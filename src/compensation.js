// 补偿台账：一笔订单针对同一补偿理由只发一次。
// 重复的发赔请求（重试、重复回调、人工误点）返回首笔结果，绝不二次打款；
// 不同理由（如改期差价 与 巡检赔付）可分别各发一次，但每类也只能一次。
// 赔付标准来自下单时冻结的保障版本，不读商户后来改过的新规则。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

export class CompensationLedger {
  #byOrder = new Map(); // orderId -> Map(reasonKey -> record)
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  // input: { orderId, reason, amount, currency, basis: {versionId, rule}, idempotencyKey }
  issue(input) {
    if (!input.orderId || !input.reason) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '补偿必须带 orderId 与 reason');
    if (!Number.isFinite(input.amount) || input.amount < 0) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '补偿金额非法');
    const key = input.reason;
    let map = this.#byOrder.get(input.orderId);
    if (!map) {
      map = new Map();
      this.#byOrder.set(input.orderId, map);
    }
    const prior = map.get(key);
    if (prior) {
      // 已赔过：补偿只发一次。金额/依据不一致要显式暴露，不静默改赔。
      if (prior.amount !== input.amount || prior.basis.versionId !== input.basis?.versionId) {
        throw new AssuranceError(ErrorCode.ALREADY_COMPENSATED, `订单 ${input.orderId} 已按 ${input.reason} 补偿 ${prior.amount}，不能按不同标准重发`, { prior: frozenCopy(prior) });
      }
      return frozenCopy({ ...prior, replayed: true });
    }
    const record = frozenCopy({
      compensationId: `CMP-${input.orderId}-${key}`,
      orderId: input.orderId,
      reason: input.reason,
      amount: input.amount,
      currency: input.currency ?? 'CNY',
      basis: input.basis ?? null, // { versionId, rule, refundRatio }
      status: 'paid',
      idempotencyKey: input.idempotencyKey ?? null,
      at: new Date().toISOString()
    });
    map.set(key, record);
    this.#bus?.record('COMPENSATION_PAID', {
      orderId: input.orderId, compensationId: record.compensationId,
      reason: input.reason, amount: input.amount, versionId: input.basis?.versionId
    });
    return frozenCopy({ ...record, replayed: false });
  }

  list(orderId) {
    const map = this.#byOrder.get(orderId);
    return map ? [...map.values()].map((r) => frozenCopy(r)) : [];
  }

  has(orderId, reason) {
    return this.#byOrder.get(orderId)?.has(reason) ?? false;
  }
}
