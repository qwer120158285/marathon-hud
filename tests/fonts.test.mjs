import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts } from '@napi-rs/canvas';
import { FONT_MANIFEST, registerFonts } from '../cli/adapter.mjs';

const FONTS_DIR = fileURLToPath(new URL('../shared/fonts', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(FONTS_DIR, 'FONTS.json'), 'utf8'));

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
