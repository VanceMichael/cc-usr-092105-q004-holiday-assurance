import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRefund, refundRatioFor, RefundLedger } from '../src/index.js';

const version = {
  versionId: 'P#v1',
  cancellationTiers: [
    { beforeHours: 72, refundRatio: 1 },
    { beforeHours: 24, refundRatio: 0.5 },
    { beforeHours: 0, refundRatio: 0 }
  ]
};

const order = { orderId: 'O1', category: 'lodging', travelDate: '2026-10-01', amount: 500 };

test('退款比例按距履约小时数匹配档位', () => {
  assert.equal(refundRatioFor(version, 100), 1);
  assert.equal(refundRatioFor(version, 72), 1);
  assert.equal(refundRatioFor(version, 30), 0.5);
  assert.equal(refundRatioFor(version, 24), 0.5);
  assert.equal(refundRatioFor(version, 5), 0);
});

test('退款金额计算与四舍五入', () => {
  const r = computeRefund(order, version, '2026-09-29T13:00:00+08:00'); // 距 10-01 14:00 为 49 小时
  assert.equal(r.refundRatio, 0.5);
  assert.equal(r.refundAmount, 250);
  assert.equal(r.versionId, 'P#v1');
});

test('一笔订单只退一次，重复请求回放', () => {
  const ledger = new RefundLedger();
  const first = ledger.issue('O1', { refundAmount: 250, refundRatio: 0.5, versionId: 'P#v1' });
  const again = ledger.issue('O1', { refundAmount: 999, refundRatio: 0, versionId: 'P#v2' });
  assert.equal(again.replayed, true);
  assert.equal(again.refundAmount, 250);
  assert.equal(ledger.of('O1').versionId, 'P#v1');
});
