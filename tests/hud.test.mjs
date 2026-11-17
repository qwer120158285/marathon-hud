import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas, registerFonts } from '../cli/adapter.mjs';
import { drawFrame, measureTabularText, drawTabularText, prepareStatic } from '../shared/hud.js';
import { jointValidate, resolveComponentRect } from '../shared/layout.js';
import { BUILTIN_PRESET_IDS, resolvePreset } from '../shared/presets.js';

await registerFonts();

const sample = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'));
const sampleById = (id) => sample.samples.find((entry) => entry.id === id);
const metricsById = (id) => sampleById(id).metrics;
const metricsComponent = sample.layout.components.find((component) => component.id === 'metrics');

function makeCtx() {
  const { ctx } = createCanvas({ width: 400, height: 120 });
  ctx.font = '700 46px Inter';
  return ctx;
}

/** 在给定预设上跑一次 prepareStatic，返回静态层与绘制计划。 */
function prepare(presetId, { sampleId = 'full', component = metricsComponent } = {}) {
  const preset = resolvePreset(presetId);
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  const layer = prepareStatic(ctx, {
    preset,
    components: [component],
    metrics: metricsById(sampleId),
  });
  return layer;
}

// ADR 0001「字体」：数字必须等宽，配速从 5:32 跳到 8:33 时不能左右抖动。
// 同一字号下 Inter 的 '1' 比 '8' 窄（比例字形），所以必须逐字符按固定步进绘制。
test('等宽数字：1:23 与 8:33 的绘制宽度相等，而比例字形本身并不等宽', () => {
  const ctx = makeCtx();

  assert.notEqual(
    ctx.measureText('1:23').width,
    ctx.measureText('8:33').width,
    'Inter 默认是比例字形，两者宽度本就不同——这正是要自己实现等宽的原因',
  );
  assert.equal(measureTabularText(ctx, '1:23'), measureTabularText(ctx, '8:33'));
});

test('等宽数字：步进取 measureText(0) 的宽度，三位数与四位数按同一格宽累加', () => {
  const ctx = makeCtx();
  const step = ctx.measureText('0').width;

  assert.equal(measureTabularText(ctx, '152'), 3 * step);
  assert.equal(measureTabularText(ctx, '5:32'), 3 * step + ctx.measureText(':').width);
});

test('等宽数字：drawTabularText 返回的推进量等于测量宽度，并从给定 x 起笔', () => {
  const ctx = makeCtx();
  const width = measureTabularText(ctx, '5:32');

  assert.equal(Math.round(drawTabularText(ctx, '5:32', 20, 60) * 1000) / 1000, Math.round(width * 1000) / 1000);
});

// ADR 0004 / 验收项 2：缺值指标整行不绘制，卡片高度随可用指标数收缩，不留空行。
test('缺值指标整行不绘制：三项 → 两项 → 一项，行序紧跟且卡片只收缩不留洞', () => {
  const full = prepare('douyin-portrait', { sampleId: 'full' });
  const noCadence = prepare('douyin-portrait', { sampleId: 'no-cadence' });
  const paceOnly = prepare('douyin-portrait', { sampleId: 'pace-only' });

  const rowIds = (layer) => layer.plan[0].staticTexts
    .filter((text) => ['PACE', 'HR', 'CAD'].includes(text.text))
    .map((text) => text.text);

  assert.deepEqual(rowIds(full), ['PACE', 'HR', 'CAD']);
  assert.deepEqual(rowIds(noCadence), ['PACE', 'HR']);
  assert.deepEqual(rowIds(paceOnly), ['PACE']);

  const heights = [full, noCadence, paceOnly].map((layer) => layer.plan[0].panel.height);
  const rowStep = heights[0] - heights[1];
  assert.ok(rowStep > 0, '少一行必须真的变矮');
  assert.equal(heights[1] - heights[2], rowStep, '每行等高，收缩量必须与行距一致');

  // 行基线等距 = 行与行之间没有空行留下的缝隙。
  const labelBaselines = (layer) => layer.plan[0].staticTexts
    .filter((text) => ['PACE', 'HR', 'CAD'].includes(text.text))
    .map((text) => text.baseline);
  const gaps = (layer) => labelBaselines(layer).slice(1).map((y, i) => y - labelBaselines(layer)[i]);
  assert.deepEqual(gaps(noCadence), [rowStep]);
});

test('缺值不填占位：缺项时既没有 0 也没有 -- 文案，缺的那一行标签也不出现', () => {
  const paceOnly = prepare('douyin-portrait', { sampleId: 'pace-only' });
  const texts = paceOnly.plan[0].staticTexts.map((text) => text.text);
  const values = paceOnly.plan[0].dynamic.map((entry) => entry.value);

  assert.deepEqual(texts.filter((text) => ['PACE', 'HR', 'CAD'].includes(text)), ['PACE']);
  assert.deepEqual(values, ['6:43']);
  assert.ok(!texts.includes('0'), '不能出现占位 0');
  assert.ok(!values.includes('0'), '不能把缺值画成 0');
  assert.ok(!values.some((value) => value !== null && value.includes('--')), '不能出现 -- 占位');
});

test('配置关闭的组件不进入绘制计划：visible=false 时一行都不画', () => {
  const layer = prepare('douyin-portrait', {
    component: { ...metricsComponent, visible: false },
  });

  assert.deepEqual(layer.plan, []);
});

// 本票实现 metrics / route / progress；weather 由 #10 负责，没有绘制条目时必须跳过。
test('未实现的组件 id 直接跳过：四类组件里只画 route / progress / metrics', () => {
  const preset = resolvePreset('douyin-portrait');
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  const layer = prepareStatic(ctx, {
    preset,
    components: sample.layout.components,
    metrics: metricsById('full'),
    activity: sample.activity,
  });

  assert.deepEqual(layer.plan.map((item) => item.componentId), ['route', 'progress', 'metrics']);
});

// 验收项：矩形一律来自 shared/layout.js，绘制代码里没有硬编码坐标。
test('卡片几何来自布局解析：两个预设下都贴住组件矩形的一边且宽度一致', () => {
  for (const presetId of BUILTIN_PRESET_IDS) {
    const preset = resolvePreset(presetId);
    const rect = resolveComponentRect(metricsComponent, preset);
    const [item] = prepare(presetId).plan;

    assert.equal(item.rect.x, rect.x);
    assert.equal(item.rect.width, rect.width);
    assert.equal(item.panel.width, rect.width);
    assert.equal(item.panel.x, rect.x);
    // bottom-left 锚点：卡片贴组件矩形底边，向上收缩。
    assert.equal(item.panel.y + item.panel.height, rect.y + rect.height);
    assert.ok(item.panel.height <= rect.height);
  }
});

test('示意布局在两张目标预设上都通过联合校验', () => {
  const { ok, errors } = jointValidate({
    layout: sample.layout,
    targetPresets: sample.targetPresets,
    presets: sample.targetPresets.map((id) => resolvePreset(id)),
  });

  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

/** 只记录调用的假上下文：用来观察 drawFrame 到底落了几笔。 */
function recordingContext() {
  const calls = {
    drawImage: 0,
    clearRect: 0,
    fillText: [],
    fill: 0,
    stroke: 0,
    beginPath: 0,
    roundRect: 0,
  };

  return {
    calls,
    canvas: { width: 1080, height: 1920 },
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    lineJoin: 'round',
    clearRect() { calls.clearRect += 1; },
    drawImage() { calls.drawImage += 1; },
    fillText(text, x, y) { calls.fillText.push({ text, x, y }); },
    fill() { calls.fill += 1; },
    stroke() { calls.stroke += 1; },
    beginPath() { calls.beginPath += 1; },
    roundRect() { calls.roundRect += 1; },
    save() {},
    restore() {},
    measureText() { throw new Error('drawFrame 不应测量文字：静态排版已经在 prepareStatic 时完成'); },
  };
}

// 验收项 5：静态层预绘一次，每帧只合成一次，不逐帧重排文字、不重描路径。
test('每帧只合成一次静态层：drawFrame 不写静态标签、不描任何路径', () => {
  const layer = prepare('douyin-portrait', { sampleId: 'full' });
  const ctx = recordingContext();

  drawFrame(ctx, {
    preset: resolvePreset('douyin-portrait'),
    metrics: metricsById('full'),
    static: layer,
  });

  const STATIC_TEXTS = ['PACE', 'HR', 'CAD', 'MIN / KM', 'BPM', 'SPM'];
  const staticHits = ctx.calls.fillText.filter((call) => STATIC_TEXTS.includes(call.text));
  assert.deepEqual(staticHits, [], '静态文字只能出现在预绘层里');
  assert.equal(ctx.calls.drawImage, 1, '每帧只合成一次静态层');
  assert.equal(ctx.calls.fill, 0, '底板不逐帧重填');
  assert.equal(ctx.calls.stroke, 0, '描边不逐帧重描');
  assert.equal(ctx.calls.beginPath + ctx.calls.roundRect, 0, '路径不逐帧重建');
  assert.equal(ctx.calls.clearRect, 1);

  // 每帧落笔的只有动态数值（逐字符绘制，所以只应出现数字与冒号）。
  assert.ok(ctx.calls.fillText.length > 0);
  for (const call of ctx.calls.fillText) {
    assert.match(call.text, /^[0-9:]$/, `drawFrame 画出了非数值字符：${call.text}`);
  }
});

test('drawFrame 画出的数值拼起来就是当前指标（5:32 / 152 / 184）', () => {
  const layer = prepare('douyin-portrait', { sampleId: 'full' });
  const ctx = recordingContext();

  drawFrame(ctx, {
    preset: resolvePreset('douyin-portrait'),
    metrics: metricsById('full'),
    static: layer,
  });

  // 按基线分组还原每一行的字符串；同一行内按 x 排序。
  const byBaseline = new Map();
  for (const call of ctx.calls.fillText) {
    const key = call.y;
    if (!byBaseline.has(key)) byBaseline.set(key, []);
    byBaseline.get(key).push(call);
  }
  const lines = [...byBaseline.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, chars]) => chars.sort((a, b) => a.x - b.x).map((call) => call.text).join(''));

  assert.deepEqual(lines, ['5:32', '152', '184']);
});

test('drawFrame 缺少静态层时直接报错，避免静默画出空帧', () => {
  const ctx = recordingContext();
  assert.throws(
    () => drawFrame(ctx, {
      preset: resolvePreset('douyin-portrait'),
      components: [metricsComponent],
      metrics: metricsById('full'),
    }),
    /prepareStatic/,
  );
});
