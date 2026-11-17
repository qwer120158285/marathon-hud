/**
 * 浏览器编辑器主程序：只做事件绑定、DOM 渲染与画布合成。
 *
 * 两条硬边界（本票验收项）：
 * 1. 几何计算全部调用 shared/ 的纯函数与 editor/layout-edit.js 的薄组合层，
 *    本文件不重算格边长、安全区、锚点或联合校验；
 * 2. 预览就是 shared/hud.js 的 drawFrame 输出，编辑器只在其上叠加网格、组件轮廓等编辑辅助线。
 *
 * 依据 ADR 0006：原生 HTML/CSS/JS，零构建、不引框架。
 */
import { BUILTIN_PRESETS, BUILTIN_PRESET_IDS, resolvePreset } from '../shared/presets.js';
import { drawFrame, prepareStatic } from '../shared/hud.js';
import { resolveComponentRect, safeAreaOverflow } from '../shared/layout.js';
import { createCanvas, registerFonts } from './preview.js';
import {
  changeLayer,
  commitComponent,
  layoutRects,
  replaceComponent,
  resizeRect,
  serializeProject,
  setVisible,
  switchSourcePreset,
  toCandidateComponent,
  translateRect,
  validateCandidate,
} from './layout-edit.js';

const COMPONENT_LABELS = {
  route: '路线',
  progress: '进度',
  metrics: '指标卡',
  weather: '天气',
};

const EDGE_LABELS = { left: '左边', right: '右边', top: '上边', bottom: '下边' };

/** 编辑辅助线颜色（不进入预览像素）。 */
const GRID_COLOR = 'rgba(255, 255, 255, 0.11)';
const PLACEABLE_COLOR = 'rgba(110, 200, 255, 0.42)';
const SAFE_AREA_COLOR = 'rgba(240, 180, 41, 0.9)';
const SELECTED_COLOR = '#ffd166';
const OVERFLOW_COLOR = 'rgba(255, 92, 92, 0.95)';

/** 角点把手的边长与命中半径（预设像素）。 */
const HANDLE_SIZE = 26;
const HANDLE_HIT = 22;

const ui = {
  canvas: document.getElementById('preview'),
  stage: document.getElementById('stage'),
  wrap: document.getElementById('canvas-wrap'),
  readout: document.getElementById('readout'),
  sourcePreset: document.getElementById('source-preset'),
  targetPresets: document.getElementById('target-presets'),
  projectPath: document.getElementById('project-path'),
  projectMeta: document.getElementById('project-meta'),
  load: document.getElementById('load'),
  save: document.getElementById('save'),
  gridToggle: document.getElementById('grid-toggle'),
  componentList: document.getElementById('component-list'),
  summary: document.getElementById('validation-summary'),
  warnings: document.getElementById('warnings'),
  errors: document.getElementById('errors'),
  consoleErrors: document.getElementById('console-errors'),
};

const state = {
  /** 当前载入的项目路径（相对仓库根）。 */
  projectPath: 'project.json',
  project: null,
  /** 当前编辑预设（shared/presets.js 解析结果）。 */
  preset: null,
  /** 固定示例采样（tests/fixtures/sample.json 的 full 样本）。 */
  metrics: null,
  /** 示意活动的整场数据（轨迹、Lap、总距离），路线与进度组件要用。 */
  activity: null,
  gridVisible: true,
  selectionId: null,
  /** 拖动 / Resize 的临时状态；提交前不改布局。 */
  drag: null,
  previewLayer: null,
  previewError: null,
  scale: 1,
  dirty: false,
  lastSavedAt: null,
  /** 首帧统计一次非透明像素，作为「预览真的画出来了」的运行时证据。 */
  pixelProbePending: true,
  runtimeErrors: [],
  serverErrors: [],
  actionError: null,
};

const components = () => state.project?.layout?.components ?? [];
const presetName = (id) => BUILTIN_PRESETS[id]?.displayName ?? id;
const selectedComponent = () => components().find((item) => item.id === state.selectionId) ?? null;

/** 所有「像素矩形 → 格位」的提交都走这里；调用方只需要给指针位移。 */
function componentRect(component) {
  return resolveComponentRect(component, state.preset);
}

// ---------------------------------------------------------------------------
// 载入与保存
// ---------------------------------------------------------------------------

const projectApiUrl = (projectPath) => `/api/project?path=${encodeURIComponent(projectPath)}`;

/** 载入固定示意数据；指标数值不随配置保存，只用于预览。 */
async function loadSample() {
  const response = await fetch(new URL('../tests/fixtures/sample.json', import.meta.url));
  if (!response.ok) throw new Error(`示例采样读取失败（HTTP ${response.status}）`);
  const sample = await response.json();
  const entry = sample.samples.find((item) => item.id === 'full') ?? sample.samples[0];
  if (entry === undefined) throw new Error('示例采样为空');
  state.metrics = entry.metrics;
  state.activity = sample.activity ?? null;
}

async function loadProject(projectPath) {
  const response = await fetch(projectApiUrl(projectPath));
  const body = await response.json().catch(() => ({
    ok: false,
    errors: [`服务返回的不是 JSON（HTTP ${response.status}）`],
  }));
  if (!response.ok || body.ok !== true) {
    throw new Error(`载入失败：${(body.errors ?? [`HTTP ${response.status}`]).join('；')}`);
  }

  state.project = body.project;
  state.projectPath = body.path;
  state.preset = resolvePreset(body.project.layout.sourcePresetId);
  state.selectionId = null;
  state.drag = null;
  state.serverErrors = [];
  state.actionError = null;
  state.runtimeErrors = [];
  state.dirty = false;
  state.lastSavedAt = null;
  state.pixelProbePending = true;
  ui.projectPath.value = body.path;

  refresh();
}

/**
 * 保存：先对全部目标预设联合校验，通过后才 PUT；服务端再用同一份 Schema 复核。
 * 任何一步失败都把错误文本留在界面上，不静默吞掉。
 */
async function saveProject() {
  if (state.project === null) return;

  const presets = BUILTIN_PRESET_IDS.map(resolvePreset);
  const result = validateCandidate(state.project, presets);
  state.serverErrors = [];
  state.actionError = null;

  if (!result.ok) {
    renderValidation();
    ui.summary.classList.remove('good');
    ui.summary.classList.add('bad');
    ui.summary.textContent = `保存已拒绝：${result.errors.length} 处越界（${result.errors
      .map((error) => `${error.presetId ?? '布局'} / ${error.componentId ?? '—'}`)
      .join('、')}）`;
    return;
  }

  ui.save.disabled = true;
  try {
    const response = await fetch(projectApiUrl(state.projectPath), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: serializeProject(state.project),
    });
    const body = await response.json().catch(() => ({
      ok: false,
      errors: [`服务返回的不是 JSON（HTTP ${response.status}）`],
    }));

    if (!response.ok || body.ok !== true) {
      state.serverErrors = body.errors ?? [`HTTP ${response.status}`];
      renderValidation();
      ui.summary.classList.remove('good');
      ui.summary.classList.add('bad');
      ui.summary.textContent = `保存被服务端拒绝（HTTP ${response.status}）`;
      return;
    }

    state.project = body.project;
    state.dirty = false;
    state.lastSavedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    refresh();
    ui.summary.classList.remove('bad');
    ui.summary.classList.add('good');
    ui.summary.textContent = `已保存 ${body.path}：全部目标预设联合校验通过（${components().length} 个组件）`;
  } catch (error) {
    state.serverErrors = [`保存请求失败：${error.message}`];
    renderValidation();
  } finally {
    ui.save.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 渲染：预览 → 网格 → 组件轮廓 → 把手
// ---------------------------------------------------------------------------

/** 预绘静态层；布局、预设或示例数据变化时重建。 */
function rebuildPreview() {
  if (state.project === null || state.preset === null) return;

  try {
    const layer = createCanvas({ width: state.preset.width, height: state.preset.height });
    state.previewLayer = prepareStatic(layer.ctx, {
      preset: state.preset,
      components: components(),
      metrics: state.metrics ?? {},
      activity: state.activity ?? undefined,
    });
    state.previewError = null;
  } catch (error) {
    state.previewLayer = null;
    state.previewError = error.message;
  }
}

/** 按视口等比缩放画布；内部坐标仍是画布预设像素。 */
function applyScale() {
  const padding = 36;
  const availableWidth = Math.max(80, ui.stage.clientWidth - padding);
  const availableHeight = Math.max(80, ui.stage.clientHeight - padding);
  const fit = Math.min(availableWidth / state.preset.width, availableHeight / state.preset.height);

  state.scale = Math.min(1, Math.max(0.05, fit));
  const cssWidth = Math.round(state.preset.width * state.scale);
  const cssHeight = Math.round(state.preset.height * state.scale);

  if (ui.canvas.width !== state.preset.width) ui.canvas.width = state.preset.width;
  if (ui.canvas.height !== state.preset.height) ui.canvas.height = state.preset.height;
  ui.canvas.style.width = `${cssWidth}px`;
  ui.canvas.style.height = `${cssHeight}px`;
  ui.wrap.style.width = `${cssWidth}px`;
  ui.wrap.style.height = `${cssHeight}px`;
}

/** 主绘制：先 drawFrame（共享绘制模块），再叠加编辑辅助线。 */
function draw() {
  if (state.project === null || state.preset === null) return;

  const ctx = ui.canvas.getContext('2d');
  ctx.clearRect(0, 0, state.preset.width, state.preset.height);

  if (state.previewLayer !== null) {
    drawFrame(ctx, { preset: state.preset, metrics: state.metrics ?? {}, static: state.previewLayer });
  } else {
    drawPreviewFallback(ctx);
  }

  if (state.pixelProbePending && state.previewLayer !== null) {
    probeRenderedPixels(ctx);
    state.pixelProbePending = false;
  }

  if (state.gridVisible || state.drag !== null) drawGrid(ctx);
  drawComponentOutlines(ctx);
  drawSelectionHandles(ctx);
  renderReadout();
}

/** 预览不可用时不留白屏：画出原因，编辑与保存仍可继续。 */
function drawPreviewFallback(ctx) {
  const { width, height } = state.preset;
  ctx.save();
  ctx.fillStyle = 'rgba(255, 92, 92, 0.12)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ffc9c9';
  ctx.font = '600 32px Inter';
  ctx.textAlign = 'center';
  ctx.fillText('预览暂不可用', width / 2, height / 2 - 24);
  ctx.font = '400 22px Inter';
  ctx.fillText(state.previewError ?? '未知原因', width / 2, height / 2 + 24);
  ctx.restore();
}

/** 统计非透明像素；只在首帧调用一次，用来确认预览确实画出了内容。 */
function probeRenderedPixels(ctx) {
  const { width, height } = state.preset;
  const { data } = ctx.getImageData(0, 0, width, height);
  let count = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] > 0) count += 1;
  }
  document.body.dataset.renderedPixels = String(count);
}

/**
 * 网格线：铺满整张画布；可放置格位范围用更亮的线单独标出；安全区用虚线框。
 * 所有数值都来自 shared/presets.js 的解析结果，这里不做第二套换算。
 */
function drawGrid(ctx) {
  const { cellSize, grid, placeable, safeArea } = state.preset;
  ctx.save();

  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let col = 0; col <= grid.cols; col += 1) {
    const x = col * cellSize;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, grid.rows * cellSize);
  }
  for (let row = 0; row <= grid.rows; row += 1) {
    const y = row * cellSize;
    ctx.moveTo(0, y);
    ctx.lineTo(grid.cols * cellSize, y);
  }
  ctx.stroke();

  // 可放置格位：只画安全区内完整整格的边界，比全画布网格更亮。
  ctx.strokeStyle = PLACEABLE_COLOR;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let col = placeable.colStart; col <= placeable.colEnd + 1; col += 1) {
    const x = col * cellSize;
    const top = placeable.rowStart * cellSize;
    const bottom = (placeable.rowEnd + 1) * cellSize;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let row = placeable.rowStart; row <= placeable.rowEnd + 1; row += 1) {
    const y = row * cellSize;
    const left = placeable.colStart * cellSize;
    const right = (placeable.colEnd + 1) * cellSize;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();

  ctx.setLineDash([14, 10]);
  ctx.strokeStyle = SAFE_AREA_COLOR;
  ctx.lineWidth = 4;
  ctx.strokeRect(safeArea.x, safeArea.y, safeArea.width, safeArea.height);
  ctx.restore();
}

/** 当前要显示的矩形：拖动中的组件用吸附后的候选矩形，其余用布局矩形。 */
function visibleRectOf(component, rect) {
  if (state.drag !== null && state.drag.id === component.id) {
    return resolveComponentRect(state.drag.candidate, state.preset);
  }
  return rect;
}

/** 组件轮廓、名称与格位标签；隐藏组件用虚线灰色表示。 */
function drawComponentOutlines(ctx) {
  for (const { component, rect } of layoutRects(components(), state.preset)) {
    const live = visibleRectOf(component, rect);
    const selected = component.id === state.selectionId;
    const dragging = state.drag !== null && state.drag.id === component.id;

    ctx.save();
    if (dragging) {
      ctx.fillStyle = 'rgba(255, 209, 102, 0.10)';
      ctx.fillRect(live.x, live.y, live.width, live.height);
    }

    ctx.lineWidth = selected ? 5 : 2.5;
    ctx.strokeStyle = selected
      ? SELECTED_COLOR
      : (component.visible ? 'rgba(110, 200, 255, 0.62)' : 'rgba(150, 160, 175, 0.55)');
    ctx.setLineDash(component.visible ? [] : [12, 8]);
    ctx.strokeRect(live.x + 1, live.y + 1, live.width - 2, live.height - 2);
    ctx.setLineDash([]);

    const label = `${COMPONENT_LABELS[component.id] ?? component.id} · ${component.anchor}`
      + ` · col ${component.col} row ${component.row} · ${component.colSpan}×${component.rowSpan}`;
    ctx.font = '600 24px Inter';
    const labelWidth = ctx.measureText(label).width;
    const inside = live.y < 44;
    const labelTop = inside ? live.y + 8 : live.y - 38;
    // 贴右 / 贴底的组件标签不能画出画布外。
    const labelLeft = Math.max(4, Math.min(live.x + 4, state.preset.width - labelWidth - 18));

    ctx.fillStyle = 'rgba(6, 10, 16, 0.78)';
    ctx.fillRect(labelLeft, labelTop, labelWidth + 14, 32);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = selected ? '#ffe6a3' : 'rgba(205, 228, 248, 0.92)';
    ctx.fillText(label, labelLeft + 7, labelTop + 17);

    if (dragging && state.drag.overflow.length > 0) drawOverflowEdges(ctx, live, state.drag.overflow);
    ctx.restore();
  }
}

/** 拖动越界时把越界的那条边画成粗红线，越界量在下方读数里给出。 */
function drawOverflowEdges(ctx, rect, overflow) {
  ctx.save();
  ctx.strokeStyle = OVERFLOW_COLOR;
  ctx.lineWidth = 10;
  ctx.beginPath();
  for (const { edge } of overflow) {
    if (edge === 'left') { ctx.moveTo(rect.x, rect.y); ctx.lineTo(rect.x, rect.y + rect.height); }
    if (edge === 'right') { ctx.moveTo(rect.x + rect.width, rect.y); ctx.lineTo(rect.x + rect.width, rect.y + rect.height); }
    if (edge === 'top') { ctx.moveTo(rect.x, rect.y); ctx.lineTo(rect.x + rect.width, rect.y); }
    if (edge === 'bottom') { ctx.moveTo(rect.x, rect.y + rect.height); ctx.lineTo(rect.x + rect.width, rect.y + rect.height); }
  }
  ctx.stroke();
  ctx.restore();
}

/** 选中组件四角的整数格 Resize 把手。 */
function drawSelectionHandles(ctx) {
  const selected = selectedComponent();
  if (selected === null || state.drag !== null) return;

  const rect = componentRect(selected);
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ];

  ctx.save();
  ctx.fillStyle = SELECTED_COLOR;
  ctx.strokeStyle = 'rgba(8, 12, 18, 0.9)';
  ctx.lineWidth = 2;
  for (const corner of corners) {
    ctx.beginPath();
    ctx.rect(corner.x - HANDLE_SIZE / 2, corner.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** 底部读数：当前预设、可放置范围、拖动候选与越界量。 */
function renderReadout() {
  const { preset } = state;
  const placeableColumns = preset.placeable.colEnd - preset.placeable.colStart + 1;
  const placeableRows = preset.placeable.rowEnd - preset.placeable.rowStart + 1;
  const lines = [
    `编辑画布：${presetName(preset.id)} ${preset.width} × ${preset.height}`
      + ` · 格位 ${preset.cellSize} px · ${preset.grid.cols} 列 × ${preset.grid.rows} 行`
      + ` · 可放置 ${placeableColumns} × ${placeableRows} 格`,
  ];

  if (state.drag !== null) {
    const candidate = state.drag.candidate;
    const overflow = state.drag.overflow;
    lines.push(
      `候选：${candidate.anchor} · col ${candidate.col} / row ${candidate.row}`
        + ` · ${candidate.colSpan} × ${candidate.rowSpan} 格`
        + (overflow.length > 0 ? ` · 越界 ${describeOverflow(overflow)}` : ' · 松开即提交'),
    );
  } else if (state.actionError !== null) {
    lines.push(state.actionError);
  } else {
    const selected = selectedComponent();
    lines.push(selected === null
      ? '拖动组件移动；选中后拖四角按整数格 Resize。'
      : `已选 ${COMPONENT_LABELS[selected.id] ?? selected.id}：${selected.anchor} · col ${selected.col} / row ${selected.row}`
        + ` · ${selected.colSpan} × ${selected.rowSpan} 格 · zIndex ${selected.zIndex}`);
  }

  ui.readout.textContent = lines.join('\n');
}

function describeOverflow(overflow) {
  return overflow
    .map(({ edge, px, cells }) => `${EDGE_LABELS[edge]}越界 ${formatNumber(px)} px（${formatNumber(cells)} 格）`)
    .join('，');
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// 侧栏与校验提示
// ---------------------------------------------------------------------------

function refresh() {
  if (state.project === null || state.preset === null) return;
  rebuildPreview();
  renderPresetBar();
  renderProjectMeta();
  renderComponentList();
  renderValidation();
  applyScale();
  draw();
}

function renderPresetBar() {
  ui.sourcePreset.value = state.project.layout.sourcePresetId;

  ui.targetPresets.replaceChildren(...state.project.targetPresets.map((id) => {
    const item = document.createElement('li');
    item.textContent = `${presetName(id)}（${id}）`;
    return item;
  }));
}

function renderProjectMeta() {
  const { preset } = state;
  const suffix = state.dirty ? ' · 未保存的修改' : '';
  const saved = state.lastSavedAt === null ? '' : ` · 已保存 ${state.lastSavedAt}`;
  ui.projectMeta.textContent = `已载入 ${state.projectPath}：${components().length} 个组件`
    + ` · 画布 ${preset.width} × ${preset.height} · 格位 ${preset.cellSize} px`
    + ` · ${preset.grid.cols} 列 × ${preset.grid.rows} 行${suffix}${saved}`;
}

function renderComponentList() {
  ui.componentList.replaceChildren(...components().map((component) => {
    const item = document.createElement('li');
    item.className = 'component-item';
    item.dataset.id = component.id;
    if (component.id === state.selectionId) item.classList.add('selected');
    if (component.visible !== true) item.classList.add('hidden-component');

    const head = document.createElement('div');
    head.className = 'component-head';
    const name = document.createElement('strong');
    name.textContent = COMPONENT_LABELS[component.id] ?? component.id;
    const code = document.createElement('code');
    code.textContent = component.id;
    head.append(name, code);

    const meta = document.createElement('div');
    meta.className = 'component-meta';
    meta.textContent = `${component.anchor} · col ${component.col} / row ${component.row}`
      + ` · ${component.colSpan} × ${component.rowSpan} 格 · zIndex ${component.zIndex}`;

    const actions = document.createElement('div');
    actions.className = 'component-actions';
    actions.append(
      actionButton('raise', '上移'),
      actionButton('lower', '下移'),
    );

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.action = 'visible';
    checkbox.checked = component.visible === true;
    toggle.append(checkbox, document.createTextNode('显示'));
    actions.append(toggle);

    item.append(head, meta, actions);
    return item;
  }));
}

function actionButton(action, text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.action = action;
  button.textContent = text;
  return button;
}

/** 校验摘要、冲突提示（只提示）与错误（阻止保存）。 */
function renderValidation() {
  if (state.project === null) return;

  const presets = BUILTIN_PRESET_IDS.map(resolvePreset);
  const result = validateCandidate(state.project, presets);

  const errorItems = [
    ...state.runtimeErrors.map((message) => messageItem('运行错误', message, true)),
    ...(state.actionError === null ? [] : [messageItem('操作被拦下', state.actionError, true)]),
    ...state.serverErrors.map((message) => messageItem('服务端校验', message, true)),
    ...result.errors.map((error) => messageItem(
      `预设 ${error.presetId ?? '—'} · 组件 ${error.componentId ?? '—'}`,
      error.message,
      true,
    )),
  ];
  ui.errors.replaceChildren(...errorItems);

  const warningItems = [
    ...(state.previewError === null ? [] : [messageItem('预览', `预览暂不可用：${state.previewError}`, false)]),
    ...result.warnings.map((warning) => messageItem(
      `预设 ${warning.presetId ?? '—'} · 组件 ${warning.componentId ?? '—'} ↔ ${warning.otherComponentId ?? '—'}`,
      warning.message,
      false,
    )),
  ];
  ui.warnings.replaceChildren(...warningItems);

  ui.summary.classList.remove('good', 'bad');
  if (state.actionError !== null) {
    ui.summary.classList.add('bad');
    ui.summary.textContent = state.actionError;
    return;
  }

  if (result.ok) {
    ui.summary.classList.add('good');
    ui.summary.textContent = `全部目标预设通过联合校验：${state.project.targetPresets
      .map((id) => presetName(id)).join('、')}（${components().length} 个组件）`;
    return;
  }

  ui.summary.classList.add('bad');
  ui.summary.textContent = `存在 ${result.errors.length} 处越界，保存会被拒绝`;
}

function messageItem(meta, message, isError) {
  const item = document.createElement('li');
  const metaLine = document.createElement('span');
  metaLine.className = 'meta';
  metaLine.textContent = meta;
  item.append(metaLine, document.createTextNode(message));
  if (!isError) item.classList.add('warning');
  return item;
}

// ---------------------------------------------------------------------------
// 指针交互：事件坐标 → 预设像素 → 纯函数
// ---------------------------------------------------------------------------

/** 事件坐标换算成画布预设像素（按 canvas 实际显示尺寸等比反算）。 */
function canvasPoint(event) {
  const rect = ui.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (state.preset.width / rect.width),
    y: (event.clientY - rect.top) * (state.preset.height / rect.height),
  };
}

function contains(rect, point) {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function hitComponent(point) {
  const rects = layoutRects(components(), state.preset);
  for (let index = rects.length - 1; index >= 0; index -= 1) {
    if (contains(rects[index].rect, point)) return rects[index];
  }
  return null;
}

function hitHandle(point) {
  const selected = selectedComponent();
  if (selected === null) return null;

  const rect = componentRect(selected);
  const corners = {
    nw: { x: rect.x, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    sw: { x: rect.x, y: rect.y + rect.height },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
  };

  for (const [name, corner] of Object.entries(corners)) {
    if (Math.abs(point.x - corner.x) <= HANDLE_HIT && Math.abs(point.y - corner.y) <= HANDLE_HIT) {
      return name;
    }
  }
  return null;
}

function beginDrag(event, point, mode, handle) {
  const component = selectedComponent();
  if (component === null) return;

  const startRect = componentRect(component);
  state.drag = {
    id: component.id,
    component,
    mode,
    handle,
    startPoint: point,
    startRect,
    rect: startRect,
    candidate: component,
    overflow: [],
  };
  state.actionError = null;
  ui.canvas.setPointerCapture?.(event.pointerId);
}

function updateCursor(event) {
  if (state.drag !== null) return;
  const point = canvasPoint(event);
  const handle = hitHandle(point);
  if (handle !== null) {
    ui.canvas.style.cursor = handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
    return;
  }
  ui.canvas.style.cursor = hitComponent(point) === null ? 'default' : 'move';
}

ui.canvas.addEventListener('pointerdown', (event) => {
  if (state.project === null || event.button !== 0) return;

  const point = canvasPoint(event);
  const handle = hitHandle(point);
  if (handle !== null) {
    beginDrag(event, point, 'resize', handle);
    draw();
    return;
  }

  const hit = hitComponent(point);
  if (hit === null) {
    state.selectionId = null;
    refresh();
    return;
  }

  state.selectionId = hit.component.id;
  beginDrag(event, point, 'move', null);
  refresh();
});

ui.canvas.addEventListener('pointermove', (event) => {
  if (state.drag === null) {
    if (state.project !== null) updateCursor(event);
    return;
  }

  event.preventDefault();
  const point = canvasPoint(event);
  const delta = {
    dx: point.x - state.drag.startPoint.x,
    dy: point.y - state.drag.startPoint.y,
  };
  const rect = state.drag.mode === 'move'
    ? translateRect(state.drag.startRect, delta)
    : resizeRect(state.drag.startRect, state.drag.handle, delta);

  state.drag.rect = rect;
  state.drag.candidate = toCandidateComponent(state.drag.component, rect, state.preset);
  state.drag.overflow = safeAreaOverflow(state.drag.candidate, state.preset);
  draw();
});

ui.canvas.addEventListener('pointerup', (event) => {
  if (state.drag === null) return;

  const drag = state.drag;
  state.drag = null;
  try {
    ui.canvas.releasePointerCapture(event.pointerId);
  } catch {
    // 指针已释放时忽略。
  }

  const result = commitComponent(drag.component, drag.rect, state.preset);
  if (result.accepted) {
    setComponents(replaceComponent(components(), result.component));
    state.actionError = null;
  } else {
    state.actionError = `拖动被拦下，已回退到上一个合法位置：组件 ${drag.id} ${describeOverflow(result.overflow)}`;
  }
  refresh();
});

ui.canvas.addEventListener('pointercancel', () => {
  if (state.drag === null) return;
  state.drag = null;
  refresh();
});

// ---------------------------------------------------------------------------
// 侧栏事件
// ---------------------------------------------------------------------------

function setComponents(next) {
  state.project = { ...state.project, layout: { ...state.project.layout, components: next } };
  state.dirty = true;
  state.serverErrors = [];
}

ui.componentList.addEventListener('click', (event) => {
  const item = event.target.closest('li[data-id]');
  if (item === null) return;

  const id = item.dataset.id;
  const action = event.target.closest('button')?.dataset.action;
  if (action === 'raise') setComponents(changeLayer(components(), id, 1));
  if (action === 'lower') setComponents(changeLayer(components(), id, -1));

  state.selectionId = id;
  state.actionError = null;
  refresh();
});

ui.componentList.addEventListener('change', (event) => {
  const checkbox = event.target.closest('input[data-action="visible"]');
  if (checkbox === null) return;

  const id = checkbox.closest('li[data-id]').dataset.id;
  setComponents(setVisible(components(), id, checkbox.checked));
  refresh();
});

ui.sourcePreset.addEventListener('change', () => {
  if (state.project === null) return;
  state.project = switchSourcePreset(state.project, ui.sourcePreset.value);
  state.preset = resolvePreset(ui.sourcePreset.value);
  state.selectionId = null;
  state.actionError = null;
  state.dirty = true;
  state.pixelProbePending = true;
  refresh();
});

ui.gridToggle.addEventListener('change', () => {
  state.gridVisible = ui.gridToggle.checked;
  draw();
});

ui.load.addEventListener('click', () => {
  loadProject(ui.projectPath.value.trim() || 'project.json').catch((error) => {
    reportError(error);
    renderValidation();
  });
});

ui.projectPath.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  ui.load.click();
});

ui.save.addEventListener('click', () => {
  saveProject();
});

window.addEventListener('resize', () => {
  if (state.project === null) return;
  applyScale();
  draw();
});

// ---------------------------------------------------------------------------
// 启动与错误上报
// ---------------------------------------------------------------------------

/** 运行期错误既写进页面（供 headless 冒烟检查），也进侧栏错误列表。 */
function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  state.runtimeErrors = [...state.runtimeErrors, message];
  const item = document.createElement('div');
  item.textContent = message;
  ui.consoleErrors.append(item);
  const count = Number(document.body.dataset.consoleErrors ?? '0') + 1;
  document.body.dataset.consoleErrors = String(count);
}

function installErrorReporting() {
  window.addEventListener('error', (event) => {
    reportError(event.error ?? new Error(event.message));
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason ?? new Error('未处理的 Promise 拒绝'));
  });
}

function populatePresetSelect() {
  ui.sourcePreset.replaceChildren(...BUILTIN_PRESET_IDS.map((id) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${presetName(id)}（${id}）`;
    return option;
  }));
}

async function main() {
  installErrorReporting();
  populatePresetSelect();
  await registerFonts();
  await loadSample();
  await loadProject(state.projectPath);

  document.body.dataset.editorReady = 'true';
  document.title = 'hud-editor-ready';
}

main().catch((error) => {
  reportError(error);
  renderValidation();
  ui.summary.classList.remove('good');
  ui.summary.classList.add('bad');
  ui.summary.textContent = `编辑器启动失败：${error.message}`;
  ui.readout.textContent = `编辑器启动失败：${error.message}`;
});
