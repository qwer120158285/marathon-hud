/**
 * 帧循环（SPEC-v1 第 5 节、ADR 0006「时间轴同步」）。
 *
 * 期望值来源：
 * - 字节数 = W × H × 4 × 帧数（RGBA，每像素 4 字节），W/H 取画布预设；
 * - 第 n 帧的运动时刻 = n / fps + alignmentOffsetMs / 1000，与墙钟耗时无关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runFrameLoop, createCountingSink, readFrameRgba, FrameSizeError } from '../cli/frame-loop.mjs';
import { createCanvas, registerFonts } from '../cli/adapter.mjs';
import { buildMotion } from '../data/interpolate.mjs';
import { prepareStatic } from '../shared/hud.js';
import { resolveCanvasPreset, resolvePreset } from '../shared/presets.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/fixtures/sample.json'), 'utf8'));

/** 小画布预设：字节计数类用例用它，保持测试快速；几何规则与真实预设同源。 */
const TINY = resolveCanvasPreset({
  id: 'tiny',
  width: 108,
  height: 192,
  safeInset: { left: 0, right: 0, top: 0, bottom: 0 },
});

/** 只有一条采样点的运动数据，指标恒定。 */
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

/** 指标随时间变化：第 0/1/2 s 的心率分别是 140/150/160。 */
const CHANGING_MOTION = buildMotion([
  { tMs: 0, speedMps: 4, heartRateBpm: 140, cadenceSpm: 180, altitudeM: 20, powerWatts: null, lat: null, lon: null, distanceM: 0 },
  { tMs: 1000, speedMps: 4, heartRateBpm: 150, cadenceSpm: 170, altitudeM: 20, powerWatts: null, lat: null, lon: null, distanceM: 4 },
  { tMs: 2000, speedMps: 4, heartRateBpm: 160, cadenceSpm: 160, altitudeM: 20, powerWatts: null, lat: null, lon: null, distanceM: 8 },
], { kmMarkers: [] });

/** 空布局的静态层：只清屏，不画组件，字节数与绘制内容无关。 */
function emptyStaticLayer(preset) {
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  return prepareStatic(ctx, { preset, components: [], metrics: { availability: {} } });
}

/** 渲染一帧的字节数（RGBA）。 */
function bytesPerFrame(preset) {
  return preset.width * preset.height * 4;
}

// 验收项：RGBA 管道交出的是直通 alpha。半透明白必须保持 255 的 R/G/B，透明度只体现在 alpha 上。
// 预乘像素会把它压成 (107,107,107,107)，FFmpeg 按直通解释就会把路线这类浅色描边画暗。
test('帧循环交出直通 RGBA：半透明白的 R/G/B 保持 255，alpha 才表示透明度', () => {
  const { canvas, ctx } = createCanvas({ width: 4, height: 4 });
  ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
  ctx.fillRect(0, 0, 4, 4);

  const buffer = readFrameRgba(canvas);
  assert.equal(buffer.length, 4 * 4 * 4);
  const [r, g, b, a] = [...buffer.slice(0, 4)];
  assert.equal(r, 255);
  assert.equal(g, 255);
  assert.equal(b, 255);
  assert.ok(Math.abs(a - 107) <= 1, `alpha ${a} 应为 0.42 × 255 ≈ 107`);
});

test('写入字节数 = W × H × 4 × 帧数，且每次 write 恰好一帧', async () => {
  const lengths = [];
  const sink = {
    write(buffer) {
      lengths.push(buffer.length);
      return true;
    },
  };

  const result = await runFrameLoop({
    motion: FLAT_MOTION,
    preset: TINY,
    fps: 30,
    alignmentOffsetMs: 0,
    totalFrames: 5,
    static: emptyStaticLayer(TINY),
    sink,
  });

  assert.equal(result.frames, 5);
  assert.equal(result.bytesWritten, bytesPerFrame(TINY) * 5);
  assert.equal(lengths.length, 5);
  for (const length of lengths) assert.equal(length, bytesPerFrame(TINY));
});

test('计数 sink 统计的字节数与帧数和帧循环返回值一致', async () => {
  const sink = createCountingSink();

  const result = await runFrameLoop({
    motion: FLAT_MOTION,
    preset: TINY,
    fps: 30,
    totalFrames: 3,
    static: emptyStaticLayer(TINY),
    sink,
  });

  assert.equal(sink.frames, 3);
  assert.equal(sink.bytes, bytesPerFrame(TINY) * 3);
  assert.equal(result.bytesWritten, sink.bytes);
});

// #7 的背压要挂在 write 返回值上：异步 write 必须逐帧等待，不能并发堆积帧。
test('sink.write 返回 Promise 时逐帧等待，同一时刻只有一帧在写', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const sink = {
    async write() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return true;
    },
  };

  const result = await runFrameLoop({
    motion: FLAT_MOTION,
    preset: TINY,
    fps: 30,
    totalFrames: 4,
    static: emptyStaticLayer(TINY),
    sink,
  });

  assert.equal(result.frames, 4);
  assert.equal(maxInFlight, 1);
});

// 管道背压的同步形态：write 返回 false 时先等 drain，再画下一帧。
test('sink.write 返回 false 时等待 drain 后再继续', async () => {
  const events = [];
  const sink = {
    write() {
      events.push('write');
      return false;
    },
    async drain() {
      events.push('drain');
    },
  };

  const result = await runFrameLoop({
    motion: FLAT_MOTION,
    preset: TINY,
    fps: 30,
    totalFrames: 2,
    static: emptyStaticLayer(TINY),
    sink,
  });

  assert.equal(result.frames, 2);
  assert.deepEqual(events, ['write', 'drain', 'write', 'drain']);
});

// ADR 0006：帧号是唯一时钟，渲染快慢不得改变运动数据时间。
// 两次运行插入不同的每帧耗时，逐帧像素必须完全一致。
test('渲染耗时不同不影响每帧取值（帧号决定运动时刻）', async () => {
  await registerFonts();
  const preset = resolvePreset('douyin-portrait');
  const staticLayer = prepareStatic(createCanvas({ width: preset.width, height: preset.height }).ctx, {
    preset,
    components: SAMPLE.layout.components,
    metrics: { availability: CHANGING_MOTION.availability },
  });

  const run = async (delayMs) => {
    const frames = [];
    await runFrameLoop({
      motion: CHANGING_MOTION,
      preset,
      fps: 1,
      alignmentOffsetMs: 0,
      totalFrames: 3,
      static: staticLayer,
      sink: {
        async write(buffer) {
          frames.push(Buffer.from(buffer));
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return true;
        },
      },
    });
    return frames;
  };

  const fast = await run(0);
  const slow = await run(3);

  assert.equal(fast.length, 3);
  for (let i = 0; i < fast.length; i += 1) {
    assert.equal(Buffer.compare(fast[i], slow[i]), 0, `第 ${i} 帧与渲染耗时无关，应逐字节一致`);
  }
  // 三帧的内容确实不同，否则上面的比较等于没测（心率 140/150/160）。
  assert.notEqual(Buffer.compare(fast[0], fast[1]), 0);
  assert.notEqual(Buffer.compare(fast[1], fast[2]), 0);
});

// 应对齐偏移生效：偏移把第 0 帧推到 1 s，取到的是心率 150 那一帧。
test('对齐偏移参与运动时刻换算', async () => {
  await registerFonts();
  const preset = resolvePreset('douyin-portrait');
  const staticLayer = prepareStatic(createCanvas({ width: preset.width, height: preset.height }).ctx, {
    preset,
    components: SAMPLE.layout.components,
    metrics: { availability: CHANGING_MOTION.availability },
  });

  const render = async (alignmentOffsetMs) => {
    const frames = [];
    await runFrameLoop({
      motion: CHANGING_MOTION,
      preset,
      fps: 1,
      alignmentOffsetMs,
      totalFrames: 1,
      static: staticLayer,
      sink: { write(buffer) { frames.push(Buffer.from(buffer)); return true; } },
    });
    return frames[0];
  };

  const atZero = await render(0);
  const atOneSecond = await render(1000);

  assert.notEqual(Buffer.compare(atZero, atOneSecond), 0);
});

// 防御性检查：渲染画布尺寸必须等于画布预设（ADR 0003「HUD 帧与画布预设不一致 → 拒绝导出」）。
test('画布尺寸与预设不一致时抛 FrameSizeError，且不写入任何字节', async () => {
  let writes = 0;
  const badFactory = () => createCanvas({ width: 50, height: 50 });

  await assert.rejects(
    runFrameLoop({
      motion: FLAT_MOTION,
      preset: TINY,
      fps: 30,
      totalFrames: 3,
      static: emptyStaticLayer(TINY),
      sink: { write() { writes += 1; return true; } },
      createFrameCanvas: badFactory,
    }),
    (error) => {
      assert.ok(error instanceof FrameSizeError);
      assert.match(error.message, /HUD 帧尺寸 50×50，期望 108×192（画布预设 tiny）/);
      return true;
    },
  );
  assert.equal(writes, 0);
});

// 每帧的字节数必须与画布预设的 W×H×4 严格相等；不等就说明画布被换了尺寸或像素格式变了，
// 静默写进管道会让 FFmpeg 收到错位的帧。
test('单帧字节数与 W×H×4 不符时抛 FrameSizeError，且不把坏帧交给 sink', async () => {
  const { ctx } = createCanvas({ width: TINY.width, height: TINY.height });
  const badCanvas = {
    width: TINY.width,
    height: TINY.height,
    data: () => new Uint8ClampedArray(8),
  };
  let writes = 0;

  await assert.rejects(
    runFrameLoop({
      motion: FLAT_MOTION,
      preset: TINY,
      fps: 30,
      totalFrames: 3,
      static: emptyStaticLayer(TINY),
      sink: { write() { writes += 1; return true; } },
      createFrameCanvas: () => ({ canvas: badCanvas, ctx }),
    }),
    (error) => {
      assert.ok(error instanceof FrameSizeError);
      assert.match(error.message, /HUD 帧字节数 8，期望 82944（108×192×4，画布预设 tiny）/);
      return true;
    },
  );
  assert.equal(writes, 0);
});

// 进程内只持有 1–2 帧（Q5）。60 帧 @ 1080×1920 若累积，约为 497 MB；
// 允许 200 MB 的粗粒度余量，仍能把「累积所有帧」的实现区分出来。
test('帧循环不累积帧（60 帧的 RSS 增长远小于全部帧体积）', async () => {
  await registerFonts();
  const preset = resolvePreset('douyin-portrait');
  const staticLayer = prepareStatic(createCanvas({ width: preset.width, height: preset.height }).ctx, {
    preset,
    components: [],
    metrics: { availability: {} },
  });
  const totalFrames = 60;
  const allFramesBytes = bytesPerFrame(preset) * totalFrames;

  const before = process.memoryUsage().rss;
  const result = await runFrameLoop({
    motion: FLAT_MOTION,
    preset,
    fps: 30,
    totalFrames,
    static: staticLayer,
    sink: createCountingSink(),
  });
  const growth = process.memoryUsage().rss - before;

  assert.equal(result.bytesWritten, allFramesBytes);
  assert.ok(
    growth < allFramesBytes / 2,
    `RSS 增长 ${growth} 字节，接近全部帧体积 ${allFramesBytes}，说明帧被累积了`,
  );
});
