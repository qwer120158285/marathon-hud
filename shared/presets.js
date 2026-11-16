/**
 * 画布预设解析（纯函数：零 DOM、零 Node 专有 API）。
 *
 * 依据 ADR 0002：基准格边长 40 px @ 短边 1080，按 min(W, H) / 1080 等比缩放；
 * 网格线铺满整张画布，安全边距不参与格位取整。
 * 依据 ADR 0003：两个内置画布预设的左右 / 顶部 / 底部安全边距。
 */

/** 基准格边长（px @ 短边 1080）。 */
const BASE_CELL_SIZE = 40;
/** 格边长缩放所用的基准短边。 */
const BASE_SHORT_SIDE = 1080;

/** 内置画布预设；画布尺寸与安全边距来自 ADR 0003。 */
export const BUILTIN_PRESETS = {
  'douyin-portrait': {
    displayName: '抖音竖屏',
    width: 1080,
    height: 1920,
    safeInset: { left: 64, right: 64, top: 160, bottom: 240 },
  },
  'bilibili-landscape': {
    displayName: 'B 站横屏',
    width: 1920,
    height: 1080,
    safeInset: { left: 64, right: 64, top: 80, bottom: 120 },
  },
};

/** 内置画布预设标识列表，顺序固定，用于报告与错误文本。 */
export const BUILTIN_PRESET_IDS = Object.keys(BUILTIN_PRESETS);

/** 判断标识是否为内置画布预设。 */
export function isBuiltinPreset(id) {
  return Object.hasOwn(BUILTIN_PRESETS, id);
}

/**
 * 解析内置画布预设。
 * @param {string} id 画布预设标识
 */
export function resolvePreset(id) {
  const preset = BUILTIN_PRESETS[id];
  if (preset === undefined) {
    throw new Error(`未知画布预设 "${id}"，可用预设：${BUILTIN_PRESET_IDS.join('、')}`);
  }
  return resolveCanvasPreset({ id, ...preset });
}

/**
 * 把「画布尺寸 + 安全边距」解析成网格与可放置格位范围。
 * 自定义分辨率同样走这条路：格边长与安全边距都按 min(W, H) / 1080 缩放。
 *
 * 可放置格位 = 完整落在安全区内的整格，`colEnd` / `rowEnd` 均为闭区间下标。
 *
 * @param {{ id: string, displayName?: string, width: number, height: number,
 *           safeInset: { left: number, right: number, top: number, bottom: number } }} canvas
 */
export function resolveCanvasPreset({ id, displayName, width, height, safeInset }) {
  const scale = Math.min(width, height) / BASE_SHORT_SIDE;
  const cellSize = BASE_CELL_SIZE * scale;
  const inset = {
    left: safeInset.left * scale,
    right: safeInset.right * scale,
    top: safeInset.top * scale,
    bottom: safeInset.bottom * scale,
  };
  const grid = {
    cols: Math.floor(width / cellSize),
    rows: Math.floor(height / cellSize),
  };
  const safeArea = {
    x: inset.left,
    y: inset.top,
    width: width - inset.left - inset.right,
    height: height - inset.top - inset.bottom,
  };
  // 首个完整落在安全区内的格位：左边（上边）按格边长向上取整。
  // 末个完整格位：右边（下边）按格边长向下取整后减一。
  const placeable = {
    colStart: Math.ceil(inset.left / cellSize),
    colEnd: Math.floor((width - inset.right) / cellSize) - 1,
    rowStart: Math.ceil(inset.top / cellSize),
    rowEnd: Math.floor((height - inset.bottom) / cellSize) - 1,
  };

  return { id, displayName, width, height, scale, cellSize, grid, safeInset: inset, safeArea, placeable };
}
