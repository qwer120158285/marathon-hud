import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli, VALID_PROJECT_PATH, brokenProject } from './helpers/cli.mjs';
import { makeVideo, projectWithVideo } from './helpers/video.mjs';

// 验收项 5：`--project` 必填。
test('缺少 --project 时退出码 2 并说明该参数必填', () => {
  const { code, stderr } = runCli(['--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /--project 是必填参数/);
});

test('project.json 不存在时退出码 2 并给出路径', () => {
  const { code, stderr } = runCli(['--project', '/nonexistent/project.json', '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /无法读取 project\.json：\/nonexistent\/project\.json（文件不存在）/);
});

test('未知参数时退出码 2', () => {
  const { code, stderr } = runCli(['--project', VALID_PROJECT_PATH, '--fps', '60']);

  assert.equal(code, 2);
  assert.match(stderr, /未知参数 "--fps"/);
});

// 验收项 5：多目标预设未指定 --preset 时，出片模式报错（校验模式不报错，见 validate-only 测试）。
test('--dry-run 多目标预设未指定 --preset 时退出码 2', () => {
  const { code, stderr } = runCli(['--project', VALID_PROJECT_PATH, '--dry-run']);

  assert.equal(code, 2);
  assert.match(
    stderr,
    /存在 2 个目标预设，出片时必须用 --preset 指定其中一个：douyin-portrait、bilibili-landscape/,
  );
});

// #6 起 --dry-run 有真实行为（校验 + 出帧）；完整渲染仍由后续 ticket 提供。
// 这里只验「不再报 --dry-run 未实现」，校验细节见 tests/export-validation.test.mjs。
test('--dry-run 不再报未实现：源视频缺失时按数据源缺失退出码 4', () => {
  const { code, stderr } = runCli([
    '--project', VALID_PROJECT_PATH,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 4);
  assert.doesNotMatch(stderr, /本版本尚未实现出片流程/);
  assert.match(stderr, /\[ffprobe\] 无法读取源视频/);
});

test('--preset 不在 targetPresets 内时退出码 2', () => {
  const file = brokenProject((project) => {
    project.targetPresets = ['douyin-portrait'];
  });

  const { code, stderr } = runCli([
    '--project', file,
    '--preset', 'bilibili-landscape',
    '--validate-only',
  ]);

  assert.equal(code, 2);
  assert.match(stderr, /--preset "bilibili-landscape" 不在 targetPresets 内（当前：douyin-portrait）/);
});

// --validate-only 的承诺是「用同一份候选布局同时校验全部目标预设」：
// --preset 只决定出片预设，不影响校验范围（指定它也要校验两个）。
test('--validate-only 指定 --preset 时仍校验全部目标预设', () => {
  const { code, stdout } = runCli([
    '--project', VALID_PROJECT_PATH,
    '--preset', 'bilibili-landscape',
    '--validate-only',
  ]);

  assert.equal(code, 0);
  assert.match(stdout, /douyin-portrait/);
  assert.match(stdout, /bilibili-landscape/);
  assert.match(stdout, /联合校验通过：douyin-portrait、bilibili-landscape/);
});

// 配置错误（这里缺 sourceVideo）必须是退出码 2 + 可照着改的中文错误，不能漏成栈回溯。
for (const [label, mutate, expected] of [
  ['缺 sourceVideo', (project) => { delete project.sourceVideo; }, /sourceVideo\.path 缺失/],
  ['sourceVideo 不是对象', (project) => { project.sourceVideo = './assets/run.mp4'; }, /sourceVideo 必须是对象/],
  ['sourceVideo.path 为空', (project) => { project.sourceVideo = { path: '' }; }, /sourceVideo\.path 缺失/],
]) {
  test(`${label} 时退出码 2，错误点名 sourceVideo 且不打印栈回溯`, () => {
    const file = brokenProject(mutate);

    const { code, stderr } = runCli([
      '--project', file,
      '--preset', 'douyin-portrait',
      '--dry-run',
    ]);

    assert.equal(code, 2);
    assert.match(stderr, expected);
    assert.doesNotMatch(stderr, /\n\s+at /, '配置错误不应暴露栈回溯');
  });
}

// 共享绘制层抛普通 Error（例如卡片放不下）也要在 CLI 边界收口成退出码 2。
test('绘制期普通 Error（卡片容不下）在 CLI 边界转成退出码 2 并给中文提示', () => {
  const file = projectWithVideo(
    makeVideo({ key: 'portrait', width: 1080, height: 1920 }),
    (project) => {
      // 一行格位（40 px）放不下数据卡；联合校验仍然通过，失败点在绘制计划里。
      project.layout.components.find((item) => item.id === 'metrics').rowSpan = 1;
    },
  );

  const { code, stderr } = runCli([
    '--project', file,
    '--preset', 'douyin-portrait',
    '--dry-run',
  ]);

  assert.equal(code, 2);
  assert.match(stderr, /错误：组件 metrics 的矩形高 40 px 容不下 3 行数据卡/);
  assert.doesNotMatch(stderr, /\n\s+at /, '绘制期错误不应暴露栈回溯');
});
