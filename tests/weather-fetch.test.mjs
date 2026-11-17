/**
 * 编辑期天气取数（ticket #10）：活动开始时刻 + 首个有效 GPS → Open-Meteo Historical Archive
 * 的一次小时值 → 单份冻结快照。
 *
 * 期望值来自独立事实源：docs/SPEC-v1.md 3.2 的 requestUrl 形状与样例数值、
 * Open-Meteo Archive 的响应字段名、示意数据里前 36 个采样点无 GPS（第 37 个是 22.5 / 113.9）。
 * 网络一律用注入的假 fetch，测试不访问外网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ARCHIVE_ENDPOINT,
  WeatherFetchError,
  buildWeatherQuery,
  createWeatherSnapshot,
  fetchWeatherSnapshot,
  firstValidPosition,
} from '../data/weather.mjs';
import { loadProject, saveProject } from '../cli/project.mjs';

const sample = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'));

/** Open-Meteo Archive 的响应形状：`latitude`/`longitude` 是模式网格中心，不是查询点。 */
const PAYLOAD = {
  latitude: 22.9525,
  longitude: 115.3653,
  timezone: 'Asia/Shanghai',
  hourly_units: { temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm' },
  hourly: {
    time: ['2026-11-15T18:00', '2026-11-15T19:00', '2026-11-15T20:00'],
    temperature_2m: [21.4, 22.0, 21.6],
    relative_humidity_2m: [91, 89, 90],
    precipitation: [0, 0.1, 0],
    weather_code: [3, 51, 3],
  },
};

const QUERY = buildWeatherQuery({
  startTimeUtc: '2026-11-15T11:00:00.000Z',
  position: { lat: 22.5, lon: 113.9 },
  timezone: 'Asia/Shanghai',
});

test('URL 与 SPEC 3.2 一致：坐标、同一开始/结束日期、四个小时字段、时区', () => {
  assert.equal(
    QUERY.url,
    `${ARCHIVE_ENDPOINT}?latitude=22.5&longitude=113.9&start_date=2026-11-15&end_date=2026-11-15`
      + '&hourly=temperature_2m,relative_humidity_2m,precipitation,weather_code&timezone=Asia%2FShanghai',
  );
  assert.equal(QUERY.timeLocal, '2026-11-15T19:00', 'UTC 11:00 在上海是活动开始那一小时 19:00');
  assert.deepEqual(QUERY.query, { latitude: 22.5, longitude: 113.9, timeLocal: '2026-11-15T19:00' });
});

test('跨零点按配置时区取当地日期：UTC 20:00 在上海已是次日 04:00', () => {
  const query = buildWeatherQuery({
    startTimeUtc: '2026-11-15T20:00:00.000Z',
    position: { lat: 22.5, lon: 113.9 },
    timezone: 'Asia/Shanghai',
  });

  assert.equal(query.timeLocal, '2026-11-16T04:00');
  assert.match(query.url, /start_date=2026-11-16&end_date=2026-11-16/);
});

test('首个有效 GPS 跳过最前面的 null：示意数据第 37 个采样点是 22.5 / 113.9', () => {
  const position = firstValidPosition(sample.activity.samples);

  assert.deepEqual(position, { lat: 22.5, lon: 113.9 });
  assert.equal(firstValidPosition([]), null);
  assert.equal(firstValidPosition([{ lat: null, lon: null }]), null);
});

test('取活动开始那一小时的值，不是第一条小时记录', () => {
  const snapshot = createWeatherSnapshot({
    query: QUERY,
    payload: PAYLOAD,
    fetchedAt: '2026-11-16T02:10:00.000Z',
  });

  assert.deepEqual(snapshot.values, {
    temperatureC: 22,
    humidityPct: 89,
    precipitationMm: 0.1,
    weatherCode: 51,
  });
});

test('快照含来源 URL、取数时刻、查询点与 ERA5 网格坐标（网格来自响应）', () => {
  const snapshot = createWeatherSnapshot({
    query: QUERY,
    payload: PAYLOAD,
    fetchedAt: '2026-11-16T02:10:00.000Z',
  });

  assert.equal(snapshot.source, 'open-meteo-historical-archive');
  assert.equal(snapshot.requestUrl, QUERY.url);
  assert.deepEqual(snapshot.query, { latitude: 22.5, longitude: 113.9, timeLocal: '2026-11-15T19:00' });
  assert.deepEqual(snapshot.grid, { latitude: 22.9525, longitude: 115.3653 });
  assert.equal(snapshot.fetchedAt, '2026-11-16T02:10:00.000Z');
  assert.equal(snapshot.values.weatherCode, 51);
});

test('响应里没有网格坐标时 grid 留 null（不猜坐标）', () => {
  const snapshot = createWeatherSnapshot({
    query: QUERY,
    payload: { hourly: PAYLOAD.hourly },
    fetchedAt: '2026-11-16T02:10:00.000Z',
  });

  assert.equal(snapshot.grid, null);
});

test('该小时缺某个测量值时省略该字段，不写成 0', () => {
  const payload = {
    ...PAYLOAD,
    hourly: { ...PAYLOAD.hourly, precipitation: [null, null, null] },
  };
  const snapshot = createWeatherSnapshot({ query: QUERY, payload, fetchedAt: '2026-11-16T02:10:00.000Z' });

  assert.equal(Object.hasOwn(snapshot.values, 'precipitationMm'), false);
  assert.equal(snapshot.values.temperatureC, 22);
});

test('响应里找不到活动开始那一小时时明确报错，并给出可选时间范围', () => {
  const payload = { ...PAYLOAD, hourly: { ...PAYLOAD.hourly, time: ['2026-11-14T19:00'] } };

  assert.throws(
    () => createWeatherSnapshot({ query: QUERY, payload, fetchedAt: '2026-11-16T02:10:00.000Z' }),
    (error) => error instanceof WeatherFetchError
      && error.message.includes('2026-11-15T19:00')
      && error.message.includes('2026-11-14T19:00'),
  );
});

test('取数只发一次请求，且请求的就是快照里记录的 URL', async () => {
  const requests = [];
  const snapshot = await fetchWeatherSnapshot({
    startTimeUtc: '2026-11-15T11:00:00.000Z',
    position: { lat: 22.5, lon: 113.9 },
    timezone: 'Asia/Shanghai',
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => PAYLOAD };
    },
    now: () => new Date('2026-11-16T02:10:00.000Z'),
  });

  assert.deepEqual(requests, [snapshot.requestUrl]);
  assert.equal(snapshot.fetchedAt, '2026-11-16T02:10:00.000Z');
  assert.equal(snapshot.values.temperatureC, 22);
});

test('网络失败与 HTTP 错误都抛 WeatherFetchError，文本里带上 URL 与原因', async () => {
  await assert.rejects(
    () => fetchWeatherSnapshot({
      startTimeUtc: '2026-11-15T11:00:00.000Z',
      position: { lat: 22.5, lon: 113.9 },
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND archive-api.open-meteo.com');
      },
    }),
    (error) => error instanceof WeatherFetchError
      && error.message.includes('ENOTFOUND')
      && error.message.includes('archive-api.open-meteo.com'),
  );

  await assert.rejects(
    () => fetchWeatherSnapshot({
      startTimeUtc: '2026-11-15T11:00:00.000Z',
      position: { lat: 22.5, lon: 113.9 },
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
    (error) => error instanceof WeatherFetchError && error.message.includes('503'),
  );
});

test('写回 project.json：快照落盘，且写前通过 Schema 校验', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-weather-'));
  try {
    const projectPath = path.join(dir, 'project.json');
    const project = {
      version: 1,
      targetPresets: ['douyin-portrait'],
      gridVersion: 1,
      layout: { sourcePresetId: 'douyin-portrait', components: [] },
      tcx: { path: './activity.tcx' },
    };
    writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);

    const snapshot = createWeatherSnapshot({
      query: QUERY,
      payload: PAYLOAD,
      fetchedAt: '2026-11-16T02:10:00.000Z',
    });
    const { project: loaded } = loadProject(projectPath);
    saveProject(projectPath, { ...loaded, weatherSnapshot: snapshot });

    const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
    assert.deepEqual(saved.weatherSnapshot, snapshot);
    assert.equal(saved.tcx.path, './activity.tcx', '其它字段原样保留');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('快照不符合 Schema 时拒绝落盘，原文件逐字节不变', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-weather-'));
  try {
    const projectPath = path.join(dir, 'project.json');
    const project = {
      version: 1,
      targetPresets: ['douyin-portrait'],
      gridVersion: 1,
      layout: { sourcePresetId: 'douyin-portrait', components: [] },
    };
    const original = `${JSON.stringify(project, null, 2)}\n`;
    writeFileSync(projectPath, original);

    // 缺 required 的 query / values：写进去就是坏配置，必须拒绝。
    assert.throws(
      () => saveProject(projectPath, { ...project, weatherSnapshot: { source: 'manual' } }),
      /query|values/,
    );
    assert.equal(readFileSync(projectPath, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
