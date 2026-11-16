/**
 * 数据可用性（GLOSSARY：数据可用性）——「整个活动是否有这个指标」。
 *
 * 只回答数据侧的事实，与组件是否开启无关；最终是否绘制由
 * `shouldRender = configEnabled && dataAvailable` 决定（ADR 0004）。
 * 判定结果只在运行时产生，不写进 project.json。
 */

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

/**
 * 绘制判据：组件开启且数据可用才绘制。缺值时既不画也不填占位数字。
 * @param {boolean} configEnabled
 * @param {boolean} dataAvailable
 */
export function shouldRender(configEnabled, dataAvailable) {
  return configEnabled === true && dataAvailable === true;
}
