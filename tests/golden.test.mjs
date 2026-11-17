import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePng, registerFonts } from '../cli/adapter.mjs';
import { BUILTIN_PRESET_IDS } from '../shared/presets.js';
import { generateGoldens, goldenPath, renderSample } from './golden-generate.mjs';
import {
  CRITICAL_MAX_DIFF_RATIO,
  FULL_MAX_DIFF_RATIO,
  TEXT_MAX_INK_DELTA,
  compareRgba,
  criticalRegionsFor,
  decodePng,
  isPassing,
  rasterizeRegions,
} from './golden-compare.mjs';

await registerFonts();

/** 用当前代码渲染一帧并与基准图比对。 */
function compareWithGolden(presetId) {
  const { canvas } = renderSample({ presetId });
  const actual = decodePng(encodePng(canvas));
  const expected = decodePng(readFileSync(goldenPath(presetId)));
  const regions = criticalRegionsFor({ presetId });
  return compareRgba(actual, expected, regions);
}

// 验收项：两个目标预设各一张基准图，Node 侧与同一张基准图比对。
// 非文字像素按 8/255 逐像素（全图 ≤1%、关键区域 ≤0.2%），文字框按结构校验（见 golden-compare.mjs）。
for (const presetId of BUILTIN_PRESET_IDS) {
  test(`Node 侧渲染与基准图 ${presetId} 一致`, () => {
    const report = compareWithGolden(presetId);
    const percent = (ratio) => (ratio * 100).toFixed(4);

    assert.ok(
      report.full.ratio <= FULL_MAX_DIFF_RATIO,
      `全图非文字差异 ${percent(report.full.ratio)}% 超过 1%（${report.full.diffPixels} px）`,
    );
    assert.ok(
      report.critical.ratio <= CRITICAL_MAX_DIFF_RATIO,
      `非文字关键区域差异 ${percent(report.critical.ratio)}% 超过 0.2%（${report.critical.diffPixels} px）`,
    );
    assert.ok(report.textChecks.centroidPx <= 1, `文字质心偏移 ${report.textChecks.centroidPx} px`);
    assert.ok(report.textChecks.bboxDeltaPx <= 1, `文字包围盒偏差 ${report.textChecks.bboxDeltaPx} px`);
    assert.ok(report.textChecks.outlinePx <= 1, `文字轮廓距离 ${report.textChecks.outlinePx} px`);
    assert.ok(report.textChecks.inkDelta <= TEXT_MAX_INK_DELTA, `文字墨量差 ${report.textChecks.inkDelta}`);
    assert.equal(isPassing(report), true);
  });
}

// 基准图必须能由入库的生成脚本原样复现，否则以后无法审查「是不是偷偷换了渲染」。
test('基准图可重复生成：重跑得到逐字节相同的 PNG', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-golden-'));
  try {
    await generateGoldens({ dir });
    for (const presetId of BUILTIN_PRESET_IDS) {
      assert.deepEqual(
        readFileSync(goldenPath(presetId, dir)),
        readFileSync(goldenPath(presetId)),
        `${presetId} 重跑结果与入库基准图不一致`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 口径自检：偏差刚好 8/255 不算差异，9/255 算；Alpha 通道同样参与。
test('比对口径：偏差 8/255 不算差异，9/255 算差异，Alpha 偏差同样计入', () => {
  const width = 4;
  const height = 1;
  const expected = { width, height, data: new Uint8Array(width * height * 4).fill(100) };
  const actual = { width, height, data: new Uint8Array(width * height * 4).fill(100) };

  actual.data[0] = 108; // +8：不算
  actual.data[4] = 109; // +9：算
  actual.data[11] = 91; // Alpha -9：算

  const report = compareRgba(actual, expected, [{ kind: 'component', x: 0, y: 0, width, height }]);
  assert.equal(report.full.diffPixels, 2);
  assert.equal(report.critical.diffPixels, 2);
});

test('关键区域栅格化：落在画布内、面积小于全图、重复区域只算一次', () => {
  const { width, height } = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const regions = [
    { kind: 'component', x: -20, y: -20, width: 100, height: 100 },
    { kind: 'component', x: 10, y: 10, width: 50, height: 50 },
  ];
  const { pixels } = rasterizeRegions(regions, width, height);

  // 第一块裁剪后 80×80，第二块整块落在其中，不重复计数。
  assert.equal(pixels, 80 * 80);

  const report = compareWithGolden('douyin-portrait');
  assert.ok(report.critical.pixels > 0, '关键区域不能为空');
  assert.ok(report.critical.pixels < width * height, '关键区域不能覆盖全图');
  assert.ok(report.text.pixels > 0, '文字框不能为空');
});

/** 把某个矩形内的像素整体平移 dx / dy，用于模拟真实的布局偏移。 */
function shiftRegion(image, region, dx, dy) {
  const { width, height, data } = image;
  const copy = data.slice();
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(width, Math.ceil(region.x + region.width));
  const y1 = Math.min(height, Math.ceil(region.y + region.height));

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const source = ((y - dy) * width + (x - dx)) * 4;
      if (x - dx < x0 || x - dx >= x1 || y - dy < y0 || y - dy >= y1) continue;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) data[target + channel] = copy[source + channel];
    }
  }
}

// 组件矩形（底板 / 描边 / 留白）不享受任何文字容差：1 px 位移必须被抓住。
test('组件矩形整块移动 1 px 会被非文字像素比对抓住', () => {
  const expected = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const actual = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const regions = criticalRegionsFor({ presetId: 'douyin-portrait' });
  const component = regions.find((region) => region.kind === 'component');

  // 只平移底板外框（文字框区域本身是均匀底板，不参与逐像素判定）。
  shiftRegion(actual, { ...component, x: component.x + 8, y: component.y + 8, width: 12, height: component.height - 16 }, 1, 0);

  const report = compareRgba(actual, expected, regions);
  assert.ok(
    report.critical.ratio > CRITICAL_MAX_DIFF_RATIO,
    `非文字关键区域差异 ${(report.critical.ratio * 100).toFixed(3)}% 应当超过 0.2%`,
  );
  assert.equal(isPassing(report), false);
});

// 文字整体位移超出 1 px 容差必须被抓住（位移 1 px 是允许的平台相位差，位移 2 px 是真错位）。
test('文字整体移动 2 px 会让质心偏移超阈值', () => {
  const expected = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const actual = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const regions = criticalRegionsFor({ presetId: 'douyin-portrait' });

  for (const region of regions.filter((item) => item.kind === 'text')) shiftRegion(actual, region, 2, 0);

  const report = compareRgba(actual, expected, regions);
  assert.ok(report.textChecks.centroidPx > 1, `质心偏移 ${report.textChecks.centroidPx} px 应当超过 1 px`);
  assert.equal(isPassing(report), false);
});

// 字重变化（墨量变轻 20%）不会被结构判定放过。
test('文字墨量减少 20% 会被墨量校验抓住', () => {
  const expected = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const actual = decodePng(readFileSync(goldenPath('douyin-portrait')));
  const regions = criticalRegionsFor({ presetId: 'douyin-portrait' });

  // 以文字框背景色为基准，把墨量压到 80%（等价于换细一档字重）。
  for (const region of regions.filter((item) => item.kind === 'text')) {
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(actual.width, Math.ceil(region.x + region.width));
    const y1 = Math.min(actual.height, Math.ceil(region.y + region.height));
    const background = [...actual.data.slice((y0 * actual.width + x0) * 4, (y0 * actual.width + x0) * 4 + 4)];

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * actual.width + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          const value = background[channel] + (actual.data[index + channel] - background[channel]) * 0.8;
          actual.data[index + channel] = Math.max(0, Math.min(255, Math.round(value)));
        }
      }
    }
  }

  const report = compareRgba(actual, expected, regions);
  assert.ok(
    report.textChecks.inkDelta > TEXT_MAX_INK_DELTA,
    `墨量差 ${(report.textChecks.inkDelta * 100).toFixed(1)}% 应当超过 ${TEXT_MAX_INK_DELTA * 100}%`,
  );
  assert.equal(isPassing(report), false);
});
