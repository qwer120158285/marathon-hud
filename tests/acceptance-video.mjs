#!/usr/bin/env node
/**
 * 成片验收（ADR 0006 第 5 / 6 / 8 条）：两个目标预设各出一次成片，用 ffprobe 与抽帧实测。
 *
 * 断言全部来自实测，不写死假值：
 * - 宽高 / 帧率 / 帧数 / 时长：ffprobe 读成片；期望值 = 画布预设尺寸与 12 s × 30 fps；
 * - 可解码：`ffmpeg -v error -f null -` 退出码 0 且 stderr 为空；
 * - HUD 位置：同一时刻的源视频帧 vs 成片帧逐像素比对，组件矩形（外扩 8 px）之外
 *   不允许出现 HUD 墨迹，只允许 H.264 往返噪声。
 *
 * 成片不存在时先跑一次 CLI（`node cli/render.mjs`），所以这个脚本可以单独重复运行：
 *   node tests/acceptance-video.mjs            # 缺成片就出片，再验收
 *   node tests/acceptance-video.mjs --check    # 只验收，不出片
 *
 * 素材（assets/run-portrait.mp4、assets/run-landscape.mp4）是 `.gitignore` 忽略的本机文件，
 * 不在仓库里；缺失时脚本给出准备命令并退出 2。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCanvas, loadImage } from '@napi-rs/canvas';

import { resolveComponentRect } from '../shared/layout.js';
import { resolvePreset } from '../shared/presets.js';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_PATH = path.join(REPO_ROOT, 'cli/render.mjs');

/** 期望时长（s）与帧数：素材 12 s、固定 30 fps，帧数 = round(12 × 30)。 */
const EXPECTED_DURATION_SEC = 12;
const EXPECTED_FRAMES = 360;
const EXPECTED_FPS = '30/1';

/** 会落笔的四个组件；矩形由布局引擎给出，不在这里写坐标。 */
const COMPONENT_IDS = ['route', 'progress', 'metrics', 'weather'];

/** 组件矩形外扩量（px），与 e2e 用例、ADR 0001 的关键区域保持一致。 */
const INFLATE_PX = 8;

/**
 * 「组件矩形之外」判定用的外扩量（px）。
 *
 * 不是 INFLATE_PX：路线组件的方向箭头沿行进方向画在 tip 外侧，最长伸出 `ROUTE.arrowLength`
 * （18 px）加抗锯齿，属于 shared/hud.js 的绘制契约。用 24 px 才能只框住「真正不该有 HUD」的区域，
 * 而不是把箭头尖判成越界。
 */
const OUTSIDE_INFLATE_PX = 24;

/**
 * 组件外的编码噪声上限（实测标定，2026-11-17，真实 12 s 素材、CRF 19）：
 * 每个用例取 1 / 3 / 5 s 三帧，组件外区域（扣除 24 px 外扩）的 PSNR 实测 39.2–41.2 dB，
 * 单通道偏差 >16 的像素占 0.001%–0.026%。取 35 dB 与 0.1% 作上限，
 * 既能容纳二次编码的细粒度损失，又能在「HUD 整体平移 / 拉伸」时立刻失败（那种差异远大于 16）。
 */
const OUTSIDE_MIN_PSNR_DB = 35;
const OUTSIDE_MAX_STRUCTURAL_RATIO = 0.001;
/** 结构差异的通道偏差阈值（>16 已远超编码噪声的尾部）。 */
const STRUCTURAL_DELTA = 16;

/** 两个验收用例：源视频画幅不同，所以是两个 project 文件（工具不做 scale / crop）。 */
export const ACCEPTANCE_CASES = [
  {
    label: '竖屏',
    project: 'project.json',
    preset: 'douyin-portrait',
    out: 'out/portrait.mp4',
    source: 'assets/run-portrait.mp4',
  },
  {
    label: '横屏',
    project: 'project.landscape.json',
    preset: 'bilibili-landscape',
    out: 'out/landscape.mp4',
    source: 'assets/run-landscape.mp4',
  },
];

/** 验收失败：脚本以非零退出码结束并打印全部原因。 */
class AcceptanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AcceptanceError';
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error !== undefined) throw new AcceptanceError(`无法启动 ${command}：${result.error.message}`);
  return result;
}

function probe(filePath) {
  const result = run('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate,nb_read_frames,sample_aspect_ratio,display_aspect_ratio',
    '-show_entries', 'format=duration',
    '-of', 'json',
    filePath,
  ]);
  if (result.status !== 0) throw new AcceptanceError(`ffprobe 无法读取 ${filePath}：${result.stderr.trim()}`);
  const json = JSON.parse(result.stdout);
  const stream = (json.streams ?? [])[0];
  if (stream === undefined) throw new AcceptanceError(`${filePath} 里没有视频流`);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    frameRate: stream.r_frame_rate,
    frames: Number(stream.nb_read_frames),
    durationSec: Number(json.format?.duration),
    sar: stream.sample_aspect_ratio ?? '0:1',
    dar: stream.display_aspect_ratio ?? '0:1',
  };
}

/** H.264 成片必须能完整解码：`-v error` 不应有任何输出。 */
function assertDecodable(filePath) {
  const result = run('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'null', '-']);
  if (result.status !== 0) throw new AcceptanceError(`成片无法解码：${filePath}\n${result.stderr.trim()}`);
  if (result.stderr.trim() !== '') {
    throw new AcceptanceError(`解码时报错：${filePath}\n${result.stderr.trim()}`);
  }
}

/** 抽一帧成 PNG（`-ss` 放在输入侧，快且对关键帧友好）。 */
function extractFrame(videoPath, seconds, pngPath) {
  const result = run('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(seconds),
    '-i', videoPath,
    '-frames:v', '1',
    pngPath,
  ]);
  if (result.status !== 0) throw new AcceptanceError(`抽帧失败：${videoPath} @ ${seconds}s\n${result.stderr.trim()}`);
}

/** PNG → `{ width, height, data }`（RGBA）。 */
async function readPixels(pngPath) {
  const image = await loadImage(readFileSync(pngPath));
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, data };
}

/** 成片缺了就出一次片；`--check` 只验收，不出片。 */
function ensureRendered(entry, { check }) {
  const outputPath = path.join(REPO_ROOT, entry.out);
  const projectPath = path.join(REPO_ROOT, entry.project);
  const sourcePath = path.join(REPO_ROOT, entry.source);

  if (existsSync(outputPath)) return { outputPath, projectPath, sourcePath };
  if (check) throw new AcceptanceError(`成片不存在：${entry.out}（去掉 --check 可先出片）`);
  if (!existsSync(sourcePath)) {
    throw new AcceptanceError(
      `源视频不存在：${entry.source}\n`
        + '真实素材被 .gitignore 忽略，需要本机自备 1080×1920 / 1920×1080、30 fps、12 s 的素材',
    );
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = run(process.execPath, [
    CLI_PATH,
    '--project', projectPath,
    '--preset', entry.preset,
    '--out', outputPath,
  ], { cwd: REPO_ROOT });
  if (result.status !== 0) {
    throw new AcceptanceError(`出片失败（退出码 ${result.status}）：${entry.out}\n${result.stderr.trim()}`);
  }
  return { outputPath, projectPath, sourcePath };
}

/** 成片规格断言：宽高 / 帧率 / 帧数 / 时长。 */
function checkSpec(entry, probeResult, preset) {
  const problems = [];
  if (probeResult.width !== preset.width || probeResult.height !== preset.height) {
    problems.push(`宽高 ${probeResult.width}×${probeResult.height}，期望 ${preset.width}×${preset.height}`);
  }
  if (probeResult.frameRate !== EXPECTED_FPS) {
    problems.push(`r_frame_rate ${probeResult.frameRate}，期望 ${EXPECTED_FPS}`);
  }
  if (probeResult.frames !== EXPECTED_FRAMES) {
    problems.push(`帧数 ${probeResult.frames}，期望 ${EXPECTED_FRAMES}`);
  }
  if (!Number.isFinite(probeResult.durationSec)
      || Math.abs(probeResult.durationSec - EXPECTED_DURATION_SEC) > 0.1) {
    problems.push(`时长 ${probeResult.durationSec} s，期望 ${EXPECTED_DURATION_SEC} s（±0.1 s）`);
  }
  if (problems.length > 0) {
    throw new AcceptanceError(`${entry.label}（${entry.preset}）成片规格不符：\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * HUD 位置：同一时刻源视频帧 vs 成片帧逐像素比对。
 *
 * 三条判据：
 * 1. 组件矩形（外扩 8 px）内必须有墨迹：证明四类组件都真的画出来了；
 * 2. 更外一层（外扩 24 px，扣掉路线箭头）之外不允许出现 >32 的差异：证明 overlay 没有平移 / 缩放；
 * 3. 组件矩形之外整体只允许编码噪声：PSNR ≥ 35 dB、>16 的结构差异 ≤ 0.1%（实测 39–41 dB、≤0.03%）。
 *
 * 返回墨迹像素数与噪声统计，供报告打印。
 */
async function checkHudPlacement({ entry, project, sourcePath, outputPath, preset, workDir }) {
  const sampleAt = 1;
  const sourcePng = path.join(workDir, `${entry.preset}-source.png`);
  const finalPng = path.join(workDir, `${entry.preset}-final.png`);
  extractFrame(sourcePath, sampleAt, sourcePng);
  extractFrame(outputPath, sampleAt, finalPng);

  const source = await readPixels(sourcePng);
  const final = await readPixels(finalPng);
  if (final.width !== preset.width || final.height !== preset.height) {
    throw new AcceptanceError(`抽帧尺寸 ${final.width}×${final.height}，期望 ${preset.width}×${preset.height}`);
  }

  const components = project.layout.components
    .filter((component) => COMPONENT_IDS.includes(component.id))
    .map((component) => ({ id: component.id, rect: resolveComponentRect(component, preset) }));
  if (components.length !== COMPONENT_IDS.length) {
    throw new AcceptanceError(`布局里缺少组件：期望 ${COMPONENT_IDS.join('、')}，实际 ${components.map((c) => c.id).join('、')}`);
  }

  const within = (rect, x, y) => x >= rect.x - INFLATE_PX && x < rect.x + rect.width + INFLATE_PX
    && y >= rect.y - INFLATE_PX && y < rect.y + rect.height + INFLATE_PX;
  const outside = (rect, x, y) => x >= rect.x - OUTSIDE_INFLATE_PX
    && x < rect.x + rect.width + OUTSIDE_INFLATE_PX
    && y >= rect.y - OUTSIDE_INFLATE_PX
    && y < rect.y + rect.height + OUTSIDE_INFLATE_PX;

  const ink = new Map(components.map(({ id }) => [id, 0]));
  let hudPixels = 0;
  let strayPixels = 0;
  let noisePixels = 0;
  let structuralPixels = 0;
  let squaredError = 0;

  for (let y = 0; y < final.height; y += 1) {
    for (let x = 0; x < final.width; x += 1) {
      const offset = (y * final.width + x) * 4;
      const delta = Math.max(
        Math.abs(final.data[offset] - source.data[offset]),
        Math.abs(final.data[offset + 1] - source.data[offset + 1]),
        Math.abs(final.data[offset + 2] - source.data[offset + 2]),
      );
      const hits = components.filter(({ rect }) => within(rect, x, y));

      if (delta > 32) {
        hudPixels += 1;
        if (hits.length === 0) {
          if (components.every(({ rect }) => !outside(rect, x, y))) strayPixels += 1;
        }
        for (const { id } of hits) ink.set(id, ink.get(id) + 1);
      }

      // 组件矩形之外（扣掉箭头外扩带）的二次编码噪声统计。
      if (components.every(({ rect }) => !outside(rect, x, y))) {
        noisePixels += 1;
        squaredError += delta * delta;
        if (delta > STRUCTURAL_DELTA) structuralPixels += 1;
      }
    }
  }

  const psnr = noisePixels === 0 || squaredError === 0
    ? Number.POSITIVE_INFINITY
    : 10 * Math.log10((255 * 255 * noisePixels) / squaredError);

  const problems = [];
  if (hudPixels < 20000) problems.push(`HUD 像素太少（${hudPixels}），合成可能没生效`);
  // 每个组件都必须留下墨迹：少一个就说明那类组件没画出来。
  for (const { id } of components) {
    if (ink.get(id) === 0) problems.push(`组件 ${id} 没有留下任何墨迹`);
  }
  if (strayPixels > 0) {
    problems.push(`组件矩形外 ${OUTSIDE_INFLATE_PX} px 之外有 ${strayPixels} 个 HUD 像素（overlay 位置或缩放不对）`);
  }
  if (psnr < OUTSIDE_MIN_PSNR_DB) {
    problems.push(`组件矩形外 PSNR ${psnr.toFixed(2)} dB，低于 ${OUTSIDE_MIN_PSNR_DB} dB`);
  }
  const structuralRatio = noisePixels === 0 ? 0 : structuralPixels / noisePixels;
  if (structuralRatio > OUTSIDE_MAX_STRUCTURAL_RATIO) {
    problems.push(
      `组件矩形外结构差异像素 ${structuralPixels}（${(structuralRatio * 100).toFixed(3)}%），`
        + `超过 ${OUTSIDE_MAX_STRUCTURAL_RATIO * 100}%`,
    );
  }
  if (problems.length > 0) {
    throw new AcceptanceError(`${entry.label}（${entry.preset}）HUD 位置不符：\n  - ${problems.join('\n  - ')}`);
  }

  return { ink, hudPixels, strayPixels, psnr, structuralRatio, noisePixels };
}

/**
 * 跑一个用例的完整验收。
 * @param {object} entry ACCEPTANCE_CASES 的成员
 * @param {{ check: boolean, workDir: string }} options
 */
async function acceptCase(entry, { check, workDir }) {
  const preset = resolvePreset(entry.preset);
  const { outputPath, projectPath, sourcePath } = ensureRendered(entry, { check });
  const project = JSON.parse(readFileSync(projectPath, 'utf8'));

  const probeResult = probe(outputPath);
  checkSpec(entry, probeResult, preset);
  assertDecodable(outputPath);
  const placement = await checkHudPlacement({ entry, project, sourcePath, outputPath, preset, workDir });

  const inkReport = COMPONENT_IDS
    .map((id) => `${id} ${placement.ink.get(id)}`)
    .join(' / ');

  return [
    `${entry.label}（${entry.preset}）${entry.out}`,
    `  ${probeResult.width}×${probeResult.height} @ ${probeResult.frameRate} fps，`
      + `${probeResult.frames} 帧，时长 ${probeResult.durationSec.toFixed(3)} s，可完整解码`,
    `  抽帧 ${1} s：HUD 墨迹 ${placement.hudPixels} 像素（${inkReport}）`,
    `  组件矩形外（外扩 ${OUTSIDE_INFLATE_PX} px 之外）：越界 HUD 像素 ${placement.strayPixels}，`
      + `PSNR ${placement.psnr.toFixed(2)} dB ≥ ${OUTSIDE_MIN_PSNR_DB}，`
      + `结构差异 ${(placement.structuralRatio * 100).toFixed(3)}% ≤ ${OUTSIDE_MAX_STRUCTURAL_RATIO * 100}%`,
    '  通过',
  ].join('\n');
}

async function main(argv) {
  const check = argv.includes('--check');
  const workDir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-accept-video-'));

  try {
    for (const entry of ACCEPTANCE_CASES) {
      process.stdout.write(`${await acceptCase(entry, { check, workDir })}\n`);
    }
    process.stdout.write('\n两段成片全部通过验收（ADR 0006 第 5 / 6 / 8 条）。\n');
    return 0;
  } catch (error) {
    if (error instanceof AcceptanceError) {
      process.stderr.write(`验收失败：${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
