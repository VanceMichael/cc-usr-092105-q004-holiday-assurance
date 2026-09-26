// 订单仓储：下单快照（含保障版本、出行日期、联系偏好）与订单状态机。
import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

// 允许的状态迁移；高风险订单必须经“预防确认”才能进入履约。
const TRANSITIONS = Object.freeze({
  placed: ['risk_held', 'confirmed'],
  risk_held: ['confirmed', 'partially_redeemed', 'cancelled'], // 外呼/人工确认期间（可恢复到部分核销态）
  confirmed: ['fulfilled', 'partially_redeemed', 'cancelled', 'risk_held'], // 履约前出现新风险可回挂
  partially_redeemed: ['fulfilled', 'cancelled', 'risk_held'],
  fulfilled: [],
  cancelled: []
});

export class OrderStore {
  #orders = new Map();

  place(order) {
    if (this.#orders.has(order.orderId)) throw new AssuranceError(ErrorCode.CONFLICT, `订单 ${order.orderId} 已存在`);
    const saved = frozenCopy({ ...order, status: 'placed', placedAt: new Date().toISOString() });
    this.#orders.set(order.orderId, saved);
    return saved;
  }

  get(orderId) {
    const o = this.#orders.get(orderId);
    if (!o) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 不存在`);
    return frozenCopy(o);
  }

  transition(orderId, to, extra = {}) {
    const current = this.#orders.get(orderId);
    if (!current) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 不存在`);
    const allowed = TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(to)) {
      throw new AssuranceError(ErrorCode.ILLEGAL_OVERRIDE, `订单 ${orderId} 不能从 ${current.status} 迁移到 ${to}`);
    }
    const next = frozenCopy({ ...current, ...extra, status: to, updatedAt: new Date().toISOString() });
    this.#orders.set(orderId, next);
    return next;
  }

  patch(orderId, patch) {
    const current = this.#orders.get(orderId);
    if (!current) throw new AssuranceError(ErrorCode.ORDER_NOT_FOUND, `订单 ${orderId} 不存在`);
    const next = frozenCopy({ ...current, ...patch, updatedAt: new Date().toISOString() });
    this.#orders.set(orderId, next);
    return next;
  }

  list(predicate = () => true) {
    return [...this.#orders.values()].filter(predicate).map((o) => frozenCopy(o));
  }
}
