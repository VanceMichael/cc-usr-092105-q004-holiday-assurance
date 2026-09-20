// 读取并验证项目共享的领域资料。
export function parseDomain(raw) {
  const value = JSON.parse(raw);
  const complete = value.domain && value.version > 0 && Array.isArray(value.facts) && value.facts.length > 0 && Array.isArray(value.entities) && value.entities.length > 0 && Array.isArray(value.rules) && value.rules.length > 0 && value.sample;
  if (!complete) throw new Error('领域资料缺少必要字段');
  return value;
}
