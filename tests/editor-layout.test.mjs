/**
 * 编辑器纯逻辑层的行为测试（不启浏览器、不碰 DOM、不测鼠标手势）。
 *
 * 测的是「像素矩形 → 格位吸附 → 安全区校验 → 候选布局」这条链的结果，
 * 以及预设切换、层级/显隐、保存前联合校验与序列化。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePreset } from '../shared/presets.js';
import { resolveComponentRect } from '../shared/layout.js';
import { validateProject, loadSchema } from '../cli/project.mjs';
import {
  changeLayer,
  commitComponent,
  layoutRects,
  parseProjectText,
  replaceComponent,
  resizeRect,
  serializeProject,
  setVisible,
  switchSourcePreset,
  translateRect,
  validateCandidate,
} from '../editor/layout-edit.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const readFixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));

const PORTRAIT = resolvePreset('douyin-portrait');
const LANDSCAPE = resolvePreset('bilibili-landscape');
const ALL_PRESETS = [PORTRAIT, LANDSCAPE];

const componentOf = (project, id) => project.layout.components.find((item) => item.id === id);

/** 取组件在预设下的当前像素矩形，作为拖动的起点。 */
const rectOf = (project, id, preset) => resolveComponentRect(componentOf(project, id), preset);

// 验收项：拖动按整数格位吸附；锚点由拖拽结果自动推导。
test('拖动 37 × −18 px 后吸附到整数格位，并推导出最近的左下锚点', () => {
  const project = readFixture('project.valid.json');
  const start = rectOf(project, 'metrics', PORTRAIT);
  const dragged = translateRect(start, { dx: 37, dy: -18 });

  const result = commitComponent(componentOf(project, 'metrics'), dragged, PORTRAIT);

  assert.equal(result.accepted, true);
  assert.deepEqual(result.overflow, []);
  assert.equal(result.component.anchor, 'bottom-left');
  assert.equal(result.component.col, 3);
  assert.equal(result.component.row, 6);
  assert.equal(result.component.colSpan, 6);
  assert.equal(result.component.rowSpan, 8);
  // 吸附后的像素矩形必须严格落在格线上，不残留像素偏移。
  assert.deepEqual(resolveComponentRect(result.component, PORTRAIT), {
    x: 120, y: 1360, width: 240, height: 320,
  });
});

// 验收项：锚点自动推导——拖到右上角后改为从右边界起算。
test('拖到右上角后锚点变为 top-right，col 从右边界起算', () => {
  const project = readFixture('project.valid.json');
  const start = rectOf(project, 'route', PORTRAIT);
  const dragged = translateRect(start, { dx: 700, dy: 0 });

  const result = commitComponent(componentOf(project, 'route'), dragged, PORTRAIT);

  assert.equal(result.accepted, true);
  assert.equal(result.component.anchor, 'top-right');
  assert.equal(result.component.col, 2);
  assert.equal(result.component.row, 7);
  assert.deepEqual(resolveComponentRect(result.component, PORTRAIT), {
    x: 760, y: 280, width: 240, height: 240,
  });
});

// 验收项：Resize 按整数格，不提供像素微调（87 px 必须收敛成 2 格）。
test('东侧 Resize 87 px 吸附为跨 8 格，且仍贴在安全区底边', () => {
  const project = readFixture('project.valid.json');
  const start = rectOf(project, 'metrics', PORTRAIT);
  const resized = resizeRect(start, 'e', { dx: 87, dy: 0 });

  const result = commitComponent(componentOf(project, 'metrics'), resized, PORTRAIT);

  assert.equal(result.accepted, true);
  assert.equal(result.component.colSpan, 8);
  assert.equal(result.component.rowSpan, 8);
  assert.equal(result.component.anchor, 'bottom-left');
  assert.deepEqual(resolveComponentRect(result.component, PORTRAIT), {
    x: 80, y: 1360, width: 320, height: 320,
  });
});

// 验收项：完整边界矩形越过安全区时被拦住，回退到上一个合法位置并报越界量。
test('向下拖出安全区时拒绝提交，组件保持原位并报出下边越界 200 px（5 格）', () => {
  const project = readFixture('project.valid.json');
  const original = componentOf(project, 'metrics');
  const start = rectOf(project, 'metrics', PORTRAIT);
  const dragged = translateRect(start, { dx: 0, dy: 200 });

  const result = commitComponent(original, dragged, PORTRAIT);

  assert.equal(result.accepted, false);
  assert.deepEqual(result.component, original);
  assert.deepEqual(
    result.overflow.map(({ edge, px, cells }) => ({ edge, px, cells })),
    [{ edge: 'bottom', px: 200, cells: 5 }],
  );
});

// 验收项：横竖屏切换按锚点重新映射位置，colSpan / rowSpan 不变（ADR 0002 A 方案）。
test('切换编辑预设只改上下文，组件按锚点 + 格位在新预设下重新解释', () => {
  const project = readFixture('project.valid.json');
  const switched = switchSourcePreset(project, 'bilibili-landscape');

  assert.equal(switched.layout.sourcePresetId, 'bilibili-landscape');
  assert.deepEqual(switched.layout.components, project.layout.components);
  assert.deepEqual(switched.targetPresets, project.targetPresets);

  const metrics = layoutRects(switched.layout.components, LANDSCAPE)
    .find(({ component }) => component.id === 'metrics');
  assert.deepEqual(metrics.rect, { x: 80, y: 520, width: 240, height: 320 });
  assert.equal(metrics.component.colSpan, 6);
  assert.equal(metrics.component.rowSpan, 8);

  const weather = layoutRects(switched.layout.components, LANDSCAPE)
    .find(({ component }) => component.id === 'weather');
  assert.deepEqual(weather.rect, { x: 1560, y: 640, width: 280, height: 200 });
});

// 验收项：保存触发全部目标预设联合校验；任一预设失败就拒绝，并列出预设、组件与越界量。
test('竖屏合法、横屏越界时拒绝保存，错误点名预设、组件与越界量', () => {
  const project = readFixture('project.landscape-overflow.json');

  const result = validateCandidate(project, ALL_PRESETS);

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].presetId, 'bilibili-landscape');
  assert.equal(result.errors[0].componentId, 'metrics');
  assert.match(result.errors[0].message, /上边越界 520 px（13 格）/);
  assert.doesNotMatch(result.errors[0].message, /douyin-portrait/);
});

test('全部目标预设通过时允许保存，层叠只作为提示返回', () => {
  const project = readFixture('project.stacking.json');

  const result = validateCandidate(project, ALL_PRESETS);

  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.warnings.every((warning) => warning.kind === 'stacking'));
  assert.match(result.warnings[0].message, /层叠/);
});

// 验收项：载入示例配置 → 修改 → 保存后的 JSON 可被 Schema 校验。
test('序列化后的配置能被 CLI 的同一套 Schema 校验通过，并可无损载回', () => {
  const project = readFixture('project.valid.json');
  const moved = replaceComponent(
    project.layout.components,
    commitComponent(componentOf(project, 'metrics'), translateRect(rectOf(project, 'metrics', PORTRAIT), { dx: 40 }), PORTRAIT).component,
  );
  const saved = serializeProject({ ...project, layout: { ...project.layout, components: moved } });

  assert.match(saved, /\n$/);
  assert.deepEqual(parseProjectText(saved).layout.components, moved);
  assert.deepEqual(validateProject(JSON.parse(saved), loadSchema()), []);
});

// 层级与显隐：只改布局字段，不做几何重算。
test('层级上移 / 下移与临时隐藏都返回新数组，不改入参', () => {
  const project = readFixture('project.valid.json');
  const components = project.layout.components;

  const raised = changeLayer(components, 'metrics', 1);
  const lowered = changeLayer(components, 'metrics', -2);
  const hidden = setVisible(components, 'weather', false);

  assert.equal(raised.find((item) => item.id === 'metrics').zIndex, 4);
  assert.equal(lowered.find((item) => item.id === 'metrics').zIndex, 1);
  assert.equal(hidden.find((item) => item.id === 'weather').visible, false);
  assert.equal(components.find((item) => item.id === 'metrics').zIndex, 3);
  assert.equal(components.find((item) => item.id === 'weather').visible, true);
});
