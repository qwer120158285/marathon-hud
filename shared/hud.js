/**
 * 共享绘制模块（纯函数：零 DOM、零 Node 专有 API）。
 *
 * 依据 ADR 0001：浏览器编辑器与命令行渲染器共用这一份绘制实现，`ctx` 由两端薄适配层传入。
 * 依据 ADR 0004：`shouldRender = configEnabled && dataAvailable`，缺值指标整行不绘制。
 *
 * 结构：
 * - `prepareStatic` 预绘一次静态层（底板、标签、单位）到离屏位图，并返回绘制计划；
 * - `drawFrame` 每帧只做一次 `drawImage` 合成 + 只画会变的数值，不重排静态文字、不重描静态路径；
 * - `DRAWERS` 按组件 id 分派，未实现的组件（route / progress / weather，见 #9 / #10）直接跳过。
 */
import { resolveComponentRect } from './layout.js';
import { COLORS, FONT_FAMILY, resolveTheme } from './theme.js';
import { shouldRender } from '../data/availability.mjs';

/** 数字等宽检测：只有阿拉伯数字按固定步进，冒号 / 小数点仍用字形自身宽度。 */
function isDigit(char) {
  return char >= '0' && char <= '9';
}

/** 组装 Canvas 字体串；字重决定选中哪一份 Inter 文件。 */
function fontString({ weight, size }) {
  return `${weight} ${size}px ${FONT_FAMILY}`;
}

/**
 * 固定数字步进与标点宽度，按字体现算一次后随绘制计划保存。
 *
 * 步进取 `measureText('0').width`：Inter 默认是比例字形（40 px 下 '0'=25.23 px、'1'=16.27 px），
 * 直接用 `measureText(整串)` 会让 PACE / HR / CAD 在数字变化时左右抖动。
 *
 * 为什么不用 `font-variant-numeric: tabular-nums`：`@napi-rs/canvas` 的 2D 上下文没有
 * `fontFeatureSettings` / `fontVariantNumeric`（`fontVariantCaps` 只认 small-caps 一类取值），
 * 浏览器侧同样只暴露 `fontVariantCaps`；OpenType 的 `tnum` 特性两端都打不开。
 * 所以在这里以固定步进逐字符绘制，两端行为一致且是可断言的纯函数。
 *
 * @param {CanvasRenderingContext2D} ctx 当前 `font` 已设置为目标字号与字重
 * @param {string[]} [extraChars] 需要一并缓存宽度的非数字字符
 * @returns {{ step: number, widths: Record<string, number> }}
 */
export function tabularMetrics(ctx, extraChars = [':']) {
  const widths = {};
  for (const char of extraChars) widths[char] = ctx.measureText(char).width;
  return { step: ctx.measureText('0').width, widths };
}

/** 取单个字符的推进量：数字走固定步进，其余用字形自身宽度。 */
function charWidth(ctx, char, tabular) {
  if (isDigit(char)) return tabular.step;
  if (Object.hasOwn(tabular.widths, char)) return tabular.widths[char];
  return ctx.measureText(char).width;
}

/**
 * 逐字符累加的等宽测量。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {{ step: number, widths: Record<string, number> }} [tabular]
 * @returns {number} 绘制宽度（px）
 */
export function measureTabularText(ctx, text, tabular = tabularMetrics(ctx)) {
  let width = 0;
  for (const char of text) width += charWidth(ctx, char, tabular);
  return width;
}

/**
 * 逐字符按固定步进绘制。`tabular` 由绘制计划预先算好，每帧不再测量文字。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x 起笔位置（左基线）
 * @param {number} baselineY 基线
 * @param {{ step: number, widths: Record<string, number> }} [tabular]
 * @returns {number} 推进量（px），等于 `measureTabularText`
 */
export function drawTabularText(ctx, text, x, baselineY, tabular = tabularMetrics(ctx)) {
  ctx.save();
  ctx.textAlign = 'left';
  let pen = x;
  for (const char of text) {
    ctx.fillText(char, Math.round(pen), baselineY);
    pen += charWidth(ctx, char, tabular);
  }
  ctx.restore();
  return pen - x;
}

/** 十位补零，用于配速的秒数。 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 配速秒数 → `m:ss`；非正数说明数据侧不可用，交给 drawFrame 跳过。 */
function formatPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return null;
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}:${pad2(total % 60)}`;
}

/**
 * 数据卡的行定义，顺序即绘制顺序（ADR 0004：默认三行 PACE / HR / CAD）。
 * `availability` 对应 data/availability.mjs 的字段名；`power` / `elevation` 子组件后续追加。
 */
const METRIC_ROWS = [
  {
    id: 'pace',
    label: 'PACE',
    unit: 'MIN / KM',
    availability: 'pace',
    field: 'paceSecPerKm',
    color: COLORS.value,
    format: formatPace,
  },
  {
    id: 'heartRate',
    label: 'HR',
    unit: 'BPM',
    availability: 'heartRate',
    field: 'heartRateBpm',
    color: COLORS.heartRate,
    format: (value) => (Number.isFinite(value) ? String(Math.round(value)) : null),
  },
  {
    id: 'cadence',
    label: 'CAD',
    unit: 'SPM',
    availability: 'cadence',
    field: 'cadenceSpm',
    color: COLORS.value,
    format: (value) => (Number.isFinite(value) ? String(Math.round(value)) : null),
  },
];

/** 圆角矩形路径；两端 Canvas 2D 都支持 `roundRect`。 */
function roundedPath(ctx, { x, y, width, height }, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/**
 * 指标组件：解析出底板矩形与每行的文字位置。
 *
 * 只做几何与文字排布，不落笔；静态部分由 `drawStaticLayer` 绘制，数值由 `drawFrame` 绘制。
 * 矩形一律来自 `resolveComponentRect`，本函数里没有硬编码坐标。
 */
function planMetrics(ctx, { preset, component, metrics }) {
  // configEnabled 来自布局，dataAvailable 来自运行时（metrics.availability），不读配置。
  if (component.visible !== true) return null;

  const availability = metrics?.availability ?? {};
  const rows = METRIC_ROWS.filter((row) => shouldRender(component.visible, availability[row.availability] === true));
  // 没有一行可画就不画底板：不留空行、不显示 0、不留一块空卡片。
  if (rows.length === 0) return null;

  const theme = resolveTheme(preset);
  const rect = resolveComponentRect(component, preset);
  const labelLine = Math.round(theme.label.size * theme.label.lineHeight);
  const valueLine = Math.round(theme.value.size * theme.value.lineHeight);
  const rowHeight = labelLine + valueLine + theme.rowGap;
  // 最后一行不留 rowGap，卡片高度随可用指标数收缩。
  const panelHeight = theme.paddingY * 2 + rows.length * rowHeight - theme.rowGap;

  if (panelHeight > rect.height) {
    throw new Error(
      `组件 ${component.id} 的矩形高 ${rect.height} px 容不下 ${rows.length} 行数据卡`
        + `（需要 ${panelHeight} px），请增大 rowSpan`,
    );
  }

  // 卡片贴组件矩形的底边（bottom-* 锚点）或顶边（top-* 锚点），收缩方向跟随锚点。
  const panel = {
    x: rect.x,
    y: component.anchor.startsWith('bottom') ? rect.y + rect.height - panelHeight : rect.y,
    width: rect.width,
    height: panelHeight,
  };

  const staticTexts = [];
  const dynamic = [];
  const valueFont = fontString(theme.value);
  const labelFont = fontString(theme.label);
  const unitFont = fontString(theme.unit);

  // 数值的固定步进只在预绘时算一次，随计划带到每帧，drawFrame 不再测量文字。
  ctx.font = valueFont;
  const valueTabular = tabularMetrics(ctx);

  rows.forEach((row, index) => {
    const rowTop = panel.y + theme.paddingY + index * rowHeight;
    const labelBaseline = rowTop + Math.round(theme.label.size * theme.ascentRatio);
    const valueBaseline = rowTop + labelLine + Math.round(theme.value.size * theme.ascentRatio);
    const textX = panel.x + theme.paddingX;

    staticTexts.push({
      text: row.label,
      font: labelFont,
      color: COLORS.label,
      x: textX,
      baseline: labelBaseline,
    });

    // 单位位置以计划时的数值宽度为准；数值等宽，数字位数不变时不会推动单位。
    const value = row.format(metrics?.[row.field]);
    const valueWidth = value === null ? 0 : measureTabularText(ctx, value, valueTabular);

    staticTexts.push({
      text: row.unit,
      font: unitFont,
      color: COLORS.label,
      x: textX + valueWidth + theme.unitGap,
      baseline: valueBaseline,
    });

    dynamic.push({
      rowId: row.id,
      field: row.field,
      format: row.format,
      font: valueFont,
      color: row.color,
      x: textX,
      baseline: valueBaseline,
      value,
      tabular: valueTabular,
    });
  });

  return {
    componentId: component.id,
    rect,
    panel: { ...panel, radius: theme.radius, strokeWidth: theme.strokeWidth },
    staticTexts,
    dynamic,
  };
}

/**
 * 按组件 id 分派。
 * route（#9）、progress / weather（#10）在本票不实现——没有条目就是「跳过」。
 */
const DRAWERS = {
  metrics: planMetrics,
};

/** 绘制顺序：`zIndex` 小的先画（ADR 0005：层级由布局显式给出）。 */
function sortForDraw(components) {
  return [...(components ?? [])]
    .map((component, index) => ({ component, index }))
    .sort((a, b) => {
      const az = Number.isFinite(a.component?.zIndex) ? a.component.zIndex : 0;
      const bz = Number.isFinite(b.component?.zIndex) ? b.component.zIndex : 0;
      return az - bz || a.index - b.index;
    })
    .map(({ component }) => component);
}

/** 生成绘制计划；同一份计划同时供静态层、每帧数值与关键区域使用。 */
function buildPlan(ctx, { preset, components, metrics }) {
  const plan = [];
  for (const component of sortForDraw(components)) {
    if (typeof component?.id !== 'string') continue;
    const drawer = DRAWERS[component.id];
    if (drawer === undefined) continue;
    const item = drawer(ctx, { preset, component, metrics });
    if (item !== null) plan.push(item);
  }
  return plan;
}

/** 静态层落笔：底板一次填充 + 一次描边，标签与单位各写一次。 */
function drawStaticLayer(ctx, plan) {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  for (const item of plan) {
    roundedPath(ctx, item.panel, item.panel.radius);
    ctx.fillStyle = COLORS.panelFill;
    ctx.fill();
    ctx.strokeStyle = COLORS.panelStroke;
    ctx.lineWidth = item.panel.strokeWidth;
    ctx.stroke();

    for (const text of item.staticTexts) {
      ctx.font = text.font;
      ctx.fillStyle = text.color;
      ctx.fillText(text.text, text.x, text.baseline);
    }
  }

  ctx.restore();
}

/**
 * 预绘静态层。
 *
 * 调用方（适配层）负责创建离屏画布并把它的 `ctx` 传进来；本函数只落笔、不做环境操作。
 * 返回的对象要原样交给 `drawFrame` 的 `static` 参数。
 *
 * @param {CanvasRenderingContext2D} ctx 离屏画布的上下文
 * @param {{ preset: object, components: object[], metrics: object }} input
 * @returns {{ canvas: object, plan: object[] }}
 */
export function prepareStatic(ctx, { preset, components, metrics }) {
  const plan = buildPlan(ctx, { preset, components, metrics });
  drawStaticLayer(ctx, plan);
  return { canvas: ctx.canvas, plan };
}

/**
 * 绘制一帧：清屏 → 一次合成静态层 → 只画会变的数值。
 *
 * 不接收 `components`：几何全部来自 `prepareStatic` 返回的计划，
 * 这样「静态层用一份布局、数值用另一份布局」的错误在接口上就写不出来。
 *
 * @param {CanvasRenderingContext2D} ctx 每帧复用的画布上下文
 * @param {{ preset: object, metrics: object, static: { canvas: object, plan: object[] } }} input
 */
export function drawFrame(ctx, { preset, metrics, static: staticLayer }) {
  if (staticLayer === undefined || staticLayer === null || staticLayer.canvas === undefined) {
    throw new Error('drawFrame 需要 prepareStatic 返回的静态层（static.canvas 缺失）');
  }

  const { width, height } = preset;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(staticLayer.canvas, 0, 0);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const item of staticLayer.plan) {
    for (const entry of item.dynamic) {
      const value = entry.format(metrics?.[entry.field]);
      // 该时刻取不到值就不画数字：不留占位、不写 0（ADR 0004）。
      if (value === null) continue;
      ctx.font = entry.font;
      ctx.fillStyle = entry.color;
      drawTabularText(ctx, value, entry.x, entry.baseline, entry.tabular);
    }
  }
  ctx.restore();
}

/** 文字外扩的保护带（px @ 短边 1080），用于关键区域（ADR 0001）。 */
const TEXT_PROTECTION_PX = 4;
/** 组件边界矩形外扩（px），用于关键区域（ADR 0001）。 */
export const COMPONENT_REGION_INFLATE_PX = 8;

/** 单条文字的实际绘制包围盒（含基线附近的保护带）。 */
function textBox(ctx, entry, preset) {
  const protection = Math.max(1, Math.round(TEXT_PROTECTION_PX * (preset?.scale ?? 1)));
  ctx.font = entry.font;
  const metrics = ctx.measureText(entry.text);
  const size = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(entry.font)?.[1] ?? '0') || 16;
  const width = measureTabularText(ctx, entry.text);
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
    ? metrics.actualBoundingBoxAscent
    : size * 0.78;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
    ? metrics.actualBoundingBoxDescent
    : size * 0.22;

  return {
    x: entry.x - protection,
    y: entry.baseline - ascent - protection,
    width: width + protection * 2,
    height: ascent + descent + protection * 2,
  };
}

/**
 * 关键区域（GLOSSARY）：组件边界矩形外扩 8 px ∪ 文字实际绘制包围盒（含保护带）。
 *
 * 比对脚本用它确定更严格容差的范围；`kind` 区分两类区域：
 * - `component`：组件边界矩形（底板、描边、留白），比对时严格逐像素；
 * - `text`：文字实际绘制包围盒，允许 ±1 px 的字形相位差（平台光栅器差异）。
 * 返回未合并的矩形列表，合并与面积统计由调用方完成。
 *
 * @param {CanvasRenderingContext2D} ctx 只用于测量文字的上下文
 * @param {{ preset: object, components: object[], metrics: object }} input
 * @returns {{ kind: 'component' | 'text', x: number, y: number, width: number, height: number }[]}
 */
export function collectCriticalRegions(ctx, { preset, components, metrics }) {
  const plan = buildPlan(ctx, { preset, components, metrics });
  const inflate = Math.max(1, Math.round(COMPONENT_REGION_INFLATE_PX * (preset?.scale ?? 1)));
  const regions = [];

  for (const item of plan) {
    const { x, y, width, height } = item.rect;
    regions.push({
      kind: 'component',
      x: x - inflate,
      y: y - inflate,
      width: width + inflate * 2,
      height: height + inflate * 2,
    });
    for (const text of item.staticTexts) regions.push({ kind: 'text', ...textBox(ctx, text, preset) });
    for (const entry of item.dynamic) {
      if (entry.value === null) continue;
      regions.push({ kind: 'text', ...textBox(ctx, { ...entry, text: entry.value }, preset) });
    }
  }

  return regions;
}
