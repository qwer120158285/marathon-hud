/**
 * 基准图生成（Node 侧）：固定示意数据 × 两个目标预设 → tests/golden/<preset>.png。
 *
 * 只走两端共用的 shared/ 绘制模块；这里不写任何坐标、字号或排版。
 * 重跑必须得到逐字节相同的 PNG（同一机器、同一 @napi-rs/canvas 与字体版本）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, encodePng, registerFonts } from '../cli/adapter.mjs';
import { drawFrame, prepareStatic } from '../shared/hud.js';
import { BUILTIN_PRESET_IDS, resolvePreset } from '../shared/presets.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SAMPLE_PATH = path.join(TESTS_DIR, 'fixtures', 'sample.json');
export const GOLDEN_DIR = path.join(TESTS_DIR, 'golden');

/** 基准图固定使用 full 样本：三项指标齐全，能同时检验 PACE / HR / CAD 与底板。 */
export const GOLDEN_SAMPLE_ID = 'full';

export function loadSample() {
  return JSON.parse(readFileSync(SAMPLE_PATH, 'utf8'));
}

export function goldenPath(presetId, dir = GOLDEN_DIR) {
  return path.join(dir, `${presetId}.png`);
}

/**
 * 用同一份示意数据渲染一帧。适配层创建画布与注册字体，shared/ 负责全部绘制。
 *
 * @param {{ presetId: string, sampleId?: string, sample?: object }} options
 * @returns {{ canvas: object, ctx: object, preset: object, layer: object, metrics: object }}
 */
export function renderSample({ presetId, sampleId = GOLDEN_SAMPLE_ID, sample = loadSample() }) {
  const preset = resolvePreset(presetId);
  const entry = sample.samples.find((item) => item.id === sampleId);
  if (entry === undefined) {
    throw new Error(`示意数据里没有样本 ${JSON.stringify(sampleId)}，可用：${sample.samples.map((item) => item.id).join('、')}`);
  }

  const { canvas, ctx } = createCanvas({ width: preset.width, height: preset.height });
  const staticCanvas = createCanvas({ width: preset.width, height: preset.height });
  const layer = prepareStatic(staticCanvas.ctx, {
    preset,
    components: sample.layout.components,
    metrics: entry.metrics,
  });

  drawFrame(ctx, { preset, metrics: entry.metrics, static: layer });

  return { canvas, ctx, preset, layer, metrics: entry.metrics };
}

/** 生成全部基准图，返回写出的文件路径。 */
export async function generateGoldens({ dir = GOLDEN_DIR } = {}) {
  await registerFonts();
  mkdirSync(dir, { recursive: true });
  const sample = loadSample();

  return BUILTIN_PRESET_IDS.map((presetId) => {
    const { canvas } = renderSample({ presetId, sample });
    const file = goldenPath(presetId, dir);
    writeFileSync(file, encodePng(canvas));
    return file;
  });
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const files = await generateGoldens();
  for (const file of files) console.log(`已生成基准图 ${path.relative(process.cwd(), file)}`);
}
