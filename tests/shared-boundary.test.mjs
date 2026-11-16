import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_DIR = fileURLToPath(new URL('../shared', import.meta.url));

/** 收集 shared/ 下的源码文件；`.md` 文档不受本扫描约束（文档需要举例说明禁用项）。 */
function collectSourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(fullPath);
    return /\.(js|mjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

// ADR 0001 技术边界 1 与 GLOSSARY「共享绘制模块」：共享逻辑不共享运行环境。
const FORBIDDEN = [
  { label: 'window', pattern: /\bwindow\b/ },
  { label: 'document', pattern: /\bdocument\b/ },
  { label: 'process', pattern: /\bprocess\b/ },
  { label: 'require()', pattern: /\brequire\s*\(/ },
  { label: 'node: 专有模块', pattern: /['"]node:/ },
];

// 验收项 4：shared/ 内部不引用 window / document / DOM / Node 专有 API。
test('shared/ 源码不引用 window、document、process、require() 或 node: 专有模块', () => {
  const files = collectSourceFiles(SHARED_DIR);
  assert.ok(files.length > 0, 'shared/ 下应当存在可扫描的源码文件');

  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(source)) {
        violations.push(`${path.relative(SHARED_DIR, file)} 出现 ${label}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

// 验收项 4：画布创建与字体注册只由两端薄适配层提供，接口以文档形式冻结。
test('两端薄适配层接口约定写明 createCanvas 与 registerFonts', () => {
  const doc = readFileSync(path.join(SHARED_DIR, 'adapter-contract.md'), 'utf8');

  assert.match(doc, /createCanvas/);
  assert.match(doc, /registerFonts/);
  assert.match(doc, /只由适配层/);
});
