# Planner、Kernel 与并发调度收敛路线图

## 计划状态

- **计划日期**：2026-07-16
- **当前状态**：实施中；Phase 1～3 已完成
- **当前激活阶段**：Phase 4——Recovery、fallback、retry 与熔断；详细实施计划待制定
- **已完成前置**：Codex/Pi canonical capability definitions、Planner-safe catalog、Seeder 与 Adapter binding 已统一
- **架构指引**：[ADR-0020：核心模块归属与依赖方向](../adr/0020-core-module-ownership-and-dependency-direction.md)；所有后续阶段实施计划和代码改动必须遵守
- **实施方式**：一次只展开一个阶段的实施计划；当前阶段完成并归档后再激活下一阶段
- **完成日期**：未完成
- **实现提交**：未产生

## 一、路线图目标

本路线图接管以下尚未完成的目标：

1. 让 Planner 按能力交接边界设计 Subtask，而不是按操作步骤拆分。
2. 让依赖图成为 Subtask 合并、串行和未来并行的唯一结构依据。
3. 保证一个 Subtask execution attempt 在同一时刻只对应一个具体 WorkUnit。
4. 将调度、失败恢复和资源授权决策收敛到 Kernel 控制面，Runtime 只执行决策和副作用。
5. 建立 workspace/resource partition、持久租约和崩溃恢复后，再启用真正并发。

本路线图不要求一次完成全部目标。每个阶段都必须形成可独立验收的最终形态，不保留为了下一阶段而存在的临时兼容路径。

本路线图只规定跨阶段能力收敛顺序；模块职责、公开 seam、依赖方向和 Application Shell/Storage 的外围定位由 [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md) 规范。若阶段实施细节与该 ADR 冲突，必须先修订 ADR，不能以现有目录布局或历史调用路径作为例外依据。

## 二、当前基线与问题拆分

### 2.1 已完成的能力底座

Canonical definitions 已经是 Codex/Pi 静态路由能力、Planner catalog、Seeder AgentClass 投影与 Adapter binding 的唯一来源。动态健康与近期执行状态继续由 `list_executor_status` 提供。

能力事实源、Planner required capabilities、Kernel canonical coverage 和完整有序 AgentClass 授权已经统一。Phase 2 没有扩大 routing 语义；Attempt Runner 只使用 Kernel 已授权的当前 AgentClass。

### 2.2 Work Graph v4 与 dependency handoff 已落地

`dependencies` 已完全替换 `dependsOn`，同时作为 DAG 拓扑与 keyed `text`/`artifact` delivery contract 的唯一事实源。独立 `src/work-graph/` 提供 Planning、Kernel 和 Execution 共享的类型与纯校验；Runtime 只注入已完成直接入边的不可变 handoff，不继承祖先结果。

当前生产图为严格 v4，Executor 响应通过 Completion Protocol v1 精确交付 acceptance evidence、artifacts 和 outgoing handoffs。SQLite v22 保留只读 v3 audit 并 park 非终态旧图；只有用户自然语言可触发 v4 replan。

### 2.3 Kernel 控制面已统一

Phase 3 已用 `ControlKernel.decide(event, snapshot)` 和持久 decision ledger 统一 Planning admission、串行 dispatch、capacity、execution outcome、timer 与 completion correction。Phase 4 将继续在同一 seam 上增加 durable recovery、failure taxonomy、retry/fallback/backoff 与 circuit breaker，不再建立第二条控制链。

### 2.4 并发的前置条件不是线程池，而是资源模型

在 partition key、读写冲突、持久租约、崩溃恢复、工作树隔离和确定性合并完成前，不允许把“同层节点”直接解释为可以生产并发执行。

## 三、全局不变量

所有阶段都必须维护以下不变量：

1. **Planner 提案，Kernel 决策，Runtime 执行副作用。**
2. **Canonical definitions 是 Codex/Pi 静态 Routing Capability 的唯一事实源。**
3. **工作图是 Subtask 依赖和执行次序的唯一事实源，不保存显式 execution layer。**
4. **每个 Subtask 只有一个有序 AgentClass 偏好清单；首位 preferred，其余为 fallback。**
5. **一个 Subtask 同一时刻最多有一个 active attempt；一个 attempt 只绑定一个 WorkUnit。**
6. **Fallback 是前一 attempt 结束并释放资源后的下一次 attempt，不允许并行双重所有权。**
7. **Runtime 不自行作战略判断；策略迁入 Kernel 时必须同步删除旧分支。**
8. **未建立 partition 授权和租约前，Runtime 保持串行。**
9. **Work Graph 与 Routing Catalog 是独立共享语义；不得把规则复制到 Planner、Kernel 或 Runtime。**
10. **Session/Commands/TUI/Gateway 是 Application Shell，Storage 是 Adapter；二者不拥有控制策略。**
11. **新增跨模块依赖必须符合 ADR-0020；现有违规 seam 只能收敛，不能扩大。**

## 四、阶段依赖

```text
Canonical capability definitions（已完成）
  → Phase 1 工作图语义收敛
  → Phase 2 Executor 执行范围隔离
  → Phase 3 Kernel 控制面收敛
  → Phase 4 Recovery / fallback / 熔断
  → Phase 5 Partition 串行落地
  → Phase 6 异步并发调度
```

Phase 1～2 关闭最初的错误拆分与重复执行问题；Phase 3～4 建立完整控制面；Phase 5～6 才进入资源隔离和并发。

## 五、分阶段执行方向

### Phase 1：工作图语义收敛

目标：让 Planner 输出的工作图在串行 Runtime 中已经具备最终、可靠的结构语义。

执行方向：

- PlanningAgentPlan 硬升级到新 schema，不维持新旧执行协议并行。
- 每个 Subtask 声明受控 `requiredCapabilities`。
- 每个 Subtask 只保留一个有序 `preferredAgentClassList`；首项是 preferred，其余是 fallback。
- 删除或由工作图派生现有重复的 hint、candidate 和顶层 executor summary 字段，避免多份路由事实。
- 建立纯工作图规则模块，由 Planner validator 和 Kernel 共同消费。
- 规则至少覆盖：唯一 ID、依赖存在、DAG、起始节点、派生执行层、同层首选 AgentClass 不重复、同 AgentClass 无分叉单链合并，以及能力覆盖。
- Kernel 使用 canonical capability definitions 校验候选，不把数据库自由文本 capability 视为内置类认证依据。
- Runtime 继续串行消费通过授权的 DAG，不在本阶段启用并发。

退出条件：Planner 不再把同一 AgentClass 可一次完成的步骤拆成无意义单链；跨能力交接才产生多个 Subtask；结构违规可由 Planner repair，并由 Kernel 防止绕过。

完成记录（2026-07-16）：PlanningAgentPlan 已升级为严格 v3，纯工作图规则、catalog-aware Planner/Kernel 双重认证、动态健康 rewrite 复检、v21 只读审计迁移及无 fallback Runtime cutover 已交付。Docker/Linux 全套测试通过（176 个文件、776 个测试），真实 Planner→Kernel→Runtime artifact smoke 通过。Phase 1 实施计划已归档并随本次收尾提交落库。

### Phase 2：Executor 执行范围与 dependency handoff

目标：Executor 每次只完成当前 Subtask，不重复完成 sibling 或整个顶层任务。

执行方向：

- 建立唯一 Subtask execution context builder。
- 顶层目标只作为背景，当前 Subtask 是唯一执行范围。
- 注入 acceptance、expected output、必要 dependency handoff 和 sibling out-of-scope。
- dependency 只传递必要交付物，不重复注入全部历史输出。
- claim、execute、release 全程维持一个 attempt 对一个 WorkUnit。
- 用端到端场景验证单能力任务只产生一次执行和一套产物。

退出条件：原始“一个 Executor 可完成的任务被拆成多个调用并重复执行”的问题关闭，且不依赖未来并发实现。

完成记录（2026-07-17）：Work Graph v4、SQLite v22、唯一 Subtask context、Execution Evidence、Completion Protocol v1、最小 attempt receipt、原子 handoff 和串行 Attempt Runner 已交付。`npm run lint`、`npm run build`、聚焦回归和 Docker/Linux 全量回归通过（182 个文件、769 个测试；另有 2 个文件、4 个测试跳过）。Planner MCP 六工具 smoke、真实 Codex Planner API-key smoke 与 Planner→Kernel→Runtime→Codex Executor artifact smoke 均通过。实现提交为 `9783518`、`1472a3c`；Phase 2 计划已归档，Phase 3 激活。

残余加固记录（2026-07-20）：contract/stale 终态统一回到 Task domain 与 attempt-bound WorkUnit，恢复 Phase 1 的可合并单链和同层 preferred 冲突校验，并以 coordinator/attempt 行为测试替换读源码断言。修复提交为 `11c8e27`；Phase 3 的事件和纠正策略范围不变。

### Phase 3：Kernel 控制面收敛

目标：建立一个小而稳定的 Kernel 决策 seam，将战略决策从 Session/Runtime 收回。

执行方向：

- 建立统一的纯决策入口，方向为 `decide(event, snapshot) -> decision`。
- event 和 decision 使用判别联合表达 Plan admission、dispatch、execution outcome、capacity signal 和 timer tick。
- Kernel 内部可以由多个 policy 模块组成，但对调用者只暴露一个决策接口。
- Runtime 保留写库、claim/release、Adapter 执行、heartbeat 和 delivery 等副作用。
- 逐条迁入现有 admission、容量不足、失败落态和定时恢复策略；每迁入一条，同时删除原 Runtime 分支。
- 新增 `handoff_contract_failed` Kernel event，携带 attemptId、Subtask、WorkUnit、授权 completion contract 和全部 violations。
- 对该事件最多授权一次同 AgentClass 纠正 attempt，并把精确缺失 key、错误类型与完整 trailer 格式反馈给 Executor；第二次失败即 blocked，不做 fallback 或 backoff。
- `SessionExecutionCoordinator` 最终只驱动 decide/apply/observe 循环。

退出条件：当前已有战略行为均能通过 Kernel 决策测试，Session/Runtime 不再维护并行策略表。

完成记录（2026-07-20）：统一 Kernel event/snapshot/decision、ledger-first 同步控制循环、SQLite v23 decision ledger、只读 legacy Planning audit、`awaiting_decision`、确定性 capacity candidate switching、timer capacity recovery、outcome landing 与一次 response-only contract correction 已交付。旧 `PolicyKernel`、`TaskAdmissionGate`、多 Task Scheduler policy、`TaskResumePlanner` 和 Session 错误文本恢复策略已删除。`npm run lint`、`npm run build` 与 Docker/Linux 全量回归通过（176 个文件、715 个测试；另有 4 个文件、15 个 Phase 4/6 历史测试跳过）；真实 Linux Codex Planner→Kernel→Runtime→Codex Executor artifact smoke 通过。实现仍在当前工作树，尚未生成提交；Phase 3 两份计划已归档，Phase 4 激活。

### Phase 4：Recovery、fallback、retry 与熔断

目标：在统一 Kernel seam 上形成可持久、可测试的失败恢复状态机。

执行方向：

- 建立稳定 failure taxonomy，区分容量、基础设施、权限、能力不足、任务失败和质量失败。
- 增加 attempt 记录、retry cap、backoff/cooldown 和简单 circuit breaker。
- 按 `preferredAgentClassList` 实现顺序 fallback；candidate 切换只发生在前一 attempt 终止并释放后。
- 明确候选耗尽后的 replan、clarify、park 或终止策略。
- timer 只产生 Kernel event，不自行恢复任务。
- 对进程恢复、重复事件和 decision apply 建立幂等保证。

退出条件：失败、恢复、fallback、候选耗尽和熔断均由单一控制面决定，Runtime 不再通过正则或 if-else 私自拍板。

### Phase 5：Partition 模型在串行 Runtime 中落地

目标：先建立最终资源模型和执行防线，在仍然串行的环境中验证，再允许并发。

执行方向：

- 通过 ADR 固定 repository/worktree/path/logical resource/external object 的 partition identity。
- 定义 read/write access、父子路径覆盖、通配资源和外部对象冲突规则。
- Planner 提出资源 claim，Kernel 授权，Runtime 在执行范围和文件操作侧强制落实。
- 建立持久租约：owner、Task/Subtask/attempt、lease、heartbeat、等待关系和幂等 claim/release。
- 建立进程退出、WorkUnit 丢失、租约过期、取消和残留工作树的恢复清理规则。
- 明确何时创建独立 worktree/临时目录，以及产物如何归属和回收。
- 本阶段仍然串行执行，但 partition 字段必须真实参与授权和范围限制，不得只是未来占位符。

退出条件：partition key、冲突检测、持久租约、崩溃恢复和隔离机制均有 ADR、迁移和容器测试；并发尚未开启。

### Phase 6：异步并发调度

目标：在已验证的 DAG、Kernel 和 partition 模型上启用安全并发。

执行方向：

- 从 DAG 动态推导 runnable frontier，不增加 Planner 输出的 execution layer。
- Kernel 根据依赖、AgentClass 偏好、动态健康、capacity 和 partition lease 选择可同时 dispatch 的集合。
- 同层 Subtask 遵守首选 AgentClass 唯一和 partition 无冲突约束。
- Runtime 并发 claim/run，但继续保证一个 Subtask 只有一个 active attempt。
- 实现跨 Task 等待、公平性、饥饿保护、取消传播和任务关闭时的租约释放。
- 实现无冲突产物聚合、同文件冲突处理、dependency handoff 和最终结果的确定性合并。
- 覆盖进程崩溃、租约过期、重复唤醒和部分成功后的恢复。

退出条件：并发行为通过容器级竞争测试；相同 partition 不会并发写入；无冲突节点可以并行；结果和恢复行为确定且可审计。

## 六、无临时兼容层策略

- 每个阶段只保留一个当前 schema 和一条运行路径。
- Plan schema 升级时，历史已完成决策只作为审计记录，不重新授权执行。
- 未完成的旧工作图在升级点重新规划，不通过 optional defaults 或双 validator 继续运行。
- 不保留旧 routing 字段与新字段双写；阶段内一次性更新 Planner、Kernel、Runtime、存储和测试调用方。
- 不使用 feature flag 长期维持新旧 Kernel 决策链。
- 策略迁入 Kernel 的同一批修改必须删除 Runtime 中对应的旧策略分支和 fixture。
- 迁移只服务于持久领域数据；不得用数据库兼容字段代替明确的领域升级决策。

## 七、文档与计划管理

- 本文件是跨阶段总路线图，只记录依赖、全局不变量和阶段退出条件。
- 每次只为当前激活阶段建立详细实施计划。
- 每份阶段实施计划必须以 ADR-0020 为设计门，列明受影响模块与 owner、公开 Interface 及消费者、禁止依赖、要删除的旧跨模块入口、临时例外的最迟删除阶段，以及边界测试证据。
- 若阶段触及 `TaskRuntimeService`、`SessionExecutionCoordinator`、Planning 内部工作图规则、带 Repository 的 Kernel projector 或其他已知违规 seam，必须在同阶段收敛，或记录有明确删除阶段的例外；不得新增调用方。
- 阶段完成后更新本文件状态、验证和提交，再归档该阶段实施计划。
- 技术债文档只记录未被计划接管的问题；一旦被本路线图完整覆盖，转入 `docs/archive/tech-debt/` 作为历史问题记录。
- 旧的 [Planner 执行器能力边界与双执行器目录改造计划](../archive/plans/2026-07-15-planner-executor-capability-boundaries-and-demo-catalog-zh.md) 已由本路线图接管并归档。

## 八、Workspace partition 技术债覆盖确认

本路线图完整接管已归档的 [Planner 工作区分区与并发调度技术债](../archive/tech-debt/planner-workspace-partition-and-concurrency-debt.md)，对应关系如下：

| 原技术债事项 | 本路线图阶段 |
| --- | --- |
| Partition identity、覆盖与冲突 | Phase 5 |
| 持久租约、owner、heartbeat、幂等 claim | Phase 5 |
| 崩溃恢复与残留清理 | Phase 5、Phase 6 |
| Worktree/临时目录隔离 | Phase 5 |
| 并行结果合并 | Phase 6 |
| 跨 Task 调度、公平性和取消传播 | Phase 6 |
| Planner / Kernel / Scheduler / Runtime 授权职责 | Phase 3、Phase 5 |
| ADR、数据迁移与容器级竞争测试 | Phase 5、Phase 6 退出条件 |

因此该技术债不再作为独立 active debt 维护，归档后由本路线图的 Phase 5～6 追踪关闭。

## 九、总体完成条件

只有同时满足以下条件，才能将本路线图标记完成：

1. Planner 按 capability handoff 形成最小工作图，并遵守依赖和合并规则。
2. Executor 只执行当前 Subtask，一个 attempt 只绑定一个 WorkUnit。
3. Plan admission、dispatch、failure、timer recovery、fallback 和熔断均由 Kernel 控制面决定。
4. Partition claim、持久租约、隔离和崩溃恢复已经落地。
5. Runtime 可安全并发执行无依赖、无 partition 冲突的 Subtask。
6. 不存在新旧 Plan schema、路由字段或 Kernel 策略的并行兼容路径。
7. 所有阶段均完成文档回填、迁移验证、聚焦测试和完整 Docker 测试。
