// 巡检结论库：食品巡检、酒店巡检的结论按商户归集。
// 规则：巡检风险只用于涉事商户的订单与投诉视图，不向无关商户扩大披露。
// 复查通过可用 resolves 指明消除的历史结论；历史保留，但不再算作“在险”。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

export class InspectionStore {
  #byMerchant = new Map(); // merchantId -> [结论]
  #ids = new Set();
  #bus;

  constructor(bus) {
    this.#bus = bus;
  }

  // input: { inspectionId, merchantId, category, conclusion, hazards, resolves: [旧结论id], at }
  record(input) {
    if (!input.inspectionId || !input.merchantId) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '巡检结论缺少 inspectionId 或 merchantId');
    if (this.#ids.has(input.inspectionId)) {
      return this.forMerchant(input.merchantId).find((i) => i.inspectionId === input.inspectionId);
    }
    const item = {
      inspectionId: input.inspectionId,
      merchantId: input.merchantId,
      category: input.category ?? 'food',
      conclusion: input.conclusion,
      hazards: input.hazards ?? [],
      resolves: input.resolves ?? [],
      resolvedBy: null,
      at: input.at ?? new Date().toISOString()
    };
    if (!this.#byMerchant.has(input.merchantId)) this.#byMerchant.set(input.merchantId, []);
    this.#byMerchant.get(input.merchantId).push(item);
    this.#ids.add(input.inspectionId);

    // 标记被复查消除的历史结论。
    for (const oldId of item.resolves) {
      for (const list of this.#byMerchant.values()) {
        const old = list.find((i) => i.inspectionId === oldId);
        if (old && !old.resolvedBy) old.resolvedBy = item.inspectionId;
      }
    }

    this.#bus?.record('INSPECTION_RECORDED', {
      inspectionId: item.inspectionId, merchantId: item.merchantId,
      category: item.category, conclusion: item.conclusion, resolves: item.resolves
    });
    return frozenCopy(item);
  }

  // 只查涉事商户：不暴露其他商户的巡检信息。
  forMerchant(merchantId) {
    return (this.#byMerchant.get(merchantId) ?? []).map((i) => frozenCopy(i));
  }

  // 该商户是否有未消除的高风险结论（fail 或带危害的 rectify，且未被复查消除）。
  hasActiveRisk(merchantId) {
    return this.forMerchant(merchantId).some(
      (i) => !i.resolvedBy && (i.conclusion === 'fail' || (i.conclusion === 'rectify' && i.hazards.length > 0))
    );
  }
}
