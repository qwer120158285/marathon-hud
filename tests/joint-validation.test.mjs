import test from 'node:test';
import assert from 'node:assert/strict';

import { resolvePreset } from '../shared/presets.js';
import { jointValidate } from '../shared/layout.js';

/** 同一版本的预设配置快照：联合校验必须只用这一份，不在校验过程中重新解析。 */
const PRESETS = [resolvePreset('douyin-portrait'), resolvePreset('bilibili-landscape')];
const TARGETS = ['douyin-portrait', 'bilibili-landscape'];

function component(overrides) {
  return {
    anchor: 'top-left',
    col: 2,
    row: 2,
    colSpan: 6,
    rowSpan: 2,
    zIndex: 1,
    visible: true,
    ...overrides,
  };
}

function layoutOf(components) {
  return { sourcePresetId: 'douyin-portrait', components };
}

// 期望值来源：ADR 0002「已知约束」——A 方案下横屏安全区只有 880 px 高，上下贴边组件容易挤到一起；
// 这里四件互不重叠，且两个预设的完整边界矩形都在安全区内（手算见各组件格位）。
test('横竖屏都通过联合校验的布局没有任何错误与提示', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'progress', col: 2, row: 4, colSpan: 20, rowSpan: 2, zIndex: 2 }),
      component({ id: 'route', col: 2, row: 7, colSpan: 6, rowSpan: 6, zIndex: 1 }),
      component({ id: 'metrics', anchor: 'bottom-left', col: 2, row: 6, colSpan: 6, rowSpan: 8, zIndex: 3 }),
      component({ id: 'weather', anchor: 'bottom-right', col: 2, row: 6, colSpan: 7, rowSpan: 5, zIndex: 2 }),
    ]),
    targetPresets: TARGETS,
    presets: PRESETS,
  });

  assert.deepEqual(result, { ok: true, errors: [], warnings: [] });
});

// 期望值来源：ticket #3 必测失败用例——「竖屏通过、横屏越界」。
// metrics 为 bottom-left row 30 / rowSpan 8：抖音 y = 1920 − 38×40 = 400，落在安全区 160–1680 内；
// B 站 y = 1080 − 38×40 = −440，安全区上边界 80，故上边越界 80 − (−440) = 520 px = 13 格。
test('竖屏通过、横屏越界的布局被拒绝，并报出预设、组件、边与越界量', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'route', col: 2, row: 4, colSpan: 6, rowSpan: 6, zIndex: 1 }),
      component({ id: 'metrics', anchor: 'bottom-left', col: 2, row: 30, colSpan: 6, rowSpan: 8, zIndex: 3 }),
    ]),
    targetPresets: TARGETS,
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);

  const [error] = result.errors;
  assert.equal(error.kind, 'safe-area');
  assert.equal(error.presetId, 'bilibili-landscape');
  assert.equal(error.componentId, 'metrics');
  assert.deepEqual(error.overflow, [{ edge: 'top', px: 520, cells: 13 }]);
  assert.match(
    error.message,
    /画布预设 bilibili-landscape：组件 metrics 超出安全区——上边越界 520 px（13 格）；组件矩形 x 80–320、y -440–-120，安全区 x 64–1856、y 80–960/,
  );
  assert.doesNotMatch(error.message, /douyin-portrait/);
});

// 期望值来源：ticket #3「格位有效（整数、非负）」——像素微调不提供，小数格位必须被拒绝。
test('小数格位被判为无效格位', () => {
  const result = jointValidate({
    layout: layoutOf([component({ id: 'route', col: 2.5, row: 4 })]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  const [error] = result.errors;
  assert.equal(error.kind, 'grid');
  assert.equal(error.componentId, 'route');
  assert.match(error.message, /画布预设 douyin-portrait：组件 route 的 col 必须是整数，实际为 2\.5/);
});

// 期望值来源：Schema 已约束 minimum 0，但联合校验是布局层的独立硬约束，不能依赖上游校验。
test('负格位被判为无效格位', () => {
  const result = jointValidate({
    layout: layoutOf([component({ id: 'weather', row: -1, anchor: 'bottom-right' })]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  const gridErrors = result.errors.filter((error) => error.kind === 'grid');
  assert.equal(gridErrors.length, 1);
  assert.match(gridErrors[0].message, /组件 weather 的 row 不能为负，实际为 -1/);
});

// 期望值来源：ticket #3「尺寸有效（colSpan / rowSpan ≥ 1 且合法）」。
test('跨格数小于 1 的组件被判为尺寸无效', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'route', row: 4, colSpan: 6 }),
      component({ id: 'metrics', anchor: 'bottom-left', row: 8, colSpan: 6, rowSpan: 0 }),
    ]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].kind, 'size');
  assert.equal(result.errors[0].componentId, 'metrics');
  assert.match(result.errors[0].message, /组件 metrics 的 rowSpan 必须是 ≥ 1 的整数，实际为 0/);
});

// 期望值来源：ADR 0002「锚点映射是否有效」——四角锚点是冻结的值集合。
test('未知锚点被判为锚点映射无效', () => {
  const result = jointValidate({
    layout: layoutOf([component({ id: 'progress', anchor: 'top-center' })]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].kind, 'anchor');
  assert.match(
    result.errors[0].message,
    /组件 progress 的锚点 "top-center" 无效，允许：top-left \/ top-right \/ bottom-left \/ bottom-right/,
  );
});

// 期望值来源：SPEC-v1 第 3.1 节「components[] 中同一 id 只能出现一次」——布局层独立成立。
test('布局层也检查组件 id 唯一性', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'route', col: 2, row: 4 }),
      component({ id: 'metrics', anchor: 'bottom-left', row: 8 }),
      component({ id: 'route', col: 12, row: 20 }),
    ]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  const duplicate = result.errors.find((error) => error.kind === 'duplicate-id');
  assert.equal(duplicate.componentId, 'route');
  assert.match(duplicate.message, /layout\.components\[2\]\.id 与 layout\.components\[0\]\.id 重复（"route"）/);
});

// 期望值来源：ADR 0002「联合校验基于同一份候选布局与同一版本的预设配置」；
// 目标预设缺少快照说明预设版本不一致，必须拒绝而不是静默跳过。
test('目标预设缺少同版本预设快照时被拒绝', () => {
  const result = jointValidate({
    layout: layoutOf([component({ id: 'route', row: 4 })]),
    targetPresets: ['douyin-portrait', 'custom-half'],
    presets: PRESETS,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors[0].kind, 'preset-missing');
  assert.match(result.errors[0].message, /画布预设 custom-half 缺少预设配置快照/);
});

// 期望值来源：ADR 0002「冲突检测区分视觉重叠与允许的层叠」——zIndex 相同且边界矩形相交记为视觉重叠。
// 两个组件都是 top-left col 2 / colSpan 6：x 80–320 完全相交；route 行 4–9（y 160–400），
// metrics 行 8–13（y 320–560），重叠区 y 320–400 → 240 × 80 px。
test('zIndex 相同的相交组件记为视觉重叠提示，不阻止保存', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'route', row: 4, colSpan: 6, rowSpan: 6, zIndex: 1 }),
      component({ id: 'metrics', row: 8, colSpan: 6, rowSpan: 6, zIndex: 1 }),
    ]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);

  const [warning] = result.warnings;
  assert.equal(warning.kind, 'visual-overlap');
  assert.equal(warning.presetId, 'douyin-portrait');
  assert.deepEqual([warning.componentId, warning.otherComponentId], ['route', 'metrics']);
  assert.equal(warning.overlap.width, 240);
  assert.equal(warning.overlap.height, 80);
  assert.match(warning.message, /组件 route 与 metrics 视觉重叠（zIndex 同为 1），重叠区域 240 × 80 px/);
});

// 期望值来源：ticket #3「文字叠在透明底板上属正常布局，不得误判为错误」。
// 同一位置不同 zIndex 是使用者显式设定的覆盖关系 → 允许的层叠，只提示不阻止。
test('文字叠在透明底板上记为允许的层叠，不算错误', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'route', row: 4, colSpan: 6, rowSpan: 6, zIndex: 1 }),
      component({ id: 'weather', row: 4, colSpan: 6, rowSpan: 6, zIndex: 5 }),
    ]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);

  const [warning] = result.warnings;
  assert.equal(warning.kind, 'stacking');
  assert.equal(warning.overlap.width, 240);
  assert.equal(warning.overlap.height, 240);
  assert.match(warning.message, /组件 route 与 weather 层叠（zIndex 5 覆盖 1），重叠区域 240 × 240 px/);
});

// 期望值来源：几何常识——边界相接（相切）面积为零，不是重叠。
test('边界刚好相接的组件不算重叠', () => {
  const result = jointValidate({
    layout: layoutOf([
      component({ id: 'route', row: 4, colSpan: 6, rowSpan: 6, zIndex: 1 }),
      component({ id: 'metrics', row: 10, colSpan: 6, rowSpan: 6, zIndex: 1 }),
    ]),
    targetPresets: ['douyin-portrait'],
    presets: PRESETS,
  });

  assert.deepEqual(result.warnings, []);
});
