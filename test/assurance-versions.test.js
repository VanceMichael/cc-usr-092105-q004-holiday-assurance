import test from 'node:test';
import assert from 'node:assert/strict';
import { AssuranceVersionRegistry, ErrorCode } from '../src/index.js';

test('保障版本只增不改：新版本不覆盖旧版本', () => {
  const reg = new AssuranceVersionRegistry();
  const v1 = reg.publish({ productId: 'P', cancellationTiers: [{ beforeHours: 72, refundRatio: 1 }], rulesText: '可退' });
  const v2 = reg.publish({ productId: 'P', cancellationTiers: [{ beforeHours: 0, refundRatio: 0 }], rulesText: '不可退' });

  assert.notEqual(v1.versionId, v2.versionId);
  assert.equal(reg.currentVersionId('P'), v2.versionId);
  assert.equal(reg.snapshot(v1.versionId).rulesText, '可退'); // 旧版本原样保留
});

test('下单冻结的快照独立于之后发布的新版本', () => {
  const reg = new AssuranceVersionRegistry();
  reg.publish({ productId: 'P', cancellationTiers: [{ beforeHours: 24, refundRatio: 1 }] });
  const frozen = reg.freezeAtOrder('P');
  reg.publish({ productId: 'P', cancellationTiers: [{ beforeHours: 0, refundRatio: 0 }] });

  assert.equal(frozen.versionId, 'P#v1');
  assert.deepEqual(frozen.cancellationTiers, [{ beforeHours: 24, refundRatio: 1 }]);
  assert.equal(reg.currentVersionId('P'), 'P#v2');
});

test('外部篡改快照不影响台账内的版本', () => {
  const reg = new AssuranceVersionRegistry();
  reg.publish({ productId: 'P', cancellationTiers: [{ beforeHours: 24, refundRatio: 1 }] });
  const frozen = reg.freezeAtOrder('P');
  assert.throws(() => { frozen.cancellationTiers[0].refundRatio = 0; }, TypeError);
  assert.equal(reg.snapshot('P#v1').cancellationTiers[0].refundRatio, 1);
});

test('没有生效版本时下单报错', () => {
  const reg = new AssuranceVersionRegistry();
  assert.throws(() => reg.freezeAtOrder('X'), (e) => e.code === ErrorCode.VERSION_NOT_FOUND);
});
