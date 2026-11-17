/**
 * 源视频规格探测与比对（ADR 0003「尺寸校验」、SPEC-v1 第 4 节第 4 步）。
 *
 * 工具绝不 scale / crop / pad：源视频规格与目标画布不一致就拒绝导出，
 * 并报出实际值与期望值。分辨率一致不等于画幅一致（1920×1080 与 1080×1920
 * 像素总数相同），所以 width / height / SAR / DAR 分别比较，并检查旋转元数据。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** 源视频缺失或 ffprobe 无法解析：属于「数据源缺失」，由 CLI 转成退出码 4。 */
export class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeError';
  }
}

/** 四分之一圈（90 / 270 / -90 / -270）才交换宽高；180° 不交换。 */
export function isQuarterTurn(rotation) {
  return Math.abs(rotation) % 180 === 90;
}

/** `"9:16"` → 0.5625；`"0:1"` / `"N/A"` / 非法值 → null（ffmpeg 用 0:1 表示未知）。 */
function parseRatio(value) {
  if (typeof value !== 'string') return null;
  const [numerator, denominator] = value.split(':').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

/** 宽高 → 最简比例文本，例如 1080×1920 → `9:16`。 */
function ratioLabel(width, height) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/**
 * 解析 `ffprobe -show_streams -show_format -of json` 的输出。
 *
 * 旋转标记优先取 `side_data_list`（Display Matrix，ffprobe 4.4.1 的现行位置），
 * 兼容旧版 / mov 容器的 `tags.rotate`。旋转角保留原始符号，只在比对时判断是否四分之一圈。
 *
 * @param {{ streams?: object[], format?: object }} json
 * @returns {{ width: number, height: number, sar: string, dar: string, rotation: number, durationSec: number }}
 */
export function parseProbeJson(json) {
  const stream = (json.streams ?? []).find((entry) => entry.codec_type === 'video');
  if (stream === undefined) {
    throw new ProbeError('源视频里没有视频流');
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ProbeError(`源视频分辨率不可用（${stream.width}×${stream.height}）`);
  }

  const sideDataRotation = (stream.side_data_list ?? [])
    .map((entry) => Number(entry.rotation))
    .find((value) => Number.isFinite(value));
  const legacyRotation = Number(stream.tags?.rotate);
  const rotation = sideDataRotation ?? (Number.isFinite(legacyRotation) ? legacyRotation : 0);

  const durationSec = Number(stream.duration ?? json.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new ProbeError('源视频没有可用的时长，无法换算出总帧数');
  }

  return {
    width,
    height,
    sar: stream.sample_aspect_ratio ?? '0:1',
    dar: stream.display_aspect_ratio ?? '0:1',
    rotation,
    durationSec,
  };
}

/**
 * 用 ffprobe 读取源视频规格。
 * @param {string} filePath
 * @param {{ ffprobePath?: string }} [options]
 */
export function probeVideo(filePath, { ffprobePath = 'ffprobe' } = {}) {
  if (!existsSync(filePath)) {
    throw new ProbeError(`无法读取源视频：${filePath}（文件不存在）`);
  }

  const result = spawnSync(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    filePath,
  ], { encoding: 'utf8' });

  if (result.error !== undefined) {
    throw new ProbeError(`无法启动 ffprobe：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? `退出码 ${result.status}`;
    throw new ProbeError(`ffprobe 无法解析源视频：${filePath}（${detail}）`);
  }

  let json;
  try {
    json = JSON.parse(result.stdout);
  } catch (error) {
    throw new ProbeError(`ffprobe 输出不是合法 JSON：${filePath}（${error.message}）`);
  }

  return parseProbeJson(json);
}

/**
 * 源视频规格 × 目标画布预设 → 不匹配项（空数组表示通过）。
 *
 * 旋转四分之一圈时按互换后的宽高比对；DAR 也按编码方向比较
 * （旋转 90° 的 1920×1080 素材，DAR 仍是编码画面的 16:9）。
 *
 * @param {{ width: number, height: number, sar: string, dar: string, rotation: number }} actual
 * @param {{ id: string, width: number, height: number }} preset
 * @returns {string[]}
 */
export function compareVideoSpec(actual, preset) {
  const issues = [];
  const rotated = isQuarterTurn(actual.rotation);
  const effectiveWidth = rotated ? actual.height : actual.width;
  const effectiveHeight = rotated ? actual.width : actual.height;
  const rotationNote = actual.rotation === 0 ? '' : `（旋转 ${actual.rotation}°）`;
  const presetNote = `（画布预设 ${preset.id}）`;

  if (effectiveWidth !== preset.width || effectiveHeight !== preset.height) {
    issues.push(
      `源视频 ${actual.width}×${actual.height}${rotationNote}，`
        + `期望 ${preset.width}×${preset.height}${presetNote}`,
    );
  }

  // SAR 0:1 是 ffmpeg 的「未标注」，按方形像素处理；其余必须严格 1:1。
  const sar = parseRatio(actual.sar);
  if (sar !== null && Math.abs(sar - 1) > 0.001) {
    issues.push(`源视频 SAR ${actual.sar}，期望 1:1${presetNote}`);
  }

  // DAR 描述编码画面的显示比例；旋转 90° 时编码画面仍是横的。
  const expectedDar = rotated
    ? ratioLabel(preset.height, preset.width)
    : ratioLabel(preset.width, preset.height);
  const dar = parseRatio(actual.dar);
  if (dar !== null) {
    const expected = rotated ? preset.height / preset.width : preset.width / preset.height;
    if (Math.abs(dar - expected) > 0.01) {
      issues.push(`源视频 DAR ${actual.dar}，期望 ${expectedDar}${presetNote}`);
    }
  }

  return issues;
}
