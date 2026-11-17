/**
 * Node 侧薄适配层：只负责「创建画布 + 注册字体 + 出 PNG」。
 *
 * 依据 ADR 0001：共享绘制逻辑不共享运行环境；布局与绘制全部在 shared/ 里，
 * 这里不得包含任何坐标、尺寸或绘制调用之外的排版逻辑。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas as createNapiCanvas } from '@napi-rs/canvas';

/** 字体清单与文件同目录，版本 / SHA-256 是契约（tests/fonts.test.mjs 强制）。 */
export const FONTS_DIR = fileURLToPath(new URL('../shared/fonts', import.meta.url));
export const FONT_MANIFEST = JSON.parse(readFileSync(path.join(FONTS_DIR, 'FONTS.json'), 'utf8'));

/**
 * 导出前的「字体与资源」校验：FONTS.json 登记的每个字体文件都存在且 SHA-256 一致。
 *
 * 只读文件、不改状态；注册字体是下一步（`registerFonts`），
 * 这样「文件被替换」与「注册失败」是两条可区分的错误。
 *
 * @param {{ dir?: string, manifest?: object }} [options] 仅供测试注入，默认取仓库内的字体目录与清单
 * @returns {void}
 */
export function verifyFontResources({ dir = FONTS_DIR, manifest = FONT_MANIFEST } = {}) {
  for (const file of manifest.files) {
    const filePath = path.join(dir, file.path);

    let bytes;
    try {
      bytes = readFileSync(filePath);
    } catch (error) {
      const reason = error.code === 'ENOENT' ? '不存在' : error.message;
      throw new Error(`字体文件 ${file.path} ${reason}：${filePath}`);
    }

    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== file.sha256) {
      throw new Error(
        `字体文件 ${file.path} 的 SHA-256 与清单不一致（实际 ${actual}，清单 ${file.sha256}）`,
      );
    }
  }
}

let fontsReady = null;

/**
 * 把 Inter 四个字重注册到家族名 `Inter`。
 *
 * 同一家族注册多个文件后，`ctx.font` 里的字重（400/500/600/700）会选中对应文件；
 * 这是两端「同一套字体资源」的 Node 侧落点。重复调用返回同一个 Promise。
 *
 * @returns {Promise<void>} 字体注册完成后 resolve；任何一档注册失败都 reject
 */
export function registerFonts() {
  if (fontsReady !== null) return fontsReady;

  fontsReady = (async () => {
    for (const file of FONT_MANIFEST.files) {
      const filePath = path.join(FONTS_DIR, file.path);
      const ok = GlobalFonts.registerFromPath(filePath, FONT_MANIFEST.family);
      if (!ok) {
        throw new Error(`字体注册失败：${file.path}（家族 ${FONT_MANIFEST.family}）`);
      }
    }
  })();

  return fontsReady;
}

/**
 * 创建一张 HUD 帧画布。DPR 固定为 1，颜色空间与透明背景由调用方按画布预设确定。
 *
 * @param {{ width: number, height: number }} size
 * @returns {{ canvas: import('@napi-rs/canvas').Canvas, ctx: import('@napi-rs/canvas').SKRSContext2D }}
 */
export function createCanvas({ width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError(`画布尺寸必须是正整数，实际为 ${width} × ${height}`);
  }
  const canvas = createNapiCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  return { canvas, ctx };
}

/**
 * 编码成 PNG。基准图与浏览器截图用同一种无损格式，避免编码差异进入比对。
 * @param {import('@napi-rs/canvas').Canvas} canvas
 * @returns {Buffer}
 */
export function encodePng(canvas) {
  return canvas.toBuffer('image/png');
}
