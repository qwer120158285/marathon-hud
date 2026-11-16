import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { runCli, VALID_PROJECT_PATH } from './helpers/cli.mjs';

const FIXTURES = path.join(path.dirname(VALID_PROJECT_PATH));
const OVERFLOW_PATH = path.join(FIXTURES, 'project.landscape-overflow.json');
const STACKING_PATH = path.join(FIXTURES, 'project.stacking.json');

// 验收项：`--validate-only` 在 Schema 校验通过后跑联合校验；通过时退出码 0。
test('合法布局通过联合校验，报告覆盖全部目标预设', () => {
  const { code, stdout, stderr } = runCli(['--project', VALID_PROJECT_PATH, '--validate-only']);

  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /联合校验通过：douyin-portrait、bilibili-landscape（4 个组件）/);
});

// 验收项：ticket 必测失败用例——真实 fixture「竖屏通过、横屏越界」必须被拒绝，
// 错误文本含具体预设、组件与越界量（B 站上边越界 520 px = 13 格）。
test('竖屏通过、横屏越界的布局以退出码 2 拒绝并列出预设、组件与越界量', () => {
  const { code, stdout, stderr } = runCli(['--project', OVERFLOW_PATH, '--validate-only']);

  assert.equal(code, 2);
  assert.doesNotMatch(stdout, /校验通过/);
  assert.match(
    stderr,
    /错误：画布预设 bilibili-landscape：组件 metrics 超出安全区——上边越界 520 px（13 格）/,
  );
  assert.match(stderr, /联合校验失败：1 处错误/);
  assert.doesNotMatch(stderr, /画布预设 douyin-portrait：组件 metrics/);
});

// 验收项：冲突提示只提示不阻止——文字叠在透明底板上通过校验，退出码 0，提示与错误分开。
test('允许的层叠只输出提示，不影响退出码', () => {
  const { code, stdout, stderr } = runCli(['--project', STACKING_PATH, '--validate-only']);

  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /联合校验通过/);
  assert.match(stdout, /提示（仅提示，不阻止保存）/);
  assert.match(
    stdout,
    /画布预设 douyin-portrait：组件 route 与 weather 层叠（zIndex 5 覆盖 1），重叠区域 240 × 240 px/,
  );
});
