// 节日保障中台 —— 不可变数据与通用错误。

// 递归深冻结：进入中台台账的任何声明都不允许被调用方就地改写。
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

// 复制一份再冻结：既保证外部拿到的快照不可变，也保证调用方之后修改原对象影响不到台账。
export function frozenCopy(value) {
  return deepFreeze(structuredClone(value));
}

export class AssuranceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AssuranceError';
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  CONFLICT: 'CONFLICT', // 幂等键复用但载荷不同
  SOLD_OUT: 'SOLD_OUT', // 同一名额不能被并发/重复占用
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ALREADY_COMPENSATED: 'ALREADY_COMPENSATED', // 补偿只发一次
  GUARD_BLOCKED: 'GUARD_BLOCKED', // 高风险订单未完成预防确认
  ILLEGAL_OVERRIDE: 'ILLEGAL_OVERRIDE' // 改量/停发/部分核销不得悄悄覆盖原承诺
});
