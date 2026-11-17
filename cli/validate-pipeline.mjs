/**
 * 导出前全量校验流水线（SPEC-v1 第 4 节、ADR 0003「导出流程」）。
 *
 * 顺序固定：配置 Schema → 联合校验（全部目标预设）→ 字体与资源 →
 * ffprobe 的 width/height/SAR/DAR/旋转元数据 → HUD 帧尺寸 → 启动 FFmpeg。
 * 每一步独立命名、可单独失败；错误文本带 `[环节]` 前缀，能直接定位到出问题的那一步。
 * 本文件只跑到「HUD 帧尺寸」，最后一步（启动 FFmpeg）由 #7 接在后面。
 */
import path from 'node:path';

import {
  EXIT_CONFIG_ERROR,
  EXIT_DATA_MISSING,
  planPresets,
} from './args.mjs';
import {
  createCanvas,
  registerFonts,
  verifyFontResources,
} from './adapter.mjs';
import { validateProject } from './project.mjs';
import { ProbeError, compareVideoSpec, probeVideo } from './ffprobe.mjs';
import { jointValidate } from '../shared/layout.js';
import { resolvePreset } from '../shared/presets.js';

/** 导出前校验的固定顺序（SPEC-v1 第 4 节第 1–6 步）。 */
export const EXPORT_STAGE_ORDER = Object.freeze([
  'schema',
  'joint',
  'resources',
  'ffprobe',
  'hud-size',
  'ffmpeg-start',
]);

/** 环节标识 → 报告里的中文名。 */
export const STAGE_LABELS = Object.freeze({
  schema: '配置 Schema',
  joint: '联合校验',
  resources: '字体与资源',
  ffprobe: 'ffprobe 尺寸比对',
  'hud-size': 'HUD 帧尺寸',
  'ffmpeg-start': '启动 FFmpeg',
});

/**
 * `sourceVideo.probed.durationSec` 与 ffprobe 实测时长的容忍差（秒）。
 *
 * 超过这个差就提示「记录值过期」：素材替换是合法操作（工具不要求 probed 精确），
 * 但配置里留着 80 s 而实际只有 12 s 会让报告与预期脱节，需要一条不阻断的警告。
 */
export const PROBED_DURATION_TOLERANCE_SEC = 1;

/** 某一校验环节失败：`stageId` 定位环节，`exitCode` 供 CLI 直接使用。 */
export class StageError extends Error {
  /**
   * @param {string} stageId EXPORT_STAGE_ORDER 中的环节标识
   * @param {string[]} messages 该环节的全部错误文本（不含前缀）
   * @param {number} [exitCode]
   */
  constructor(stageId, messages, exitCode = EXIT_CONFIG_ERROR) {
    super(messages.map((message) => `[${stageId}] ${message}`).join('\n'));
    this.name = 'StageError';
    this.stageId = stageId;
    this.messages = messages;
    this.exitCode = exitCode;
  }
}

/**
 * 「HUD 帧尺寸 == 目标画布预设」校验。
 *
 * 正常路径必然一致（画布由预设尺寸创建），这是防御性检查：
 * 任何绕过预设的尺寸来源（注入的画布工厂、后续 ticket 的复用画布）都会在这里被拦下。
 *
 * @param {{ preset: object, createFrameCanvas?: Function }} options
 */
export function checkHudFrameSize({ preset, createFrameCanvas = createCanvas }) {
  const { canvas } = createFrameCanvas({ width: preset.width, height: preset.height });
  if (canvas.width !== preset.width || canvas.height !== preset.height) {
    throw new StageError('hud-size', [
      `HUD 帧尺寸 ${canvas.width}×${canvas.height}，`
        + `期望 ${preset.width}×${preset.height}（画布预设 ${preset.id}）`,
    ]);
  }
  return { width: canvas.width, height: canvas.height };
}

/**
 * `sourceVideo.probed.durationSec` 是否过期：与 ffprobe 实测时长相差超过 1 s 时报一条提示。
 *
 * 不阻断导出：素材替换是合法操作，实测时长才是出片依据（帧数 = round(实测时长 × fps)）。
 * 提示里给出可照抄的探测命令，让人能把记录值刷新回 project.json。
 *
 * @param {{ sourceVideo?: { probed?: { durationSec?: number } } }} project
 * @param {{ durationSec: number }} video
 * @param {string} videoPath 已解析的源视频绝对路径，写进刷新命令
 * @returns {string|null} 提示文本；记录值缺失或差值在容忍范围内时返回 null
 */
export function staleProbedDuration(project, video, videoPath) {
  const recorded = project?.sourceVideo?.probed?.durationSec;
  if (typeof recorded !== 'number' || !Number.isFinite(recorded) || recorded < 0) return null;

  const delta = Math.abs(recorded - video.durationSec);
  if (delta <= PROBED_DURATION_TOLERANCE_SEC) return null;

  const format = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(3));
  return `sourceVideo.probed.durationSec 记录值 ${format(recorded)} s 与 ffprobe 实测 `
    + `${video.durationSec.toFixed(3)} s 相差 ${format(delta)} s`
    + `（超过 ${PROBED_DURATION_TOLERANCE_SEC} s）：记录值已过期，本次按实测时长出片。`
    + '刷新方式：重跑探测 '
    + `ffprobe -v error -print_format json -show_streams -show_format "${videoPath}" ，`
    + '把结果里的 durationSec 写回 project.json 的 sourceVideo.probed';
}

/**
 * 跑完导出前的 5 个校验环节。
 *
 * 失败即抛出 `StageError`（含环节标识与退出码）；多目标预设未指定 `--preset`
 * 属于参数用法错误，保持 `UsageError` 原样上抛，由 CLI 统一转成退出码 2。
 *
 * @param {{
 *   project: object, schema: object, projectDir: string, presetId?: string,
 *   createFrameCanvas?: Function, probe?: Function,
 * }} options
 * @returns {Promise<{ preset: object, presets: object[], presetIds: string[],
 *                     videoPath: string, video: object, warnings: string[] }>}
 */
export async function runExportValidation({
  project,
  schema,
  projectDir,
  presetId,
  createFrameCanvas = createCanvas,
  probe = probeVideo,
}) {
  // 1. 配置 Schema（含 version / gridVersion、组件 id 不重复等语义约束）。
  const schemaErrors = validateProject(project, schema);
  if (schemaErrors.length > 0) {
    throw new StageError('schema', schemaErrors);
  }

  // 2. 本次出片预设：多目标预设必须用 --preset 选定。
  const presetIds = planPresets({
    targetPresets: project.targetPresets,
    presetId,
    mode: 'render',
  });
  const preset = resolvePreset(presetIds[0]);

  // 3. 联合校验：同一份候选布局跑全部目标预设（重叠只提示，不在这里失败）。
  const presets = project.targetPresets.map((id) => resolvePreset(id));
  const joint = jointValidate({
    layout: project.layout,
    targetPresets: project.targetPresets,
    presets,
  });
  if (!joint.ok) {
    throw new StageError('joint', joint.errors.map((error) => error.message));
  }

  // 4. 字体与资源：文件存在 + SHA-256 一致 + 注册完成。
  try {
    verifyFontResources();
    await registerFonts();
  } catch (error) {
    throw new StageError('resources', [error.message]);
  }

  // 5. 源视频规格：width / height / SAR / DAR / 旋转元数据分别比对。
  //    文件缺失或 ffprobe 失败属于数据源缺失（退出码 4），规格不符属于校验失败（退出码 2）。
  const videoPath = path.resolve(projectDir, project.sourceVideo.path);
  let video;
  try {
    video = probe(videoPath);
  } catch (error) {
    if (error instanceof ProbeError) {
      throw new StageError('ffprobe', [error.message], EXIT_DATA_MISSING);
    }
    throw error;
  }
  const issues = compareVideoSpec(video, preset);
  if (issues.length > 0) {
    throw new StageError('ffprobe', issues);
  }

  // 5b. 记录值新鲜度：只提示不阻断（素材替换合法，实测时长才是出片依据）。
  const warnings = [];
  const staleDuration = staleProbedDuration(project, video, videoPath);
  if (staleDuration !== null) warnings.push(staleDuration);

  // 6. HUD 帧尺寸：必须在启动 FFmpeg（以及任何编码前工作）之前确认。
  checkHudFrameSize({ preset, createFrameCanvas });

  return { preset, presets, presetIds, videoPath, video, warnings };
}
