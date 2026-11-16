/**
 * CLI 参数解析与预设选择规则（纯函数，不读文件、不启动进程）。
 * 参数与退出码定义见 docs/SPEC-v1.md 第 4 节。
 */

/** 参数用法错误 / 配置错误统一用这个错误类型，由 CLI 入口转成退出码 2。 */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// 退出码（SPEC-v1 第 4 节）。
/** 成功 */
export const EXIT_SUCCESS = 0;
/** 配置或校验失败 */
export const EXIT_CONFIG_ERROR = 2;
/** FFmpeg 失败 */
export const EXIT_FFMPEG_ERROR = 3;
/** 数据源缺失 */
export const EXIT_DATA_MISSING = 4;

const VALUE_FLAGS = new Map([
  ['--project', 'project'],
  ['--preset', 'preset'],
  ['--out', 'out'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--validate-only', 'validateOnly'],
  ['--dry-run', 'dryRun'],
  ['-h', 'help'],
  ['--help', 'help'],
]);

/**
 * 解析命令行参数。
 * @param {string[]} argv 不含 node 与脚本路径的参数数组
 * @returns {{ project?: string, preset?: string, out?: string,
 *             dryRun: boolean, validateOnly: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const args = { dryRun: false, validateOnly: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    const booleanKey = BOOLEAN_FLAGS.get(token);
    if (booleanKey !== undefined) {
      args[booleanKey] = true;
      continue;
    }

    const valueKey = VALUE_FLAGS.get(token);
    if (valueKey !== undefined) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${token} 需要一个取值，例如 ${token} <path>`);
      }
      args[valueKey] = value;
      i += 1;
      continue;
    }

    throw new UsageError(`未知参数 "${token}"；可用参数见 --help`);
  }

  return args;
}

/**
 * 决定本次要处理的画布预设。
 *
 * - `mode: 'validate'`（`--validate-only`）：校验全部目标预设，指定 `--preset` 时只校验该预设；
 * - `mode: 'render'`（出片 / `--dry-run`）：只能产出一个成片，多目标预设必须用 `--preset` 选定。
 *
 * @param {{ targetPresets: string[], presetId?: string, mode: 'validate' | 'render' }} options
 * @returns {string[]} 本次要校验或出片的画布预设标识
 */
export function planPresets({ targetPresets, presetId, mode }) {
  if (presetId !== undefined && !targetPresets.includes(presetId)) {
    throw new UsageError(
      `--preset "${presetId}" 不在 targetPresets 内（当前：${targetPresets.join('、')}）`,
    );
  }

  if (mode === 'render') {
    if (presetId !== undefined) {
      return [presetId];
    }
    if (targetPresets.length > 1) {
      throw new UsageError(
        `存在 ${targetPresets.length} 个目标预设，出片时必须用 --preset 指定其中一个：${targetPresets.join('、')}`,
      );
    }
    return [...targetPresets];
  }

  return presetId === undefined ? [...targetPresets] : [presetId];
}
