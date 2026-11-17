/**
 * CLI 进程边界：`--dry-run` 的导出前全量校验与完整 RGBA 管道。
 *
 * 期望值来源：
 * - 校验顺序与退出码：SPEC-v1 第 4 节、ADR 0003「导出流程」；
 * - 字节数：W × H × 4 × 帧数（1080×1920×4 = 8294400，1 s @ 30 fps = 30 帧 → 248832000）；
 * - 视频规格是 ffmpeg 现场生成素材的 ffprobe 实测值，不写死假 JSON。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runCli, readValidProject, REPO_ROOT } from './helpers/cli.mjs';
import { makeVideo, projectWithVideo } from './helpers/video.mjs';
import { checkHudFrameSize, EXPORT_STAGE_ORDER, StageError, staleProbedDuration } from '../cli/validate-pipeline.mjs';
import { verifyFontResources } from '../cli/adapter.mjs';
import { resolvePreset } from '../shared/presets.js';

const DOUYIN = resolvePreset('douyin-portrait');

// 验收项：校验顺序固定为 配置 Schema → 联合校验 → 字体与资源 → ffprobe → HUD 帧尺寸 → 启动 FFmpeg。
test('导出前校验顺序固定，与 SPEC-v1 第 4 节一致', () => {
  assert.deepEqual(EXPORT_STAGE_ORDER, [
    'schema',
    'joint',
    'resources',
    'ffprobe',
    'hud-size',
    'ffmpeg-start',
  ]);
});

test('HUD 帧尺寸校验：画布工厂尺寸不符时报 hud-size 环节', () => {
  assert.throws(
    () => checkHudFrameSize({
      preset: DOUYIN,
      createFrameCanvas: () => ({ canvas: { width: 1080, height: 1081 }, ctx: {} }),
    }),
    (error) => {
      assert.ok(error instanceof StageError);
      assert.equal(error.stageId, 'hud-size');
      assert.match(error.message, /HUD 帧尺寸 1080×1081，期望 1080×1920（画布预设 douyin-portrait）/);
      return true;
    },
  );
});

test('字体资源校验：SHA-256 与清单不一致时报字体与资源环节', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-fonts-'));
  writeFileSync(path.join(dir, 'Inter-Regular.ttf'), 'not a font');
  const manifest = {
    family: 'Inter',
    files: [{ path: 'Inter-Regular.ttf', weight: 400, sha256: '0'.repeat(64) }],
  };

  assert.throws(
    () => verifyFontResources({ dir, manifest }),
    /字体文件 Inter-Regular\.ttf 的 SHA-256 与清单不一致/,
  );
});

test('字体资源校验：文件缺失时点名文件', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-fonts-'));
  const manifest = {
    family: 'Inter',
    files: [{ path: 'Inter-Bold.ttf', weight: 700, sha256: '0'.repeat(64) }],
  };

  assert.throws(
    () => verifyFontResources({ dir, manifest }),
    /字体文件 Inter-Bold\.ttf 不存在/,
  );
});

// 验收项：--dry-run 跑到全量校验通过，跑完整帧循环，写入字节数 = W×H×4×帧数。
test('--dry-run 通过全量校验后跑完整帧循环并报告字节数等式', () => {
  const file = projectWithVideo(makeVideo({ key: 'portrait', width: 1080, height: 1920 }));

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /校验通过/);
  assert.match(stdout, /画布预设\s+douyin-portrait（抖音竖屏）/);
  assert.match(stdout, /画布尺寸\s+1080 × 1920/);
  assert.match(stdout, /帧率\s+30 fps（固定）/);
  assert.match(stdout, /帧循环完成：30 帧/);
  assert.match(stdout, /写入 RGBA 管道 248832000 字节（= 8294400 × 30）/);
  assert.match(stdout, /未启动 FFmpeg/);
  assert.doesNotMatch(stdout, /错误/);
});

// 验收项：--preset 从目标预设中指定本次出片预设；单目标预设可省略。
test('--dry-run 只有一个目标预设时可省略 --preset', () => {
  const file = projectWithVideo(
    makeVideo({ key: 'portrait', width: 1080, height: 1920 }),
    (project) => {
      project.targetPresets = ['douyin-portrait'];
    },
  );

  const { code, stdout, stderr } = runCli(['--project', file, '--dry-run']);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /画布预设\s+douyin-portrait/);
});

// 验收项：--preset 必须在 targetPresets 内。
test('--dry-run 的 --preset 不在 targetPresets 内时退出码 2', () => {
  const file = projectWithVideo(
    makeVideo({ key: 'portrait', width: 1080, height: 1920 }),
    (project) => {
      project.targetPresets = ['douyin-portrait'];
    },
  );

  const { code, stderr } = runCli([
    '--project', file,
    '--preset', 'bilibili-landscape',
    '--dry-run',
  ]);

  assert.equal(code, 2);
  assert.match(stderr, /--preset "bilibili-landscape" 不在 targetPresets 内（当前：douyin-portrait）/);
});

// 验收项：3840×1612 对 1080×1920 必须拒绝，错误文本含实际值与期望值，退出码 2。
test('--dry-run 拒绝 3840×1612 源视频，错误可定位到 ffprobe 环节', () => {
  const file = projectWithVideo(makeVideo({ key: 'wide-3840x1612', width: 3840, height: 1612 }));

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 2);
  assert.match(stderr, /\[ffprobe\] 源视频 3840×1612，期望 1080×1920（画布预设 douyin-portrait）/);
  assert.doesNotMatch(stdout, /帧循环完成/);
});

// 验收项：分辨率一致但方向相反的素材同样被拒绝。
test('--dry-run 拒绝 1920×1080 对抖音竖屏（方向相反）', () => {
  const file = projectWithVideo(makeVideo({ key: 'landscape', width: 1920, height: 1080 }));

  const { code, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 2);
  assert.match(stderr, /\[ffprobe\] 源视频 1920×1080，期望 1080×1920（画布预设 douyin-portrait）/);
});

// ADR 0003：手机素材的旋转标记不能只依赖容器报告的宽高——横拍竖看应允许。
test('--dry-run 接受旋转 90° 的 1920×1080 素材（互换后匹配）', () => {
  const file = projectWithVideo(makeVideo({
    key: 'landscape-rot90',
    width: 1920,
    height: 1080,
    rotation: 90,
  }));

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /旋转 90°/);
});

// 源视频不存在属于「数据源缺失」，退出码 4（与 tcx 缺失同口径）。
test('--dry-run 遇到缺失源视频时退出码 4，错误可定位到 ffprobe 环节', () => {
  const file = projectWithVideo(makeVideo({ key: 'portrait', width: 1080, height: 1920 }), (project) => {
    project.sourceVideo = { path: './missing.mp4' };
  });

  const { code, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 4);
  assert.match(stderr, /\[ffprobe\] 无法读取源视频：.*missing\.mp4（文件不存在）/);
});

test('--dry-run 遇到无法解析的源视频时退出码 4', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-badvideo-'));
  writeFileSync(path.join(dir, 'broken.mp4'), 'not a video');
  const project = readValidProject();
  project.sourceVideo = { path: './broken.mp4' };
  project.tcx = { path: path.relative(dir, path.join(REPO_ROOT, 'activity_662602587.tcx')) };
  const file = path.join(dir, 'project.json');
  writeFileSync(file, JSON.stringify(project, null, 2));

  const { code, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 4);
  assert.match(stderr, /\[ffprobe\] ffprobe 无法解析源视频：.*broken\.mp4/);
});

// 校验失败必须发生在编码之前：联合校验在 ffprobe 之前，前一步失败就不再探测视频。
test('校验顺序：联合校验失败时停在 [joint]，不进入 [ffprobe]', () => {
  const overflow = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'tests/fixtures/project.landscape-overflow.json'), 'utf8'),
  );
  const file = projectWithVideo(
    makeVideo({ key: 'portrait', width: 1080, height: 1920 }),
    (project) => {
      project.layout = overflow.layout;
    },
  );

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 2);
  assert.match(stderr, /\[joint\] 画布预设 bilibili-landscape：组件 metrics 超出安全区/);
  assert.doesNotMatch(stderr, /\[ffprobe\]/);
  assert.doesNotMatch(stdout, /帧循环完成/);
});

// 验收项：--validate-only 不加载媒体、不启动 ffprobe。
test('--validate-only 不探测源视频：视频不存在也照样通过', () => {
  const file = projectWithVideo(makeVideo({ key: 'portrait', width: 1080, height: 1920 }), (project) => {
    project.sourceVideo = { path: './missing.mp4' };
  });

  const { code, stdout, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /联合校验通过/);
  assert.doesNotMatch(stderr, /ffprobe/);
});

// `--dry-run` 的边界：跑完校验与出帧就停，不启动 FFmpeg、不写成片（合成见 e2e-render.test.mjs）。
test('--dry-run 不启动 FFmpeg，也不写出成片', () => {
  const file = projectWithVideo(makeVideo({ key: 'portrait', width: 1080, height: 1920 }));

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /未启动 FFmpeg/);
  // fixture 的 output.path 是 ./out/final.mp4。
  assert.equal(
    existsSync(path.join(path.dirname(file), 'out', 'final.mp4')),
    false,
    '--dry-run 不应产生成片文件',
  );
});

// ffmpeg 用 0:1 表示「未标注」；报告里不能印成「零比一」，要写清实际按什么处理。
test('--dry-run 把未标注的 SAR / DAR 写成「未标注（按…处理）」，不印 0:1', () => {
  const videoPath = makeVideo({
    key: 'portrait-unspecified-sar',
    width: 1080,
    height: 1920,
    sar: '0',
  });
  const file = projectWithVideo(videoPath);

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /SAR 未标注（按 1:1 处理）/);
  assert.match(stdout, /DAR 未标注（按画面宽高处理）/);
  assert.doesNotMatch(stdout, /SAR 0:1/);
  assert.doesNotMatch(stdout, /DAR 0:1/);
  // 行为不变：仍然是按方形像素处理，校验照样通过。
  assert.match(stdout, /帧循环完成：30 帧/);
});

// sourceVideo.probed 只是记录，不参与校验；但记录值过期到超过 1 s 就要提示，并给出刷新命令。
test('probed.durationSec 与实测差 ≤1 s 不提示，>1 s 报一条不阻断的过期提示', () => {
  const video = { durationSec: 12 };

  assert.equal(staleProbedDuration({ sourceVideo: { probed: { durationSec: 12.4 } } }, video, '/x.mp4'), null);
  assert.equal(staleProbedDuration({ sourceVideo: {} }, video, '/x.mp4'), null);
  assert.equal(staleProbedDuration({}, video, '/x.mp4'), null);

  const warning = staleProbedDuration({ sourceVideo: { probed: { durationSec: 80 } } }, video, '/x.mp4');
  assert.match(warning, /sourceVideo\.probed\.durationSec 记录值 80 s/);
  assert.match(warning, /ffprobe 实测 12\.000 s/);
  assert.match(warning, /相差 68 s/);
  assert.match(warning, /本次按实测时长出片/);
  assert.match(warning, /ffprobe -v error -print_format json -show_streams -show_format "\/x\.mp4"/);
  assert.match(warning, /写回 project\.json/);
});

test('--dry-run 遇到过期的 probed.durationSec 仍成功出帧，只在 stderr 提示', () => {
  const file = projectWithVideo(
    makeVideo({ key: 'probed-stale', width: 1080, height: 1920 }),
    (project) => {
      project.sourceVideo.probed = {
        width: 1080, height: 1920, sar: '1:1', dar: '9:16', rotation: 0, durationSec: 80,
      };
    },
  );

  const { code, stdout, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /帧循环完成：30 帧/);
  assert.match(stderr, /提示：sourceVideo\.probed\.durationSec 记录值 80 s/);
  assert.match(stderr, /相差 79 s/);
  assert.match(stderr, /ffprobe -v error -print_format json/);
});

