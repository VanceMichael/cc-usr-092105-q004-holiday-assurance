// 节日保障中台核心。
//
// 职责：接收商户可售能力、团购券规则、出行日期、核销记录、巡检结论与
// 消费者联系偏好；高风险订单在履约前生成外呼或人工确认任务；取消范围
// 与赔付标准按下单时的保障版本冻结；商户改量、线路停发与部分核销不会
// 悄悄覆盖已确认订单。
//
// 并发约定：实例方法均为同步执行，"检查余量—扣减落账"之间没有异步间隙，
// 因此同一进程内同一名额不会被并发占用。跨进程部署时，存储层必须对
// (product_id, use_date) 的余量扣减与 (order_id, reason) 的补偿键
// 提供唯一约束，语义与本模块保持一致。

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  return value === undefined || value === null ? value : structuredClone(value);
}

function requireFields(target, fields) {
  for (const field of fields) {
    if (target[field] === undefined || target[field] === null || target[field] === '') {
      throw new Error(`缺少必要字段: ${field}`);
    }
  }
}

function requirePositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
}

function requireNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

const capacityKey = (productId, useDate) => `${productId}|${useDate}`;

const PENDING_STATUS = new Set(['confirmed', 'partially_redeemed']);

export function createAssuranceHub() {
  const state = {
    products: new Map(), // product_id -> { merchant_id, type, category, current_rule, rules: [] }
    guaranteeVersions: [], // 按 effective_from 升序
    capacities: new Map(), // capacityKey -> { total, confirmed, version, history: [] }
    orders: new Map(), // order_id -> order（含冻结快照）
    redemptions: new Map(), // redemption_id -> record
    inspections: new Map(), // inspection_id -> record
    contacts: new Map(), // consumer_id -> 联系偏好
    suspensions: new Set(), // 已停发的 capacityKey
    outreachTasks: new Map(), // task_id -> task
    outreachKeys: new Map(), // `${order_id}|${reason}` -> task_id（任务去重）
    compensations: new Map(), // `${order_id}|${reason}` -> record（补偿只发一次）
    processedEvents: new Set(), // 回调幂等键
    seq: 0,
  };

  const nextId = (prefix) => `${prefix}-${String(++state.seq).padStart(4, '0')}`;

  function alreadyProcessed(eventId) {
    if (state.processedEvents.has(eventId)) return true;
    state.processedEvents.add(eventId);
    return false;
  }

  // 下单时刻有效的保障版本：effective_from 不晚于给定时间的最新一版。
  function guaranteeAt(at) {
    let current = null;
    for (const version of state.guaranteeVersions) {
      if (version.effective_from <= at) current = version;
    }
    return current;
  }

  function pendingOrdersOn(productId, useDate) {
    return [...state.orders.values()].filter(
      (order) => order.product_id === productId && order.use_date === useDate && PENDING_STATUS.has(order.status),
    );
  }

  // 高风险订单在履约前进入外呼或人工确认；同一订单同一原因只建一次任务。
  function flagRisk(order, reason, detail, at) {
    if (!PENDING_STATUS.has(order.status)) return null;
    const key = `${order.order_id}|${reason}`;
    const existingId = state.outreachKeys.get(key);
    if (existingId) return state.outreachTasks.get(existingId);
    order.risks.push({ reason, detail, at });
    const pref = state.contacts.get(order.consumer_id);
    const task = {
      task_id: nextId('task'),
      order_id: order.order_id,
      consumer_id: order.consumer_id,
      reason,
      detail,
      channel: pref?.channel ?? 'phone',
      status: 'pending',
      created_at: at,
    };
    state.outreachTasks.set(task.task_id, task);
    state.outreachKeys.set(key, task.task_id);
    return task;
  }

  function registerGuaranteeVersion(version) {
    requireFields(version, ['version_id', 'effective_from', 'cancel_scope', 'compensation']);
    if (state.guaranteeVersions.some((v) => v.version_id === version.version_id)) {
      throw new Error(`保障版本已存在: ${version.version_id}`);
    }
    state.guaranteeVersions.push(freezeDeep(clone(version)));
    state.guaranteeVersions.sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
    return { ok: true };
  }

  function registerProduct(product) {
    requireFields(product, ['product_id', 'merchant_id', 'type', 'category']);
    if (state.products.has(product.product_id)) throw new Error(`团购产品已存在: ${product.product_id}`);
    state.products.set(product.product_id, {
      product_id: product.product_id,
      merchant_id: product.merchant_id,
      type: product.type,
      category: product.category,
      current_rule: clone(product.rule) ?? null,
      rules: product.rule ? [{ rule: clone(product.rule), updated_at: product.updated_at ?? null }] : [],
    });
    return { ok: true };
  }

  function setContactPreference(pref) {
    requireFields(pref, ['consumer_id', 'channel']);
    state.contacts.set(pref.consumer_id, { channel: pref.channel, allow_hours: clone(pref.allow_hours) ?? null });
    return { ok: true };
  }

  // 商户申报可售能力。申报只追加不篡改：改量低于已确认量时记录违约风险
  // 并对受影响订单外呼，已确认订单的承诺保持不变。
  function declareCapacity(event) {
    requireFields(event, ['event_id', 'merchant_id', 'product_id', 'use_date', 'declared_at']);
    requireNonNegativeInt(event.total_slots, 'total_slots');
    if (alreadyProcessed(event.event_id)) return { ok: true, duplicate: true, breaches: [] };
    const product = state.products.get(event.product_id);
    if (!product) throw new Error(`未登记的团购产品: ${event.product_id}`);
    if (product.merchant_id !== event.merchant_id) throw new Error('商户只能申报自有产品的可售能力');
    const key = capacityKey(event.product_id, event.use_date);
    let rec = state.capacities.get(key);
    if (!rec) {
      rec = { total: 0, confirmed: 0, version: 0, history: [] };
      state.capacities.set(key, rec);
    }
    rec.history.push({ event_id: event.event_id, total_slots: event.total_slots, declared_at: event.declared_at });
    rec.total = event.total_slots;
    rec.version += 1;
    const breaches = [];
    if (rec.total < rec.confirmed) {
      for (const order of pendingOrdersOn(event.product_id, event.use_date)) {
        flagRisk(order, 'capacity_breach', '商户改量后可售能力低于已确认订单', event.declared_at);
        breaches.push(order.order_id);
      }
    }
    return { ok: true, duplicate: false, breaches };
  }

  // 下单即冻结保障版本与团购券规则快照；余量检查与扣减同步完成，不超售。
  function placeOrder(input) {
    requireFields(input, ['order_id', 'product_id', 'consumer_id', 'use_date', 'ordered_at']);
    requirePositiveInt(input.slots, 'slots');
    const existing = state.orders.get(input.order_id);
    if (existing) return { ok: true, duplicate: true, order: existing };
    const product = state.products.get(input.product_id);
    if (!product) throw new Error(`未登记的团购产品: ${input.product_id}`);
    if (state.suspensions.has(capacityKey(input.product_id, input.use_date))) {
      return { ok: false, reason: 'route_suspended' };
    }
    const guarantee = guaranteeAt(input.ordered_at);
    if (!guarantee) throw new Error('下单时间没有有效的保障版本');
    const key = capacityKey(input.product_id, input.use_date);
    const rec = state.capacities.get(key);
    const remaining = rec ? rec.total - rec.confirmed : 0;
    if (remaining < input.slots) return { ok: false, reason: 'insufficient_capacity' };
    rec.confirmed += input.slots;
    rec.version += 1;
    const order = {
      order_id: input.order_id,
      product_id: input.product_id,
      consumer_id: input.consumer_id,
      use_date: input.use_date,
      slots: input.slots,
      redeemed_slots: 0,
      amount: input.amount ?? 0,
      ordered_at: input.ordered_at,
      status: 'confirmed',
      guarantee_snapshot: freezeDeep(clone(guarantee)),
      rule_snapshot: freezeDeep(clone(product.current_rule)),
      risks: [],
    };
    state.orders.set(order.order_id, order);
    return { ok: true, duplicate: false, order };
  }

  // 核销按 redemption_id 幂等；部分核销只扣减已核销数量，剩余承诺继续有效，
  // 且核销始终按订单冻结的规则快照执行，不受商户事后改规则影响。
  function redeem(input) {
    requireFields(input, ['redemption_id', 'order_id', 'redeemed_at']);
    requirePositiveInt(input.quantity, 'quantity');
    const duplicate = state.redemptions.get(input.redemption_id);
    if (duplicate) return { ok: true, duplicate: true, record: duplicate };
    const order = state.orders.get(input.order_id);
    if (!order) throw new Error(`订单不存在: ${input.order_id}`);
    if (order.status === 'cancelled') return { ok: false, reason: 'order_cancelled' };
    const remaining = order.slots - order.redeemed_slots;
    if (input.quantity > remaining) return { ok: false, reason: 'redeem_exceeds_remaining' };
    order.redeemed_slots += input.quantity;
    order.status = order.redeemed_slots === order.slots ? 'redeemed' : 'partially_redeemed';
    const record = {
      redemption_id: input.redemption_id,
      order_id: input.order_id,
      quantity: input.quantity,
      redeemed_at: input.redeemed_at,
    };
    state.redemptions.set(record.redemption_id, record);
    return { ok: true, duplicate: false, record };
  }

  // 线路停发只标记风险并触发外呼，不取消已确认订单。
  function suspendRoute(event) {
    requireFields(event, ['event_id', 'product_id', 'use_date', 'decided_at']);
    if (alreadyProcessed(event.event_id)) return { ok: true, duplicate: true, affected: [] };
    state.suspensions.add(capacityKey(event.product_id, event.use_date));
    const affected = [];
    for (const order of pendingOrdersOn(event.product_id, event.use_date)) {
      flagRisk(order, 'route_suspended', event.reason ?? '线路停发', event.decided_at);
      affected.push(order.order_id);
    }
    return { ok: true, duplicate: false, affected };
  }

  // 巡检结论只作用于同商户同品类的待履约订单，不向无关商户扩大披露。
  function registerInspection(event) {
    requireFields(event, ['inspection_id', 'merchant_id', 'category', 'level', 'concluded_at']);
    if (state.inspections.has(event.inspection_id)) return { ok: true, duplicate: true, affected: [] };
    state.inspections.set(event.inspection_id, clone(event));
    const affected = [];
    if (event.level === 'high') {
      for (const order of state.orders.values()) {
        if (!PENDING_STATUS.has(order.status)) continue;
        const product = state.products.get(order.product_id);
        if (product.merchant_id === event.merchant_id && product.category === event.category) {
          flagRisk(order, 'high_risk_category', '巡检判定高风险品类', event.concluded_at);
          affected.push(order.order_id);
        }
      }
    }
    return { ok: true, duplicate: false, affected };
  }

  // 商户改规则只对新订单生效；若新规则收窄了待履约订单的原承诺范围
  // （有效期提前或出行日期被排除），原订单保留快照并进入外呼。
  function updateProductRule(event) {
    requireFields(event, ['product_id', 'rule', 'updated_at']);
    const product = state.products.get(event.product_id);
    if (!product) throw new Error(`未登记的团购产品: ${event.product_id}`);
    product.rules.push({ rule: clone(event.rule), updated_at: event.updated_at });
    product.current_rule = clone(event.rule);
    const excluded = event.rule.excluded_dates ?? [];
    const affected = [];
    for (const order of state.orders.values()) {
      if (order.product_id !== event.product_id || !PENDING_STATUS.has(order.status)) continue;
      const narrowed = (event.rule.valid_until && order.use_date > event.rule.valid_until) || excluded.includes(order.use_date);
      if (narrowed) {
        flagRisk(order, 'rule_changed', '商户改规则收窄了原承诺范围', event.updated_at);
        affected.push(order.order_id);
      }
    }
    return { ok: true, affected };
  }

  // 取消范围以下单时冻结的保障版本为准；取消幂等，释放未核销名额。
  function cancelOrder(input) {
    requireFields(input, ['order_id', 'at']);
    const order = state.orders.get(input.order_id);
    if (!order) throw new Error(`订单不存在: ${input.order_id}`);
    if (order.status === 'cancelled') return { ok: true, duplicate: true };
    if (order.status === 'redeemed') return { ok: false, reason: 'already_redeemed' };
    const scope = order.guarantee_snapshot.cancel_scope ?? {};
    if (scope.free_cancel_until && input.at > scope.free_cancel_until) {
      return { ok: false, reason: 'cancel_window_closed' };
    }
    order.status = 'cancelled';
    const rec = state.capacities.get(capacityKey(order.product_id, order.use_date));
    if (rec) {
      rec.confirmed -= order.slots - order.redeemed_slots;
      rec.version += 1;
    }
    return { ok: true, duplicate: false };
  }

  // 补偿对同一订单同一原因只发放一次；金额默认按冻结版本的赔付标准计算。
  function issueCompensation(input) {
    requireFields(input, ['order_id', 'reason', 'issued_at']);
    const order = state.orders.get(input.order_id);
    if (!order) throw new Error(`订单不存在: ${input.order_id}`);
    const key = `${input.order_id}|${input.reason}`;
    const duplicate = state.compensations.get(key);
    if (duplicate) return { ok: true, duplicate: true, record: duplicate };
    const standard = order.guarantee_snapshot.compensation?.[input.reason];
    const amount = input.amount ?? round2(order.amount * (standard?.rate ?? 1));
    const record = {
      compensation_id: nextId('comp'),
      order_id: input.order_id,
      reason: input.reason,
      amount,
      guarantee_version: order.guarantee_snapshot.version_id,
      issued_at: input.issued_at,
    };
    state.compensations.set(key, record);
    return { ok: true, duplicate: false, record };
  }

  // 客服追溯视图：从一次投诉看到商户当时申报的能力、平台采取的预防动作
  // 以及最终退款或履约结果。
  function trace(orderId) {
    const order = state.orders.get(orderId);
    if (!order) throw new Error(`订单不存在: ${orderId}`);
    const rec = state.capacities.get(capacityKey(order.product_id, order.use_date));
    const history = rec ? [...rec.history] : [];
    const declaredAtOrderTime = [...history].reverse().find((h) => h.declared_at <= order.ordered_at) ?? null;
    const outreachTasks = [...state.outreachTasks.values()].filter((t) => t.order_id === orderId);
    const redemptions = [...state.redemptions.values()].filter((r) => r.order_id === orderId);
    const compensations = [...state.compensations.values()].filter((c) => c.order_id === orderId);
    const outcome =
      order.status === 'redeemed'
        ? 'fulfilled'
        : order.status === 'partially_redeemed'
          ? 'partially_redeemed'
          : order.status === 'cancelled'
            ? compensations.length > 0
              ? 'refunded'
              : 'cancelled'
            : compensations.length > 0
              ? 'compensated'
              : 'pending';
    return {
      order,
      guarantee_version: order.guarantee_snapshot.version_id,
      declared_capacity_at_order: declaredAtOrderTime,
      capacity_history: history,
      risks: [...order.risks],
      outreach_tasks: outreachTasks,
      fulfillment_events: redemptions,
      compensations,
      outcome,
    };
  }

  return {
    registerGuaranteeVersion,
    registerProduct,
    setContactPreference,
    declareCapacity,
    placeOrder,
    redeem,
    suspendRoute,
    registerInspection,
    updateProductRule,
    cancelOrder,
    issueCompensation,
    trace,
    capacityOf: (productId, useDate) => {
      const rec = state.capacities.get(capacityKey(productId, useDate));
      return rec ? { total: rec.total, confirmed: rec.confirmed, version: rec.version } : null;
    },
    orderOf: (orderId) => state.orders.get(orderId) ?? null,
    outreachTasks: () => [...state.outreachTasks.values()],
  };
}
