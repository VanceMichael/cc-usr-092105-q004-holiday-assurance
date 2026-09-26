import test from 'node:test';
import assert from 'node:assert/strict';
import { AssurancePlatform, ErrorCode } from '../src/index.js';

function newPlatform() {
  return new AssurancePlatform({ festivalWindow: true });
}

function seedLodging(p, { declared = 1, productId = 'HTL-1', compensation } = {}) {
  p.publishAssuranceVersion({
    productId,
    cancellationTiers: [
      { beforeHours: 72, refundRatio: 1 },
      { beforeHours: 24, refundRatio: 0.5 },
      { beforeHours: 0, refundRatio: 0 }
    ],
    compensation: compensation ?? {
      standards: {
        oversold: { type: 'ratio', value: 0.3, rule: '到店无房赔30%' },
        default: { type: 'ratio', value: 0.3 }
      }
    }
  });
  return p.declareCapacity({ productId, date: '2026-10-01', declared, callbackId: `d-${productId}` });
}

test('下单后商户改量击穿：受影响单挂起、闸口拦截、确认后按冻结版本退赔', async () => {
  const p = newPlatform();
  await seedLodging(p, { declared: 2 });
  const o1 = { orderId: 'O1', productId: 'HTL-1', merchantId: 'M1', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 500, contactPreference: { channel: 'phone' } };
  await p.placeOrder(o1);
  await p.placeOrder({ ...o1, orderId: 'O2', contactPreference: { channel: 'sms' } });

  const reduced = await p.declareCapacity({ productId: 'HTL-1', date: '2026-10-01', declared: 1, callbackId: 'd2', reason: '酒店超售改量' });
  const heldId = reduced.affected[0].orderId;
  assert.equal(heldId, 'O2'); // 最晚下单先受影响
  assert.equal(p.orders.get(heldId).status, 'risk_held');

  await assert.rejects(p.markFulfilled(heldId), (e) => e.code === ErrorCode.GUARD_BLOCKED);

  const task = p.outreach.openTaskFor(heldId);
  assert.equal(task.kind, 'manual_confirm'); // 短信偏好走人工确认
  const res = await p.completePreventiveTask(task.taskId, 'consumer_cancelled', '酒店确认无房');
  assert.equal(res.order.status, 'cancelled');
  assert.equal(res.refund.refundAmount, 500); // 商户责任全额退
  assert.equal(res.refund.versionId, 'HTL-1#v1'); // 按下单冻结版本
  assert.equal(res.compensation.amount, 150); // 30%
});

test('重复下单回调幂等：名额不重复占用，不重复创建订单副作用', async () => {
  const p = newPlatform();
  await seedLodging(p);
  const input = { orderId: 'O1', productId: 'HTL-1', merchantId: 'M1', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 500 };
  const a = await p.placeOrder(input);
  const b = await p.placeOrder(input);
  assert.equal(a.order.status, b.order.status);
  assert.equal(p.capacity.available('HTL-1', '2026-10-01').used, 1);
});

test('并发下单同一最后名额：只有一单成功', async () => {
  const p = newPlatform();
  await seedLodging(p, { declared: 1 });
  const results = await Promise.allSettled(
    ['A', 'B'].map((id) => p.placeOrder({
      orderId: id, productId: 'HTL-1', merchantId: 'M1', category: 'lodging',
      travelDate: '2026-10-01', units: 1, amount: 500, callbackId: `cb-${id}`
    }))
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected' && r.reason.code === ErrorCode.SOLD_OUT);
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
});

test('商户临时改规则不影响已下订单的冻结版本与赔付', async () => {
  const p = newPlatform();
  await seedLodging(p, { declared: 2 });
  const input = { orderId: 'O1', productId: 'HTL-1', merchantId: 'M1', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 500 };
  await p.placeOrder(input);

  await p.merchantRuleChange({
    productId: 'HTL-1', callbackId: 'r1', note: '改成不可退',
    version: { productId: 'HTL-1', effectiveFrom: '2026-09-30T00:00:00+08:00', cancellationTiers: [{ beforeHours: 0, refundRatio: 0 }] }
  });
  assert.equal(p.orders.get('O1').assuranceVersion.versionId, 'HTL-1#v1');
  assert.deepEqual(p.promises.revisions('O1').map((r) => r.type), ['merchant_rule_changed']);
  assert.equal(p.promises.original('O1').versionId, 'HTL-1#v1');
});

test('巡检不合格挂起涉事商户订单，复查通过恢复，且不向无关商户披露', async () => {
  const p = newPlatform();
  await seedLodging(p, { declared: 5, productId: 'H-A' });
  await p.publishAssuranceVersion({
    productId: 'H-B',
    cancellationTiers: [{ beforeHours: 24, refundRatio: 1 }, { beforeHours: 0, refundRatio: 0 }]
  });
  await p.declareCapacity({ productId: 'H-B', date: '2026-10-01', declared: 5, callbackId: 'd-H-B' });

  await p.placeOrder({ orderId: 'A1', productId: 'H-A', merchantId: 'M-A', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 400 });
  await p.placeOrder({ orderId: 'B1', productId: 'H-B', merchantId: 'M-B', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 400 });

  await p.recordInspection({ inspectionId: 'I1', merchantId: 'M-A', category: 'lodging', conclusion: 'fail', hazards: ['消防隐患'] });
  assert.equal(p.orders.get('A1').status, 'risk_held');
  assert.equal(p.orders.get('B1').status, 'confirmed'); // 无关商户不受影响

  // 投诉视图里 B1 看不到 M-A 的巡检结论
  const traceB = p.complaint('C-B', 'B1');
  assert.equal(traceB.inspections.length, 0);

  await p.recordInspection({ inspectionId: 'I2', merchantId: 'M-A', category: 'lodging', conclusion: 'pass', resolves: ['I1'] });
  assert.equal(p.orders.get('A1').status, 'confirmed');
  await p.markFulfilled('A1');
  assert.equal(p.orders.get('A1').status, 'fulfilled');
});

test('消费者主动取消按冻结版本档位退款，不产生商户赔付', async () => {
  const p = newPlatform();
  await seedLodging(p);
  await p.placeOrder({ orderId: 'O1', productId: 'HTL-1', merchantId: 'M1', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 500 });
  // 距 10-01 14:00 还有 49 小时 → 50% 档
  const res = await p.cancel('O1', { at: '2026-09-29T13:00:00+08:00', initiator: 'consumer', merchantFault: false, reason: '行程变更' });
  assert.equal(res.refund.refundRatio, 0.5);
  assert.equal(res.refund.refundAmount, 250);
  assert.equal(res.compensation, null);
});

test('投诉溯源视图串起申报、预防动作与最终结果', async () => {
  const p = newPlatform();
  await seedLodging(p, { declared: 1 });
  await p.placeOrder({ orderId: 'O1', productId: 'HTL-1', merchantId: 'M1', category: 'lodging', travelDate: '2026-10-01', units: 1, amount: 500, contactPreference: { channel: 'phone' } });
  await p.declareCapacity({ productId: 'HTL-1', date: '2026-10-01', declared: 0, callbackId: 'd2', reason: '关店' });
  const task = p.outreach.openTaskFor('O1');
  await p.completePreventiveTask(task.taskId, 'consumer_cancelled', '无房');

  const trace = p.complaint('CMP-1', 'O1');
  assert.equal(trace.declaredCapacity.initialDeclared, 1);
  assert.equal(trace.declaredCapacity.currentDeclared, 0);
  assert.ok(trace.declaredCapacity.history.length >= 2);
  assert.ok(trace.preventiveActions.length >= 1);
  assert.equal(trace.outcome.status, 'cancelled');
  assert.equal(trace.outcome.refund.refundAmount, 500);
  assert.equal(trace.outcome.compensations.length, 1);
  assert.ok(trace.events.find((e) => e.type === 'CAPACITY_PROMISE_AT_RISK'));
  assert.ok(trace.events.find((e) => e.type === 'COMPENSATION_PAID'));
});
