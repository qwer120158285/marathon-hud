/**
 * 天气快照的共享纯函数（零 DOM、零网络、零 Node 专有 API）。
 *
 * 依据 GLOSSARY「天气快照」与「静态覆盖」：快照在编辑期一次性取得并冻结，
 * 使用者的手工覆盖值优先于快照数值；渲染期只读配置，不发起任何请求。
 * 依据 ADR 0005「探测值与使用者配置分开」：覆盖值与快照数值分字段存放（`manualOverride`），
 * 覆盖只允许改数值，不允许改 `requestUrl` / `grid` / `fetchedAt` / `query`。
 */

/** 配置未写 `timezone` 时的解释时区（docs/SPEC-v1.md）。 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 快照来源标识（写进 `weatherSnapshot.source`）。 */
export const WEATHER_SOURCE = 'open-meteo-historical-archive';

/** 可被数值覆盖的字段；顺序即报告与测试里的稳定顺序。 */
export const WEATHER_VALUE_KEYS = ['temperatureC', 'humidityPct', 'precipitationMm', 'weatherCode'];

/**
 * WMO 4677 天气码 → 英文短语。
 *
 * 为什么是英文而不是中文：卡片上只允许出现随项目打包的 Inter 字体（ADR 0001「字体文件随项目
 * 打包，不依赖操作系统字体」）。Inter 没有汉字字形，中文短语必然落到本机系统字体上，
 * 换一台机器会静默回退、字宽变化（实测「晴」40 px 下 40.00 → 34.60），基准图不再可复现。
 * 英文短语与 HUD 其余标签（PACE / HR / CAD / DISTANCE / BPM / SPM）用同一套字体与写法。
 *
 * 只收录 Open-Meteo 常用取值；同组码用同一短语（毛毛雨 51/53/55、雨 61/63/65 按强度区分）。
 */
const WMO_PHRASES = new Map([
  [0, 'CLEAR'],
  [1, 'MOSTLY CLEAR'],
  [2, 'PARTLY CLOUDY'],
  [3, 'OVERCAST'],
  [45, 'FOG'],
  [48, 'RIME FOG'],
  [51, 'DRIZZLE'],
  [53, 'DRIZZLE'],
  [55, 'DRIZZLE'],
  [56, 'FREEZING DRIZZLE'],
  [57, 'FREEZING DRIZZLE'],
  [61, 'RAIN'],
  [63, 'RAIN'],
  [65, 'HEAVY RAIN'],
  [66, 'FREEZING RAIN'],
  [67, 'FREEZING RAIN'],
  [71, 'SNOW'],
  [73, 'SNOW'],
  [75, 'HEAVY SNOW'],
  [77, 'SNOW GRAINS'],
  [80, 'SHOWERS'],
  [81, 'SHOWERS'],
  [82, 'HEAVY SHOWERS'],
  [85, 'SNOW SHOWERS'],
  [86, 'SNOW SHOWERS'],
  [95, 'THUNDER'],
  [96, 'THUNDER HAIL'],
  [99, 'THUNDER HAIL'],
]);

/**
 * 天气码 → 已知码的英文短语。
 *
 * 未收录的码不猜描述：返回 null，调用方自己决定是省略还是显示原始码（见 `weatherPhrase`）。
 *
 * @param {unknown} code
 * @returns {string|null} 未收录或不是整数时返回 null
 */
export function describeWeatherCode(code) {
  if (!Number.isInteger(code)) return null;
  return WMO_PHRASES.get(code) ?? null;
}

/**
 * 卡片上实际显示的天气短语：已知码给英文短语，未知整数码给 `WX <code>`。
 *
 * 显示原始码而不是省略：未知码是「我们没收录」而不是「没有数据」，
 * 留着 `WX 47` 至少能让人回查 WMO 表；只有非整数（真正没有值）才返回 null。
 *
 * @param {unknown} code
 * @returns {string|null}
 */
export function weatherPhrase(code) {
  const phrase = describeWeatherCode(code);
  if (phrase !== null) return phrase;
  return Number.isInteger(code) ? `WX ${code}` : null;
}

/** 数值字段：必须是有限数字；天气码额外要求整数。 */
function isUsableValue(key, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return key === 'weatherCode' ? Number.isInteger(value) : true;
}

/**
 * 合并快照数值与手工覆盖值（`manualOverride` 优先）。
 *
 * 覆盖只遍历 `WEATHER_VALUE_KEYS`：其它键（例如 `requestUrl` / `grid` / `fetchedAt`）
 * 根本不会被读，因此「用覆盖值伪造来源」在接口上写不出来。
 * 非数值（字符串、NaN、null）不算覆盖，回落到快照值。
 *
 * @param {object|undefined} snapshot project.json 的 `weatherSnapshot`
 * @returns {{ values: object, overridden: string[] }|null} 没有任何可用数值时返回 null
 */
export function mergeWeatherValues(snapshot) {
  const base = snapshot?.values ?? {};
  const overrides = snapshot?.manualOverride ?? {};
  const values = {};
  const overridden = [];

  for (const key of WEATHER_VALUE_KEYS) {
    if (isUsableValue(key, overrides[key])) {
      values[key] = overrides[key];
      overridden.push(key);
      continue;
    }
    if (isUsableValue(key, base[key])) values[key] = base[key];
  }

  // 一个数值都没有就当作没有快照：调用方据此整块不画，不留空卡片。
  if (Object.keys(values).length === 0) return null;
  return { values, overridden };
}

/**
 * 墙钟（GLOSSARY）：把活动的 UTC 开始时刻换算成配置时区下的本地时间。
 *
 * 用 `Intl.DateTimeFormat` 而不是自己算时区偏移：两端（浏览器 / Node）都有 ECMA-402，
 * 且不需要打包时区数据。`hour12: false` + `en-GB` 保证得到 `HH:MM` 而不是 AM/PM。
 *
 * @param {string|undefined} startTimeUtc 活动开始时刻（ISO 8601，UTC）
 * @param {string} [timezone] 配置时区
 * @returns {string|null} `HH:MM`；开始时刻缺失或不可解析时返回 null
 */
export function formatWallClock(startTimeUtc, timezone = DEFAULT_TIMEZONE) {
  if (typeof startTimeUtc !== 'string') return null;
  const timeMs = Date.parse(startTimeUtc);
  if (!Number.isFinite(timeMs)) return null;

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    throw new Error(`timezone 不是合法时区：${JSON.stringify(timezone)}（例如 Asia/Shanghai）`);
  }

  return formatter.format(new Date(timeMs));
}
