#!/usr/bin/env node
/**
 * CLI 入口：加载 project.json、联合预设校验、出片。
 * 参数与退出码定义见 docs/SPEC-v1.md 第 4 节。
 */
import {
  parseArgs,
  planPresets,
  UsageError,
  EXIT_SUCCESS,
  EXIT_CONFIG_ERROR,
} from './args.mjs';
import { loadProject, loadSchema, validateProject } from './project.mjs';
import { resolvePreset } from '../shared/presets.js';

const USAGE = `用法：node cli/render.mjs --project <path/to/project.json> [options]

  --project <path>   必填，project.json 路径
  --preset <id>      本次出片预设，必须在 targetPresets 内；存在多个目标预设时必须指定
  --validate-only    只做预设校验并打印报告，不加载媒体、不启动 FFmpeg
  --dry-run          执行到导出前全量校验为止，不启动 FFmpeg（本版本未实现）
  --out <path>       覆盖 output.path（本版本未实现）
  -h, --help         显示本帮助

退出码：0 成功；2 配置或校验失败；3 FFmpeg 失败；4 数据源缺失。`;

/** 数字转报告文本：整数不带小数点，小数最多三位。 */
function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/** 单个画布预设一段报告：画布尺寸、安全边距、格边长、网格规模、可放置格位范围。 */
function formatPresetReport(preset) {
  const { placeable, grid } = preset;
  const placeableCols = placeable.colEnd - placeable.colStart + 1;
  const placeableRows = placeable.rowEnd - placeable.rowStart + 1;
  const title = preset.displayName === undefined
    ? `画布预设 ${preset.id}`
    : `画布预设 ${preset.id}（${preset.displayName}）`;

  return [
    title,
    `  画布尺寸      ${formatNumber(preset.width)} × ${formatNumber(preset.height)}`,
    `  安全边距      左右 ${formatNumber(preset.safeInset.left)} px，`
      + `顶部 ${formatNumber(preset.safeInset.top)} px，底部 ${formatNumber(preset.safeInset.bottom)} px`,
    `  格边长        ${formatNumber(preset.cellSize)} px`,
    `  网格规模      ${grid.cols} 列 × ${grid.rows} 行`,
    `  可放置格位    列 ${placeable.colStart}–${placeable.colEnd}，行 ${placeable.rowStart}–${placeable.rowEnd}`
      + `（${placeableCols} 列 × ${placeableRows} 行）`,
  ].join('\n');
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
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
    process.stderr.write(`错误：${error.message}\n`);
    return EXIT_CONFIG_ERROR;
  }

  const { project, path: projectPath } = loaded;

  const errors = validateProject(project, loadSchema());
  if (errors.length > 0) {
    for (const message of errors) {
      process.stderr.write(`错误：${message}\n`);
    }
    return EXIT_CONFIG_ERROR;
  }

  let presetIds;
  try {
    presetIds = planPresets({
      targetPresets: project.targetPresets,
      presetId: args.preset,
      mode: args.validateOnly ? 'validate' : 'render',
    });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  if (!args.validateOnly) {
    process.stderr.write(
      '错误：本版本尚未实现出片流程（--dry-run 与完整渲染由后续 ticket 提供）；请使用 --validate-only\n',
    );
    return EXIT_CONFIG_ERROR;
  }

  const sections = presetIds.map((id) => formatPresetReport(resolvePreset(id)));
  process.stdout.write(`校验通过：${projectPath}\n\n${sections.join('\n\n')}\n`);
  return EXIT_SUCCESS;
}

process.exitCode = main(process.argv.slice(2));
