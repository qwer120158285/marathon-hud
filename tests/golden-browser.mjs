/**
 * 浏览器侧出图：本地 HTTP 服务 + Chrome（headless，经 DevTools 协议截图）→ 与同一张基准图比对。
 *
 * 为什么需要 HTTP：editor/golden.html 用 ES module 引 shared/*，file:// 下会被浏览器拦。
 * 为什么不用 `chrome --screenshot`：本机 Chrome 150 的 `--screenshot` 在页面「load」时立刻截图，
 * 而本页要等字体注册完（异步）才开始绘制，截到的是空画布；`--headless=new` 在本机静默不写文件。
 * 所以改走 DevTools 协议：等页面打出就绪信号后再 `Page.captureScreenshot`。
 *
 * 依赖本机 Chrome 与端口，不进 `node --test` 的必跑集合：存在 Chrome 才跑，否则 skip。
 */
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILTIN_PRESET_IDS, resolvePreset } from '../shared/presets.js';
import { compareGolden, formatReport } from './golden-compare.mjs';

/** 仓库根（去掉目录 URL 末尾的斜杠，供路径前缀判断使用）。 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 页面绘制完成后写进标题的就绪信号。 */
export const READY_TITLE_PREFIX = 'hud-golden-ready';

/** 常见安装位置；可用 CHROME_PATH 覆盖。 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
};

/** 返回第一个可用的 Chrome 可执行文件；没有则返回 null。 */
export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/** 以仓库根为文档根启动静态服务，返回端口与关闭函数。 */
async function startStaticServer() {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    const filePath = path.join(REPO_ROOT, pathname);
    const insideRoot = filePath === REPO_ROOT || filePath.startsWith(REPO_ROOT + path.sep);

    if (!insideRoot || !existsSync(filePath) || !statSync(filePath).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`404 ${pathname}`);
      return;
    }

    response.writeHead(200, {
      'content-type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 极简 DevTools 协议客户端：按 id 配对响应。 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method} 失败：${message.error.message}`));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }
}

/** 启动 headless Chrome 并连上浏览器级 WebSocket。 */
async function launchChrome({ chrome, profileDir }) {
  const child = spawn(chrome, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`Chrome 未在 20 s 内就绪：\n${buffer.slice(-800)}`)), 20000);

    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match === null) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 提前退出（退出码 ${code}）：\n${buffer.slice(-800)}`));
    });
  });

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`无法连接 DevTools：${wsUrl}`)), { once: true });
  });

  return { child, cdp: new Cdp(socket), socket };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 截一张透明 PNG：等到页面打出就绪信号再截图。
 *
 * @returns {Promise<void>}
 */
async function screenshot({ chrome, port, presetId, outPath, profileDir }) {
  const preset = resolvePreset(presetId);
  const url = `http://127.0.0.1:${port}/editor/golden.html?preset=${encodeURIComponent(presetId)}`;
  await capturePng({ chrome, url, ...preset, outPath, profileDir });
}

/**
 * 用 DevTools 协议截页面：等到标题出现就绪信号后再截图。
 *
 * @param {{ chrome: string, url: string, width: number, height: number,
 *           outPath: string, profileDir: string }} options
 */
async function capturePng({ chrome, url, width, height, outPath, profileDir }) {
  const { child, cdp, socket } = await launchChrome({ chrome, profileDir });

  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);
    // 透明背景：与 Node 侧画布一致，Alpha 通道参与比对。
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    }, sessionId);

    await cdp.send('Page.navigate', { url }, sessionId);

    const deadline = Date.now() + 30000;
    let title = '';
    while (Date.now() < deadline) {
      const { result } = await cdp.send('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      }, sessionId);
      title = typeof result?.value === 'string' ? result.value : '';
      if (title.startsWith(READY_TITLE_PREFIX)) break;
      await delay(100);
    }

    if (!title.startsWith(READY_TITLE_PREFIX)) {
      throw new Error(`页面未在 30 s 内就绪（标题 ${JSON.stringify(title)}）`);
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
    const data = Buffer.from(shot.data, 'base64');
    if (data.length === 0) throw new Error('DevTools 返回了空截图');
    writeFileSync(outPath, data);
  } finally {
    try {
      await cdp.send('Browser.close');
    } catch {
      // 浏览器已退出时忽略。
    }
    socket.close();
    child.kill('SIGKILL');
  }
}

/**
 * 跑浏览器侧全流程：起服务 → 每个预设截一张 → 与基准图比对。
 * @param {{ presetIds?: string[], outDir?: string, chrome?: string }} options
 */
export async function runBrowserGolden({ presetIds = BUILTIN_PRESET_IDS, outDir, chrome = findChrome() } = {}) {
  if (chrome === null) throw new Error('未找到 Chrome，无法进行浏览器侧出图');

  const workDir = outDir ?? mkdtempSync(path.join(tmpdir(), 'hud-browser-'));
  mkdirSync(workDir, { recursive: true });
  const profileDir = mkdtempSync(path.join(tmpdir(), 'hud-chrome-'));
  const { port, close } = await startStaticServer();

  try {
    const reports = [];
    for (const presetId of presetIds) {
      const candidatePath = path.join(workDir, `${presetId}.browser.png`);
      await screenshot({ chrome, port, presetId, outPath: candidatePath, profileDir });
      reports.push(compareGolden({ presetId, candidatePath }));
    }
    return reports;
  } finally {
    await close();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const presetArg = valueOf('--preset');
  const presetIds = presetArg === undefined ? BUILTIN_PRESET_IDS : [presetArg];

  try {
    const reports = await runBrowserGolden({ presetIds, outDir: valueOf('--out-dir') });
    for (const report of reports) console.log(formatReport(report));
    process.exit(reports.every((report) => report.pass) ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(3);
  }
}
