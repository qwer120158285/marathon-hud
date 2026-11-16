import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePreset, resolveCanvasPreset } from '../shared/presets.js';

// 期望值来源：ADR 0003「安全边距」表、ADR 0002「规格」与「网格语义」。不来自被测实现。
test('抖音竖屏预设解析出 ADR 0003 的安全边距与 ADR 0002 的网格', () => {
  const preset = resolvePreset('douyin-portrait');

  assert.equal(preset.width, 1080);
  assert.equal(preset.height, 1920);
  assert.deepEqual(preset.safeInset, { left: 64, right: 64, top: 160, bottom: 240 });
  assert.equal(preset.cellSize, 40);
  assert.deepEqual(preset.grid, { cols: 27, rows: 48 });
});

// 期望值来源：ADR 0002「网格语义」示例——左右 64 px / 40 px 格边长 → 从 col 2 起；
// 顶部 160 px → row 4 起；底部 240 px → 最后一行到 row 41（row 42 的底边 1720 > 1680）。
test('抖音竖屏的可放置格位从 col 2 / row 4 起，到 col 24 / row 41 止', () => {
  const preset = resolvePreset('douyin-portrait');

  assert.deepEqual(preset.placeable, { colStart: 2, colEnd: 24, rowStart: 4, rowEnd: 41 });
  assert.deepEqual(preset.safeArea, { x: 64, y: 160, width: 952, height: 1520 });
});

// 期望值来源：ADR 0002——B 站 1920×1080 → 48 列 × 27 行；ADR 0003——左右 64 / 顶部 80 / 底部 120。
// 可放置格位：col 2 起（64/40 → 2）、col 45 止（(45+1)×40 = 1840 ≤ 1856）；row 2 起、row 23 止（24×40 = 960 = 1080−120）。
test('B 站横屏预设解析出 48×27 网格，可放置格位 col 2–45 / row 2–23', () => {
  const preset = resolvePreset('bilibili-landscape');

  assert.equal(preset.width, 1920);
  assert.equal(preset.height, 1080);
  assert.deepEqual(preset.safeInset, { left: 64, right: 64, top: 80, bottom: 120 });
  assert.equal(preset.cellSize, 40);
  assert.deepEqual(preset.grid, { cols: 48, rows: 27 });
  assert.deepEqual(preset.placeable, { colStart: 2, colEnd: 45, rowStart: 2, rowEnd: 23 });
  // ADR 0002「已知约束」：A 方案下横屏安全区只有 880 px 高。
  assert.deepEqual(preset.safeArea, { x: 64, y: 80, width: 1792, height: 880 });
});

// 期望值来源：ADR 0002「基准格边长 40 px @ 短边 1080；自定义分辨率按 min(W,H)/1080 等比缩放」
// 与 ADR 0003「自定义分辨率按 min(W,H)/1080 缩放全部边距」。540×960 → 缩放 0.5。
test('自定义分辨率按短边等比缩放格边长与安全边距', () => {
  const preset = resolveCanvasPreset({
    id: 'custom-half',
    width: 540,
    height: 960,
    safeInset: { left: 64, right: 64, top: 160, bottom: 240 },
  });

  assert.equal(preset.scale, 0.5);
  assert.equal(preset.cellSize, 20);
  assert.deepEqual(preset.safeInset, { left: 32, right: 32, top: 80, bottom: 120 });
  assert.deepEqual(preset.grid, { cols: 27, rows: 48 });
  assert.deepEqual(preset.safeArea, { x: 32, y: 80, width: 476, height: 760 });
  assert.deepEqual(preset.placeable, { colStart: 2, colEnd: 24, rowStart: 4, rowEnd: 41 });
});

test('未知画布预设报错并列出内置预设', () => {
  assert.throws(
    () => resolvePreset('youtube-square'),
    /未知画布预设 "youtube-square"，可用预设：douyin-portrait、bilibili-landscape/,
  );
});
