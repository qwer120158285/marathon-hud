/**
 * 帧循环（SPEC-v1 第 5 节）。
 *
 * 每帧：帧号 → 运动时刻（`n / fps + alignmentOffsetMs / 1000`）→ 插值取指标 →
 * `drawFrame` 画到复用画布 → 取出 RGBA → 交给 sink。帧号是唯一时钟，
 * 渲染快慢不改变运动数据时间（ADR 0006）。
 *
 * 进程内只持有 1–2 帧：动画帧画布复用同一张，取出的 RGBA 交给 sink 后即不再持有，
 * 不把帧存进数组。#7 把 sink 换成 FFmpeg 的 stdin 即可，背压挂在 `write` 的返回值上。
 */
import { createCanvas } from './adapter.mjs';
import { drawFrame } from '../shared/hud.js';
import { motionAtFrame } from '../data/interpolate.mjs';

/** HUD 帧尺寸与目标画布预设不一致（ADR 0003：拒绝导出）。 */
export class FrameSizeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameSizeError';
  }
}

/**
 * 计数 sink：只统计帧数与字节数，不保留任何缓冲（`--dry-run` 用）。
 * @returns {{ frames: number, bytes: number, write(buffer: Buffer): boolean }}
 */
export function createCountingSink() {
  return {
    frames: 0,
    bytes: 0,
    write(buffer) {
      this.frames += 1;
      this.bytes += buffer.length;
      return true;
    },
  };
}

/**
 * 跑完整帧循环。
 *
 * `sink.write(buf)` 的返回值约定（#7 的背压接缝）：
 * - 返回 `true` / `undefined`：已接收，继续下一帧；
 * - 返回 `false`：管道写满，帧循环会 `await sink.drain()` 后再继续；
 * - 返回 Promise：帧循环等它 resolve 后再画下一帧。
 *
 * @param {{
 *   motion: object, preset: object, fps: number, alignmentOffsetMs?: number,
 *   totalFrames: number, static: object,
 *   sink: { write(buffer: Buffer): boolean | void | Promise<unknown>, drain?(): Promise<unknown> },
 *   createFrameCanvas?: (size: { width: number, height: number }) => { canvas: object, ctx: object },
 * }} options
 * @returns {Promise<{ frames: number, bytesPerFrame: number, bytesWritten: number, width: number, height: number }>}
 */
export async function runFrameLoop({
  motion,
  preset,
  fps,
  alignmentOffsetMs = 0,
  totalFrames,
  static: staticLayer,
  sink,
  createFrameCanvas = createCanvas,
}) {
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new RangeError(`总帧数必须是正整数，实际为 ${totalFrames}`);
  }
  if (staticLayer === undefined || staticLayer === null) {
    throw new Error('runFrameLoop 需要 prepareStatic 返回的静态层（static 缺失）');
  }

  const { canvas, ctx } = createFrameCanvas({ width: preset.width, height: preset.height });
  if (canvas.width !== preset.width || canvas.height !== preset.height) {
    throw new FrameSizeError(
      `HUD 帧尺寸 ${canvas.width}×${canvas.height}，期望 ${preset.width}×${preset.height}（画布预设 ${preset.id}）`,
    );
  }

  const bytesPerFrame = preset.width * preset.height * 4;
  let bytesWritten = 0;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const { metrics } = motionAtFrame(motion, frame, { fps, alignmentOffsetMs });
    drawFrame(ctx, { preset, metrics, static: staticLayer });

    // RGBA，长度 = W×H×4。交出后不再被帧循环持有。
    const buffer = canvas.data();
    const pending = sink.write(buffer);

    if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') {
      await pending;
    } else if (pending === false) {
      if (typeof sink.drain !== 'function') {
        throw new Error('sink.write 返回 false 但 sink 没有 drain()，无法等待背压解除');
      }
      await sink.drain();
    }

    bytesWritten += buffer.length;
  }

  return { frames: totalFrames, bytesPerFrame, bytesWritten, width: preset.width, height: preset.height };
}
