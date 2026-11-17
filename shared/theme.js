/**
 * 视觉常量（纯数据：零 DOM、零 Node 专有 API）。
 *
 * 所有长度以「px @ 短边 1080」书写，由 `resolveTheme(preset)` 按画布预设的 `scale`
 * 换算成实际像素——两端拿到的数字相同，绘制代码里不再出现散落的字号 / 圆角 / 内边距。
 * 基调沿用 marathon-hud-demo：深色半透明圆角底板 + 1–2 px 浅色描边 + 白色主数值。
 */

/** 字体家族名：两端用同一批 Inter 文件注册成这个名字（见 shared/fonts/FONTS.json）。 */
export const FONT_FAMILY = 'Inter';

/**
 * 只使用随项目打包的 Inter（ADR 0001「字体」）：模块内不允许出现任何系统字体名。
 *
 * 曾经为中文天气短语单独指定过 macOS 系统字体；那会让「换机器」改变字宽
 * （实测缺字体时「晴」40.00 → 34.60 px），基准图跨机器不可复现。
 * 天气短语因此改用英文（见 shared/weather.js），全部分支只走 Inter。
 * `tests/fonts.test.mjs` 会扫描 shared/ 源码，出现系统字体名即失败。
 */

export const COLORS = {
  /** 数据卡底板：深色半透明，保证压在任意画面上都有足够对比。 */
  panelFill: 'rgba(8, 14, 24, 0.76)',
  /** 底板描边：浅色低透明度，只勾轮廓。 */
  panelStroke: 'rgba(255, 255, 255, 0.20)',
  /** 主数值。 */
  value: '#FFFFFF',
  /** 次文本（标签、单位）。 */
  label: '#A8B7C9',
  /** 心率专用强调色。 */
  heartRate: '#FF667D',
};

/** 数据卡（指标组件）在 1080 短边下的样式。 */
export const METRICS_CARD = {
  radius: 20,
  strokeWidth: 2,
  paddingX: 22,
  paddingY: 18,
  /** 行与行之间额外留白。 */
  rowGap: 8,
  /** 数值与单位之间的水平间距。 */
  unitGap: 8,
  label: { size: 17, weight: 600, lineHeight: 1.5 },
  value: { size: 46, weight: 700, lineHeight: 1.15 },
  unit: { size: 15, weight: 500 },
  /**
   * 字母基线到字号顶部的比例。用固定比例而不是读字体度量，是为了两端布局完全一致：
   * 字体文件相同但度量接口的实现细节可能不同，固定比例不会有这种差异。
   */
  ascentRatio: 0.78,
};

/** 路线组件在 1080 短边下的样式。 */
export const ROUTE = {
  /** 轨迹到组件矩形四边的内边距。 */
  padding: 18,
  /** 完整路线（整场不变，属于静态层）。 */
  lineWidth: 4,
  baseColor: 'rgba(255, 255, 255, 0.42)',
  /** 已完成的一段（每帧变化，属于动态层）。 */
  doneWidth: 5,
  doneColor: '#FFFFFF',
  /** 方向箭头：沿当前行进方向的三角形。 */
  arrowLength: 18,
  arrowWidth: 14,
};

/** 进度组件在 1080 短边下的样式。 */
export const PROGRESS_CARD = {
  paddingX: 22,
  paddingY: 12,
  /** 公里刻度相对进度条的上下伸出量。 */
  markerOverhang: 4,
  markerWidth: 2,
  markerColor: 'rgba(255, 255, 255, 0.55)',
  /** 标签、数值、总量、单位排在同一行，整块高度压进 2 行格位（80 px）。 */
  label: { size: 15, weight: 600, lineHeight: 1.4 },
  value: { size: 34, weight: 700, lineHeight: 1.15 },
  unit: { size: 15, weight: 500 },
  /** 标签与数值、数值与「/ 总距离」之间的水平间距。 */
  valueGap: 12,
  /** 文字行与进度条之间的留白。 */
  barGap: 6,
  barHeight: 8,
  barRadius: 4,
  trackColor: 'rgba(255, 255, 255, 0.18)',
  fillColor: '#FFFFFF',
  ascentRatio: 0.78,
};

/** 天气组件在 1080 短边下的样式（静态覆盖卡片：一次预绘，整场不变）。 */
export const WEATHER_CARD = {
  paddingX: 22,
  paddingY: 18,
  /** 标签行与数值行、数值行与详情行之间的额外留白。 */
  labelToValueGap: 2,
  valueToDetailGap: 4,
  /** 温度数值与单位、单位与天气短语之间的水平间距（单位要落在数值文字框之外）。 */
  unitGap: 16,
  phraseGap: 24,
  /** 字号与数据卡一致（METRICS_CARD），视觉上属于同一套卡片。 */
  label: { size: 17, weight: 600, lineHeight: 1.5 },
  value: { size: 46, weight: 700, lineHeight: 1.15 },
  unit: { size: 15, weight: 500, lineHeight: 1.4 },
  ascentRatio: 0.78,
};

const round = (value) => Math.round(value);

/**
 * 按画布预设换算出一份实际像素的样式表。
 *
 * 返回的是四类组件合并后的样式：`METRICS_CARD` 的数字在顶层，路线、进度、天气各自在
 * `route` / `progress` / `weather` 子对象里；不是 `METRICS_CARD` 本身。
 *
 * @param {{ scale?: number }} preset shared/presets.js 解析出的画布预设
 * @returns {{ radius: number, strokeWidth: number, paddingX: number, paddingY: number,
 *             rowGap: number, unitGap: number, label: object, value: object, unit: object,
 *             ascentRatio: number, route: object, progress: object, weather: object }}
 */
export function resolveTheme(preset) {
  const scale = preset?.scale ?? 1;
  const px = (value) => Math.max(1, round(value * scale));
  const font = (font) => ({
    ...font,
    size: px(font.size),
    lineHeight: font.lineHeight,
  });

  return {
    radius: px(METRICS_CARD.radius),
    strokeWidth: Math.max(1, Math.round(METRICS_CARD.strokeWidth * scale)),
    paddingX: px(METRICS_CARD.paddingX),
    paddingY: px(METRICS_CARD.paddingY),
    rowGap: px(METRICS_CARD.rowGap),
    unitGap: px(METRICS_CARD.unitGap),
    label: font(METRICS_CARD.label),
    value: font(METRICS_CARD.value),
    unit: font(METRICS_CARD.unit),
    ascentRatio: METRICS_CARD.ascentRatio,
    route: {
      padding: px(ROUTE.padding),
      lineWidth: Math.max(1, round(ROUTE.lineWidth * scale)),
      baseColor: ROUTE.baseColor,
      doneWidth: Math.max(1, round(ROUTE.doneWidth * scale)),
      doneColor: ROUTE.doneColor,
      arrowLength: px(ROUTE.arrowLength),
      arrowWidth: px(ROUTE.arrowWidth),
    },
    progress: {
      paddingX: px(PROGRESS_CARD.paddingX),
      paddingY: px(PROGRESS_CARD.paddingY),
      markerOverhang: px(PROGRESS_CARD.markerOverhang),
      markerWidth: Math.max(1, round(PROGRESS_CARD.markerWidth * scale)),
      markerColor: PROGRESS_CARD.markerColor,
      label: font(PROGRESS_CARD.label),
      value: font(PROGRESS_CARD.value),
      unit: font(PROGRESS_CARD.unit),
      valueGap: px(PROGRESS_CARD.valueGap),
      barGap: px(PROGRESS_CARD.barGap),
      barHeight: Math.max(2, round(PROGRESS_CARD.barHeight * scale)),
      barRadius: px(PROGRESS_CARD.barRadius),
      trackColor: PROGRESS_CARD.trackColor,
      fillColor: PROGRESS_CARD.fillColor,
      ascentRatio: PROGRESS_CARD.ascentRatio,
    },
    weather: {
      paddingX: px(WEATHER_CARD.paddingX),
      paddingY: px(WEATHER_CARD.paddingY),
      unitGap: px(WEATHER_CARD.unitGap),
      labelToValueGap: px(WEATHER_CARD.labelToValueGap),
      valueToDetailGap: px(WEATHER_CARD.valueToDetailGap),
      phraseGap: px(WEATHER_CARD.phraseGap),
      label: font(WEATHER_CARD.label),
      value: font(WEATHER_CARD.value),
      unit: font(WEATHER_CARD.unit),
      ascentRatio: WEATHER_CARD.ascentRatio,
    },
  };
}
