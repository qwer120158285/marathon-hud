/**
 * TCX → 规范化采样点（GLOSSARY：采样点 / 运动指标）。
 *
 * 数据源是 Garmin 导出的 TrainingCenterDatabase v2。这里只解析出片需要的部分：
 * `Activities/Activity/Lap/Track/Trackpoint`。解析器是手写的按块匹配：
 * TCX 的 Trackpoint 不会互相嵌套，按 `<Trackpoint>…</Trackpoint>` 切块比引第三方 XML 库更省事，
 * 也不给运行时加依赖。限制：不支持 CDATA、注释里出现同名标签这类极端写法。
 *
 * 命名空间前缀不固定（样本是 `ns3:`，别的导出可能是 `gpx:` 或默认命名空间），
 * 因此所有字段都按「本地名 + 可选前缀」匹配，不硬编码 `ns3:`。
 */
import { readFileSync } from 'node:fs';

import { computeAvailability } from './availability.mjs';

/** 解析失败统一抛这个错误，由 CLI 入口转成退出码 4（数据源缺失 / 不可解析）。 */
export class TcxParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TcxParseError';
  }
}

/** 按本地名取第一个元素的内容；`<Foo>`、`<ns3:Foo>`、`<gpx:Foo>` 都能命中。 */
function tagText(block, localName) {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
  );
  const match = block.match(pattern);
  return match === null ? null : match[1].trim();
}

/** 取数值字段；缺失或非数字一律返回 null（缺值不是 0）。 */
function tagNumber(block, localName) {
  const text = tagText(block, localName);
  if (text === null || text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 取 `Lap` 的开头属性，例如 `StartTime`。 */
function attribute(openTag, name) {
  const match = openTag.match(new RegExp(`${name}="([^"]*)"`));
  return match === null ? null : match[1];
}

/** 一个 Trackpoint 块 → 采样点（相对时间由调用方补）。 */
function parseTrackpoint(block) {
  const timeText = tagText(block, 'Time');
  const timeMs = timeText === null ? Number.NaN : Date.parse(timeText);
  if (!Number.isFinite(timeMs)) {
    throw new TcxParseError(`Trackpoint 的 Time 无法解析：${timeText ?? '（缺失）'}`);
  }

  const position = tagText(block, 'Position');
  const lat = position === null ? null : tagNumber(position, 'LatitudeDegrees');
  const lon = position === null ? null : tagNumber(position, 'LongitudeDegrees');

  const heartRate = tagText(block, 'HeartRateBpm');
  const runCadence = tagNumber(block, 'RunCadence');

  return {
    timeMs,
    distanceM: tagNumber(block, 'DistanceMeters'),
    speedMps: tagNumber(block, 'Speed'),
    heartRateBpm: heartRate === null ? null : tagNumber(heartRate, 'Value'),
    // `RunCadence` 是单脚读数（样本中位 92），显示步频要 ×2 才是双脚步频 SPM。
    cadenceSpm: runCadence === null ? null : runCadence * 2,
    altitudeM: tagNumber(block, 'AltitudeMeters'),
    powerWatts: tagNumber(block, 'Watts'),
    // GPS 缺失保留 null 而不是 0，供路线断笔使用。
    lat: lat ?? null,
    lon: lon ?? null,
  };
}

/** 一个 Lap 块 → Lap 摘要 + 它的全部 Trackpoint。 */
function parseLap(openTag, body) {
  const startTimeText = attribute(openTag, 'StartTime');
  const startTimeMs = startTimeText === null ? null : Date.parse(startTimeText);
  const totalSeconds = tagNumber(body, 'TotalTimeSeconds');
  // Lap 级的 DistanceMeters 出现在 Track 之前；Track 内部每个 Trackpoint 都有自己的 DistanceMeters。
  const header = body.split(/<Track\b/)[0];

  const trackpoints = [];
  for (const match of body.matchAll(/<Trackpoint(?:\s[^>]*)?>([\s\S]*?)<\/Trackpoint>/g)) {
    trackpoints.push(parseTrackpoint(match[1]));
  }

  return {
    startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : null,
    durationMs: totalSeconds === null ? null : Math.round(totalSeconds * 1000),
    distanceM: tagNumber(header, 'DistanceMeters'),
    trackpoints,
  };
}

/**
 * 解析 TCX 文本。
 * @param {string} xml
 * @returns {{
 *   startTimeUtc: string,
 *   durationMs: number,
 *   totalDistanceM: number,
 *   trackpointCount: number,
 *   duplicateTimestamps: number,
 *   samples: object[],
 *   laps: object[],
 *   kmMarkers: object[],
 * }}
 */
export function parseTcx(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new TcxParseError('TCX 内容为空，没有找到 Activity');
  }

  const activityMatch = xml.match(/<Activity(?:\s[^>]*)?>([\s\S]*?)<\/Activity>/);
  if (activityMatch === null) {
    throw new TcxParseError('TCX 里没有找到 Activity 节点，可能不是 TrainingCenterDatabase v2 文件');
  }
  const activityBody = activityMatch[1];

  const rawLaps = [];
  for (const match of activityBody.matchAll(/<Lap(\s[^>]*)?>([\s\S]*?)<\/Lap>/g)) {
    rawLaps.push(parseLap(match[1] ?? '', match[2]));
  }
  if (rawLaps.length === 0) {
    throw new TcxParseError('TCX 的 Activity 里没有 Lap 节点');
  }

  // 原始 Trackpoint 展平；`trackpointCount` 是去重前的条数，与 Garmin 导出条数对齐。
  const rawPoints = rawLaps.flatMap((lap) => lap.trackpoints);
  if (rawPoints.length === 0) {
    throw new TcxParseError('TCX 的 Lap 里没有 Trackpoint');
  }
  rawPoints.sort((a, b) => a.timeMs - b.timeMs);

  const startTimeMs = rawPoints[0].timeMs;

  // 重复时间戳：设备在 Lap 边界会把同一时刻写两遍。
  // 保留首条——同一时刻只应有一个观测值，首条是该时刻第一次落盘的值；
  // 真实样本的 18 处重复记录字段完全相同，因此保留首条不丢信息。
  const samples = [];
  let duplicateTimestamps = 0;
  let lastKeptTimeMs = Number.NaN;
  for (const point of rawPoints) {
    if (point.timeMs === lastKeptTimeMs) {
      duplicateTimestamps += 1;
      continue;
    }
    lastKeptTimeMs = point.timeMs;
    const { timeMs, ...rest } = point;
    samples.push({ tMs: timeMs - startTimeMs, ...rest });
  }

  const laps = [];
  let startDistanceM = 0;
  for (const [index, lap] of rawLaps.entries()) {
    const firstPoint = lap.trackpoints[0];
    const lapStartMs = lap.startTimeMs ?? (firstPoint === undefined ? null : firstPoint.timeMs);
    laps.push({
      index,
      startTimeMs: lapStartMs === null ? null : lapStartMs - startTimeMs,
      durationMs: lap.durationMs,
      distanceM: lap.distanceM,
      startDistanceM,
    });
    startDistanceM += lap.distanceM ?? 0;
  }

  const kmMarkers = deriveKmMarkers(laps);

  return {
    startTimeUtc: new Date(startTimeMs).toISOString(),
    durationMs: rawPoints[rawPoints.length - 1].timeMs - startTimeMs,
    totalDistanceM: lastDistance(samples),
    trackpointCount: rawPoints.length,
    duplicateTimestamps,
    samples,
    laps,
    kmMarkers,
    availability: computeAvailability(samples, kmMarkers),
  };
}

/** 活动总距离取最后一个采样点的累计距离；都没有时退回 Lap 距离之和。 */
function lastDistance(samples) {
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    if (samples[i].distanceM !== null) return samples[i].distanceM;
  }
  return 0;
}

/** 公里刻度容差：Lap 距离与整数公里的偏差在此之内才算一个完整公里，否则不伪造刻度。 */
const KM_MARKER_TOLERANCE_M = 25;

/**
 * 公里刻度只取完整 Lap：Lap 距离是整数公里（±25 m）才在累计距离处落刻度。
 * 样本最后一个 Lap 只有 278.08 m，不产生 18 km 之后的刻度。
 */
function deriveKmMarkers(laps) {
  const markers = [];
  for (const lap of laps) {
    const distanceM = lap.distanceM;
    if (distanceM === null || distanceM <= 0) continue;
    const kms = Math.round(distanceM / 1000);
    if (kms < 1 || Math.abs(distanceM - kms * 1000) > KM_MARKER_TOLERANCE_M) continue;
    for (let km = 1; km <= kms; km += 1) {
      markers.push({
        lapIndex: lap.index,
        // 累计距离按米取整：Lap 距离本身有 999.99 这类抖动，刻度落在整米上便于比对。
        distanceM: Math.round(lap.startDistanceM + km * 1000),
      });
    }
  }
  return markers;
}

/**
 * 读取并解析 TCX 文件。
 * @param {string} filePath
 * @returns {ReturnType<typeof parseTcx>}
 */
export function readTcx(filePath) {
  let xml;
  try {
    xml = readFileSync(filePath, 'utf8');
  } catch (error) {
    const reason = error.code === 'ENOENT' ? '文件不存在' : error.message;
    throw new TcxParseError(`无法读取数据源：${filePath}（${reason}）`);
  }
  try {
    return parseTcx(xml);
  } catch (error) {
    if (error instanceof TcxParseError) {
      throw new TcxParseError(`无法解析数据源：${filePath}（${error.message}）`);
    }
    throw error;
  }
}
