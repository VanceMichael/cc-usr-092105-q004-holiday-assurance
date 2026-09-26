// 核销台账：团购券核销、出行集合核销都在这里登记。
// 不变量：
//  1) 核销回调带幂等键，重复回调只认一次，绝不重复计核；
//  2) 部分核销只追加一条核销明细，原订单权益（券面、份数、保障版本）保持不变，
//     未核销部分仍按原承诺与原赔付标准处理；
//  3) 超量核销（份数超过订单）直接拒绝，不能把订单“核成已完成”。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

export class VerificationLedger {
  #byOrder = new Map(); // orderId -> { total, records: [] }
  #keys = new Set();
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  // 下单后登记可核销总量（份数/人数/间夜）。
  registerOrder(orderId, total) {
    if (!Number.isInteger(total) || total <= 0) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '可核销总量必须是正整数');
    if (this.#byOrder.has(orderId)) throw new AssuranceError(ErrorCode.CONFLICT, `订单 ${orderId} 已登记核销总量`);
    this.#byOrder.set(orderId, { total, records: [] });
  }

  // 核销（可部分）。input: { orderId, idempotencyKey, units, voucherCode, storeId, at }
  redeem(input) {
    const entry = this.#byOrder.get(input.orderId);
    if (!entry) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${input.orderId} 未登记核销`);
    if (!input.idempotencyKey) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '核销回调缺少幂等键');
    if (this.#keys.has(input.idempotencyKey)) {
      const prior = entry.records.find((r) => r.idempotencyKey === input.idempotencyKey);
      return frozenCopy({ ...prior, replayed: true }); // 重复回调：回放上一次结果
    }
    const units = Number(input.units ?? entry.total);
    if (!Number.isInteger(units) || units <= 0) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '核销份数必须是正整数');

    const redeemed = entry.records.reduce((s, r) => s + r.units, 0);
    if (redeemed + units > entry.total) {
      throw new AssuranceError(
        ErrorCode.ILLEGAL_OVERRIDE,
        `订单 ${input.orderId} 超量核销：已核 ${redeemed}/${entry.total}，本次 ${units}；部分核销不能覆盖原权益`
      );
    }
    const record = frozenCopy({
      idempotencyKey: input.idempotencyKey,
      units,
      voucherCode: input.voucherCode ?? null,
      storeId: input.storeId ?? null,
      kind: redeemed + units === entry.total ? 'full' : 'partial',
      at: input.at ?? new Date().toISOString()
    });
    entry.records.push(record);
    this.#keys.add(input.idempotencyKey);
    this.#bus?.record('VOUCHER_REDEEMED', {
      orderId: input.orderId, units, kind: record.kind,
      voucherCode: record.voucherCode, storeId: record.storeId, idempotencyKey: input.idempotencyKey
    });
    return frozenCopy({ ...record, replayed: false });
  }

  status(orderId) {
    const entry = this.#byOrder.get(orderId);
    if (!entry) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 未登记核销`);
    const redeemed = entry.records.reduce((s, r) => s + r.units, 0);
    const hasPartial = entry.records.some((r) => r.kind === 'partial');
    return frozenCopy({
      orderId, total: entry.total, redeemed, remaining: entry.total - redeemed,
      state: redeemed === 0 ? 'none' : redeemed === entry.total ? 'full' : 'partial',
      hasPartial,
      records: entry.records
    });
  }
}
