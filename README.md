# 双节消费保障联动

中秋国庆订单突增时，酒店到店无房、餐饮高风险品类、纯玩小团超售、商户临时改规则会同时发生。本仓库实现一套**节日保障中台**：接收商户可售能力、团购券规则、出行日期、核销记录、巡检结论与消费者联系偏好，让高风险订单在履约前进入外呼或人工确认，并让取消范围与赔付标准按下单时的保障版本冻结。

## 目录结构

- `contracts/domain.schema.json` / `fixtures/domain.json` / `docs/domain.md` — 领域资料与约定
- `contracts/platform.schema.json` — 中台交换契约（命令与回调的字段、枚举、幂等键要求）
- `fixtures/scenarios/` — 三个可回放的业务场景（住宿改量超售、餐饮高风险品类、小团停发）
- `src/` — 中台实现（见 `docs/domain.md` 模块对照表）
- `test/` — 单元测试、平台集成测试、场景回放测试、契约校验测试

## 硬保证

- **重复回调幂等**：所有写操作带幂等键；重复投递回放首次结果，并发同键共享同一次执行，同键不同载荷判冲突
- **名额不并发占用**：容量占用串行落账，超额直接 `SOLD_OUT`，两个订单拿不到同一名额
- **补偿只发一次**：同一订单同一理由只发一笔；按不同标准重发会被显式拒绝
- **承诺不被悄悄覆盖**：商户改量、线路停发、部分核销只追加记录，原承诺与冻结版本永不被改写
- **高风险履约前确认**：高风险订单挂起并派发外呼/人工确认任务，履约闸口在任务闭环前一律拦截
- **一诉到底**：客服从一次投诉直接看到商户当时申报的能力、平台采取的预防动作、最终退款或履约结果

## 快速开始

```bash
npm test          # 全部单元/集成/场景/契约测试
```

回放单个场景：

```bash
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { replayScenario } from './src/scenario-runner.js';
const s = JSON.parse(await readFile('fixtures/scenarios/lodging-oversold.json','utf8'));
const { traces } = await replayScenario(s);
console.log(traces.map(t => t.step + (t.threw ? ' → ' + t.threw : '')).join('\n'));
"
```

代码内使用：

```js
import { AssurancePlatform } from './src/index.js';

const platform = new AssurancePlatform({ festivalWindow: true });
platform.publishAssuranceVersion({ productId: 'HTL-1', cancellationTiers: [/* 取消档位 */] });
await platform.declareCapacity({ productId: 'HTL-1', date: '2026-10-01', declared: 2, callbackId: 'cb-1' });
await platform.placeOrder({ orderId: 'O1', productId: 'HTL-1', merchantId: 'M1', category: 'lodging',
  travelDate: '2026-10-01', units: 1, amount: 500, contactPreference: { channel: 'phone' } });
// 商户改量击穿 → 订单挂起 → 外呼/人工确认 → 按冻结版本退赔
```

## 校验方式

在仓库根目录运行 `npm test`。测试覆盖：领域资料完整性、幂等网关（重复/并发/冲突/失败重试）、容量并发占用、保障版本冻结、部分核销、补偿只发一次、巡检商户隔离、履约闸口、投诉溯源，以及三个场景样例的端到端回放和契约校验。
