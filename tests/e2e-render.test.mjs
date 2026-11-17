/**
 * 端到端出片：CLI → 帧循环 → FFmpeg 合成 → 成片（验收项 2 / 5 / 6）。
 *
 * 期望值来源：
 * - 宽高 / 帧率 / 帧数：画布预设与 `output.fps`，帧数 = round(时长 × fps)；
 * - 成片规格与可解码性：`ffprobe` / `ffmpeg -v error` 实测，不写死假值；
 * - HUD 位置：组件矩形来自 `shared/layout.js`（布局引擎的契约，已有独立测试），
 *   像素差异用「同一时刻的源视频帧 vs 成片帧」逐像素比出来；
 * - 素材用 ffmpeg 现场生成（`*.mp4` 不进 Git 历史）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadImage, createCanvas } from '@napi-rs/canvas';

import { CLI_PATH, REPO_ROOT, readValidProject } from './helpers/cli.mjs';
import { makeVideo } from './helpers/video.mjs';
import { resolveComponentRect } from '../shared/layout.js';
import { resolvePreset } from '../shared/presets.js';

const PRESET = resolvePreset('douyin-portrait');

/**
 * 异步跑 CLI：`spawnSync` 会卡住事件循环，node:test 的超时到点也杀不掉，
 * 所以端到端用例统一走异步 spawn + 显式超时。
 */
function runCliAsync(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI 超过 ${timeoutMs} ms 未结束（可能挂在管道上）\n${stderr.slice(-2000)}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** 临时工程目录：源视频 + TCX + project.json（路径相对 project.json 所在目录）。 */
function makeProject({ videoPath, seconds = 1, fps = 30, output = './out/final.mp4', mutate }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-e2e-'));
  mkdirSync(path.join(dir, 'out'), { recursive: true });

  const project = readValidProject();
  project.targetPresets = ['douyin-portrait'];
  project.sourceVideo = { path: path.relative(dir, videoPath) };
  project.tcx = { path: path.relative(dir, path.join(REPO_ROOT, 'activity_662602587.tcx')) };
  project.output = { path: output, fps, codec: 'libx264', pixFmt: 'yuv420p' };
  mutate?.(project);

  const projectPath = path.join(dir, 'project.json');
  writeFileSync(projectPath, JSON.stringify(project, null, 2));
  return { dir, projectPath, outputPath: path.resolve(dir, output) };
}

/** 抽一帧成 PNG（`-ss` 在输入侧，快且对关键帧友好）。 */
function extractFrame(videoPath, seconds, pngPath) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-ss', String(seconds),
    '-i', videoPath,
    '-frames:v', '1',
    pngPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
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

function probeStreams(filePath, { countFrames = false } = {}) {
  const args = ['-v', 'error', ...(countFrames ? ['-count_frames'] : []),
    '-show_streams', '-show_format', '-print_format', 'json', filePath];
  const result = spawnSync('ffprobe', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** 成片必须能完整解码：`-v error` 不应有任何输出。 */
function assertDecodable(filePath) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', filePath, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `成片无法解码：${result.stderr}`);
  assert.equal(result.stderr.trim(), '', `解码时报错：${result.stderr}`);
}

test('完整渲染：2 s 1080×1920 @30fps → 成片规格、帧数、HUD 位置全部对上', { timeout: 180000 }, async () => {
  const videoPath = makeVideo({
    key: 'e2e-portrait-green',
    width: PRESET.width,
    height: PRESET.height,
    seconds: 2,
    fps: 30,
    color: '0x2E8B57',
  });
  const { dir, projectPath, outputPath } = makeProject({ videoPath, seconds: 2 });

  try {
    const { code, stdout, stderr } = await runCliAsync([
      '--project', projectPath,
      '--preset', 'douyin-portrait',
    ]);
    assert.equal(code, 0, stderr);

    assert.match(stdout, /校验通过/);
    assert.match(stdout, /成片/);
    assert.match(stdout, /1080 × 1920/);
    assert.match(stdout, new RegExp(`帧数\\s+60（= round\\(2 × 30\\)）`));

    // 1. 成片规格：宽高 / 帧率 / 时长 / 帧数 / 像素格式。
    const probe = probeStreams(outputPath, { countFrames: true });
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    assert.equal(video.width, PRESET.width);
    assert.equal(video.height, PRESET.height);
    assert.equal(video.pix_fmt, 'yuv420p');
    assert.equal(video.r_frame_rate, '30/1');
    assert.equal(Number(video.nb_read_frames), 60, '帧数必须等于 round(时长 × fps)');
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.1, `时长应为 2 s，实际 ${probe.format.duration}`);
    assertDecodable(outputPath);

    // 2. HUD 位置：同一时刻（1 s）源视频帧 vs 成片帧逐像素比对。
    const sourcePng = path.join(dir, 'source.png');
    const finalPng = path.join(dir, 'final.png');
    extractFrame(videoPath, 1, sourcePng);
    extractFrame(outputPath, 1, finalPng);

    const source = await readPixels(sourcePng);
    const final = await readPixels(finalPng);
    assert.equal(final.width, PRESET.width);
    assert.equal(final.height, PRESET.height);

    // 会落笔的三个组件：路线、进度、指标。各自的边界矩形由布局决定（fixture）。
    // weather 尚未实现（#10），不参与。
    const layout = readValidProject().layout.components;
    const rendered = ['route', 'progress', 'metrics'].map((id) => ({
      id,
      rect: resolveComponentRect(layout.find((item) => item.id === id), PRESET),
    }));
    const inflate = 8;
    const within = (rect, x, y) => x >= rect.x - inflate && x < rect.x + rect.width + inflate
      && y >= rect.y - inflate && y < rect.y + rect.height + inflate;

    let maskCount = 0;
    let outsideCount = 0;
    let sourceError = 0;
    const inkByComponent = new Map(rendered.map(({ id }) => [id, 0]));

    for (let y = 0; y < final.height; y += 1) {
      for (let x = 0; x < final.width; x += 1) {
        const offset = (y * final.width + x) * 4;
        const delta = Math.max(
          Math.abs(final.data[offset] - source.data[offset]),
          Math.abs(final.data[offset + 1] - source.data[offset + 1]),
          Math.abs(final.data[offset + 2] - source.data[offset + 2]),
        );
        const hits = rendered.filter(({ rect }) => within(rect, x, y));

        if (delta > 32) {
          maskCount += 1;
          if (hits.length === 0) outsideCount += 1;
          for (const { id } of hits) inkByComponent.set(id, inkByComponent.get(id) + 1);
        } else if (hits.length === 0 && delta > 4) {
          // 组件矩形之外只允许编码噪声（两次 H.264 往返，同画面区域差值很小）。
          sourceError += 1;
        }
      }
    }

    // HUD 必须真的出现：指标卡底板面积 240×289 远大于这个下限。
    assert.ok(maskCount > 20000, `HUD 像素太少（${maskCount}），合成可能没生效`);
    // 三个组件都必须在自己的矩形里留下墨迹，且不得越界：证明 overlay 位置正确、没有被缩放。
    assert.ok(inkByComponent.get('metrics') > 20000, `指标卡墨迹 ${inkByComponent.get('metrics')} 太少`);
    assert.ok(inkByComponent.get('progress') > 5000, `进度卡墨迹 ${inkByComponent.get('progress')} 太少`);
    assert.ok(inkByComponent.get('route') > 1000, `路线墨迹 ${inkByComponent.get('route')} 太少`);
    // 组件矩形之外必须还是源视频：证明没有整体平移 / 拉伸 / 裁切。
    assert.equal(outsideCount, 0, `组件矩形外有 ${outsideCount} 个 HUD 像素`);
    assert.ok(
      sourceError < final.width * final.height * 0.001,
      `组件矩形外与源视频不一致的像素 ${sourceError} 个，超过 0.1%`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('成片保留音频轨', { timeout: 120000 }, async () => {
  const videoPath = makeVideo({
    key: 'e2e-portrait-audio',
    width: PRESET.width,
    height: PRESET.height,
    seconds: 1,
    fps: 30,
    audio: true,
  });
  const { dir, projectPath, outputPath } = makeProject({ videoPath });

  try {
    const { code, stderr } = await runCliAsync(['--project', projectPath, '--preset', 'douyin-portrait']);
    assert.equal(code, 0, stderr);

    const probe = probeStreams(outputPath);
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    assert.ok(audio !== undefined, '成片里没有音频轨（-map 0:a? 没生效）');
    assert.equal(audio.codec_name, 'aac');
    assertDecodable(outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--out 覆盖 output.path，报告里给出实际写出的路径', { timeout: 120000 }, async () => {
  const videoPath = makeVideo({
    key: 'e2e-portrait-green',
    width: PRESET.width,
    height: PRESET.height,
    seconds: 1,
    fps: 30,
    color: '0x2E8B57',
  });
  const { dir, projectPath } = makeProject({ videoPath });
  const custom = path.join(dir, 'custom-name.mp4');

  try {
    const { code, stdout, stderr } = await runCliAsync([
      '--project', projectPath,
      '--preset', 'douyin-portrait',
      '--out', custom,
    ]);
    assert.equal(code, 0, stderr);
    assert.ok(existsSync(custom), '--out 指定的文件没有写出来');
    assert.match(stdout, /custom-name\.mp4/);
    assertDecodable(custom);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('既没有 --out 也没有 output.path 时退出码 2，错误指名缺哪个字段', () => {
  const videoPath = makeVideo({
    key: 'e2e-portrait-green',
    width: PRESET.width,
    height: PRESET.height,
    seconds: 1,
    fps: 30,
    color: '0x2E8B57',
  });
  const { dir, projectPath } = makeProject({
    videoPath,
    mutate(project) {
      delete project.output;
    },
  });

  try {
    const result = spawnSync(process.execPath, [CLI_PATH, '--project', projectPath, '--preset', 'douyin-portrait'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /output\.path/);
    assert.match(result.stderr, /--out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 验收项 4（真进程）：FFmpeg 启动后立刻失败（输出目录不存在）→ 退出码 3，带 stderr 片段。
test('输出目录不存在时退出码 3，错误里带 FFmpeg 的 stderr 片段', { timeout: 120000 }, async () => {
  const videoPath = makeVideo({
    key: 'e2e-portrait-green',
    width: PRESET.width,
    height: PRESET.height,
    seconds: 1,
    fps: 30,
    color: '0x2E8B57',
  });
  const { dir, projectPath } = makeProject({
    videoPath,
    output: './missing-dir/final.mp4',
  });

  try {
    const startedAt = Date.now();
    const { code, stderr } = await runCliAsync([
      '--project', projectPath,
      '--preset', 'douyin-portrait',
    ], { timeoutMs: 60000 });

    assert.equal(code, 3, stderr);
    assert.match(stderr, /\[ffmpeg-start\]/);
    assert.match(stderr, /No such file or directory/);
    assert.ok(Date.now() - startedAt < 60000, '不能挂在管道上');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
