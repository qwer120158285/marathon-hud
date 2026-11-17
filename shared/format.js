/**
 * 报告与读数里的数字格式（纯函数：零 DOM、零 Node 专有 API）。
 *
 * CLI 报告、数据源报告、天气报告与编辑器读数共用这一处实现，保证同一个数字在任何出口
 * 都逐字一致；缺失值写明「缺失」，不静默当成 0。
 */

/**
 * 数字转报告文本：整数不带小数点，小数最多三位；缺失值直接写明。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatNumber(value) {
  if (value === undefined) return '缺失';
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
