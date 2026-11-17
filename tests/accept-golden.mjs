#!/usr/bin/env node
/**
 * 基准图全量比对（ADR 0001、ADR 0006 第 7 条）：两个目标预设 × 两端（Node / 浏览器）。
 *
 * Node 侧：shared/hud.js 渲染固定示意数据 → PNG → 与 tests/golden/<preset>.png 比对。
 * 浏览器侧：Chrome headless 打开 editor/golden.html 截图 → 与同一张基准图比对。
 *
 * 判据与阈值一律取 `tests/golden-compare.mjs` 的导出常量（ADR 0001 修订 1），本脚本只负责
 * 汇总与打印，不放宽任何阈值。
 *
 *   node tests/accept-golden.mjs              # 两端都跑
 *   node tests/accept-golden.mjs --node-only  # 只跑 Node 侧（无 Chrome 的环境）
 *
 * 退出码：0 全部通过；1 有任一项未通过；2 基准图缺失。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { encodePng, registerFonts } from '../cli/adapter.mjs';
import { BUILTIN_PRESET_IDS } from '../shared/presets.js';
import { generateGoldens, goldenPath, renderSample } from './golden-generate.mjs';
import { compareRgba, criticalRegionsFor, decodePng, formatReport, isPassing } from './golden-compare.mjs';
import { findChrome, runBrowserGolden } from './golden-browser.mjs';

/** Node 侧：用当前代码渲染一帧，与入库基准图逐像素 / 逐文字框比对。 */
export function compareNodeSide(presetId) {
  const { canvas } = renderSample({ presetId });
  const actual = decodePng(encodePng(canvas));
  const expected = decodePng(readFileSync(goldenPath(presetId)));
  const regions = criticalRegionsFor({ presetId });

  const report = { presetId, candidatePath: '（Node 内存渲染）', ...compareRgba(actual, expected, regions) };
  return { ...report, pass: isPassing(report) };
}

async function main(argv) {
  const nodeOnly = argv.includes('--node-only');
  await registerFonts();

  const missing = BUILTIN_PRESET_IDS.filter((presetId) => !existsSync(goldenPath(presetId)));
  if (missing.length > 0) {
    process.stderr.write(
      `基准图缺失：${missing.join('、')}；先跑 npm run golden:generate 生成并审查\n`,
    );
    return 2;
  }

  const reports = [];
  process.stdout.write('Node 侧（@napi-rs/canvas）：\n');
  for (const presetId of BUILTIN_PRESET_IDS) {
    const report = compareNodeSide(presetId);
    reports.push({ end: 'Node', ...report });
    process.stdout.write(`  ${formatReport(report)}\n`);
  }

  const chrome = findChrome();
  if (nodeOnly) {
    process.stdout.write('\n浏览器侧：--node-only，跳过\n');
  } else if (chrome === null) {
    process.stdout.write('\n浏览器侧：未找到 Chrome，跳过（可用 CHROME_PATH 指定）\n');
  } else {
    process.stdout.write('\n浏览器侧（Chrome headless）：\n');
    const browserReports = await runBrowserGolden({ presetIds: BUILTIN_PRESET_IDS, chrome });
    for (const report of browserReports) {
      reports.push({ end: '浏览器', ...report });
      process.stdout.write(`  ${formatReport(report)}\n`);
    }
  }

  const failed = reports.filter((report) => !report.pass);
  if (failed.length > 0) {
    process.stderr.write(
      `\n未通过：${failed.map((report) => `${report.end}/${report.presetId}`).join('、')}\n`,
    );
    return 1;
  }

  process.stdout.write(`\n两预设 × ${nodeOnly || chrome === null ? 'Node 一端' : '两端'}全部通过（ADR 0001 修订 1 的判据）。\n`);

  // 基准图必须能由入库脚本原样复现；不一致说明渲染参数漂移（或有人手改了 PNG）。
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-accept-golden-'));
  try {
    await generateGoldens({ dir });
    const drift = BUILTIN_PRESET_IDS.filter((presetId) => (
      !readFileSync(goldenPath(presetId, dir)).equals(readFileSync(goldenPath(presetId)))
    ));
    if (drift.length > 0) {
      process.stderr.write(
        `\n基准图不可重复生成：${drift.join('、')} 与入库文件不一致；`
          + '确认渲染参数未变后重跑 npm run golden:generate 并审查差异\n',
      );
      return 1;
    }
    process.stdout.write('基准图可重复生成：重跑得到逐字节相同的 PNG。\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return 0;
}

process.exitCode = await main(process.argv.slice(2));
