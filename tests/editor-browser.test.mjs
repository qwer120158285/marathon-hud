/**
 * 编辑器 UI 冒烟测试：Chrome headless 真实加载页面，检查
 * 「无 console 报错 + 预览画出像素 + 预设展示 + 预设切换 + 保存拒绝」。
 *
 * 不模拟鼠标手势（ticket 明确不测），几何正确性由 editor-layout.test.mjs 覆盖；
 * 这里验证的是事件绑定、DOM 渲染与接口联动真的能跑起来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadSchema, validateProject } from '../cli/project.mjs';
import { findChrome, launchChrome } from './golden-browser.mjs';
import { REPO_ROOT, startEditorServer } from '../editor/serve.mjs';

const chrome = findChrome();
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 在页面里执行表达式并取回可序列化结果。 */
async function evaluate(cdp, sessionId, expression) {
  const { result } = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return result?.value;
}

/** 轮询页面状态，直到条件满足或超时。 */
async function waitFor(cdp, sessionId, expression, predicate, label) {
  const deadline = Date.now() + 15000;
  let value;
  while (Date.now() < deadline) {
    value = await evaluate(cdp, sessionId, expression);
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`${label} 等待超时，最后取值：${JSON.stringify(value)}`);
}

/** 关闭 Chrome，并等进程真正退出后再删临时 profile，避免与 Chrome 的写入抢文件。 */
async function stopChrome({ child, cdp, socket }) {
  try {
    await cdp.send('Browser.close');
  } catch {
    // 浏览器已退出时忽略。
  }
  socket.close();

  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGKILL');
  });
}

/** 打开页面、等就绪信号，然后把页面交给回调。 */
async function withEditorPage(t, run) {
  const handle = await startEditorServer({ root: REPO_ROOT });
  t.after(() => handle.close());

  const profileDir = mkdtempSync(path.join(tmpdir(), 'hud-editor-chrome-'));
  const { child, cdp, socket } = await launchChrome({ chrome, profileDir });
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    await cdp.send('Page.navigate', { url: `${handle.url}/` }, sessionId);

    await waitFor(
      cdp,
      sessionId,
      'document.body.dataset.editorReady',
      (value) => value === 'true',
      '编辑器就绪信号',
    );

    return await run({ cdp, sessionId, url: handle.url });
  } finally {
    await stopChrome({ child, cdp, socket });
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test(
  '编辑器页面载入示例配置：无 console 报错、预览有像素、预设与组件正确渲染',
  { skip: chrome === null ? '未找到 Chrome，跳过编辑器 UI 冒烟' : false },
  async (t) => {
    await withEditorPage(t, async ({ cdp, sessionId }) => {
      const snapshot = await evaluate(cdp, sessionId, `(() => ({
        consoleErrors: document.body.dataset.consoleErrors,
        renderedPixels: Number(document.body.dataset.renderedPixels ?? '0'),
        projectMeta: document.getElementById('project-meta').textContent,
        summary: document.getElementById('validation-summary').textContent,
        components: [...document.querySelectorAll('#component-list li')].map((li) => li.textContent),
        targets: [...document.querySelectorAll('#target-presets li')].map((li) => li.textContent),
        sourcePreset: document.getElementById('source-preset').value,
        canvasWidth: document.getElementById('preview').width,
        canvasCssWidth: getComputedStyle(document.getElementById('preview')).width,
      }))()`);

      assert.equal(snapshot.consoleErrors, '0');
      assert.ok(snapshot.renderedPixels > 10000, `预览非透明像素过少：${snapshot.renderedPixels}`);
      assert.match(snapshot.projectMeta, /已载入 project\.json：4 个组件/);
      assert.match(snapshot.summary, /全部目标预设通过联合校验/);
      assert.equal(snapshot.components.length, 4);
      assert.equal(snapshot.targets.length, 2);
      assert.match(snapshot.targets.join(' '), /抖音竖屏/);
      assert.match(snapshot.targets.join(' '), /B 站横屏/);
      assert.equal(snapshot.sourcePreset, 'douyin-portrait');
      // 画布内部坐标是预设像素；CSS 尺寸只是等比缩放后的显示尺寸。
      assert.equal(snapshot.canvasWidth, 1080);
      assert.notEqual(snapshot.canvasCssWidth, '1080px');

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const shotPath = path.join(tmpdir(), 'hud-editor-initial.png');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      t.diagnostic(`初始截图：${shotPath}`);
    });
  },
);

test(
  '切换编辑预设：画布变为横屏，组件跨格数保持不变',
  { skip: chrome === null ? '未找到 Chrome，跳过编辑器 UI 冒烟' : false },
  async (t) => {
    await withEditorPage(t, async ({ cdp, sessionId }) => {
      await evaluate(cdp, sessionId, `(() => {
        const select = document.getElementById('source-preset');
        select.value = 'bilibili-landscape';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);

      const snapshot = await waitFor(
        cdp,
        sessionId,
        `(() => ({
          canvasWidth: document.getElementById('preview').width,
          canvasHeight: document.getElementById('preview').height,
          readout: document.getElementById('readout').textContent,
          metrics: [...document.querySelectorAll('#component-list li')]
            .find((li) => li.textContent.includes('指标卡'))?.textContent ?? '',
          consoleErrors: document.body.dataset.consoleErrors,
        }))()`,
        (value) => value?.canvasWidth === 1920,
        '切换到横屏画布',
      );

      assert.equal(snapshot.canvasHeight, 1080);
      assert.match(snapshot.readout, /B 站横屏 1920 × 1080/);
      assert.match(snapshot.metrics, /bottom-left/);
      assert.match(snapshot.metrics, /col 2 \/ row 6/);
      assert.match(snapshot.metrics, /6 × 8 格/);
      assert.equal(snapshot.consoleErrors, '0');
    });
  },
);

test(
  '横屏越界的候选布局保存被拒绝，列出预设、组件与越界量',
  { skip: chrome === null ? '未找到 Chrome，跳过编辑器 UI 冒烟' : false },
  async (t) => {
    await withEditorPage(t, async ({ cdp, sessionId }) => {
      await evaluate(cdp, sessionId, `(() => {
        const input = document.getElementById('project-path');
        input.value = 'tests/fixtures/project.landscape-overflow.json';
        document.getElementById('load').click();
        return true;
      })()`);

      await waitFor(
        cdp,
        sessionId,
        'document.getElementById("project-meta").textContent',
        (value) => /landscape-overflow/.test(value),
        '载入横屏越界样例',
      );

      await evaluate(cdp, sessionId, 'document.getElementById("save").click()');

      const snapshot = await waitFor(
        cdp,
        sessionId,
        `(() => ({
          summary: document.getElementById('validation-summary').textContent,
          errors: [...document.querySelectorAll('#errors li')].map((li) => li.textContent),
          consoleErrors: document.body.dataset.consoleErrors,
        }))()`,
        (value) => /保存已拒绝/.test(value?.summary ?? ''),
        '保存被拒绝',
      );

      assert.match(snapshot.summary, /保存已拒绝：1 处越界/);
      assert.match(snapshot.errors.join('\n'), /预设 bilibili-landscape · 组件 metrics/);
      assert.match(snapshot.errors.join('\n'), /上边越界 520 px（13 格）/);
      assert.equal(snapshot.consoleErrors, '0');

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const shotPath = path.join(tmpdir(), 'hud-editor-save-rejected.png');
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      t.diagnostic(`保存拒绝截图：${shotPath}`);
    });
  },
);

test(
  '载入示例配置、切换组件显隐后保存，落盘 JSON 通过 Schema 校验',
  { skip: chrome === null ? '未找到 Chrome，跳过编辑器 UI 冒烟' : false },
  async (t) => {
    // 写进 gitignored 的 out/，避免动到仓库里的示例配置。
    const outDir = path.join(REPO_ROOT, 'out');
    mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, `editor-e2e-${process.pid}.json`);
    writeFileSync(target, readFileSync(path.join(REPO_ROOT, 'tests/fixtures/project.valid.json'), 'utf8'));
    t.after(() => rmSync(target, { force: true }));
    const relative = path.relative(REPO_ROOT, target);

    await withEditorPage(t, async ({ cdp, sessionId }) => {
      await evaluate(cdp, sessionId, `(() => {
        const input = document.getElementById('project-path');
        input.value = ${JSON.stringify(relative)};
        document.getElementById('load').click();
        return true;
      })()`);

      await waitFor(
        cdp,
        sessionId,
        'document.getElementById("project-meta").textContent',
        (value) => typeof value === 'string' && value.includes(relative),
        '载入临时示例配置',
      );

      // 用侧栏的显隐开关制造一次真实修改（不模拟鼠标手势）。
      await evaluate(cdp, sessionId, `(() => {
        const item = [...document.querySelectorAll('#component-list li')]
          .find((li) => li.textContent.includes('天气'));
        const checkbox = item.querySelector('input[data-action="visible"]');
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);

      await evaluate(cdp, sessionId, 'document.getElementById("save").click()');

      const snapshot = await waitFor(
        cdp,
        sessionId,
        `(() => ({
          summary: document.getElementById('validation-summary').textContent,
          consoleErrors: document.body.dataset.consoleErrors,
        }))()`,
        (value) => /已保存/.test(value?.summary ?? ''),
        '保存成功',
      );

      assert.match(snapshot.summary, /全部目标预设联合校验通过/);
      assert.equal(snapshot.consoleErrors, '0');
    });

    const saved = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(saved.layout.components.find((item) => item.id === 'weather').visible, false);
    assert.deepEqual(validateProject(saved, loadSchema()), []);
  },
);
