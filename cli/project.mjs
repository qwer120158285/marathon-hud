/**
 * project.json 的读取（Node 侧）。
 * 校验规则见 shared/validate.js 与 docs/schema/project.schema.json。
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSchema } from '../shared/validate.js';
import { BUILTIN_PRESET_IDS, isBuiltinPreset } from '../shared/presets.js';

/** Schema 是契约文件，直接读仓库里的那一份，不在代码里复制副本。 */
const SCHEMA_PATH = fileURLToPath(new URL('../docs/schema/project.schema.json', import.meta.url));

/** 配置读取失败统一抛这个错误，由 CLI 入口转成退出码 2。 */
export class ProjectConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProjectConfigError';
  }
}

/** 读取 docs/schema/project.schema.json。 */
export function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

/**
 * 校验 project.json，返回全部错误文本。
 * 顺序：先 Schema 契约，再 Schema 无法表达的语义规则。
 * @param {unknown} project
 * @param {object} schema loadSchema() 的结果
 * @returns {string[]}
 */
export function validateProject(project, schema) {
  return [...validateSchema(project, schema), ...validateSemantics(project)];
}

/** Schema 无法表达的项目语义约束。 */
function validateSemantics(project) {
  const errors = [];
  if (!isPlainObject(project)) return errors;

  if (Array.isArray(project.targetPresets)) {
    project.targetPresets.forEach((id, index) => {
      checkPresetId(id, `targetPresets[${index}]`, errors);
    });
  }

  checkPresetId(project.layout?.sourcePresetId, 'layout.sourcePresetId', errors);

  const components = project.layout?.components;
  if (Array.isArray(components)) {
    const firstIndexById = new Map();
    components.forEach((component, index) => {
      if (!isPlainObject(component) || typeof component.id !== 'string') return;
      const firstIndex = firstIndexById.get(component.id);
      if (firstIndex === undefined) {
        firstIndexById.set(component.id, index);
        return;
      }
      errors.push(
        `layout.components[${index}].id 与 layout.components[${firstIndex}].id 重复（${JSON.stringify(component.id)}）`,
      );
    });
  }

  return errors;
}

/** 预设标识必须是已知画布预设（Schema 只约束它是非空字符串）。 */
function checkPresetId(id, path, errors) {
  if (typeof id !== 'string' || isBuiltinPreset(id)) return;
  errors.push(
    `${path} 未知画布预设 ${JSON.stringify(id)}，可用预设：${BUILTIN_PRESET_IDS.join('、')}`,
  );
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 读取 project.json。
 * @param {string} filePath 命令行传入的路径，相对当前工作目录
 * @returns {{ project: unknown, path: string, dir: string }}
 */
export function loadProject(filePath) {
  const absolutePath = path.resolve(filePath);

  let text;
  try {
    text = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    const reason = error.code === 'ENOENT' ? '文件不存在' : error.message;
    throw new ProjectConfigError(`无法读取 project.json：${absolutePath}（${reason}）`);
  }

  let project;
  try {
    project = JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(`project.json 不是合法 JSON：${absolutePath}；${error.message}`);
  }

  return { project, path: absolutePath, dir: path.dirname(absolutePath) };
}

/**
 * 写回 project.json（编辑期用，例如写天气快照）。
 *
 * 顺序即安全边界：先校验整份配置 → 写同目录临时文件 → `rename` 原子替换。
 * 校验失败或写盘失败都不会把原文件改成半份坏配置。
 *
 * @param {string} filePath project.json 路径
 * @param {object} project 完整的工程配置（不是片段）
 * @returns {object} 写入的配置
 */
export function saveProject(filePath, project) {
  const errors = validateProject(project, loadSchema());
  if (errors.length > 0) {
    throw new ProjectConfigError(`配置不合法，已拒绝写入：${filePath}\n${errors.join('\n')}`);
  }

  const absolutePath = path.resolve(filePath);
  const tempPath = `${absolutePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(project, null, 2)}\n`);
  renameSync(tempPath, absolutePath);
  return project;
}
