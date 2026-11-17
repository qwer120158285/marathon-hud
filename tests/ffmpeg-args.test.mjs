/**
 * FFmpeg 参数拼装（ADR 0003「工具不负责 scale / crop / pad」、SPEC-v1 第 5 节）。
 *
 * 期望值来源：`archive/marathon-hud-demo/src/render.js` 里已在真机验证过的参数形状
 * （双输入 + overlay 0:0 + `-map 0:a?` + H.264 / yuv420p / faststart），
 * 以及本机 `ffmpeg -h` 的选项名（rawvideo 解复用器的 `-pixel_format`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildFfmpegArgs } from '../cli/ffmpeg.mjs';

const INPUT = '/tmp/src.mp4';
const OUTPUT = '/tmp/final.mp4';

function buildArgs(overrides = {}) {
  return buildFfmpegArgs({
    inputPath: INPUT,
    outputPath: OUTPUT,
    width: 1080,
    height: 1920,
    fps: 30,
    totalFrames: 60,
    ...overrides,
  });
}

/** 取某个选项后面紧跟的取值。 */
function valueOf(args, flag) {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, `参数里缺少 ${flag}`);
  return args[index + 1];
}

test('双输入：源视频 + pipe:0 的 rawvideo rgba，画幅与帧率来自画布预设', () => {
  const args = buildArgs();

  assert.equal(valueOf(args, '-i'), INPUT);

  // 第二个输入必须是管道：rawvideo + rgba + WxH + 帧率，四者都要显式给出，
  // 否则 FFmpeg 会按默认值猜画幅，导致 HUD 像素错位。
  const second = args.lastIndexOf('-i');
  const pipeInput = args.slice(0, second);
  assert.ok(pipeInput.includes('-f'));
  assert.ok(pipeInput.includes('rawvideo'));
  assert.equal(pipeInput[pipeInput.indexOf('-f') + 1], 'rawvideo');
  assert.equal(valueOf(args.slice(0, second), '-pixel_format'), 'rgba');
  assert.equal(valueOf(args.slice(0, second), '-video_size'), '1080x1920');
  assert.equal(valueOf(args.slice(0, second), '-framerate'), '30');
  assert.equal(args[second + 1], 'pipe:0');
});

test('合成用 overlay 固定在 0:0，成片画面构图不被移动', () => {
  const args = buildArgs();
  const filter = valueOf(args, '-filter_complex');

  assert.match(filter, /overlay=0:0/);
  assert.match(filter, /\[0:v\].*\[base\]/);
  assert.match(filter, /\[1:v\].*\[ov\]/);
  assert.match(filter, /\[base\]\[ov\]overlay/);
  // 管道输入结束时合成也跟着结束，不会无限等帧。
  assert.match(filter, /shortest=1/);
  assert.equal(valueOf(args, '-map').length > 0, true);
});

// 验收项：参数中不含 scale / crop / pad（工具绝不改变源视频构图）。
test('参数里不出现 scale / crop / pad', () => {
  const args = buildArgs();

  for (const argument of args) {
    assert.doesNotMatch(
      argument,
      /\b(scale|crop|pad)\b/,
      `参数 "${argument}" 里出现了被禁止的滤镜`,
    );
  }
});

test('保留音频轨、H.264 / yuv420p / faststart', () => {
  const args = buildArgs();

  const maps = args.reduce((all, argument, index) => (
    argument === '-map' ? [...all, args[index + 1]] : all
  ), []);
  assert.deepEqual(maps, ['[v]', '0:a?']);

  assert.equal(valueOf(args, '-c:v'), 'libx264');
  assert.equal(valueOf(args, '-pix_fmt'), 'yuv420p');
  assert.equal(valueOf(args, '-movflags'), '+faststart');
  // stderr 只留错误：报错片段要能直接读到故障原因，不被输入元数据淹没。
  assert.equal(valueOf(args, '-loglevel'), 'error');
  assert.equal(args.at(-1), OUTPUT);
});

// 输出时长由帧数决定：n 帧 @ fps → n / fps 秒，与源视频时长解耦。
test('输出时长按总帧数换算，误差在 1 ms 内', () => {
  const args = buildArgs({ totalFrames: 45, fps: 30 });

  assert.equal(Number(valueOf(args, '-t')), 1.5);
});

test('帧率与编码参数可被工程配置覆盖', () => {
  const args = buildArgs({ fps: 25, codec: 'libx264', crf: 18, x264Preset: 'fast' });

  assert.equal(valueOf(args.slice(0, args.lastIndexOf('-i')), '-framerate'), '25');
  assert.equal(valueOf(args, '-crf'), '18');
  assert.equal(valueOf(args, '-preset'), 'fast');
});

test('总帧数非法时拒绝拼装参数', () => {
  assert.throws(() => buildArgs({ totalFrames: 0 }), /总帧数/);
  assert.throws(() => buildArgs({ fps: 0 }), /帧率/);
});
