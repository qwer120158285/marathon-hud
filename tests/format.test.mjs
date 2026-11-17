/**
 * 报告数字格式只有一处实现（shared/format.js）。
 *
 * 期望值来源：CLI 报告与编辑器读数的既有输出——整数不带小数点、小数最多三位，
 * 非有限值与缺失值原样写明，不吞成 0。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatNumber } from '../shared/format.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('formatNumber 对整数、小数与特殊值逐字输出', () => {
  const cases = [
    [0, '0'],
    [12, '12'],
    [-7, '-7'],
    [1.2345, '1.235'],
    [1.2344, '1.234'],
    [0.0004, '0'],
    [-2.5, '-2.5'],
    [1234567, '1234567'],
    [1 / 3, '0.333'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [undefined, '缺失'],
    ['8', '8'],
  ];

  for (const [value, expected] of cases) {
    assert.equal(formatNumber(value), expected, `formatNumber(${String(value)})`);
  }
});

test('报告层不再各自实现 formatNumber，统一从 shared/format.js 引用', () => {
  const files = [
    'shared/layout.js',
    'cli/data.mjs',
    'cli/render.mjs',
    'cli/weather.mjs',
    'editor/editor.js',
  ];

  for (const relative of files) {
    const source = readFileSync(path.join(REPO_ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /function\s+formatNumber\b/, `${relative} 仍在本地定义 formatNumber`);
    assert.match(
      source,
      /import\s*\{[^}]*\bformatNumber\b[^}]*\}\s*from\s*['"][^'"]*format\.js['"]/s,
      `${relative} 应从 shared/format.js 引用 formatNumber`,
    );
  }
});
