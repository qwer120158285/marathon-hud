/**
 * TCX 解析器的行为测试。
 * 台账数据全部手写构造，期望值来自手算（每个 Trackpoint 的字段值都是我写进去的那几个数）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTcx, TcxParseError } from '../data/tcx.mjs';
import { shouldRender } from '../data/availability.mjs';

/** 拼一个最小 TCX；`trackpoints` 是 Trackpoint 内部 XML 的字符串数组。 */
function tcx({ id = '2026-01-01T08:00:00.000Z', laps } = {}) {
  const lapList = laps ?? [{ startTime: id, totalSeconds: 2, distance: 10, trackpoints: [] }];
  const body = lapList
    .map((lap) => `      <Lap StartTime="${lap.startTime}">
        <TotalTimeSeconds>${lap.totalSeconds}</TotalTimeSeconds>
        <DistanceMeters>${lap.distance}</DistanceMeters>
        <Track>
${lap.trackpoints.map((tp) => `          <Trackpoint>${tp}</Trackpoint>`).join('\n')}
        </Track>
      </Lap>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase
  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Running">
      <Id>${id}</Id>
${body}
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;
}

/** 一个带齐全部字段的 Trackpoint。 */
function point({ time, distance, heartRate, altitude = 20, lat, lon, speed, runCadence, watts, prefix = 'ns3' }) {
  const position = lat === undefined ? '' : `
            <Position>
              <LatitudeDegrees>${lat}</LatitudeDegrees>
              <LongitudeDegrees>${lon}</LongitudeDegrees>
            </Position>`;
  const extension = speed === undefined ? '' : `
            <Extensions>
              <${prefix ? `${prefix}:` : ''}TPX>
                <${prefix ? `${prefix}:` : ''}Speed>${speed}</${prefix ? `${prefix}:` : ''}Speed>
                <${prefix ? `${prefix}:` : ''}RunCadence>${runCadence}</${prefix ? `${prefix}:` : ''}RunCadence>
                ${watts === undefined ? '' : `<${prefix ? `${prefix}:` : ''}Watts>${watts}</${prefix ? `${prefix}:` : ''}Watts>`}
              </${prefix ? `${prefix}:` : ''}TPX>
            </Extensions>`;
  return `
            <Time>${time}</Time>${position}
            <AltitudeMeters>${altitude}</AltitudeMeters>
            <DistanceMeters>${distance}</DistanceMeters>
            <HeartRateBpm>
              <Value>${heartRate}</Value>
            </HeartRateBpm>${extension}`;
}

// 验收项 1：规范化采样点含相对时间、距离、速度、心率、步频、海拔与经纬度。
test('三个 Trackpoint 解析成相对时间起算的规范化采样点', () => {
  const xml = tcx({
    laps: [{
      startTime: '2026-01-01T08:00:00.000Z',
      totalSeconds: 2,
      distance: 10,
      trackpoints: [
        point({ time: '2026-01-01T08:00:00.000Z', distance: 0, heartRate: 150, altitude: 21.5, lat: 22.5, lon: 115.5, speed: 3, runCadence: 90, watts: 300 }),
        point({ time: '2026-01-01T08:00:01.000Z', distance: 3.5, heartRate: 152, altitude: 22, lat: 22.5001, lon: 115.5001, speed: 3.5, runCadence: 91, watts: 320 }),
        point({ time: '2026-01-01T08:00:02.000Z', distance: 10, heartRate: 155, altitude: 22.5, lat: 22.5002, lon: 115.5002, speed: 4, runCadence: 92, watts: 340 }),
      ],
    }],
  });

  const activity = parseTcx(xml);

  assert.deepEqual(activity.samples, [
    { tMs: 0, distanceM: 0, speedMps: 3, heartRateBpm: 150, cadenceSpm: 180, altitudeM: 21.5, powerWatts: 300, lat: 22.5, lon: 115.5 },
    { tMs: 1000, distanceM: 3.5, speedMps: 3.5, heartRateBpm: 152, cadenceSpm: 182, altitudeM: 22, powerWatts: 320, lat: 22.5001, lon: 115.5001 },
    { tMs: 2000, distanceM: 10, speedMps: 4, heartRateBpm: 155, cadenceSpm: 184, altitudeM: 22.5, powerWatts: 340, lat: 22.5002, lon: 115.5002 },
  ]);
});

// 活动级信息：首点 UTC 时间、时长、总距离、原始采样点数、Lap。
test('活动级信息给首点 UTC 时间、时长、总距离、采样点数与 Lap 列表', () => {
  const xml = tcx({
    laps: [
      {
        startTime: '2026-01-01T08:00:00.000Z',
        totalSeconds: 2,
        distance: 10,
        trackpoints: [
          point({ time: '2026-01-01T08:00:00.000Z', distance: 0, heartRate: 150, altitude: 21.5, speed: 3, runCadence: 90 }),
          point({ time: '2026-01-01T08:00:02.000Z', distance: 10, heartRate: 155, altitude: 22.5, speed: 4, runCadence: 92 }),
        ],
      },
    ],
  });

  const activity = parseTcx(xml);

  assert.equal(activity.startTimeUtc, '2026-01-01T08:00:00.000Z');
  assert.equal(activity.durationMs, 2000);
  assert.equal(activity.totalDistanceM, 10);
  assert.equal(activity.trackpointCount, 2);
  assert.deepEqual(activity.laps, [
    { index: 0, startTimeMs: 0, durationMs: 2000, distanceM: 10, startDistanceM: 0 },
  ]);
});

test('不可解析的文本抛 TcxParseError 并说明原因', () => {
  assert.throws(() => parseTcx('<not-tcx/>'), TcxParseError);
  assert.throws(() => parseTcx(''), /没有找到 Activity/);
});

/**
 * 验收项 2：重复时间戳去重。样本里 18 处重复都是相邻、字段全同的记录；
 * 这里故意让后一条取值不同，用来固定「保留首条」这一策略。
 */
test('相邻重复时间戳只保留首条采样点', () => {
  const xml = tcx({
    laps: [{
      startTime: '2026-01-01T08:00:00.000Z',
      totalSeconds: 1,
      distance: 6,
      trackpoints: [
        point({ time: '2026-01-01T08:00:00.000Z', distance: 0, heartRate: 150, speed: 3, runCadence: 90 }),
        point({ time: '2026-01-01T08:00:01.000Z', distance: 5, heartRate: 160, speed: 3.5, runCadence: 91 }),
        point({ time: '2026-01-01T08:00:01.000Z', distance: 6, heartRate: 199, speed: 9.9, runCadence: 99 }),
      ],
    }],
  });

  const activity = parseTcx(xml);

  assert.equal(activity.trackpointCount, 3);
  assert.equal(activity.duplicateTimestamps, 1);
  assert.equal(activity.samples.length, 2);
  assert.deepEqual(activity.samples[1], {
    tMs: 1000, distanceM: 5, speedMps: 3.5, heartRateBpm: 160, cadenceSpm: 182, altitudeM: 20, powerWatts: null, lat: null, lon: null,
  });
});

// 命名空间前缀不是固定的：默认命名空间（无前缀）与别的前缀都要能取到扩展字段。
test('扩展字段按本地名匹配，不依赖 ns3 前缀', () => {
  const xml = tcx({
    laps: [{
      startTime: '2026-01-01T08:00:00.000Z',
      totalSeconds: 1,
      distance: 3,
      trackpoints: [
        point({ time: '2026-01-01T08:00:00.000Z', distance: 0, heartRate: 140, speed: 3, runCadence: 88, prefix: '' }),
        point({ time: '2026-01-01T08:00:01.000Z', distance: 3, heartRate: 141, speed: 3.2, runCadence: 89, prefix: 'gpx' }),
      ],
    }],
  });

  const activity = parseTcx(xml);

  assert.equal(activity.samples[0].speedMps, 3);
  assert.equal(activity.samples[0].cadenceSpm, 176);
  assert.equal(activity.samples[1].speedMps, 3.2);
  assert.equal(activity.samples[1].cadenceSpm, 178);
});

// 验收项 3：最前若干点没有 Position 时保留空值，供路线断笔使用（不是 0）。
test('缺少 Position 的采样点经纬度为 null', () => {
  const xml = tcx({
    laps: [{
      startTime: '2026-01-01T08:00:00.000Z',
      totalSeconds: 1,
      distance: 3,
      trackpoints: [
        point({ time: '2026-01-01T08:00:00.000Z', distance: 0, heartRate: 140, speed: 3, runCadence: 88 }),
        point({ time: '2026-01-01T08:00:01.000Z', distance: 3, heartRate: 141, lat: 22.5, lon: 115.5, speed: 3.2, runCadence: 89 }),
      ],
    }],
  });

  const activity = parseTcx(xml);

  assert.equal(activity.samples[0].lat, null);
  assert.equal(activity.samples[0].lon, null);
  assert.equal(activity.samples[1].lat, 22.5);
  assert.equal(activity.samples[1].lon, 115.5);
});

// 验收项 4/6：整个活动缺某个指标时标为不可用（数据可用性不写进 project.json）。
test('活动级数据可用性逐项判定，缺字段即不可用', () => {
  const xml = tcx({
    laps: [{
      startTime: '2026-01-01T08:00:00.000Z',
      totalSeconds: 1,
      distance: 3,
      trackpoints: [
        point({ time: '2026-01-01T08:00:00.000Z', distance: 0, heartRate: 140 }),
        point({ time: '2026-01-01T08:00:01.000Z', distance: 3, heartRate: 141 }),
      ],
    }],
  });

  const { availability } = parseTcx(xml);

  assert.deepEqual(availability, {
    pace: false,
    heartRate: true,
    cadence: false,
    altitude: true,
    power: false,
    gps: false,
    gct: false,
    lapMarkers: false,
  });
});

// ADR 0004：组件开启且数据可用才绘制；两者任一为假都不画。
test('绘制判据是组件开关与数据可用性的合取', () => {
  assert.equal(shouldRender(true, true), true);
  assert.equal(shouldRender(true, false), false);
  assert.equal(shouldRender(false, true), false);
});
