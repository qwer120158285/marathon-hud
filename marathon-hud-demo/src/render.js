import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActivityCsv, sampleAt } from './csv.js';
import { createHudRenderer } from './hud.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const input = resolve(arg('--input', 'input.mp4'));
const csvFile = resolve(arg('--csv', 'activity.csv'));
const output = resolve(arg('--output', 'output.mp4'));
const fps = Number(arg('--fps', '30'));
const crf = Number(arg('--crf', '19'));
const preset = arg('--preset', 'medium');
const offsetMs = Number(arg('--offset-ms', '0'));
const encoder = arg('--encoder', 'libx264');

if (!existsSync(input)) throw new Error(`找不到输入视频: ${input}`);
if (!existsSync(csvFile)) throw new Error(`找不到运动数据 CSV: ${csvFile}`);
if (!Number.isFinite(fps) || fps <= 0) throw new Error('--fps 必须是正数');

function runProbe() {
  return new Promise((resolvePromise, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolvePromise(Number(out.trim())) : reject(new Error(err || `ffprobe exit ${code}`)));
  });
}

function ffmpegArgs(duration, width, height) {
  const filter = `[0:v]fps=${fps},setpts=PTS-STARTPTS[base];[1:v]setpts=PTS-STARTPTS,format=rgba[ov];[base][ov]overlay=0:0:format=auto:shortest=1[v]`;
  return [
    '-hide_banner', '-y', '-i', input,
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?',
    '-t', String(duration),
    '-c:v', encoder,
    ...(encoder === 'libx264' ? ['-preset', preset, '-crf', String(crf)] : ['-b:v', '12M']),
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', output
  ];
}

const duration = await runProbe();
if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长');
const rows = readActivityCsv(csvFile);
const totalFrames = Math.ceil(duration * fps);
const hud = createHudRenderer();
const frameBytes = hud.width * hud.height * 4;

console.log(`输入视频: ${basename(input)}`);
console.log(`时长: ${duration.toFixed(2)} 秒 | 帧率: ${fps} | 总帧数: ${totalFrames.toLocaleString()}`);
console.log(`运动数据: ${rows.length} 条 | 时间偏移: ${offsetMs} ms`);
console.log(`编码器: ${encoder} | 输出: ${output}`);
console.log('开始渲染...');

const ff = spawn('ffmpeg', ffmpegArgs(duration, hud.width, hud.height), { stdio: ['pipe', 'ignore', 'pipe'] });
let stderr = '';
ff.stderr.on('data', chunk => {
  stderr += chunk.toString();
  if (stderr.length > 20000) stderr = stderr.slice(-12000);
});
const ffClosed = once(ff, 'close');
let lastLog = Date.now();
const start = Date.now();

try {
  for (let frame = 0; frame < totalFrames; frame++) {
    const videoTimeMs = frame * 1000 / fps;
    const activityTimeMs = videoTimeMs + offsetMs;
    const metrics = sampleAt(rows, activityTimeMs);
    const pixels = hud.render(metrics, videoTimeMs, offsetMs);
    const buffer = Buffer.from(pixels.buffer, pixels.byteOffset, frameBytes);

    if (!ff.stdin.write(buffer)) await once(ff.stdin, 'drain');

    const now = Date.now();
    if (now - lastLog >= 1000 || frame === totalFrames - 1) {
      const elapsed = (now - start) / 1000;
      const renderFps = (frame + 1) / Math.max(elapsed, 0.001);
      const pct = ((frame + 1) / totalFrames * 100).toFixed(1);
      process.stdout.write(`\r进度 ${pct}% | ${frame + 1}/${totalFrames} 帧 | 生产 ${renderFps.toFixed(1)} FPS | 已耗时 ${elapsed.toFixed(1)}s   `);
      lastLog = now;
    }
  }
  ff.stdin.end();
  const [code, signal] = await ffClosed;
  if (code !== 0) throw new Error(`FFmpeg 失败 (code=${code}, signal=${signal})\n${stderr}`);
  const elapsed = (Date.now() - start) / 1000;
  console.log(`\n完成：${output}`);
  console.log(`总耗时：${elapsed.toFixed(1)} 秒 | 相对实时速度：${(duration / elapsed).toFixed(2)}x`);
} catch (error) {
  ff.stdin.destroy();
  ff.kill('SIGTERM');
  await ffClosed.catch(() => {});
  throw error;
}
