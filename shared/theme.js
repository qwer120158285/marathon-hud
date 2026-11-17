/**
 * 视觉常量（纯数据：零 DOM、零 Node 专有 API）。
 *
 * 所有长度以「px @ 短边 1080」书写，由 `resolveTheme(preset)` 按画布预设的 `scale`
 * 换算成实际像素——两端拿到的数字相同，绘制代码里不再出现散落的字号 / 圆角 / 内边距。
 * 基调沿用 marathon-hud-demo：深色半透明圆角底板 + 1–2 px 浅色描边 + 白色主数值。
 */

/** 字体家族名：两端用同一批 Inter 文件注册成这个名字（见 shared/fonts/FONTS.json）。 */
export const FONT_FAMILY = 'Inter';

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

const round = (value) => Math.round(value);

/**
 * 按画布预设换算出一份实际像素的样式表。
 *
 * @param {{ scale?: number }} preset shared/presets.js 解析出的画布预设
 * @returns {typeof METRICS_CARD} 数值已乘 `scale` 的新对象
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
  };
}
