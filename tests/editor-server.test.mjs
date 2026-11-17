/**
 * 本地编辑器服务的端点测试：静态文件、project.json 读写、目录穿越拦截。
 *
 * 服务既承担浏览器 `file://` 的替代，也承担保存前的 Schema 把关，
 * 所以这里既测 HTTP 语义，也测「非法配置不落盘」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateProject, loadSchema } from '../cli/project.mjs';
import { REPO_ROOT, startEditorServer } from '../editor/serve.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const VALID_PROJECT = readFileSync(path.join(FIXTURES, 'project.valid.json'), 'utf8');

/** 起一个临时服务，测试结束自动关闭。 */
async function withServer(t, options, run) {
  const handle = await startEditorServer(options);
  t.after(() => handle.close());
  return run(handle);
}

/** 临时项目目录：模拟仓库外的独立工程，避免测试写进工作区。 */
function tempRoot(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'hud-editor-'));
  writeFileSync(path.join(root, 'project.json'), VALID_PROJECT);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const apiUrl = (server, query) => `${server.url}/api/project?${query}`;

test('根路径返回编辑器页面，ES module 以 text/javascript 提供', async (t) => {
  await withServer(t, { root: REPO_ROOT }, async (server) => {
    const page = await fetch(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(await page.text(), /<canvas id="preview"/);

    for (const file of ['/editor/editor.js', '/shared/hud.js', '/shared/layout.js']) {
      const response = await fetch(`${server.url}${file}`);
      assert.equal(response.status, 200, file);
      assert.match(response.headers.get('content-type'), /^text\/javascript/, file);
    }

    const css = await fetch(`${server.url}/editor/editor.css`);
    assert.match(css.headers.get('content-type'), /^text\/css/);
  });
});

test('GET /api/project 读取仓库根的示例配置', async (t) => {
  await withServer(t, { root: REPO_ROOT }, async (server) => {
    const response = await fetch(apiUrl(server, 'path=project.json'));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.path, 'project.json');
    assert.equal(body.project.version, 1);
    assert.equal(body.project.layout.components.length, 4);
    assert.deepEqual(body.project.targetPresets, ['douyin-portrait', 'bilibili-landscape']);
  });
});

test('拒绝越界的项目路径，不返回仓库外文件', async (t) => {
  await withServer(t, { root: REPO_ROOT }, async (server) => {
    for (const requested of ['../package.json', '%2e%2e%2fpackage.json', '/etc/passwd']) {
      const response = await fetch(apiUrl(server, `path=${requested}`));
      const body = await response.json();
      assert.equal(response.status, 400, requested);
      assert.equal(body.ok, false);
      assert.match(body.errors[0], /项目路径/, requested);
    }
  });
});

test('静态文件请求也不能穿越到允许目录之外', async (t) => {
  await withServer(t, { root: REPO_ROOT }, async (server) => {
    // URL 解析会把 %2e%2e 归一化成 ..，最终落到允许目录之外：无论 400 还是 404，都不能泄漏内容。
    const escaped = await fetch(`${server.url}/shared/%2e%2e/%2e%2e/package.json`);
    assert.notEqual(escaped.status, 200);
    assert.doesNotMatch(await escaped.text(), /marathon-hud/);

    const unknown = await fetch(`${server.url}/api/unknown`);
    assert.equal(unknown.status, 404);
  });
});

test('PUT 合法配置落盘，并且能被 CLI 的 Schema 校验通过', async (t) => {
  const root = tempRoot(t);
  await withServer(t, { root }, async (server) => {
    const project = JSON.parse(VALID_PROJECT);
    project.layout.components.find((item) => item.id === 'metrics').col = 3;

    const response = await fetch(apiUrl(server, 'path=project.json'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(project),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, path: 'project.json', project });

    const saved = JSON.parse(readFileSync(path.join(root, 'project.json'), 'utf8'));
    assert.equal(saved.layout.components.find((item) => item.id === 'metrics').col, 3);
    assert.deepEqual(validateProject(saved, loadSchema()), []);

    const reloaded = await (await fetch(apiUrl(server, 'path=project.json'))).json();
    assert.deepEqual(reloaded.project.layout.components, project.layout.components);
  });
});

test('PUT 不合 Schema 的配置返回 422、带回错误文本，且不覆盖磁盘文件', async (t) => {
  const root = tempRoot(t);
  await withServer(t, { root }, async (server) => {
    const broken = JSON.parse(VALID_PROJECT);
    broken.version = 2;
    broken.layout.components[0].colSpan = 0;

    const response = await fetch(apiUrl(server, 'path=project.json'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(broken),
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.ok(body.errors.some((error) => /version 必须为 1/.test(error)));
    assert.ok(body.errors.some((error) => /colSpan 不能小于 1/.test(error)));
    assert.equal(readFileSync(path.join(root, 'project.json'), 'utf8'), VALID_PROJECT);
  });
});

test('PUT 非法 JSON 返回 422 并指出不是合法 JSON', async (t) => {
  const root = tempRoot(t);
  await withServer(t, { root }, async (server) => {
    const response = await fetch(apiUrl(server, 'path=project.json'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{ "version": 1, ',
    });
    const body = await response.json();

    assert.equal(response.status, 422);
    assert.equal(body.ok, false);
    assert.match(body.errors[0], /不是合法 JSON/);
    assert.equal(readFileSync(path.join(root, 'project.json'), 'utf8'), VALID_PROJECT);
  });
});

test('GET 不存在的项目返回 404', async (t) => {
  const root = tempRoot(t);
  await withServer(t, { root }, async (server) => {
    const response = await fetch(apiUrl(server, 'path=missing.json'));
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.ok, false);
    assert.match(body.errors[0], /文件不存在/);
  });
});
