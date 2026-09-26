// 节日保障中台门面：把各台账编排成业务用例。
// 所有外部回调都经过幂等网关；高风险订单在履约闸口前必须完成预防动作。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';
import { AssuranceVersionRegistry } from './assurance-versions.js';
import { IdempotencyGateway } from './idempotency.js';
import { EventBus } from './event-bus.js';
import { CapacityLedger } from './capacity.js';
import { PromiseLedger } from './promises.js';
import { OrderStore } from './orders.js';
import { VerificationLedger } from './verification.js';
import { CompensationLedger } from './compensation.js';
import { InspectionStore } from './inspections.js';
import { OutreachBoard } from './outreach.js';
import { RefundLedger, computeRefund, assertRefundable } from './settlement.js';
import { evaluateRisk } from './risk.js';
import { buildComplaintTrace } from './complaint-trace.js';

export class AssurancePlatform {
  constructor({ festivalWindow = false } = {}) {
    this.festivalWindow = festivalWindow;
    this.bus = new EventBus();
    this.versions = new AssuranceVersionRegistry();
    this.idempotency = new IdempotencyGateway();
    this.capacity = new CapacityLedger(this.bus);
    this.promises = new PromiseLedger(this.bus);
    this.orders = new OrderStore();
    this.verification = new VerificationLedger(this.bus);
    this.compensations = new CompensationLedger(this.bus);
    this.inspections = new InspectionStore(this.bus);
    this.outreach = new OutreachBoard(this.bus);
    this.refunds = new RefundLedger(this.bus);
    this.stores = Object.freeze({
      bus: this.bus, versions: this.versions, idempotency: this.idempotency, capacity: this.capacity,
      promises: this.promises, orders: this.orders, verification: this.verification,
      compensations: this.compensations, inspections: this.inspections,
      outreach: this.outreach, refunds: this.refunds
    });
  }

  // ---------- 商户侧申报 ----------

  publishAssuranceVersion(input) {
    return this.versions.publish(input);
  }

  // 商户可售能力申报（首次/改量都走这里；重复回调幂等）。
  declareCapacity(input) {
    const defaultKey = `DCL-${input.productId}-${input.date}-${input.declared}-${input.at ?? new Date().toISOString()}`;
    return this.idempotency.run('capacity-declare', input.callbackId ?? defaultKey, input, async () => {
      const result = this.capacity.declare(input);
      if (result.affected.length > 0) {
        for (const a of result.affected) {
          this.promises.appendRevision(a.orderId, {
            type: 'capacity_reduced',
            detail: { declared: result.declared, atRiskUnits: a.atRiskUnits, reason: input.reason ?? '商户改量' }
          });
          this.#raiseRisk(a.orderId, { reason: 'capacity', detail: result });
        }
      }
      return result;
    });
  }

  stopSelling(input) {
    return this.idempotency.run('sales-stop', input.callbackId ?? `STP-${input.productId}-${input.date}`, input, async () => {
      const result = this.capacity.stopSelling(input);
      for (const a of result.affected) {
        this.promises.appendRevision(a.orderId, {
          type: 'route_suspended',
          detail: { reason: input.reason ?? '线路停发', at: input.at ?? null }
        });
        this.#raiseRisk(a.orderId, { reason: 'stopped' });
      }
      return result;
    });
  }

  // 商户临时改规则：只发布新版本；已下订单的冻结版本不受影响，逐条登记变化。
  merchantRuleChange(input) {
    const sig = `${input.productId}-${input.version.effectiveFrom ?? ''}-${JSON.stringify(input.version.cancellationTiers)}`;
    return this.idempotency.run('rule-change', input.callbackId ?? `RUL-${sig}`, input, async () => {
      const newVersion = this.versions.publish(input.version);
      const impacted = this.orders.list(
        (o) => o.productId === input.productId
          && o.assuranceVersion.versionId !== newVersion.versionId
          && o.status !== 'cancelled' && o.status !== 'fulfilled'
      );
      for (const order of impacted) {
        this.promises.appendRevision(order.orderId, {
          type: 'merchant_rule_changed',
          detail: { fromVersionId: order.assuranceVersion.versionId, newVersionId: newVersion.versionId, note: input.note ?? '' }
        });
        // 改规则不阻断履约，但必须有人工提示，不能让消费者按旧理解到店才发现。
        const risk = { level: 'medium', signals: [{ code: 'RULE_CHANGED', level: 'medium', detail: input.note ?? '商户修改了规则' }] };
        this.outreach.dispatch(order, risk, order.travelDate);
      }
      return frozenCopy({ newVersion, impactedOrderIds: impacted.map((o) => o.orderId) });
    });
  }

  recordInspection(input) {
    return this.idempotency.run('inspection', input.inspectionId, input, async () => {
      const item = this.inspections.record(input);
      const active = this.inspections.hasActiveRisk(input.merchantId);
      const pending = this.orders.list(
        (o) => o.merchantId === input.merchantId && o.status !== 'cancelled' && o.status !== 'fulfilled'
      );
      if (active) {
        for (const order of pending) {
          this.promises.appendRevision(order.orderId, {
            type: 'inspection_risk',
            detail: { inspectionId: input.inspectionId, conclusion: input.conclusion, hazards: input.hazards ?? [] }
          });
          this.#raiseRisk(order.orderId, { reason: 'inspection' });
        }
      } else if (input.conclusion === 'pass') {
        // 复查通过、风险消除：自动闭环挂起单，恢复可履约（原事件与修订仍保留可溯源）。
        for (const order of pending) {
          if (order.status === 'risk_held' && this.#evaluate(order).level !== 'high') {
            this.promises.appendRevision(order.orderId, {
              type: 'inspection_cleared',
              detail: { inspectionId: input.inspectionId, resolves: input.resolves ?? [] }
            });
            this.outreach.resolveBySystem(order.orderId, 'merchant_rectified', `复查通过 ${input.inspectionId}`);
            this.capacity.confirm(`HOLD-${order.orderId}`);
            // 部分核销中的订单恢复到 partially_redeemed，其余恢复 confirmed。
            let vState = 'none';
            try { vState = this.verification.status(order.orderId).state; } catch { /* 未登记核销 */ }
            const target = vState === 'partial' ? 'partially_redeemed' : 'confirmed';
            this.orders.transition(order.orderId, target);
          }
        }
      }
      return item;
    });
  }

  // ---------- 下单 ----------

  // input: { orderId, productId, merchantId, category, travelDate, units, amount,
  //          highRiskCategory?, voucherId?, contactPreference: {channel}, callbackId }
  placeOrder(input) {
    return this.idempotency.run('order', input.callbackId ?? input.orderId, input, async () => {
      const holdKey = `HOLD-${input.orderId}`;
      this.capacity.hold({
        productId: input.productId, date: input.travelDate, units: input.units ?? 1,
        orderId: input.orderId, idempotencyKey: holdKey
      });

      const snapshot = this.versions.freezeAtOrder(input.productId);
      const order = this.orders.place({
        orderId: input.orderId,
        productId: input.productId,
        merchantId: input.merchantId,
        category: input.category, // lodging | dining | tour
        travelDate: input.travelDate,
        units: input.units ?? 1,
        amount: input.amount,
        highRiskCategory: input.highRiskCategory ?? null,
        voucherId: input.voucherId ?? null,
        contactPreference: input.contactPreference ?? { channel: 'phone' },
        assuranceVersion: snapshot
      });
      this.promises.commit(input.orderId, {
        orderId: input.orderId,
        productId: input.productId,
        versionId: snapshot.versionId,
        entitlement: { units: order.units, category: order.category, highRiskCategory: order.highRiskCategory },
        cancellationTiers: snapshot.cancellationTiers,
        compensation: snapshot.compensation
      });
      if (input.voucherId || input.category === 'dining') {
        this.verification.registerOrder(input.orderId, order.units);
      }

      const risk = this.#evaluate(order, { excludeOwnHold: true });
      let task = null;
      if (risk.requiresPreFulfillmentAction) {
        this.orders.transition(input.orderId, 'risk_held');
        task = this.outreach.dispatch(order, risk, input.travelDate);
      } else {
        this.capacity.confirm(holdKey);
        this.orders.transition(input.orderId, 'confirmed');
      }
      return frozenCopy({ order: this.orders.get(input.orderId), risk, outreachTask: task });
    });
  }

  // ---------- 预防动作处置 ----------

  completePreventiveTask(taskId, outcome, note) {
    return this.idempotency.run('outreach', taskId, { taskId, outcome }, async () => {
      const done = this.outreach.complete(taskId, outcome, note);
      return this.#afterPreventive(done, outcome, note);
    });
  }

  // 客服按订单操作的便捷入口：找到该订单进行中的预防任务并闭环。
  completePreventiveForOrder(orderId, outcome, note = '') {
    const task = this.outreach.openTaskFor(orderId);
    if (!task) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, `订单 ${orderId} 没有进行中的预防任务`);
    return this.completePreventiveTask(task.taskId, outcome, note);
  }

  #afterPreventive(done, outcome, note) {
    const orderId = done.orderId;
    if (outcome === 'confirmed' || outcome === 'merchant_rectified') {
      if (this.orders.get(orderId).status === 'risk_held') {
        this.capacity.confirm(`HOLD-${orderId}`);
        this.orders.transition(orderId, 'confirmed');
      }
    } else if (outcome === 'consumer_cancelled') {
      const reason = this.#faultReason(done.signals, note);
      return this.#cancel(orderId, { at: new Date().toISOString(), initiator: 'consumer', merchantFault: true, reason });
    }
    // unreachable：维持 risk_held，履约闸口会继续拦截。
    return frozenCopy({ task: done, order: this.orders.get(orderId) });
  }

  // ---------- 核销 ----------

  redeemVoucher(input) {
    return this.idempotency.runWithMeta('voucher', input.idempotencyKey, input, async () => {
      const held = this.orders.get(input.orderId);
      if (held.status === 'risk_held') {
        throw new AssuranceError(ErrorCode.GUARD_BLOCKED, `订单 ${input.orderId} 的高风险预防动作未完成，不能核销`, {
          taskId: this.outreach.openTaskFor(input.orderId)?.taskId ?? null
        });
      }
      const record = this.verification.redeem(input);
      const status = this.verification.status(input.orderId);
      if (status.state === 'partial') this.orders.transition(input.orderId, 'partially_redeemed');
      if (status.state === 'full') this.orders.transition(input.orderId, 'fulfilled');
      return { record, verification: status, order: this.orders.get(input.orderId) };
    }).then(({ result, replayed }) => frozenCopy({ ...result, replayed }));
  }

  // 住宿/小团到店到点履约：过闸后落履约结果。
  markFulfilled(orderId) {
    return this.idempotency.run('fulfill', orderId, { orderId }, async () => {
      this.passFulfillmentGuard(orderId);
      const order = this.orders.get(orderId);
      if (order.status !== 'fulfilled') this.orders.transition(orderId, 'fulfilled');
      return this.orders.get(orderId);
    });
  }

  // ---------- 商户承认履约失败（到店无房/无位/发不了团） ----------

  reportFulfillmentFailure(input) {
    return this.idempotency.run('fulfill-fail', input.callbackId ?? `FAIL-${input.orderId}`, input, async () => {
      const order = this.orders.get(input.orderId);
      this.capacity.reportFulfillmentFailure({ ...input, productId: order.productId, date: order.travelDate });
      this.promises.appendRevision(input.orderId, {
        type: 'fulfillment_failed',
        detail: { category: input.category ?? order.category, reason: input.reason }
      });
      this.#raiseRisk(input.orderId, { reason: 'failure' });
      return this.orders.get(input.orderId);
    });
  }

  // ---------- 取消与赔付 ----------

  // initiator: consumer | merchant | platform；merchantFault 表示责任在商户（改量击穿/停发/巡检/承认失败）。
  cancel(orderId, { at = new Date().toISOString(), initiator = 'consumer', merchantFault = false, reason = '' } = {}) {
    return this.idempotency.run('cancel', orderId, { orderId, at, initiator, merchantFault }, async () =>
      this.#cancel(orderId, { at, initiator, merchantFault, reason })
    );
  }

  #cancel(orderId, { at, initiator, merchantFault, reason }) {
    const order = this.orders.get(orderId);
    // 已取消：回放首次结果，退款与补偿都不会重发。
    if (order.status === 'cancelled') {
      return frozenCopy({
        order,
        refund: this.refunds.of(orderId),
        compensation: this.compensations.list(orderId)[0] ?? null,
        replayed: true
      });
    }
    assertRefundable(order);

    // 退款：商户责任按原承诺全额退；消费者主动取消按冻结版本档位。
    const calc = merchantFault
      ? { hoursBefore: null, refundRatio: 1, refundAmount: order.amount, versionId: order.assuranceVersion.versionId }
      : computeRefund(order, order.assuranceVersion, at);
    const refund = this.refunds.issue(orderId, calc);

    // 释放名额（幂等：已释放回放）。
    try { this.capacity.release(`HOLD-${orderId}`, reason || '订单取消'); } catch { /* 无占用（如核销单）忽略 */ }

    this.orders.transition(orderId, 'cancelled');
    this.bus.record('ORDER_CANCELLED', { orderId, initiator, merchantFault, reason, at });

    // 商户责任：按冻结版本里的赔付标准补偿，补偿只发一次。
    let compensation = null;
    if (merchantFault) compensation = this.#compensateByFrozenStandard(order, reason || 'merchant_fault');

    return frozenCopy({ order: this.orders.get(orderId), refund, compensation });
  }

  // 按“下单时冻结版本”的赔付标准发赔；版本里没标准就不发明细，只留事件。
  #compensateByFrozenStandard(order, reason) {
    const standard = order.assuranceVersion.compensation?.standards?.[reasonKey(reason)]
      ?? order.assuranceVersion.compensation?.standards?.default;
    if (!standard) {
      this.bus.record('COMPENSATION_STANDARD_MISSING', { orderId: order.orderId, reason, versionId: order.assuranceVersion.versionId });
      return null;
    }
    const amount = standard.type === 'ratio'
      ? Math.round(order.amount * standard.value * 100) / 100
      : standard.amount;
    return this.compensations.issue({
      orderId: order.orderId,
      reason: reasonKey(reason),
      amount,
      basis: { versionId: order.assuranceVersion.versionId, rule: standard.rule ?? reason }
    });
  }

  // ---------- 履约闸口 ----------

  // 到店/到点履约前的最后一道闸：高风险订单未完成预防确认一律拦截；中风险提示不阻断。
  passFulfillmentGuard(orderId) {
    const order = this.orders.get(orderId);
    if (order.status === 'risk_held' || this.outreach.hasOpenHigh(orderId)) {
      const task = this.outreach.openTaskFor(orderId);
      throw new AssuranceError(
        ErrorCode.GUARD_BLOCKED,
        `订单 ${orderId} 存在未完成的高风险预防动作，禁止履约`,
        { taskId: task?.taskId ?? null, signals: task?.signals ?? [] }
      );
    }
    this.bus.record('FULFILLMENT_GUARD_PASSED', { orderId });
    return frozenCopy({ allowed: true, order });
  }

  // ---------- 投诉溯源 ----------

  complaint(complaintId, orderId) {
    return buildComplaintTrace({ complaintId, orderId }, this.stores);
  }

  // ---------- 内部 ----------

  #evaluate(order, { excludeOwnHold = false } = {}) {
    let avail = this.capacity.available(order.productId, order.travelDate);
    // 下单瞬间评估时排除本单自己的占用，避免最后一间房误报余量为 0。
    if (avail && excludeOwnHold) {
      avail = { ...avail, used: Math.max(0, avail.used - order.units), available: avail.available + order.units };
    }
    // 击穿承诺线：占用名额超过最新申报（商户改量后才会出现；下单超额在占用时已被 SOLD_OUT 拦截）。
    const breached = avail ? avail.used > avail.declared : false;
    return evaluateRisk({
      order,
      capacity: avail ? {
        breached,
        stopped: avail.stopped,
        availableRatio: avail.declared === 0 ? 0 : avail.available / avail.declared
      } : null,
      inspections: { hasActiveRisk: this.inspections.hasActiveRisk(order.merchantId) },
      inFestivalWindow: this.festivalWindow
    });
  }

  #raiseRisk(orderId, _detail) {
    const order = this.orders.get(orderId);
    if (order.status === 'cancelled' || order.status === 'fulfilled') return;
    const risk = this.#evaluate(order);
    if (!risk.requiresPreFulfillmentAction) {
      // 非高风险也挂一条提示任务，但不改状态、不拦履约。
      if (risk.signals.length > 0) this.outreach.dispatch(order, risk, order.travelDate);
      return;
    }
    if (order.status !== 'risk_held') this.orders.transition(orderId, 'risk_held');
    this.outreach.dispatch(order, risk, order.travelDate);
  }

  // 把预防任务的风险信号翻译成赔付理由键，保证按冻结版本里对应的赔付标准发赔。
  #faultReason(signals = [], note = '') {
    const codes = new Set(signals);
    if (codes.has('NO_ROOM_RISK') || codes.has('GROUP_OVERSOLD') || note.includes('超售')) return '商户超售';
    if (codes.has('ROUTE_SUSPENDED') || note.includes('停发')) return '线路停发';
    if (codes.has('INSPECTION_FAIL') || note.includes('巡检')) return '巡检不合格';
    return note || '商户违约';
  }
}

function reasonKey(reason) {
  if (reason.includes('无房') || reason.includes('无位') || reason.includes('失败')) return 'merchant_fault';
  if (reason.includes('停发')) return 'route_suspended';
  if (reason.includes('改量') || reason.includes('超售')) return 'oversold';
  if (reason.includes('巡检')) return 'inspection';
  return reason || 'default';
}
