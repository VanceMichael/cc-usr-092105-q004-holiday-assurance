// 场景回放器：把 fixtures/scenarios/*.json 里的步骤序列在一个全新中台上重放。
// 每步可声明 expect：throws 表示该步必须抛出指定错误码；status/equal 校验返回字段。
// capture 可把返回值里的字段存入变量，后续步骤用 {{var}} 占位引用（如预防任务 id）。

import { AssurancePlatform, ErrorCode } from './index.js';

export async function replayScenario(scenario, { festivalWindow = true } = {}) {
  const platform = new AssurancePlatform({ festivalWindow });
  const vars = {};
  const traces = [];

  for (const [index, rawStep] of scenario.steps.entries()) {
    const step = hydrate(rawStep, vars);
    const fn = resolveOp(platform, step.op);
    try {
      const result = await fn(step.input);
      if (step.expect?.throws) throw new Error(`第 ${index + 1} 步（${step.op}）预期抛出 ${step.expect.throws}，但成功了`);
      if (step.expect?.status && result?.order?.status !== step.expect.status && result?.status !== step.expect.status) {
        throw new Error(`第 ${index + 1} 步状态应为 ${step.expect.status}，实际 ${result?.order?.status ?? result?.status}`);
      }
      if (step.expect?.equal) {
        for (const [path, expected] of Object.entries(step.expect.equal)) {
          const actual = getPath(result, path);
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`第 ${index + 1} 步 ${path} 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
          }
        }
      }
      for (const [name, path] of Object.entries(step.capture ?? {})) vars[name] = getPath(result, path);
      traces.push({ step: step.op, ok: true, result: summarize(result) });
    } catch (err) {
      if (step.expect?.throws) {
        const want = ErrorCode[step.expect.throws] ?? step.expect.throws;
        if (err.code !== want) throw new Error(`第 ${index + 1} 步预期错误码 ${want}，实际 ${err.code}：${err.message}`);
        traces.push({ step: step.op, ok: true, threw: want });
      } else {
        traces.push({ step: step.op, ok: false, error: `${err.code ?? 'Error'}: ${err.message}` });
        throw err;
      }
    }
  }
  return { platform, traces, vars };
}

function hydrate(value, vars) {
  if (typeof value === 'string') {
    const m = value.match(/^\{\{(\w+)\}\}$/);
    if (m) return vars[m[1]];
    return value.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path) => JSON.stringify(getPath(vars, path) ?? null));
  }
  if (Array.isArray(value)) return value.map((v) => hydrate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hydrate(v, vars)]));
  }
  return value;
}

function resolveOp(platform, op) {
  const table = {
    publishAssuranceVersion: platform.publishAssuranceVersion.bind(platform),
    declareCapacity: platform.declareCapacity.bind(platform),
    stopSelling: platform.stopSelling.bind(platform),
    merchantRuleChange: platform.merchantRuleChange.bind(platform),
    recordInspection: platform.recordInspection.bind(platform),
    placeOrder: platform.placeOrder.bind(platform),
    completePreventiveTask: (input) => platform.completePreventiveTask(input.taskId, input.outcome, input.note),
    completePreventiveForOrder: (input) => platform.completePreventiveForOrder(input.orderId, input.outcome, input.note),
    redeemVoucher: platform.redeemVoucher.bind(platform),
    markFulfilled: (input) => platform.markFulfilled(input.orderId),
    reportFulfillmentFailure: platform.reportFulfillmentFailure.bind(platform),
    cancel: (input) => platform.cancel(input.orderId, input),
    guard: (input) => platform.passFulfillmentGuard(input.orderId),
    complaint: (input) => platform.complaint(input.complaintId, input.orderId)
  };
  if (!table[op]) throw new Error(`未知场景步骤：${op}`);
  return table[op];
}

function getPath(obj, path) {
  return String(path).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function summarize(result) {
  if (result === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return String(result);
  }
}
