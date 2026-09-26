// 事件总线：中台所有预防动作、商户变更、核销、补偿都只追加事件，供风险引擎与客服溯源消费。
export class EventBus {
  #events = [];
  #subscribers = [];

  record(type, payload = {}) {
    const event = Object.freeze({
      seq: this.#events.length + 1,
      at: new Date().toISOString(),
      type,
      ...payload
    });
    this.#events.push(event);
    for (const fn of this.#subscribers) {
      try { fn(event); } catch { /* 订阅方失败不影响主链路 */ }
    }
    return event;
  }

  subscribe(fn) {
    this.#subscribers.push(fn);
    return () => {
      const i = this.#subscribers.indexOf(fn);
      if (i >= 0) this.#subscribers.splice(i, 1);
    };
  }

  // 溯源：按订单聚合该订单相关的全部事件（含商户申报、预防动作、结果），按时间排列。
  // 容量击穿/停发这类事件通过 affectedOrderIds 关联到订单。
  forOrder(orderId) {
    return this.#events
      .filter((e) => e.orderId === orderId || (Array.isArray(e.affectedOrderIds) && e.affectedOrderIds.includes(orderId)))
      .map((e) => ({ ...e }));
  }

  all() {
    return [...this.#events];
  }
}
