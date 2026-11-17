/**
 * 编辑期取数 CLI（ticket #10）：`node cli/weather.mjs --project <path>` 的进程边界。
 *
 * 成功路径用本地 HTTP 服务充当 Open-Meteo（不访问外网）；失败路径断言退出码、
 * 错误文本，以及「取数失败不写坏配置」——原文件逐字节不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeTempProject } from './helpers/cli.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = path.join(REPO_ROOT, 'cli/weather.mjs');
const TCX_PATH = path.join(REPO_ROOT, 'activity_662602587.tcx');

/** Open-Meteo Archive 的响应形状；时间落在真实样本的活动开始那一小时。 */
const PAYLOAD = {
  latitude: 22.9525,
  longitude: 115.3653,
  hourly: {
    time: ['2026-11-15T19:00', '2026-11-15T20:00'],
    temperature_2m: [22.0, 21.6],
    relative_humidity_2m: [89, 90],
    precipitation: [0.1, 0],
    weather_code: [51, 3],
  },
};

function runWeatherCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * 异步版：成功路径要用「同进程里的本地 HTTP 服务」当 Open-Meteo，
 * `spawnSync` 会阻塞事件循环，服务根本没法应答子进程的请求，所以这里不能同步等待。
 */
function runWeatherCliAsync(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : error.code, stdout, stderr }));
  });
}

/** 一个指向仓库真实样本、位于临时目录的工程配置。 */
function projectFixture(overrides = {}) {
  return {
    version: 1,
    targetPresets: ['douyin-portrait'],
    gridVersion: 1,
    layout: { sourcePresetId: 'douyin-portrait', components: [] },
    tcx: { path: TCX_PATH },
    timezone: 'Asia/Shanghai',
    ...overrides,
  };
}

/** 起一个返回固定响应的本地服务，返回端口与关闭函数。 */
async function startFakeArchive() {
  const server = createServer((request, response) => {
    if (!request.url.startsWith('/v1/archive?')) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(PAYLOAD));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    endpoint: `http://127.0.0.1:${server.address().port}/v1/archive`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('--help 打印用法并成功退出', () => {
  const result = runWeatherCli(['--help']);

  assert.equal(result.code, 0);
  assert.match(result.stdout, /--project/);
  assert.match(result.stdout, /渲染期零网络/);
});

test('缺 --project 与未知参数都退出码 2', () => {
  const missing = runWeatherCli([]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /--project 是必填参数/);

  const unknown = runWeatherCli(['--preset', 'x']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /未知参数/);
});

test('project.json 不存在时退出码 2；tcx 未配置时退出码 4', () => {
  const missing = runWeatherCli(['--project', path.join(REPO_ROOT, 'no-such-project.json')]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /无法读取 project.json/);

  const noTcx = writeTempProject({
    version: 1,
    targetPresets: ['douyin-portrait'],
    gridVersion: 1,
    layout: { sourcePresetId: 'douyin-portrait', components: [] },
  });
  const result = runWeatherCli(['--project', noTcx]);
  assert.equal(result.code, 4);
  assert.match(result.stderr, /tcx\.path/);
});

test('成功路径：按活动开始时刻与首个有效 GPS 取一次小时值，快照写回 project.json', async () => {
  const archive = await startFakeArchive();
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-weather-cli-'));
  try {
    const projectPath = path.join(dir, 'project.json');
    writeFileSync(projectPath, `${JSON.stringify(projectFixture(), null, 2)}\n`);

    const result = await runWeatherCliAsync(['--project', projectPath, '--endpoint', archive.endpoint]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /已写入天气快照/);
    assert.match(result.stdout, /毛毛雨/);

    const saved = JSON.parse(readFileSync(projectPath, 'utf8'));
    const snapshot = saved.weatherSnapshot;
    assert.equal(snapshot.source, 'open-meteo-historical-archive');
    assert.equal(snapshot.requestUrl.startsWith(`${archive.endpoint}?`), true);
    // 真实样本：开始 2026-11-15T11:44:02Z → 上海 19:44 → 取 19:00 那一小时；
    // 首个有效 GPS 是 22.99092 / 115.32902（前 36 个采样点无坐标）。
    assert.deepEqual(snapshot.query, { latitude: 22.99092, longitude: 115.32902, timeLocal: '2026-11-15T19:00' });
    assert.deepEqual(snapshot.grid, { latitude: 22.9525, longitude: 115.3653 });
    assert.deepEqual(snapshot.values, { temperatureC: 22, humidityPct: 89, precipitationMm: 0.1, weatherCode: 51 });
    assert.match(snapshot.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
    // 其它字段原样保留。
    assert.deepEqual(saved.tcx, { path: TCX_PATH });
  } finally {
    await archive.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('取数失败：退出码 2、点名请求失败，且 project.json 逐字节不变', async () => {
  // 先占一个端口再关掉，保证连接被拒绝而不是超时。
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const dir = mkdtempSync(path.join(tmpdir(), 'hud-weather-cli-'));
  try {
    const projectPath = path.join(dir, 'project.json');
    const original = `${JSON.stringify(projectFixture(), null, 2)}\n`;
    writeFileSync(projectPath, original);

    const result = await runWeatherCliAsync([
      '--project', projectPath,
      '--endpoint', `http://127.0.0.1:${deadPort}/v1/archive`,
    ]);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /天气请求失败/);
    assert.match(result.stderr, /未改动/);
    assert.equal(readFileSync(projectPath, 'utf8'), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('手工覆盖只允许数值：写 requestUrl 进 manualOverride 会被 Schema 拒绝（退出码 2）', () => {
  const project = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/fixtures/project.valid.json'), 'utf8'));
  project.weatherSnapshot.manualOverride = { requestUrl: 'https://example.com/forged' };
  const projectPath = writeTempProject(project);

  const result = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'cli/render.mjs'), '--project', projectPath, '--validate-only'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /weatherSnapshot\.manualOverride\.requestUrl 是未知字段/);
});

test('重新取数保留手工覆盖值（覆盖优先于新快照，不被写丢）', async () => {
  const archive = await startFakeArchive();
  const dir = mkdtempSync(path.join(tmpdir(), 'hud-weather-cli-'));
  try {
    const projectPath = path.join(dir, 'project.json');
    const project = projectFixture({
      // 手填的旧快照：数值会被新快照替换，覆盖值必须原样保留。
      weatherSnapshot: {
        source: 'manual',
        query: { latitude: 22.99, longitude: 115.33, timeLocal: '2026-11-15T19:00' },
        values: { temperatureC: 30, weatherCode: 0 },
        manualOverride: { temperatureC: 18 },
      },
    });
    writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);

    const result = await runWeatherCliAsync(['--project', projectPath, '--endpoint', archive.endpoint]);
    assert.equal(result.code, 0, result.stderr);

    const saved = JSON.parse(readFileSync(projectPath, 'utf8')).weatherSnapshot;
    assert.deepEqual(saved.manualOverride, { temperatureC: 18 });
    assert.equal(saved.values.temperatureC, 22, '快照数值来自新取数');
  } finally {
    await archive.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
