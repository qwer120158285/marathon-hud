/**
 * 编辑期天气取数（Node 侧）：Open-Meteo Historical Archive 的一次小时值 → 冻结快照。
 *
 * 依据 ticket #10 与 docs/SPEC-v1.md 3.2：
 * - 查询点是「活动开始时刻 + 首个有效 GPS 坐标」，按配置时区解释成当地日期与整点小时；
 * - 只取开始那一小时的值，冻结成**单份快照**（不是逐小时序列），此后渲染不再联网；
 * - 快照保留来源 URL、取数时刻、查询点与 ERA5 网格坐标，便于溯源与复现。
 *
 * 网络请求只发生在 `fetchWeatherSnapshot` 里，且 `fetchImpl` 可注入——测试不访问外网。
 */
import { DEFAULT_TIMEZONE, WEATHER_SOURCE } from '../shared/weather.js';

/** Open-Meteo 历史归档接口（ERA5 再分析）。 */
export const ARCHIVE_ENDPOINT = 'https://archive-api.open-meteo.com/v1/archive';

/** 请求的小时字段；顺序固定，URL 才可复现。 */
export const HOURLY_FIELDS = [
  'temperature_2m',
  'relative_humidity_2m',
  'precipitation',
  'weather_code',
];

/** 取数失败统一抛这个错误，由 CLI 入口转成非零退出码。 */
export class WeatherFetchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WeatherFetchError';
  }
}

/**
 * 首个有效 GPS 坐标（跳过最前面的 null）。
 *
 * 样本最前 36 个采样点没有 Position；活动开始时刻仍然来自 TCX 的首个采样点，
 * 二者不必是同一条记录。
 *
 * @param {{ lat: number|null, lon: number|null }[]} samples
 * @returns {{ lat: number, lon: number }|null}
 */
export function firstValidPosition(samples) {
  for (const sample of samples ?? []) {
    if (Number.isFinite(sample?.lat) && Number.isFinite(sample?.lon)) {
      return { lat: sample.lat, lon: sample.lon };
    }
  }
  return null;
}

/**
 * UTC 时刻 → 配置时区下的当地日期与整点。
 *
 * 用 `Intl.DateTimeFormat` 取当地年月日时（两端都有 ECMA-402，无需时区数据库）；
 * `hourCycle: 'h23'` 保证 0 点是 `00` 而不是 `24`。
 *
 * @param {string} startTimeUtc
 * @param {string} timezone
 * @returns {{ date: string, timeLocal: string }}
 */
function localHour(startTimeUtc, timezone) {
  const timeMs = Date.parse(startTimeUtc);
  if (!Number.isFinite(timeMs)) {
    throw new WeatherFetchError(`活动开始时刻无法解析：${JSON.stringify(startTimeUtc)}（需要 ISO 8601 UTC）`);
  }

  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(timeMs));
  } catch {
    throw new WeatherFetchError(`时区不是合法时区：${JSON.stringify(timezone)}（例如 Asia/Shanghai）`);
  }

  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const hour = part('hour').padStart(2, '0');
  return { date, timeLocal: `${date}T${hour}:00` };
}

/**
 * 查询坐标保留 5 位小数（约 1 m）：TCX 坐标有十几位小数，URL 与快照里只需要定位精度，
 * 收短后请求地址可读、可复现（SPEC 3.2 的样例也是 5 位）。
 */
function roundCoordinate(value) {
  return Math.round(value * 1e5) / 1e5;
}

/**
 * 组装取数查询与请求 URL。
 *
 * @param {{ startTimeUtc: string, position: { lat: number, lon: number },
 *           timezone?: string, endpoint?: string }} options
 * @returns {{ latitude: number, longitude: number, date: string, timeLocal: string,
 *             query: { latitude: number, longitude: number, timeLocal: string }, url: string }}
 */
export function buildWeatherQuery({
  startTimeUtc,
  position,
  timezone = DEFAULT_TIMEZONE,
  endpoint = ARCHIVE_ENDPOINT,
}) {
  if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lon)) {
    throw new WeatherFetchError('缺少有效 GPS 坐标：无法按经纬度取天气');
  }

  const latitude = roundCoordinate(position.lat);
  const longitude = roundCoordinate(position.lon);
  const { date, timeLocal } = localHour(startTimeUtc, timezone);
  // 逗号不转义：字段名本身安全，写成 SPEC 3.2 里那种可读的请求地址。
  const url = `${endpoint}?latitude=${latitude}&longitude=${longitude}`
    + `&start_date=${date}&end_date=${date}`
    + `&hourly=${HOURLY_FIELDS.join(',')}`
    + `&timezone=${encodeURIComponent(timezone)}`;

  return {
    latitude,
    longitude,
    date,
    timeLocal,
    query: { latitude, longitude, timeLocal },
    url,
  };
}

/** 数字字段只接受有限数字；API 的 null（缺测）不参与快照。 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 从响应里挑出活动开始那一小时的值。
 *
 * 请求带了 `timezone`，Open-Meteo 的 `hourly.time` 就是同一时区下的本地时间字符串
 * （`YYYY-MM-DDTHH:00`），因此可以按字符串精确匹配。
 *
 * @param {object} payload
 * @param {string} timeLocal
 * @returns {{ temperatureC?: number, humidityPct?: number, precipitationMm?: number, weatherCode?: number }}
 */
function pickHourlyValues(payload, timeLocal) {
  const hourly = payload?.hourly;
  const times = hourly?.time;
  if (!Array.isArray(times) || times.length === 0) {
    throw new WeatherFetchError(`天气响应缺少 hourly.time：无法定位 ${timeLocal} 的小时值`);
  }

  const index = times.indexOf(timeLocal);
  if (index === -1) {
    throw new WeatherFetchError(
      `天气响应里没有 ${timeLocal} 这一小时（可用范围 ${times[0]} – ${times[times.length - 1]}）`,
    );
  }

  const values = {};
  const temperatureC = numberOrNull(hourly.temperature_2m?.[index]);
  const humidityPct = numberOrNull(hourly.relative_humidity_2m?.[index]);
  const precipitationMm = numberOrNull(hourly.precipitation?.[index]);
  const weatherCode = numberOrNull(hourly.weather_code?.[index]);
  if (temperatureC !== null) values.temperatureC = temperatureC;
  if (humidityPct !== null) values.humidityPct = humidityPct;
  if (precipitationMm !== null) values.precipitationMm = precipitationMm;
  if (weatherCode !== null) values.weatherCode = Math.round(weatherCode);
  return values;
}

/**
 * 响应 + 查询 → 冻结快照（纯函数，可单测）。
 *
 * `grid` 取响应顶层的经纬度：那是模式网格中心（ERA5 网格吸附后的坐标），
 * 与查询点不同；响应没给就留 null，不拿查询点冒充。
 *
 * @param {{ query: ReturnType<typeof buildWeatherQuery>, payload: object, fetchedAt: string }} input
 */
export function createWeatherSnapshot({ query, payload, fetchedAt }) {
  const gridLatitude = numberOrNull(payload?.latitude);
  const gridLongitude = numberOrNull(payload?.longitude);

  return {
    source: WEATHER_SOURCE,
    requestUrl: query.url,
    query: { ...query.query },
    grid: gridLatitude === null || gridLongitude === null
      ? null
      : { latitude: gridLatitude, longitude: gridLongitude },
    fetchedAt,
    values: pickHourlyValues(payload, query.timeLocal),
  };
}

/**
 * 取一次天气快照。
 *
 * `fetchImpl` 与 `now` 可注入：测试用假 fetch 覆盖成功 / 失败路径，线上用全局 fetch。
 *
 * @param {{ startTimeUtc: string, position: { lat: number, lon: number }, timezone?: string,
 *           endpoint?: string, fetchImpl?: typeof fetch, now?: () => Date }} options
 */
export async function fetchWeatherSnapshot({
  startTimeUtc,
  position,
  timezone = DEFAULT_TIMEZONE,
  endpoint = ARCHIVE_ENDPOINT,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const query = buildWeatherQuery({ startTimeUtc, position, timezone, endpoint });

  let response;
  try {
    response = await fetchImpl(query.url);
  } catch (error) {
    throw new WeatherFetchError(`天气请求失败：${query.url}（${error.message}）`);
  }

  if (!response.ok) {
    throw new WeatherFetchError(`天气请求失败：${query.url}（HTTP ${response.status}）`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new WeatherFetchError(`天气响应不是合法 JSON：${query.url}（${error.message}）`);
  }

  return createWeatherSnapshot({ query, payload, fetchedAt: now().toISOString() });
}
