import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAssuranceHub } from '../src/assurance.js';

const GV1 = {
  version_id: 'gv-1',
  effective_from: '2026-09-01T00:00:00+08:00',
  cancel_scope: { free_cancel_until: '2026-09-29T18:00:00+08:00' },
  compensation: { capacity_breach: { rate: 1.3 }, route_suspended: { rate: 1.0 } },
};

function setup() {
  const hub = createAssuranceHub();
  hub.registerGuaranteeVersion(GV1);
  hub.registerProduct({ product_id: 'hotel', merchant_id: 'm-hotel', type: '住宿', category: '酒店' });
  hub.registerProduct({ product_id: 'dining', merchant_id: 'm-food', type: '餐饮', category: '生冷海鲜' });
  return hub;
}

test('下单即冻结保障版本，后续版本不影响已下单的赔付标准', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 1, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  hub.registerGuaranteeVersion({ ...GV1, version_id: 'gv-2', effective_from: '2026-09-25T00:00:00+08:00', compensation: { capacity_breach: { rate: 1.1 } } });
  const { record } = hub.issueCompensation({ order_id: 'o1', reason: 'capacity_breach', issued_at: '2026-09-28T10:00:00+08:00' });
  assert.equal(record.amount, 1300);
  assert.equal(record.guarantee_version, 'gv-1');
});

test('容量扣减具备幂等键，重复回调只落账一次', () => {
  const hub = setup();
  const event = { event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 5, declared_at: '2026-09-15T10:00:00+08:00' };
  assert.equal(hub.declareCapacity(event).duplicate, false);
  assert.equal(hub.declareCapacity(event).duplicate, true);
  assert.deepEqual(hub.capacityOf('hotel', '2026-10-01'), { total: 5, confirmed: 0, version: 1 });
});

test('同一名额不会被并发占用，超出能力的下单被拒绝', async () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 3, declared_at: '2026-09-15T10:00:00+08:00' });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      Promise.resolve(
        hub.placeOrder({ order_id: `o${i}`, product_id: 'hotel', consumer_id: `c${i}`, use_date: '2026-10-01', slots: 1, amount: 100, ordered_at: '2026-09-20T12:00:00+08:00' }),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(results.filter((r) => !r.ok && r.reason === 'insufficient_capacity').length, 7);
  assert.equal(hub.capacityOf('hotel', '2026-10-01').confirmed, 3);
});

test('商户改量不覆盖已确认订单，而是记录风险并触发履约前外呼', () => {
  const hub = setup();
  hub.setContactPreference({ consumer_id: 'c1', channel: 'sms' });
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 1, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  const cut = { event_id: 'e2', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 0, declared_at: '2026-09-27T08:00:00+08:00' };
  const result = hub.declareCapacity(cut);
  assert.deepEqual(result.breaches, ['o1']);
  assert.equal(hub.declareCapacity(cut).duplicate, true);
  assert.equal(hub.orderOf('o1').status, 'confirmed');
  const tasks = hub.outreachTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].reason, 'capacity_breach');
  assert.equal(tasks[0].channel, 'sms');
});

test('线路停发只标记风险，不取消已确认订单', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 1, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  const { affected } = hub.suspendRoute({ event_id: 'e2', product_id: 'hotel', use_date: '2026-10-01', decided_at: '2026-09-28T10:00:00+08:00' });
  assert.deepEqual(affected, ['o1']);
  assert.equal(hub.orderOf('o1').status, 'confirmed');
  assert.equal(hub.outreachTasks()[0].reason, 'route_suspended');
});

test('部分核销保留剩余承诺，核销记录幂等', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-food', product_id: 'dining', use_date: '2026-10-01', total_slots: 10, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'dining', consumer_id: 'c1', use_date: '2026-10-01', slots: 2, amount: 400, ordered_at: '2026-09-20T12:00:00+08:00' });
  const record = { redemption_id: 'r1', order_id: 'o1', quantity: 1, redeemed_at: '2026-10-01T12:00:00+08:00' };
  assert.equal(hub.redeem(record).duplicate, false);
  assert.equal(hub.redeem(record).duplicate, true);
  assert.equal(hub.orderOf('o1').status, 'partially_redeemed');
  assert.equal(hub.redeem({ redemption_id: 'r2', order_id: 'o1', quantity: 2, redeemed_at: '2026-10-01T13:00:00+08:00' }).reason, 'redeem_exceeds_remaining');
  assert.equal(hub.redeem({ redemption_id: 'r3', order_id: 'o1', quantity: 1, redeemed_at: '2026-10-01T14:00:00+08:00' }).ok, true);
  assert.equal(hub.orderOf('o1').status, 'redeemed');
});

test('补偿对同一订单同一原因只发放一次', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 1, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  const first = hub.issueCompensation({ order_id: 'o1', reason: 'capacity_breach', issued_at: '2026-09-28T10:00:00+08:00' });
  const second = hub.issueCompensation({ order_id: 'o1', reason: 'capacity_breach', issued_at: '2026-09-28T10:00:01+08:00' });
  assert.equal(second.duplicate, true);
  assert.equal(second.record.compensation_id, first.record.compensation_id);
});

test('巡检高风险只影响同商户同品类订单，不向无关商户扩大披露', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 1, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.declareCapacity({ event_id: 'e2', merchant_id: 'm-food', product_id: 'dining', use_date: '2026-10-01', total_slots: 10, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o-hotel', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  hub.placeOrder({ order_id: 'o-dining', product_id: 'dining', consumer_id: 'c2', use_date: '2026-10-01', slots: 1, amount: 200, ordered_at: '2026-09-20T12:00:00+08:00' });
  const { affected } = hub.registerInspection({ inspection_id: 'i1', merchant_id: 'm-food', category: '生冷海鲜', level: 'high', concluded_at: '2026-09-27T15:00:00+08:00' });
  assert.deepEqual(affected, ['o-dining']);
  assert.deepEqual(hub.trace('o-hotel').risks, []);
});

test('商户改规则收窄原承诺时，原订单保留快照并进入外呼', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-food', product_id: 'dining', use_date: '2026-10-01', total_slots: 10, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'dining', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 200, ordered_at: '2026-09-20T12:00:00+08:00' });
  const { affected } = hub.updateProductRule({ product_id: 'dining', rule: { excluded_dates: ['2026-10-01'] }, updated_at: '2026-09-27T16:00:00+08:00' });
  assert.deepEqual(affected, ['o1']);
  assert.equal(hub.orderOf('o1').rule_snapshot, null);
  assert.equal(hub.redeem({ redemption_id: 'r1', order_id: 'o1', quantity: 1, redeemed_at: '2026-10-01T12:00:00+08:00' }).ok, true);
});

test('取消范围按下单时冻结的保障版本执行', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 2, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  hub.registerGuaranteeVersion({ ...GV1, version_id: 'gv-2', effective_from: '2026-09-25T00:00:00+08:00', cancel_scope: { free_cancel_until: '2026-09-27T18:00:00+08:00' } });
  // 冻结版本 gv-1 的窗口仍然有效，即使当前版本 gv-2 的窗口已关闭
  assert.equal(hub.cancelOrder({ order_id: 'o1', at: '2026-09-28T12:00:00+08:00' }).ok, true);
  assert.equal(hub.cancelOrder({ order_id: 'o1', at: '2026-09-28T12:00:00+08:00' }).duplicate, true);
  hub.placeOrder({ order_id: 'o2', product_id: 'hotel', consumer_id: 'c2', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  assert.equal(hub.cancelOrder({ order_id: 'o2', at: '2026-09-30T10:00:00+08:00' }).reason, 'cancel_window_closed');
});

test('客服追溯视图还原申报能力、预防动作与最终结果', () => {
  const hub = setup();
  hub.declareCapacity({ event_id: 'e1', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 1, declared_at: '2026-09-15T10:00:00+08:00' });
  hub.placeOrder({ order_id: 'o1', product_id: 'hotel', consumer_id: 'c1', use_date: '2026-10-01', slots: 1, amount: 1000, ordered_at: '2026-09-20T12:00:00+08:00' });
  hub.declareCapacity({ event_id: 'e2', merchant_id: 'm-hotel', product_id: 'hotel', use_date: '2026-10-01', total_slots: 0, declared_at: '2026-09-27T08:00:00+08:00' });
  hub.issueCompensation({ order_id: 'o1', reason: 'capacity_breach', issued_at: '2026-09-28T10:00:00+08:00' });
  const view = hub.trace('o1');
  assert.equal(view.declared_capacity_at_order.total_slots, 1);
  assert.equal(view.capacity_history.length, 2);
  assert.equal(view.outreach_tasks[0].reason, 'capacity_breach');
  assert.equal(view.compensations[0].amount, 1300);
  assert.equal(view.outcome, 'compensated');
});

test('演练样例端到端回放', async () => {
  const raw = await readFile(new URL('../fixtures/intake-events.json', import.meta.url), 'utf8');
  const scenario = JSON.parse(raw);
  const hub = createAssuranceHub();
  for (const version of scenario.guarantee_versions) hub.registerGuaranteeVersion(version);
  for (const product of scenario.products) hub.registerProduct(product);
  for (const contact of scenario.contacts) hub.setContactPreference(contact);
  const results = scenario.events.map((event) => {
    const { type, ...payload } = event;
    switch (type) {
      case 'capacity_declared':
        return hub.declareCapacity(payload);
      case 'order_placed':
        return hub.placeOrder(payload);
      case 'redemption_recorded':
        return hub.redeem(payload);
      case 'inspection_concluded':
        return hub.registerInspection(payload);
      case 'product_rule_changed':
        return hub.updateProductRule(payload);
      case 'route_suspended':
        return hub.suspendRoute(payload);
      case 'compensation_requested':
        return hub.issueCompensation(payload);
      case 'order_cancelled':
        return hub.cancelOrder(payload);
      default:
        throw new Error(`未知事件类型: ${type}`);
    }
  });
  const [capHotel, , , order1, order1Dup, order2, , , cut, cutDup, inspection, ruleChange, suspend, rd1, rd1Dup, comp1, comp2, cancelTour, cancelHotel] = results;
  assert.equal(capHotel.ok, true);
  assert.equal(order1.ok, true);
  assert.equal(order1Dup.duplicate, true);
  assert.equal(order2.reason, 'insufficient_capacity');
  assert.deepEqual(cut.breaches, ['o-hotel-1']);
  assert.equal(cutDup.duplicate, true);
  assert.deepEqual(inspection.affected, ['o-dining-1']);
  assert.deepEqual(ruleChange.affected, ['o-dining-1']);
  assert.deepEqual(suspend.affected, ['o-tour-1']);
  assert.equal(rd1.ok, true);
  assert.equal(rd1Dup.duplicate, true);
  assert.equal(comp1.record.amount, 1300);
  assert.equal(comp1.record.guarantee_version, 'gv-2026-09');
  assert.equal(comp2.duplicate, true);
  assert.equal(cancelTour.ok, true);
  assert.equal(cancelHotel.reason, 'cancel_window_closed');

  const hotelTrace = hub.trace('o-hotel-1');
  assert.equal(hotelTrace.declared_capacity_at_order.total_slots, 1);
  assert.equal(hotelTrace.outcome, 'compensated');
  const diningTrace = hub.trace('o-dining-1');
  assert.deepEqual(diningTrace.risks.map((r) => r.reason), ['high_risk_category', 'rule_changed']);
  assert.equal(diningTrace.outcome, 'partially_redeemed');
  const tourTrace = hub.trace('o-tour-1');
  assert.equal(tourTrace.outreach_tasks[0].reason, 'route_suspended');
  assert.equal(tourTrace.outcome, 'cancelled');
  // 高风险订单均在履约日期前生成外呼任务，且按联系偏好选择渠道
  const tasks = hub.outreachTasks();
  assert.equal(tasks.length, 4);
  for (const task of tasks) assert.ok(task.created_at <= hub.orderOf(task.order_id).use_date);
  assert.equal(tasks.find((t) => t.order_id === 'o-dining-1' && t.reason === 'high_risk_category').channel, 'sms');
});
