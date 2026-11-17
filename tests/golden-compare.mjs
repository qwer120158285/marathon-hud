/**
 * 基准图比对（ADR 0001）。
 *
 * 口径分两类（ADR 0001 修订记录，2026-11-17）：
 *
 * 1. **非文字区域**（组件边界矩形与其中除文字框外的留白、底板、描边）：原始像素比较，
 *    RGBA 任一通道偏差 > 8/255 计为差异像素；全图 ≤1%、关键区域 ≤0.2%。
 * 2. **文字区域**（文字实际绘制包围盒）：四项判据——
 *    几何（墨迹质心 ≤1 px、支撑包围盒 ≤1 px、字形轮廓距离 ≤1 px）、
 *    内容（列 / 行墨迹剖面的相关系数 ≥0.98 与归一化 L1 ≤0.05）、
 *    墨量总量（相对差 ≤20%，只作整体兜底）、
 *    粗降采样（12× 盒式、整框墨量归一化后逐格 8/255，差异格 ≤6%）。
 *
 * 为什么不是「降采样后逐像素」一刀切：Chrome 在 macOS 走 CoreText、`@napi-rs/canvas` 走 Skia，
 * 两端笔画粗细系统性相差约 0.5 px，差异沿整条字形边缘分布。2×–8× 降采样实测反而把差异摊到
 * 更多格子上（19%–27%），比「换一个数字」的差异（3.7%–9.5%）还大，判据在该档位无法分离；
 * 只有 12× 且先做整框墨量归一化，才能让跨光栅器差异（3.6%）与换数字（8.4%）分开。
 * 所以像素判据退居兜底（抓整体丢失 / 错位 / 换字号），内容细差由剖面判据承担。
 * 标定数据与阈值见下方各常量注释；失败用例在 `tests/golden.test.mjs`。
 * 内容与字体属性另由「两端共用 shared/ + 同一 fixture + FONTS.json SHA-256」保证。
 *
 * 关键区域 = 每个组件边界矩形外扩 8 px ∪ 文字实际绘制包围盒（含保护带），
 * 由 shared/hud.js 的 collectCriticalRegions 给出（`kind` 区分组件矩形与文字框）。
 *
 * PNG 解码用 node:zlib 手写（只支持非隔行 8 bit），避免引入运行时依赖，
 * 也避免经过任何画布重采样——比对必须看到文件里的原始像素。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, registerFonts } from '../cli/adapter.mjs';
import { collectCriticalRegions } from '../shared/hud.js';
import { resolvePreset } from '../shared/presets.js';
import { loadSample, goldenPath, GOLDEN_SAMPLE_ID } from './golden-generate.mjs';

/** 单通道绝对偏差上限（8/255）：超过即计为差异像素。 */
export const MAX_CHANNEL_DELTA = 8;
/** 非文字全图允许的差异像素比例。 */
export const FULL_MAX_DIFF_RATIO = 0.01;
/** 非文字关键区域允许的差异像素比例。 */
export const CRITICAL_MAX_DIFF_RATIO = 0.002;
/** 文字框：墨迹质心最大偏移（px），同时代表位置与基线偏移。 */
export const TEXT_MAX_CENTROID_PX = 1;
/** 文字框：墨迹支撑包围盒起点与宽高的最大偏差（px）。 */
export const TEXT_MAX_BBOX_DELTA_PX = 1;
/** 文字框：字形轮廓最大距离（px）。 */
export const TEXT_MAX_OUTLINE_PX = 1;
/**
 * 文字框降采样的盒式边长（px）。
 *
 * 标定过程（2026-11-17，Node 与 Chrome 各出一张 PNG，逐档实测）：
 * 2× / 3× / 4× / 6× / 8× 下，跨光栅器差异（19%–27%）**高于**「换一个数字」的差异（3.7%–9.5%），
 * 判据在该档位完全无法分离；原因是两端字形笔画粗细系统性相差约 0.5 px，
 * 差异沿整条笔画边缘分布，取小窗平均反而把它摊到更多格子上。
 * 到 12× 并先做整框墨量归一化，跨光栅器差异降到 3.6%，换数字升到 8.4%，才可分离。
 * 因此降采样只作为「兜底」判据（文字整体丢失、错位、换字号这类粗错），
 * 内容细差由列 / 行墨迹剖面的相关系数与 L1 距离承担。
 */
export const TEXT_COARSE_DOWNSAMPLE_FACTOR = 12;
/** 文字框粗降采样（归一化后）允许的差异格比例：实测跨光栅器 3.61%，换数字 8.43%，取 6%。 */
export const TEXT_MAX_COARSE_DIFF_RATIO = 0.06;
/** 文字框墨迹总量相对差上限：只作整体兜底（实测跨光栅器 11.45%，字重换一档 >40%）。 */
export const TEXT_MAX_INK_DELTA = 0.2;
/** 文字框列 / 行墨迹剖面相关系数下限：内容是否同一串字（实测跨光栅器 0.9944，换数字 0.9588）。 */
export const TEXT_MIN_PROFILE_CORRELATION = 0.98;
/** 文字框列 / 行墨迹剖面归一化 L1 距离上限（实测跨光栅器 0.0365，换数字 0.0662）。 */
export const TEXT_MAX_PROFILE_L1 = 0.05;

/**
 * 文字压在底板上，Alpha 到处都是底板的值，所以「墨迹」不能按 Alpha 判，
 * 而按「与文字框背景色的单通道最大距离」判：背景色取文字框内出现最多的 RGBA。
 */
const INK_WEIGHT_FLOOR = 8;
/** 墨迹支撑集阈值：用于轮廓（Hausdorff）比较。 */
const INK_SUPPORT_THRESHOLD = 24;

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * 解码 PNG 为 RGBA8。
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('不是 PNG 文件：文件头签名不匹配');
  }

  let offset = 8;
  let header = null;
  const idatChunks = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (header === null) throw new Error('PNG 缺少 IHDR 块');
  if (header.bitDepth !== 8) throw new Error(`PNG 位深 ${header.bitDepth} 不受支持，只支持 8 bit`);
  if (header.interlace !== 0) throw new Error('PNG 使用了隔行扫描，不受支持');

  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (channels === undefined) {
    throw new Error(`PNG 颜色类型 ${header.colorType} 不受支持`);
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = header.width * channels;
  const pixels = new Uint8Array(stride * header.height);
  let previous = new Uint8Array(stride);

  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const current = new Uint8Array(stride);
    unfilterRow(filter, line, previous, current, channels);
    pixels.set(current, row * stride);
    previous = current;
  }

  return { width: header.width, height: header.height, data: toRgba(pixels, header.width, header.height, channels) };
}

function unfilterRow(filter, line, previous, current, channels) {
  for (let i = 0; i < line.length; i += 1) {
    const left = i >= channels ? current[i - channels] : 0;
    const up = previous[i];
    const upLeft = i >= channels ? previous[i - channels] : 0;
    let value = line[i];

    switch (filter) {
      case 0: break;
      case 1: value += left; break;
      case 2: value += up; break;
      case 3: value += (left + up) >> 1; break;
      case 4: value += paeth(left, up, upLeft); break;
      default: throw new Error(`PNG 行过滤类型 ${filter} 不受支持`);
    }

    current[i] = value & 0xff;
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

/** 统一转 RGBA，灰度与无 Alpha 的 PNG 补成 255，保证 Alpha 参与比较。 */
function toRgba(pixels, width, height, channels) {
  if (channels === 4) return pixels;

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels;
    const to = index * 4;
    if (channels === 1 || channels === 2) {
      rgba[to] = pixels[from];
      rgba[to + 1] = pixels[from];
      rgba[to + 2] = pixels[from];
      rgba[to + 3] = channels === 2 ? pixels[from + 1] : 255;
    } else {
      rgba[to] = pixels[from];
      rgba[to + 1] = pixels[from + 1];
      rgba[to + 2] = pixels[from + 2];
      rgba[to + 3] = 255;
    }
  }
  return rgba;
}

/** 把矩形列表栅格化成布尔掩码；重复区域只算一次。 */
export function rasterizeRegions(regions, width, height) {
  const mask = new Uint8Array(width * height);

  for (const region of regions) {
    const x0 = Math.max(0, Math.floor(region.x));
    const y0 = Math.max(0, Math.floor(region.y));
    const x1 = Math.min(width, Math.ceil(region.x + region.width));
    const y1 = Math.min(height, Math.ceil(region.y + region.height));
    for (let y = y0; y < y1; y += 1) {
      mask.fill(1, y * width + x0, y * width + x1);
    }
  }

  let pixels = 0;
  for (const value of mask) pixels += value;
  return { mask, pixels };
}

/** 同一坐标上的单通道最大绝对偏差。 */
function channelDelta(actual, expected, index) {
  let delta = 0;
  for (let channel = 0; channel < 4; channel += 1) {
    const diff = Math.abs(actual.data[index + channel] - expected.data[index + channel]);
    if (diff > delta) delta = diff;
  }
  return delta;
}

/** 文字框裁剪到画布内的像素范围。 */
function regionBounds(region, width, height) {
  return {
    x0: Math.max(0, Math.floor(region.x)),
    y0: Math.max(0, Math.floor(region.y)),
    x1: Math.min(width, Math.ceil(region.x + region.width)),
    y1: Math.min(height, Math.ceil(region.y + region.height)),
  };
}

/** 文字框背景色：取框内出现次数最多的 RGBA（保护带保证一定有底板像素）。 */
function regionBackground(image, region) {
  const { x0, y0, x1, y1 } = regionBounds(region, image.width, image.height);
  const counts = new Map();

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * image.width + x) * 4;
      const key = (image.data[index] << 24) | (image.data[index + 1] << 16)
        | (image.data[index + 2] << 8) | image.data[index + 3];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let bestKey = 0;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }

  return [
    (bestKey >>> 24) & 0xff,
    (bestKey >>> 16) & 0xff,
    (bestKey >>> 8) & 0xff,
    bestKey & 0xff,
  ];
}

/** 单个像素的「墨量权重」：与背景色的最大单通道距离。 */
function inkWeight(image, x, y, background) {
  const index = (y * image.width + x) * 4;
  let distance = 0;
  for (let channel = 0; channel < 4; channel += 1) {
    const diff = Math.abs(image.data[index + channel] - background[channel]);
    if (diff > distance) distance = diff;
  }
  return distance;
}

/**
 * 文字框的墨迹场：每个像素的墨量权重（与背景色的最大单通道距离，低于噪声门限记 0）。
 *
 * 之所以不用 Alpha：文字压在底板上，Alpha 全是底板的值；用「离背景色多远」才能把字形量出来。
 */
function inkField(image, region, background) {
  const { x0, y0, x1, y1 } = regionBounds(region, image.width, image.height);
  const width = x1 - x0;
  const height = y1 - y0;
  const weights = new Float64Array(width * height);
  let total = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const raw = inkWeight(image, x0 + x, y0 + y, background);
      const weight = raw < INK_WEIGHT_FLOOR ? 0 : raw;
      weights[y * width + x] = weight;
      total += weight;
    }
  }

  return { weights, width, height, x0, y0, total };
}

/** 墨迹质心。 */
function fieldCentroid(field) {
  let sum = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      const weight = field.weights[y * field.width + x];
      if (weight === 0) continue;
      sum += weight;
      sumX += (field.x0 + x) * weight;
      sumY += (field.y0 + y) * weight;
    }
  }
  return sum === 0 ? null : { x: sumX / sum, y: sumY / sum };
}

/** 墨迹支撑集：权重 ≥ 阈值的像素坐标集合。 */
function supportSet(field) {
  const points = new Uint8Array(field.width * field.height);
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      if (field.weights[y * field.width + x] >= INK_SUPPORT_THRESHOLD) points[y * field.width + x] = 1;
    }
  }
  return points;
}

/**
 * 墨迹支撑包围盒（绝对画布坐标）。
 *
 * 用支撑集本身而不是投影峰值比例：支撑集已经滤掉最外侧的淡淡抗锯齿，
 * 包围盒因此对平台覆盖值差异不敏感，只随「文字真的挪了 / 字真的变宽了」而变。
 */
function supportBounds(field) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) {
      if (field.weights[y * field.width + x] < INK_SUPPORT_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x0: field.x0 + minX, y0: field.y0 + minY, x1: field.x0 + maxX, y1: field.y0 + maxY };
}

/**
 * 字形轮廓距离：两侧支撑集的双向 Hausdorff 距离（Chebyshev，超过 1 px 记 2）。
 * 只判断「笔画落在哪一带」，不要求每个边缘像素的覆盖值相同。
 */
function supportDistance(aField, bField) {
  const a = supportSet(aField);
  const b = supportSet(bField);
  let aCount = 0;
  let bCount = 0;
  for (const value of a) aCount += value;
  for (const value of b) bCount += value;
  if (aCount === 0 || bCount === 0) return Number.POSITIVE_INFINITY;

  const hasNear = (set, x, y) => {
    for (let dy = -TEXT_MAX_OUTLINE_PX; dy <= TEXT_MAX_OUTLINE_PX; dy += 1) {
      for (let dx = -TEXT_MAX_OUTLINE_PX; dx <= TEXT_MAX_OUTLINE_PX; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= aField.width || ny >= aField.height) continue;
        if (set[ny * aField.width + nx] === 1) return true;
      }
    }
    return false;
  };

  let worst = 0;
  for (let y = 0; y < aField.height; y += 1) {
    for (let x = 0; x < aField.width; x += 1) {
      if (a[y * aField.width + x] === 1 && !hasNear(b, x, y)) worst = TEXT_MAX_OUTLINE_PX + 1;
      if (b[y * aField.width + x] === 1 && !hasNear(a, x, y)) worst = TEXT_MAX_OUTLINE_PX + 1;
    }
  }
  return worst;
}

/** 列方向墨迹投影。 */
function columnProfile(field) {
  const profile = new Float64Array(field.width);
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) profile[x] += field.weights[y * field.width + x];
  }
  return profile;
}

/** 行方向墨迹投影。 */
function rowProfile(field) {
  const profile = new Float64Array(field.height);
  for (let y = 0; y < field.height; y += 1) {
    for (let x = 0; x < field.width; x += 1) profile[y] += field.weights[y * field.width + x];
  }
  return profile;
}

/** 归一化投影的皮尔逊相关：只看形状，不看整体浓淡。 */
function profileCorrelation(a, b) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  const peakA = Math.max(...a) || 1;
  const peakB = Math.max(...b) || 1;

  let meanA = 0;
  let meanB = 0;
  for (let index = 0; index < length; index += 1) {
    meanA += a[index] / peakA;
    meanB += b[index] / peakB;
  }
  meanA /= length;
  meanB /= length;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < length; index += 1) {
    const u = a[index] / peakA - meanA;
    const v = b[index] / peakB - meanB;
    covariance += u * v;
    varianceA += u * u;
    varianceB += v * v;
  }

  return varianceA === 0 || varianceB === 0 ? 0 : covariance / Math.sqrt(varianceA * varianceB);
}

/** 归一化投影的 L1 距离（0 = 分布完全同形，1 = 完全不重叠）。 */
function profileL1(a, b) {
  const length = Math.min(a.length, b.length);
  let totalA = 0;
  let totalB = 0;
  for (let index = 0; index < length; index += 1) {
    totalA += a[index];
    totalB += b[index];
  }
  if (totalA === 0 || totalB === 0) return 1;

  let distance = 0;
  for (let index = 0; index < length; index += 1) {
    distance += Math.abs(a[index] / totalA - b[index] / totalB);
  }
  return distance / 2;
}

/**
 * 粗降采样逐像素比较（ADR 0001 修订里的兜底判据）。
 *
 * 输入是两个同尺寸的墨迹场（与背景色的单通道最大距离）。先按整框墨量归一化，
 * 消掉两端笔画粗细的系统性差异，再用 `TEXT_COARSE_DOWNSAMPLE_FACTOR` 见方取均值逐格比较，
 * 超过 8/255 记差异格。它抓的是「文字整体丢失、错位、换字号」这类粗错，
 * 内容细差交给列 / 行剖面的相关系数与 L1。
 */
export function coarseDownsampleCompare(aField, bField, factor = TEXT_COARSE_DOWNSAMPLE_FACTOR) {
  const scale = aField.total > 0 ? bField.total / aField.total : 1;
  let cells = 0;
  let diffCells = 0;
  let maxDelta = 0;

  for (let blockY = 0; blockY < bField.height; blockY += factor) {
    for (let blockX = 0; blockX < bField.width; blockX += factor) {
      const endX = Math.min(blockX + factor, bField.width);
      const endY = Math.min(blockY + factor, bField.height);
      let sumActual = 0;
      let sumExpected = 0;
      let count = 0;

      for (let y = blockY; y < endY; y += 1) {
        for (let x = blockX; x < endX; x += 1) {
          sumActual += aField.weights[y * bField.width + x] * scale;
          sumExpected += bField.weights[y * bField.width + x];
          count += 1;
        }
      }
      if (count === 0) continue;

      cells += 1;
      const delta = Math.abs(sumActual - sumExpected) / count;
      if (delta > maxDelta) maxDelta = delta;
      if (delta > MAX_CHANNEL_DELTA) diffCells += 1;
    }
  }

  return { cells, diffCells, ratio: cells === 0 ? 0 : diffCells / cells, maxDelta };
}

/** 单个文字框的校验：粗降采样像素（兜底）+ 剖面内容 + 位置 / 尺寸 / 形状几何。 */
function textStructure(actual, expected, region) {
  // 背景色取基准图：两张图必须是同一块底板，才能用同一把尺子量墨迹。
  const background = regionBackground(expected, region);
  const a = inkField(actual, region, background);
  const b = inkField(expected, region, background);
  const coarse = coarseDownsampleCompare(a, b);
  const aCentroid = fieldCentroid(a);
  const bCentroid = fieldCentroid(b);
  const aBounds = supportBounds(a);
  const bBounds = supportBounds(b);

  if (aCentroid === null || bCentroid === null || aBounds === null || bBounds === null) {
    return {
      centroidPx: Number.POSITIVE_INFINITY,
      bboxDeltaPx: Number.POSITIVE_INFINITY,
      outlinePx: Number.POSITIVE_INFINITY,
      inkDelta: 1,
      correlation: 0,
      profileL1: 1,
      coarseCells: coarse.cells,
      coarseDiffCells: coarse.cells,
    };
  }

  const aColumns = columnProfile(a);
  const bColumns = columnProfile(b);
  const aRows = rowProfile(a);
  const bRows = rowProfile(b);

  return {
    centroidPx: Math.hypot(aCentroid.x - bCentroid.x, aCentroid.y - bCentroid.y),
    bboxDeltaPx: Math.max(
      Math.abs(aBounds.x0 - bBounds.x0),
      Math.abs(aBounds.y0 - bBounds.y0),
      Math.abs(aBounds.x1 - bBounds.x1),
      Math.abs(aBounds.y1 - bBounds.y1),
    ),
    outlinePx: supportDistance(a, b),
    inkDelta: Math.abs(a.total - b.total) / b.total,
    correlation: Math.min(profileCorrelation(aColumns, bColumns), profileCorrelation(aRows, bRows)),
    profileL1: Math.max(profileL1(aColumns, bColumns), profileL1(aRows, bRows)),
    coarseCells: coarse.cells,
    coarseDiffCells: coarse.diffCells,
  };
}

/**
 * 比较两张同尺寸 RGBA 位图。
 *
 * - `full` / `critical`：判定用的非文字像素统计；
 * - `fullWithText` / `criticalWithText`：把文字框也算进去的严格参考值；
 * - `text`：文字框的像素差异（参考值）与结构校验的最差值。
 */
export function compareRgba(actual, expected, regions) {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error(
      `画布尺寸不一致：实际 ${actual.width} × ${actual.height}，基准 ${expected.width} × ${expected.height}`,
    );
  }

  const { width, height } = expected;
  const textRegions = regions.filter((region) => region.kind === 'text');
  const componentRegions = regions.filter((region) => region.kind !== 'text');
  const textMask = rasterizeRegions(textRegions, width, height).mask;
  const componentMask = rasterizeRegions(componentRegions, width, height).mask;

  let fullDiff = 0;
  let fullWithTextDiff = 0;
  let textPixels = 0;
  let textDiff = 0;
  let nonTextPixels = 0;
  let nonTextDiff = 0;
  let criticalWithTextPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const maskIndex = y * width + x;
      const differs = channelDelta(actual, expected, maskIndex * 4) > MAX_CHANNEL_DELTA;
      if (differs) fullWithTextDiff += 1;

      const isText = textMask[maskIndex] === 1;
      const isComponent = componentMask[maskIndex] === 1;
      if (isText) textPixels += 1;
      if (isText || isComponent) criticalWithTextPixels += 1;
      if (!isText && isComponent) nonTextPixels += 1;

      if (!differs) continue;
      if (isText) {
        textDiff += 1;
      } else {
        fullDiff += 1;
        if (isComponent) nonTextDiff += 1;
      }
    }
  }

  const nonTextFullPixels = width * height - textPixels;
  const ratio = (count, total) => (total === 0 ? 0 : count / total);
  const structure = textRegions.map((region) => textStructure(actual, expected, region));
  const worst = (key) => (structure.length === 0 ? 0 : Math.max(...structure.map((entry) => entry[key])));
  const weakest = (key) => (structure.length === 0 ? 1 : Math.min(...structure.map((entry) => entry[key])));

  return {
    width,
    height,
    full: { pixels: nonTextFullPixels, diffPixels: fullDiff, ratio: ratio(fullDiff, nonTextFullPixels) },
    fullWithText: {
      pixels: width * height,
      diffPixels: fullWithTextDiff,
      ratio: ratio(fullWithTextDiff, width * height),
    },
    critical: { pixels: nonTextPixels, diffPixels: nonTextDiff, ratio: ratio(nonTextDiff, nonTextPixels) },
    criticalWithText: {
      pixels: criticalWithTextPixels,
      diffPixels: textDiff + nonTextDiff,
      ratio: ratio(textDiff + nonTextDiff, criticalWithTextPixels),
    },
    text: { pixels: textPixels, diffPixels: textDiff, ratio: ratio(textDiff, textPixels) },
    textChecks: {
      regions: structure.length,
      centroidPx: worst('centroidPx'),
      bboxDeltaPx: worst('bboxDeltaPx'),
      outlinePx: worst('outlinePx'),
      inkDelta: worst('inkDelta'),
      correlation: weakest('correlation'),
      profileL1: worst('profileL1'),
      // 粗降采样按全部文字框汇总：单框只有十几个格子，按框取最差值会出现 1/9=11% 的粒度噪声。
      coarseRatio: (() => {
        const cells = structure.reduce((sum, entry) => sum + entry.coarseCells, 0);
        const diffCells = structure.reduce((sum, entry) => sum + entry.coarseDiffCells, 0);
        return cells === 0 ? 0 : diffCells / cells;
      })(),
    },
  };
}

/** 关键区域：组件矩形外扩 8 px ∪ 文字实际绘制包围盒（由 shared/hud.js 计算）。 */
export function criticalRegionsFor({ presetId, sampleId = GOLDEN_SAMPLE_ID, sample = loadSample() }) {
  const preset = resolvePreset(presetId);
  const entry = sample.samples.find((item) => item.id === sampleId);
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  return collectCriticalRegions(ctx, {
    preset,
    components: sample.layout.components,
    metrics: entry.metrics,
    activity: sample.activity,
  });
}

/** 判定：非文字像素达标，且文字框的几何、剖面内容与粗降采样全部在容差内。 */
export function isPassing(report) {
  const { textChecks } = report;
  return report.full.ratio <= FULL_MAX_DIFF_RATIO
    && report.critical.ratio <= CRITICAL_MAX_DIFF_RATIO
    && textChecks.centroidPx <= TEXT_MAX_CENTROID_PX
    && textChecks.bboxDeltaPx <= TEXT_MAX_BBOX_DELTA_PX
    && textChecks.outlinePx <= TEXT_MAX_OUTLINE_PX
    && textChecks.inkDelta <= TEXT_MAX_INK_DELTA
    && textChecks.correlation >= TEXT_MIN_PROFILE_CORRELATION
    && textChecks.profileL1 <= TEXT_MAX_PROFILE_L1
    && textChecks.coarseRatio <= TEXT_MAX_COARSE_DIFF_RATIO;
}

/** 读取基准图与候选图，按上述口径比对。 */
export function compareGolden({ presetId, candidatePath, goldenDir }) {
  const expected = decodePng(readFileSync(goldenPath(presetId, goldenDir)));
  const actual = decodePng(readFileSync(candidatePath));
  const regions = criticalRegionsFor({ presetId });

  const report = { presetId, candidatePath, ...compareRgba(actual, expected, regions) };
  return { ...report, pass: isPassing(report) };
}

/** 打印可直接贴进汇报的结论。 */
export function formatReport(report) {
  const percent = (ratio) => `${(ratio * 100).toFixed(4)}%`;
  const { textChecks } = report;
  return `${report.presetId}: 全图非文字差异 ${percent(report.full.ratio)}`
    + `（${report.full.diffPixels}/${report.full.pixels} px ≤1%）`
    + `，非文字关键区域 ${percent(report.critical.ratio)}`
    + `（${report.critical.diffPixels}/${report.critical.pixels} px ≤0.2%）`
    + `，文字区 质心 ${textChecks.centroidPx.toFixed(3)} px / 包围盒 ${textChecks.bboxDeltaPx} px`
    + ` / 轮廓 ${textChecks.outlinePx} px / 墨量差 ${percent(textChecks.inkDelta)}`
    + ` / 剖面相关 ${textChecks.correlation.toFixed(4)} / 剖面 L1 ${textChecks.profileL1.toFixed(4)}`
    + ` / 粗降采样 ${percent(textChecks.coarseRatio)}`
    + `（${textChecks.regions} 个文字框）`
    + `〔参考：含文字全图 ${percent(report.fullWithText.ratio)}、含文字关键区 ${percent(report.criticalWithText.ratio)}、文字框原始逐像素 ${percent(report.text.ratio)}〕`;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const presetId = valueOf('--preset');
  const candidatePath = valueOf('--candidate');
  if (presetId === undefined || candidatePath === undefined) {
    console.error('用法：node tests/golden-compare.mjs --preset <id> --candidate <png>');
    process.exit(2);
  }

  await registerFonts();
  const report = compareGolden({ presetId, candidatePath, goldenDir: valueOf('--golden-dir') });
  console.log(formatReport(report));
  process.exit(report.pass ? 0 : 1);
}
