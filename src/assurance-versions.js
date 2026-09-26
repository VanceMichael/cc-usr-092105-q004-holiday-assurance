// 保障版本目录：取消范围与赔付标准按“下单时”的保障版本冻结。
// 商户临时改规则只会发布新版本，不覆盖旧版本；旧订单永远引用下单那一刻的版本快照。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

export class AssuranceVersionRegistry {
  #versions = new Map(); // versionId -> 不可变版本
  #currentByProduct = new Map(); // productId -> { id, no }

  // 发布一个保障版本（始终新增版本号，从不修改已发布版本）。
  publish(input) {
    const productId = input.productId;
    if (!productId) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '保障版本必须带 productId');
    if (!Array.isArray(input.cancellationTiers) || input.cancellationTiers.length === 0) {
      throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '保障版本必须包含取消档位 cancellationTiers');
    }
    const no = (this.#currentByProduct.get(productId)?.no ?? 0) + 1;
    const record = frozenCopy({
      versionId: `${productId}#v${no}`,
      productId,
      no,
      effectiveFrom: input.effectiveFrom ?? new Date().toISOString(),
      cancellationTiers: input.cancellationTiers, // [{ beforeHours, refundRatio }]
      compensation: input.compensation ?? {}, // 品类赔付标准
      rulesText: input.rulesText ?? '',
      source: input.source ?? '商户申报'
    });
    this.#versions.set(record.versionId, record);
    this.#currentByProduct.set(productId, { id: record.versionId, no });
    return record;
  }

  currentVersionId(productId) {
    return this.#currentByProduct.get(productId)?.id ?? null;
  }

  // 下单时调用：返回要写进订单的版本快照（独立深拷贝，之后发布新版本不影响它）。
  freezeAtOrder(productId) {
    const current = this.#currentByProduct.get(productId);
    if (!current) throw new AssuranceError(ErrorCode.VERSION_NOT_FOUND, `产品 ${productId} 没有生效中的保障版本`);
    return this.snapshot(current.id);
  }

  snapshot(versionId) {
    const v = this.#versions.get(versionId);
    if (!v) throw new AssuranceError(ErrorCode.VERSION_NOT_FOUND, `保障版本 ${versionId} 不存在或已被替换`);
    return frozenCopy(v);
  }

  list() {
    return [...this.#versions.values()].map((v) => frozenCopy(v));
  }
}
