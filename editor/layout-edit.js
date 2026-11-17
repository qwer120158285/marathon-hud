/**
 * 编辑器布局编辑的纯逻辑层（零 DOM、零浏览器 API）。
 *
 * 只有这一层负责「把指针产生的像素矩形变成候选布局」：几何判断全部转交给
 * shared/layout.js（格位吸附、锚点推导、安全区越界、联合校验），本文件不重算
 * 格边长、不重算安全区、也不做第二套坐标换算——UI 里的手势只是把事件坐标
 * 按缩放比换成预设像素，然后调用这里的函数。
 *
 * 依据 ADR 0002：布局存「四角锚点 + 整数格位」，Resize 按整数格；
 * 依据 ADR 0005：`layout.sourcePresetId` 只是编辑上下文，切换预设不改组件格位。
 */
import {
  jointValidate,
  resolveComponentRect,
  safeAreaOverflow,
  snapRectToGrid,
} from '../shared/layout.js';
import { BUILTIN_PRESET_IDS, isBuiltinPreset } from '../shared/presets.js';

/**
 * 拖动：把指针位移平移到原始像素矩形上。
 *
 * 只做平移，不吸附、不判越界；吸附与校验在 `commitComponent` 里由 shared 完成。
 *
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {{ dx?: number, dy?: number }} delta 预设像素位移
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function translateRect(rect, { dx = 0, dy = 0 } = {}) {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/**
 * Resize：按把手移动对应的边，另一边保持不动。
 *
 * 支持四角（nw / ne / se / sw）与四边（n / s / e / w）。结果不吸附到格位，
 * 由 `commitComponent` 交给 `snapRectToGrid` 收拢成整数跨格。
 * 拖过头时退化为 1 px 的矩形，避免出现负宽高。
 *
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {'nw' | 'ne' | 'se' | 'sw' | 'n' | 's' | 'e' | 'w'} handle
 * @param {{ dx?: number, dy?: number }} delta 预设像素位移
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function resizeRect(rect, handle, { dx = 0, dy = 0 } = {}) {
  const left = rect.x + (handle.includes('w') ? dx : 0);
  const top = rect.y + (handle.includes('n') ? dy : 0);
  const right = rect.x + rect.width + (handle.includes('e') ? dx : 0);
  const bottom = rect.y + rect.height + (handle.includes('s') ? dy : 0);

  return {
    x: Math.min(left, right - 1),
    y: Math.min(top, bottom - 1),
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/**
 * 把像素矩形吸附成候选组件：保留 id / zIndex / visible / subcomponents，只换格位字段。
 *
 * @param {object} component 原组件（提供非几何字段与兜底值）
 * @param {{ x: number, y: number, width: number, height: number }} rect 像素矩形
 * @param {object} preset shared/presets.js 解析出的画布预设
 */
export function toCandidateComponent(component, rect, preset) {
  return { ...component, ...snapRectToGrid(rect, preset) };
}

/**
 * 提交一次拖动或 Resize。
 *
 * 组件完整边界矩形越过安全区就拒绝：返回原组件（上一个合法位置）与越界量，
 * 由 UI 提示「哪个预设 / 哪个组件 / 越界多少」；合法时返回吸附后的候选组件。
 * 只检查当前预设——全部目标预设的联合校验在保存时进行。
 *
 * @param {object} component
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {object} preset
 * @returns {{ component: object, accepted: boolean,
 *             overflow: { edge: string, px: number, cells: number }[] }}
 */
export function commitComponent(component, rect, preset) {
  const candidate = toCandidateComponent(component, rect, preset);
  const overflow = safeAreaOverflow(candidate, preset);

  if (overflow.length > 0) {
    return { component, accepted: false, overflow };
  }
  return { component: candidate, accepted: true, overflow: [] };
}

/**
 * 用同一个 id 替换组件，返回新数组。
 *
 * @param {object[]} components
 * @param {object} next 新组件（按 id 匹配）
 * @returns {object[]}
 */
export function replaceComponent(components, next) {
  return components.map((component) => (component.id === next.id ? next : component));
}

/**
 * 调整绘制顺序：`zIndex` 加 / 减若干层，返回新数组。
 *
 * 只改层级字段，不改位置尺寸；重叠提示由联合校验按 zIndex 区分「视觉重叠」与「允许的层叠」。
 *
 * @param {object[]} components
 * @param {string} id
 * @param {number} delta 正数上移、负数下移
 */
export function changeLayer(components, id, delta) {
  return components.map((component) => (
    component.id === id
      ? { ...component, zIndex: (Number.isInteger(component.zIndex) ? component.zIndex : 0) + delta }
      : component
  ));
}

/**
 * 临时隐藏 / 显示组件（对应 Schema 的 `visible`，即 configEnabled）。
 *
 * @param {object[]} components
 * @param {string} id
 * @param {boolean} visible
 */
export function setVisible(components, id, visible) {
  return components.map((component) => (
    component.id === id ? { ...component, visible } : component
  ));
}

/**
 * 切换编辑预设：只改 `layout.sourcePresetId`，组件格位与跨格数原样保留。
 *
 * 这是 ADR 0002 A 方案的关键：同一份布局在不同预设下按「锚点 + col + row」重新解释，
 * `colSpan` / `rowSpan` 不随画布方向变化；因此这里绝不做像素换算。
 *
 * @param {object} project
 * @param {string} presetId
 * @returns {object} 新 project（不改入参）
 */
export function switchSourcePreset(project, presetId) {
  if (!isBuiltinPreset(presetId)) {
    throw new Error(`未知画布预设 ${JSON.stringify(presetId)}，可用预设：${BUILTIN_PRESET_IDS.join('、')}`);
  }
  return { ...project, layout: { ...project.layout, sourcePresetId: presetId } };
}

/**
 * 当前预设下每个组件的像素矩形，按绘制顺序（zIndex 升序）排列。
 *
 * 显示轮廓、命中测试与拖动起点都走这里，保证和 shared 的绘制几何是同一个来源。
 *
 * @param {object[]} components
 * @param {object} preset
 * @returns {{ component: object, rect: object }[]}
 */
export function layoutRects(components, preset) {
  return components
    .map((component, index) => ({
      component,
      index,
      rect: resolveComponentRect(component, preset),
    }))
    .sort((a, b) => {
      const az = Number.isInteger(a.component.zIndex) ? a.component.zIndex : 0;
      const bz = Number.isInteger(b.component.zIndex) ? b.component.zIndex : 0;
      return az - bz || a.index - b.index;
    })
    .map(({ component, rect }) => ({ component, rect }));
}

/**
 * 保存前联合校验：用同一份候选布局对所有目标预设同时校验。
 *
 * 目标预设取项目根级 `targetPresets[]`，不是编辑预设（ADR 0005）。
 *
 * @param {object} project
 * @param {object[]} presets 已解析的画布预设快照
 * @returns {{ ok: boolean, errors: object[], warnings: object[] }}
 */
export function validateCandidate(project, presets) {
  return jointValidate({
    layout: project.layout,
    targetPresets: project.targetPresets,
    presets,
  });
}

/**
 * 序列化 project.json：两空格缩进、末尾换行，便于 diff 与人工查看。
 * @param {object} project
 * @returns {string}
 */
export function serializeProject(project) {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/**
 * 从文本载入 project.json。Schema 校验由本地服务 / CLI 把关，这里只负责 JSON 解析。
 * @param {string} text
 * @returns {object}
 */
export function parseProjectText(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`project.json 不是合法 JSON：${error.message}`);
  }
}
