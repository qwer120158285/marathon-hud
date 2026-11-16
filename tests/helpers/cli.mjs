/**
 * CLI 进程边界的测试辅助：真正 spawn 一个 node 子进程，只断言退出码与输出文本。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const CLI_PATH = path.join(REPO_ROOT, 'cli/render.mjs');
export const VALID_PROJECT_PATH = path.join(REPO_ROOT, 'tests/fixtures/project.valid.json');

/** 运行 CLI，返回 `{ code, stdout, stderr }`。 */
export function runCli(args) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 读取合法 fixture 的深拷贝，便于逐字段构造非法配置。 */
export function readValidProject() {
  return JSON.parse(readFileSync(VALID_PROJECT_PATH, 'utf8'));
}

/** 把配置写到临时目录，返回绝对路径；调用方用后自行删除。 */
export function writeTempProject(project) {
  const dir = mkdtempSync(path.join(tmpdir(), 'marathon-hud-t2-'));
  const file = path.join(dir, 'project.json');
  writeFileSync(file, JSON.stringify(project, null, 2));
  return file;
}

/** 以合法 fixture 为起点，改坏一处后写入临时文件。 */
export function brokenProject(mutate) {
  const project = readValidProject();
  mutate(project);
  return writeTempProject(project);
}
