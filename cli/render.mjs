#!/usr/bin/env node
/**
 * CLI 入口：加载 project.json、导出前全量校验、逐帧出 RGBA。
 * 参数与退出码定义见 docs/SPEC-v1.md 第 4 节。
 */
import {
  parseArgs,
  planPresets,
  UsageError,
  EXIT_SUCCESS,
  EXIT_CONFIG_ERROR,
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
import { StageError, runExportValidation } from './validate-pipeline.mjs';
import { motionAtFrame } from '../data/interpolate.mjs';
import { prepareStatic } from '../shared/hud.js';
import { resolvePreset } from '../shared/presets.js';
import { jointValidate } from '../shared/layout.js';

const USAGE = `用法：node cli/render.mjs --project <path/to/project.json> [options]

  --project <path>   必填，project.json 路径
  --preset <id>      本次出片预设，必须在 targetPresets 内；存在多个目标预设时必须指定
  --at-frame <n>     打印第 n 帧（0 起）对应的运动时刻与运动指标，用于核对数据源
  --validate-only    只做 Schema 与联合预设校验并打印报告（含数据源解析结果），
                     不加载媒体、不启动 ffprobe、不启动 FFmpeg
  --dry-run          执行到导出前全量校验为止（含 ffprobe 尺寸比对），再跑完整帧循环、
                     把每帧 RGBA 写进计数 sink；不启动 FFmpeg
  --out <path>       覆盖 output.path（本版本未实现）
  -h, --help         显示本帮助

导出前校验顺序：配置 Schema → 联合校验（全部目标预设）→ 字体与资源 →
ffprobe 的 width/height/SAR/DAR/旋转元数据 → HUD 帧尺寸 → 启动 FFmpeg。

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
    `  视频规格      ${video.width}×${video.height}，SAR ${video.sar}，DAR ${video.dar}，`
      + `旋转 ${video.rotation}°，时长 ${video.durationSec.toFixed(3)} s`,
    `  帧率          ${formatNumber(fps)} fps（固定），对齐偏移 ${formatNumber(alignmentOffsetMs)} ms`,
    '',
    `帧循环完成：${stats.frames} 帧`,
    `  每帧字节     ${stats.width} × ${stats.height} × 4 = ${stats.bytesPerFrame} 字节`,
    `  写入 RGBA 管道 ${stats.bytesWritten} 字节（= ${stats.bytesPerFrame} × ${stats.frames}）`,
    '未启动 FFmpeg（--dry-run 只做导出前校验与出帧，不合成）',
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
 * `--dry-run`：导出前全量校验 → 真实跑完整帧循环 → 统计报告。
 * 帧循环把 RGBA 写进计数 sink，不 spawn 任何进程。
 */
async function dryRun({ args, loaded }) {
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
      return error.exitCode;
    }
    if (error instanceof UsageError) {
      process.stderr.write(`错误：${error.message}\n`);
      return EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  const fps = project.output?.fps ?? 30;
  const alignmentOffsetMs = project.alignmentOffsetMs ?? 0;
  const totalFrames = Math.round(validation.video.durationSec * fps);
  if (totalFrames <= 0) {
    process.stderr.write(
      `错误：[ffprobe] 源视频时长 ${validation.video.durationSec} s × fps ${fps} 得到 0 帧，无法出片\n`,
    );
    return EXIT_CONFIG_ERROR;
  }

  const data = loadDataOrExit(project, projectDir);
  if (data === null) return EXIT_DATA_MISSING;

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
  });

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

  if (args.out !== undefined) {
    process.stderr.write('错误：本版本尚未实现 --out（完整渲染由后续 ticket 提供）\n');
    return EXIT_CONFIG_ERROR;
  }

  if (args.dryRun) {
    return dryRun({ args, loaded });
  }

  if (args.validateOnly || args.atFrame !== undefined) {
    return inspectOnly({ args, loaded });
  }

  process.stderr.write(
    '错误：本版本尚未实现完整渲染（FFmpeg 合成由后续 ticket 提供）；'
      + '可用 --dry-run 做导出前全量校验与出帧，或用 --validate-only 只做校验\n',
  );
  return EXIT_CONFIG_ERROR;
}

process.exitCode = await main(process.argv.slice(2));
