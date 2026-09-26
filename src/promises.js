// 承诺台账：平台对每个订单“当时承诺了什么”的只追加记录。
// 商户改量、线路停发、部分核销都只能新增一条“现状/影响”记录，
// 原承诺行永远保留并可被客服与赔付计算引用。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

export class PromiseLedger {
  #byOrder = new Map(); // orderId -> { original, revisions: [] }
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  // 下单时写入原始承诺（保障版本快照 + 权益明细）。
  commit(orderId, promise) {
    if (this.#byOrder.has(orderId)) throw new AssuranceError(ErrorCode.CONFLICT, `订单 ${orderId} 的原始承诺已存在，不能重复提交`);
    const record = { ...frozenCopy(promise), committedAt: new Date().toISOString() };
    this.#byOrder.set(orderId, { original: record, revisions: [] });
    this.#bus?.record('PROMISE_COMMITTED', { orderId, productId: promise.productId, versionId: promise.versionId });
    return frozenCopy(record);
  }

  // 追加一次变更影响（改量/停发/改规则触发）。type 说明变化，原承诺不动。
  appendRevision(orderId, revision) {
    const entry = this.#byOrder.get(orderId);
    if (!entry) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 尚无承诺记录`);
    const record = frozenCopy({ ...revision, seq: entry.revisions.length + 1, at: revision.at ?? new Date().toISOString() });
    entry.revisions.push(record);
    this.#bus?.record('PROMISE_REVISION_APPENDED', { orderId, revisionType: record.type, seq: record.seq });
    return record;
  }

  original(orderId) {
    const entry = this.#byOrder.get(orderId);
    if (!entry) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 尚无承诺记录`);
    return frozenCopy(entry.original);
  }

  revisions(orderId) {
    const entry = this.#byOrder.get(orderId);
    return entry ? frozenCopy(entry.revisions) : [];
  }

  // 客服视图：下单时的原承诺 + 之后所有变化，按时间排列。
  timeline(orderId) {
    const entry = this.#byOrder.get(orderId);
    if (!entry) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 尚无承诺记录`);
    return frozenCopy({ original: entry.original, revisions: entry.revisions });
  }
}
