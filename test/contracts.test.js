import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { validate } from '../src/schema-check.js';

// 场景中的命令步骤都应满足交换契约（只读步骤 guard/complaint 不在命令契约内，跳过）。
const READ_OPS = new Set(['guard', 'complaint']);

test('三个场景中的每个命令步骤都符合 platform.schema.json', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/platform.schema.json', import.meta.url), 'utf8'));
  const dir = new URL('../fixtures/scenarios/', import.meta.url);

  for (const file of await readdir(dir)) {
    if (!file.endsWith('.json')) continue;
    const scenario = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
    for (const [i, step] of scenario.steps.entries()) {
      if (READ_OPS.has(step.op)) continue;
      const message = { op: step.op, ...step.input };
      const result = validate(schema, message);
      assert.ok(result.valid, `${file} 第 ${i + 1} 步 ${step.op} 违反契约：\n- ${result.errors.join('\n- ')}`);
    }
  }
});

test('契约拒绝越界与缺字段的命令', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/platform.schema.json', import.meta.url), 'utf8'));

  assert.equal(validate(schema, {
    op: 'placeOrder', orderId: 'X', productId: 'P', merchantId: 'M',
    category: 'lodging', travelDate: '2026-10-01', amount: 100
  }).valid, true);

  // 缺必填 merchantId
  const bad1 = validate(schema, {
    op: 'placeOrder', orderId: 'X', productId: 'P', category: 'lodging', travelDate: '2026-10-01', amount: 100
  });
  assert.equal(bad1.valid, false);
  assert.ok(bad1.errors.some((e) => e.includes('merchantId')));

  // 非法枚举
  const bad2 = validate(schema, {
    op: 'placeOrder', orderId: 'X', productId: 'P', merchantId: 'M',
    category: 'airline', travelDate: '2026-10-01', amount: 100
  });
  assert.equal(bad2.valid, false);

  // 退款比例越界
  const bad3 = validate(schema, {
    op: 'publishAssuranceVersion', productId: 'P',
    cancellationTiers: [{ beforeHours: 24, refundRatio: 1.5 }]
  });
  assert.equal(bad3.valid, false);
});
