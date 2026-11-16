/**
 * 插值器 / 配速平滑 / 时间轴的行为测试。
 * 采样点与期望值都是手写的小数据，插值结果按线性插值手算，平滑窗口按窗口内算术平均手算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMotion, frameTimeMs, motionAt, motionAtFrame } from '../data/interpolate.mjs';

/** 造一个采样点，未给的字段统一为 null（缺值不是 0）。 */
function sample(tMs, fields = {}) {
  return {
    tMs,
    distanceM: null,
    speedMps: null,
    heartRateBpm: null,
    cadenceSpm: null,
    altitudeM: null,
    powerWatts: null,
    lat: null,
    lon: null,
    ...fields,
  };
}

// 验收项 1：任意时刻的运动指标由相邻采样点线性插值得到。
test('相邻采样点之间按时间比例线性插值', () => {
  const motion = buildMotion([
    sample(0, { distanceM: 100, speedMps: 4, heartRateBpm: 140, cadenceSpm: 170, altitudeM: 20 }),
    sample(1000, { distanceM: 120, speedMps: 4, heartRateBpm: 160, cadenceSpm: 180, altitudeM: 22 }),
  ]);

  const metrics = motionAt(motion, 250);

  assert.equal(metrics.distanceM, 105);
  assert.equal(metrics.heartRateBpm, 145);
  assert.equal(metrics.cadenceSpm, 172.5);
  assert.equal(metrics.altitudeM, 20.5);
  // 4 m/s → 1000 / 4 = 250 s/km
  assert.equal(metrics.paceSecPerKm, 250);
});

// 越界时刻的约定：早于首点取首点，晚于末点取末点（不产生 NaN，也不外推）。
test('早于首点与晚于末点时取端点值', () => {
  const motion = buildMotion([
    sample(0, { distanceM: 0, speedMps: 5, heartRateBpm: 140 }),
    sample(2000, { distanceM: 10, speedMps: 5, heartRateBpm: 150 }),
  ]);

  assert.equal(motionAt(motion, -5000).distanceM, 0);
  assert.equal(motionAt(motion, -5000).heartRateBpm, 140);
  assert.equal(motionAt(motion, 9000).distanceM, 10);
  assert.equal(motionAt(motion, 9000).heartRateBpm, 150);
});

// 验收项 5：某时刻缺值（暂停 / 缺失区间）保持上一有效值，不归零。
test('缺失的心率与功率保持上一有效值而不是 0', () => {
  const motion = buildMotion([
    sample(0, { distanceM: 0, speedMps: 4, heartRateBpm: 140, powerWatts: 300 }),
    sample(1000, { distanceM: 4, speedMps: 4 }),
    sample(2000, { distanceM: 8, speedMps: 4, heartRateBpm: 160 }),
  ]);

  assert.equal(motionAt(motion, 1000).heartRateBpm, 140);
  assert.equal(motionAt(motion, 1000).powerWatts, 300);
  assert.equal(motionAt(motion, 1500).heartRateBpm, 150);
});

// 整个活动都没有某个指标时返回 null，而不是 0 或占位值。
test('整段缺失的指标返回 null 而不是 0', () => {
  const motion = buildMotion([
    sample(0, { distanceM: 0, speedMps: 4 }),
    sample(1000, { distanceM: 4, speedMps: 4 }),
  ]);

  assert.equal(motionAt(motion, 500).powerWatts, null);
  assert.equal(motionAt(motion, 500).lat, null);
  assert.equal(motion.availability.power, false);
  assert.equal(motion.availability.heartRate, false);
});

// 验收项 5：暂停（速度为 0）的区间不换算配速（避免除零），配速保持上一有效值。
test('速度为 0 的暂停区间保持上一有效配速且不出现 Infinity/NaN', () => {
  const samples = [];
  for (let second = 0; second <= 20; second += 1) {
    samples.push(sample(second * 1000, {
      distanceM: Math.min(second, 4) * 4,
      speedMps: second <= 4 ? 4 : 0,
    }));
  }

  const motion = buildMotion(samples);

  assert.equal(motionAt(motion, 15000).paceSecPerKm, 250);
  for (const value of motion.paceSecPerKm) {
    assert.ok(Number.isFinite(value), `配速出现非有限值：${value}`);
  }
});

// 验收项 4：配速做 10 s 滑动平滑（按时间窗口、不按索引）。
test('配速按前后各 5 s 的时间窗口平滑', () => {
  const samples = [];
  for (let second = 0; second <= 9; second += 1) {
    samples.push(sample(second * 1000, {
      distanceM: second,
      // 前 5 个点 3 m/s，后 5 个点 5 m/s
      speedMps: second < 5 ? 3 : 5,
    }));
  }

  const motion = buildMotion(samples);

  // t=0：窗口 [0, 5] 内 6 个点，速度 3×5 + 5×1 = 20，均值 20/6 → 配速 1000 ÷ (20/6) = 300
  assert.equal(motionAt(motion, 0).paceSecPerKm, 300);
  // t=5：窗口 [0, 10] 内 10 个点，速度 3×5 + 5×5 = 40，均值 4 → 配速 250
  assert.equal(motionAt(motion, 5000).paceSecPerKm, 250);
  // 平滑前的原始速度中位数仍是 3 与 5 的分界，单点配速不会在 1 s 内从 333 跳到 200
  assert.ok(motionAt(motion, 2000).paceSecPerKm > 250);
});

// 验收项 2：7 s 间隔照常插值，不产生 NaN、不产生时间倒退。
test('7 秒间隔照常插值且时间戳严格递增', () => {
  const motion = buildMotion([
    sample(0, { distanceM: 100, speedMps: 4, heartRateBpm: 150 }),
    sample(7000, { distanceM: 128, speedMps: 4, heartRateBpm: 164 }),
  ]);

  for (let i = 1; i < motion.samples.length; i += 1) {
    assert.ok(motion.samples[i].tMs > motion.samples[i - 1].tMs);
  }
  const metrics = motionAt(motion, 3500);
  assert.equal(metrics.distanceM, 114);
  assert.equal(metrics.heartRateBpm, 157);
  assert.ok(Number.isFinite(metrics.paceSecPerKm));
});

// 验收项 7：第 n 帧的运动时刻 = n / fps + alignmentOffsetMs / 1000，与墙钟耗时无关。
test('帧号换算成运动时刻，只由帧号、fps 与对齐偏移决定', () => {
  assert.equal(frameTimeMs(0, { fps: 30, alignmentOffsetMs: 0 }), 0);
  assert.equal(frameTimeMs(30, { fps: 30, alignmentOffsetMs: 0 }), 1000);
  assert.equal(frameTimeMs(45, { fps: 30, alignmentOffsetMs: 500 }), 2000);
});

// 同一帧号在任何调用顺序下给出同一结果——帧号是唯一时钟。
test('同一帧号在不同调用顺序下得到同一运动指标', () => {
  const motion = buildMotion([
    sample(0, { distanceM: 0, speedMps: 4, heartRateBpm: 140 }),
    sample(1000, { distanceM: 4, speedMps: 4, heartRateBpm: 160 }),
    sample(2000, { distanceM: 8, speedMps: 4, heartRateBpm: 150 }),
  ]);
  const options = { fps: 30, alignmentOffsetMs: 0 };

  const forward = [0, 15, 30, 45].map((frame) => motionAtFrame(motion, frame, options));
  const backward = [45, 30, 15, 0].map((frame) => motionAtFrame(motion, frame, options)).reverse();

  assert.deepEqual(forward, backward);
  // 第 15 帧 = 0.5 s → 心率 150
  assert.equal(forward[1].metrics.heartRateBpm, 150);
  assert.equal(forward[1].timeMs, 500);
});

test('fps 非法时明确报错', () => {
  assert.throws(() => frameTimeMs(1, { fps: 0, alignmentOffsetMs: 0 }), /fps/);
});
