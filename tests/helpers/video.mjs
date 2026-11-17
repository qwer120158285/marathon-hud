/**
 * 测试用源视频生成：用 ffmpeg 现场造小素材（`*.mp4` 不进 Git 历史）。
 *
 * 同一进程内按 key 缓存，避免每个用例重复编码；文件落在系统临时目录。
 * 视频尺寸 / 旋转 / SAR 都是 ffprobe 的实测事实，不用手写 JSON 冒充。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { REPO_ROOT } from './cli.mjs';

const cache = new Map();
let workDir = null;

/** 临时工作目录（整个测试进程共用一个）。 */
export function videoWorkDir() {
  if (workDir === null) workDir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-video-'));
  return workDir;
}

function runFfmpeg(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`生成测试视频失败：ffmpeg ${args.join(' ')}\n${result.stderr}`);
  }
}

/**
 * 生成一段纯色测试视频。
 *
 * @param {{ key: string, width: number, height: number, seconds?: number, fps?: number,
 *           sar?: string, rotation?: number }} options
 * @returns {string} 绝对路径
 */
export function makeVideo({ key, width, height, seconds = 1, fps = 30, sar = null, rotation = null }) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const dir = videoWorkDir();
  const plain = path.join(dir, `${key}.mp4`);
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`,
    '-t', String(seconds)];
  if (sar !== null) args.push('-vf', `setsar=${sar}`);
  args.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', plain);
  runFfmpeg(args);

  let result = plain;
  if (rotation !== null) {
    const rotated = path.join(dir, `${key}-rot${rotation}.mp4`);
    runFfmpeg(['-v', 'error', '-y', '-i', plain, '-c', 'copy',
      '-metadata:s:v:0', `rotate=${rotation}`, rotated]);
    result = rotated;
  }

  cache.set(key, result);
  return result;
}

/**
 * 以合法 fixture 为起点，配上一段真实源视频，写到临时目录。
 *
 * `tcx.path` 改成指向仓库里的真实样本（相对 project.json 所在目录），
 * 这样 CLI 的 Schema / 联合校验 / 数据源校验都能真实跑通。
 *
 * @param {string} videoPath makeVideo 的返回值
 * @param {(project: object) => void} [mutate]
 * @returns {string} project.json 的绝对路径
 */
export function projectWithVideo(videoPath, mutate = () => {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-dry-run-'));
  const project = JSON.parse(readFileSync(path.join(REPO_ROOT, 'tests/fixtures/project.valid.json'), 'utf8'));

  project.sourceVideo = { path: path.relative(dir, videoPath) };
  project.tcx = { path: path.relative(dir, path.join(REPO_ROOT, 'activity_662602587.tcx')) };
  mutate(project);

  const file = path.join(dir, 'project.json');
  writeFileSync(file, JSON.stringify(project, null, 2));
  return file;
}
