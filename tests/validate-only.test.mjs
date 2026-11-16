import test from 'node:test';
import assert from 'node:assert/strict';

import { runCli, VALID_PROJECT_PATH, brokenProject } from './helpers/cli.mjs';

// 验收项 1：合法 project.json 经 --validate-only 通过，报告覆盖全部目标预设，退出码 0。
test('合法 project.json 校验通过，报告覆盖两个目标预设', () => {
  const { code, stdout } = runCli(['--project', VALID_PROJECT_PATH, '--validate-only']);

  assert.equal(code, 0);
  assert.match(stdout, /douyin-portrait/);
  assert.match(stdout, /1080 × 1920/);
  assert.match(stdout, /27 列 × 48 行/);
  assert.match(stdout, /列 2–24，行 4–41/);
  assert.match(stdout, /bilibili-landscape/);
  assert.match(stdout, /1920 × 1080/);
  assert.match(stdout, /48 列 × 27 行/);
  assert.match(stdout, /列 2–45，行 2–23/);
});

// 验收项 2：version 不合法 → 退出码 2，错误文本点名 version。
test('version 非法时退出码 2 并指出 version 字段', () => {
  const file = brokenProject((project) => {
    project.version = 2;
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /version 必须为 1，实际为 2/);
});

// 验收项 2：gridVersion 与 version 相互独立（ADR 0005 工程约束 3），各自点名报错。
test('gridVersion 非法时退出码 2 并指出 gridVersion 字段', () => {
  const file = brokenProject((project) => {
    project.gridVersion = 2;
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /gridVersion 必须为 1，实际为 2/);
  assert.doesNotMatch(stderr, /version 必须为 1/);
});

// 验收项 2：SPEC-v1 第 3.1 节「components[] 中同一 id 只能出现一次」。
test('components[] 的 id 重复时退出码 2 并指出重复的两处', () => {
  const file = brokenProject((project) => {
    project.layout.components[2].id = 'route';
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /layout\.components\[2\]\.id 与 layout\.components\[1\]\.id 重复（"route"）/);
});

// 验收项 2：目标预设为空 → 退出码 2（Schema targetPresets.minItems = 1）。
test('targetPresets 为空时退出码 2 并指出 targetPresets', () => {
  const file = brokenProject((project) => {
    project.targetPresets = [];
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /targetPresets 至少需要 1 项，实际为 0 项/);
});

// 验收项 2：目标预设未知 → 退出码 2，错误文本列出可用预设。
test('targetPresets 含未知预设时退出码 2 并列出可用预设', () => {
  const file = brokenProject((project) => {
    project.targetPresets = ['douyin-portrait', 'youtube-square'];
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(
    stderr,
    /targetPresets\[1\] 未知画布预设 "youtube-square"，可用预设：douyin-portrait、bilibili-landscape/,
  );
});

// 验收项 2：缺必填字段 → 退出码 2，错误文本指出字段全路径。
test('组件缺必填字段时退出码 2 并指出字段路径', () => {
  const file = brokenProject((project) => {
    delete project.layout.components[1].visible;
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /layout\.components\[1\]\.visible 是必填字段/);
});

// 验收项 2：类型错误 → 退出码 2，错误文本给出实际值与期望类型（ticket 举的例子）。
test('字段类型错误时退出码 2 并给出实际值', () => {
  const file = brokenProject((project) => {
    project.layout.components[2].colSpan = '8';
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /layout\.components\[2\]\.colSpan 必须是整数，实际为 "8"/);
});

// 验收项 2（类型错误的另一形态）：枚举值不在允许集合内。
test('枚举字段取值非法时退出码 2 并列出允许值', () => {
  const file = brokenProject((project) => {
    project.layout.components[0].anchor = 'top-center';
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(
    stderr,
    /layout\.components\[0\]\.anchor 必须是 top-left \/ top-right \/ bottom-left \/ bottom-right 之一，实际为 "top-center"/,
  );
});

// Schema targetPresets.uniqueItems：同一预设重复出现属于配置错误。
test('targetPresets 重复时退出码 2', () => {
  const file = brokenProject((project) => {
    project.targetPresets = ['douyin-portrait', 'douyin-portrait'];
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /targetPresets 不能包含重复项，重复值："douyin-portrait"/);
});

// ADR 0005：sourcePresetId 是编辑上下文，但仍是画布预设引用，未知值必须拒绝。
test('layout.sourcePresetId 未知时退出码 2', () => {
  const file = brokenProject((project) => {
    project.layout.sourcePresetId = 'youtube-square';
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /layout\.sourcePresetId 未知画布预设 "youtube-square"/);
});

// Schema 的 additionalProperties: false 是契约的一部分：拼错字段名必须被拒绝，而不是静默忽略。
test('未知字段时退出码 2 并指出字段名', () => {
  const file = brokenProject((project) => {
    project.layout.components[0].marginPx = 12;
  });

  const { code, stderr } = runCli(['--project', file, '--validate-only']);

  assert.equal(code, 2);
  assert.match(stderr, /layout\.components\[0\]\.marginPx 是未知字段/);
});
