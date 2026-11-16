/**
 * 采样点 → 运动指标（GLOSSARY：采样点 / 运动指标 / 对齐偏移）。
 *
 * 三件事：
 * 1. 配速：`ns3:Speed` 按时间窗口做 10 s 滑动平滑，再把速度换算成 s/km；速度 0（暂停）不换算，保持上一有效值。
 * 2. 取任意时刻指标：二分查找 + 线性插值；缺值保持上一有效值，不归零。
 * 3. 帧号 → 运动时刻：`t = n / fps + alignmentOffsetMs / 1000`，是纯函数，与墙钟耗时无关。
 */
import { computeAvailability } from './availability.mjs';

/** 配速平滑窗口长度（毫秒），窗口以当前时刻为中心，前后各一半。 */
export const PACE_SMOOTH_WINDOW_MS = 10000;

/** 参与向前保持的数值指标；经纬度不在此列，缺失要保持 null 以便路线断笔。 */
const HOLD_METRICS = ['distanceM', 'heartRateBpm', 'cadenceSpm', 'altitudeM', 'powerWatts'];

/** 速度平滑只在有效速度上做平均：null 是缺值，0 是暂停，两者都不参与。 */
function smoothSpeed(samples, windowMs) {
  const half = windowMs / 2;
  const valid = samples
    .map((sample) => ({ tMs: sample.tMs, speed: sample.speedMps }))
    .filter((entry) => entry.speed !== null && entry.speed > 0);

  const smoothed = new Array(samples.length).fill(null);
  let lo = 0;
  let hi = 0;
  let sum = 0;

  for (const [index, sample] of samples.entries()) {
    const from = sample.tMs - half;
    const to = sample.tMs + half;

    while (hi < valid.length && valid[hi].tMs <= to) {
      sum += valid[hi].speed;
      hi += 1;
    }
    while (lo < hi && valid[lo].tMs < from) {
      sum -= valid[lo].speed;
      lo += 1;
    }

    if (hi > lo) smoothed[index] = sum / (hi - lo);
  }

  return smoothed;
}

/**
 * 把 null 用上一有效值填掉；开头的 null 用第一个有效值回填。
 * 这就是「暂停 / 缺失区间保持上一有效值，不归零」的实现位置。
 */
function holdPrevious(values) {
  const out = values.slice();
  let last = null;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === null) {
      out[i] = last;
    } else {
      last = out[i];
    }
  }
  const firstValid = out.find((value) => value !== null);
  if (firstValid !== undefined) {
    for (let i = 0; i < out.length && out[i] === null; i += 1) out[i] = firstValid;
  }
  return out;
}

/**
 * 构建运动指标序列。
 * @param {object[]} samples 规范化采样点（按 tMs 严格递增）
 * @param {{ windowMs?: number, kmMarkers?: object[] }} [options]
 */
export function buildMotion(samples, options = {}) {
  const { windowMs = PACE_SMOOTH_WINDOW_MS, kmMarkers = [] } = options;

  const smoothedSpeed = smoothSpeed(samples, windowMs);
  // 速度 0 意味着暂停，配速无意义（除零），保持上一有效配速；保留一位小数即可。
  const paceSecPerKm = holdPrevious(smoothedSpeed.map((speed) => (
    speed === null || speed <= 0 ? null : Math.round((1000 / speed) * 10) / 10
  )));

  const series = { paceSecPerKm };
  for (const metric of HOLD_METRICS) {
    series[metric] = holdPrevious(samples.map((sample) => sample[metric]));
  }

  return {
    samples,
    series,
    paceSecPerKm,
    availability: computeAvailability(samples, kmMarkers),
    startMs: samples[0].tMs,
    endMs: samples[samples.length - 1].tMs,
  };
}

/** 找到最后一个 `tMs <= timeMs` 的下标；调用方保证时间在 [首点, 末点] 内。 */
function bracketIndex(samples, timeMs) {
  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tMs <= timeMs) lo = mid;
    else hi = mid;
  }
  return lo;
}

function lerp(a, b, ratio) {
  return a + (b - a) * ratio;
}

/** 两个端点都有效才插值；只有一侧有效时取有效值；都无效返回 null。 */
function interpolate(a, b, ratio) {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return lerp(a, b, ratio);
}

/**
 * 取某时刻的运动指标。早于首点取首点，晚于末点取末点（不外推）。
 * @param {ReturnType<typeof buildMotion>} motion
 * @param {number} timeMs 相对活动开始的毫秒
 */
export function motionAt(motion, timeMs) {
  const { samples, series } = motion;
  const first = samples[0];
  const last = samples[samples.length - 1];

  if (timeMs <= first.tMs) return metricsAt(samples[0], series, 0, timeMs);
  if (timeMs >= last.tMs) return metricsAt(last, series, samples.length - 1, timeMs);

  const lo = bracketIndex(samples, timeMs);
  const a = samples[lo];
  const b = samples[lo + 1];
  const span = b.tMs - a.tMs;
  return metricsAt(a, series, lo, timeMs, b, span === 0 ? 0 : (timeMs - a.tMs) / span);
}

function metricsAt(a, series, index, timeMs, b = null, ratio = 0) {
  const value = (metric) => (b === null ? series[metric][index] : interpolate(series[metric][index], series[metric][index + 1], ratio));
  return {
    tMs: timeMs,
    distanceM: value('distanceM'),
    paceSecPerKm: value('paceSecPerKm'),
    heartRateBpm: value('heartRateBpm'),
    cadenceSpm: value('cadenceSpm'),
    altitudeM: value('altitudeM'),
    powerWatts: value('powerWatts'),
    // 经纬度不做保持：任一端缺失就是 null，路线据此断笔，不连线穿过缺口。
    lat: b === null ? a.lat : (a.lat === null || b.lat === null ? null : lerp(a.lat, b.lat, ratio)),
    lon: b === null ? a.lon : (a.lon === null || b.lon === null ? null : lerp(a.lon, b.lon, ratio)),
  };
}

/**
 * 帧号 → 运动时刻（毫秒）。帧号是唯一时钟：同一帧号在任何调用顺序、任何渲染耗时下结果相同。
 * @param {number} frame 帧号，从 0 开始
 * @param {{ fps: number, alignmentOffsetMs?: number }} options
 */
export function frameTimeMs(frame, { fps, alignmentOffsetMs = 0 }) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`fps 必须是正数，实际为 ${fps}`);
  }
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`帧号必须是非负整数，实际为 ${frame}`);
  }
  return (frame * 1000) / fps + alignmentOffsetMs;
}

/**
 * 取某帧的运动指标。
 * @param {ReturnType<typeof buildMotion>} motion
 * @param {number} frame
 * @param {{ fps: number, alignmentOffsetMs?: number }} options
 */
export function motionAtFrame(motion, frame, options) {
  const timeMs = frameTimeMs(frame, options);
  return { frame, timeMs, metrics: motionAt(motion, timeMs) };
}
