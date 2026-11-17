#!/usr/bin/env node
/**
 * CLI 入口：加载 project.json、导出前全量校验、逐帧出 RGBA、交 FFmpeg 合成。
 * 参数与退出码定义见 docs/SPEC-v1.md 第 4 节。
 */
import path from 'node:path';

import {
  parseArgs,
  planPresets,
  UsageError,
  EXIT_SUCCESS,
  EXIT_CONFIG_ERROR,
  EXIT_FFMPEG_ERROR,
  EXIT_DATA_MISSING,
} from './args.mjs';
import { loadProject, loadSchema, validateProject } from './project.mjs';
import {
  DataSourceError,
  formatDataSourceReport,
  formatFrameReport,
  loadDataSource,
} from './data.mjs';
import { createCanvas } from './adapter.mjs';
import { createCountingSink, runFrameLoop } from './frame-loop.mjs';
import { buildFfmpegArgs, startFfmpeg, FfmpegError } from './ffmpeg.mjs';
import { StageError, runExportValidation } from './validate-pipeline.mjs';
import { motionAtFrame } from '../data/interpolate.mjs';
import { prepareStatic } from '../shared/hud.js';
import { resolvePreset } from '../shared/presets.js';
import { jointValidate } from '../shared/layout.js';

const USAGE = `用法：node cli/render.mjs --project <path/to/project.json> [options]

  --project <path>   必填，project.json 路径
  --preset <id>      本次出片预设，必须在 targetPresets 内；出片时存在多个目标预设必须指定。
                     --validate-only 总是校验全部目标预设，不受本参数影响
  --at-frame <n>     打印第 n 帧（0 起）对应的运动时刻与运动指标，用于核对数据源
  --validate-only    只做 Schema 与联合预设校验并打印报告（含数据源解析结果），
                     不加载媒体、不启动 ffprobe、不启动 FFmpeg；总是覆盖全部目标预设
  --dry-run          执行到导出前全量校验为止（含 ffprobe 尺寸比对），再跑完整帧循环、
                     把每帧 RGBA 写进计数 sink；不启动 FFmpeg
  --out <path>       覆盖 output.path（相对当前目录；未指定时用 project.json 里的相对路径）
  -h, --help         显示本帮助

导出前校验顺序：配置 Schema → 联合校验（全部目标预设）→ 字体与资源 →
ffprobe 的 width/height/SAR/DAR/旋转元数据 → HUD 帧尺寸 → 启动 FFmpeg。

退出码：0 成功；2 配置或校验失败；3 FFmpeg 失败；4 数据源缺失。`;

/** 数字转报告文本：整数不带小数点，小数最多三位。 */
function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * 比例字段 → 报告文本。
 *
 * ffmpeg 用 `0:1` 表示「未标注」（见 cli/ffprobe.mjs 的 parseRatio），直接印出来会被读成
 * 「零比一」。未标注时写清楚实际按什么处理，避免看报告的人以为校验被跳过。
 *
 * @param {string} value ffprobe 的 sar / dar
 * @param {string} fallback 未标注时的处理口径，例如「按 1:1」
 */
function formatRatio(value, fallback) {
  return value === '0:1' || value === 'N/A' ? `未标注（${fallback}）` : value;
}

/** 源视频规格一行：宽高、SAR、DAR、旋转、时长；报告与 `--dry-run` 共用。 */
function formatVideoSpec(video) {
  return `视频规格      ${video.width}×${video.height}，`
    + `SAR ${formatRatio(video.sar, '按 1:1 处理')}，`
    + `DAR ${formatRatio(video.dar, '按画面宽高处理')}，`
    + `旋转 ${video.rotation}°，时长 ${video.durationSec.toFixed(3)} s`;
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

/** `--dry-run` 报告：校验结论 + 帧循环统计（字节数等式必须一眼可核对）。 */
function formatDryRunReport({ projectPath, preset, videoPath, video, fps, alignmentOffsetMs, stats }) {
  const title = preset.displayName === undefined
    ? `画布预设  ${preset.id}`
    : `画布预设  ${preset.id}（${preset.displayName}）`;

  return [
    `校验通过：${projectPath}`,
    '',
    title,
    `  画布尺寸      ${preset.width} × ${preset.height}`,
    `  源视频        ${videoPath}`,
    `  ${formatVideoSpec(video)}`,
    `  帧率          ${formatNumber(fps)} fps（固定），对齐偏移 ${formatNumber(alignmentOffsetMs)} ms`,
    '',
    `帧循环完成：${stats.frames} 帧`,
    `  每帧字节     ${stats.width} × ${stats.height} × 4 = ${stats.bytesPerFrame} 字节`,
    `  写入 RGBA 管道 ${stats.bytesWritten} 字节（= ${stats.bytesPerFrame} × ${stats.frames}）`,
    '未启动 FFmpeg（--dry-run 只做导出前校验与出帧，不合成）',
  ].join('\n');
}

/** 成片报告：校验结论 + 实际写出的成片规格与帧循环统计。 */
function formatRenderReport({
  projectPath, preset, videoPath, video, fps, alignmentOffsetMs, totalFrames, outputPath, stats,
}) {
  const title = preset.displayName === undefined
    ? `画布预设  ${preset.id}`
    : `画布预设  ${preset.id}（${preset.displayName}）`;

  return [
    `校验通过：${projectPath}`,
    '',
    title,
    `  画布尺寸      ${preset.width} × ${preset.height}`,
    `  源视频        ${videoPath}`,
    `  ${formatVideoSpec(video)}`,
    `  帧率          ${formatNumber(fps)} fps（固定），对齐偏移 ${formatNumber(alignmentOffsetMs)} ms`,
    '',
    `成片  ${outputPath}`,
    `  宽高          ${preset.width} × ${preset.height}`,
    `  帧率          ${formatNumber(fps)} fps`,
    `  帧数          ${totalFrames}（= round(${formatNumber(video.durationSec)} × ${formatNumber(fps)})）`,
    `  合成          overlay 0:0，源视频构图未被 scale / crop / pad 改动`,
    `  RGBA 管道     ${stats.frames} 帧，${stats.bytesWritten} 字节`
      + `（= ${stats.bytesPerFrame} × ${stats.frames}）`,
  ].join('\n');
}

/** 数据源缺失 / 不可解析统一退出码 4。 */
function loadDataOrExit(project, projectDir) {
  try {
    return loadDataSource(project, projectDir);
  } catch (error) {
    if (error instanceof DataSourceError) {
      process.stderr.write(`错误：${error.message}\n`);
      return null;
    }
    throw error;
  }
}

/**
 * 出片前的一切准备工作：导出前全量校验 → 数据源 → 静态层。
 *
 * `--dry-run` 与完整渲染共用这一段，保证两条路径的校验完全一致，
 * 差别只在最后的 sink 是计数 sink 还是 FFmpeg 的 stdin。
 *
 * @returns {Promise<object>} 失败时返回 `{ exitCode }`
 */
async function prepareExport({ args, loaded }) {
  const { project, path: projectPath, dir: projectDir } = loaded;

  let validation;
  try {
    validation = await runExportValidation({
      project,
      schema: loadSchema(),
      projectDir,
      presetId: args.preset,
    });
  } catch (error) {
    if (error instanceof StageError) {
      for (const message of error.message.split('\n')) {
        process.stderr.write(`错误：${message}\n`);
      }
      return { exitCode: error.exitCode };
    }
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n`);
      return { exitCode: EXIT_CONFIG_ERROR };
    }
    throw error;
  }

  const fps = project.output?.fps ?? 30;
  const alignmentOffsetMs = project.alignmentOffsetMs ?? 0;
  // 提示不阻断导出：记录值过期、素材替换这类情况照常出片，只是把话说清楚。
  for (const warning of validation.warnings ?? []) {
    process.stderr.write(`提示：${warning}\n`);
  }

  const totalFrames = Math.round(validation.video.durationSec * fps);
  if (totalFrames <= 0) {
    process.stderr.write(
      `错误：[ffprobe] 源视频时长 ${validation.video.durationSec} s × fps ${fps} 得到 0 帧，无法出片\n`,
    );
    return { exitCode: EXIT_CONFIG_ERROR };
  }

  const data = loadDataOrExit(project, projectDir);
  if (data === null) return { exitCode: EXIT_DATA_MISSING };

  // 静态层只预绘一次：底板、标签、单位不随帧变化。
  const { preset } = validation;
  const staticCanvas = createCanvas({ width: preset.width, height: preset.height });
  const firstFrame = motionAtFrame(data.motion, 0, { fps, alignmentOffsetMs });
  const staticLayer = prepareStatic(staticCanvas.ctx, {
    preset,
    components: project.layout.components,
    metrics: { ...firstFrame.metrics, availability: data.motion.availability },
    // 整场活动：路线轨迹、总距离与真实 Lap 刻度都从这里取。
    activity: data.activity,
    // 静态覆盖：天气只读配置里的快照，渲染期不联网、不读时钟（ticket #10）。
    weatherSnapshot: project.weatherSnapshot,
    timezone: project.timezone,
  });

  return { projectPath, validation, preset, data, fps, alignmentOffsetMs, totalFrames, staticLayer };
}

/**
 * `--dry-run`：导出前全量校验 → 真实跑完整帧循环 → 统计报告。
 * 帧循环把 RGBA 写进计数 sink，不 spawn 任何进程。
 */
async function dryRun({ args, loaded }) {
  const prepared = await prepareExport({ args, loaded });
  if (prepared.exitCode !== undefined) return prepared.exitCode;

  const {
    projectPath, validation, preset, data, fps, alignmentOffsetMs, totalFrames, staticLayer,
  } = prepared;

  const sink = createCountingSink();
  const stats = await runFrameLoop({
    motion: data.motion,
    preset,
    fps,
    alignmentOffsetMs,
    totalFrames,
    static: staticLayer,
    sink,
  });

  process.stdout.write(`${formatDryRunReport({
    projectPath,
    preset,
    videoPath: validation.videoPath,
    video: validation.video,
    fps,
    alignmentOffsetMs,
    stats,
  })}\n`);
  return EXIT_SUCCESS;
}

/**
 * 完整渲染：校验通过后启动 FFmpeg，把帧循环的 sink 接到它的 stdin。
 *
 * 退出码口径：校验失败 2 / 数据源缺失 4 / FFmpeg 启动失败、非零退出、提前退出一律 3。
 * 输出路径不做自动建目录：写不进去就交给 FFmpeg 报错，工具不隐式改动文件系统。
 */
async function renderVideo({ args, loaded }) {
  const { project, dir: projectDir } = loaded;

  // 成片路径：--out 优先（相对当前目录），否则 output.path（相对 project.json 所在目录）。
  const configuredPath = project.output?.path;
  if (args.out === undefined && (typeof configuredPath !== 'string' || configuredPath.trim() === '')) {
    process.stderr.write(
      '错误：未指定成片路径：请用 --out <path> 指定，或在 project.json 里配置 output.path\n',
    );
    return EXIT_CONFIG_ERROR;
  }
  const outputPath = args.out === undefined
    ? path.resolve(projectDir, configuredPath)
    : path.resolve(args.out);

  const prepared = await prepareExport({ args, loaded });
  if (prepared.exitCode !== undefined) return prepared.exitCode;

  const {
    projectPath, validation, preset, data, fps, alignmentOffsetMs, totalFrames, staticLayer,
  } = prepared;

  const argsForFfmpeg = buildFfmpegArgs({
    inputPath: validation.videoPath,
    outputPath,
    width: preset.width,
    height: preset.height,
    fps,
    totalFrames,
    codec: project.output?.codec ?? 'libx264',
    pixFmt: project.output?.pixFmt ?? 'yuv420p',
  });

  const ffmpeg = startFfmpeg({ args: argsForFfmpeg });
  let stats;
  try {
    stats = await runFrameLoop({
      motion: data.motion,
      preset,
      fps,
      alignmentOffsetMs,
      totalFrames,
      static: staticLayer,
      sink: ffmpeg.sink,
    });
    await ffmpeg.finish();
  } catch (error) {
    ffmpeg.abort();
    if (error instanceof FfmpegError) {
      // 环节名沿用导出前校验的最后一步，错误文本里能看出是 FFmpeg 这一步挂的。
      const stage = new StageError('ffmpeg-start', error.message.split('\n'), EXIT_FFMPEG_ERROR);
      for (const message of stage.message.split('\n')) {
        process.stderr.write(`错误：${message}\n`);
      }
      return EXIT_FFMPEG_ERROR;
    }
    throw error;
  }

  process.stdout.write(`${formatRenderReport({
    projectPath,
    preset,
    videoPath: validation.videoPath,
    video: validation.video,
    fps,
    alignmentOffsetMs,
    totalFrames,
    outputPath,
    stats,
  })}\n`);
  return EXIT_SUCCESS;
}

/** `--validate-only` / `--at-frame`：只查配置、布局与数据源，不碰媒体文件。 */
function inspectOnly({ args, loaded }) {
  const { project, path: projectPath, dir: projectDir } = loaded;

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
      mode: 'validate',
    });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  // 导出前校验顺序（SPEC-v1 第 4 节）：Schema 已完成 → 联合校验 → 数据源。
  // --at-frame 只查数据源、不产出成片，因此跳过联合校验，也不要求布局可用。
  let presetSnapshot = [];
  let joint = { ok: true, errors: [], warnings: [] };
  if (args.validateOnly) {
    // 同一版本预设配置：整份报告与联合校验都只用这一次解析出来的快照。
    presetSnapshot = presetIds.map((id) => resolvePreset(id));
    joint = jointValidate({
      layout: project.layout,
      targetPresets: presetIds,
      presets: presetSnapshot,
    });

    if (!joint.ok) {
      for (const error of joint.errors) {
        process.stderr.write(`错误：${error.message}\n`);
      }
      process.stderr.write(
        `联合校验失败：${joint.errors.length} 处错误，候选布局未保存\n`,
      );
      return EXIT_CONFIG_ERROR;
    }
  }

  const data = loadDataOrExit(project, projectDir);
  if (data === null) return EXIT_DATA_MISSING;

  if (args.atFrame !== undefined) {
    const fps = project.output?.fps ?? 30;
    const alignmentOffsetMs = project.alignmentOffsetMs ?? 0;
    const frame = motionAtFrame(data.motion, args.atFrame, { fps, alignmentOffsetMs });
    const report = formatFrameReport(frame, {
      fps,
      alignmentOffsetMs,
      availability: data.motion.availability,
    });
    process.stdout.write(`${report}\n`);
    return EXIT_SUCCESS;
  }

  const lines = [
    `校验通过：${projectPath}`,
    '',
    presetSnapshot.map(formatPresetReport).join('\n\n'),
    '',
    `联合校验通过：${presetIds.join('、')}（${project.layout.components.length} 个组件）`,
    '',
    formatDataSourceReport(data),
  ];

  // 重叠只提示不阻止：提示与错误分开输出，且不影响退出码。
  if (joint.warnings.length > 0) {
    lines.push(
      '',
      '提示（仅提示，不阻止保存）：',
      ...joint.warnings.map((warning) => `  - ${warning.message}`),
    );
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT_SUCCESS;
}

async function main(argv) {
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

  if (args.dryRun && args.validateOnly) {
    process.stderr.write('错误：--dry-run 与 --validate-only 不能同时使用\n');
    return EXIT_CONFIG_ERROR;
  }

  if (args.dryRun) {
    return dryRun({ args, loaded });
  }

  if (args.validateOnly || args.atFrame !== undefined) {
    return inspectOnly({ args, loaded });
  }

  return renderVideo({ args, loaded });
}

/**
 * CLI 边界：把渲染期漏出来的异常归类成约定退出码。
 *
 * 已经按环节处理的错误（`StageError` / `UsageError` / `DataSourceError` / `FfmpegError`）
 * 各自带了退出码；走到这里的多半是共享绘制层的普通 `Error`（例如「卡片放不下」），
 * 属于配置或布局问题：按退出码 2 处理并只打印中文原因，不把栈回溯丢给使用者。
 */
function exitCodeFor(error) {
  if (error instanceof FfmpegError) return EXIT_FFMPEG_ERROR;
  if (error instanceof DataSourceError) return EXIT_DATA_MISSING;
  return EXIT_CONFIG_ERROR;
}

let exitCode;
try {
  exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = exitCodeFor(error);
}
process.exitCode = exitCode;
