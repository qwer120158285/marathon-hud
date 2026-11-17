import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePreset, resolveCanvasPreset } from '../shared/presets.js';
import {
  EDGE_LABELS,
  describeOverflow,
  duplicateComponentIdErrors,
  isBottomAnchor,
  isRightAnchor,
  resolveComponentRect,
  safeAreaOverflow,
  snapRectToGrid,
} from '../shared/layout.js';

// 期望值来源：ADR 0002「基准格边长 40 px @ 短边 1080」与 ADR 0003 抖音安全边距 64 / 160 / 240。
// 抖音 1080×1920 格边长 40 px：col 2 → x = 2×40 = 80；row 4 → y = 4×40 = 160。
test('top-left 组件从网格左上原点起算', () => {
  const rect = resolveComponentRect(
    { anchor: 'top-left', col: 2, row: 4, colSpan: 20, rowSpan: 2 },
    resolvePreset('douyin-portrait'),
  );

  assert.deepEqual(rect, { x: 80, y: 160, width: 800, height: 80 });
});

// 期望值来源：ticket #3「col 从右侧起算（col=0 表示贴右边界的整格）」。
// 抖音宽 1080：top-right col 2 / colSpan 7 的右边界 = 1080−80 = 1000，左边界 = 1000−280 = 720。
test('top-right 组件的 col 从右边界起算', () => {
  const rect = resolveComponentRect(
    { anchor: 'top-right', col: 2, row: 4, colSpan: 7, rowSpan: 5 },
    resolvePreset('douyin-portrait'),
  );

  assert.deepEqual(rect, { x: 720, y: 160, width: 280, height: 200 });
});

// 期望值来源：ticket #3「col=0 表示贴右边界的整格」——右边界正好落在画布右边。
test('top-right 锚点 col 0 时组件贴右边界', () => {
  const rect = resolveComponentRect(
    { anchor: 'top-right', col: 0, row: 0, colSpan: 7, rowSpan: 5 },
    resolvePreset('douyin-portrait'),
  );

  assert.equal(rect.x + rect.width, 1080);
  assert.equal(rect.x, 800);
});

// 期望值来源：ticket #3「bottom-left / bottom-right 的 row 从底部起算」。
// 抖音高 1920：row 6 / rowSpan 5 的底边界 = 1920−240 = 1680，上边界 = 1680−200 = 1480。
test('bottom-left 组件的 row 从底部起算', () => {
  const rect = resolveComponentRect(
    { anchor: 'bottom-left', col: 2, row: 6, colSpan: 6, rowSpan: 5 },
    resolvePreset('douyin-portrait'),
  );

  assert.deepEqual(rect, { x: 80, y: 1480, width: 240, height: 200 });
});

// 期望值来源：同一条锚点规则在横屏上复用，B 站 1920×1080 格边长同为 40。
// 右边界 = 1920−80 = 1840，左边界 = 1840−280 = 1560；底边界 = 1080−240 = 840，上边界 = 640。
test('bottom-right 锚点同时从右与从下起算', () => {
  const rect = resolveComponentRect(
    { anchor: 'bottom-right', col: 2, row: 6, colSpan: 7, rowSpan: 5 },
    resolvePreset('bilibili-landscape'),
  );

  assert.deepEqual(rect, { x: 1560, y: 640, width: 280, height: 200 });
});

// 期望值来源：ADR 0002「自定义分辨率按 min(W,H)/1080 等比缩放」；540×960 缩放 0.5，
// 格边长 20 px：col 2 → 40、row 4 → 80、colSpan 20 → 400、rowSpan 2 → 40。
test('自定义分辨率下按缩放后的格边长解析', () => {
  const preset = resolveCanvasPreset({
    id: 'custom-half',
    width: 540,
    height: 960,
    safeInset: { left: 64, right: 64, top: 160, bottom: 240 },
  });
  const rect = resolveComponentRect(
    { anchor: 'top-left', col: 2, row: 4, colSpan: 20, rowSpan: 2 },
    preset,
  );

  assert.deepEqual(rect, { x: 40, y: 80, width: 400, height: 40 });
});

// 期望值来源：ticket #3「格位吸附：收拢到最近的整数格位；同时自动推导四角锚点」。
// 输入矩形 (76,1604)–(324,1692) 在抖音 1080×1920 上离左下角最近（76 + 228 = 304，
// 左上角 1680、右上角 2360、右下角 984），因此锚点为 bottom-left；
// 格位：col = round(76/40) = 2、row = round(228/40) = 6、colSpan = round(248/40) = 6、
// rowSpan = round(88/40) = 2 → 收拢后的矩形为 (80,1600)–(320,1680)，底边正好压在安全区下沿。
test('格位吸附把左下角的矩形收拢到最近整格并推导出 bottom-left 锚点', () => {
  const snapped = snapRectToGrid(
    { x: 76, y: 1604, width: 248, height: 88 },
    resolvePreset('douyin-portrait'),
  );

  assert.deepEqual(snapped, { anchor: 'bottom-left', col: 2, row: 6, colSpan: 6, rowSpan: 2 });
});

// 期望值来源：同一吸附规则用于右上角。输入 (960,20)–(1050,100)：离右上角最近（30 + 20 = 50），
// col = round((1080−1050)/40) = 1、row = round(20/40) = 1、colSpan = round(90/40) = 2、rowSpan = 2。
test('格位吸附在右上角推导出 top-right 锚点', () => {
  const snapped = snapRectToGrid(
    { x: 960, y: 20, width: 90, height: 80 },
    resolvePreset('douyin-portrait'),
  );

  assert.deepEqual(snapped, { anchor: 'top-right', col: 1, row: 1, colSpan: 2, rowSpan: 2 });
});

// 期望值来源：拖动本身不在本票，但吸附必须是幂等的——已对齐的矩形吸附后格位不变。
// 输入即 top-left col 2 / row 4 / 20×2 的矩形 (80,160)–(880,240)，离左上角最近（240）。
test('已对齐的矩形吸附后格位保持不变', () => {
  const snapped = snapRectToGrid(
    { x: 80, y: 160, width: 800, height: 80 },
    resolvePreset('douyin-portrait'),
  );

  assert.deepEqual(snapped, { anchor: 'top-left', col: 2, row: 4, colSpan: 20, rowSpan: 2 });
});

// 期望值来源：ADR 0003「可放置格位范围仅限安全区」。抖音安全区 x 64–1016，组件 (80,160)–(880,240) 完全在内。
test('完整落在安全区内的组件没有越界', () => {
  assert.deepEqual(
    safeAreaOverflow(
      { anchor: 'top-left', col: 2, row: 4, colSpan: 20, rowSpan: 2 },
      resolvePreset('douyin-portrait'),
    ),
    [],
  );
});

// 期望值来源：ADR 0002「边界判断统一使用组件的完整边界矩形，而不是只判断起始格」。
// col 24 是抖音竖屏最后一个可放置列（含），单独占 1 格合法；跨 2 格后右边界 1040 > 安全区右沿 1016，
// 越界 24 px = 24/40 = 0.6 格。
test('起始格合法但跨格后越过安全区时判定失败并给出越界量', () => {
  assert.deepEqual(
    safeAreaOverflow(
      { anchor: 'top-left', col: 24, row: 4, colSpan: 2, rowSpan: 2 },
      resolvePreset('douyin-portrait'),
    ),
    [{ edge: 'right', px: 24, cells: 0.6 }],
  );
});

// 期望值来源：抖音左右安全边距 64 px、格边长 40 px——col 0 的左边越界 64 px = 1.6 格。
test('从 col 0 起算的组件越过左边安全边距', () => {
  assert.deepEqual(
    safeAreaOverflow(
      { anchor: 'top-left', col: 0, row: 4, colSpan: 20, rowSpan: 2 },
      resolvePreset('douyin-portrait'),
    ),
    [{ edge: 'left', px: 64, cells: 1.6 }],
  );
});

// 期望值来源：B 站横屏底部安全边距 120 px → 安全区下沿 960；row 23 是最后一个可放置行（单行合法），
// 跨 2 行后下边界 1000，越界 40 px = 1 格。
test('起始行合法但跨行后越过底部安全边距时判定失败', () => {
  assert.deepEqual(
    safeAreaOverflow(
      { anchor: 'top-left', col: 2, row: 23, colSpan: 6, rowSpan: 2 },
      resolvePreset('bilibili-landscape'),
    ),
    [{ edge: 'bottom', px: 40, cells: 1 }],
  );
});

// 锚点方位判断只有一份实现：shared/hud.js 与 shared/layout.js 都用它决定行从哪边起算。
test('isBottomAnchor / isRightAnchor 对四角锚点给出确定答案', () => {
  assert.equal(isBottomAnchor('bottom-left'), true);
  assert.equal(isBottomAnchor('bottom-right'), true);
  assert.equal(isBottomAnchor('top-left'), false);
  assert.equal(isBottomAnchor('top-right'), false);

  assert.equal(isRightAnchor('top-right'), true);
  assert.equal(isRightAnchor('bottom-right'), true);
  assert.equal(isRightAnchor('top-left'), false);
  assert.equal(isRightAnchor('bottom-left'), false);
});

// 越界文案只有一份实现：编辑器读数与联合校验报告必须逐字一致。
test('describeOverflow 与 EDGE_LABELS 由 shared/layout.js 导出，文案与联合校验一致', () => {
  assert.deepEqual(EDGE_LABELS, { left: '左边', right: '右边', top: '上边', bottom: '下边' });
  assert.equal(
    describeOverflow([{ edge: 'bottom', px: 200, cells: 5 }]),
    '下边越界 200 px（5 格）',
  );
  assert.equal(
    describeOverflow([{ edge: 'left', px: 64, cells: 1.6 }, { edge: 'right', px: 1.2345, cells: 0.0308625 }]),
    '左边越界 64 px（1.6 格），右边越界 1.235 px（0.031 格）',
  );
});

// 组件 id 唯一性在布局层独立成立；CLI 的语义校验复用同一份实现与文案。
test('duplicateComponentIdErrors 指出重复的两处下标与 id', () => {
  assert.deepEqual(
    duplicateComponentIdErrors([
      { id: 'route' },
      { id: 'metrics' },
      { id: 'route' },
    ]),
    [{
      index: 2,
      firstIndex: 0,
      componentId: 'route',
      message: 'layout.components[2].id 与 layout.components[0].id 重复（"route"）',
    }],
  );
  assert.deepEqual(duplicateComponentIdErrors([{ id: 'route' }, { id: 'metrics' }]), []);
});
