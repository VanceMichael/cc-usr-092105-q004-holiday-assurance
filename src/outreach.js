// 外呼 / 人工确认看板：高风险订单在履约前必须完成一次预防动作。
// 同一订单同一时刻最多一个进行中的预防任务；风险升级时任务随之升级而不是重复派发。
// 联系偏好决定触达渠道：电话偏好走外呼，其他偏好（短信/App）走人工确认，绝不静默跳过。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

const CHANNEL_FOR = Object.freeze({ phone: 'call', sms: 'manual', app_push: 'manual', none: 'manual' });

export class OutreachBoard {
  #tasks = new Map(); // taskId -> task
  #openByOrder = new Map(); // orderId -> taskId
  #seq = 0;
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  // order: { orderId, contactPreference } ; risk: { level, signals }
  dispatch(order, risk, dueBefore) {
    const existing = this.#openByOrder.get(order.orderId);
    // 联系偏好决定渠道：电话偏好走外呼，其余走人工确认；高风险不改变渠道选择，但处置必须闭环。
    const channel = CHANNEL_FOR[order.contactPreference?.channel ?? 'none'] ?? 'manual';
    const kind = channel === 'call' ? 'outbound_call' : 'manual_confirm';

    if (existing) {
      const task = this.#tasks.get(existing);
      // 风险升级：同一任务升级，不新开，客服看到的是一条连续处置线。
      if (risk.level === 'high' && task.kind !== 'manual_confirm') {
        task.kind = 'manual_confirm';
        task.escalatedAt = new Date().toISOString();
      }
      task.signals = risk.signals.map((s) => s.code);
      return frozenCopy({ ...task, deduped: true });
    }

    const task = {
      taskId: `TSK-${++this.#seq}`,
      orderId: order.orderId,
      kind, // outbound_call | manual_confirm
      channel,
      level: risk.level,
      signals: risk.signals.map((s) => s.code),
      status: 'open',
      dueBefore: dueBefore ?? null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      outcome: null
    };
    this.#tasks.set(task.taskId, task);
    this.#openByOrder.set(order.orderId, task.taskId);
    this.#bus?.record('PREVENTIVE_ACTION_DISPATCHED', {
      orderId: order.orderId, taskId: task.taskId, kind: task.kind, channel: task.channel, level: task.level
    });
    return frozenCopy({ ...task, deduped: false });
  }

  complete(taskId, outcome, note = '') {
    const task = this.#tasks.get(taskId);
    if (!task) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, `预防任务 ${taskId} 不存在`);
    if (task.status !== 'open') return frozenCopy({ ...task, replayed: true });
    task.status = 'done';
    task.outcome = outcome; // confirmed | consumer_cancelled | merchant_rectified | unreachable
    task.note = note;
    task.completedAt = new Date().toISOString();
    this.#openByOrder.delete(task.orderId);
    this.#bus?.record('PREVENTIVE_ACTION_COMPLETED', { orderId: task.orderId, taskId, outcome });
    return frozenCopy({ ...task, replayed: false });
  }

  openTaskFor(orderId) {
    const id = this.#openByOrder.get(orderId);
    return id ? frozenCopy(this.#tasks.get(id)) : null;
  }

  // 风险源消除后（如巡检复查通过）由系统闭环进行中的任务。
  resolveBySystem(orderId, outcome, note = '') {
    const id = this.#openByOrder.get(orderId);
    if (!id) return null;
    const task = this.#tasks.get(id);
    task.status = 'done';
    task.outcome = outcome;
    task.note = note;
    task.resolvedBy = 'system';
    task.completedAt = new Date().toISOString();
    this.#openByOrder.delete(orderId);
    this.#bus?.record('PREVENTIVE_ACTION_COMPLETED', { orderId, taskId: id, outcome, resolvedBy: 'system' });
    return frozenCopy({ ...task });
  }

  isCleared(orderId) {
    return !this.#openByOrder.has(orderId);
  }

  // 只有高风险预防任务未闭环才阻断履约；中风险提示不拦履约但仍留痕。
  hasOpenHigh(orderId) {
    const id = this.#openByOrder.get(orderId);
    return id ? this.#tasks.get(id).level === 'high' : false;
  }

  tasksFor(orderId) {
    return [...this.#tasks.values()].filter((t) => t.orderId === orderId).map((t) => frozenCopy(t));
  }
}
