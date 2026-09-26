import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { replayScenario } from '../src/scenario-runner.js';

test('fixtures/scenarios 下的全部场景回放通过', async (t) => {
  const dir = new URL('../fixtures/scenarios/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 3, '应至少包含住宿/餐饮/旅行三个场景');

  for (const file of files) {
    await t.test(file, async () => {
      const scenario = JSON.parse(await readFile(new URL(file, dir), 'utf8'));
      const { traces } = await replayScenario(scenario);
      const failed = traces.filter((tr) => !tr.ok);
      assert.equal(failed.length, 0, failed.map((f) => `${f.step}: ${f.error}`).join('; '));
    });
  }
});
