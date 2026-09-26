// 风险引擎：把商户申报、巡检结论、容量状态汇总成订单风险信号。
// 高风险订单必须在履约前进入外呼或人工确认；中风险只记录提示，不阻断履约。

export const RiskCode = Object.freeze({
  NO_ROOM_RISK: 'NO_ROOM_RISK', // 住宿：到店无房风险（超售/改量击穿/停售）
  HIGH_RISK_CATEGORY: 'HIGH_RISK_CATEGORY', // 餐饮：高风险品类
  INSPECTION_FAIL: 'INSPECTION_FAIL', // 巡检不合格
  GROUP_OVERSOLD: 'GROUP_OVERSOLD', // 旅行：纯玩小团超售
  ROUTE_SUSPENDED: 'ROUTE_SUSPENDED', // 旅行：线路停发
  RULE_CHANGED: 'RULE_CHANGED', // 商户临时改规则
  SUPPLY_TIGHT: 'SUPPLY_TIGHT' // 节日期间余量告急（提示级）
});

// 餐饮高风险品类（生食、冷加工等节日重点监管对象）。
export const HIGH_RISK_CATEGORIES = Object.freeze(['生食', '冷荤', '裱花蛋糕', '现榨果蔬汁', '野生菌']);

const LEVEL_ORDER = { none: 0, low: 1, medium: 2, high: 3 };

export function evaluateRisk({ order, capacity, inspections, merchantFlags = {}, inFestivalWindow = false }) {
  const signals = [];
  const add = (code, level, detail) => signals.push({ code, level, detail });

  if (capacity?.breached || capacity?.stopped) {
    const code = order.category === 'lodging' ? RiskCode.NO_ROOM_RISK
      : order.category === 'tour' ? (capacity.stopped ? RiskCode.ROUTE_SUSPENDED : RiskCode.GROUP_OVERSOLD)
      : RiskCode.SUPPLY_TIGHT;
    add(code, 'high', capacity.stopped ? '商户已停发/停售该日期产品' : '商户改量后名额不足以覆盖已承诺订单');
  }
  if (inspections?.hasActiveRisk) add(RiskCode.INSPECTION_FAIL, 'high', '商户存在未消除的巡检风险结论');
  if (order.category === 'dining' && order.highRiskCategory) {
    add(RiskCode.HIGH_RISK_CATEGORY, inFestivalWindow ? 'medium' : 'low', `菜品属于高风险品类：${order.highRiskCategory}`);
  }
  if (merchantFlags.ruleChanged) add(RiskCode.RULE_CHANGED, 'medium', '商户在下单后修改了团购/取消规则');
  if (inFestivalWindow && capacity && capacity.availableRatio !== undefined && capacity.availableRatio < 0.1) {
    add(RiskCode.SUPPLY_TIGHT, 'medium', '节日期间可售余量不足 10%');
  }

  const level = signals.reduce((max, s) => (LEVEL_ORDER[s.level] > LEVEL_ORDER[max] ? s.level : max), 'none');
  return { level, signals, requiresPreFulfillmentAction: level === 'high' };
}
