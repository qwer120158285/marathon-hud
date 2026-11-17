/**
 * FFmpeg 合成：参数拼装 + 进程管理 + 背压 + 提前退出（SPEC-v1 第 5 节、ADR 0003）。
 *
 * 双输入合成：源视频（`-i <path>`）+ HUD 的 RGBA 管道（`-f rawvideo … -i pipe:0`），
 * 用 `overlay` 叠在 0:0。工具绝不改变构图，所以参数里不允许出现 scale / crop / pad。
 *
 * 背压与提前退出：
 * - `sink.write(buf)` 直接转发 `stdin.write`，返回 false 表示管道写满；
 * - `sink.drain()` 用 `Promise.race([once(stdin, 'drain'), exitInfo])` 等待——
 *   FFmpeg 中途退出时 `drain` 可能永远不来，只有 exit 能解开这个等待；
 * - 退出后继续 `write` 会立刻抛错，渲染循环因此结束，不会挂在 pipe 上。
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** stderr 只保留尾部这么多字符：报错要带 FFmpeg 原文，但不能无限涨。 */
const STDERR_TAIL_LIMIT = 4000;

/** FFmpeg 启动失败 / 非零退出 / 提前退出统一用这个错误类型，由 CLI 转成退出码 3。 */
export class FfmpegError extends Error {
  constructor(message, { code = null, signal = null, stderr = '' } = {}) {
    super(message);
    this.name = 'FfmpegError';
    this.exitCode = code;
    this.signal = signal;
    this.stderr = stderr;
  }
}

/** 保留字符串尾部 `limit` 个字符。 */
function tail(text, limit) {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/** stderr 原文 → 报错里的最后几行（去掉空行，最多 10 行）。 */
function stderrExcerpt(stderr) {
  const lines = stderr.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
  return lines.slice(-10).join('\n');
}

/**
 * 拼装 FFmpeg 参数。
 *
 * 滤镜链与 marathon-hud-demo 已验证的形状一致：
 * `[0:v]fps=fps,setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS,format=rgba[ov];[base][ov]overlay=0:0:format=auto:shortest=1[v]`
 *
 * - `fps` 滤镜把源视频锁到与 HUD 相同的恒定帧率（时间轴同步的硬要求）；
 * - `shortest=1` 让成片长度由 RGBA 管道的帧数决定，不跟着源视频尾巴拖长；
 * - `-map 0:a?` 里的 `?` 表示源视频没有音轨时也不报错。
 *
 * @param {{
 *   inputPath: string, outputPath: string, width: number, height: number,
 *   fps: number, totalFrames: number, codec?: string, pixFmt?: string,
 *   crf?: number, x264Preset?: string, audioBitrate?: string,
 * }} options
 * @returns {string[]}
 */
export function buildFfmpegArgs({
  inputPath,
  outputPath,
  width,
  height,
  fps,
  totalFrames,
  codec = 'libx264',
  pixFmt = 'yuv420p',
  crf = 19,
  x264Preset = 'medium',
  audioBitrate = '192k',
}) {
  if (!Number.isInteger(totalFrames) || totalFrames <= 0) {
    throw new RangeError(`总帧数必须是正整数，实际为 ${totalFrames}`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new RangeError(`帧率必须是正数，实际为 ${fps}`);
  }
  for (const value of [width, height]) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`画布尺寸必须是正整数，实际为 ${width} × ${height}`);
    }
  }

  const filter = [
    `[0:v]fps=${fps},setpts=PTS-STARTPTS[base]`,
    '[1:v]setpts=PTS-STARTPTS,format=rgba[ov]',
    '[base][ov]overlay=0:0:format=auto:shortest=1[v]',
  ].join(';');

  // 输出时长 = 总帧数 / 帧率：帧号是唯一时钟，成片长度不依赖源视频容器的时长字段。
  const durationSec = totalFrames / fps;

  return [
    '-hide_banner',
    // 只要错误级别的日志：stderr 里就只剩真正的故障，报错片段不会被输入元数据淹没。
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '0:a?',
    '-t', String(Number(durationSec.toFixed(6))),
    '-c:v', codec,
    '-preset', x264Preset,
    '-crf', String(crf),
    '-pix_fmt', pixFmt,
    '-c:a', 'aac',
    '-b:a', audioBitrate,
    '-movflags', '+faststart',
    outputPath,
  ];
}

/**
 * 启动 FFmpeg 并返回挂在帧循环上的 sink。
 *
 * `spawnImpl` 是进程边界的测试接缝（默认 `child_process.spawn`），
 * 假进程同样要提供 `stdin` / `stderr` / `on` / `kill`。
 *
 * @param {{
 *   args: string[], ffmpegPath?: string, spawnImpl?: typeof spawn,
 *   stderrLimit?: number,
 * }} options
 * @returns {{
 *   args: string[], child: object,
 *   sink: { write(buffer: Buffer): boolean, drain(): Promise<void> },
 *   finish(): Promise<void>, abort(): void, stderr(): string,
 * }}
 */
export function startFfmpeg({ args, ffmpegPath = 'ffmpeg', spawnImpl = spawn, stderrLimit = STDERR_TAIL_LIMIT }) {
  const child = spawnImpl(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });

  let stderr = '';
  let failure = null;
  let exited = false;
  let pipeError = null;

  child.stderr?.on('data', (chunk) => {
    stderr = tail(stderr + chunk.toString(), stderrLimit);
  });

  // 管道写进已关闭的进程会拿到 EPIPE / ERR_STREAM_DESTROYED。这里必须消费掉这个
  // 事件：没有监听器时 EventEmitter 会把它变成未捕获异常，盖住真正的 FFmpeg 错误。
  // 刻意不在这里下结论：EPIPE 只是「进程没了」的副作用，真正的原因（打开输出失败、
  // 编码器崩）要等 stderr 写完之后才完整，所以报错统一在 close 之后拼。
  child.stdin?.on('error', (error) => {
    pipeError = pipeError ?? error;
  });

  // 永不 reject：两个分支都用 then 转换成标签，避免 race 里留下未处理的拒绝。
  const exitInfo = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal, spawnError: null }));
    child.once('error', (error) => resolve({ code: null, signal: null, spawnError: error }));
  });

  exitInfo.then(() => { exited = true; });

  function exitError(info) {
    if (info.spawnError !== null) {
      return new FfmpegError(
        `无法启动 FFmpeg（${ffmpegPath}）：${info.spawnError.message}`,
        { stderr },
      );
    }
    const reason = info.code === 0
      ? '未写完所有帧就退出了'
      : `退出码 ${info.code}${info.signal === null ? '' : `，信号 ${info.signal}`}`;
    const excerpt = stderrExcerpt(stderr);
    return new FfmpegError(
      `FFmpeg 提前退出（${reason}）${excerpt === '' ? '' : `\n${excerpt}`}`,
      { code: info.code, signal: info.signal, stderr },
    );
  }

  /**
   * 管道已断：等进程 close 之后用完整 stderr 拼错误。
   * 返回 rejected Promise 而不是同步抛，是因为此刻 stderr 还没收齐。
   */
  function pipeFailure() {
    return exitInfo.then((info) => {
      failure = info.spawnError === null && info.code === 0
        ? new FfmpegError(
          `写入 FFmpeg 的 RGBA 管道失败：${pipeError?.message ?? '管道已关闭'}`
            + `${stderrExcerpt(stderr) === '' ? '' : `\n${stderrExcerpt(stderr)}`}`,
          { stderr },
        )
        : exitError(info);
      throw failure;
    });
  }

  function write(buffer) {
    if (failure !== null) throw failure;
    if (pipeError !== null) return pipeFailure();
    if (exited) {
      failure = new FfmpegError('FFmpeg 已退出，渲染循环停止写帧', { stderr });
      throw failure;
    }

    let accepted;
    try {
      accepted = child.stdin.write(buffer);
    } catch (error) {
      pipeError = error;
      return pipeFailure();
    }
    // 管道在写的同时被关掉时，Node 只会在下一个 tick 报 error；这里提前知道就提前停。
    if (pipeError !== null) return pipeFailure();
    return accepted;
  }

  async function drain() {
    if (failure !== null) throw failure;

    const drained = once(child.stdin, 'drain');
    // race 的落败方仍可能 reject（stdin 出错时 once 会 reject），先接住，避免未处理拒绝。
    drained.catch(() => {});

    const winner = await Promise.race([
      drained.then(() => 'drain', () => 'drain'),
      exitInfo.then(() => 'exit'),
    ]);

    if (winner === 'exit' || pipeError !== null) {
      failure = failure ?? exitError(await exitInfo);
      throw failure;
    }
    if (failure !== null) throw failure;
  }

  async function finish() {
    if (failure !== null) {
      abort();
      throw failure;
    }

    child.stdin.end();
    const info = await exitInfo;
    // 管道中途断过，即使退出码是 0 也不算写完整。
    if (info.spawnError !== null || info.code !== 0 || pipeError !== null) {
      failure = failure ?? exitError(info);
      throw failure;
    }
  }

  function abort() {
    try {
      child.stdin?.destroy();
    } catch {
      // 已经关掉的管道，忽略。
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // 进程已经没了，忽略。
    }
  }

  return {
    args,
    child,
    sink: { write, drain },
    finish,
    abort,
    stderr: () => stderr,
  };
}
