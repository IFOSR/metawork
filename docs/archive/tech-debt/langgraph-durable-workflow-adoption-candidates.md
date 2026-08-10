# LangGraph durable workflow 引入候选

> 状态：已关闭——Phase 4 门控 spike 未达到采用标准，不引入 LangGraph
> 关闭日期：2026-07-21
> 创建日期：2026-07-21
> 最佳引入阶段：Phase 4 后半段；不得早于 failure/apply persistence 契约冻结
> 关联路线图：[Planner、Kernel 与并发调度收敛路线图](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
> 关联 ADR：[ADR-0020](../../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0022](../../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)、[ADR-0023](../../adr/0023-durable-kernel-workflow-recovery-and-availability.md)
> 用途：只登记满足本文三项硬门槛、可由 LangGraph 明显降低维护复杂度的 workflow implementation；不授权直接引入依赖或改写 Kernel。

## Phase 4 门控 spike 结论

结论为**不采用**。评估以已经冻结的 `KernelWorkflow`、SQLite v24 application/outbox 契约和官方 Functional API 恢复语义为边界，没有加入试验依赖或保留第二条生产路径。

- 当前 `DurableKernelWorkflow` 文件共 196 行，其中真正可能被 Functional API 替换的串行 drain/apply 区间约 60 行；其余是稳定公开 Interface、领域 application 状态和 ledger record 构造。
- `KernelWorkflowRepo` 共 257 行。它负责主库 inbox、Decision/application 原子 issuance、幂等键、人工恢复与 checkpoint 丢失后的事实重建；按 ADR-0023，这些代码即使采用 LangGraph 也必须保留。
- Functional API 恢复会从 entrypoint 起点重放，并复用已完成 task 的 checkpoint 结果；未完成 task 仍可能再次执行。因此 MetaClaw 的后置条件检查、application 状态与 outbox 幂等不能由 checkpointer 替代。
- 接入仍需新增独立 SQLite checkpointer 生命周期、`entrypoint/task` glue、thread 配置、checkpoint 损坏处理和双存储故障测试。可删除代码少于新增 glue，明显不满足“净减少至少 30%”门槛。
- 独立 checkpoint 会成为第二个 workflow cursor，而主库已经可以独立恢复；在当前串行控制面中，它增加一致性面而没有删除领域恢复知识。

因此 Phase 4 保留自研 `DurableKernelWorkflow` 作为唯一生产 implementation，删除旧 `KernelControlLoop`，不增加 `@langchain/langgraph` 或 checkpointer 依赖。Phase 6 也不得以“未来并发”重新打开该依赖；只有新的、可量化删除至少 30% 实现复杂度的独立证据，才允许新建 ADR 重新评估。

## 一、登记门槛

只有同时满足以下条件的部分才属于候选：

1. 使用 LangGraph 现成函数和持久化工具后，能够删除大量自研 workflow bookkeeping，而不是在现有实现外再包一层；
2. checkpoint、暂停恢复、执行历史和测试工具能够提高维护性，并把恢复知识集中在一个深 module 内；
3. 保持现有领域职责、公开 Interface、Decision ledger、Task/Subtask/attempt/WorkUnit 语义不变，可在现有 seam 上替换 implementation，不要求领域对象迁就 LangGraph state model。

以下情况不算“适合改写”：

- LangGraph 只是也能表达同一组 `if/switch`，但不能删除领域代码；
- 需要同时维护一套 LangGraph 状态机和一套 MetaClaw 状态机；
- 需要把 Kernel policy、Work Graph、lease 或 ledger 转译为 LangGraph 专用领域模型；
- 只为了可视化、流行度或未来可能并行而增加依赖；
- 用 checkpoint 代替 Decision ledger、outbox、幂等键或领域审计。

## 二、总体结论

`ControlKernel` **不适合**直接用 LangGraph 改写。它是纯确定性领域决策 module：

```text
decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision
```

LangGraph 的 `StateGraph`、conditional edges 和 `Command.goto` 负责 workflow navigation，不是领域授权。将 Kernel Decision 改成 graph edge 会把 policy 与 orchestration 再次混合，并扩大调用者需要理解的 Interface。

当前唯一值得评估的替换 seam 是：

```text
KernelEvent
  → durable workflow shell
  → build snapshot
  → ControlKernel.decide
  → kernel_decisions ledger
  → Runtime apply
  → normalized KernelEvent
```

LangGraph只能拥有“执行到哪里、何时暂停、从哪里恢复”的 workflow cursor；`ControlKernel` 继续拥有战略决策，`kernel_decisions` 继续是授权审计事实源，Runtime 继续拥有副作用。

## 三、符合条件的改写候选

### 3.1 Kernel durable application shell

**最佳引入阶段：Phase 4 后半段。**

建议评估以 LangGraph Functional API 的 `entrypoint`、`task` 和 durable checkpointer 替换 Phase 4 将要扩展的控制循环恢复 bookkeeping，而不是使用 `StateGraph` 重写领域流程。

拟改范围：

| 位置 | 改写目标 | 必须保留 |
| --- | --- | --- |
| `src/kernel/kernel-control-loop.ts` | 将同步 `decide → issue → apply → observe` 循环的 durable cursor、节点结果复用、暂停/恢复交给 Functional API implementation | `KernelEvent`、`KernelSnapshot`、`KernelDecision`、ledger-first 顺序、最大循环防线 |
| Phase 4 新增的 unapplied-decision recovery runner | 优先由 checkpointer/task result 管理“已完成步骤”和恢复位置，避免再造通用 workflow replay engine | outbox/apply status、幂等键、fail-closed 规则仍由 MetaClaw 定义 |
| `src/session/session-kernel-runtime.ts` 与 `src/session/session-execution-coordinator.ts` | 通过同一个 workflow Interface 启动或恢复一次控制运行；调用方不感知 LangGraph | Runtime handler、WorkUnit release、attempt landing 与 presentation 职责 |
| `src/session/metaclaw-session.ts` | 把新事件提交给 workflow，使用现有 session/correlation identity 作为 thread 配置 | Session 仍只负责 trigger 与 projection |
| Storage composition root | 使用官方 SQLite checkpointer Adapter，并与 MetaClaw transaction/connection 生命周期组合 | `KernelDecisionRepo` 不被 checkpointer 替代或双写 |

预期简化来源：

- checkpoint 和 task result 复用，减少自研 workflow cursor、恢复位置与重复步骤判断；
- Functional API 允许保留普通函数调用和现有类型，不要求把 `ControlKernel` 变成 graph nodes/edges；
- durable run history、state inspection 和 replay 测试集中在 workflow module 内；
- Phase 4 不需要自行实现一套通用的“从上一个安全步骤继续”的流程引擎。

为什么是 Phase 4 后半段：

1. Phase 4 前半段必须先冻结 failure taxonomy、Decision apply status、outbox、幂等键和 crash semantics；这些是领域契约，LangGraph不能替代。
2. 契约冻结后，LangGraph只替换 workflow implementation，能够保持 Interface 不变。
3. 若在契约前引入，checkpoint 很容易反向决定领域模型，产生双重事实源。
4. Phase 5 聚焦 partition/lease，届时再首次引入 workflow framework 会扩大风险面。

官方能力参考：

- [Functional API overview](https://docs.langchain.com/oss/javascript/langgraph/functional-api)
- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [JavaScript SQLite checkpointer](https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-checkpoint.html)

### 3.2 Clarification 与风险确认的 durable pause/resume

**最佳引入阶段：与 3.1 同批进入 Phase 4；不得作为独立引入理由。**

若 durable application shell 已采用 LangGraph，可用 `interrupt()` 与 `Command.resume` 承担以下通用 workflow 行为：

- `request_clarification` 发出问题后持久暂停；
- 高风险 confirmation 等待用户输入；
- 进程重启后继续同一 correlation/thread；
- 保留暂停点和恢复输入，便于审计与测试。

领域行为保持不变：Kernel 仍决定是否 `request_clarification`；LangGraph只暂停和恢复，不判断风险、不生成问题、不直接授权 Task/attempt。

拟改范围：

| 位置 | 改写目标 | 不得改变 |
| --- | --- | --- |
| Kernel workflow apply handler | 对 `request_clarification` 使用 durable interrupt，而不是自研 pending continuation | Decision action 与 ledger record |
| Session intake | 将后续用户输入作为对应 workflow 的 resume value | PlanningAgent 语义和 Session presentation |
| startup recovery | 从 checkpointer 恢复等待中的 workflow | orphan attempt、Task/Subtask recovery 仍走 Kernel |

该能力单独引入 LangGraph不满足“显著简化”门槛；只有 3.1 已采用、无需增加第二套运行框架时才成立。

官方能力参考：[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。

## 四、当前不符合门槛的部分

| 部分 | 不改写原因 | 归属阶段 |
| --- | --- | --- |
| `ControlKernel.decide` 与内部 decision matrix | conditional edges 不能减少领域规则，只会把纯函数拆散为 graph topology | 保持自研 |
| `kernel_decisions` ledger | LangGraph checkpoint 是 workflow snapshot，不是业务授权审计；两者不可互换 | Phase 4 继续增强 |
| failure taxonomy、retry/fallback/backoff/circuit policy | LangGraph retry 是执行机制，不能拥有 MetaClaw 战略政策，否则绕过 Kernel | Phase 4 自研领域 policy |
| Work Graph 校验、ready frontier 与 handoff | 已有稳定领域图；转译为 StateGraph 会形成第二套拓扑事实 | 保持现有 Work Graph |
| WorkUnit claim、partition、lease、heartbeat、冲突检测 | LangGraph不提供 MetaClaw 的资源所有权和写冲突模型 | Phase 5 自研 |
| response-only contract correction | 是受限 Adapter profile 和领域授权，不是通用 workflow graph | 保持现有 implementation |
| Executor attempt runner | 已是一个深 module；包装为 subgraph 不会删除执行、receipt、handoff、release 复杂度 | 保持现有 implementation |
| Phase 6 runnable frontier 并发 | `Send`/parallel super-step 只能提供执行机制，无法替代 fairness、partition lease、取消传播和确定性合并 | 不作为首次引入理由 |

## 五、Phase 6 的条件性复用

若 LangGraph 已在 Phase 4 通过下述验收并成为唯一 durable workflow implementation，Phase 6 可以评估复用其 per-invocation subgraph、`Send` 或 parallel super-step 来承载 Kernel 已授权的并发 attempt 集合。

这不是独立迁移项：

- Kernel 仍产出允许并发的授权集合；
- partition/lease 仍在 dispatch 前强制；
- LangGraph只并行执行已授权 handlers；
- 若 Phase 4 未采用 LangGraph，Phase 6 不应仅为并发调度临时引入。

官方能力参考：[Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) 与 [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api)。

## 六、正式引入验收门

Phase 4 spike 只有同时满足以下条件才能转为生产依赖：

1. `ControlKernel`、Kernel contracts、Runtime apply Interface 和领域 Repository 无需增加 LangGraph 专用字段；
2. `kernel_decisions` 仍是唯一授权账本，checkpointer 只保存 workflow cursor；
3. 删除的自研 durable workflow/recovery 代码明显多于新增 glue code，目标是该部分 implementation 复杂度至少下降 30%；
4. 不保留旧 `KernelControlLoop` durable path 与 LangGraph path 双实现；测试在同一 seam 上替换；
5. ledger-before-apply、apply-before-checkpoint、node failure、进程崩溃、重复 resume 和重复 event 的故障注入全部通过；
6. 所有副作用仍具有 MetaClaw 幂等键；不得因为使用 checkpointer 而假设 exactly-once；
7. 本地 SQLite、Docker/Linux、真实 Planner→Kernel→Runtime→Executor smoke 均通过；
8. 不要求引入 LangChain model/agent abstraction；依赖范围只覆盖 LangGraph workflow 与所选 checkpointer。

若任一条件不成立，则关闭该技术债并继续使用自研 `KernelControlLoop`；不得留下试验性兼容层。

## 七、实施顺序建议

```text
Phase 4 前半
  冻结 failure taxonomy / apply status / outbox / idempotency
    ↓
Phase 4 中后段
  用 Functional API 做受控 spike
    ↓
  比较代码删除量、crash matrix、测试复杂度和双状态风险
    ↓
  达标：替换 durable workflow implementation
  未达标：删除 spike，保留自研 loop
    ↓
Phase 5
  不扩大 LangGraph 职责，专注 partition/lease
    ↓
Phase 6
  仅在 Phase 4 已采用时复用并行 workflow primitives
```

因此，最佳首次引入窗口是 **Phase 4 后半段**，不是 Phase 3 收尾、Phase 5 或 Phase 6。
