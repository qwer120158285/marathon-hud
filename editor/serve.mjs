/**
 * 编辑器本地服务（Node 内置 http，零依赖）。
 *
 * 作用有两个：
 * 1. 用 HTTP 提供 editor/、shared/、data/ 与示意图，绕开浏览器 `file://` 对 ES module 的限制（ADR 0006）；
 * 2. 承担 project.json 的读写，并在落盘前用与 CLI 完全相同的 Schema 契约校验，
 *    保证「编辑器保存成功」等于「CLI 能读」。
 *
 * 所有路径都限定在 `root` 内：`..` 与绝对路径一律拒绝，防止目录穿越读取仓库外文件。
 */
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadSchema, validateProject } from '../cli/project.mjs';

/** 仓库根目录（文档根）。 */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 允许静态访问的目录前缀；其余路径一律 404，避免把 TCX / 视频等大文件暴露出去。 */
const STATIC_PREFIXES = ['/editor/', '/shared/', '/data/', '/tests/fixtures/'];

/** 默认页面。 */
const INDEX_PATH = '/editor/index.html';

/** 请求体上限：project.json 正常只有几 KB，给 4 MB 足够且能挡住误传的大文件。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** 统一的 JSON 响应。 */
function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** 错误响应形态：`{ ok: false, path, errors: string[] }`，编辑器直接展示 errors。 */
function sendErrors(response, status, requestedPath, errors) {
  sendJson(response, status, { ok: false, path: requestedPath, errors });
}

/** 判断绝对路径是否落在根目录内（根自身也算）。 */
function isInsideRoot(root, absolutePath) {
  return absolutePath === root || absolutePath.startsWith(root + path.sep);
}

/**
 * 把请求里的项目相对路径解析成绝对路径，并做越界与类型检查。
 *
 * @param {string} root 文档根
 * @param {string | null} requested 请求参数 `path`
 * @returns {{ ok: true, absolutePath: string, relativePath: string }
 *          | { ok: false, status: number, message: string }}
 */
export function resolveProjectPath(root, requested) {
  const value = requested === null || requested.trim() === '' ? 'project.json' : requested.trim();

  if (path.isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    return { ok: false, status: 400, message: `项目路径必须是相对于仓库根的路径，实际为 ${JSON.stringify(value)}` };
  }
  if (value.includes('\0')) {
    return { ok: false, status: 400, message: '项目路径不能包含空字符' };
  }

  const absolutePath = path.resolve(root, value);
  if (!isInsideRoot(root, absolutePath)) {
    return { ok: false, status: 400, message: `项目路径越界：${JSON.stringify(value)} 不在仓库目录内` };
  }
  if (path.extname(absolutePath) !== '.json') {
    return { ok: false, status: 400, message: `项目路径必须是 .json 文件，实际为 ${JSON.stringify(value)}` };
  }

  return { ok: true, absolutePath, relativePath: path.relative(root, absolutePath) };
}

/** 读取请求体文本；超限或读失败时抛带中文原因的错误。 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** 静态文件响应。 */
function serveStatic(root, pathname, response) {
  const target = pathname === '/' ? INDEX_PATH : pathname;

  if (!STATIC_PREFIXES.some((prefix) => target.startsWith(prefix))) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`404 ${pathname}`);
    return;
  }

  let absolutePath;
  try {
    absolutePath = path.join(root, decodeURIComponent(target));
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('400 路径编码非法');
    return;
  }

  if (!isInsideRoot(root, absolutePath) || !existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    response.writeHead(!isInsideRoot(root, absolutePath) ? 400 : 404, {
      'content-type': 'text/plain; charset=utf-8',
    });
    response.end(`${!isInsideRoot(root, absolutePath) ? 400 : 404} ${pathname}`);
    return;
  }

  response.writeHead(200, {
    'content-type': MIME_TYPES[path.extname(absolutePath)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(absolutePath).pipe(response);
}

/** `/api/project` 的 GET：读取并原样返回。 */
function handleGetProject(root, requested, response) {
  const resolved = resolveProjectPath(root, requested);
  if (!resolved.ok) {
    sendErrors(response, resolved.status, requested, [resolved.message]);
    return;
  }

  if (!existsSync(resolved.absolutePath) || !statSync(resolved.absolutePath).isFile()) {
    sendErrors(response, 404, resolved.relativePath, [`文件不存在：${resolved.relativePath}`]);
    return;
  }

  let project;
  try {
    project = JSON.parse(readFileSync(resolved.absolutePath, 'utf8'));
  } catch (error) {
    sendErrors(response, 422, resolved.relativePath, [`project.json 不是合法 JSON：${error.message}`]);
    return;
  }

  sendJson(response, 200, { ok: true, path: resolved.relativePath, project });
}

/** `/api/project` 的 PUT：先过 Schema 契约，再落盘。 */
async function handlePutProject(root, requested, request, response) {
  const resolved = resolveProjectPath(root, requested);
  if (!resolved.ok) {
    sendErrors(response, resolved.status, requested, [resolved.message]);
    return;
  }

  let text;
  try {
    text = await readBody(request);
  } catch (error) {
    sendErrors(response, 413, resolved.relativePath, [error.message]);
    return;
  }

  let project;
  try {
    project = JSON.parse(text);
  } catch (error) {
    sendErrors(response, 422, resolved.relativePath, [`project.json 不是合法 JSON：${error.message}`]);
    return;
  }

  const errors = validateProject(project, loadSchema());
  if (errors.length > 0) {
    sendErrors(response, 422, resolved.relativePath, errors);
    return;
  }

  try {
    writeFileSync(resolved.absolutePath, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  } catch (error) {
    sendErrors(response, 500, resolved.relativePath, [`写入失败：${error.message}`]);
    return;
  }

  sendJson(response, 200, { ok: true, path: resolved.relativePath, project });
}

/**
 * 创建 HTTP 服务（不监听端口）。
 * @param {{ root?: string }} [options]
 */
export function createEditorServer({ root = REPO_ROOT } = {}) {
  const absoluteRoot = path.resolve(root);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');

      if (url.pathname === '/api/project') {
        const requested = url.searchParams.get('path');
        if (request.method === 'GET') {
          handleGetProject(absoluteRoot, requested, response);
          return;
        }
        if (request.method === 'PUT') {
          await handlePutProject(absoluteRoot, requested, request, response);
          return;
        }
        sendErrors(response, 405, requested, [`不支持的请求方法 ${request.method}，只允许 GET / PUT`]);
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendErrors(response, 404, undefined, [`没有这个接口：${url.pathname}`]);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('405 只支持 GET');
        return;
      }

      serveStatic(absoluteRoot, url.pathname, response);
    } catch (error) {
      sendErrors(response, 500, undefined, [`服务内部错误：${error.message}`]);
    }
  });
}

/**
 * 启动服务。
 * @param {{ root?: string, port?: number, host?: string }} [options]
 * @returns {Promise<{ server: import('node:http').Server, port: number, host: string,
 *                     url: string, close: () => Promise<void> }>}
 */
export async function startEditorServer({ root = REPO_ROOT, port = 0, host = '127.0.0.1' } = {}) {
  const server = createEditorServer({ root });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  return {
    server,
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  if (args.includes('--help')) {
    console.log('用法：node editor/serve.mjs [--port 8000] [--host 127.0.0.1] [--root .]');
    process.exit(0);
  }

  const portArg = valueOf('--port');
  const port = portArg === undefined ? 8000 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`端口无效：${portArg}`);
    process.exit(2);
  }

  const root = path.resolve(valueOf('--root') ?? REPO_ROOT);
  try {
    const handle = await startEditorServer({ root, port, host: valueOf('--host') ?? '127.0.0.1' });
    console.log(`编辑器已启动：${handle.url}/（文档根 ${root}）`);
    console.log('按 Ctrl+C 停止。');
  } catch (error) {
    console.error(`启动失败：${error.message}`);
    process.exit(1);
  }
}
