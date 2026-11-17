/**
 * 天气快照（ticket #10）：共享纯函数、静态绘制与「渲染期零网络」。
 *
 * 期望值来自独立事实源：docs/SPEC-v1.md 3.2 的天气快照样例（22 °C / 89% / 0.1 mm / code 51）、
 * WMO 4677 天气码语义（51 = drizzle，65 = heavy rain，95 = thunderstorm）、
 * 2026-11-15T11:00Z 在 Asia/Shanghai 是 19:00、在 UTC 是 11:00。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_TIMEZONE,
  describeWeatherCode,
  formatWallClock,
  mergeWeatherValues,
  weatherPhrase,
} from '../shared/weather.js';
import { createCanvas, registerFonts } from '../cli/adapter.mjs';
import { drawFrame, prepareStatic } from '../shared/hud.js';
import { resolveComponentRect } from '../shared/layout.js';
import { resolvePreset } from '../shared/presets.js';

await registerFonts();

const sample = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'));

const PRESET = resolvePreset('douyin-portrait');
const weatherComponent = sample.layout.components.find((component) => component.id === 'weather');
const fullMetrics = sample.samples.find((entry) => entry.id === 'full').metrics;

/** 在给定预设上预绘静态层；默认把示意数据里的快照、时区与活动开始时刻都传进去。 */
function prepare({
  preset = PRESET,
  component = weatherComponent,
  components,
  weatherSnapshot = sample.weatherSnapshot,
  timezone = sample.timezone,
  activity = sample.activity,
} = {}) {
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  const layer = prepareStatic(ctx, {
    preset,
    components: components ?? [component],
    metrics: fullMetrics,
    activity,
    weatherSnapshot,
    timezone,
  });
  return layer;
}

const planOf = (layer, componentId) => layer.plan.find((item) => item.componentId === componentId);
const textsOf = (item) => item.staticTexts.map((text) => text.text);

/** 只记录落笔的假上下文：用来证明 drawFrame 对天气卡片一笔都不画。 */
function recordingContext() {
  const calls = { clearRect: 0, drawImage: 0, fillText: 0, stroke: 0, fill: 0 };
  const ctx = {
    calls,
    canvas: { width: PRESET.width, height: PRESET.height },
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect() { calls.clearRect += 1; },
    drawImage() { calls.drawImage += 1; },
    fillText() { calls.fillText += 1; },
    stroke() { calls.stroke += 1; },
    fill() { calls.fill += 1; },
    save() {},
    restore() {},
    measureText() {
      throw new Error('drawFrame 不应测量文字：天气卡片全部在静态层预绘');
    },
  };
  return ctx;
}


/** SPEC 3.2 的样例快照（数值与取数时刻为示意，结构是契约）。 */
const SPEC_SNAPSHOT = {
  source: 'open-meteo-historical-archive',
  requestUrl: 'https://archive-api.open-meteo.com/v1/archive?latitude=22.99092&longitude=115.32902',
  query: { latitude: 22.99092, longitude: 115.32902, timeLocal: '2026-11-15T19:00' },
  grid: { latitude: 22.9525, longitude: 115.3653 },
  fetchedAt: '2026-11-16T02:10:00.000Z',
  values: { temperatureC: 22, humidityPct: 89, precipitationMm: 0.1, weatherCode: 51 },
};

test('默认时区是 Asia/Shanghai（配置缺省时的解释口径）', () => {
  assert.equal(DEFAULT_TIMEZONE, 'Asia/Shanghai');
});

// 英文短语不是偏好问题：Inter 没有汉字字形，中文会落到系统字体上，基准图跨机器不可复现
// （ADR 0001「字体文件随项目打包，不依赖操作系统字体」）。
test('WMO 天气码给英文短语：CLEAR / PARTLY CLOUDY / OVERCAST / FOG / DRIZZLE / RAIN / SNOW / SHOWERS / THUNDER', () => {
  assert.equal(describeWeatherCode(0), 'CLEAR');
  assert.equal(describeWeatherCode(2), 'PARTLY CLOUDY');
  assert.equal(describeWeatherCode(3), 'OVERCAST');
  assert.equal(describeWeatherCode(45), 'FOG');
  assert.equal(describeWeatherCode(51), 'DRIZZLE');
  assert.equal(describeWeatherCode(63), 'RAIN');
  assert.equal(describeWeatherCode(65), 'HEAVY RAIN');
  assert.equal(describeWeatherCode(71), 'SNOW');
  assert.equal(describeWeatherCode(80), 'SHOWERS');
  assert.equal(describeWeatherCode(95), 'THUNDER');
});

test('未知天气码不编造描述：describeWeatherCode 返回 null，weatherPhrase 退回原始码', () => {
  assert.equal(describeWeatherCode(999), null);
  assert.equal(describeWeatherCode(undefined), null);
  assert.equal(describeWeatherCode(null), null);

  // 卡片上显示 `WX <code>`：未知码是「没收录」而不是「没有数据」。
  assert.equal(weatherPhrase(999), 'WX 999');
  assert.equal(weatherPhrase(47), 'WX 47');
  assert.equal(weatherPhrase(51), 'DRIZZLE');
  // 非整数才是真正的缺值，一律不画。
  assert.equal(weatherPhrase(undefined), null);
  assert.equal(weatherPhrase(null), null);
  assert.equal(weatherPhrase('51'), null);
});

test('快照数值原样取出；没有手工覆盖时 overridden 为空', () => {
  const merged = mergeWeatherValues(SPEC_SNAPSHOT);

  assert.deepEqual(merged.values, { temperatureC: 22, humidityPct: 89, precipitationMm: 0.1, weatherCode: 51 });
  assert.deepEqual(merged.overridden, []);
});

test('手工覆盖值优先于快照数值，且记录被覆盖的字段', () => {
  const merged = mergeWeatherValues({
    ...SPEC_SNAPSHOT,
    manualOverride: { temperatureC: 18, weatherCode: 61 },
  });

  assert.equal(merged.values.temperatureC, 18);
  assert.equal(merged.values.weatherCode, 61);
  // 没被覆盖的字段仍取快照。
  assert.equal(merged.values.humidityPct, 89);
  assert.deepEqual(merged.overridden, ['temperatureC', 'weatherCode']);
});

test('手工覆盖只认数值字段：未知键与非数值一律忽略，不覆盖来源字段', () => {
  const merged = mergeWeatherValues({
    ...SPEC_SNAPSHOT,
    manualOverride: {
      temperatureC: 18,
      requestUrl: 'https://example.com/forged',
      grid: { latitude: 0, longitude: 0 },
      fetchedAt: '2000-01-01T00:00:00.000Z',
      weatherCode: '51',
      humidityPct: Number.NaN,
    },
  });

  assert.deepEqual(Object.keys(merged.values).sort(), [
    'humidityPct', 'precipitationMm', 'temperatureC', 'weatherCode',
  ]);
  assert.equal(merged.values.temperatureC, 18);
  // 字符串 / NaN 不是数值，不参与覆盖。
  assert.equal(merged.values.humidityPct, 89);
  assert.equal(merged.values.weatherCode, 51);
  assert.deepEqual(merged.overridden, ['temperatureC']);
  // 合并是纯函数：不改写传进来的快照（溯源字段仍然原样）。
  assert.equal(SPEC_SNAPSHOT.values.temperatureC, 22);
  assert.equal(SPEC_SNAPSHOT.values.weatherCode, 51);
});

test('缺快照或快照里一个数值都没有时返回 null（不画假值）', () => {
  assert.equal(mergeWeatherValues(undefined), null);
  assert.equal(mergeWeatherValues({}), null);
  assert.equal(mergeWeatherValues({ values: {} }), null);
  assert.equal(mergeWeatherValues({ values: { temperatureC: null } }), null);
});

test('墙钟按配置时区显示活动开始时刻：同一 UTC 时刻在上海是 19:00、在 UTC 是 11:00', () => {
  const startTimeUtc = '2026-11-15T11:00:00.000Z';

  assert.equal(formatWallClock(startTimeUtc, 'Asia/Shanghai'), '19:00');
  assert.equal(formatWallClock(startTimeUtc, 'UTC'), '11:00');
  assert.equal(formatWallClock(startTimeUtc), '19:00');
});

test('缺开始时刻返回 null；时区非法时报错并点名时区', () => {
  assert.equal(formatWallClock(undefined, 'Asia/Shanghai'), null);
  assert.equal(formatWallClock('not-a-date', 'Asia/Shanghai'), null);
  assert.throws(
    () => formatWallClock('2026-11-15T11:00:00.000Z', 'Mars/Olympus'),
    /时区/,
  );
});

test('示意数据里 weather 组件已有快照、时区与活动开始时刻（基准图的前提）', () => {
  assert.equal(sample.timezone, 'Asia/Shanghai');
  assert.equal(sample.activity.startTimeUtc, '2026-11-15T11:00:00.000Z');
  assert.equal(sample.weatherSnapshot.values.weatherCode, 51);
  assert.equal(describeWeatherCode(sample.weatherSnapshot.values.weatherCode), 'DRIZZLE');
});

// ---------------------------------------------------------------------------
// 静态覆盖：天气卡整体进静态层（ticket #10 第 4、5 条）
// ---------------------------------------------------------------------------

test('weather 进绘制计划：底板 + 标签 + 墙钟 + 温度 + 天气短语 + 湿度降水，动态层为空', () => {
  const layer = prepare();
  const item = planOf(layer, 'weather');

  assert.ok(item !== undefined, 'weather 组件应当出现在 plan[] 里');
  assert.deepEqual(item.rect, resolveComponentRect(weatherComponent, PRESET));
  assert.equal(item.panel.height > 0, true);
  assert.deepEqual(item.dynamic, [], '天气与墙钟整场不变，不应有逐帧内容');
  assert.deepEqual(textsOf(item), ['WEATHER', '19:00', '22', '°C', 'DRIZZLE', '89% · 0.1 MM']);
  assert.deepEqual(item.weather.values, {
    temperatureC: 22, humidityPct: 89, precipitationMm: 0.1, weatherCode: 51,
  });
  assert.equal(item.weather.phrase, 'DRIZZLE');
  assert.equal(item.weather.wallClock, '19:00');
});

test('手工覆盖优先：覆盖 18 °C 后画面写 18°C，不再出现快照的 22°C', () => {
  const layer = prepare({
    weatherSnapshot: { ...sample.weatherSnapshot, manualOverride: { temperatureC: 18 } },
  });
  const item = planOf(layer, 'weather');

  assert.deepEqual(textsOf(item), ['WEATHER', '19:00', '18', '°C', 'DRIZZLE', '89% · 0.1 MM']);
  assert.equal(item.weather.values.temperatureC, 18);
  assert.deepEqual(item.weather.overridden, ['temperatureC']);
});

test('未知天气码显示原始码 WX 999，不编造描述，也不落任何汉字', () => {
  const layer = prepare({
    weatherSnapshot: {
      ...sample.weatherSnapshot,
      values: { ...sample.weatherSnapshot.values, weatherCode: 999 },
    },
  });
  const item = planOf(layer, 'weather');

  assert.equal(item.weather.phrase, 'WX 999');
  assert.equal(textsOf(item).includes('WX 999'), true);
  // 卡片上不允许出现汉字：Inter 没有汉字字形，落到系统字体会让基准图跨机器不可复现。
  assert.equal(textsOf(item).some((text) => /[\u4e00-\u9fa5]/.test(text)), false);
  // 所有文字一律用随项目打包的 Inter。
  for (const text of item.staticTexts) assert.match(text.font, /px Inter$/);
});

test('只有温度时不画假湿度与假降水：缺哪个字段就少哪一段', () => {
  const layer = prepare({
    weatherSnapshot: { ...sample.weatherSnapshot, values: { temperatureC: 20 } },
  });
  const texts = textsOf(planOf(layer, 'weather'));

  assert.deepEqual(texts, ['WEATHER', '19:00', '20', '°C']);
  assert.equal(texts.some((text) => text.includes('%') || text.includes('MM')), false);
});

test('墙钟按配置时区换算：同一份快照，UTC 时区显示 11:00', () => {
  const texts = textsOf(planOf(prepare({ timezone: 'UTC' }), 'weather'));

  assert.equal(texts.includes('11:00'), true);
  assert.equal(texts.includes('19:00'), false);
});

test('组件不可见或缺快照时不绘制天气（不画 0、不画占位、不留空卡片）', () => {
  const hidden = prepare({ component: { ...weatherComponent, visible: false } });
  assert.equal(planOf(hidden, 'weather'), undefined);

  const noSnapshot = prepare({ weatherSnapshot: null });
  assert.equal(planOf(noSnapshot, 'weather'), undefined);

  const emptyValues = prepare({ weatherSnapshot: { ...sample.weatherSnapshot, values: {} } });
  assert.equal(planOf(emptyValues, 'weather'), undefined);
});

test('静态层证据：drawFrame 对天气只合成一次静态层，不写文字、不描路径、不测文字', () => {
  const layer = prepare();
  const ctx = recordingContext();

  drawFrame(ctx, { preset: PRESET, metrics: fullMetrics, static: layer });

  assert.equal(ctx.calls.drawImage, 1, '每帧只合成一次静态层');
  assert.equal(ctx.calls.fillText, 0, '天气文字已在静态层，drawFrame 不应再写');
  assert.equal(ctx.calls.stroke, 0, 'drawFrame 不应描任何路径');
  assert.equal(ctx.calls.fill, 0);
});

test('同一份快照反复出片：两次预绘的天气文字与数值完全一致', () => {
  const first = planOf(prepare(), 'weather');
  const second = planOf(prepare(), 'weather');

  assert.deepEqual(second.staticTexts, first.staticTexts);
  assert.deepEqual(second.weather.values, first.weather.values);
});

test('渲染期零网络：全局 fetch 抛错时静态预绘与每帧绘制照常完成', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('断网：渲染期不应发起任何网络请求');
  };
  try {
    const layer = prepare();
    assert.deepEqual(textsOf(planOf(layer, 'weather')), ['WEATHER', '19:00', '22', '°C', 'DRIZZLE', '89% · 0.1 MM']);

    const ctx = recordingContext();
    drawFrame(ctx, { preset: PRESET, metrics: fullMetrics, static: layer });
    assert.equal(ctx.calls.fillText, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('手填快照（没有 requestUrl / grid / fetchedAt）同样能出片：渲染只读 values', () => {
  const layer = prepare({
    weatherSnapshot: {
      source: 'manual',
      query: { latitude: 22.99, longitude: 115.33, timeLocal: '2026-11-15T19:00' },
      values: { temperatureC: 30.4, humidityPct: 60, precipitationMm: 0, weatherCode: 0 },
    },
  });

  assert.deepEqual(textsOf(planOf(layer, 'weather')), ['WEATHER', '19:00', '30', '°C', 'CLEAR', '60% · 0.0 MM']);
});
