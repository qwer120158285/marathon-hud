import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';
import { FONT_MANIFEST, registerFonts } from '../cli/adapter.mjs';
import { FONT_FAMILY } from '../shared/theme.js';

const FONTS_DIR = fileURLToPath(new URL('../shared/fonts', import.meta.url));
const SHARED_DIR = fileURLToPath(new URL('../shared', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(FONTS_DIR, 'FONTS.json'), 'utf8'));

/** 收集 shared/ 下的源码文件；`.md` 只作文档，不受本扫描约束。 */
function collectSharedSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectSharedSources(fullPath);
    return /\.(js|mjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

/** 系统字体名：出现在 shared/ 源码里就意味着「换机器字形会变」，基准图随之不可复现。 */
const SYSTEM_FONT_PATTERN = /\b(PingFang|Hiragino|Noto|Source Han|Heiti|Songti|Microsoft YaHei|Arial|Helvetica|Roboto|SF Pro|system-ui|sans-serif)\b/i;

/** 重新计算文件 SHA-256，与清单里登记的值比对。 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(path.join(FONTS_DIR, file))).digest('hex');
}

// ADR 0001「字体」：固定字体文件版本与 SHA-256，防止日后升级字体导致基准图漂移。
test('FONTS.json 登记 Inter 4.1 与 SIL OFL 1.1 许可', () => {
  assert.equal(manifest.family, 'Inter');
  assert.equal(manifest.version, '4.1');
  assert.match(manifest.license, /SIL Open Font License 1\.1/);
  assert.doesNotThrow(() => readFileSync(path.join(FONTS_DIR, manifest.licenseFile)));
});

// 两个适配层按 weight 显式注册同一批文件；缺一档就会退回系统字体，基准图随之改变。
test('FONTS.json 登记 Regular / Medium / SemiBold / Bold 四个字重', () => {
  assert.deepEqual(
    manifest.files.map((file) => file.weight),
    [400, 500, 600, 700],
  );
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['Inter-Regular.ttf', 'Inter-Medium.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf'],
  );
});

test('每个字体文件的 SHA-256 与 FONTS.json 登记值一致', () => {
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${file.path} 的 sha256 字段格式不对`);
    assert.equal(sha256(file.path), file.sha256, `${file.path} 的 SHA-256 与清单不一致`);
  }
});

// 验收项 3：字体在绘制前由适配层显式注册，且四个字重都挂在同一家族上。
test('Node 适配层把 Inter 四个字重注册到同一家族', async () => {
  await registerFonts();

  const family = GlobalFonts.families.find((entry) => entry.family === FONT_MANIFEST.family);
  assert.ok(family !== undefined, `未注册家族 ${FONT_MANIFEST.family}`);
  assert.equal(family.styles.length, FONT_MANIFEST.files.length);
});

// ADR 0001「字体文件随项目打包，不依赖操作系统字体」：
// shared/ 只能出现随项目打包的 Inter 家族名，出现任何系统字体名都意味着换机器时字宽会变。
test('shared/ 源码只使用随项目打包的 Inter，不出现系统字体名', () => {
  const files = collectSharedSources(SHARED_DIR);
  assert.ok(files.length > 0, 'shared/ 下应当存在可扫描的源码文件');

  const violations = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const match = SYSTEM_FONT_PATTERN.exec(source);
    if (match !== null) {
      violations.push(`${path.relative(SHARED_DIR, file)} 出现系统字体名 ${match[0]}`);
    }
  }

  assert.deepEqual(violations, []);
});

// 字体串必须由 FONT_FAMILY 拼出，且 FONT_FAMILY 就是 FONTS.json 登记的家族。
// 这条同时挡住「写死一个字符串字面量的第二个家族」这类回退。
test('绘制代码的字体族只来自 FONT_FAMILY（= FONTS.json 的 Inter）', () => {
  assert.equal(FONT_FAMILY, 'Inter');
  assert.equal(FONT_FAMILY, manifest.family);

  const targets = ['hud.js', 'theme.js'].map((name) => path.join(SHARED_DIR, name));
  const violations = [];

  for (const file of targets) {
    const source = readFileSync(file, 'utf8');
    // `px "某个家族"` / `px '某个家族'` / `px \`某个家族\``：字符串字面量的字体族。
    const literal = /px\s+["'`][^"'`]*["'`]/.exec(source);
    if (literal !== null) {
      violations.push(`${path.relative(SHARED_DIR, file)} 写死了字体族字面量：${literal[0]}`);
    }
    if (!source.includes('${FONT_FAMILY}') && path.basename(file) === 'hud.js') {
      violations.push('hud.js 没有用 ${FONT_FAMILY} 拼字体串');
    }
  }

  assert.deepEqual(violations, []);
});
