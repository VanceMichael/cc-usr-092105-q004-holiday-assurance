import test from 'node:test';
import assert from 'node:assert/strict';
import { IdempotencyGateway, ErrorCode } from '../src/index.js';

test('重复回调只执行一次，重放首次结果', async () => {
  const gw = new IdempotencyGateway();
  let calls = 0;
  const handler = async () => { calls += 1; return { n: calls }; };

  const first = await gw.run('voucher', 'k1', { a: 1 }, handler);
  const second = await gw.run('voucher', 'k1', { a: 1 }, handler);

  assert.equal(calls, 1);
  assert.deepEqual(second, first);
});

test('并发同键回调共享同一次执行', async () => {
  const gw = new IdempotencyGateway();
  let calls = 0;
  const handler = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true };
  };
  const results = await Promise.all([
    gw.run('order', 'k2', { x: 1 }, handler),
    gw.run('order', 'k2', { x: 1 }, handler),
    gw.run('order', 'k2', { x: 1 }, handler)
  ]);
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.ok === true));
});

test('同键不同载荷判冲突', async () => {
  const gw = new IdempotencyGateway();
  await gw.run('order', 'k3', { amount: 100 }, async () => ({}));
  await assert.rejects(
    gw.run('order', 'k3', { amount: 200 }, async () => ({})),
    (err) => err.code === ErrorCode.CONFLICT
  );
});

test('处理器失败允许同键重试', async () => {
  const gw = new IdempotencyGateway();
  let calls = 0;
  await assert.rejects(gw.run('order', 'k4', {}, async () => { calls += 1; throw new Error('boom'); }));
  const ok = await gw.run('order', 'k4', {}, async () => { calls += 1; return 'recovered'; });
  assert.equal(ok, 'recovered');
  assert.equal(calls, 2);
});

test('不同业务域的同名字段互不干扰', async () => {
  const gw = new IdempotencyGateway();
  const a = await gw.run('capacity-declare', 'same', { v: 1 }, async () => 'capacity');
  const b = await gw.run('order', 'same', { v: 1 }, async () => 'order');
  assert.equal(a, 'capacity');
  assert.equal(b, 'order');
});
