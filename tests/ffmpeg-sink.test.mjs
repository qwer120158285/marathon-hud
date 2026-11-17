/**
 * FFmpeg 进程边界：背压与提前退出（SPEC-v1 第 5 节第 5 条、验收项 3/4/5）。
 *
 * 期望值来源：
 * - 「写满 → 等 drain」是 Node Writable 的文档行为：`write()` 返回 false 后只有 `drain` 表示可续写；
 * - 「FFmpeg 退出 → 循环立刻结束」是本票的核心：`drain` 在进程死掉后永远不会来，
 *   只有 race 上 exit 才能解开等待。假进程可以精确制造这个顺序，真 FFmpeg 用来验证集成；
 * - 帧数 / 字节数来自 `ffprobe` 实测，不用手写 JSON 冒充。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { FfmpegError, buildFfmpegArgs, startFfmpeg } from '../cli/ffmpeg.mjs';
import { runFrameLoop } from '../cli/frame-loop.mjs';
import { createCanvas, registerFonts } from '../cli/adapter.mjs';
import { buildMotion } from '../data/interpolate.mjs';
import { prepareStatic } from '../shared/hud.js';
import { resolveCanvasPreset, resolvePreset } from '../shared/presets.js';

const FLAT_MOTION = buildMotion([{
  tMs: 0,
  speedMps: 4,
  heartRateBpm: 150,
  cadenceSpm: 180,
  altitudeM: 20,
  powerWatts: null,
  lat: null,
  lon: null,
  distanceM: 0,
}], { kmMarkers: [] });

/** 108×192：帧循环照样走真实几何，字节数小、编码快。 */
const TINY = resolveCanvasPreset({
  id: 'tiny',
  width: 108,
  height: 192,
  safeInset: { left: 0, right: 0, top: 0, bottom: 0 },
});

function emptyStatic(preset) {
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  return prepareStatic(ctx, { preset, components: [], metrics: { availability: {} } });
}

/**
 * 假 FFmpeg 进程：真实的 Writable 做 stdin（背压语义与真管道一致），
 * 需要提前退出时手动 emit `close`。
 *
 * @param {{ acceptWrites?: boolean }} [options] `acceptWrites: false` 让 write 永远返回 false
 */
function fakeFfmpeg({ acceptWrites = true } = {}) {
  const events = new EventEmitter();
  const stderr = new PassThrough();
  const stdin = new Writable({
    // highWaterMark 设成 1：写进去一帧就返回 false，稳定制造背压。
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      if (acceptWrites) callback();
      // 不调用 callback 时数据永远「没消化完」，drain 不会自己来。
    },
  });
  const child = {
    stdin,
    stderr,
    on: events.on.bind(events),
    once: events.once.bind(events),
    kill() {},
  };

  return {
    child,
    stdin,
    stderr,
    exit(code = 1, text = '') {
      if (text !== '') stderr.write(text);
      events.emit('close', code, null);
    },
  };
}

function startWith(fake) {
  return startFfmpeg({
    args: ['-i', 'in.mp4', 'pipe:0', 'out.mp4'],
    spawnImpl: () => fake.child,
  });
}

// 验收项 4：编码器提前退出时渲染循环立刻结束并报错，不挂在 drain 上。
test('FFmpeg 提前退出：drain 永不到来的情况下渲染循环仍然结束并抛 FfmpegError', { timeout: 5000 }, async () => {
  const fake = fakeFfmpeg({ acceptWrites: false });
  const ffmpeg = startWith(fake);
  const preset = TINY;

  // 让假进程在第一次背压之后退出：这时帧循环正卡在 drain 上。
  let framesWritten = 0;
  const sink = {
    write(buffer) {
      framesWritten += 1;
      if (framesWritten === 1) {
        setImmediate(() => fake.exit(1, '[out#0/mp4 @ 0x7f] Error opening output /nope/final.mp4: No such file or directory\n'));
      }
      return ffmpeg.sink.write(buffer);
    },
    drain: ffmpeg.sink.drain,
  };

  const startedAt = Date.now();
  await assert.rejects(
    runFrameLoop({
      motion: FLAT_MOTION,
      preset,
      fps: 30,
      totalFrames: 900,
      static: emptyStatic(preset),
      sink,
    }),
    (error) => {
      assert.ok(error instanceof FfmpegError, `期望 FfmpegError，实际 ${error.name}`);
      assert.match(error.message, /FFmpeg 提前退出（退出码 1）/);
      assert.match(error.message, /No such file or directory/, '报错要带 FFmpeg 的 stderr 片段');
      return true;
    },
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3000, `应在毫秒级结束，实际 ${elapsed} ms`);
  assert.ok(framesWritten < 900, `不应把 900 帧都写下去，实际写了 ${framesWritten} 帧`);
});

// 正常背压：write 返回 false → 等 drain → 继续，一帧都不丢。
test('背压解除后继续写：帧数与字节数都不丢', { timeout: 5000 }, async () => {
  const fake = fakeFfmpeg();
  const ffmpeg = startWith(fake);
  const preset = TINY;
  const lengths = [];

  const loop = runFrameLoop({
    motion: FLAT_MOTION,
    preset,
    fps: 30,
    totalFrames: 5,
    static: emptyStatic(preset),
    sink: {
      write(buffer) {
        lengths.push(buffer.length);
        return ffmpeg.sink.write(buffer);
      },
      drain: ffmpeg.sink.drain,
    },
  });

  // 每帧写进去后都让假进程把缓冲吃掉，drain 才会来；直到帧循环结束。
  const timer = setInterval(() => {
    const { bufferedLength, writableLength } = fake.stdin;
    if (bufferedLength > 0 || writableLength > 0) {
      fake.stdin.emit('drain');
    }
  }, 1);
  timer.unref?.();

  const stats = await loop;
  clearInterval(timer);

  assert.equal(stats.frames, 5);
  assert.equal(stats.bytesWritten, preset.width * preset.height * 4 * 5);
  assert.deepEqual(lengths, Array(5).fill(preset.width * preset.height * 4));
});

// 退出之后再写必须立刻抛错：这是「循环在 FFmpeg 死后还继续跑」的最后一道闸。
test('FFmpeg 退出后继续写帧立即抛 FfmpegError', { timeout: 5000 }, async () => {
  const fake = fakeFfmpeg({ acceptWrites: false });
  const ffmpeg = startWith(fake);

  assert.equal(ffmpeg.sink.write(Buffer.alloc(8)), false, '假管道的背压必须真的触发');

  fake.exit(1, 'Conversion failed!\n');
  // 等 'close' 的回调跑完（exitInfo 在同一个 tick 之后标记）。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => ffmpeg.sink.write(Buffer.alloc(8)),
    (error) => {
      assert.ok(error instanceof FfmpegError);
      assert.match(error.message, /FFmpeg 已退出|FFmpeg 提前退出/);
      return true;
    },
  );
});

// 真 FFmpeg：管道里放多少帧，成片就是多少帧（零丢帧），且能正常解码。
test('真 FFmpeg 合成：45 帧进管道 → 成片 45 帧', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-ffmpeg-'));
  const inputPath = path.join(dir, 'src.mp4');
  const outputPath = path.join(dir, 'out.mp4');

  const make = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=108x192:r=30',
    '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    inputPath,
  ]);
  assert.equal(make.status, 0, make.stderr?.toString());

  await registerFonts();
  const preset = TINY;
  const totalFrames = 45;
  const ffmpeg = startFfmpeg({
    args: buildFfmpegArgs({
      inputPath,
      outputPath,
      width: preset.width,
      height: preset.height,
      fps: 30,
      totalFrames,
    }),
  });

  await runFrameLoop({
    motion: FLAT_MOTION,
    preset,
    fps: 30,
    totalFrames,
    static: emptyStatic(preset),
    sink: ffmpeg.sink,
  });
  await ffmpeg.finish();

  const probe = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,width,height',
    '-print_format', 'json', outputPath,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);

  const stream = JSON.parse(probe.stdout).streams[0];
  assert.equal(stream.width, 108);
  assert.equal(stream.height, 192);
  assert.equal(Number(stream.nb_read_frames), totalFrames);
});

// 验收项 4（真进程）：输出路径不可写时 FFmpeg 立刻失败，渲染循环退不出来就是 bug。
test('真 FFmpeg 输出路径不可写：渲染循环在有限时间内以 FfmpegError 结束', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-ffmpeg-'));
  const inputPath = path.join(dir, 'src.mp4');
  const outputPath = path.join(dir, 'no-such-dir', 'out.mp4');

  const make = spawnSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=108x192:r=30',
    '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    inputPath,
  ]);
  assert.equal(make.status, 0, make.stderr?.toString());

  await registerFonts();
  const preset = TINY;
  const ffmpeg = startFfmpeg({
    args: buildFfmpegArgs({
      inputPath,
      outputPath,
      width: preset.width,
      height: preset.height,
      fps: 30,
      totalFrames: 600,
    }),
  });

  const startedAt = Date.now();
  await assert.rejects(
    (async () => {
      try {
        await runFrameLoop({
          motion: FLAT_MOTION,
          preset,
          fps: 30,
          totalFrames: 600,
          static: emptyStatic(preset),
          sink: ffmpeg.sink,
        });
      } finally {
        ffmpeg.abort();
      }
    })(),
    (error) => {
      assert.ok(error instanceof FfmpegError);
      assert.match(error.message, /No such file or directory/);
      return true;
    },
  );

  assert.ok(Date.now() - startedAt < 20000, '必须在有限时间内结束');
});

// 验收项 5：受控慢消费者（假管道）下零丢帧，且帧循环不攒帧。
test('慢消费者：1080×1920 × 24 帧零丢帧，且同一时刻只有一帧在手上', { timeout: 60000 }, async () => {
  await registerFonts();
  const preset = resolvePreset('douyin-portrait');
  const staticLayer = prepareStatic(createCanvas({ width: preset.width, height: preset.height }).ctx, {
    preset,
    components: [],
    metrics: { availability: {} },
  });

  const totalFrames = 24;
  const bytesPerFrame = preset.width * preset.height * 4;
  const lengths = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const before = process.memoryUsage().rss;
  const stats = await runFrameLoop({
    motion: FLAT_MOTION,
    preset,
    fps: 30,
    totalFrames,
    static: staticLayer,
    sink: {
      async write(buffer) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        lengths.push(buffer.length);
        // 模拟慢消费者：不立刻接收，而是拖 2 ms。
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return true;
      },
    },
  });
  const growth = process.memoryUsage().rss - before;

  assert.equal(stats.frames, totalFrames);
  assert.equal(lengths.length, totalFrames);
  for (const length of lengths) assert.equal(length, bytesPerFrame);
  assert.equal(maxInFlight, 1, '同一时刻只能有一帧在写，不能攒帧');
  assert.ok(
    growth < bytesPerFrame * totalFrames / 2,
    `RSS 增长 ${growth} 字节，接近全部帧体积 ${bytesPerFrame * totalFrames}，说明帧被攒下来了`,
  );
});
