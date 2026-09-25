# MetaCoin Usage And Query Billing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 其他执行代理使用本地 `executing-plans` 技能；按任务先测试、后实现、再评审。本文定稿不代表运行能力已交付。

**Goal:** 在单用户多任务边界内，建立按 Query 归因、按阶段可解释的用量、成本及 MetaCoin 应计账单，并通过幂等接口向独立第三方系统提交消费账单。

**Architecture:** 保留 Web/Feishu/TUI -> Gateway -> AccountRuntime -> Planner/Kernel/Runtime 主轴。计量模块收集事实，账单模块核算费用，第三方系统持有资金账户并执行实际扣款；Task 只是跨 Query 的汇总维度，不重复收费。Kernel 继续独占调度与恢复政策。

**Tech Stack:** 现有 Node 22.19+、TypeScript ESM、SQLite、Vitest 和 vendored AnyFusion-Pi；复用三端 Gateway。金额采用 `bigint`/精确有理数，JSON 金额采用十进制字符串；不新增支付 SDK 或强制模型代理。

---

- 计划日期与文档定稿日期：2026-09-21。
- 版本与状态：**v2.2 实施完成，未提交**。本版整体替代同路径原 16 项任务方案。
- 交付范围：详细实施方案、文档索引、此前现状评估的范围变更说明；只修改文档。
- 实施完成日期：2026-09-22；外部消费 export 仍按文档门禁保持关闭。
- 关闭提交：未创建提交。实施时逐阶段追加实际验证、交付日期及关闭提交。
- 前置依据：[现状评估](2026-09-21-multi-tenant-and-query-metering-assessment.md)、[ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0031](../adr/0031-account-runtime-and-unified-client-gateway.md)、[ADR-0037](../adr/0037-multi-conversation-task-parallelism.md)、[CONTEXT](../../CONTEXT.md)。
- 权威：代码和测试优先。本文定义目标方案，不直接变更 Accepted ADR；新增架构决定在 Task 1 记录和评审。

## 1. 定稿边界

### 1.1 本期做账单，不做资金系统

| 事项 | MetaWork 本期职责 | 第三方系统职责 |
| --- | --- | --- |
| 资源用量 | 采集模型、工具、执行资源的可信用量 | 可提供供应商或外部对账记录 |
| 成本 | 核算参考成本、可核实实际成本、平台承担部分 | 不替代 MetaWork 的资源归因 |
| MetaCoin | 计算每个 Query 的应计消耗及明细 | 管理余额，执行真实扣款 |
| 消费对接 | 幂等提交最终账单、查询结果、记录回执 | 幂等应用账单，返回明确扣款结果 |
| 订阅、充值、支付、退款 | 不建设相关业务系统 | 全部由外部独立系统处理 |
| 三端展示 | 展示用量、费用、完整性、对账和扣款确认状态 | 可通过独立入口提供资金服务 |

已确认商业背景保持不变：订阅费全额转换为 MetaCoin，1 元人民币对应 1 MetaCoin，初期按成本加价 30%～50%。但充值兑换和订阅权益不是本期 MetaWork 数据模型或实施任务。

这里的 30%～50% 是**成本加价率，不是净利润率**。生产使用明确的价格版本和加价率，本文的 40% 只是测试示例；不承诺每个 Query 的实际利润。

### 1.2 明确排除

- 不建设本地钱包、余额、充值订单、支付回调、订阅续费、退款执行或营销额度系统。
- 不建设余额冻结、预算预留/扣划、本地透支控制；本版本不承诺“余额不足一定无法产生资源成本”。
- 不关闭自定义 Provider，不限制为 MetaWork Provider，不迁移用户现有 Key。
- 不以计费为由新增统一模型代理、修改所有模型流量出口或强制更换 Harness。
- 不建设共享 Runtime 多租户、用户注册、组织权限或集群公平调度。
- 不把 Query 强制等同于 Task，不提前创建空 Task，不增加第二个语义路由器或调度器。

保留单用户多任务可靠性修复，因为清理、恢复和错误重启直接影响成本归因及重复执行风险。此项不是重新开展多租户项目。

### 1.3 交付方式

按 **observe（只计量）-> shadow（影子账单）-> export（提交外部消费）** 发布。生产第三方选择、接口凭据、价格和对账窗口是部署输入，不重新打开已确认范围；缺少这些输入时仍可交付前两种模式。

## 2. Query、Turn 与 Task 的准确关系

### 2.1 定义与现有代码依据

| 概念 | 定义 | 费用关系 |
| --- | --- | --- |
| Query | 服务端接受的一次语义请求，或明确启动新执行段的用户操作 | 轻量用量归因根；不是新的任务状态机 |
| Turn | 现有交互轮次与展示关联 | 可绑定 Query，但 UI 结束不代表后台调用全部结束 |
| Task | 经 Kernel 授权后创建或继续执行的持久工作 | 一个 Task 可累积多个 Query 的费用 |
| Attempt | 一次被授权的执行尝试 | 包含多次调用；不同尝试不等于不同用户 Query |

当前 [ConversationSession](../../src/session/conversation-session.ts) 处理语义请求和显式系统命令；[SessionKernelRuntime](../../src/session/session-kernel-runtime.ts) 的澄清路径只输出问题，`applyTaskPlan` 的授权应用路径才创建 Task。[ControlKernel](../../src/kernel/control-kernel.ts) 的 `no_op` 也可以针对已经运行或正在发布的 Task，不能解释成“没有 Task”。

生产语义规划不开放 `direct_reply` 作为工作请求的简化绕行路径。不能为了计费重建“聊天模型直接回答、任务模型另一路”的语义分流。

### 2.2 归因规则

| 场景 | Query 归因 | Task 关系 | 是否可能有成本 |
| --- | --- | --- | --- |
| 新工作请求，规划并执行 | 首次可能收费的调用前建立 Query | 授权创建 Task 后补关联 | 是，包含创建 Task 前的 Planner 成本 |
| 澄清问题 | 当前 Query 结束；用户补充是新 Query | 本轮可没有 Task | 是，Planner 已调用模型 |
| 规划失败或收敛耗尽 | 保留当前 Query 与失败记录 | 可以没有 Task | 是，不得因无 Task 丢弃成本 |
| 针对现有任务解释、规划或控制 | 当前请求自己的 Query | 仅明确、权威绑定时归该 Task | 取决于实际调用 |
| 用户显式 Resume 或新追加要求 | 新 Query/新执行段 | 可以继续原 Task | 是；不把原段未结束的调用转移过来 |
| 自动 retry、fallback、replan | 继承触发执行段的 Query | 原 Task | 可能新增成本；按调用实际发生次数计量 |
| 权限按钮批准 | 继续原执行段，不创建新收费归属 | 原 Task | 批准动作本身不收费，后续执行计入原 Query |
| `/status`、停止、历史回放、重连 | 不自动创建付费执行段 | 可引用现有 Task | 无实际付费调用则为零 |
| 自然语言“查看进度”等 | 若进入 Planner，建立当前 Query | 按明确绑定处理 | 可能有 Planner 成本 |
| `no_op` 决策 | 保留本次请求已经发生的计量 | 有无 Task 均可能 | 不因决策名自动判零 |

同一请求重传以既有请求幂等身份复用 Query；相同文字的新请求不是重传。身份需按账户及入口作用域限定，拒绝相同请求键配不同 payload。断开客户端、切换 Conversation、浏览历史均不改变费用归属。

### 2.3 示例

```text
Q1: “帮我分析这份材料” -> Planner 澄清材料位置 -> 无 Task，但可能有费用
Q2: 用户补充材料 -> Planner -> Kernel 授权创建 T1 -> 执行/验证 -> Q2 账单
Q3: 用户明确恢复 T1 -> 新执行段 -> 自动重试仍归 Q3 -> Q3 账单

T1 费用汇总 = Q2 最终应计 + Q3 最终应计
账户期间费用 = Q1 + Q2 + Q3
```

不能根据“上一条消息”或语义相似度把 Q1 自动重新挂到 T1。产品可展示关联会话，但不能用模糊推断改变已经形成的归因。

### 2.4 持久关联约束

- `queryId` 在首次可能产生费用的调用前持久化，复用现有 request/Turn 身份，不重写输入邮箱架构。
- 建议 `costTaskId: string | null`：一个 Query 在本期最多有一个收费归属 Task，由授权应用事实绑定；允许 `null -> 一个 Task`，不允许随 UI 焦点更换。
- `relatedTaskIds` 可表达只读引用多个 Task，但不是费用分配依据。跨 Task 查询无法明确归属时保持无 Task。
- `executionSegmentId`、Planner run、Task generation、Attempt 与 Query 的映射持久化，恢复后仍可查询。旧段剩余调用和新 Resume 调用必须分别归因。
- Task 创建后关联同一 Query 的已有 observations，不复制、搬迁或重复写费用记录。
- Task 汇总只相加已分配 Query 的最终金额；不新增扣款，不用当前价格重算历史账单。进行中和待核对金额另列。
- Task 已授权但关联应用中断时，从已持久授权事实幂等补齐后再出最终单；不因崩溃临时误判为无 Task。

澄清 UI 无 Task 时改为“等待你补充信息”，不能显示“任务在此等待”。无 Task 的账单直接按 Query 获取，不调用 Task Dashboard 后再显示 `turn_task_mismatch`。

## 3. 单用户多任务现状与必要修复

当前已有不同 Conversation 的 Task 并发基础，默认账户 Task 上限 2、Attempt 上限 4、单 Task Attempt 上限 2；同 Conversation 一个执行槽。参见 [配置](../../src/configuration/schema.ts) 与 [ADR-0037](../adr/0037-multi-conversation-task-parallelism.md)。配置上限不是完整可靠性保证。

以下为此前审核记录，实施时先固化回归测试，不把“计划列出”当成“已修复”：

| ID | 缺口 | 主要入口 | 证据级别 |
| --- | --- | --- | --- |
| S1 | A/B 占满槽，C 排队，A 完成后跨 Conversation 队列不能可靠唤醒 | `account-startup-recovery-service.ts` | 先前最小复现 |
| S2 | 账户已满但目标 Conversation 无 active Task 时，队列上限判断可被绕过 | `control-kernel.ts` | 先前生产决策复现 |
| S3 | 取消释放槽后，同会话后继已被提升但未启动 | cancellation coordinator、scheduler repo | 先前释放/回调/周期路径复现 |
| S4 | 状态修复器在仍有 WorkUnit/lease 残留时释放槽 | `task-state-reconciler.ts` | 先前持久残留复现 |
| S5 | 调度 helper 未接生产，aging 不能保证跨优先级等待者不饥饿 | `task-scheduler.ts` | 静态核查，须生产路径测试 |
| S6 | blocked/parked 清理后释放与 Resume 重新准入需闭环 | execution runtime、account recovery | 待逐分支复现，不宣称全部已证实 |

修复坚持统一 residue reader、账户级 durable wakeup 和 Kernel 决策。Repository 只应用已授权的槽位/队列变化，不独立选择并启动后继。Account admission 与已准入 Task 内 Attempt 调度是两层约束。

清理完成不能仅看 Task 终态；仍运行的 WorkUnit、lease、未决 dispatch/application 必须留在恢复事实中。禁止直接 SQL 改成成功或终态来掩盖不确定副作用。任何恢复必须沿现有 Kernel 授权路径。

外部账单提交失败不得回退 Task 成功状态，也不得因此重新执行任务。任务运行、统计完整性、账单外部确认是独立生命周期。

## 4. 用量与成本采集

### 4.1 三个正交维度

| 维度 | 候选值 | 规则 |
| --- | --- | --- |
| stage | `intake/context/planning/execution/verification/delivery` | 表达资源消耗发生在哪个业务阶段 |
| reason | `primary/retry/fallback/replan/compaction/merge_repair/system_probe` | 表达为什么发生；不与 stage 相加重复收费 |
| resource | `model_tokens/image/search/tool_request/compute/storage/network` | 不强行把所有资源折算成 token |

后台健康探测等无法归属于用户请求的成本进入 system 成本桶，不随机挂给最后活跃 Query。仅对接真实存在且能计量的资源；未计量项标明不支持，不虚构零成本。

### 4.2 来源与精度

| 来源 | 接入位置 | 不能做的推断 |
| --- | --- | --- |
| Planner usage、压缩等隐藏模型调用 | `planner-process-supervisor.ts`、Pi `core/agent-session.ts` | 不能只计最终回答 token |
| Codex/Pi Executor | `harness-driver.ts`、`codex-cli-driver.ts`、`pi-cli-driver.ts` | CLI 只报告 Turn 汇总时，不能伪装成逐次模型调用明细 |
| 图片服务 | `image-api-client.ts`、`image-api-runner.ts` | 无计数或金额字段不能凭输出文件数推定供应商收费 |
| 工具与执行资源 | 现有工具、Attempt、resource adapter seam | 排队/等权限时间不自动等于计算资源占用 |

每项 observation 至少携带：稳定事件 ID、source ID、Query/执行段关联、source scope、调用或 allocation ID、stage/reason/resource、计量单位、原始计数、采集时间、Provider/模型绑定版本、payer、完整性和证据引用。

`sourceScope = model_request | harness_turn | attempt | resource_allocation`。同一覆盖范围选一个权威计量层级，父级汇总与子级明细不能叠加。只具备 Turn 汇总时展示该粒度；无法确定 stage 时允许 `null` 并展示“阶段未细分”，不任意拆成看似精确的数字。

### 4.3 去重与缺失处理

- 区分 delta 和 cumulative snapshot。累计值按同一计量周期/调用的有序快照计算，不把每个累计值都追加；计数器重置必须有新 scope。
- 同一次调用的事件重放不重复计量；真正的 retry/fallback 是新调用，即使输入相同也有独立成本。
- cache read/write、reasoning token 是否属于 input/output 子集由 adapter 规范化；保留安全原始计数和规则版本，禁止总量与子集重复收费。
- 质量标记使用 `reported/estimated/unavailable`，同时记录 coverage 和 missing count。缺少 usage 不是 0 token、0 元。
- 估算允许用于进度展示与影子统计。默认不能作为最终收费依据；若采用执行资源标准计价，须有明确价格规则和可核实的资源数量。
- 输入内容、模型猜测的价格、工具返回的任意“账单”不能成为可信计量证据。

### 4.4 保留自定义 Provider 的付款方处理

付款方必须来自可信服务端配置或可核实凭据关系，不由模型名、Provider 显示名称或客户端自报决定：

| payer | 成本统计 | MetaWork 模型收费基数 |
| --- | --- | --- |
| `platform` | 记录平台采购参考及对账成本 | 符合费用政策的部分纳入 |
| `user_direct` | 可展示外部自付的参考成本，明确非平台支出 | 不再次收取用户已直接支付的模型费用 |
| `system` | 记录后台公共成本 | 不任意分摊到当前 Query |
| `unknown` | 保留用量，等待付款方核实 | 不自动纳入最终收费 |

用户自付模型时，MetaWork 实际提供的执行资源仍可单独按已发布规则计费。本期不通过限制 Provider 来简化归因；缺少价格也不能破坏原有 Provider 的运行能力，但不能把缺失账单当完整账单导出扣款。

## 5. 定价、金额与账单终结

### 5.1 核算层次

必须分别存储：观测用量、参考成本、核实的实际成本、可收费成本基数、应计 MetaCoin、第三方已确认扣款。实际成本未知时显示待核对，不能以参考值冒充供应商最终账单。

每个 Query 固定 `priceBookVersion`、付款方配置及费用政策版本；所有自动重试沿用该请求的版本。新 Query 使用当时生效版本。与既有 generation 配置绑定分别存储，不覆盖原 Provider/Executor binding。

```text
BillableBase(Q) = 合格的平台模型参考成本
                + 合格的工具参考成本
                + 按已发布规则计价的执行资源成本
AssessedMetaCoin(Q) = round_once(BillableBase(Q) × (1 + markup))
TaskAssessedTotal(T) = SUM(归属 T 的 finalized Query 应计金额)
```

平台实际成本不直接等于收费基数。平台缺陷造成的重复执行、内部修复浪费不转嫁用户；正常授权尝试和恢复产生的费用按固定政策处理。责任不明先待核对，不能默认是用户责任。用户取消不抹去已经发生的合格费用，未启动的部分不收费。

例如：正常可收费成本 1 元，平台缺陷另耗 0.2 元，加价率 40%，应计 1.4 MetaCoin；核实实际支出为 1.2 元。未收到第三方成功回执前展示“应计 1.4，扣款未确认”，不显示“已扣 1.4”。

CPU、内存、容器时长等价格须声明包含关系，不能既按整包执行资源收费又重复收包内 CPU。共享进程无法可靠分配的费用本期列作系统成本，不伪造 Query 精度。

### 5.2 精度

- `1 MetaCoin = 1,000,000 microCoin`；`1 CNY = 1,000,000,000 nanoCny`。
- 数量乘单价保留精确有理数直至 Query 汇总；nanoCny 仍不足表达的分数不得在逐事件处理中截断。
- 只在 Query 最终金额处按 half-even 舍入为整数 microCoin。以下函数适用于已经精确表示为整数 nanoCny 的基数；一般有理数路径保留分母。
- 阶段金额展示以最终单分配，采用确定性的最大余数法及稳定 ID 排序，使明细之和等于总额；不逐行重新加价舍入。
- 所有跨进程大整数以十进制字符串传输，不经浮点 `number` 中转。

```ts
export function roundHalfEven(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error('invalid_amount');
  const q = n / d;
  const r = n % d;
  return q + (r * 2n > d || (r * 2n === d && q % 2n !== 0n) ? 1n : 0n);
}

export function assessMicroCoin(costNanoCny: bigint, markupBps: bigint): bigint {
  if (markupBps < 3000n || markupBps > 5000n) throw new Error('invalid_markup');
  return roundHalfEven(costNanoCny * (10000n + markupBps), 10000000n);
}
```

必测：1 元基数在 3000/4000/5000 bps 下分别为 1,300,000/1,400,000/1,500,000 microCoin；`5/2 -> 2`、`7/2 -> 4`；负数、零分母及超范围加价拒绝。零费用合法。

第三方必须明确支持相同金额精度。若只能按分扣款，不得把每个微小 Query 向上取整为一分钱；此时先停留 shadow，另行明确精确累计结算协议后再启用 export。

### 5.3 最终单与外部状态分离

```text
本地账单：collecting -> pending_reconciliation -> finalized
外部提交：not_exported -> pending -> received -> confirmed
                         |          |
                         +----------+-> unknown / rejected
```

以上是概念状态；`unknown` 可通过原键查询回到 `received/confirmed/rejected`，不是重新创建账单。`received` 只表示外部接收，不能解释为已扣款。

MVP **每个 Query 最终单只提交一次消费意图**。执行中可实时累计本地展示，但不把每次累计快照都发送成扣款。重传最终单是同一意图的幂等重试，不是分段扣费。

终结条件：本次请求/执行段已经结束，不再有属于它的活跃或不确定资源调用，归因已确定，费用相关观察与价格/付款方已齐备；否则停留待核对。不能仅凭 Turn 完成或 Task 终态结账。

长任务等待权限而仍属于同一段时继续收集；失败/取消/park 后满足无残留条件可终结该段，后续显式 Resume 是新 Query。自动恢复仍使用原段时，原 Query 不应提前最终化。

缺失项可经有审计记录的平台承担决定从收费基数排除后出最终单，但保留 `coverage=incomplete` 和缺失原因。不得为了出单把未知成本填成零；零费用单本地保留，默认无需向第三方请求扣款。

最终单不可变。迟到的实际采购成本用于内部对账和利润分析，不自动向用户追加扣款。需要纠错时建立引用原账单的 adjustment 记录，通过独立外部流程处理；不在 MetaWork 内实现退款或修改原单抹掉历史。

## 6. 第三方消费接口

### 6.1 账户与接口契约

区分 `runtimeAccountId`、`actorPrincipalId` 与 `externalAccountRef`。后者由可信安装/服务端配置绑定，Query 接受时固定；不允许客户端请求体选择任意被扣款账户。缺少绑定仍可 observe/shadow，不允许 export。

```ts
export interface ConsumptionBill {
  sourceSystem: 'metawork';
  sourceInstanceId: string;
  externalAccountRef: string;
  billId: string;
  queryId: string;
  taskId: string | null;
  version: 1;
  amountMicroCoin: string;
  priceBookVersion: string;
  digest: string;
}

export interface ConsumptionResult {
  billId: string;
  digest: string;
  state: 'received' | 'applied' | 'rejected' | 'unknown';
  externalEntryId?: string;
  appliedAmountMicroCoin?: string;
  reason?: string;
}

export interface ExternalConsumptionPort {
  submitBill(bill: ConsumptionBill): Promise<ConsumptionResult>;
  getBillStatus(key: {
    sourceInstanceId: string;
    billId: string;
  }): Promise<ConsumptionResult>;
}
```

这是 MetaWork 的领域端口，不假设某第三方已经具备同名 HTTP API。Adapter 转换具体协议；`applied` 必须有外部流水标识及与提交额完全匹配的金额，类型实现应收紧为判别联合。所有结果须验证来源、账户作用域、账单键及 digest。

### 6.2 交付保证

1. 最终账单和 `consumption_outbox` 在同一数据库事务内创建。
2. `sourceInstanceId + billId` 为稳定幂等键；规范化 payload 的 digest 覆盖账户、币种/单位、金额、版本和归因字段，不包含 digest 自身。
3. 相同键相同 payload 可重传；同键不同金额或账户必须冲突，不能覆盖外部记录。
4. 网络超时视为 unknown，先以原键查询；不生成新 billId、不直接认定未扣款。
5. 外部仅确认收到时记录 received；HTTP 200 不足以记 confirmed。成功回执须核对实际金额。
6. 明确业务拒绝（含资金不足）保存原因，不重新执行 Task，不循环换键提交。网络故障按有界退避恢复。
7. 回执及重放幂等，乱序旧结果不得把 confirmed 降回 unknown；金额不一致进入人工核对。

实际是“至少一次交付 + 第三方持久幂等应用”，不是靠 MetaWork 本地去重宣称跨系统恰好一次。第三方不支持稳定幂等和状态查询时，只允许本地账单/影子运行，不开放生产消费提交。

`sourceInstanceId` 持久保存，备份恢复不重建；克隆安装不得和原实例同时作为独立发送者。迁移需保持账单键、outbox 和回执一致。

本期默认通过主动查询完成对账，不要求建设外部 webhook。必要的费用调整通知可用引用原单的独立幂等键，或人工外部处理；没有本地退款执行器。

外发只包含必要身份、用量摘要与金额，不发送 prompt、隐藏推理、Provider Key 或保密采购合同价。凭据放现有 SecretStore；不允许 Executor 读取消费接口凭据。

## 7. 模块与存储

### 7.1 所有权

| 模块 | 本期新增职责 | 禁止越界 |
| --- | --- | --- |
| `src/metering/` | Query context、观察规范化、覆盖率与去重契约 | 不决定任务调度，不操作钱包 |
| `src/billing/` | 定价、费用政策、最终单、汇总、外部消费应用端口 | 不创建 Task，不执行支付或退款 |
| `src/integrations/` | 第三方端口的协议适配 | 不重新解释成本或擅改账单 |
| `src/storage/` | 上述模块定义的持久化 port 的 SQLite 实现 | 不成为收费/恢复政策中心 |
| Session/Account composition | 注入服务，传递持久关联及授权事实 | 不新增语义分流或第二调度器 |
| Gateway/三端 | 只读账单投影与安全事件 | 不计算权威价格或直接写数据库 |

保持 ADR-0020 依赖方向。Kernel 不依赖 billing/外部账单服务；费用采集不能赋予 Planner 存储或执行权限。

### 7.2 最小持久模型

复用现有 Server SQLite 和迁移流程，不新建 Commerce 数据库或资金账本。

| 建议表 | 主要事实与约束 |
| --- | --- |
| `query_usage_contexts` | Query、账户、request/Turn、固定价格和付款方版本；请求作用域幂等键唯一 |
| `query_task_links` | Query 到唯一费用 Task 的权威关联和依据；无 Task 不伪造外键 |
| `execution_usage_contexts` | segment/run/generation/attempt 到 Query 的持久映射 |
| `metering_spans` | 可能收费的调用 scope、父子覆盖、started/closed/uncertain |
| `usage_observations` | source/event 唯一，安全原始计量及 normalized 数量、质量 |
| `cost_entries` | observation 对应参考/实际成本、payer、eligible/absorbed/pending、证据 |
| `billing_price_versions` | 不可变价格、币种与汇率规则、markup、费用政策版本 |
| `query_bills` / `query_bill_lines` | 每 Query 一个最终原单，整数总额与精确依据、完整性 |
| `consumption_outbox` / `consumption_receipts` | 唯一账单提交键、不可变 payload、尝试和外部结果 |
| `bill_adjustments` | 原单引用、原因、授权记录及外部处理结果，不覆写原账单 |

新表的具体 schema 版本在实施时从当前迁移头递增，不预占过期版本号。金额用有约束的十进制文本，涉及聚合在精确金额层完成，不能用 SQLite 浮点 `SUM` 偷换精度。外键、唯一性、append-only 约束及 migration/reopen 在 Docker 中一起验收。

### 7.3 故障与可信性

可能收费的调用前先保存归因和 span。启动后崩溃，从可信既有调用记录/供应商记录补 usage；无法判定则标 unknown，不能为了恢复统计重新执行业务调用。输入尚未获得持久接收的故障沿现有请求契约返回，不借本期全面重写 mailbox。

数据库/计量存储不可写时，禁止静默继续开启新的可收费调用；已在途调用尽力保留恢复证据并标缺失。此为计量完整性故障处理，不是余额控制，也不新增 Runtime 自行重试政策。

当前 native 执行权限较广：**客户端或 Executor 能改写的本地统计不构成防篡改扣款凭据**。export 必须部署在可信服务端，并验证账单数据、计量来源和消费凭据不受不可信工作代码控制，或有独立可信用量源可核对；否则只开 observe/shadow。不能把“本地账单表建好了”宣称为商业安全隔离完成。

本期只验证并配置已有部署/权限边界，不隐含新增一套沙箱平台；不满足可信条件时阻断 export 而非降低门槛。

## 8. 三端展示与兼容

新增可选能力 `usage_billing_v1`。通过统一 Gateway 应用查询端口提供 `get_query_bill`、`get_task_usage_summary`、`list_query_bills`、`get_usage_summary`，身份授权与分页限制沿用现有机制。

- Web：Turn 下显示 Query 应计金额、阶段明细和完整性；Task 视图展示跨 Query 汇总。
- TUI：同一 Server 投影显示用量摘要，Task Dashboard 只投影 Task 汇总，不本地计算金额。
- Feishu：终结时显示简洁费用摘要，待核对和扣款未确认必须明确；避免每次 token 更新都推消息。
- 三端均区分“应计”“第三方已确认扣款”“待核对”“非平台支付成本”。不展示虚构余额，不添加充值或 Provider 限制入口。

Taskless Query 也能查到账单。进行中金额为暂计，不伪装最终单；零用量、用量缺失、外部待确认是三种不同状态。

能力协商、客户端未知字段处理及协议镜像一起测试；旧客户端保持原任务交互。继续遵守 origin-scoped live events，重连通过授权历史/只读查询补账单；不能广播其他连接的详细 Turn 消息。迟到账单不得将 terminal Turn 改回 running。

统计按 Query 接受时间、账单最终化时间、外部确认时间分别定义过滤字段；账户汇总不相加“Query 明细 + Task 汇总”两套数据。默认不向普通客户端暴露采购折扣、敏感成本证据或外部账户凭据。

## 9. 详细实施任务

以下 11 项是实施工作包，每项按所列顺序拆成小改动。新增文件为建议路径，修改文件为现有入口；执行前核对工作区并保留用户改动。每个用例先运行确认失败，再实现最小修改，最后运行相同命令确认通过。本文不授权自动提交；如后续要求提交，只提交该工作包经过验证的改动。

### Task 1: 固定架构、范围与测试契约

**文件：**新增 `docs/adr/0042-query-usage-billing-and-external-consumption.md`（实施时确认编号空闲）；修改 `docs/adr/README.md`、`CONTEXT.md`、`docs/current/technical-overview.md`、`docs/current/technical-overview.zh-CN.md`。

1. 草拟 ADR，写明 Query 非 Task、计量/账单/外部资金职责、付款方、只读客户端、可信导出门禁及无预算准入。
2. 把第 2～8 节不变量转为后续测试清单，逐项指定唯一 owner。
3. 评审通过后再更新架构权威文档；尚未实现内容明确标为目标，不写成 current capability。
4. 运行 `git diff --check`，核对本地链接与 ADR 编号，确认未引入 wallet/payment/provider restriction 的实施义务。

**验收：**计量、账单不侵入 Kernel 政策；不存在第二资金账户事实源；本期与延期范围不矛盾。

### Task 2: 清理栅栏与取消后继衔接（S1/S3/S4）

**文件：**新增 `src/execution/task-residue-reader.ts`；修改 `src/execution/task-state-reconciler.ts`、`src/execution/task-cancellation-coordinator.ts`、`src/execution/kernel-execution-runtime.ts`、`src/account/account-startup-recovery-service.ts`、`src/account/account-runtime-composition.ts`，必要时调整 `src/index.ts` 装配；新增 `tests/execution/task-slot-cleanup-fence.test.ts`、`tests/account/account-task-scheduling-lifecycle.test.ts`。

1. 写失败测试：terminal Task 仍有 WorkUnit/lease/uncertain dispatch 时不能释放槽；取消完成后产生可恢复的账户唤醒；重复取消和重复回调无重复启动。
2. 运行 `npm test -- tests/execution/task-slot-cleanup-fence.test.ts tests/account/account-task-scheduling-lifecycle.test.ts`，确认覆盖旧缺陷而非只测 mock。
3. 实现统一 residue reader，去除仅按 Task 终态释放的捷径；Account 通过既有 durable workflow 交付唤醒，不自行选择后继。
4. 同命令通过后运行 `npm test -- tests/execution/task-cancellation-coordinator.test.ts tests/execution/task-state-reconciler.test.ts tests/execution/cancellation-trace.test.ts`。

**验收：**清理未完成绝不重叠占槽；Task 2 与 Task 3 联合发布，不留下“已 reserved 但无启动者”的中间生产状态。

### Task 3: 账户队列、公平性与重启恢复（S2/S5/S6）

**文件：**修改 `src/kernel/control-kernel.ts`、`src/kernel/task-scheduler.ts`、`src/kernel/kernel-workflow.ts`、`src/account/account-kernel-coordinator.ts`、`src/account/account-startup-recovery-service.ts`、`src/storage/conversation-task-scheduler-repo.ts`、`src/execution/attempt-supervisor.ts`；扩展 `tests/kernel/control-kernel.test.ts`、`tests/kernel/task-scheduler.test.ts`、`tests/account/account-task-scheduling-lifecycle.test.ts`，新增 `tests/account/account-scheduler-restart.test.ts`。

1. 写失败测试：无 active Task 的 Conversation 不能绕过 queue=8；A/B 占满后 C 能在释放时启动；关闭全部客户端仍能启动；唤醒持久化后重启不丢失。
2. 增加 blocked/parked 无残留释放、有残留不释放、显式 Resume 重新准入及公平 aging 用例；用明确上界断言低优先级不会无限饥饿。
3. 运行 `npm test -- tests/kernel/control-kernel.test.ts tests/kernel/task-scheduler.test.ts tests/account/account-scheduler-restart.test.ts tests/account/account-task-scheduling-lifecycle.test.ts`。
4. 接通生产 Kernel 的统一选择政策；Snapshot 带入时间/容量事实，Repository 只落授权结果；保留 Task 和 Attempt 各自上限。
5. 重跑上述测试及 `npm test -- tests/account/account-startup-recovery-service.test.ts tests/execution/attempt-supervisor.test.ts`。

**验收：**跨会话唤醒、取消后继、重启、清理栅栏、上限和公平性通过同一生产路径，不靠额外后台调度器补丁。

### Task 4: 持久 Query 归因与执行段

**文件：**新增 `src/metering/contracts.ts`、`src/metering/ports.ts`、`src/metering/query-context-service.ts`、`src/storage/query-usage-context-repo.ts`、`src/storage/execution-usage-context-repo.ts`；修改 `src/gateway/conversation-gateway-runtime.ts`、`src/session/conversation-session.ts`、`src/session/session-kernel-runtime.ts`、`src/session/session-task-execution-application-service.ts`、`src/execution/kernel-execution-runtime.ts`、`src/storage/migrations.ts`；新增 `tests/session/query-usage-attribution.test.ts`。

1. 写表驱动测试覆盖第 2.2 节，重点是无 Task 澄清、规划失败、已有 Task 的 no_op、自动重试、手动 Resume、权限批准及请求重传。
2. 增加 interleaving 用例：A/B Query 并发、切换 UI、旧段迟到 usage 与新段 Resume、Task 创建后关联应用崩溃。
3. 运行 `npm test -- tests/session/query-usage-attribution.test.ts`，确认缺失功能失败。
4. 在首个收费调用前持久化关联，沿授权应用补 Task link；恢复读取持久事实，不读取“当前 Task”。修正无 Task 的澄清展示文案。
5. 重跑新测试及 `npm test -- tests/session/conversation-session.test.ts tests/session/session-kernel-runtime.test.ts tests/session/planning-kernel-path.test.ts`。

**验收：**Query 不改变 Task 创建时机；一条 observation 只有一个收费归属；零用量控制操作不凭空收费。

### Task 5: 采集、去重与覆盖率

**文件：**新增 `src/metering/usage-service.ts`、`src/metering/usage-normalizer.ts`、`src/metering/coverage-projector.ts`、`src/storage/metering-span-repo.ts`、`src/storage/usage-observation-repo.ts`；修改 `src/planning/planner-process-supervisor.ts`、`src/executor/harness-driver.ts`、`src/executor/codex-cli-driver.ts`、`src/executor/pi-cli-driver.ts`、`src/executor/image-api-client.ts`、`src/executor/image-api-runner.ts`，按需修改 `planner/AnyFusion-Pi/packages/coding-agent/src/core/agent-session.ts` 的受控 usage 输出；新增 `tests/metering/usage-normalization.test.ts`、`tests/metering/usage-coverage.test.ts`。

1. 先用真实格式的脱敏 fixture 测 delta/cumulative、重复、乱序、计数重置、缓存/reasoning 子集、父子重复、缺失 usage。
2. 运行 `npm test -- tests/metering/usage-normalization.test.ts tests/metering/usage-coverage.test.ts`。
3. 接入各 adapter 的实际可用粒度；补齐 Planner 压缩等隐藏调用；无法逐请求展开的 CLI 保留 harness_turn 粒度和明确 coverage。
4. 记录 source event 唯一键、span 结束或不确定事实；不从展示事件/历史 replay 再次记账。
5. 重跑测试，另验证两任务并发的成本隔离、取消后迟到事件、调用发生但最终 usage 丢失的故障。

**验收：**缺失不是零、重放不是新调用；工具内容不能伪造 trusted usage；计量异常不触发业务重执行。

### Task 6: 精确价格与付款方政策

**文件：**新增 `src/billing/money.ts`、`src/billing/pricing.ts`、`src/billing/cost-policy.ts`、`src/billing/ports.ts`、`src/storage/billing-price-repo.ts`、`src/storage/cost-entry-repo.ts`；新增 `tests/billing/money.test.ts`、`tests/billing/pricing.test.ts`、`tests/billing/payer-policy.test.ts`。

1. 编写第 5.2 节数值断言，扩展极小分数、大金额、JSON 往返、混合 cache 价格和阶段分配总和。
2. 写平台付款、用户自付、未知付款方、平台故障吸收、未配置价格、Query 中途改价的失败用例。
3. 运行 `npm test -- tests/billing/money.test.ts tests/billing/pricing.test.ts tests/billing/payer-policy.test.ts`。
4. 实现不可变价格版本和精确核算；汇率若需要，固定来源、币种、生效版本，不用运行时随机行情重算历史。
5. 重跑测试并验证 user_direct 的模型部分不进入平台收费基数，缺价格不阻止既有 Provider 工作但阻断不完整单 export。

**验收：**同一事实及版本得同一金额；可解释实际成本与应计的差异；无任何钱包或余额 API。

### Task 7: 最终账单、Task 汇总与调整

**文件：**新增 `src/billing/query-bill-service.ts`、`src/billing/bill-query-service.ts`、`src/billing/bill-adjustment-service.ts`、`src/storage/query-bill-repo.ts`、`src/storage/bill-adjustment-repo.ts`；新增 `tests/billing/query-bill.test.ts`、`tests/billing/task-bill-rollup.test.ts`、`tests/billing/bill-finality.test.ts`。

1. 写失败测试：无 Task Query 可出单；一个 Task 多 Query 不重扣；Turn 结束但 span 活跃不最终化；未知成本待核对。
2. 增加重复 finalize、平台承担缺失项、零费用、迟到成本、最终单不可变及精确阶段金额用例。
3. 运行 `npm test -- tests/billing/query-bill.test.ts tests/billing/task-bill-rollup.test.ts tests/billing/bill-finality.test.ts`。
4. 实现账单状态和汇总查询；实际成本修订单独记事实，调整引用原单，禁止自动补扣。
5. 重跑测试，验证 Task 汇总、账户汇总不会把相同 Query 或父子观察累计两次。

**验收：**客户端可明确区分暂计、最终应计和缺失；账单终结不等于 Task 终态，也不等于外部已扣款。

### Task 8: 外部消费与断点对账

**文件：**新增 `src/billing/external-consumption-port.ts`、`src/billing/consumption-export-service.ts`、`src/billing/consumption-reconciliation-service.ts`、`src/integrations/external-consumption-client.ts`、`src/storage/consumption-outbox-repo.ts`、`src/storage/consumption-receipt-repo.ts`；新增 `tests/billing/external-consumption-contract.test.ts`、`tests/billing/consumption-outbox-recovery.test.ts`。

1. 用 fake consumption server 写失败测试：已扣款后响应丢失、收到未应用、重复提交、同键异额、错账户、乱序结果、金额不符、明确拒绝和进程重启。
2. 运行 `npm test -- tests/billing/external-consumption-contract.test.ts tests/billing/consumption-outbox-recovery.test.ts`。
3. 实现最终单与 outbox 同事务，固定实例键/digest，超时查询原单，幂等回执；凭据只由可信 Server adapter 持有。
4. 实现停止新增发送的操作开关、对账查询和脱敏审计；不重试明确业务拒绝至无限循环。
5. 重跑测试，使用选定第三方的测试环境确认金额精度、幂等保持期限、状态查询和错误语义。

**验收：**同一 bill 最多有一笔被外部应用的消费；仅 received 不显示已扣款。第三方尚未选定可交付 port/fake，但 production export 保持关闭；本任务没有支付/退款沙箱开发。

### Task 9: Web、Feishu、TUI 一致投影

**文件：**修改 `src/gateway/client-protocol.ts`、`src/gateway/read-only-query-handler.ts`、`src/management/web-gateway-session-runtime.ts`、`src/gateway/feishu-runtime.ts`、`web/src/api/gateway-types.ts`、`web/src/components/ConversationTurn.tsx`；新增 `web/src/components/QueryBill.tsx`、`web/src/components/TaskUsageSummary.tsx`；修改 `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts` 及 `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/` 的 model/reducer/controller/Task Dashboard；新增 `tests/gateway/billing-protocol.test.ts`、`tests/web/query-bill.test.ts`、`tests/gateway/feishu-billing-projection.test.ts`、`planner/AnyFusion-Pi/packages/coding-agent/test/metawork-tui-billing.test.ts`。

1. 写失败测试覆盖 capability 缺失、无 Task 账单、pending/confirmed/unknown、重连、历史 Turn、非 origin 连接和金额字符串。
2. 运行 `npm test -- tests/gateway/billing-protocol.test.ts tests/web/query-bill.test.ts tests/gateway/feishu-billing-projection.test.ts`。
3. 接入统一只读账单服务，客户端只展示，保留当前 Task/权限/停止契约。
4. 重跑测试和 `npm test -- tests/gateway/gateway-protocol-mirror.test.ts`；执行 `npx --no-install tsc --noEmit -p web/tsconfig.json` 与 `npm run build --prefix web`。
5. 在 `planner/AnyFusion-Pi/packages/coding-agent` 运行 `npx --no-install vitest run test/metawork-tui-billing.test.ts`，在 vendored 根按现有流程运行 `npm run build:offline`。

**验收：**三端金额、质量和外部状态一致；无 Task 不报 Task-view 错误；旧客户端仍可工作；不存在客户端自行计价或重复发送消费。

### Task 10: 迁移、故障注入与端到端验收

**文件：**扩展 `src/storage/migrations.ts`、`tests/storage/migrations.test.ts`；新增 `tests/acceptance/query-billing-lifecycle.test.ts`、`tests/docker/billing-schema-and-recovery.test.ts`、`scripts/smoke-query-billing.mjs`；按需接入现有 `Dockerfile.test` 流程。

1. 写失败用例：旧库升级/WAL reopen、金额文本无损、唯一键冲突、运行中重启、最终单事务中断、外部应用后响应丢失、旧备份恢复。
2. 运行 `npm test -- tests/storage/migrations.test.ts tests/acceptance/query-billing-lifecycle.test.ts tests/docker/billing-schema-and-recovery.test.ts`。
3. 补齐 migration、恢复与 smoke；默认 fake Provider 和 fake consumption server，不消耗真实付费资源。
4. 执行 `node scripts/smoke-query-billing.mjs`；以独立命令运行 `docker build -f Dockerfile.test -t metaclaw-test .` 和 `docker run --rm metaclaw-test`。
5. 验收 Q1 澄清无 Task、Q2 创建 T1、多任务并发、取消、Q3 Resume T1、外部超时恢复的全链路，检查费用不丢、不重复、不串 Query。

**验收：**旧历史不追溯扣费、不清库迁移；SQLite 约束与 POSIX 运行链在容器通过；故障恢复不再次执行已完成业务。

### Task 11: 分阶段发布与运营说明

**文件：**新增 `docs/current/query-billing-operations.md`；更新本计划、`docs/README.md`、`CONTEXT.md`、两份 technical overview 和适用 ADR 的实际交付状态。

1. observe：只收集用量/coverage，与 adapter 原始事实对齐；记录每类 Harness 实际粒度。
2. shadow：生成账单但不发送消费；验证价格、付款方、阶段金额、平台承担和三端投影。
3. export：仅在信任边界、第三方幂等/查询、精度、账户绑定、价格版本及恢复验证全部通过后启用。
4. 演练关闭新增导出，确认计量、已有回执查询和对账继续运行；不删除 outbox，不轮换 billId。
5. 记录验证命令、真实结果、遗留限制、完成日期；只有实施完成并获授权提交后才填写关闭提交。

**验收：**没有“enforce 本地余额”的隐含阶段；外部不可用不改变 Task 结果，未完成结算明确可见；文档不把影子账单说成正式扣款。

## 10. 阶段与上线门禁

| 阶段 | 任务 | 可以交付 | 禁止宣称 |
| --- | --- | --- | --- |
| P0 | 1～3 | 架构契约及单用户多任务可靠性 | 已实现计费 |
| P1 | 4～6 | Query 用量、覆盖率与成本核算 | 每个 Harness 都有逐调用精度 |
| P2 | 7、9 | 本地账单、Task 汇总、三端展示 | 应计就是已扣款 |
| P3 | 8、10、11 | 幂等外部消费、恢复、生产门禁 | MetaWork 拥有钱包或保证无透支 |

外部联调可提前使用固定测试账单，但不可跳过最终单不变量上线。Task 2/3 是一个可靠性发布单元；计量表及恢复测试在各任务落地时同步实现，不拖到 Task 10 才补数据库约束。

上线必须有：每类资源采集能力矩阵、缺失/平台承担政策、生产价格版本、trusted payer/外部账户映射、第三方幂等及精度证据、可信部署检查、重启和重复投递测试、三端无回归记录。

## 11. 迁移、回滚与运营边界

- 历史 Task/Turn 无可靠 usage 时标记 historical unavailable，不推算并追溯收费。
- 升级前按既有原生更新机制备份；新版本从兼容 schema 迁移，不能用删表/清库完成切换。
- 回滚优先关闭 export，再回退到兼容新 schema 的版本；已发单及 receipt 不回滚删除。旧版本不识别新表时只可按已验证的兼容路径运行。
- 备份恢复必须先检查稳定实例标识和外部状态；禁止恢复旧库后生成新键重复收费。无法证明完整性时保持 export 关闭。
- 第三方停机或拒绝消费，费用仍可待处理；不承诺余额实时同步或余额不足自动停止。此产品约束必须对运营明确。
- 更改 Provider、价格、外部账户绑定只影响新 Query；旧账单继续使用固定身份和版本。
- 监控重点为 usage 缺失、待核对滞留、未导出积压、unknown 回执、幂等冲突、账额不一致，不以“最终单数量”替代正确性。

## 12. 验证记录与完成标准

实施阶段基线及回归命令：

```bash
npm run lint
npm test -- tests/kernel/control-kernel.test.ts tests/kernel/task-scheduler.test.ts tests/execution/attempt-supervisor.test.ts tests/execution/task-cancellation-coordinator.test.ts tests/execution/task-state-reconciler.test.ts tests/execution/cancellation-trace.test.ts tests/account/account-startup-recovery-service.test.ts
npm test -- tests/session/conversation-session.test.ts tests/session/session-kernel-runtime.test.ts tests/session/planning-kernel-path.test.ts
npx --no-install tsc --noEmit -p web/tsconfig.json
npm run build --prefix web
git diff --check
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

Pi 验证始终使用仓库内 `planner/AnyFusion-Pi` 的隔离依赖和 `build:offline`，不得调用全局 Pi 代替。真实模型及第三方生产调用需另行授权；默认测试不花费真实资源。

先前审核记录包含 13 文件/148 测试、11 文件/100 测试，以及 Query/Task 核查的 3 文件/65 测试通过；批次有重叠，不相加，也不是本版计费实现的验收结果。本轮文档定稿不重新运行运行时回归，不声称上述新建测试已存在或通过。

本轮文档验证（2026-09-21）：本方案、现状评估及索引相关章节的 44 个本地链接通过；Task 1～11 顺序与金额示例 10 项断言通过；文档空白和 `git diff --check` 通过，排除项未残留为实施任务。全量扫描索引另发现 5 个既有无关失效链接，不计入本次链接通过结论，也未扩展修改。运行代码、数据库、支付配置和服务进程均不修改。

最终实施完成必须证明：无 Task 费用不遗漏，多 Query/Task 不重复，三个客户端同源，未知费用不冒充零，外部未知不冒充已扣，平台自担和用户自付不错误收费，重启不重执业务，最终单跨系统幂等。否则只能声明相应阶段完成。

---

## 实施记录（2026-09-21，第一批）

- 版本与状态：**v2.2，代码目标已落地，未提交**。本记录描述本次实际落地的代码、测试和仍受发布门禁约束的外部 export；未通过或未执行的环境验证不写作已通过。
- 关闭提交：未创建提交（本计划不授权自动提交）。
- 操作说明：[Query Usage And Billing Operations](../current/query-billing-operations.md)。

### 已交付

| 任务 | 交付内容 | 主要文件 |
| --- | --- | --- |
| Task 1 | ADR-0042、ADR 索引、`CONTEXT.md` 目标契约与词汇、两份技术总览的目标章节 | `docs/adr/0042-query-usage-billing-and-external-consumption.md` 等 |
| Task 2（部分，S4） | 统一 residue reader；`task-state-reconciler` 不再仅按 Task 终态释放槽，且不再把 `cancelling`/`uncertain`/有后端证据的 dispatch 直接改成 `cancelled`；取消协调器复用同一 reader | `src/execution/task-residue-reader.ts`、`src/execution/task-state-reconciler.ts`、`src/execution/task-cancellation-coordinator.ts` |
| Task 4 | Query 归因服务与端口、SQLite 归因/执行段/任务关联持久化 | `src/metering/contracts.ts`、`ports.ts`、`query-context-service.ts`、`src/storage/query-usage-context-repo.ts` |
| Task 5（领域部分） | 用量规范化（delta/cumulative、重放、计数重置、子集、父子覆盖、缺失）与覆盖率投影 | `src/metering/usage-normalizer.ts`、`coverage-projector.ts`、`src/storage/metering-repo.ts` |
| Task 6 | 精确金额、不可变价格版本与汇率规则、付款方/费用政策 | `src/billing/money.ts`、`pricing.ts`、`cost-policy.ts` |
| Task 7 | 最终账单服务（终结条件、阶段最大余数分配、平台承担审计、Task/账户汇总、调整引用原单） | `src/billing/query-bill-service.ts`、`bill-query-service.ts`、`bill-adjustment-service.ts`、`src/storage/billing-repo.ts` |
| Task 8（端口与 fake） | `ExternalConsumptionPort`、digest 与回执校验、outbox 同事务创建、幂等导出与主动对账、HTTP 适配器与 fake server | `src/billing/consumption-contract.ts`、`consumption-export-service.ts`、`consumption-reconciliation-service.ts`、`src/integrations/external-consumption-client.ts`、`src/storage/consumption-outbox-repo.ts` |
| Task 10 | SQLite schema 40、38→39→40 事务迁移、WAL reopen、唯一键/外键约束、端到端验收用例 | `src/storage/billing-schema.ts`、`src/storage/migrations.ts`、`tests/acceptance/query-billing-lifecycle.test.ts` |
| Task 11（部分） | 发布阶段、能力矩阵、运营边界与回滚/备份规则 | `docs/current/query-billing-operations.md` |

### 发布门禁与限制

- Task 2/3：S1-S6 已接入 durable promotion/recovery、residue fence、取消释放和显式 Resume 路径；调度 repository 使用持久 priority、aging 和公平序列；未引入第二调度器。
- Task 5 适配器接线：Planner、Harness、Codex/Pi CLI 和本地执行适配器已接入统一 usage observer；无法报告的 Provider/resource 仍显式标记 unavailable，不填零。
- 外部 consumption export 未启用；第三方账户绑定、生产价格和精度证据齐备前只允许 observe/shadow。
- Task 10：schema 40、39→40 字段迁移、WAL reopen、唯一键/外键约束、fake external smoke 已验证；Docker 全量套件已尝试执行，但因基础镜像授权网络超时未获得结果。
- export 未启用：第三方账户绑定、生产价格和精度证据齐备前保持 observe/shadow；这不是本地钱包或余额控制。

### 环境限制记录（2026-09-22）

已执行 `docker build -f Dockerfile.test -t metaclaw-test .`，Docker Desktop 可用，但拉取 `node:22.19.0-bookworm-slim` 时访问 `auth.docker.io` 超时，故 Docker 迁移/重启/故障注入套件未获得结果，不能标记为通过。`npm run smoke:query-billing` 及本地 SQLite/Vitest 验证通过。

### 运行链路修复记录（2026-09-22）

- 修复任务型 Query 在 Planner/Kernel 返回后被会话 `finally` 提前结算的问题：已授权绑定 Task 的 Query 保留到 Task 终态，Planner/执行阶段的 usage span 和 observation 均可进入最终账单；无 Task 的澄清、失败和纯规划 Query 仍在当前请求结束时结算。
- Account Task terminal recovery 现在在 residue、publication、claim 和资源租约收束后，幂等结算该 Task 关联的全部 Query；账单异常不会改变 Task 的终态结果。
- Web 账单投影在 Task 终态相关 trace 事件及 `250ms/1s/3s/10s` 延迟刷新中重新读取服务端账单，历史回放继续使用同一只读投影，因此账单不会只依赖 Planner 回答完成时刻。
- 新增 server billing composition 回归测试，覆盖 Task 终态结算和执行 span 收束；该测试与 Web Gateway、Query attribution 回归共 46 个用例通过。

### 本批验证（实际执行）

```bash
npx tsc --noEmit                      # 通过
npx vitest run tests/billing tests/metering tests/session/query-usage-attribution.test.ts
npx vitest run tests/acceptance/query-billing-lifecycle.test.ts
npx vitest run tests/execution/task-slot-cleanup-fence.test.ts
npx vitest run tests/storage/migrations.test.ts tests/storage/runtime-database-opening.test.ts tests/architecture
npx vitest run tests/kernel tests/execution tests/account        # 56 文件 / 343 用例通过
npx vitest run tests/session/conversation-session.test.ts tests/session/session-kernel-runtime.test.ts tests/session/planning-kernel-path.test.ts
git diff --check                      # 通过
```

新增测试文件：`tests/billing/{money,pricing,payer-policy,query-bill,task-bill-rollup,bill-finality,external-consumption-contract,consumption-outbox-recovery}.test.ts`、`tests/metering/{usage-normalization,usage-coverage}.test.ts`、`tests/session/query-usage-attribution.test.ts`、`tests/execution/task-slot-cleanup-fence.test.ts`、`tests/acceptance/query-billing-lifecycle.test.ts`、`tests/billing/harness.ts`。

### 后续必须完成才可声明完成

按计划 §12，代码侧目标已完成：适配器统一 usage observer、三端只读同源投影、账户调度可靠性闭环和本地 fake/SQLite 验收均已落地。仍不具备发布条件的事项是外部 export 的可信部署门禁，以及 Docker 全量验收的实际结果；这些不能由本地单元测试替代。
