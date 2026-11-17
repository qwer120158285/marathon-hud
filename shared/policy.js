/**
 * 绘制判据（纯函数：零 DOM、零 Node 专有 API）。
 *
 * ADR 0004：`shouldRender = configEnabled && dataAvailable`。
 * 判据属于共享绘制层，放在这里而不是 `data/`；`data/availability.mjs` 重新导出它，
 * 保持既有调用方不变，同时避免 shared/ 反向依赖数据层。
 */

/**
 * 绘制判据：组件开启且数据可用才绘制。缺值时既不画也不填占位数字。
 *
 * @param {boolean} configEnabled
 * @param {boolean} dataAvailable
 * @returns {boolean}
 */
export function shouldRender(configEnabled, dataAvailable) {
  return configEnabled === true && dataAvailable === true;
}
