/**
 * 共享绘制模块（纯函数：零 DOM、零 Node 专有 API）。
 *
 * 依据 ADR 0001：浏览器编辑器与命令行渲染器共用这一份绘制实现，`ctx` 由两端薄适配层传入。
 * 依据 ADR 0004：`shouldRender = configEnabled && dataAvailable`，缺值指标整行不绘制。
 *
 * 结构：
 * - `prepareStatic` 预绘一次静态层（底板、标签、单位、完整路线、进度轨道与刻度）到离屏位图，并返回绘制计划；
 * - `drawFrame` 每帧只做一次 `drawImage` 合成 + 只画会变的部分（数值、路线高亮与箭头、进度填充）；
 * - `DRAWERS` 按组件 id 分派；weather 是纯静态覆盖（整场不变，`dynamic` 恒为空）。
 */
import {
  isBottomAnchor,
  resolveComponentRect,
} from './layout.js';
import { COLORS, FONT_FAMILY, resolveTheme } from './theme.js';
import {
  DEFAULT_TIMEZONE,
  formatWallClock,
  mergeWeatherValues,
  weatherPhrase,
} from './weather.js';
import { shouldRender } from './policy.js';

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
 * `availability` 对应 data/availability.mjs 的字段名；带 `subcomponent` 的行是可选项，
 * 由所属组件的 `subcomponents.<id>` 单独开关，默认关闭。
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
  {
    id: 'power',
    label: 'POWER',
    unit: 'W',
    availability: 'power',
    field: 'powerWatts',
    subcomponent: 'power',
    color: COLORS.value,
    format: (value) => (Number.isFinite(value) ? String(Math.round(value)) : null),
  },
  {
    id: 'elevation',
    label: 'ELEV',
    unit: 'M',
    availability: 'altitude',
    field: 'altitudeM',
    subcomponent: 'elevation',
    color: COLORS.value,
    format: (value) => (Number.isFinite(value) ? String(Math.round(value)) : null),
  },
];

/** 某一行是否同时满足「配置开启」与「数据可用」；子组件的配置开关在父组件的 subcomponents 上。 */
function rowEnabled(component, row, availability) {
  const configEnabled = row.subcomponent === undefined
    ? component.visible === true
    : component.subcomponents?.[row.subcomponent] === true;
  return shouldRender(configEnabled, availability[row.availability] === true);
}

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
  const rows = METRIC_ROWS.filter((row) => rowEnabled(component, row, availability)
    // 可选行的单位位置依赖数值宽度，参考帧取不到值就不排这一行（不画标签配空数字）。
    // 基础三行不依赖参考帧的具体取值：帧循环会传入只带 availability 的 metrics。
    && (row.subcomponent === undefined || row.format(metrics?.[row.field]) !== null));
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
    y: isBottomAnchor(component.anchor) ? rect.y + rect.height - panelHeight : rect.y,
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
 * 等距圆柱投影：整条轨迹等比压进「组件矩形减去内边距」的框里并居中。
 *
 * 经度按平均纬度的余弦压缩（`cos(lat)`），保证小范围内东西向与南北向的比例正确；
 * 纬度为 0 或所有点重合时退化为中心一个点，不除零。
 *
 * 经纬度缺失（`null`）的采样点不参与投影，并把轨迹**断开**：相邻两次 GPS 有效之间
 * 各自成为独立的 `run`，因此「前 36 点无 GPS」不会从原点拉一条直线穿过去。
 *
 * @param {{ lat: number|null, lon: number|null, distanceM?: number|null }[]} samples
 * @param {{ x: number, y: number, width: number, height: number }} rect 组件矩形
 * @param {number} padding 内边距（px）
 * @returns {{ runs: { x: number, y: number, distanceM: number|null }[][],
 *             segmentCount: number, projection: object }}
 */
export function projectRoute(samples, rect, padding) {
  const runs = [];
  let current = null;
  let lastDistance = null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const sample of samples ?? []) {
    const lat = sample?.lat;
    const lon = sample?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      current = null;
      continue;
    }
    if (Number.isFinite(sample.distanceM)) lastDistance = sample.distanceM;
    if (current === null) {
      current = [];
      runs.push(current);
    }
    // 缺距离的 GPS 点沿用上一有效距离：累计距离是单调量，缺值不该让高亮跳回起点。
    current.push({ lat, lon, distanceM: lastDistance });
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  const segmentCount = runs.reduce((count, run) => count + Math.max(0, run.length - 1), 0);
  if (runs.length === 0) {
    return { runs, segmentCount, projection: { scale: 0, cosLat: 1, offsetX: rect.x, offsetY: rect.y } };
  }

  const meanLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((meanLat * Math.PI) / 180);
  const spanX = (maxLon - minLon) * cosLat;
  const spanY = maxLat - minLat;
  const innerWidth = Math.max(0, rect.width - padding * 2);
  const innerHeight = Math.max(0, rect.height - padding * 2);

  // 某一轴跨度为 0 时该轴不限制缩放；两轴都为 0 时 scale 取 0（所有点重合，居中即可）。
  const scaleX = spanX > 0 ? innerWidth / spanX : Infinity;
  const scaleY = spanY > 0 ? innerHeight / spanY : Infinity;
  const rawScale = Math.min(scaleX, scaleY);
  const scale = Number.isFinite(rawScale) ? rawScale : 0;

  const offsetX = rect.x + (rect.width - spanX * scale) / 2;
  const offsetY = rect.y + (rect.height - spanY * scale) / 2;

  const projected = runs.map((run) => run.map((point) => ({
    x: offsetX + (point.lon - minLon) * cosLat * scale,
    y: offsetY + (maxLat - point.lat) * scale,
    distanceM: point.distanceM,
  })));

  return {
    runs: projected,
    segmentCount,
    projection: { scale, cosLat, offsetX, offsetY, minLat, minLon },
  };
}

/**
 * 已完成的轨迹：从起点高亮到当前时刻。
 *
 * 每帧按当前累计距离在轨迹上截断，返回可直接描边的路径段（`completed`）、
 * 截断点（`tip`）与行进方向（`heading`，屏幕坐标弧度）。距离落在 GPS 缺口里时
 * 只高亮到缺口前的最后一个点，不跨过缺口连线。
 *
 * @param {{ runs: { x: number, y: number, distanceM: number|null }[][] }} route 绘制计划里的路线
 * @param {number|null} distanceM 当前累计距离（米）
 * @returns {{ completed: { x: number, y: number }[][], tip: { x: number, y: number },
 *             heading: number|null } | null} 没有任何已完成的点时为 null
 */
export function routeProgressAt(route, distanceM) {
  if (!Number.isFinite(distanceM)) return null;

  const completed = [];
  let tip = null;
  let heading = null;
  let reached = false;

  for (const run of route.runs) {
    const runPoints = [];

    for (let index = 0; index < run.length; index += 1) {
      const point = run[index];
      // 没有距离的 GPS 点按 0 处理（只在活动开头出现，此时本来就在起点附近）。
      const distance = point.distanceM ?? 0;

      if (distance <= distanceM) {
        runPoints.push(point);
        continue;
      }

      // 当前距离落在本段内：按距离插值到精确位置，作为高亮终点与箭头起点。
      const before = run[index - 1];
      if (before !== undefined) {
        const beforeDistance = before.distanceM ?? 0;
        if (distance > beforeDistance) {
          const ratio = Math.max(0, Math.min(1, (distanceM - beforeDistance) / (distance - beforeDistance)));
          runPoints.push({
            x: before.x + (point.x - before.x) * ratio,
            y: before.y + (point.y - before.y) * ratio,
          });
        }
      }
      reached = true;
      break;
    }

    if (runPoints.length === 0) {
      // 本段还没开始（当前距离落在缺口里）：不画、也不跨缺口取方向。
      if (reached) break;
      continue;
    }

    const last = runPoints.at(-1);
    // 只有一个点的段没有可供描边的线段，不进路径；但它仍可能是截断点。
    if (runPoints.length > 1) {
      completed.push(runPoints);
      const before = runPoints.at(-2);
      const dx = last.x - before.x;
      const dy = last.y - before.y;
      // 方向只在本段内取：箭头不会跨过 GPS 缺口指向别处。
      heading = dx === 0 && dy === 0 ? null : Math.atan2(dy, dx);
    } else {
      heading = null;
    }
    tip = last;

    if (reached) break;
  }

  if (tip === null) return null;
  return { completed, tip, heading };
}

/** 速度接近 0（配速为 null / 非正 / 大于 1 h/km）时视为原地，不画方向箭头。 */
function isMoving(paceSecPerKm) {
  return Number.isFinite(paceSecPerKm) && paceSecPerKm > 0 && paceSecPerKm < 3600;
}

/**
 * 路线组件：解析组件矩形与投影后的轨迹。
 *
 * 完整路线不随时刻变化（静态层预绘）；已完成段与箭头在 `drawFrame` 里按当前距离重画。
 * 数据可用性来自 `availability.gps`，配置来自 `visible`，两者都成立才进入计划。
 */
function planRoute(ctx, { preset, component, metrics, activity }) {
  if (!shouldRender(component.visible, metrics?.availability?.gps === true)) return null;

  const samples = activity?.samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;

  const theme = resolveTheme(preset);
  const rect = resolveComponentRect(component, preset);
  const route = projectRoute(samples, rect, theme.route.padding);
  // 没有任何有效经纬度：画不出路线，跳过而不是画一块空底板。
  if (route.runs.length === 0) return null;

  return {
    componentId: component.id,
    rect,
    panel: null,
    staticTexts: [],
    dynamic: [],
    route: {
      ...route,
      lineWidth: theme.route.lineWidth,
      baseColor: theme.route.baseColor,
      doneWidth: theme.route.doneWidth,
      doneColor: theme.route.doneColor,
      arrowLength: theme.route.arrowLength,
      arrowWidth: theme.route.arrowWidth,
    },
  };
}

/** 把若干路径段描成一条折线（每段一个 moveTo，段与段之间不连线）。 */
function strokeRuns(ctx, runs) {
  ctx.beginPath();
  for (const run of runs) {
    if (run.length === 0) continue;
    ctx.moveTo(run[0].x, run[0].y);
    for (let index = 1; index < run.length; index += 1) {
      ctx.lineTo(run[index].x, run[index].y);
    }
  }
  ctx.stroke();
}

/** 静态层：完整路线（一次描边，不随时刻变化）。 */
function drawRouteBase(ctx, route) {
  ctx.strokeStyle = route.baseColor;
  ctx.lineWidth = route.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  strokeRuns(ctx, route.runs);
}

/** 动态层：已完成段高亮 + 沿当前方向指的箭头。 */
function drawRouteProgress(ctx, route, metrics) {
  const progress = routeProgressAt(route, metrics?.distanceM);
  if (progress === null) return;

  if (progress.completed.length > 0) {
    ctx.strokeStyle = route.doneColor;
    ctx.lineWidth = route.doneWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeRuns(ctx, progress.completed);
  }

  if (progress.heading === null || !isMoving(metrics?.paceSecPerKm)) return;

  const { tip } = progress;
  const dx = Math.cos(progress.heading);
  const dy = Math.sin(progress.heading);
  const halfWidth = route.arrowWidth / 2;
  ctx.beginPath();
  ctx.moveTo(tip.x + dx * route.arrowLength, tip.y + dy * route.arrowLength);
  ctx.lineTo(tip.x - dy * halfWidth, tip.y + dx * halfWidth);
  ctx.lineTo(tip.x + dy * halfWidth, tip.y - dx * halfWidth);
  ctx.closePath();
  ctx.fillStyle = route.doneColor;
  ctx.fill();
}

/**
 * 进度组件：已跑距离 / 总距离 + 进度条（可带公里刻度）。
 *
 * 总距离来自整场活动的 `activity.totalDistanceM`，当前距离来自此刻的 `metrics.distanceM`；
 * 两者都是运行时数据，不写进配置。公里刻度只按真实 Lap 派生出的 `activity.kmMarkers` 落点，
 * Lap 不完整时那一段就没有刻度，绝不按整公里补齐。
 */
function planProgress(ctx, { preset, component, metrics, activity }) {
  if (component.visible !== true) return null;

  const totalDistanceM = activity?.totalDistanceM;
  const distanceM = metrics?.distanceM;
  // 比例的分母与分子都必须有真实取值，否则宁可整块不画。
  if (!Number.isFinite(totalDistanceM) || totalDistanceM <= 0) return null;
  if (!Number.isFinite(distanceM)) return null;

  const theme = resolveTheme(preset);
  const style = theme.progress;
  const rect = resolveComponentRect(component, preset);
  const valueLine = Math.round(style.value.size * style.value.lineHeight);
  // 标签、数值、总量、单位排在同一行（行高按数值字号算），下面接进度条。
  const panelHeight = style.paddingY * 2 + valueLine + style.barGap + style.barHeight;

  if (panelHeight > rect.height) {
    throw new Error(
      `组件 ${component.id} 的矩形高 ${rect.height} px 容不下进度卡`
        + `（需要 ${panelHeight} px），请增大 rowSpan`,
    );
  }

  const panel = {
    x: rect.x,
    y: isBottomAnchor(component.anchor) ? rect.y + rect.height - panelHeight : rect.y,
    width: rect.width,
    height: panelHeight,
  };
  const bar = {
    x: panel.x + style.paddingX,
    y: panel.y + style.paddingY + valueLine + style.barGap,
    width: panel.width - style.paddingX * 2,
    height: style.barHeight,
    radius: style.barRadius,
  };

  const labelFont = fontString(style.label);
  const valueFont = fontString(style.value);
  const unitFont = fontString(style.unit);

  ctx.font = valueFont;
  const valueTabular = tabularMetrics(ctx, [':', '.']);
  const value = formatDistance(distanceM);
  const valueWidth = value === null ? 0 : measureTabularText(ctx, value, valueTabular);

  const baseline = panel.y + style.paddingY + Math.round(style.value.size * style.ascentRatio);
  const textX = panel.x + style.paddingX;

  ctx.font = labelFont;
  const labelTabular = tabularMetrics(ctx, [':', '.', '/', ' ']);
  const labelWidth = measureTabularText(ctx, 'DISTANCE', labelTabular);
  const valueX = textX + labelWidth + style.valueGap;

  const totalText = `/ ${formatDistance(totalDistanceM)}`;
  const totalWidth = measureTabularText(ctx, totalText, labelTabular);

  const staticTexts = [
    { text: 'DISTANCE', font: labelFont, color: COLORS.label, x: textX, baseline },
    {
      text: totalText,
      font: labelFont,
      color: COLORS.label,
      x: valueX + valueWidth + style.valueGap,
      baseline,
    },
    {
      text: 'KM',
      font: unitFont,
      color: COLORS.label,
      x: valueX + valueWidth + style.valueGap + totalWidth + theme.unitGap,
      baseline,
    },
  ];

  const markers = [];
  const lapMarkersOn = shouldRender(
    component.subcomponents?.lapMarkers === true,
    metrics?.availability?.lapMarkers === true,
  );
  if (lapMarkersOn) {
    for (const marker of activity?.kmMarkers ?? []) {
      if (!Number.isFinite(marker?.distanceM)) continue;
      const markerRatio = marker.distanceM / totalDistanceM;
      // 超出活动总距离的刻度没有落点；不补、不外推。
      if (markerRatio <= 0 || markerRatio > 1) continue;
      markers.push({ distanceM: marker.distanceM, ratio: markerRatio, x: bar.x + markerRatio * bar.width });
    }
  }

  return {
    componentId: component.id,
    rect,
    panel: { ...panel, radius: theme.radius, strokeWidth: theme.strokeWidth },
    staticTexts,
    dynamic: [
      {
        rowId: 'distance',
        field: 'distanceM',
        format: formatDistance,
        font: valueFont,
        color: COLORS.value,
        x: valueX,
        baseline,
        value,
        tabular: valueTabular,
      },
    ],
    progress: {
      bar,
      ratio: Math.max(0, Math.min(1, distanceM / totalDistanceM)),
      totalDistanceM,
      trackColor: style.trackColor,
      fillColor: style.fillColor,
      markers,
      marker: {
        width: style.markerWidth,
        height: bar.height + style.markerOverhang * 2,
        color: style.markerColor,
      },
    },
  };
}

/** 距离格式：千米两位小数（3.2105 km → "3.21"）；无效值交给 drawFrame 跳过。 */
function formatDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return null;
  return (meters / 1000).toFixed(2);
}

/** 静态层：进度条轨道与公里刻度（整场活动不变）。 */
function drawProgressStatic(ctx, progress) {
  const { bar } = progress;
  roundedPath(ctx, bar, Math.min(bar.radius, bar.width / 2, bar.height / 2));
  ctx.fillStyle = progress.trackColor;
  ctx.fill();

  if (progress.markers.length === 0) return;
  const half = progress.marker.height / 2;
  ctx.beginPath();
  for (const marker of progress.markers) {
    ctx.moveTo(marker.x, bar.y - half);
    ctx.lineTo(marker.x, bar.y + bar.height + half);
  }
  ctx.strokeStyle = progress.marker.color;
  ctx.lineWidth = progress.marker.width;
  ctx.stroke();
}

/** 动态层：按当前比例重画进度条填充。 */
function drawProgressFrame(ctx, progress) {
  const { bar } = progress;
  const width = progress.ratio * bar.width;
  if (width <= 0) return;

  roundedPath(ctx, { x: bar.x, y: bar.y, width, height: bar.height }, Math.min(bar.radius, width / 2, bar.height / 2));
  ctx.fillStyle = progress.fillColor;
  ctx.fill();
}

/** 温度：取整（快照的小数位对画面没有意义，也不做单位换算）；单位单独用 unit 字号画。 */
function formatTemperature(celsius) {
  return Number.isFinite(celsius) ? String(Math.round(celsius)) : null;
}

/** 相对湿度：整数百分比。 */
function formatHumidity(pct) {
  return Number.isFinite(pct) ? `${Math.round(pct)}%` : null;
}

/** 降水量：一位小数 + MM。 */
function formatPrecipitation(mm) {
  return Number.isFinite(mm) ? `${mm.toFixed(1)} MM` : null;
}

/**
 * 天气组件：静态覆盖卡片（GLOSSARY「天气快照」「静态覆盖」「墙钟」）。
 *
 * 全部内容整场活动不变，因此只进静态层：`dynamic` 恒为空数组，
 * `drawFrame` 只合成一次离屏位图，不重排文字、不描路径。
 *
 * 显示规则（ADR 0004：`shouldRender = configEnabled && dataAvailable`）：
 * - 组件不可见、没有快照、或快照里一个可用数值都没有 → 整块不画（不画 0、不画占位）；
 * - 缺某个数值就少那一段：只有温度时没有湿度 / 降水那段，天气码不是整数时省略短语；
 * - 天气短语用英文（见 shared/weather.js）：全部分支只走随项目打包的 Inter；
 * - 墙钟取 `activity.startTimeUtc` 按配置时区换算，与视频当前时刻无关。
 */
function planWeather(ctx, { preset, component, activity, weatherSnapshot, timezone }) {
  const merged = mergeWeatherValues(weatherSnapshot);
  if (!shouldRender(component.visible === true, merged !== null)) return null;

  const values = merged.values;
  const phrase = weatherPhrase(values.weatherCode);
  const wallClock = formatWallClock(activity?.startTimeUtc, timezone ?? DEFAULT_TIMEZONE);
  const temperature = formatTemperature(values.temperatureC);
  const detailParts = [formatHumidity(values.humidityPct), formatPrecipitation(values.precipitationMm)]
    .filter((part) => part !== null);
  const detail = detailParts.length === 0 ? null : detailParts.join(' · ');

  // 只有标签和墙钟时不成卡片：没有天气内容就不占位。
  if (temperature === null && phrase === null && detail === null) return null;

  const theme = resolveTheme(preset);
  const style = theme.weather;
  const rect = resolveComponentRect(component, preset);
  const labelLine = Math.round(style.label.size * style.label.lineHeight);
  const valueLine = Math.round(style.value.size * style.value.lineHeight);
  const detailLine = Math.round(style.unit.size * style.unit.lineHeight);
  const hasValueRow = temperature !== null || phrase !== null;

  // 从上往下累加行高，面板高度随可用内容收缩（与数据卡一致，最后一行不留间距）。
  // 这里只算相对面板顶部的偏移，确定面板位置后再加到基线上。
  let offset = style.paddingY;
  const labelOffset = offset + Math.round(style.label.size * style.ascentRatio);
  offset += labelLine;
  let valueOffset = null;
  if (hasValueRow) {
    offset += style.labelToValueGap;
    valueOffset = offset + Math.round(style.value.size * style.ascentRatio);
    offset += valueLine;
  }
  let detailOffset = null;
  if (detail !== null) {
    offset += style.valueToDetailGap;
    detailOffset = offset + Math.round(style.unit.size * style.ascentRatio);
    offset += detailLine;
  }
  const panelHeight = offset + style.paddingY;

  if (panelHeight > rect.height) {
    throw new Error(
      `组件 ${component.id} 的矩形高 ${rect.height} px 容不下天气卡`
        + `（需要 ${panelHeight} px），请增大 rowSpan`,
    );
  }

  const panel = {
    x: rect.x,
    y: isBottomAnchor(component.anchor) ? rect.y + rect.height - panelHeight : rect.y,
    width: rect.width,
    height: panelHeight,
  };

  const textX = panel.x + style.paddingX;
  const labelBaseline = panel.y + labelOffset;
  const valueBaseline = valueOffset === null ? null : panel.y + valueOffset;
  const detailBaseline = detailOffset === null ? null : panel.y + detailOffset;
  const labelFont = fontString(style.label);
  const valueFont = fontString(style.value);
  const unitFont = fontString(style.unit);
  const staticTexts = [
    { text: 'WEATHER', font: labelFont, color: COLORS.label, x: textX, baseline: labelBaseline },
  ];

  // 墙钟右对齐：对齐位置在预绘时按标签字体量好，每帧不再测量。
  // 位置取整：两端 measureText 的小数位可能差一点点，取整后文字落在同一像素相位上。
  if (wallClock !== null) {
    ctx.font = labelFont;
    const clockWidth = Math.round(ctx.measureText(wallClock).width);
    staticTexts.push({
      text: wallClock,
      font: labelFont,
      color: COLORS.label,
      x: panel.x + panel.width - style.paddingX - clockWidth,
      baseline: labelBaseline,
    });
  }

  if (hasValueRow) {
    // 与数据卡一致：主数值用 value 字号，单位与短语用 unit 字号跟在后面。
    // 没有温度时退化为短语本身（用 value 字号），不重复画两遍。
    // 短语是英文，与其余标签同一套 Inter，不再有第二套字体分支。
    const primary = temperature ?? phrase;
    staticTexts.push({ text: primary, font: valueFont, color: COLORS.value, x: textX, baseline: valueBaseline });

    if (temperature !== null) {
      ctx.font = valueFont;
      let cursorX = textX + Math.round(ctx.measureText(primary).width) + style.unitGap;
      ctx.font = unitFont;
      const unitText = '°C';
      staticTexts.push({ text: unitText, font: unitFont, color: COLORS.label, x: cursorX, baseline: valueBaseline });
      cursorX += Math.round(ctx.measureText(unitText).width) + style.phraseGap;
      if (phrase !== null) {
        staticTexts.push({
          text: phrase,
          font: unitFont,
          color: COLORS.label,
          x: cursorX,
          baseline: valueBaseline,
        });
      }
    }
  }

  if (detail !== null) {
    staticTexts.push({ text: detail, font: unitFont, color: COLORS.label, x: textX, baseline: detailBaseline });
  }

  return {
    componentId: component.id,
    rect,
    panel: { ...panel, radius: theme.radius, strokeWidth: theme.strokeWidth },
    staticTexts,
    // 天气与墙钟都是静态覆盖：没有任何逐帧内容。
    dynamic: [],
    weather: {
      values,
      phrase,
      wallClock,
      overridden: merged.overridden,
    },
  };
}

/**
 * 按组件 id 分派。
 * 未列出的组件一律跳过（没有绘制实现就不画）。
 */
const DRAWERS = {
  metrics: planMetrics,
  route: planRoute,
  progress: planProgress,
  weather: planWeather,
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
function buildPlan(ctx, { preset, components, metrics, activity, weatherSnapshot, timezone }) {
  const plan = [];
  for (const component of sortForDraw(components)) {
    if (typeof component?.id !== 'string') continue;
    const drawer = DRAWERS[component.id];
    if (drawer === undefined) continue;
    const item = drawer(ctx, { preset, component, metrics, activity, weatherSnapshot, timezone });
    if (item !== null) plan.push(item);
  }
  return plan;
}

/** 静态层落笔：底板一次填充 + 一次描边，标签与单位各写一次，完整路线一次描边。 */
function drawStaticLayer(ctx, plan) {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';

  for (const item of plan) {
    if (item.panel !== null) {
      roundedPath(ctx, item.panel, item.panel.radius);
      ctx.fillStyle = COLORS.panelFill;
      ctx.fill();
      ctx.strokeStyle = COLORS.panelStroke;
      ctx.lineWidth = item.panel.strokeWidth;
      ctx.stroke();
    }

    for (const text of item.staticTexts) {
      ctx.font = text.font;
      ctx.fillStyle = text.color;
      ctx.fillText(text.text, text.x, text.baseline);
    }

    // 完整路线整场活动都不变，属于静态层；已完成段与箭头每帧重画。
    if (item.route !== undefined) drawRouteBase(ctx, item.route);
    if (item.progress !== undefined) drawProgressStatic(ctx, item.progress);
  }

  ctx.restore();
}

/**
 * 预绘静态层。
 *
 * 调用方（适配层）负责创建离屏画布并把它的 `ctx` 传进来；本函数只落笔、不做环境操作。
 * 返回的对象要原样交给 `drawFrame` 的 `static` 参数。
 *
 * `activity` 是整场活动的数据（`readTcx` 的形状），提供路线轨迹与总距离；
 * `metrics` 只描述当前时刻。两者分开，避免把整条轨迹塞进每一帧的指标里。
 *
 * `weatherSnapshot` 与 `timezone` 是静态覆盖（ADR 0005）：天气卡只读配置里的快照，
 * 渲染期不联网、不读时钟；缺快照时整块不画。
 *
 * @param {CanvasRenderingContext2D} ctx 离屏画布的上下文
 * @param {{ preset: object, components: object[], metrics: object, activity?: object,
 *           weatherSnapshot?: object, timezone?: string }} input
 * @returns {{ canvas: object, plan: object[] }}
 */
export function prepareStatic(ctx, { preset, components, metrics, activity, weatherSnapshot, timezone }) {
  const plan = buildPlan(ctx, { preset, components, metrics, activity, weatherSnapshot, timezone });
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

    // 路线的已完成段与方向箭头随当前距离变化，每帧重画（完整路线已在静态层）。
    if (item.route !== undefined) drawRouteProgress(ctx, item.route, metrics);
    if (item.progress !== undefined) drawProgressFrame(ctx, item.progress);
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
 * @param {{ preset: object, components: object[], metrics: object, activity?: object,
 *           weatherSnapshot?: object, timezone?: string }} input
 * @returns {{ kind: 'component' | 'text', x: number, y: number, width: number, height: number }[]}
 */
export function collectCriticalRegions(ctx, {
  preset, components, metrics, activity, weatherSnapshot, timezone,
}) {
  const plan = buildPlan(ctx, { preset, components, metrics, activity, weatherSnapshot, timezone });
  const inflate = Math.max(1, Math.round(COMPONENT_REGION_INFLATE_PX * (preset?.scale ?? 1)));
  const regions = [];

  for (const item of plan) {
    const { x, y, width, height } = item.rect;
    regions.push({
      kind: 'component',
      componentId: item.componentId,
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
