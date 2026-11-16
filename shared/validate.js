/**
 * 极简 JSON Schema 校验器（纯函数：零 DOM、零 Node 专有 API）。
 *
 * 只实现 docs/schema/project.schema.json 用到的子集：type / const / enum / required /
 * properties / additionalProperties / items / minItems / uniqueItems / minLength /
 * minimum / exclusiveMinimum / $ref（仅同文档 `#/$defs/...`）。
 * 不引入 ajv 等运行时依赖；Schema 文件本身是契约，只能用真实文件驱动。
 */

/**
 * 校验实例。
 * @param {unknown} instance 待校验的 JSON 值
 * @param {object} schema 根 Schema（含 $defs）
 * @returns {string[]} 中文错误文本，每条都点名具体字段
 */
export function validateSchema(instance, schema) {
  const errors = [];
  visit(instance, schema, '', schema, errors);
  return errors;
}

function visit(value, schema, path, root, errors) {
  if (schema.$ref !== undefined) {
    visit(value, resolveRef(schema.$ref, root), path, root, errors);
    return;
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(
      `${pathLabel(path)} 必须是${TYPE_LABELS[schema.type] ?? schema.type}，实际为 ${formatValue(value)}`,
    );
    return;
  }

  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    errors.push(`${pathLabel(path)} 必须为 ${formatValue(schema.const)}，实际为 ${formatValue(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(
      `${pathLabel(path)} 必须是 ${schema.enum.join(' / ')} 之一，实际为 ${formatValue(value)}`,
    );
  }

  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${pathLabel(path)} 不能为空字符串，实际为 ${formatValue(value)}`);
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${pathLabel(path)} 不能小于 ${schema.minimum}，实际为 ${formatValue(value)}`);
  }

  if (
    typeof value === 'number'
    && schema.exclusiveMinimum !== undefined
    && value <= schema.exclusiveMinimum
  ) {
    errors.push(`${pathLabel(path)} 必须大于 ${schema.exclusiveMinimum}，实际为 ${formatValue(value)}`);
  }

  if (isPlainObject(value) && isPlainObject(schema.properties)) {
    for (const [key, propertySchema] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue;
      visit(value[key], propertySchema, joinPath(path, key), root, errors);
    }
  }

  if (isPlainObject(value) && Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (Object.hasOwn(value, key)) continue;
      errors.push(`${joinPath(path, key)} 是必填字段，当前缺失`);
    }
  }

  if (isPlainObject(value) && schema.additionalProperties === false) {
    const knownKeys = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
    for (const key of Object.keys(value)) {
      if (knownKeys.includes(key)) continue;
      errors.push(`${joinPath(path, key)} 是未知字段`);
    }
  }

  if (Array.isArray(value) && schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push(`${pathLabel(path)} 至少需要 ${schema.minItems} 项，实际为 ${value.length} 项`);
  }

  if (Array.isArray(value) && schema.uniqueItems === true) {
    const seen = new Set();
    for (const item of value) {
      const key = JSON.stringify(item);
      if (seen.has(key)) {
        errors.push(`${pathLabel(path)} 不能包含重复项，重复值：${key}`);
        break;
      }
      seen.add(key);
    }
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      const itemPath = path === '' ? `[${index}]` : `${path}[${index}]`;
      visit(item, schema.items, itemPath, root, errors);
    });
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function joinPath(path, key) {
  return path === '' ? key : `${path}.${key}`;
}

/** 顶层字段用裸字段名，根节点用「配置根」。 */
function pathLabel(path) {
  return path === '' ? '配置根' : path;
}

const TYPE_LABELS = {
  object: '对象',
  array: '数组',
  string: '字符串',
  integer: '整数',
  number: '数字',
  boolean: '布尔值',
  null: 'null',
};

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new Error(`不支持的 type "${type}"`);
  }
}

function formatValue(value) {
  if (value === undefined) return '缺失';
  return JSON.stringify(value);
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) {
    throw new Error(`不支持的 $ref "${ref}"：只支持同文档内的 #/ 引用`);
  }
  return ref
    .slice(2)
    .split('/')
    .reduce((node, key) => node[key], root);
}
