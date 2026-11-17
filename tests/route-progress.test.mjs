/**
 * 路线组件、进度组件、子组件开关与数据可用性（ticket #9）。
 *
 * 期望值来自独立事实源：示意轨迹的经纬度（矩形一圈 0.01° × 0.01°）、手算的等距圆柱投影、
 * 固定的总距离 18.278 km 与 19 个 Lap（最后一个只有 278.08 m）、ADR 0004 的默认状态表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCanvas, registerFonts } from '../cli/adapter.mjs';
import { collectCriticalRegions, drawFrame, prepareStatic, routeProgressAt } from '../shared/hud.js';
import { resolveComponentRect } from '../shared/layout.js';
import { resolvePreset } from '../shared/presets.js';

await registerFonts();

const sample = JSON.parse(readFileSync(new URL('./fixtures/sample.json', import.meta.url), 'utf8'));
const PRESET = resolvePreset('douyin-portrait');

const componentById = (id) => sample.layout.components.find((component) => component.id === id);
const entryById = (id) => sample.samples.find((entry) => entry.id === id);
const fullMetrics = entryById('full').metrics;

/** 在给定预设上预绘一次静态层。 */
function prepare(components, { preset = PRESET, metrics = fullMetrics, activity = sample.activity } = {}) {
  const { ctx } = createCanvas({ width: preset.width, height: preset.height });
  const layer = prepareStatic(ctx, { preset, components, metrics, activity });
  return layer;
}

const planOf = (layer, componentId) => layer.plan.find((item) => item.componentId === componentId);

/**
 * 记录型上下文：只记下路径与文字落笔，用来观察「画在哪、画了几段」。
 * `measureText` 对 drawFrame 抛错——每帧不应再测量文字。
 */
function recordingContext({ measure = false } = {}) {
  const calls = {
    drawImage: 0,
    clearRect: 0,
    fillText: [],
    fill: 0,
    fillRect: 0,
    stroke: 0,
    beginPath: 0,
    moveTo: [],
    lineTo: [],
    roundRect: 0,
    arc: 0,
  };
  const trace = [];
  const ctx = {
    calls,
    trace,
    canvas: { width: PRESET.width, height: PRESET.height },
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    clearRect() { calls.clearRect += 1; },
    drawImage() { calls.drawImage += 1; },
    fillText(text, x, y) { calls.fillText.push({ text, x, y, fillStyle: ctx.fillStyle }); },
    fill() { calls.fill += 1; trace.push('fill'); },
    fillRect() { calls.fillRect += 1; },
    stroke() { calls.stroke += 1; trace.push('stroke'); },
    beginPath() { calls.beginPath += 1; },
    moveTo(x, y) { calls.moveTo.push({ x, y }); },
    lineTo(x, y) { calls.lineTo.push({ x, y }); },
    roundRect() { calls.roundRect += 1; },
    arc() { calls.arc += 1; },
    closePath() {},
    save() {},
    restore() {},
    measureText(text) {
      if (!measure) throw new Error('drawFrame 不应测量文字：静态排版已经在 prepareStatic 时完成');
      return { width: text.length * 10, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 };
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// 路线：完整形状
// ---------------------------------------------------------------------------

// 验收项 1：整条 GPS 轨迹压进组件矩形，等比、居中、留内边距。
// 独立期望值：示意轨迹是一圈 0.01° × 0.01° 的矩形；等距圆柱投影按 cos(平均纬度) 压缩经度，
// cos(22.505°) = 0.92388，所以投影后的宽高比必须是 0.92388，长边顶满内边距。
test('路线底图：整条轨迹等比压进组件矩形，长边顶满内边距、四周留白相等', () => {
  const layer = prepare([componentById('route')]);
  const route = planOf(layer, 'route').route;
  const rect = resolveComponentRect(componentById('route'), PRESET);
  const points = route.runs.flat();

  assert.equal(points.length, sample.activity.samples.filter((point) => point.lat !== null).length);

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const expectedAspect = Math.cos((22.505 * Math.PI) / 180);

  assert.ok(Math.abs(width / height - expectedAspect) < 0.002, `投影宽高比 ${width / height} 应为 ${expectedAspect}`);

  const padding = 18; // 路线内边距（px @ 短边 1080）
  assert.ok(Math.abs(height - (rect.height - padding * 2)) < 0.5, '较高的方向应当顶满内边距');
  assert.ok(Math.abs((rect.height - height) / 2 - padding) < 0.5, '上下留白应当等于内边距');
  assert.ok(
    Math.abs((Math.min(...xs) - rect.x) - (rect.x + rect.width - Math.max(...xs))) < 0.5,
    '左右留白相等（水平居中）',
  );
  assert.ok((rect.width - width) / 2 >= padding, '较窄的方向只能更宽，不能压到内边距以内');

  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), '投影结果必须是有限值');
    assert.ok(point.x >= rect.x && point.x <= rect.x + rect.width, '投影后不能越出组件矩形');
    assert.ok(point.y >= rect.y && point.y <= rect.y + rect.height, '投影后不能越出组件矩形');
  }
});

// 验收项 1：前 36 点无 GPS 必须断笔；中段 5 点缺口也不能连成直线穿过去。
// 独立事实：示意轨迹的 GPS 点分成 4 段（10 / 10 / 10 / 10），共 40 点、36 条线段。
test('路线断笔：GPS 缺失处拆成独立路径段，缺口两侧不相连、开头的空点不落到原点', () => {
  const routeComponent = componentById('route');
  const ctx = recordingContext({ measure: true });
  prepareStatic(ctx, { preset: PRESET, components: [routeComponent], metrics: fullMetrics, activity: sample.activity });
  const route = planOf(prepare([routeComponent]), 'route').route;

  assert.deepEqual(route.runs.map((run) => run.length), [12, 24], '缺口两侧各自成段：第 12–16 点缺失，前后各成一段');
  assert.equal(ctx.calls.beginPath, 1, '路线底图只建一条路径');
  assert.equal(ctx.calls.moveTo.length, 2, '每个连续段一次 moveTo：2 段而不是 1 段');
  assert.equal(ctx.calls.lineTo.length, 34, '36 个 GPS 点、2 段路径 → 34 条线段');
  assert.equal(route.segmentCount, 34);

  const firstGps = sample.activity.samples.find((point) => point.lat !== null);
  const firstProjected = route.runs[0][0];
  assert.equal(firstGps.lat, 22.5);
  assert.notEqual(Math.round(firstProjected.x), 0);
  assert.notEqual(Math.round(firstProjected.y), 0);
  // 开头的 36 个空点若被当成 (0, 0) 画进来，路径会从画布左上角起笔。
  assert.notDeepEqual([Math.round(ctx.calls.moveTo[0].x), Math.round(ctx.calls.moveTo[0].y)], [0, 0]);

  // 当前距离落在缺口里：只高亮缺口前的一段，箭头沿缺口前的方向（向东），不跨缺口。
  const inGap = routeProgressAt(route, 6000);
  assert.equal(inGap.completed.length, 1, '缺口内只能高亮缺口前的一段');
  assert.ok(Math.abs(inGap.heading) < 0.01, `缺口内航向 ${inGap.heading} 应为缺口前的正东`);

  // 缺口两侧的端点相距很远：不能被一条线段直接连起来。
  const beforeGap = route.runs[0].at(-1);
  const afterGap = route.runs[1][0];
  const gapDistance = Math.hypot(afterGap.x - beforeGap.x, afterGap.y - beforeGap.y);
  assert.ok(gapDistance > 50, `缺口两侧端点应当分开（实际 ${gapDistance} px）`);
});

// 验收项 1：高亮「已完成的一段」——按当前累计距离截断，箭头沿当前行进方向指。
// 独立事实：示意轨迹从南往北起跑，3.2105 km 落在第一条边（正北）上，屏幕坐标的航向即 -π/2。
test('路线高亮：按当前累计距离截断，箭头沿路线当前方向指（向北 → -π/2）', () => {
  const layer = prepare([componentById('route')]);
  const route = planOf(layer, 'route').route;
  const progress = routeProgressAt(route, 3210.5);

  assert.equal(progress.completed.length, 1, '当前距离只覆盖第一段轨迹');
  assert.ok(progress.completed[0].length < route.runs[0].length, '只高亮到 3.2105 km，不能画完整段');
  assert.ok(progress.completed[0].length > 2);
  assert.ok(Math.abs(progress.heading - -Math.PI / 2) < 0.01, `航向 ${progress.heading} 应指正北`);
  // 第一条边是竖线：截断点与这条边上的点同 x。
  assert.ok(Math.abs(progress.tip.x - route.runs[0][0].x) < 0.001, '截断点应当落在第一条边上');

  // 起点附近（GPS 还没出现）没有已完成段，也就没有箭头。
  assert.equal(routeProgressAt(route, 0), null);
  assert.equal(routeProgressAt(route, null), null);

  const end = routeProgressAt(route, 18278.08);
  assert.equal(end.completed.length, 2, '终点时两段都已完成');
  assert.ok(Math.abs(Math.abs(end.heading) - Math.PI) < 0.01, `终点航向 ${end.heading} 应指正西`);
});

// 验收项：速度接近 0（配速无意义）时不画箭头；缺当前距离时整条动态层都不画。
test('路线箭头：速度为 0 或配速缺失时不画箭头，只画已完成段', () => {
  const layer = prepare([componentById('route')]);
  const draw = (metrics) => {
    const recorder = recordingContext();
    drawFrame(recorder, { preset: PRESET, metrics, static: layer });
    return recorder.calls;
  };

  const moving = draw(fullMetrics);
  assert.equal(moving.drawImage, 1, '每帧只合成一次静态层');
  assert.equal(moving.stroke, 1, '已完成段描一次');
  assert.equal(moving.fill, 1, '行进中画一个箭头（填充三角形）');

  for (const paceSecPerKm of [null, 0, 4000]) {
    const calls = draw({ ...fullMetrics, paceSecPerKm });
    assert.equal(calls.stroke, 1, `配速 ${paceSecPerKm} 时已完成段仍要画`);
    assert.equal(calls.fill, 0, `配速 ${paceSecPerKm} 时不应画箭头`);
  }

  const noDistance = draw({ ...fullMetrics, distanceM: null });
  assert.equal(noDistance.stroke, 0);
  assert.equal(noDistance.fill, 0);
  assert.equal(noDistance.fillText.length, 0);
});

// 高亮之前不能出现文字或面板：路线组件没有数据卡。
test('路线组件只画路径：绘制计划里没有底板与文字', () => {
  const item = planOf(prepare([componentById('route')]), 'route');
  assert.equal(item.panel, null);
  assert.deepEqual(item.staticTexts, []);
  assert.deepEqual(item.dynamic, []);
});
// ---------------------------------------------------------------------------
// 进度：已跑距离 / 总距离 + 进度条
// ---------------------------------------------------------------------------

// 验收项 2：进度条显示已跑距离与总距离；样本终点 18.278 km。
test('进度组件：当前 3.2105 km / 总 18.278 km，进度条按距离比例填充', () => {
  const layer = prepare([componentById('progress')]);
  const item = planOf(layer, 'progress');
  const texts = item.staticTexts.map((text) => text.text);

  assert.ok(texts.includes('/ 18.28'), `缺少总距离文案：${texts.join(' | ')}`);
  assert.ok(texts.includes('KM'), '缺少单位 KM');
  assert.deepEqual(item.dynamic.map((entry) => entry.value), ['3.21']);
  assert.equal(item.dynamic[0].field, 'distanceM');

  // 独立期望值：3210.5 / 18278.08 = 0.17565…
  const expectedRatio = 3210.5 / 18278.08;
  assert.ok(Math.abs(item.progress.ratio - expectedRatio) < 1e-9, `进度比例 ${item.progress.ratio}`);
  assert.equal(item.progress.totalDistanceM, 18278.08);

  const bar = item.progress.bar;
  const panel = item.panel;
  assert.ok(bar.x >= panel.x && bar.x + bar.width <= panel.x + panel.width, '进度条不能溢出底板');
  assert.ok(bar.y >= panel.y && bar.y + bar.height <= panel.y + panel.height, '进度条不能溢出底板');
  assert.ok(panel.height <= item.rect.height, '底板不能高过组件矩形');
});

test('进度组件：终点时数值为 18.28、进度条填满，且不超过 100%', () => {
  const metrics = { ...fullMetrics, distanceM: 18278.08 };
  const item = planOf(prepare([componentById('progress')], { metrics }), 'progress');
  assert.deepEqual(item.dynamic.map((entry) => entry.value), ['18.28']);
  assert.equal(item.progress.ratio, 1);

  const beyond = { ...fullMetrics, distanceM: 20000 };
  assert.equal(planOf(prepare([componentById('progress')], { metrics: beyond }), 'progress').progress.ratio, 1);
});

// 每帧只重画「填充」这一件事：轨道、刻度、文字都在静态层。
test('进度条每帧只填一次，填充宽度等于比例 × 轨道宽度', () => {
  const layer = prepare([componentById('progress')]);
  const recorder = recordingContext();
  drawFrame(recorder, { preset: PRESET, metrics: fullMetrics, static: layer });

  assert.equal(recorder.calls.fill, 1, '每帧只填一次进度条');
  assert.equal(recorder.calls.stroke, 0, '底板与轨道不逐帧重描');
  assert.equal(recorder.calls.fillText.map((call) => call.text).join(''), '3.21');
});

test('进度组件跳过：配置关闭或没有距离数据时整块不画', () => {
  assert.equal(planOf(prepare([{ ...componentById('progress'), visible: false }]), 'progress'), undefined);
  assert.equal(planOf(prepare([componentById('progress')], { metrics: { ...fullMetrics, distanceM: null } }), 'progress'), undefined);
  assert.equal(
    planOf(prepare([componentById('progress')], { activity: { ...sample.activity, totalDistanceM: null } }), 'progress'),
    undefined,
    '总距离缺失时无法计算比例，不能画一条恒为 0 的进度条',
  );
});

// 验收项 2：公里刻度取真实 Lap 数据；默认关闭。
test('Lap 刻度：默认关闭；开启后按真实 Lap 落 18 个刻度，不伪造第 19 段', () => {
  const off = planOf(prepare([componentById('progress')]), 'progress');
  assert.deepEqual(off.progress.markers, [], 'Lap 刻度默认关闭（ADR 0004）');

  const on = planOf(prepare([{ ...componentById('progress'), subcomponents: { lapMarkers: true } }]), 'progress');
  const markers = on.progress.markers;
  assert.equal(markers.length, 18, '19 个 Lap 里只有 18 个完整公里');
  assert.deepEqual(markers.map((marker) => marker.distanceM), Array.from({ length: 18 }, (_, index) => (index + 1) * 1000));
  assert.ok(!markers.some((marker) => marker.distanceM >= 19000), '最后一个 Lap 只有 278.08 m，不能补出 19 km 刻度');

  const bar = on.progress.bar;
  for (const [index, marker] of markers.entries()) {
    const expectedX = bar.x + (((index + 1) * 1000) / 18278.08) * bar.width;
    assert.ok(Math.abs(marker.x - expectedX) < 0.001, `第 ${index + 1} 个刻度位置 ${marker.x} 应为 ${expectedX}`);
    assert.ok(marker.x >= bar.x && marker.x <= bar.x + bar.width);
  }
});

// 数据不可用时即使子组件开启也不画刻度（shouldRender = configEnabled && dataAvailable）。
test('Lap 刻度：配置开启但活动没有完整公里时一个刻度也不画', () => {
  const metrics = { ...fullMetrics, availability: { ...fullMetrics.availability, lapMarkers: false } };
  const on = planOf(prepare([{ ...componentById('progress'), subcomponents: { lapMarkers: true } }], { metrics }), 'progress');
  assert.deepEqual(on.progress.markers, []);
});

// ---------------------------------------------------------------------------
// 子组件开关与数据可用性（ADR 0004：shouldRender = configEnabled && dataAvailable）
// ---------------------------------------------------------------------------

const metricsComponent = componentById('metrics');
// 追加行需要更高的组件矩形（示意布局里的卡片只按默认三行给高度）。
const tallMetrics = { ...metricsComponent, anchor: 'top-left', col: 2, row: 20, rowSpan: 12 };
const withPower = (component) => ({ ...component, subcomponents: { power: true, elevation: false } });
const withElevation = (component) => ({ ...component, subcomponents: { power: false, elevation: true } });
const labelsOf = (layer) => planOf(layer, 'metrics').staticTexts.map((text) => text.text);

// 验收项 3：功率默认关闭；开启且活动确有功率时才作为附加行出现。
test('功率子组件：默认关闭不画，开启且有数据时追加一行，数值随帧变化', () => {
  assert.ok(!labelsOf(prepare([metricsComponent])).includes('POWER'), '功率默认关闭');

  const metrics = { ...fullMetrics, powerWatts: 337, availability: { ...fullMetrics.availability, power: true } };
  const layer = prepare([withPower(tallMetrics)], { metrics });
  assert.deepEqual(
    labelsOf(layer).filter((text) => ['PACE', 'HR', 'CAD', 'POWER'].includes(text)),
    ['PACE', 'HR', 'CAD', 'POWER'],
  );
  assert.ok(labelsOf(layer).includes('W'), '功率单位是 W');
  assert.deepEqual(planOf(layer, 'metrics').dynamic.map((entry) => entry.value), ['5:32', '152', '184', '337']);

  const recorder = recordingContext();
  drawFrame(recorder, { preset: PRESET, metrics: { ...metrics, powerWatts: 341 }, static: layer });
  const numbers = recorder.calls.fillText.filter((call) => /^\d$/.test(call.text));
  const powerChars = numbers.slice(-3).map((call) => call.text).join('');
  assert.equal(powerChars, '341', '功率取当前时刻的值，不冻结在预绘时');
});

// 验收项 4：开启但 TCX 没有功率 → 整行不绘制、不显示 0、不留空行。
test('功率开启但活动没有功率：整行不出现，也没有 0 或 -- 占位', () => {
  const layer = prepare([withPower(tallMetrics)], { metrics: fullMetrics });
  const labels = labelsOf(layer);
  const values = planOf(layer, 'metrics').dynamic.map((entry) => entry.value);

  assert.ok(!labels.includes('POWER'), `功率行不应出现：${labels.join(' | ')}`);
  assert.ok(!labels.includes('W'));
  assert.deepEqual(labels.filter((text) => ['PACE', 'HR', 'CAD'].includes(text)), ['PACE', 'HR', 'CAD']);
  assert.ok(!values.includes('0'));
  assert.ok(!values.some((value) => value !== null && value.includes('--')));

  const recorder = recordingContext();
  drawFrame(recorder, { preset: PRESET, metrics: fullMetrics, static: layer });
  const drawn = recorder.calls.fillText.map((call) => call.text).join('');
  assert.ok(!drawn.includes('--'), '画布上不能出现 -- 占位');
  assert.ok(!drawn.includes('W'), '画布上不能出现功率单位');
});

// 验收项 4：海拔取当前时刻对应的值；无值时不画。
test('海拔子组件：默认关闭，开启后取当前时刻的海拔，缺值时整行不画', () => {
  assert.ok(!labelsOf(prepare([metricsComponent])).includes('ELEV'), '海拔默认关闭');

  const layer = prepare([withElevation(tallMetrics)], { metrics: fullMetrics });
  assert.ok(labelsOf(layer).includes('ELEV'));
  assert.ok(labelsOf(layer).includes('M'));
  // 当前时刻 altitudeM = 24.6 m → 25
  assert.equal(planOf(layer, 'metrics').dynamic.at(-1).value, '25');

  const higher = { ...fullMetrics, altitudeM: 26.2 };
  const recorder = recordingContext();
  drawFrame(recorder, { preset: PRESET, metrics: higher, static: layer });
  const digits = recorder.calls.fillText.filter((call) => /^\d$/.test(call.text)).map((call) => call.text).join('');
  assert.ok(digits.endsWith('26'), `海拔应取当前时刻的值，实际画出的数字 ${digits}`);

  const noAltitude = { ...fullMetrics, altitudeM: null, availability: { ...fullMetrics.availability, altitude: false } };
  assert.ok(!labelsOf(prepare([withElevation(tallMetrics)], { metrics: noAltitude })).includes('ELEV'));
});

// 验收项 5：GCT / 触地时间、字幕条、右上角水印、缺失数据的占位数字一律不出现。
test('被排除的视觉元素一个都不出现：无 GCT、无字幕、无水印、无占位数字', () => {
  const metrics = { ...fullMetrics, availability: { ...fullMetrics.availability, power: true, altitude: true } };
  const component = { ...tallMetrics, subcomponents: { power: true, elevation: true } };
  const layer = prepare([component], { metrics });
  const texts = layer.plan.flatMap((item) => [
    ...item.staticTexts.map((text) => text.text),
    ...item.dynamic.map((entry) => entry.value),
  ]);

  for (const banned of ['GCT', '触地时间', '--', '0 W', '0W']) {
    assert.ok(!texts.some((text) => text?.includes(banned)), `不应出现 ${banned}`);
  }
  // 功率此刻没有取值 → 整行不画，而不是画 0。
  assert.ok(!texts.includes('POWER'));
  assert.ok(!texts.includes('0'));
});

// ---------------------------------------------------------------------------
// 路线：退化与跳过
// ---------------------------------------------------------------------------

test('路线退化情形：所有点经度相同也不产生 NaN，横向居中不动', () => {
  const samples = sample.activity.samples.map((point) => (
    point.lat === null ? point : { ...point, lon: 113.9 }
  ));
  const layer = prepare([componentById('route')], { activity: { ...sample.activity, samples } });
  const points = planOf(layer, 'route').route.runs.flat();
  const xs = new Set(points.map((point) => point.x));

  for (const point of points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), '退化情形也必须得到有限坐标');
  }
  assert.equal(xs.size, 1, '经度相同时所有点应落在同一条竖线上');
});

// 没有 GPS 数据（或配置关闭）时整个路线组件跳过，不留空底板。
test('路线组件跳过：可见但活动没有 GPS 时不出现在绘制计划里', () => {
  const metrics = { ...fullMetrics, availability: { ...fullMetrics.availability, gps: false } };
  assert.equal(planOf(prepare([componentById('route')], { metrics }), 'route'), undefined);
  assert.equal(planOf(prepare([{ ...componentById('route'), visible: false }]), 'route'), undefined);
});

// 验收项 3：子组件不写配置时一律默认关闭（ADR 0004 的默认状态表），即使数据完全可用。
test('子组件默认关闭：没写 subcomponents 时功率、海拔、Lap 刻度都不出现', () => {
  const metrics = {
    ...fullMetrics,
    powerWatts: 337,
    altitudeM: 24.6,
    availability: { ...fullMetrics.availability, power: true, altitude: true, lapMarkers: true },
  };
  const bareMetrics = { ...tallMetrics };
  delete bareMetrics.subcomponents;
  assert.deepEqual(labelsOf(prepare([bareMetrics], { metrics })).filter((text) => ['POWER', 'ELEV'].includes(text)), []);

  const bareProgress = { ...componentById('progress') };
  delete bareProgress.subcomponents;
  assert.deepEqual(planOf(prepare([bareProgress], { metrics }), 'progress').progress.markers, []);
});

// ---------------------------------------------------------------------------
// 两端一致：静态层一次、每帧只合成一次 + 只画变化部分
// ---------------------------------------------------------------------------

// 验收项 6：路线底图、进度轨道 / 刻度 / 文字都属于静态层；每帧只合成一次，
// 落笔的只有会变的东西（已完成段、箭头、进度条填充、指标数值）。
test('四类组件同帧：静态文字一次也不重写，每帧只有变化部分落笔', () => {
  const layer = prepare(sample.layout.components);
  assert.deepEqual(layer.plan.map((item) => item.componentId), ['route', 'progress', 'metrics'], 'weather 未实现应跳过');

  const recorder = recordingContext();
  drawFrame(recorder, { preset: PRESET, metrics: fullMetrics, static: layer });

  const STATIC_TEXTS = ['PACE', 'HR', 'CAD', 'MIN / KM', 'BPM', 'SPM', 'DISTANCE', 'KM', '/ 18.28'];
  const staticHits = recorder.calls.fillText.filter((call) => STATIC_TEXTS.includes(call.text));
  assert.deepEqual(staticHits, [], '静态文字只能出现在预绘层里');

  assert.equal(recorder.calls.drawImage, 1, '每帧只合成一次静态层');
  assert.equal(recorder.calls.clearRect, 1);
  assert.equal(recorder.calls.stroke, 1, '只有路线高亮段描一次（底图在静态层）');
  assert.equal(recorder.calls.fill, 2, '箭头 + 进度条填充各一次');

  // 每帧落笔的字符只有数值：数字、冒号、小数点。
  for (const call of recorder.calls.fillText) {
    assert.match(call.text, /^[0-9:.]$/, `drawFrame 画出了非数值字符：${call.text}`);
  }
  assert.equal(recorder.calls.fillText.map((call) => call.text).join(''), '3.215:32152184');
});

test('关键区域覆盖路线与进度组件：组件矩形外扩 8 px 都在列表里', () => {
  const { ctx } = createCanvas({ width: PRESET.width, height: PRESET.height });
  const regions = collectCriticalRegions(ctx, {
    preset: PRESET,
    components: sample.layout.components,
    metrics: fullMetrics,
    activity: sample.activity,
  });
  const rects = regions.filter((region) => region.kind === 'component');
  assert.equal(rects.length, 3, '路线、进度、指标三块');

  for (const id of ['route', 'progress']) {
    const rect = resolveComponentRect(componentById(id), PRESET);
    assert.ok(
      rects.some((region) => region.x === rect.x - 8 && region.y === rect.y - 8
        && region.width === rect.width + 16 && region.height === rect.height + 16),
      `${id} 的组件矩形应当出现在关键区域里`,
    );
  }
});

