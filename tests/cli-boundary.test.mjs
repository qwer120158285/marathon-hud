import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli, VALID_PROJECT_PATH, brokenProject } from './helpers/cli.mjs';

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

// --validate-only 指定 --preset 时只报告该预设。
test('--validate-only 指定 --preset 时只校验该预设', () => {
  const { code, stdout } = runCli([
    '--project', VALID_PROJECT_PATH,
    '--preset', 'bilibili-landscape',
    '--validate-only',
  ]);

  assert.equal(code, 0);
  assert.match(stdout, /bilibili-landscape/);
  assert.doesNotMatch(stdout, /douyin-portrait/);
});
