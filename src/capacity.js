// 容量台账：酒店房量、小团名额、餐厅可订位都在这里占核。
// 不变量：
//  1) 同一名额不会被并发或重复占用 —— 占用按幂等键串行落账，超额直接 SOLD_OUT；
//  2) 商户改量只追加申报记录，绝不覆盖既有承诺；下调到承诺线以下时，受影响订单被显式挑出；
//  3) 线路停发只拒绝新单，已承诺订单进入预防名单，不能被悄悄取消。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

const poolKey = (productId, date) => `${productId}|${date}`;

export class CapacityLedger {
  #pools = new Map();
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  declare(input) {
    const key = poolKey(input.productId, input.date);
    const before = this.#pools.get(key);
    const declared = Number(input.declared);
    if (!Number.isInteger(declared) || declared < 0) {
      throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '可售能力 declared 必须是非负整数');
    }
    if (!before) {
      this.#pools.set(key, {
        productId: input.productId,
        date: input.date,
        declared,
        stopped: false,
        declarations: [{ declared, at: input.at ?? new Date().toISOString(), reason: input.reason ?? '首次申报', source: input.source ?? '商户申报' }],
        holds: new Map() // holdId(幂等键) -> { orderId, units, status, at }
      });
    } else {
      // 改量：追加申报，保留首报能力用于溯源。
      before.declarations.push({ declared, at: input.at ?? new Date().toISOString(), reason: input.reason ?? '商户改量', source: input.source ?? '商户申报' });
      before.declared = declared;
    }
    const pool = this.#pools.get(key);
    this.#bus?.record('CAPACITY_DECLARED', {
      productId: input.productId, date: input.date, declared,
      initialDeclared: pool.declarations[0].declared, changed: before !== undefined
    });

    // 下调击穿承诺线：找出超额受影响订单（最晚占用的先受影响，确定性规则），一个都不替商户抹掉。
    const obligated = this.#obligatedOrders(pool);
    const breach = declared < obligated.units || pool.stopped;
    let affected = [];
    if (declared < obligated.units) {
      let shortage = obligated.units - declared;
      for (const o of obligated.ordersDesc) {
        if (shortage <= 0) break;
        affected.push({ orderId: o.orderId, units: Math.min(o.units, shortage), atRiskUnits: Math.min(o.units, shortage) });
        shortage -= o.units;
      }
      this.#bus?.record('CAPACITY_PROMISE_AT_RISK', {
        productId: input.productId, date: input.date, declared,
        promised: obligated.units, shortage: obligated.units - declared,
        affectedOrderIds: affected.map((a) => a.orderId), reason: input.reason ?? '商户改量'
      });
    }
    return frozenCopy({ productId: input.productId, date: input.date, declared, breached: breach, affected });
  }

  // 线路停发：停止新售，已占用名额原样保留并全部进入受影响名单。
  stopSelling(input) {
    const key = poolKey(input.productId, input.date);
    const pool = this.#pools.get(key);
    if (!pool) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, `停发前必须先申报能力：${input.productId} ${input.date}`);
    pool.stopped = true;
    pool.declarations.push({ declared: pool.declared, at: input.at ?? new Date().toISOString(), reason: input.reason ?? '线路停发', source: input.source ?? '商户申报', stopped: true });
    const obligated = this.#obligatedOrders(pool);
    const affected = obligated.ordersAsc.map((o) => ({ orderId: o.orderId, units: o.units, atRiskUnits: o.units }));
    this.#bus?.record('SALES_STOPPED', {
      productId: input.productId, date: input.date,
      affectedOrderIds: affected.map((a) => a.orderId), reason: input.reason ?? '线路停发'
    });
    return frozenCopy({ stopped: true, affected });
  }

  // 占用名额。幂等键由调用方提供（如下单号），重复占用返回同一结果而不是再扣一次。
  hold(input) {
    const key = poolKey(input.productId, input.date);
    const pool = this.#pools.get(key);
    if (!pool) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, `产品 ${input.productId} 在 ${input.date} 尚未申报可售能力`);
    if (pool.stopped) throw new AssuranceError(ErrorCode.SOLD_OUT, `产品 ${input.productId} 在 ${input.date} 已停发`);
    const units = Number(input.units ?? 1);
    if (!Number.isInteger(units) || units <= 0) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '占用名额 units 必须是正整数');

    const existing = pool.holds.get(input.idempotencyKey);
    if (existing) {
      // 同键必须同一订单同一数量；不同调用复用键属于冲突。
      if (existing.orderId !== input.orderId || existing.units !== units) {
        throw new AssuranceError(ErrorCode.CONFLICT, `容量幂等键 ${input.idempotencyKey} 被不同占用请求复用`);
      }
      return frozenCopy({ idempotencyKey: input.idempotencyKey, status: existing.status, units, replayed: true });
    }

    const used = [...pool.holds.values()].filter((h) => h.status !== 'released').reduce((s, h) => s + h.units, 0);
    if (used + units > pool.declared) {
      this.#bus?.record('CAPACITY_REJECTED', { productId: input.productId, date: input.date, orderId: input.orderId, units, used, declared: pool.declared });
      throw new AssuranceError(ErrorCode.SOLD_OUT, `产品 ${input.productId} 在 ${input.date} 名额不足：已占 ${used}/${pool.declared}，申请 ${units}`);
    }
    pool.holds.set(input.idempotencyKey, { orderId: input.orderId, units, status: 'held', at: new Date().toISOString() });
    this.#bus?.record('CAPACITY_HELD', { productId: input.productId, date: input.date, orderId: input.orderId, units, idempotencyKey: input.idempotencyKey });
    return frozenCopy({ idempotencyKey: input.idempotencyKey, status: 'held', units, replayed: false });
  }

  confirm(idempotencyKey) {
    return this.#transition(idempotencyKey, 'held', 'confirmed', 'CAPACITY_CONFIRMED');
  }

  release(idempotencyKey, reason = '释放名额') {
    return this.#transition(idempotencyKey, (s) => s !== 'released', 'released', 'CAPACITY_RELEASED', reason);
  }

  #transition(idempotencyKey, from, to, eventType, reason) {
    for (const pool of this.#pools.values()) {
      const h = pool.holds.get(idempotencyKey);
      if (!h) continue;
      const ok = typeof from === 'function' ? from(h.status) : h.status === from;
      if (!ok) return frozenCopy({ idempotencyKey, status: h.status, replayed: true });
      h.status = to;
      this.#bus?.record(eventType, { productId: pool.productId, date: pool.date, orderId: h.orderId, units: h.units, idempotencyKey, reason });
      return frozenCopy({ idempotencyKey, status: to, replayed: false });
    }
    throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, `容量占用 ${idempotencyKey} 不存在`);
  }

  // 商户在履约点承认失败（到店无房 / 到店无位 / 到点发不了团）：记录违约，不改动名额与原承诺。
  reportFulfillmentFailure(input) {
    this.#bus?.record('FULFILLMENT_FAILED', {
      productId: input.productId, date: input.date, orderId: input.orderId,
      category: input.category, reason: input.reason, source: input.source ?? '商户申报'
    });
  }

  available(productId, date) {
    const pool = this.#pools.get(poolKey(productId, date));
    if (!pool) return null;
    const used = [...pool.holds.values()].filter((h) => h.status !== 'released').reduce((s, h) => s + h.units, 0);
    return frozenCopy({ productId, date, declared: pool.declared, used, available: pool.declared - used, stopped: pool.stopped });
  }

  // 溯源：商户当时申报的能力与全部改量历史。
  declarationsOf(productId, date) {
    const pool = this.#pools.get(poolKey(productId, date));
    return pool ? frozenCopy(pool.declarations) : [];
  }

  #obligatedOrders(pool) {
    const orders = [...pool.holds.entries()]
      .filter(([, h]) => h.status !== 'released')
      .map(([id, h]) => ({ holdId: id, orderId: h.orderId, units: h.units, at: h.at }));
    return {
      units: orders.reduce((s, o) => s + o.units, 0),
      ordersAsc: orders.sort((a, b) => a.at.localeCompare(b.at)),
      get ordersDesc() { return [...this.ordersAsc].reverse(); }
    };
  }
}
