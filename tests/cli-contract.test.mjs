import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseArgs,
  planPresets,
  EXIT_SUCCESS,
  EXIT_CONFIG_ERROR,
  EXIT_FFMPEG_ERROR,
  EXIT_DATA_MISSING,
} from '../cli/args.mjs';

// 期望值来源：SPEC-v1 第 4 节 CLI 参数表。
test('解析全部 CLI 参数', () => {
  const args = parseArgs([
    '--project', 'tests/fixtures/project.valid.json',
    '--preset', 'douyin-portrait',
    '--out', 'out/final.mp4',
    '--dry-run',
    '--validate-only',
  ]);

  assert.deepEqual(args, {
    project: 'tests/fixtures/project.valid.json',
    preset: 'douyin-portrait',
    out: 'out/final.mp4',
    dryRun: true,
    validateOnly: true,
    help: false,
  });
});

// 期望值来源：SPEC-v1 第 4 节「存在多个目标预设且不指定时报错」。
test('出片模式下多个目标预设未指定 --preset 时报错', () => {
  assert.throws(
    () => planPresets({
      targetPresets: ['douyin-portrait', 'bilibili-landscape'],
      presetId: undefined,
      mode: 'render',
    }),
    /存在 2 个目标预设，出片时必须用 --preset 指定其中一个：douyin-portrait、bilibili-landscape/,
  );
});

// 期望值来源：ticket #2 与 SPEC-v1 第 4 节——`--validate-only` 就是校验全部目标预设，不要求 --preset。
test('校验模式下多个目标预设不需要 --preset，覆盖全部目标预设', () => {
  const presets = planPresets({
    targetPresets: ['douyin-portrait', 'bilibili-landscape'],
    presetId: undefined,
    mode: 'validate',
  });

  assert.deepEqual(presets, ['douyin-portrait', 'bilibili-landscape']);
});

test('--preset 不在 targetPresets 内时报错', () => {
  assert.throws(
    () => planPresets({
      targetPresets: ['douyin-portrait'],
      presetId: 'bilibili-landscape',
      mode: 'validate',
    }),
    /--preset "bilibili-landscape" 不在 targetPresets 内（当前：douyin-portrait）/,
  );
});

test('单目标预设出片不需要 --preset', () => {
  assert.deepEqual(
    planPresets({ targetPresets: ['bilibili-landscape'], presetId: undefined, mode: 'render' }),
    ['bilibili-landscape'],
  );
});

// 期望值来源：SPEC-v1 第 4 节退出码表。
test('退出码常量：0 成功 / 2 配置或校验失败 / 3 FFmpeg 失败 / 4 数据源缺失', () => {
  assert.equal(EXIT_SUCCESS, 0);
  assert.equal(EXIT_CONFIG_ERROR, 2);
  assert.equal(EXIT_FFMPEG_ERROR, 3);
  assert.equal(EXIT_DATA_MISSING, 4);
});
