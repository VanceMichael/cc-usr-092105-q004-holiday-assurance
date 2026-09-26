import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityLedger, EventBus, ErrorCode } from '../src/index.js';

function setup() {
  const bus = new EventBus();
  return { bus, cap: new CapacityLedger(bus) };
}

test('同一名额不会被重复占用：同键重放不二次扣减', () => {
  const { cap } = setup();
  cap.declare({ productId: 'P', date: '2026-10-01', declared: 2 });
  const h1 = cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O1', units: 1, idempotencyKey: 'HOLD-O1' });
  const h2 = cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O1', units: 1, idempotencyKey: 'HOLD-O1' });
  assert.equal(h1.status, 'held');
  assert.equal(h2.replayed, true);
  assert.equal(cap.available('P', '2026-10-01').used, 1);
});

test('并发占满：超额请求被拒，两个订单不会拿到同一名额', async () => {
  const { cap } = setup();
  cap.declare({ productId: 'P', date: '2026-10-01', declared: 1 });
  const attempts = await Promise.all(
    ['A', 'B'].map((id) =>
      Promise.resolve().then(() => {
        try {
          return cap.hold({ productId: 'P', date: '2026-10-01', orderId: id, units: 1, idempotencyKey: `HOLD-${id}` });
        } catch (e) {
          return { error: e.code };
        }
      })
    )
  );
  const held = attempts.filter((a) => a.status === 'held');
  const rejected = attempts.filter((a) => a.error === ErrorCode.SOLD_OUT);
  assert.equal(held.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(cap.available('P', '2026-10-01').used, 1);
});

test('容量幂等键被不同订单复用判冲突', () => {
  const { cap } = setup();
  cap.declare({ productId: 'P', date: '2026-10-01', declared: 5 });
  cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O1', units: 1, idempotencyKey: 'K' });
  assert.throws(
    () => cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O2', units: 1, idempotencyKey: 'K' }),
    (e) => e.code === ErrorCode.CONFLICT
  );
});

test('商户改量只追加申报；击穿承诺线时确定性挑出最晚占用订单', () => {
  const { cap } = setup();
  cap.declare({ productId: 'P', date: '2026-10-01', declared: 3, at: '2026-09-20T00:00:00Z' });
  cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O1', units: 1, idempotencyKey: '1' });
  cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O2', units: 1, idempotencyKey: '2' });
  cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O3', units: 1, idempotencyKey: '3' });

  const result = cap.declare({ productId: 'P', date: '2026-10-01', declared: 1, reason: '临时改量', at: '2026-09-25T00:00:00Z' });
  assert.equal(result.breached, true);
  assert.deepEqual(result.affected.map((a) => a.orderId), ['O3', 'O2']); // 最晚占用先受影响

  const history = cap.declarationsOf('P', '2026-10-01');
  assert.equal(history[0].declared, 3); // 首报保留
  assert.equal(history.at(-1).declared, 1); // 改量追加
});

test('线路停发拒绝新单但保留既有占用', () => {
  const { cap } = setup();
  cap.declare({ productId: 'P', date: '2026-10-01', declared: 2 });
  cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O1', units: 1, idempotencyKey: '1' });
  const stop = cap.stopSelling({ productId: 'P', date: '2026-10-01', reason: '停发' });
  assert.deepEqual(stop.affected.map((a) => a.orderId), ['O1']);
  assert.throws(
    () => cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O2', units: 1, idempotencyKey: '2' }),
    (e) => e.code === ErrorCode.SOLD_OUT
  );
  assert.equal(cap.available('P', '2026-10-01').used, 1);
});

test('释放后的名额可再售，释放本身幂等', () => {
  const { cap } = setup();
  cap.declare({ productId: 'P', date: '2026-10-01', declared: 1 });
  cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O1', units: 1, idempotencyKey: '1' });
  cap.release('1');
  const again = cap.release('1');
  assert.equal(again.replayed, true);
  const h = cap.hold({ productId: 'P', date: '2026-10-01', orderId: 'O2', units: 1, idempotencyKey: '2' });
  assert.equal(h.status, 'held');
});
