#!/usr/bin/env node
/**
 * 编辑期天气取数入口（ticket #10）：
 * `node cli/weather.mjs --project <path/to/project.json>`
 *
 * 读活动开始时刻与首个有效 GPS → 向 Open-Meteo Historical Archive 取一次小时值 →
 * 冻结成 `weatherSnapshot` 写回 project.json。渲染器从不联网；这个命令是唯一的取数点，
 * 因此它是可选的：手填快照同样能出片。
 *
 * 退出码沿用 SPEC-v1 第 4 节：0 成功；2 配置 / 校验 / 取数失败；4 数据源缺失。
 * 取数失败时原配置文件保持不变（写前校验 + 临时文件原子替换，见 cli/project.mjs 的 saveProject）。
 */
import {
  EXIT_CONFIG_ERROR,
  EXIT_DATA_MISSING,
  EXIT_SUCCESS,
} from './args.mjs';
import { loadProject, saveProject, ProjectConfigError } from './project.mjs';
import { DataSourceError, loadDataSource } from './data.mjs';
import {
  ARCHIVE_ENDPOINT,
  WeatherFetchError,
  fetchWeatherSnapshot,
  firstValidPosition,
} from '../data/weather.mjs';
import { DEFAULT_TIMEZONE, describeWeatherCode } from '../shared/weather.js';

const USAGE = `用法：node cli/weather.mjs --project <path/to/project.json> [options]

  --project <path>   必填，project.json 路径；快照会写回这份文件
  --endpoint <url>   覆盖 Open-Meteo 历史归档地址（默认 ${ARCHIVE_ENDPOINT}）
  -h, --help         显示本帮助

取数口径：活动开始时刻 + 首个有效 GPS 坐标，按 project.json 的 timezone 解释成当地整点，
只取那一小时的温度、相对湿度、降水与 WMO 天气码，冻结成单份快照（不是逐小时序列）。
渲染期零网络：不跑本命令也能出片，手填 weatherSnapshot 同样有效。

退出码：0 成功；2 配置 / 校验 / 取数失败；4 数据源缺失。`;

/** 极简参数解析：本命令只有两个取值参数，不引入 cli/args.mjs 的渲染参数表。 */
function parseWeatherArgs(argv) {
  const args = { help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token !== '--project' && token !== '--endpoint') {
      throw new WeatherFetchError(`未知参数 "${token}"；可用参数见 --help`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new WeatherFetchError(`${token} 需要一个取值，例如 ${token} <path>`);
    }
    args[token === '--project' ? 'project' : 'endpoint'] = value;
    i += 1;
  }

  return args;
}

/** 整数不带小数点，小数最多三位；报告里只做展示，不参与逻辑。 */
function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/** 写入结果报告：每个字段都能对回快照，方便手改与复核。 */
function formatReport({ projectPath, project, snapshot }) {
  const { query, grid, values } = snapshot;
  const timezone = project.timezone ?? DEFAULT_TIMEZONE;
  const phrase = describeWeatherCode(values.weatherCode);
  const lines = [
    `已写入天气快照：${projectPath}`,
    `  来源          ${snapshot.source}`,
    `  查询点        ${formatNumber(query.latitude)}, ${formatNumber(query.longitude)}`
      + `（当地 ${query.timeLocal}，${timezone}）`,
    `  网格坐标      ${grid === null ? '（响应未提供）' : `${formatNumber(grid.latitude)}, ${formatNumber(grid.longitude)}`}`,
    `  取数时刻      ${snapshot.fetchedAt}`,
  ];

  if (values.temperatureC !== undefined) lines.push(`  温度          ${formatNumber(values.temperatureC)} °C`);
  if (values.humidityPct !== undefined) lines.push(`  相对湿度      ${formatNumber(values.humidityPct)} %`);
  if (values.precipitationMm !== undefined) lines.push(`  降水量        ${formatNumber(values.precipitationMm)} mm`);
  if (values.weatherCode !== undefined) {
    lines.push(`  天气码        ${values.weatherCode}${phrase === null ? '' : `（${phrase}）`}`);
  }
  lines.push(`  请求地址      ${snapshot.requestUrl}`);
  return lines.join('\n');
}

/**
 * 主流程。
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
async function main(argv) {
  let args;
  try {
    args = parseWeatherArgs(argv);
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`);
    return EXIT_CONFIG_ERROR;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_SUCCESS;
  }

  if (args.project === undefined) {
    process.stderr.write(`错误：--project 是必填参数\n\n${USAGE}\n`);
    return EXIT_CONFIG_ERROR;
  }

  let loaded;
  try {
    loaded = loadProject(args.project);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  const { project, path: projectPath, dir: projectDir } = loaded;

  let data;
  try {
    data = loadDataSource(project, projectDir);
  } catch (error) {
    if (error instanceof DataSourceError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_DATA_MISSING;
    }
    throw error;
  }

  const position = firstValidPosition(data.activity.samples);
  if (position === null) {
    process.stderr.write(
      `错误：数据源 ${data.filePath} 里没有任何有效 GPS 坐标，无法按经纬度取天气\n`,
    );
    return EXIT_CONFIG_ERROR;
  }

  let snapshot;
  try {
    snapshot = await fetchWeatherSnapshot({
      startTimeUtc: data.activity.startTimeUtc,
      position,
      timezone: project.timezone ?? DEFAULT_TIMEZONE,
      ...(args.endpoint === undefined ? {} : { endpoint: args.endpoint }),
    });
  } catch (error) {
    if (error instanceof WeatherFetchError) {
      process.stderr.write(`错误：${error.message}\n`);
      process.stderr.write(`未改动 ${projectPath}（取数失败不写配置）\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  // 重新取数不能把手工覆盖丢掉：覆盖值是使用者的配置，快照只是探测值（ADR 0005）。
  const manualOverride = project.weatherSnapshot?.manualOverride;
  const nextSnapshot = manualOverride === undefined ? snapshot : { ...snapshot, manualOverride };

  try {
    saveProject(projectPath, { ...project, weatherSnapshot: nextSnapshot });
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  process.stdout.write(`${formatReport({ projectPath, project, snapshot })}\n`);
  return EXIT_SUCCESS;
}

process.exitCode = await main(process.argv.slice(2));
