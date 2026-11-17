/**
 * 源视频规格校验（ADR 0003「尺寸校验」、SPEC-v1 第 4 节第 4 步）。
 *
 * 期望值来源：
 * - 分辨率、SAR、DAR、旋转的字段形状取自本机 ffprobe 4.4.1 的真实输出；
 * - 规则取自 ADR 0003：分别比较 width / height / SAR / DAR，检查旋转元数据，
 *   分辨率一致但方向相反（1920×1080 vs 1080×1920）必须拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { compareVideoSpec, parseProbeJson, probeVideo } from '../cli/ffprobe.mjs';
import { resolvePreset } from '../shared/presets.js';
import { makeVideo } from './helpers/video.mjs';

const DOUYIN = resolvePreset('douyin-portrait');

/** 本机 ffprobe 4.4.1 对 1080×1920 竖屏 H.264 的真实输出（节选关键字段）。 */
const PORTRAIT_PROBE = {
  streams: [{
    codec_type: 'video',
    width: 1080,
    height: 1920,
    sample_aspect_ratio: '1:1',
    display_aspect_ratio: '9:16',
    duration: '1.000000',
  }],
  format: { duration: '1.000000' },
};

test('解析 ffprobe 输出：宽高、SAR、DAR、时长、旋转', () => {
  const actual = parseProbeJson(PORTRAIT_PROBE);

  assert.deepEqual(actual, {
    width: 1080,
    height: 1920,
    sar: '1:1',
    dar: '9:16',
    rotation: 0,
    durationSec: 1,
  });
});

// 手机素材的旋转标记在 side_data_list（Display Matrix）里，ffprobe 4.4.1 返回 rotation: 90。
test('优先取 side_data_list 的旋转标记', () => {
  const probe = structuredClone(PORTRAIT_PROBE);
  probe.streams[0].side_data_list = [{ side_data_type: 'Display Matrix', rotation: 90 }];

  assert.equal(parseProbeJson(probe).rotation, 90);
});

// 旧版 ffprobe / mov 容器用 tags.rotate，且是逆时针角度（-90）。
test('兼容旧版 tags.rotate', () => {
  const probe = structuredClone(PORTRAIT_PROBE);
  probe.streams[0].tags = { rotate: '-90' };

  assert.equal(parseProbeJson(probe).rotation, -90);
});

test('没有视频流时报「源视频里没有视频流」', () => {
  assert.throws(
    () => parseProbeJson({ streams: [{ codec_type: 'audio' }], format: {} }),
    /源视频里没有视频流/,
  );
});

// 验收项：3840×1612 对 1080×1920 抖音竖屏必须拒绝，错误文本含实际值与期望值。
test('3840×1612 对 douyin-portrait 拒绝，并给出实际值与期望值', () => {
  const issues = compareVideoSpec(
    { width: 3840, height: 1612, sar: '1:1', dar: '240:101', rotation: 0 },
    DOUYIN,
  );

  assert.equal(issues[0], '源视频 3840×1612，期望 1080×1920（画布预设 douyin-portrait）');
  // DAR 由编码宽高推导，尺寸不符时必然连带不符：一并报告，便于一次改完。
  assert.match(issues.join('；'), /DAR 240:101，期望 9:16/);
});

// 验收项：分辨率一致但方向相反同样被拒绝。
test('1920×1080 对 douyin-portrait 拒绝（方向相反）', () => {
  const issues = compareVideoSpec(
    { width: 1920, height: 1080, sar: '1:1', dar: '16:9', rotation: 0 },
    DOUYIN,
  );

  assert.equal(issues.length, 2);
  assert.match(issues[0], /源视频 1920×1080，期望 1080×1920（画布预设 douyin-portrait）/);
  assert.match(issues[1], /DAR 16:9，期望 9:16/);
});

// 旋转 90° 的横拍素材竖着看：应按互换后的宽高比对。
test('旋转 90° 的 1920×1080 对 douyin-portrait 通过', () => {
  assert.deepEqual(
    compareVideoSpec({ width: 1920, height: 1080, sar: '1:1', dar: '16:9', rotation: 90 }, DOUYIN),
    [],
  );
});

// 旋转 -90°（旧版 tags.rotate 语义）同样是四分之一圈，按互换处理。
test('旋转 -90° 的 1920×1080 对 douyin-portrait 通过', () => {
  assert.deepEqual(
    compareVideoSpec({ width: 1920, height: 1080, sar: '1:1', dar: '16:9', rotation: -90 }, DOUYIN),
    [],
  );
});

// 180° 不互换宽高：1920×1080 倒着放仍是横屏，对竖屏预设必须拒绝。
test('旋转 180° 的 1920×1080 不视为宽高互换', () => {
  const issues = compareVideoSpec(
    { width: 1920, height: 1080, sar: '1:1', dar: '16:9', rotation: 180 },
    DOUYIN,
  );

  assert.match(issues[0], /源视频 1920×1080（旋转 180°），期望 1080×1920/);
});

test('旋转 90° 但互换后仍不匹配时拒绝', () => {
  const issues = compareVideoSpec(
    { width: 3840, height: 1612, sar: '1:1', dar: '960:403', rotation: 90 },
    DOUYIN,
  );

  assert.match(issues[0], /源视频 3840×1612（旋转 90°），期望 1080×1920/);
});

// SAR 单独比较：非方形像素即使宽高正确也拒绝。
test('SAR 不是 1:1 时拒绝并报告实际 SAR', () => {
  const issues = compareVideoSpec(
    { width: 1080, height: 1920, sar: '4:3', dar: '3:4', rotation: 0 },
    DOUYIN,
  );

  assert.match(issues[0], /源视频 SAR 4:3，期望 1:1（画布预设 douyin-portrait）/);
});

// DAR 单独比较：宽高正确但显示比例不符时拒绝。
test('DAR 与预设不符时拒绝并报告期望比例', () => {
  const issues = compareVideoSpec(
    { width: 1080, height: 1920, sar: '1:1', dar: '16:9', rotation: 0 },
    DOUYIN,
  );

  assert.match(issues[0], /源视频 DAR 16:9，期望 9:16（画布预设 douyin-portrait）/);
});

// ffprobe 对未标注 SAR 的素材给 0:1，按方形像素处理（ffmpeg 的约定），不误杀。
test('SAR 未知（0:1）按 1:1 处理', () => {
  assert.deepEqual(
    compareVideoSpec({ width: 1080, height: 1920, sar: '0:1', dar: '9:16', rotation: 0 }, DOUYIN),
    [],
  );
});

test('probeVideo 读取真实文件的分辨率、SAR、DAR、时长与旋转', () => {
  const file = makeVideo({ key: 'probe-portrait', width: 1080, height: 1920 });
  const actual = probeVideo(file);

  assert.equal(actual.width, 1080);
  assert.equal(actual.height, 1920);
  assert.equal(actual.sar, '1:1');
  assert.equal(actual.dar, '9:16');
  assert.equal(actual.rotation, 0);
  assert.ok(Math.abs(actual.durationSec - 1) < 0.05);
});

test('probeVideo 读取旋转元数据', () => {
  const file = makeVideo({ key: 'probe-rot90', width: 1920, height: 1080, rotation: 90 });
  const actual = probeVideo(file);

  assert.equal(actual.rotation, 90);
  assert.deepEqual(compareVideoSpec(actual, DOUYIN), []);
});
