/**
 * 浏览器侧薄适配层：只负责「创建画布 + 注册字体」。
 *
 * 依据 ADR 0001：共享绘制逻辑不共享运行环境；布局与绘制全部在 shared/ 里，
 * 这里不得出现坐标、尺寸或排版计算。字体就绪前不得开始绘制。
 */

const FONTS_URL = new URL('../shared/fonts/FONTS.json', import.meta.url);

let fontsReady = null;

/**
 * 用 FontFace 显式注册 Inter 四个字重，并等到字体全部可用。
 *
 * 与 Node 侧注册同一批文件（路径与 SHA-256 见 shared/fonts/FONTS.json）；
 * 之所以显式注册而不是依赖系统字体，是为了两端字形完全一致（ADR 0001「字体」）。
 *
 * @returns {Promise<void>} 字体可用后 resolve；任一档加载失败则 reject
 */
export function registerFonts() {
  if (fontsReady !== null) return fontsReady;

  fontsReady = (async () => {
    const response = await fetch(FONTS_URL);
    if (!response.ok) {
      throw new Error(`字体清单读取失败：${FONTS_URL.pathname}（HTTP ${response.status}）`);
    }
    const manifest = await response.json();

    const faces = manifest.files.map((file) => new FontFace(
      manifest.family,
      `url("${new URL(file.path, FONTS_URL).href}")`,
      { weight: String(file.weight), style: file.style ?? 'normal' },
    ));

    const loaded = await Promise.all(faces.map((face) => face.load()));
    for (const face of loaded) document.fonts.add(face);
    await document.fonts.ready;

    // 就绪信号必须能反查到具体字重：缺一档就会静默回退到系统字体，基准图随之漂移。
    for (const file of manifest.files) {
      const probe = `${file.weight} 46px ${manifest.family}`;
      if (!document.fonts.check(probe)) {
        throw new Error(`字体未就绪：${probe}（${file.path}）`);
      }
    }
  })();

  return fontsReady;
}

/**
 * 创建 HUD 帧画布。DPR 固定为 1、透明背景，与 Node 侧输入一致。
 *
 * @param {{ width: number, height: number }} size
 * @returns {{ canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D }}
 */
export function createCanvas({ width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: true });
  return { canvas, ctx };
}
