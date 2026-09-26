// 投诉溯源视图：客服从一次投诉直接看到
//   1) 商户当时申报的能力（首报 + 全部改量历史）
//   2) 平台采取的预防动作（外呼/人工确认及结果）
//   3) 最终退款或履约结果
// 巡检结论只含涉事商户的，绝不向无关商户扩大披露。

import { frozenCopy } from './freeze.js';

export function buildComplaintTrace({ complaintId, orderId }, stores) {
  const order = stores.orders.get(orderId);
  const promise = stores.promises.timeline(orderId);
  const declared = stores.capacity.declarationsOf(order.productId, order.travelDate);
  const initialDeclared = declared[0]?.declared ?? null;

  return frozenCopy({
    complaintId,
    orderId,
    generatedAt: new Date().toISOString(),

    // 下单时冻结的承诺与保障版本
    orderSnapshot: order,
    originalPromise: promise.original,
    promiseRevisions: promise.revisions,

    // 商户当时申报的能力
    declaredCapacity: {
      initialDeclared,
      currentDeclared: declared[declared.length - 1]?.declared ?? null,
      history: declared
    },

    // 平台采取的预防动作
    preventiveActions: stores.outreach.tasksFor(orderId),

    // 履约与核销
    verification: order.category === 'dining' || order.voucherId ? safe(() => stores.verification.status(orderId)) : null,

    // 巡检结论（仅涉事商户）
    inspections: stores.inspections.forMerchant(order.merchantId),

    // 最终结果
    outcome: {
      status: order.status,
      refund: stores.refunds.of(orderId),
      compensations: stores.compensations.list(orderId)
    },

    // 全量事件流（申报、预防、核销、退款、赔付）
    events: stores.bus.forOrder(orderId)
  });
}

function safe(fn) {
  try { return fn(); } catch { return null; }
}
