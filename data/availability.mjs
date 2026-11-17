/**
 * 数据可用性（GLOSSARY：数据可用性）——「整个活动是否有这个指标」。
 *
 * 只回答数据侧的事实，与组件是否开启无关；最终是否绘制由 `shouldRender` 决定
 * （ADR 0004）。判定结果只在运行时产生，不写进 project.json。
 */

/**
 * 绘制判据的实现在 shared/policy.js：判据属于共享绘制层，数据层不定义绘制规则。
 * 这里重新导出，保持既有调用方（`from '../data/availability.mjs'`）不变。
 */
export { shouldRender } from '../shared/policy.js';

/**
 * @param {object[]} samples 规范化采样点
 * @param {object[]} kmMarkers 由真实 Lap 派生的公里刻度
 * @returns {{ pace: boolean, heartRate: boolean, cadence: boolean, altitude: boolean,
 *             power: boolean, gps: boolean, gct: boolean, lapMarkers: boolean }}
 */
export function computeAvailability(samples, kmMarkers = []) {
  return {
    pace: samples.some((sample) => sample.speedMps !== null && sample.speedMps > 0),
    heartRate: samples.some((sample) => sample.heartRateBpm !== null),
    cadence: samples.some((sample) => sample.cadenceSpm !== null),
    altitude: samples.some((sample) => sample.altitudeM !== null),
    power: samples.some((sample) => sample.powerWatts !== null),
    gps: samples.some((sample) => sample.lat !== null && sample.lon !== null),
    // TCX 不提供触地时间；首版不解析、不绘制、不填 0（ADR 0004）。
    gct: false,
    lapMarkers: kmMarkers.length > 0,
  };
}
