# Phase 3：Kernel 控制面收敛总体行动计划

## 计划状态

- **计划日期**：2026-07-20
- **当前状态**：已完成并归档
- **所属路线图**：[`2026-07-16-planner-kernel-concurrency-convergence-roadmap.md`](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- **对应阶段**：Phase 3——Kernel 控制面收敛
- **架构设计门**：[`ADR-0020：核心模块归属与依赖方向`](../../adr/0020-core-module-ownership-and-dependency-direction.md)
- **相关现行约束**：[`ADR-0011`](../../adr/0011-single-active-task-admission-gate.md)、[`ADR-0014`](../../adr/0014-planning-agent-policy-kernel-boundary.md)、[`ADR-0017`](../../adr/0017-kernel-executor-status-projection.md)、[`ADR-0019`](../../adr/0019-planning-agent-plan-v3-work-graph-authority.md)、[`ADR-0021`](../../adr/0021-work-graph-v4-subtask-execution-contract.md)
- **完成日期**：2026-07-20
- **实现提交**：`bfca74a`

本计划规定 Phase 3 的阶段目标、改动范围、模块所有权、依赖边界、实施原则、验收标准与完成门槛。它不冻结具体类型字段、Decision 变体名称、policy 拆分、持久化结构、文件清单或迁移顺序；这些内容必须在后续 Plan 模式中结合本计划逐项核对并形成详细实施计划后，才能开始代码改动。

计划完成时必须回填实际交付行为、最终公开 Interface、删除的旧策略入口、验证命令及结果、相关文档更新、实现提交和收尾提交。

## 一、阶段目标

建立一个小而稳定、纯且可穷举测试的 Control Kernel 决策 seam，使当前系统形成唯一控制主轴：

```text
observe normalized facts
  -> build Kernel event and snapshot
  -> decide
  -> apply authorized side effects
  -> observe normalized facts
```

Phase 3 结束后，Planner 仍只负责提案，Kernel 成为当前战略行为的唯一最终解释者，Runtime 只负责执行 Decision、维护副作用状态并上报规范化事实，Session 只负责触发和驱动循环。现有 admission、串行 dispatch、容量不足、执行结果落态、定时检查和 Completion Protocol 纠正策略不得再由 Session、Scheduler、TaskRuntimeService、Attempt Runner 或 Executor Adapter 自行决定。

本阶段必须独立形成可运行、可验收的串行最终态，为 Phase 4 的通用 recovery/fallback/retry/circuit 状态机提供稳定控制面，但不得提前实现 Phase 4～6 的能力。

## 二、当前代码基线与问题边界

截至计划日期，Phase 1～2 与残余加固已经交付严格 Work Graph v4、canonical AgentClass 授权、唯一 Subtask execution context、Completion Protocol v1、attempt-bound WorkUnit、原子 handoff 与 terminal receipt。工作区无未提交改动，当前基线提交为 `4249bd2`，Phase 2 残余修复提交为 `11c8e27`。

当前已经存在以下可复用基础：

- `PolicyKernel` 是纯对象，能校验或重写 `PlanningAgentPlan`，处理风险确认、单活跃 Task 冲突、工作图与静态/动态 AgentClass 授权，不直接写 Repository。
- `KernelDecisionApplier` 已承担部分 plan decision 的应用与审计副作用。
- `SessionExecutionCoordinator` 能串行选择 ready Subtask，驱动一个 attempt、一个 WorkUnit 的执行，并汇总完成结果。
- `SubtaskAttemptRunner` 已能把 Adapter 结果规范化为 `completed`、`contract_blocked`、`executor_failed`、`cancelled_or_stale`，并持久化最小 terminal receipt。
- `Task`、`Subtask`、`WorkUnit`、handoff、attempt receipt、executor status projection 与事件记录已提供构建显式 snapshot 和 Runtime fact 的事实基础。

但当前控制权仍分散：

- `PolicyKernel.decide(plan, snapshot)` 只解释 PlanningAgentPlan，尚不是统一的 event/snapshot 决策入口；`authorizeDirectReply` 仍是第二公开捷径。
- `TaskAdmissionGate` 在确定性执行路径保留 Session 所有的 admission 规则，与自然语言路径的 Kernel admission 并存。
- `SessionExecutionCoordinator` 自行选择 AgentClass、判断无容量/attempt 失败/无 ready 节点后的 Task 落态，并直接触发后续调度。
- `SubtaskAttemptRunner` 在 contract、executor failure 和 stale 场景中直接决定 Subtask/Task blocked 等战略落态，而不只是提交执行事实。
- `MetaclawSession` 通过原始错误分类、Executor 可用性检查和计时状态自行决定 blocked Task 是否解除并重新调度。
- `TaskRuntimeService` 与 `SchedulerEngine` 仍包含优先级、抢占、自动恢复、选择下一 Task 和调度落态等策略入口；其中一部分受单活跃 Task 约束抑制，但仍是并行控制面。
- Repo-backed executor status projector 仍位于 Kernel 命名空间附近并由 Coordinator 直接驱动，纯策略、事实投影和持久化应用边界尚未完全分开。

因此，本阶段不是给现有分支再包一层统一 facade，而是建立唯一决策协议，并在迁入每项当前策略的同时删除对应的旧策略所有权。

## 三、改动范围与唯一 Owner

### 3.1 纳入范围

1. **统一 Control Kernel 决策 seam**
   - Control Kernel 拥有单一 `decide(event, snapshot) -> decision` 公开 Interface。
   - event、snapshot 与 decision 使用可判别、可穷举的稳定领域契约，覆盖当前阶段所需的 plan admission、direct reply/clarification/no-action、串行 dispatch、execution outcome、capacity signal、timer tick 和 handoff contract failure。
   - Kernel 内部可组合多个纯 policy，但调用者不得知道或分别调用这些内部 policy。
   - `authorizeDirectReply`、plan-only `decide` 或其他按场景暴露的 Kernel 公开捷径必须收敛到统一入口。

2. **显式事件、快照与规范化事实边界**
   - Runtime/Adapter 负责把原始异常、退出状态、claim 结果、heartbeat、Executor 可用性和 completion violations 规范化为 Kernel 可解释的稳定事实。
   - Application Shell/Runtime 负责从领域查询与持久事实构建 event/snapshot；Kernel 不查询 Repository、不读取时钟、不解析 stderr、不匹配原始错误文本，也不调用 Executor。
   - snapshot 只携带当前决策必需的有界事实；不得把 Repository、服务对象、完整日志或可变全局状态伪装成 snapshot。

3. **当前 admission 与串行 dispatch 权威收敛**
   - 单活跃顶层 Task 产品约束继续有效，但其最终授权归 Control Kernel。
   - 自然语言、确定性执行与恢复入口必须共享同一 admission 权威；`TaskAdmissionGate` 不得继续作为并行策略所有者。
   - 当前串行 Runtime 中“是否可以 dispatch、dispatch 哪个已授权 Subtask/AgentClass、容量不足后采取何种当前阶段动作”由 Kernel 决定。
   - Work Graph 继续拥有拓扑与 ready/frontier 的纯派生语义；Kernel 消费派生事实作授权，Runtime 不复制拓扑规则。

4. **Execution outcome 与失败落态收敛**
   - Attempt Runner/Executor Adapter 只产生规范化 outcome 和完成必要的原子执行事实，不决定 retry、fallback、replan、park 或 Task 的下一战略状态。
   - 当前已有的完成、容量不足、Executor 失败、stale/cancelled、heartbeat lost、无 runnable node 等结果必须通过 Kernel Decision 决定后续可执行动作或终态。
   - Phase 3 只收敛当前既有落态行为，不引入 Phase 4 的通用 retry/fallback/backoff/circuit 策略。

5. **Completion Protocol 一次纠正策略**
   - 新增 `handoff_contract_failed` Kernel event，输入必须包含 attempt、Subtask、WorkUnit、AgentClass、已授权 completion contract 和全部结构化 violations。
   - Kernel 对同一 Subtask 最多授权一次同 AgentClass 的纠正 attempt；纠正输入必须精确反馈缺失/错误 key、violation 类型和完整 Completion Protocol trailer 要求。
   - 第二次 contract failure 必须确定性 blocked，不切换 AgentClass、不 fallback、不 backoff，也不被 timer、进程恢复或普通 resume 隐式重试。
   - 纠正 attempt 仍必须遵守一个 active attempt、一个 WorkUnit，且前一 attempt 已终止并释放资源。

6. **Timer 与恢复触发器降级为事件源**
   - timer 只负责产生时间/触发事实并请求 Kernel 决策，不自行检查后直接 unblock、resume 或 dispatch。
   - Session 中基于原始错误字符串、权限正则、Executor 可用性和计时状态的恢复决策必须迁出或删除。
   - Phase 3 只保留路线图明确要求的当前定时恢复行为；通用恢复分类、retry cap、cooldown 和 circuit 留给 Phase 4。

7. **Decision apply/observe 与审计闭环**
   - Execution Runtime 拥有 Decision apply、Task/Subtask/WorkUnit 领域命令调用、claim/release、heartbeat、Adapter 调用、持久化和事实上报。
   - `SessionExecutionCoordinator` 收缩为 observe/build/decide/apply/observe 驱动器，不再维护策略表或按 outcome 自行选择下一动作。
   - 所有当前战略行为必须能以稳定 event、snapshot、decision 和 apply result 被测试与审计；具体持久化形状由详细计划决定，且不得让 Storage schema 反向定义 Kernel 契约。

8. **触及的违规 seam 同阶段收敛**
   - 审核并收敛 `TaskRuntimeService` 中本阶段触及的调度、抢占和自动恢复策略入口；属于当前单活跃产品行为的迁入 Kernel，已不可达或与当前约束冲突的旧策略删除，Phase 4 专属策略只保留事实/领域能力而不继续自主执行。
   - 审核 `SchedulerEngine`、`TaskAdmissionGate`、`KernelDecisionApplier`、`SessionExecutionCoordinator`、timer path、Attempt Runner 和 executor status projection 的调用方向；不得新增违规调用方或扩大迁移期 public surface。
   - Repo-backed status projector 的稳定词汇归 Routing Catalog，纯状态解释归 Control Kernel，事实读取/写入归 Runtime/持久化 Adapter；本阶段若触及该 seam，必须按 ADR-0020 收敛命名与依赖边界。

9. **测试、验证与文档**
   - 增加纯 Kernel decision matrix、事件/Decision 穷举、模块边界、Decision apply、一次 contract 纠正、timer 事件化、容量不足与失败落态的聚焦测试。
   - 增加串行端到端和恢复场景，证明 Session/Runtime 不再拥有平行战略分支。
   - 更新 `CONTEXT.md`、当前技术总览、相关 ADR 对齐说明、总路线图、本计划与文档索引，使其只描述统一 Kernel 控制链。

### 3.2 模块 Owner 与公开边界

| 行为/事实 | 唯一 Owner | 允许的消费者 | Phase 3 边界 |
| --- | --- | --- | --- |
| Kernel event、snapshot、decision 词汇与战略解释 | Control Kernel | Application Shell、Execution Runtime | 单一纯 `decide` seam，无 I/O、Repository、时钟或 Adapter 依赖 |
| PlanningAgentPlan 与自然语言语义提案 | Planning | Control Kernel | Planner 不产生执行授权或 Task 落态 |
| DAG、依赖、ready/frontier 与 handoff 引用纯规则 | Work Graph | Planning、Control Kernel、Execution Runtime | 不拥有运行状态、容量或调度政策 |
| canonical AgentClass 与健康投影词汇 | Routing Catalog | Planning、Control Kernel、Runtime projector | 不决定 dispatch/fallback，不启动进程 |
| Task/Subtask 生命周期不变量与领域命令 | Task Domain | Execution Runtime、Task queries | 不选择下一战略动作，不拥有 retry/recovery policy |
| attempt、WorkUnit、claim/release、Adapter 调用与 Runtime facts | Execution Runtime | Control loop、Persistence Adapter | 应用 Decision，不自行决定后续策略 |
| 原始外部结果规范化 | Executor Port / Adapter 与 Runtime 边界 | Execution Runtime、Control Kernel 的稳定 event builder | 不解析为 Task 落态，不选择 AgentClass |
| 循环驱动、入口与界面投影 | Application Shell | 用户入口 | observe/build/decide/apply，不拥有策略 |
| 持久化实现与审计写入 | Storage Adapter | 对应领域/Runtime port | 不成为 Kernel Interface 或策略源 |

最终类型名称、字段、policy 组合、port 数量和物理文件位置由详细实施计划冻结，但不得改变上表的所有权。

### 3.3 允许与禁止的依赖方向

本阶段遵循 ADR-0020，并特别固定：

```text
Application Shell -> Planning / Control Kernel / Execution Runtime / Task queries
Planning          -> Work Graph / Routing Catalog
Control Kernel    -> Work Graph / Routing Catalog / Task facts
Execution Runtime -> Work Graph / Task Domain / Executor ports / persistence ports
Adapters          -> owned contracts and external systems
Storage           -> domain value types and persistence ports
```

禁止：

- Control Kernel 依赖 Session、Scheduler、Execution Runtime、具体 Executor Adapter、SQLite Repository、系统时钟或原始日志解析；
- Session、Scheduler、TaskRuntimeService、Attempt Runner、Executor Adapter 各自保留同一事件的战略判断；
- Runtime 直接解释未授权 PlanningAgentPlan，或在 Kernel Decision 之外选择 retry、fallback、replan、park、preempt、resume 或 circuit 行为；
- event/snapshot builder 通过自由文本或 Storage 表结构反推领域语义；
- Kernel policy 通过正则匹配原始错误文本或读取动态外部状态；
- Work Graph 或 Routing Catalog 依赖 Task 运行状态、Repository、Session 或 Executor 进程；
- Commands、TUI、Gateway 绕过应用 facade 直接写 Repository 或调用内部 policy；
- 为测试方便给生产 Interface 增加只供测试使用的入口；
- 用 feature flag、兼容 wrapper 或双写长期保留 plan-only Kernel 和 unified Kernel 两条路径。

### 3.4 明确不纳入范围

以下事项不得在 Phase 3 中顺带实现：

- 通用 failure taxonomy、跨失败类型 retry cap、backoff/cooldown、顺序 fallback、候选耗尽、circuit breaker 和完整持久恢复状态机（Phase 4）。
- partition identity、读写冲突、资源授权、持久 lease、worktree 隔离和崩溃清理（Phase 5）。
- 真正异步并发、跨 Task 公平性、饥饿保护、并行 claim/run、取消传播和确定性并行聚合（Phase 6）。
- 放宽 ADR-0011 的单活跃顶层 Task 产品约束，或恢复旧多 Task queue/preemption 行为。
- 修改 Work Graph v4、Completion Protocol v1 或 canonical Routing Capability 的既有语义；若详细设计发现长期契约必须改变，应先修订相应 ADR，而不是在实现中隐式改变。
- 对 Memory、Guidance、Learning、Delivery、Gateway、TUI 或整个 Storage 层做与控制面收敛无关的全面重构。
- 以 Phase 4 的未来需要为理由预埋未参与当前决策的字段、占位事件、死 policy 或双版本协议。

## 四、必须遵循的原则

1. **唯一战略解释者。** 同一事实只能由 Control Kernel 决定下一战略动作；Runtime 与 Application Shell 不得保留“兜底判断”。
2. **纯决策、显式输入。** 时间、健康、容量、attempt 历史和领域状态必须通过 event/snapshot 提供；Kernel 不隐藏读取任何外部状态。
3. **事件是事实，不是命令伪装。** event 描述已经观察到的事实；decision 才表达授权动作。调用者不得预先作出策略选择再包装成 event。
4. **Decision 是授权，不是副作用。** Kernel 不写库、不 claim、不调用 Executor、不投递消息；apply 层必须验证并执行 Decision。
5. **规范化边界在 Kernel 外。** 原始异常、stderr、超时和外部响应先由 Adapter/Runtime 规范化；Kernel 不依赖脆弱字符串启发式。
6. **一次迁入、一次删除。** 每迁入一项策略，必须在同一批改动删除原 Session/Runtime/Scheduler 分支、旁路和旧 fixture，不保留双控制面。
7. **判别联合与穷举处理。** event 和 decision 必须能由类型系统与测试穷举；未知或不完整输入 fail closed，不通过默认分支猜测。
8. **领域 owner 不漂移。** Work Graph 继续拥有图规则，Routing Catalog 继续拥有静态路由与健康词汇，Task Domain 继续拥有生命周期不变量；Kernel 只拥有战略解释。
9. **串行不变量保持。** Phase 3 仍一次执行一个 Subtask；一个 Subtask 同时最多一个 active attempt，一个 attempt 绑定一个 WorkUnit。
10. **Contract 纠正是窄例外。** 只允许同 AgentClass、最多一次、精确反馈格式错误；不得演化为通用 retry 或 fallback 后门。
11. **当前行为可证明。** 迁移后的用户可见结果要么与现有已接受行为一致，要么由路线图/ADR 明确要求改变；不得静默恢复已禁用的多 Task 调度。
12. **幂等与重复观察安全。** event 重复、apply 重入或观察延迟不能造成并行 attempt、重复 handoff、重复终态或越权恢复；具体持久化机制在详细计划冻结。
13. **最小公开 surface。** Kernel 对外只有统一 decide seam；内部 policy、分类器和辅助函数保持私有或模块内可见。
14. **文档是完成门槛。** 未回填本计划、总路线图、当前架构文档和验证证据，不得宣告 Phase 3 完成或激活 Phase 4。

## 五、验收标准

### 5.1 统一 Kernel 契约

- 所有 Kernel-owned 行为均通过一个 `decide(event, snapshot) -> decision` 入口；生产代码不存在 `authorizeDirectReply`、plan-only decide 或独立 policy 旁路。
- plan admission、direct reply/clarification/no-action、task control、串行 dispatch、capacity、execution outcome、timer tick 和 handoff contract failure 均有明确、可穷举的事件与 Decision 测试。
- Kernel 在纯单元测试中无需数据库、系统时钟、Executor、Session 或文件系统即可运行；相同输入产生相同 Decision。
- 不完整、矛盾、未知或越权事实 fail closed，并产生稳定、可审计的拒绝/阻塞/澄清结果。

### 5.2 策略所有权与运行循环

- `SessionExecutionCoordinator` 只驱动 observe/build/decide/apply/observe，不直接选择战略落态、retry、fallback、resume 或下一个授权动作。
- `TaskAdmissionGate` 不再是独立 admission 权威；自然语言与确定性入口遵守同一 Kernel 决策语义。
- `TaskRuntimeService` 只保留 Task 生命周期命令、查询及明确的应用能力；本阶段触及的优先级、调度、抢占和自动恢复策略已迁移或删除。
- `SchedulerEngine` 不再拥有与 Kernel 重复的 admission、dispatch、preemption 或 recovery policy；若作为 apply/驱动组件保留，只消费授权事实。
- Attempt Runner 和 Executor Adapter 只上报规范化结果并完成原子执行副作用，不直接决定 Task/Subtask 的下一战略状态。

### 5.3 当前战略行为

- 单活跃顶层 Task admission 在所有生产入口一致生效；direct reply、clarification、status/clear 和针对当前 Task 的合法操作保持可用。
- 串行 dispatch 只选择依赖已满足、经 Kernel 授权且当前可执行的 Subtask/AgentClass；Runtime 不自行更换候选。
- capacity 不足、Executor 失败、cancelled/stale、heartbeat lost、无 runnable node 和 Task 完成均先形成稳定事实，再由 Kernel Decision 决定当前阶段允许的落态。
- timer tick 不直接修改 Task/Subtask 或启动 Executor；任何恢复/继续执行都必须有对应 Kernel Decision。
- 当前 Phase 3 不会因失败自动跨 AgentClass fallback、backoff 或进入 circuit；这些行为没有隐藏路径。

### 5.4 Completion Protocol 纠正

- 第一次 contract failure 产生完整 `handoff_contract_failed` 事件，保留 attempt/Subtask/WorkUnit/AgentClass、授权 contract 与全部 violations。
- Kernel 最多授权一次同 AgentClass 纠正 attempt，且新 attempt 只在旧 attempt 终止、receipt 落库、claim 释放后开始。
- Executor 能收到精确 violation 反馈和完整 trailer 要求，不需要从历史输出或自由文本错误中猜测缺失内容。
- 纠正成功只发布一份最终 handoff/产物；第一次失败不会发布无效正文或 handoff。
- 第二次 contract failure 确定性 blocked；timer、startup recovery、普通 resume 和 scheduler 不会再次执行，也不会 fallback/backoff。
- 重复事件或重复 apply 不会创建第二个纠正 attempt、重复 receipt 或重复终态。

### 5.5 架构与依赖边界

- Control Kernel 没有对 Session、Execution Runtime、具体 Adapter、Storage 或系统时钟的依赖；模块边界测试能证明禁止方向。
- Runtime 不导入 PlanningAgent 实现，不解释未经 Kernel 授权的 plan；Work Graph 与 Routing Catalog 规则没有被复制。
- Repo-backed executor status projection 的纯词汇/解释/持久化职责符合 ADR-0017/ADR-0020，且没有被扩大为 Kernel Repository seam。
- 旧策略入口、旧测试 fixture、字符串恢复判断和双 Kernel 路径已删除；代码与文档搜索不再出现生产调用方。
- 新增跨模块类型由语义 owner 定义，Storage schema 不充当 event/snapshot/decision Interface。

### 5.6 验证门槛

至少完成并记录：

- `npm run lint`
- Kernel event/decision matrix、纯 policy、模块边界和 exhaustiveness 聚焦测试
- Decision apply、admission、capacity、execution outcome、timer event、heartbeat lost 和一次 contract 纠正的集成测试
- 覆盖 direct reply、单活跃冲突、单节点成功、依赖链成功、容量不足、Executor 失败、首次 contract 纠正成功、二次 contract failure blocked、重复事件/apply 的端到端场景
- `npm run build`
- `docker build -f Dockerfile.test -t metaclaw-test .`
- `docker run --rm metaclaw-test`
- 至少一个真实 Planner → Kernel → Runtime → Executor smoke，以及一个可控的 contract correction smoke/fixture，证明最终用户输出与 handoff 唯一且无协议泄漏

由于本地 Windows 环境不提供 `better-sqlite3`，涉及持久化、Session 主链、attempt 和完整套件的验收必须在 Docker/Linux 中完成；不得以宿主机跳过或失败结果代替。

## 六、总体实施收敛门

后续详细计划应把 Phase 3 组织为以下总体收敛门；每一门的具体类型、文件、迁移和测试矩阵由 Plan 模式确定：

1. **契约门**：冻结 unified Kernel event/snapshot/decision 语义、明确 Phase 3 与 Phase 4 的失败策略边界，并决定是否需要 ADR 修订。
2. **纯内核门**：建立单一纯 decide seam 和内部 policy 组合，以 decision matrix 证明当前战略行为可穷举。
3. **事实与应用门**：建立规范化 Runtime facts、snapshot builder 和 Decision apply/observe 边界，保证副作用与策略分离。
4. **策略迁移门**：逐项迁入 admission、dispatch、capacity、outcome landing、timer 和 contract correction，同时删除原 Gate/Session/Scheduler/Runtime 分支。
5. **控制循环门**：把 Coordinator 收缩为 observe/build/decide/apply/observe，并证明串行 attempt/WorkUnit 不变量和重复事件安全。
6. **验收门**：完成聚焦测试、Docker 全量回归、真实 smoke、架构文档与计划回填后，才关闭 Phase 3 并激活 Phase 4。

任何细化方案若突破“不纳入范围”、引入新旧控制链并行、让 Kernel 产生副作用或违反 ADR-0020，必须先修改本计划或相关 ADR，不能在实现中隐式扩大范围。

## 七、迁移期例外与最迟删除阶段

- **Phase 3 内部短期切换**：实施过程中可以按可独立验证的垂直行为切换，但一个行为一旦接入 unified decide，就必须在同一批修改删除旧分支。短期适配器只允许服务当次切换，不得作为阶段完成时的生产兼容层。
- **通用失败恢复**：retry cap、跨 AgentClass fallback、backoff/cooldown、候选耗尽和 circuit breaker 明确延期到 Phase 4；Phase 3 只能保留支持规范化事实和领域不变量的能力，不得保留会自主执行这些策略的入口。
- **单活跃 Task 下的旧多 Task 调度代码**：详细设计必须逐项判定删除还是降级为无策略应用能力。若确有不能在 Phase 3 删除的历史入口，必须证明生产不可达、禁止新增调用方，并明确最迟在 Phase 4 前删除；不得用“未来可能恢复多 Task”作为保留并行策略的充分理由。
- **Repo-backed executor status projector**：若完整物理迁移会明显扩大 Phase 3，可保留为 Runtime/持久化应用服务，但必须移除其作为纯 Kernel public seam 的含义，禁止新增调用方，并在本计划完成记录中写明最终归属。纯解释策略不得延期。

除上述条目外，不预设临时例外。后续详细计划若发现新的例外，必须在实施前写明原因、风险、禁止新增调用方和最迟删除阶段。

## 八、完成与归档要求

Phase 3 关闭时必须同时完成：

1. 回填本文件开头的完成日期、实际交付、最终 Interface/迁移结果、删除的旧策略入口、验证结果与实现/收尾提交。
2. 更新总路线图的当前状态、Phase 3 实际行为、验证证据和下一激活阶段。
3. 更新 `CONTEXT.md`、`docs/current/technical-overview.md`、必要 ADR 对齐说明与模块/边界文档，使其只描述 unified Kernel control loop。
4. 若实施形成 ADR-0020、ADR-0021 未覆盖或与现行 ADR 不同的长期架构决定，先新增或修订 ADR；不得只留在代码、详细计划或聊天记录中。
5. 将本总体计划与详细实施计划移入 `docs/archive/plans/`，更新 `docs/README.md`，并确认 `docs/plans/` 只保留总路线图和下一当前活动计划。

## 九、实际交付与验证记录

最终公开控制接口为 `ControlKernel.decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision`；每个 Decision 只包含一个高层 action。`KernelControlLoop` 负责构建 snapshot、先写统一 ledger、apply 与 observe，重复 event 不再 apply。SQLite v23 建立 `kernel_decisions`，旧 `planning_decisions` 改名并冻结为只读历史审计。

Runtime 已按 Kernel 指定的 Subtask、AgentClass、attempt ID 执行；非成功 receipt 与 `awaiting_decision` 原子落盘，WorkUnit 在 outcome 再次进入 Kernel 前释放。capacity failure 不生成 receipt，候选切换和 timer capacity recovery 由 Kernel 决定；普通 execution failure、timeout、network 与 heartbeat lost 不进入 timer 恢复。首次 completion contract failure 可获得一次同 AgentClass、空只读 workspace、无 tools/evidence 的 response-only correction，第二次失败 fail closed。

旧 plan-only `PolicyKernel`、direct-reply shortcut、`TaskAdmissionGate`、多 Task Scheduler policy、`TaskResumePlanner` 与 Session 错误文本恢复策略已删除。Task 命令/查询收敛到领域接口，focus 留在 Session projection，executor status projector 归 Execution/Storage 应用层。

验证：`npm run lint` 与 `npm run build` 通过；Docker/Linux 全量 Vitest 为 176 个文件、715 个测试通过，4 个文件、15 个明确延期到 Phase 4/6 的历史测试跳过。Kernel 决策矩阵、架构边界、ledger/migration、capacity loop、outcome landing 与 correction isolation 均有聚焦回归。真实 Linux `npm run smoke:metaclaw` 通过，Codex Planner 经统一 Kernel/ledger 驱动 Codex Executor，在授权 Task workspace 生成并验证 `smoke-result.md`；Windows host 直接运行仍受仓库已知的 `better-sqlite3` native binding 缺失限制。实现提交为 `bfca74a`。
