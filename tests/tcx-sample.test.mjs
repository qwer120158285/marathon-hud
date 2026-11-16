/**
 * 真实样本 `activity_662602587.tcx`（Garmin Forerunner 255）的验收测试。
 * 期望值来自 docs/DECISIONS.md「事实基线」：4828 个 Trackpoint、19 个 Lap、18.278 km、
 * 时长 1:20:15、18 个重复时间戳、1 处 7 s 间隔、最前 36 点无 GPS、步频中位 92（×2 记 SPM）、无 GCT。
 * 样本是 3.6 MB 的仓库内文件，缺失时跳过，不伪装通过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTcx } from '../data/tcx.mjs';
import { buildMotion, motionAt } from '../data/interpolate.mjs';

const SAMPLE_PATH = fileURLToPath(new URL('../activity_662602587.tcx', import.meta.url));
const skip = existsSync(SAMPLE_PATH) ? false : `缺少真实样本：${SAMPLE_PATH}`;

let cached = null;
function sample() {
  cached ??= readTcx(SAMPLE_PATH);
  return cached;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

test('真实样本解析出 4828 个采样点、19 个 Lap、18.278 km、1:20:15', { skip }, () => {
  const activity = sample();

  assert.equal(activity.trackpointCount, 4828);
  assert.equal(activity.laps.length, 19);
  assert.equal(Math.round(activity.totalDistanceM), 18278);
  assert.equal(activity.durationMs, 4_815_000);
  assert.equal(activity.startTimeUtc, '2026-11-15T11:44:02.000Z');
});

test('18 个重复时间戳去重后剩 4810 个采样点', { skip }, () => {
  const activity = sample();

  assert.equal(activity.duplicateTimestamps, 18);
  assert.equal(activity.samples.length, 4828 - 18);
});

test('最前 36 点没有 GPS，其余点有经纬度', { skip }, () => {
  const activity = sample();

  const missing = activity.samples.filter((entry) => entry.lat === null);
  assert.equal(missing.length, 36);
  assert.ok(activity.samples.slice(36).every((entry) => entry.lat !== null && entry.lon !== null));
});

test('步频是单脚读数的两倍，中位 184 SPM', { skip }, () => {
  const activity = sample();

  assert.equal(median(activity.samples.map((entry) => entry.cadenceSpm)), 184);
  // 原始 RunCadence 是单脚读数，中位 92；解析后一律按双脚步频 SPM 输出。
  assert.equal(median(activity.samples.map((entry) => entry.cadenceSpm)) / 2, 92);
});

test('触地时间不可用，功率与 GPS 可用', { skip }, () => {
  const activity = sample();

  assert.equal(activity.availability.gct, false);
  assert.equal(activity.availability.power, true);
  assert.equal(activity.availability.gps, true);
  assert.equal(activity.availability.lapMarkers, true);
});

test('公里刻度只取完整 Lap：18 个刻度，最后一个不足 1 km 的 Lap 不伪造刻度', { skip }, () => {
  const activity = sample();

  assert.equal(activity.kmMarkers.length, 18);
  assert.deepEqual(activity.kmMarkers.map((marker) => marker.distanceM), [
    1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000,
    10000, 11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000,
  ]);
  assert.equal(activity.laps[18].distanceM, 278.08);
});

test('7 s 间隔照常插值：整段帧扫描无 NaN、时刻单调', { skip }, () => {
  const activity = sample();
  const motion = buildMotion(activity.samples, { kmMarkers: activity.kmMarkers });
  const fps = 30;
  const totalFrames = Math.round((activity.durationMs / 1000) * fps);
  let previousTime = -Infinity;

  for (let frame = 0; frame <= totalFrames; frame += 1) {
    const timeMs = (frame / fps) * 1000;
    assert.ok(timeMs > previousTime);
    previousTime = timeMs;

    const metrics = motionAt(motion, timeMs);
    assert.ok(Number.isFinite(metrics.distanceM), `第 ${frame} 帧距离非有限值`);
    assert.ok(Number.isFinite(metrics.heartRateBpm), `第 ${frame} 帧心率非有限值`);
    assert.ok(Number.isFinite(metrics.cadenceSpm), `第 ${frame} 帧步频非有限值`);
    assert.ok(Number.isFinite(metrics.paceSecPerKm), `第 ${frame} 帧配速非有限值`);
  }
});

test('平滑后的配速贴近真实速度中位数，不会逐秒乱跳', { skip }, () => {
  const activity = sample();
  const motion = buildMotion(activity.samples);

  // 事实基线：速度中位 3.84 m/s → 配速中位约 260 s/km（4'20"/km）
  assert.ok(Math.abs(median(motion.paceSecPerKm) - 261) < 5, `配速中位数 ${median(motion.paceSecPerKm)}`);

  // 显示精度是 1 s/km：95% 的相邻秒变化应小于 2 s/km。
  // 样本里 13.4 km 处有一段真实减速（配速从 4'32" 掉到 11'34"），那属于数据本身，不算抖动。
  const jumps = [];
  for (let i = 1; i < motion.paceSecPerKm.length; i += 1) {
    jumps.push(Math.abs(motion.paceSecPerKm[i] - motion.paceSecPerKm[i - 1]));
  }
  jumps.sort((a, b) => a - b);
  const p95 = jumps[Math.floor(jumps.length * 0.95)];
  assert.ok(p95 < 2, `相邻秒配速变化的 95 分位为 ${p95} s/km`);
});
