import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CompensationLedger, VerificationLedger, PromiseLedger, EventBus, ErrorCode
} from '../src/index.js';

test('补偿对同一订单同一理由只发一次；不同理由各发一次', () => {
  const cmp = new CompensationLedger(new EventBus());
  const first = cmp.issue({ orderId: 'O1', reason: 'oversold', amount: 150, basis: { versionId: 'P#v1' } });
  const replay = cmp.issue({ orderId: 'O1', reason: 'oversold', amount: 150, basis: { versionId: 'P#v1' } });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(cmp.list('O1').length, 1);

  const other = cmp.issue({ orderId: 'O1', reason: 'inspection', amount: 80, basis: { versionId: 'P#v1' } });
  assert.equal(other.replayed, false);
  assert.equal(cmp.list('O1').length, 2);
});

test('同一理由按不同标准重发被拒，不能悄悄改赔', () => {
  const cmp = new CompensationLedger(new EventBus());
  cmp.issue({ orderId: 'O1', reason: 'oversold', amount: 150, basis: { versionId: 'P#v1' } });
  assert.throws(
    () => cmp.issue({ orderId: 'O1', reason: 'oversold', amount: 50, basis: { versionId: 'P#v2' } }),
    (e) => e.code === ErrorCode.ALREADY_COMPENSATED
  );
});

test('部分核销只追加明细，原权益与未核部分不变；超量核销被拒', () => {
  const ver = new VerificationLedger(new EventBus());
  ver.registerOrder('O1', 4);

  const part = ver.redeem({ orderId: 'O1', idempotencyKey: 'r1', units: 1 });
  assert.equal(part.kind, 'partial');
  const st = ver.status('O1');
  assert.equal(st.redeemed, 1);
  assert.equal(st.remaining, 3);

  // 重复回调只认一次
  const replay = ver.redeem({ orderId: 'O1', idempotencyKey: 'r1', units: 1 });
  assert.equal(replay.replayed, true);
  assert.equal(ver.status('O1').redeemed, 1);

  assert.throws(
    () => ver.redeem({ orderId: 'O1', idempotencyKey: 'r2', units: 4 }),
    (e) => e.code === ErrorCode.ILLEGAL_OVERRIDE
  );

  // 剩余份额仍可核销
  ver.redeem({ orderId: 'O1', idempotencyKey: 'r3', units: 3 });
  assert.equal(ver.status('O1').state, 'full');
});

test('承诺只追加：修订不改写原承诺', () => {
  const pl = new PromiseLedger(new EventBus());
  pl.commit('O1', { productId: 'P', versionId: 'P#v1', entitlement: { units: 1 } });
  pl.appendRevision('O1', { type: 'capacity_reduced', detail: { declared: 0 } });
  pl.appendRevision('O1', { type: 'route_suspended', detail: { reason: '停发' } });

  const timeline = pl.timeline('O1');
  assert.equal(timeline.original.versionId, 'P#v1');
  assert.equal(timeline.revisions.length, 2);
  assert.equal(timeline.revisions[0].type, 'capacity_reduced');
  assert.throws(() => pl.commit('O1', { productId: 'P', versionId: 'P#v2' }), (e) => e.code === ErrorCode.CONFLICT);
});
