/**
 * CLI 数据源：加载 TCX、构建运动指标、生成报告文本。
 * 数据源相关的一切都在这里，`cli/render.mjs` 只负责编排与退出码。
 */
import path from 'node:path';

import { readTcx } from '../data/tcx.mjs';
import { buildMotion } from '../data/interpolate.mjs';

/** 数据源缺失或不可解析统一用这个错误类型，由 CLI 入口转成退出码 4。 */
export class DataSourceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataSourceError';
  }
}

/** 指标标识 → 报告里的中文名。 */
const METRIC_LABELS = {
  pace: '配速',
  heartRate: '心率',
  cadence: '步频',
  altitude: '海拔',
  power: '功率',
  gps: 'GPS',
  gct: '触地时间',
  lapMarkers: 'Lap 刻度',
};

/**
 * 按 project.json 的 `tcx.path`（相对 project.json 所在目录）加载数据源。
 * @param {object} project 已通过 Schema 校验的配置
 * @param {string} projectDir project.json 所在目录
 */
export function loadDataSource(project, projectDir) {
  const configured = project.tcx?.path;
  if (typeof configured !== 'string' || configured.trim() === '') {
    throw new DataSourceError('project.json 未配置 tcx.path（数据源缺失）');
  }

  const filePath = path.resolve(projectDir, configured);
  let activity;
  try {
    activity = readTcx(filePath);
  } catch (error) {
    throw new DataSourceError(error.message);
  }

  return {
    filePath,
    activity,
    motion: buildMotion(activity.samples, { kmMarkers: activity.kmMarkers }),
  };
}

/** 整数不带小数点，小数最多三位。 */
function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/** 毫秒 → h:mm:ss。 */
export function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 配速（秒/公里）→ m'ss"/km。 */
function formatPace(secPerKm) {
  const total = Math.round(secPerKm);
  return `${Math.floor(total / 60)}'${String(total % 60).padStart(2, '0')}"`;
}

/** 数据可用性 → 「可用指标 / 不可用指标」两行。 */
function formatAvailabilityLines(availability) {
  const available = [];
  const unavailable = [];
  for (const [metric, label] of Object.entries(METRIC_LABELS)) {
    (availability[metric] ? available : unavailable).push(label);
  }
  return [
    `  可用指标      ${available.length === 0 ? '（无）' : available.join('、')}`,
    `  不可用指标    ${unavailable.length === 0 ? '（无）' : unavailable.join('、')}`,
  ];
}

/** 数据源概览：解析结果的事实，用于 `--validate-only` 的报告。 */
export function formatDataSourceReport({ filePath, activity }) {
  const { availability } = activity;
  return [
    `数据源  ${filePath}`,
    `  采样点        ${activity.trackpointCount}（去重后 ${activity.samples.length}，重复时间戳 ${activity.duplicateTimestamps}）`,
    `  Lap           ${activity.laps.length}（完整公里刻度 ${activity.kmMarkers.length} 个）`,
    `  距离          ${formatNumber(Math.round(activity.totalDistanceM * 10) / 10)} m`,
    `  时长          ${formatDuration(activity.durationMs)}`,
    `  首点          ${activity.startTimeUtc}`,
    ...formatAvailabilityLines(availability),
  ].join('\n');
}

/**
 * 某一帧的运动指标报告。
 * @param {{ frame: number, timeMs: number, metrics: object }} frameResult motionAtFrame 的结果
 * @param {{ fps: number, alignmentOffsetMs: number, availability: object }} context
 */
export function formatFrameReport({ frame, timeMs, metrics }, { fps, alignmentOffsetMs, availability }) {
  const lines = [
    `帧号：${frame}（fps ${formatNumber(fps)}，对齐偏移 ${formatNumber(alignmentOffsetMs)} ms）`,
    `运动时刻：${(timeMs / 1000).toFixed(3)} s`,
    `距离：${formatNumber(Math.round(metrics.distanceM * 10) / 10)} m`,
  ];

  if (metrics.paceSecPerKm !== null) lines.push(`配速：${formatPace(metrics.paceSecPerKm)}/km`);
  if (metrics.heartRateBpm !== null) lines.push(`心率：${formatNumber(Math.round(metrics.heartRateBpm))} bpm`);
  if (metrics.cadenceSpm !== null) lines.push(`步频：${formatNumber(Math.round(metrics.cadenceSpm))} spm`);
  if (metrics.altitudeM !== null) lines.push(`海拔：${formatNumber(Math.round(metrics.altitudeM * 10) / 10)} m`);
  if (metrics.powerWatts !== null) lines.push(`功率：${formatNumber(Math.round(metrics.powerWatts))} W`);
  if (metrics.lat !== null && metrics.lon !== null) {
    lines.push(`位置：${metrics.lat.toFixed(6)}, ${metrics.lon.toFixed(6)}`);
  }

  const unavailable = Object.entries(METRIC_LABELS)
    .filter(([metric]) => !availability[metric])
    .map(([, label]) => label);
  lines.push(`不可用指标：${unavailable.length === 0 ? '（无）' : unavailable.join('、')}`);
  return lines.join('\n');
}
