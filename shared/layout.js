/**
 * 格位几何与联合校验（纯函数：零 DOM、零 Node 专有 API）。
 *
 * 依据 ADR 0002：布局以「四角锚点 + 整数格位」存储，不存像素坐标；
 * 依据 ADR 0003：安全区是硬约束，边界判断用组件完整边界矩形，不能只查起始格。
 * 格边长与安全边距一律取 shared/presets.js 的解析结果，本文件不重复缩放。
 */

/** 四角锚点；顺序即吸附平局时的优先级。 */
export const ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 锚点的水平方向：决定 `col` 从左边还是右边起算。 */
function horizontalSide(anchor) {
  return anchor.endsWith('right') ? 'right' : 'left';
}

/** 锚点的垂直方向：决定 `row` 从顶部还是底部起算。 */
function verticalSide(anchor) {
  return anchor.startsWith('bottom') ? 'bottom' : 'top';
}

/**
 * 把「锚点 + 整数格位 + 跨格数」解析成像素矩形。
 *
 * 锚点语义（水平与垂直方向各自独立按锚点映射）：
 * - `top-left` / `bottom-left`：`col` 从画布左边界起算，`x = col × 格边长`；
 * - `top-right` / `bottom-right`：`col` 从画布右边界起算，`col = 0` 即贴右边界的整格，
 *   `x = 画布宽 − (col + colSpan) × 格边长`；
 * - `top-*`：`row` 从画布上边界起算，`y = row × 格边长`；
 * - `bottom-*`：`row` 从画布下边界起算，`row = 0` 即贴底边界的整行，
 *   `y = 画布高 − (row + rowSpan) × 格边长`。
 *
 * 结果不取整到安全区、也不做合法性判断：解析只回答「这组格位在本预设下意味着哪个矩形」。
 *
 * @param {{ anchor: string, col: number, row: number, colSpan: number, rowSpan: number }} component
 * @param {object} preset shared/presets.js 解析出的画布预设
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
export function resolveComponentRect(component, preset) {
  const { anchor, col, row, colSpan, rowSpan } = component;
  if (!ANCHORS.includes(anchor)) {
    throw new Error(
      `未知锚点 ${JSON.stringify(anchor)}，允许：${ANCHORS.join(' / ')}`,
    );
  }

  const { cellSize, width, height } = preset;
  const rectWidth = colSpan * cellSize;
  const rectHeight = rowSpan * cellSize;

  const x = horizontalSide(anchor) === 'left'
    ? col * cellSize
    : width - (col + colSpan) * cellSize;
  const y = verticalSide(anchor) === 'top'
    ? row * cellSize
    : height - (row + rowSpan) * cellSize;

  return { x, y, width: rectWidth, height: rectHeight };
}

/**
 * 格位吸附：把任意像素矩形收拢到最近的整数格位，并推导出四角锚点。
 *
 * 锚点按「矩形离画布哪个角最近」自动推导：比较矩形对应角与画布对应角的曼哈顿距离，
 * 取最小者；平局按 `ANCHORS` 顺序取前一者（top-left 优先），保证结果确定。
 * 推导出的锚点决定 `col` / `row` 从哪条边界起算，跨格数按格边长四舍五入，最小为 1。
 *
 * 吸附不负责安全区约束，也不阻止格位越界——那是「可放置格位判定」与联合校验的职责。
 * 拖动与 Resize 都走这一层（手势本身不在本模块）。
 *
 * @param {{ x: number, y: number, width: number, height: number }} rect 像素矩形
 * @param {object} preset shared/presets.js 解析出的画布预设
 * @returns {{ anchor: string, col: number, row: number, colSpan: number, rowSpan: number }}
 */
export function snapRectToGrid(rect, preset) {
  const { cellSize, width, height } = preset;
  const anchor = nearestAnchor(rect, preset);
  const rectRight = rect.x + rect.width;
  const rectBottom = rect.y + rect.height;

  return {
    anchor,
    col: Math.round(
      (horizontalSide(anchor) === 'left' ? rect.x : width - rectRight) / cellSize,
    ),
    row: Math.round(
      (verticalSide(anchor) === 'top' ? rect.y : height - rectBottom) / cellSize,
    ),
    colSpan: Math.max(1, Math.round(rect.width / cellSize)),
    rowSpan: Math.max(1, Math.round(rect.height / cellSize)),
  };
}

/** 矩形对应角到画布对应角的曼哈顿距离最小的锚点。 */
function nearestAnchor(rect, preset) {
  const right = preset.width - (rect.x + rect.width);
  const bottom = preset.height - (rect.y + rect.height);
  const distances = {
    'top-left': rect.x + rect.y,
    'top-right': right + rect.y,
    'bottom-left': rect.x + bottom,
    'bottom-right': right + bottom,
  };

  return ANCHORS.reduce((best, anchor) => (
    distances[anchor] < distances[best] ? anchor : best
  ));
}

/**
 * 可放置格位判定：组件的**完整边界矩形**必须完全落在安全区内。
 *
 * 只查起始格是不够的——起始格可能合法，跨格后仍然越界（ADR 0002 / ADR 0003）。
 * 返回每条越界边的越界量；空数组表示完全落在安全区内。
 *
 * @param {{ anchor: string, col: number, row: number, colSpan: number, rowSpan: number }} component
 * @param {object} preset shared/presets.js 解析出的画布预设
 * @returns {{ edge: 'left' | 'right' | 'top' | 'bottom', px: number, cells: number }[]}
 */
export function safeAreaOverflow(component, preset) {
  const rect = resolveComponentRect(component, preset);
  const { safeArea, cellSize } = preset;
  const safeRight = safeArea.x + safeArea.width;
  const safeBottom = safeArea.y + safeArea.height;
  const overflow = [];

  const checks = [
    { edge: 'left', px: safeArea.x - rect.x },
    { edge: 'top', px: safeArea.y - rect.y },
    { edge: 'right', px: rect.x + rect.width - safeRight },
    { edge: 'bottom', px: rect.y + rect.height - safeBottom },
  ];

  for (const { edge, px } of checks) {
    if (px <= 0) continue;
    overflow.push({ edge, px, cells: px / cellSize });
  }

  return overflow;
}

/** 数字转报告文本：整数不带小数点，小数最多三位；缺失值直接写明。 */
function formatNumber(value) {
  if (value === undefined) return '缺失';
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/** 错误「画布预设 X：组件 Y ...」的统一前缀；组件标识缺失时退回数组下标。 */
function placementLabel(presetId, component, index) {
  const name = typeof component?.id === 'string' ? component.id : `layout.components[${index}]`;
  return `画布预设 ${presetId}：组件 ${name}`;
}

/**
 * 联合校验：用同一份候选布局与同一版本预设配置，对全部目标预设同时校验。
 *
 * 校验项目（ADR 0002「联合校验约束」）：
 * - 格位有效：`col` / `row` 为整数且非负；
 * - 尺寸有效：`colSpan` / `rowSpan` 为 ≥ 1 的整数；
 * - 锚点映射有效：四角锚点之一；
 * - 完整边界矩形未越过安全区（报出哪条边、越界多少 px / 多少格）；
 * - `components[].id` 唯一（布局层独立成立）。
 *
 * 重叠只提示不阻止：同组相交组件若 `zIndex` 不同，记为「允许的层叠」（使用者显式设定的覆盖关系，
 * 例如文字叠在透明底板上）；`zIndex` 相同则记为「视觉重叠」。边界相接（面积为零）不算重叠。
 *
 * @param {{ layout: { components?: object[] }, targetPresets: string[], presets: object[] }} input
 *   `presets` 必须是已解析的画布预设快照（同一版本配置），本函数不再重新解析。
 * @returns {{ ok: boolean, errors: object[], warnings: object[] }}
 */
export function jointValidate({ layout, targetPresets, presets }) {
  const components = Array.isArray(layout?.components) ? layout.components : [];
  const presetsById = new Map((presets ?? []).map((preset) => [preset.id, preset]));
  const errors = duplicateIdErrors(components);
  const warnings = [];

  for (const presetId of targetPresets) {
    const preset = presetsById.get(presetId);
    if (preset === undefined) {
      errors.push({
        kind: 'preset-missing',
        presetId,
        componentId: undefined,
        message: `画布预设 ${presetId} 缺少预设配置快照，联合校验必须使用同一版本的预设配置`,
      });
      continue;
    }

    const rects = [];
    components.forEach((component, index) => {
      const placementErrors = checkComponent(component, preset, index);
      errors.push(...placementErrors);
      // 几何不成立（锚点非法、格位非法）的组件不参与重叠计算，避免用无效矩形产生误导提示。
      if (placementErrors.length === 0) {
        rects.push({ component, rect: resolveComponentRect(component, preset) });
      }
    });

    warnings.push(...overlapWarnings(rects, preset));
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** 组件 id 唯一性；布局层独立于 Schema 的检查。 */
function duplicateIdErrors(components) {
  const errors = [];
  const firstIndexById = new Map();

  components.forEach((component, index) => {
    if (typeof component?.id !== 'string') return;
    const firstIndex = firstIndexById.get(component.id);
    if (firstIndex === undefined) {
      firstIndexById.set(component.id, index);
      return;
    }
    errors.push({
      kind: 'duplicate-id',
      presetId: undefined,
      componentId: component.id,
      message: `layout.components[${index}].id 与 layout.components[${firstIndex}].id 重复（${JSON.stringify(component.id)}）`,
    });
  });

  return errors;
}

/** 单个组件在单个预设下的格位 / 尺寸 / 锚点 / 安全区校验。 */
function checkComponent(component, preset, index) {
  const errors = [];
  const label = placementLabel(preset.id, component, index);
  const push = (kind, message) => errors.push({
    kind,
    presetId: preset.id,
    componentId: component?.id,
    message,
  });

  for (const key of ['col', 'row']) {
    const value = component?.[key];
    if (!Number.isInteger(value)) {
      push('grid', `${label} 的 ${key} 必须是整数，实际为 ${formatNumber(value)}`);
    } else if (value < 0) {
      push('grid', `${label} 的 ${key} 不能为负，实际为 ${value}`);
    }
  }

  for (const key of ['colSpan', 'rowSpan']) {
    const value = component?.[key];
    if (!Number.isInteger(value) || value < 1) {
      push('size', `${label} 的 ${key} 必须是 ≥ 1 的整数，实际为 ${formatNumber(value)}`);
    }
  }

  if (!ANCHORS.includes(component?.anchor)) {
    push(
      'anchor',
      `${label} 的锚点 ${JSON.stringify(component?.anchor)} 无效，允许：${ANCHORS.join(' / ')}`,
    );
  }

  if (errors.length > 0) return errors;

  const overflow = safeAreaOverflow(component, preset);
  if (overflow.length > 0) {
    push('safe-area', `${label} 超出安全区——${describeOverflow(overflow)}；${describeBounds(component, preset)}`);
    errors.at(-1).overflow = overflow;
  }

  return errors;
}

const EDGE_LABELS = { left: '左边', right: '右边', top: '上边', bottom: '下边' };

function describeOverflow(overflow) {
  return overflow
    .map(({ edge, px, cells }) => `${EDGE_LABELS[edge]}越界 ${formatNumber(px)} px（${formatNumber(cells)} 格）`)
    .join('，');
}

/** 报告组件矩形与安全区的实际范围，让人能直接照着改格位。 */
function describeBounds(component, preset) {
  const rect = resolveComponentRect(component, preset);
  const { x, y, width, height } = preset.safeArea;
  // 用「…」而非破折号分隔上下界，避免负数区间（如 -440–-120）被误读。
  const range = (start, size) => `${formatNumber(start)}…${formatNumber(start + size)}`;

  return `组件矩形 x ${range(rect.x, rect.width)}、y ${range(rect.y, rect.height)}，`
    + `安全区 x ${range(x, width)}、y ${range(y, height)}`;
}

/** 重叠提示：只提示不阻止，区分「视觉重叠」与「允许的层叠」。 */
function overlapWarnings(rects, preset) {
  const warnings = [];

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i];
      const b = rects[j];
      const overlap = intersect(a.rect, b.rect);
      if (overlap === null) continue;

      const sameLayer = a.component.zIndex === b.component.zIndex;
      const size = `${formatNumber(overlap.width)} × ${formatNumber(overlap.height)} px`;
      warnings.push({
        kind: sameLayer ? 'visual-overlap' : 'stacking',
        presetId: preset.id,
        componentId: a.component.id,
        otherComponentId: b.component.id,
        zIndex: a.component.zIndex,
        otherZIndex: b.component.zIndex,
        overlap,
        message: sameLayer
          ? `画布预设 ${preset.id}：组件 ${a.component.id} 与 ${b.component.id} 视觉重叠`
            + `（zIndex 同为 ${formatNumber(a.component.zIndex)}），重叠区域 ${size}`
          : `画布预设 ${preset.id}：组件 ${a.component.id} 与 ${b.component.id} 层叠`
            + `（zIndex ${formatNumber(b.component.zIndex)} 覆盖 ${formatNumber(a.component.zIndex)}），`
            + `重叠区域 ${size}`,
      });
    }
  }

  return warnings;
}

/** 两个矩形的相交区域；面积为零（含边界相接）返回 null。 */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;

  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
