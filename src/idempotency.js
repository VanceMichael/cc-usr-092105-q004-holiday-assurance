// 回调幂等网关：流量突增下商户/内部回调会重复投递，甚至同一回调并发到达。
// 同一幂等键的处理器全局只执行一次：
//   - 先后重复：直接回放首次结果；
//   - 并发同键：后来者等待同一个在途 Promise，绝不二次执行；
//   - 同键不同载荷：判为冲突，显式报错而不是静默覆盖。

import { AssuranceError, ErrorCode, frozenCopy } from './freeze.js';

export class IdempotencyGateway {
  #seen = new Map(); // key -> { scope, fingerprint, status, result, at }
  #inflight = new Map(); // key -> Promise

  static fingerprint(payload) {
    return JSON.stringify(payload ?? null);
  }

  // scope 区分业务域（capacity-declare / order / voucher / compensation …），避免跨域键碰撞。
  run(scope, idempotencyKey, payload, handler) {
    return this.runWithMeta(scope, idempotencyKey, payload, handler).then((r) => r.result);
  }

  // 同 run，但额外返回 { replayed }：调用方可据此标记本次是否为重放（如核销结果）。
  async runWithMeta(scope, idempotencyKey, payload, handler) {
    if (!idempotencyKey) throw new AssuranceError(ErrorCode.INVALID_ARGUMENT, '回调缺少幂等键');
    const key = `${scope}:${idempotencyKey}`;
    const fingerprint = IdempotencyGateway.fingerprint(payload);
    const state = this.#seen.get(key);

    if (state) {
      if (state.fingerprint !== fingerprint) {
        throw new AssuranceError(
          ErrorCode.CONFLICT,
          `幂等键 ${idempotencyKey} 被不同载荷重复使用`,
          { scope, firstAt: state.at }
        );
      }
      if (state.status === 'running') {
        const result = await this.#inflight.get(key); // 在途 Promise 解析为原始结果
        return { result, replayed: true, concurrent: true };
      }
      return { result: frozenCopy(state.result), replayed: true, concurrent: false };
    }

    const record = { scope, fingerprint, status: 'running', result: undefined, at: new Date().toISOString() };
    this.#seen.set(key, record);
    const promise = Promise.resolve()
      .then(handler)
      .then((result) => {
        record.status = 'done';
        record.result = result;
        this.#inflight.delete(key);
        return frozenCopy(result);
      })
      .catch((err) => {
        // 执行失败要允许调用方用同键重试，因此清理占用。
        this.#seen.delete(key);
        this.#inflight.delete(key);
        throw err;
      });
    this.#inflight.set(key, promise);
    const result = await promise;
    return { result, replayed: false, concurrent: false };
  }

  has(scope, idempotencyKey) {
    const s = this.#seen.get(`${scope}:${idempotencyKey}`);
    return Boolean(s) && s.status === 'done';
  }

  status(scope, idempotencyKey) {
    const s = this.#seen.get(`${scope}:${idempotencyKey}`);
    return s ? s.status : 'unknown';
  }
}
