// 极小 JSON Schema 校验器，只实现中台契约用到的子集：
// type / required / properties / items / enum / const / minimum / minItems /
// minLength / oneOf / $ref(本文件 $defs) / additionalProperties / format(date,date-time)。
// 刻意不引第三方依赖，保证 npm test 在离线环境也能跑。

const FORMATS = {
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  'date-time': (v) => !Number.isNaN(Date.parse(v))
};

export function validate(schema, value, root = schema) {
  const errors = [];
  walk(schema, value, '$', root, errors);
  return { valid: errors.length === 0, errors };
}

function walk(schema, value, path, root, errors) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/$defs/', '');
    walk(root.$defs[name], value, path, root, errors);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} 应为常量 ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} 必须是 ${schema.enum.join(' / ')} 之一`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) {
      errors.push(`${path} 类型应为 ${types.join('|')}，实际 ${JSON.stringify(value)}`);
      return;
    }
    if (value === null) return; // 可空联合：null 跳过后续约束
  }
  if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) {
    errors.push(`${path} 不符合格式 ${schema.format}`);
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${path} 长度不能小于 ${schema.minLength}`);
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path} 不能小于 ${schema.minimum}`);
  }
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
    errors.push(`${path} 不能大于 ${schema.maximum}`);
  }
  if (schema.minItems && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(`${path} 至少包含 ${schema.minItems} 项`);
  }
  if (schema.properties && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path} 缺少必填字段 ${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) errors.push(`${path}.${key} 是不允许的额外字段`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) walk(sub, value[key], `${path}.${key}`, root, errors);
    }
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, root, errors));
  }
  if (schema.allOf) {
    for (const branch of schema.allOf) walk(branch, value, path, root, errors);
  }
  if (schema.oneOf) {
    const reports = schema.oneOf.map((branch) => validate(branch, value, root));
    const matched = reports.filter((r) => r.valid).length;
    if (matched !== 1) {
      errors.push(`${path} 必须恰好匹配 oneOf 中的一个定义（匹配 ${matched} 个）`);
      if (matched === 0) {
        // 附上错误最少的那个分支的细节，方便定位缺了哪个字段。
        const closest = reports.reduce((a, b) => (b.errors.length < a.errors.length ? b : a));
        for (const detail of closest.errors) errors.push(`  ↳ ${detail}`);
      }
    }
  }
}

function typeOk(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}
