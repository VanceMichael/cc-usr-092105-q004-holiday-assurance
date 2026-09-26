// 结算：退款金额按下单时冻结的保障版本计算，一笔订单只退一次。
// 取消档位示例：[{ beforeHours: 72, refundRatio: 1 }, { beforeHours: 24, refundRatio: 0.5 }, { beforeHours: 0, refundRatio: 0 }]

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

// 各品类默认履约时刻（+08:00），用于把出行日期换算成“距履约还有几小时”。
const FULFILL_HOUR = Object.freeze({ lodging: 14, dining: 12, tour: 8 });

export function hoursBeforeFulfillment(order, at) {
  const hour = FULFILL_HOUR[order.category] ?? 12;
  const start = Date.parse(`${order.travelDate}T${String(hour).padStart(2, '0')}:00:00+08:00`);
  return (start - Date.parse(at)) / 3_600_000;
}

// 按冻结版本里的取消档位匹配退款比例；低于最后一档按最后一档处理（可取消但不退款）。
export function refundRatioFor(versionSnapshot, hoursBefore) {
  const tiers = [...versionSnapshot.cancellationTiers].sort((a, b) => b.beforeHours - a.beforeHours);
  for (const tier of tiers) {
    if (hoursBefore >= tier.beforeHours) return tier.refundRatio;
  }
  return tiers[tiers.length - 1].refundRatio;
}

export function computeRefund(order, versionSnapshot, at) {
  const hoursBefore = hoursBeforeFulfillment(order, at);
  const ratio = refundRatioFor(versionSnapshot, hoursBefore);
  return {
    hoursBefore: Math.round(hoursBefore * 100) / 100,
    refundRatio: ratio,
    refundAmount: Math.round(order.amount * ratio * 100) / 100,
    versionId: versionSnapshot.versionId
  };
}

export class RefundLedger {
  #byOrder = new Map();
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  // 一笔订单只退一次；重复请求回放首笔结果。
  issue(orderId, refund) {
    const prior = this.#byOrder.get(orderId);
    if (prior) return frozenCopy({ ...prior, replayed: true });
    const record = frozenCopy({
      refundId: `RFD-${orderId}`,
      orderId,
      ...refund,
      status: 'refunded',
      at: new Date().toISOString()
    });
    this.#byOrder.set(orderId, record);
    this.#bus?.record('REFUND_ISSUED', { orderId, refundId: record.refundId, amount: record.refundAmount, versionId: record.versionId });
    return frozenCopy({ ...record, replayed: false });
  }

  of(orderId) {
    const r = this.#byOrder.get(orderId);
    return r ? frozenCopy(r) : null;
  }
}

export function assertRefundable(order) {
  if (order.status === 'fulfilled') throw new AssuranceError(ErrorCode.ILLEGAL_OVERRIDE, `订单 ${order.orderId} 已履约，不能退款`);
}
