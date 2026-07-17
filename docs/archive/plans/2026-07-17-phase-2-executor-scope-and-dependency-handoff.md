# Phase 2：Executor 执行范围与 Dependency Handoff 总体行动计划

## 计划状态

- **计划日期**：2026-07-17
- **当前状态**：已完成并归档
- **所属路线图**：[`2026-07-16-planner-kernel-concurrency-convergence-roadmap.md`](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- **对应阶段**：Phase 2——Executor 执行范围与 dependency handoff
- **架构设计门**：[`ADR-0020：核心模块归属与依赖方向`](../../adr/0020-core-module-ownership-and-dependency-direction.md)
- **完成日期**：2026-07-17
- **实现提交**：`9783518`、`1472a3c`

本计划规定 Phase 2 的目标、改动范围、模块所有权、依赖边界、实施原则、验收标准与完成门槛。最终数据结构、公开接口、预算、迁移顺序和测试矩阵已在[详细实施计划](2026-07-17-phase-2-executor-scope-and-handoff-detailed-implementation-plan.md)及 [ADR-0021](../../adr/0021-work-graph-v4-subtask-execution-contract.md)冻结。

计划完成时必须回填实际交付行为、最终接口与迁移结果、验证命令及结果、相关文档更新、实现提交和收尾提交。

## 一、阶段目标

让每次 Executor 调用只执行当前已授权 Subtask：顶层 Task 目标只提供背景和最终方向，当前 Subtask 的 goal、acceptance 与 expected output 构成本次唯一工作范围；已完成依赖只通过受控、必要、可审计的 handoff 向下游传递；未调度 sibling 明确属于本次范围之外。

Phase 2 必须在现有串行 Runtime 上独立关闭“一个 Executor 可完成的工作被多次调用、重复完成 sibling 或重复产生产物”的问题，不依赖未来 Kernel 控制面、partition 或并发实现。

## 二、当前代码基线与问题边界

截至计划日期，Phase 1 已交付严格 v3 工作图、共享结构验证、canonical capability 授权和串行 DAG 消费。当前执行链已经具备以下基础：

- `SessionExecutionCoordinator` 按 `dependsOn` 选择一个 ready Subtask，并在执行前 claim 一个具体 Executor WorkUnit，成功或失败后 release。
- `SubtaskExecutionSpec` 已携带当前 Subtask、WorkUnit、AgentClass、acceptance 和 expected output；`ExecutionRuntime` 每次只调用一个已 claim 的 Adapter，不再实现跨 Executor fallback 或工作图编排。
- v3 Subtask 已持久化 `dependsOn`、`acceptance`、`expectedOutput` 和执行结果，可作为受控 handoff 的事实基础。
- 现有 claim/release 事件记录 Task、Subtask 与 WorkUnit 绑定，已有异常、取消和心跳丢失回归测试。

但当前上下文路径仍以 Task 为中心：

- `MemoryContextService.prepareExecutionContext` 和 `ResumeContextBuilder` 在进入 Subtask 循环前只构建一次 Task 级上下文，随后被所有 Subtask 调用复用。
- `SessionExecutionCoordinator` 直接把 `readySubtask.goal` 作为 `ExecutorInput.userPrompt`，同时仍把完整 Task、Task 级历史和 Task 级 execution context bundle 交给 Adapter。
- `buildExecutorContextPrompt` 强调顶层 Task 标题、目标、历史和用户指令，尚无统一的“当前 Subtask 是唯一执行范围”契约，也未稳定呈现 acceptance、expected output、dependency handoff 和 sibling out-of-scope。
- 已完成依赖的 `result` 尚未被构造成下游专用 handoff；若直接复用完整 Task 历史或聚合输出，会放大上下文并诱发重复执行。
- 当前 `executionId` 面向一轮 Task 调度，Runtime 内部 token 面向一次调用；Phase 2 仍需把一次 Subtask execution attempt 从 claim 到 execute 再到 release 的身份与边界明确为同一条可审计链，但不提前引入 Phase 4 的持久 retry/fallback 状态机。

因此，本阶段不是重新设计工作图或增加并发，而是在已授权工作图与 Executor Adapter 之间建立唯一、受控、Subtask 级的执行上下文边界。

## 三、改动范围与唯一 Owner

### 3.1 纳入范围

1. **唯一的 Subtask execution context 构建 seam**
   - 由 Execution Runtime 逻辑模块拥有当前 Subtask 的执行上下文契约与构建行为。
   - 所有生产 Executor 调用必须消费同一构建结果；Session、Adapter、prompt builder 或测试 fixture 不得各自拼接近似版本。
   - 构建结果必须清晰区分顶层 Task 背景、当前执行范围、验收要求、预期交付、依赖交付和明确的范围外 sibling。

2. **Dependency handoff 共享语义**
   - Work Graph 模块拥有依赖关系、handoff 引用和从已授权图派生依赖事实的纯规则。
   - handoff 只能来自当前 Subtask 的已完成依赖，并只携带下游完成当前范围所需的交付事实；不得把整个 Task 历史、所有上游原始输出或无关 sibling 结果作为默认 handoff。
   - 由于本阶段首次扩展 handoff 语义，必须依照 ADR-0020 将现位于 `planning/` 内的共享工作图规则收敛到独立 Work Graph 公开入口；不得新增对 Planning 内部路径的 Runtime 依赖。

3. **Executor 输入与 Prompt 范围防线**
   - Executor Port 只接收 Runtime 已构造的单次执行上下文并执行；Adapter 不解释工作图、不选择 sibling、不决定 handoff 或 Task 落态。
   - Prompt/rendering 层必须把当前 Subtask 标为唯一执行范围，把顶层目标标为背景，并明确禁止主动完成未调度 sibling。
   - acceptance、expected output 和必要 handoff 必须以结构化事实进入执行调用，而不是依赖自然语言历史中的偶然描述。

4. **Attempt—WorkUnit 单一绑定**
   - 每次 Subtask execution attempt 从 claim、mark running、execute、完成/失败到 release 必须始终绑定同一个 Subtask 与同一个 WorkUnit。
   - Runtime 活跃执行跟踪、WorkUnit 事件和 Task/Subtask 事件必须能关联并证明这条边界；异常、取消或 Task 状态漂移也必须关闭或释放同一绑定。
   - 本阶段只建立当前串行执行中的边界与可审计性，不引入 retry/fallback 的持久 attempt 历史模型。

5. **现有调用链收敛**
   - `SessionExecutionCoordinator` 继续负责当前 Application Shell 编排，但必须把 Subtask execution context 构建委托给 Execution Runtime seam，不再拥有或复制范围/handoff 规则。
   - 现有 Task 级 memory、material、workspace 和 recall 信息仍可作为背景事实来源，但必须经过 Subtask 范围构建后才进入 Executor 调用；Memory 不成为执行范围 owner。
- handoff 使用 Work Graph v4 edge contract 与 Completion Protocol v1 规范化快照；不得从自由正文推断，也不得以复制完整 transcript 或新增自由文本平行事实代替领域契约。

6. **测试、Smoke 与文档**
   - 增加 execution-context 纯/聚焦测试、prompt 边界测试、dependency handoff 集成测试、attempt—WorkUnit 生命周期测试和真实生产路径回归。
   - 更新 `CONTEXT.md`、当前技术总览、相关模块边界测试、本计划、总路线图和文档索引，使它们只描述 Phase 2 完成后的唯一生产路径。

### 3.2 模块 Owner 与公开边界

| 行为/事实 | 唯一 Owner | 允许的消费者 | 本阶段边界 |
| --- | --- | --- | --- |
| 工作图依赖与 handoff 引用规则 | Work Graph | Planning、Control Kernel、Execution Runtime | 纯验证/派生，无 I/O、无 Repository、无运行状态策略 |
| 当前 Subtask execution context | Execution Runtime | ExecutionRuntime 调用链、Executor Port | 唯一构建 seam；精确签名待 Plan 模式冻结 |
| Task/Subtask 生命周期与持久结果事实 | Task Domain | Execution Runtime、Task queries | 不决定下一战略动作，不解释 Executor prompt |
| Task 级 memory/material/history 背景 | 对应 Memory/材料领域 | Execution Runtime context builder | 只提供背景事实，不拥有执行范围和 handoff 规则 |
| 单次外部执行与原始结果规范化 | Executor Port / Adapter | Execution Runtime | 不选择 Subtask、WorkUnit、fallback 或 Task 状态 |
| claim/execute/release 副作用与事实上报 | Execution Runtime | Application Shell、后续 Control Kernel | 保持一个 attempt 对一个 WorkUnit |
| 调用、依赖装配和用户界面投影 | Application Shell | 用户入口 | 不拼接 execution context，不拥有策略 |
| 持久化实现 | Storage Adapter | 对应领域/Runtime port | 不以表结构定义跨模块契约 |

最终 Interface 名称、参数形状和物理文件位置由后续 Plan 模式确定，但不得改变上表所有权或扩大公开 surface。

### 3.3 允许与禁止的依赖方向

本阶段遵循 ADR-0020，并特别固定：

```text
Application Shell -> Execution Runtime / Task queries / Memory application ports
Execution Runtime -> Work Graph / Task Domain / Executor ports / persistence ports
Planning          -> Work Graph
Adapters          -> Executor-owned contracts and external systems
Storage           -> domain value types and persistence ports
```

禁止：

- Execution Runtime 导入 PlanningAgent 实现、Planning 内部工作图文件或解释未经 Kernel 授权的 Plan；
- Session、prompt builder、Executor Adapter 和 Execution Runtime 各自维护一套 scope/handoff 拼接规则；
- Executor Adapter 读取 Repository 来发现 sibling/dependency，或反向决定 Task/Subtask 状态；
- Work Graph 规则依赖 Storage、Memory、WorkUnit 健康、Executor 进程或 Session；
- Commands、TUI、Gateway 直接访问具体 Repository 以构造执行上下文；
- 为测试方便增加仅测试使用的生产入口，或把 Storage schema 当作跨模块 Interface。

### 3.4 明确不纳入范围

以下事项属于后续阶段或独立解耦工作，不得顺带进入 Phase 2：

- 将 admission、capacity、dispatch、failure、timer、park、replan 等战略决策迁入统一 `decide(event, snapshot)` Kernel seam（Phase 3）。
- retry cap、backoff、fallback、候选耗尽、熔断和持久 attempt 历史状态机（Phase 4）。
- partition identity、读写冲突、持久 lease、worktree/临时目录隔离和崩溃清理（Phase 5）。
- runnable frontier 并发派发、跨 Task 公平性、取消传播、并行结果合并和竞争测试（Phase 6）。
- 修改 v4 工作图既有的能力拆分/合并授权语义，或重新引入旧 routing 字段、executor summary、双 schema/双 validator。
- 对 Memory、Guidance、Learning、Delivery、Gateway 或整个 prompt 系统做与 Subtask 范围无关的全面重构。
- 把 `SessionExecutionCoordinator` 一次性改造成最终 decide/apply/observe 循环；该控制面收敛属于 Phase 3。

## 四、必须遵循的原则

1. **当前 Subtask 是唯一执行范围。** 顶层 Task 目标、历史、材料和依赖结果都只能辅助当前 Subtask，不能扩张本次授权范围。
2. **最小充分 handoff。** 只传完成当前 Subtask 所必需、来自已完成直接依赖的交付事实；默认拒绝全量历史、全量 stdout、完整工具轨迹和无关 sibling 输出。
3. **结构化事实优先。** acceptance、expected output、scope、dependency 与 out-of-scope 必须来自领域/工作图契约，不从 prompt 文本猜测，也不复制为多份自由文本事实源。
4. **唯一 builder、统一消费。** 所有生产 Adapter 经过同一 Subtask execution context seam；不同 Executor 只负责按各自协议渲染或执行，不改变范围语义。
5. **Planner 提案，Kernel 授权，Runtime 落实。** Phase 2 不把策略迁入 Adapter 或 Session，也不让 Runtime重解释 Planner 意图。
6. **一个 attempt、一个 WorkUnit。** 从 claim 到 release 不切换所有者；若执行结束、异常或取消，必须先终止并释放当前绑定，后续行为留给未来 Kernel 决策。
7. **串行不变量保持。** 本阶段仍一次执行一个 ready Subtask；handoff 可用于未来并发，但不得成为提前开启并发的借口。
8. **派生优于复制。** sibling 列表、依赖集合和顺序由已授权工作图派生；不得新增显式 execution layer 或第二份依赖图。
9. **有界、确定、可审计。** 相同 Task/工作图/Subtask/依赖结果应产生稳定的执行上下文；裁剪和缺失必须有明确、可测试的结果，而不是静默注入任意历史。
10. **一次性收敛。** 新 seam 生效时删除或迁移旧的 Task 级直通拼接路径及对应 fixture；不保留 feature flag、双 prompt 路径或长期兼容包装。
11. **触及违规 seam 就收敛。** 本阶段触及 Planning 内部工作图规则和 `SessionExecutionCoordinator`：前者必须迁入独立 Work Graph 入口；后者不得新增策略职责或新的外部调用方。
12. **文档是完成门槛。** 未完成计划、路线图、当前架构文档与验证证据回填，不得宣告 Phase 2 完成或激活 Phase 3。

## 五、验收标准

### 5.1 执行上下文契约

- 生产路径只有一个 Subtask execution context builder，所有 Executor Adapter 消费相同的范围语义。
- 每次调用都能明确区分：顶层背景、当前 Subtask、acceptance、expected output、dependency handoff 和 sibling out-of-scope。
- 当前 Subtask goal 是唯一操作性指令；顶层目标不得以同等优先级再次呈现为“完成整个任务”。
- 未调度 sibling 不会因为 Task 历史、聚合输出或 prompt 默认文案而进入本次执行范围。
- Task 级 memory/material/history 仍可用，但不能覆盖当前范围、验收、handoff 或系统边界。

### 5.2 Dependency handoff

- 下游只接收其工作图依赖允许且已经完成的 handoff；未完成依赖、非依赖 sibling 和无关历史不得注入。
- handoff 使用稳定、结构化、大小有界的交付表达，并能引用必要产物；不得默认复制全部上游原始输出、完整 Task interaction 或工具轨迹。
- handoff 缺失、无效或超过边界时产生确定、可审计的结果，不由 Adapter 静默猜测或扩大范围。
- 工作图依赖/handoff 规则只有一个 Work Graph owner，Planning 与 Runtime 均不复制其实现。

### 5.3 Attempt 与 WorkUnit 生命周期

- 一次 Subtask attempt 的 claim、running、execute、结果/错误和 release 记录始终指向同一 Task、Subtask 和 WorkUnit。
- 同一 Subtask 同一时刻不存在两个 active attempts；一次 attempt 内不得切换 WorkUnit 或并行持有候选。
- 成功、失败、Executor 异常、progress callback 异常、Task 取消/状态漂移和 heartbeat lost 场景均不会遗留错误的 active claim。
- Phase 2 不实现跨 AgentClass retry/fallback；任何下一 attempt 都不得与前一绑定重叠。

### 5.4 用户可见端到端场景

- 单一 capability 可覆盖的“实现 + 文档 + 普通产物 + 验证”任务只形成一个 Subtask、一次 Executor 调用和一套产物，不重复执行顶层任务。
- 两节点依赖链中，上游只执行一次；下游收到必要 handoff 后只完成自己的范围，不重做上游，也不主动完成其他 sibling。
- 存在分叉或汇合时，每个串行调用只看到与当前节点有关的依赖交付和明确的 sibling 排除，不因完整 Task 历史重复生成别人的产物。
- 恢复已有 v4 工作图时，已完成 Subtask 不重新执行；后续 ready Subtask 只读取已持久的直接入边 handoff 快照。
- Executor 最终输出、Task 聚合和用户界面不重复展示或重复登记同一 Subtask 产物。

### 5.5 架构与回归门

- 共享工作图规则不再由 `planning/` 内部路径充当跨模块入口；Runtime 不新增对 Planning 内部实现的依赖。
- `SessionExecutionCoordinator` 不再直接拥有 Subtask scope/handoff 拼接规则，且没有因本阶段新增调用方或策略分支。
- `ExecutionRuntime` 只接收/执行 Kernel 已授权工作图中的当前 Subtask，不读取原始 `PlanningAgentPlan` 来补充执行语义。
- Executor Adapter、Commands、TUI 和 Gateway 不直接读取 Subtask/WorkUnit Repository 构造执行上下文。
- 旧 Task 级上下文直通导致的范围歧义路径和对应旧 fixture 被删除或迁移，不存在双路径。

### 5.6 验证门槛

至少完成并记录：

- `npm run lint`
- execution context、Work Graph handoff、prompt boundary、Execution Runtime、WorkUnit claim/release 和 Session 主链的聚焦测试
- 覆盖单节点唯一执行、依赖链 handoff、分叉/汇合范围、恢复和异常释放的集成测试
- `npm run build`
- `docker build -f Dockerfile.test -t metaclaw-test .`
- `docker run --rm metaclaw-test`
- 至少一个真实 Planner → Kernel → Runtime → Executor artifact smoke，证明只执行当前 Subtask且产物不重复

由于本地 Windows 环境不提供 `better-sqlite3`，涉及存储、Session 主链和完整测试套件的验收必须在 Docker/Linux 中完成；不得以宿主机跳过或失败结果代替。

## 六、总体实施收敛门

后续详细计划应把 Phase 2 组织为以下收敛门；各门内的具体接口、数据形状、文件与测试矩阵由 Plan 模式确定：

1. **契约门**：冻结 Subtask execution context、必要 handoff、out-of-scope 和 attempt 关联的最终语义。
2. **模块门**：建立独立 Work Graph 公开入口和唯一 Runtime context seam，确认所有 owner 与依赖方向满足 ADR-0020。
3. **切换门**：一次性把 Session、Runtime、Executor Port/prompt、必要领域/持久化投影和测试调用方切到新路径，并删除旧直通拼接路径。
4. **生命周期门**：证明 claim、execute、result/failure 和 release 对同一 Subtask/WorkUnit 的完整绑定与异常收尾。
5. **验收门**：完成端到端重复执行回归、Docker 全量测试、真实 artifact smoke 和文档回填后，才关闭 Phase 2 并激活 Phase 3。

任何细化方案若突破“不纳入范围”、引入并行新旧路径或违反 ADR-0020，必须先修改本计划或 ADR，不能在实现中隐式扩大范围。

## 七、迁移期例外与最迟删除阶段

- `SessionExecutionCoordinator` 现有容量不足、失败判断、Task 落态、定时恢复和调度策略在 Phase 2 可继续存在，因为其权威迁移属于 Phase 3～4；本阶段不得增加新的同类策略或调用方，Phase 3 必须开始收敛到统一 Kernel seam。
- 当前带 Repository 的 `KernelExecutorStatusProjector` 不属于 Phase 2 改动范围；若仅因执行结果上报被动受影响，只允许适配新的稳定 Runtime fact，不得扩大其 Repository/策略职责，最迟按 Phase 3～4 的控制面计划收敛。
- Phase 2 已建立最小持久 terminal attempt receipt 与稳定事件关联；retry 次数、backoff、fallback 与通用恢复状态最迟在 Phase 4 落地。
- 现有 Task 级 Memory/Resume context 类型可以作为背景事实载体保留，但不能继续作为 Executor 的完整执行范围契约；Task 级直通路径必须在 Phase 2 结束前删除，而非延期。

除上述条目外，不预设临时例外。后续 Plan 模式若发现新的例外，必须在实施前写明原因、风险、禁止新增调用方和最迟删除阶段。

## 八、完成与归档要求

Phase 2 关闭时必须同时完成：

1. 回填本文件开头的完成日期、实际交付、最终 Interface/迁移结果、验证结果与实现/收尾提交。
2. 更新总路线图的当前状态、Phase 2 实际行为、验证证据和下一激活阶段。
3. 更新 `CONTEXT.md`、当前技术总览与必要的模块/边界文档，使其只描述唯一 Subtask execution context 与 dependency handoff 路径。
4. 若实施形成 ADR-0020 未覆盖的长期架构决定，先新增或修订 ADR；不得只留在代码或聊天记录中。
5. 将本计划移入 `docs/archive/plans/`，更新 `docs/README.md`，并确认 `docs/plans/` 只保留总路线图和下一当前活动计划。

## 九、当前实施记录（2026-07-17）

Work Graph v4、SQLite v22、唯一 Subtask execution context、Task/attempt-scoped Execution Evidence、Completion Protocol v1、最小 attempt receipt、原子 handoff 持久化和串行 Attempt Runner 已实现。Session 已收缩为 ready-node 串行外壳，Executor Adapter 不再接收 Task prompt、全量 history 或 Task 级 memory bundle；contract failure 会冻结 Task 且不会被 `/task resume`、timer 或重启隐式重试。

`npm run lint`、`npm run build` 与聚焦回归通过；最终 Docker/Linux 全量回归通过 182 个文件、769 个测试（另有 2 个文件、4 个测试跳过，共 184 个文件、773 个测试）。Planner MCP 六工具 smoke、真实 Codex Planner API-key smoke 和 Planner→Kernel→Runtime→Codex Executor artifact smoke 全部通过；artifact 位于 Task 授权 target path，Completion Protocol 机器块未进入用户输出。

诊断中确认生产链路不需要登录：API key 位于 `docker/pi.env`，正式 runtime entrypoint 渲染 `anyint` provider 并通过 `OPENAI_API_KEY` 调用 Codex。最初的 refresh-token 报错来自错误的人工 smoke 命令——它没有加载 `docker/pi.env`，却复制了个人 `auth.json`。同时修复了真实 smoke 揭示的两个问题：v4 ContextRef 输出 schema 改用 Responses API 支持的 `anyOf`，以及 smoke 场景改为写入授权 Task target path。
