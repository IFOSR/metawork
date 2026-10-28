# Kernel 兼容性中继与可选服务规格优化方案

- 日期：2026-10-28
- 状态：已实施（2026-10-28）；完成记录见文末
- 本次交付：方案、只读排查与 P0/P1 实施（运行代码、schema 61、前端投影与测试）
- 范围：Planner 提案、Kernel 兼容性边界、已完成 Task 的后续操作、Workspace 运行目标、本地服务规格与对话/轨迹状态一致性
- 关联：[ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md)、[ADR-0051](../adr/0051-service-identity-specification-revision-and-handover.md)、[ADR-0052](../adr/0052-executor-owned-tool-capabilities-and-kernel-boundary.md)、[ADR-0053](../adr/0053-planner-graph-coordinator-and-executor-authority.md)

## 背景

用户在同一 Conversation 中先生成一个 B/S 网站，再要求启动刚才生成的网站时，当前链路出现了两个相互叠加的问题：

1. 旧项目遗留的 `.metawork-service.json` 被当成当前服务规格；新网站没有独立的服务候选记录，导致服务目标错误绑定。
2. 第二个 Turn 被 Planner 表达成对第一个已完成 Task 的 `service_start` 控制。当前服务路径读到旧服务的 owner，Kernel 命中“来源 Task 为 `succeeded`、服务没有移交、服务 owner 与请求 Task 不同”的组合条件，拒绝启动。并非所有 `succeeded` Task 都会被拒绝。

数据库中的两个 Turn 是独立的，问题发生在“后续操作目标”的语义绑定和生命周期模型，而不是 Turn 持久化串线。

代码已有后续工作创建新 Task 的路径，但服务控制另外走引用旧 Task 的路径；两条路径的绑定与终态处理没有统一。引用旧 Task 来定位用户刚完成的产物本身没有问题，问题是把来源身份、当前执行身份和服务 owner 混用。既有测试不等于所有生产 follow-up 场景均已通过。

ADR-0053 已于 2026-10-28 接受“Planner → Work Graph → Durable Task Coordinator → Executor/Harness”的职责划分，生产工具权限路径已绕过 Kernel。本方案补齐服务操作、目标解析与状态投影的剩余缺口，不把既有权限路径迁移重新描述为待实施工作，也不把仓库源码视为已部署到用户运行实例。

## 目标

- Planner 负责理解用户意图和确定操作目标；只有存在不能从上下文解决的用户选择时才确认。Executor 可以自行检查 README、入口和配置，确定命令、目录、端口等实现细节。
- Kernel 作为兼容性中继和持久事实记录面，不再根据 Task 终态替用户否定明确的后续意图，不再决定一次性运行还是受管服务。
- 已完成 Task 的历史记录保持真实；Workspace 中的文件和运行目标可以继续使用、修改和运行。
- `.metawork-service.json` 成为可选的服务规格来源，不再是所有程序运行的硬门槛。
- 一次性运行、预览和长期受管服务共享同一个运行入口，差异通过用户意图和后续管理操作逐步形成，而不是由 Planner 先做不可逆分类。
- 对话、轨迹、TaskView 和执行时间使用同一组持久事实，避免一个界面显示排队、另一个界面显示完成。

## 目标行为

用户说“启动刚才的网站”时，系统按以下顺序处理：

```text
当前 Turn
  -> 读取当前 Conversation 的 Workspace、最近交付物和可运行候选
  -> 确定用户指向的项目；真实的目标歧义由 Planner 向用户确认
  -> 提交后续工作，关联来源 Task 与当前 Turn
  -> Kernel 记录并透传提案
  -> Executor 检查项目并确定启动方式；Runtime/Host 执行
  -> 记录运行句柄、状态、输出和时间
  -> 对话与轨迹共同读取同一份事实
```

旧 Task 只作为来源事实：

```text
sourceTaskId = 已完成的网站生成 Task
executionId  = 本次执行身份（可复用现有 Task/Attempt/operation 标识）
```

启动操作不改变旧 Task 的 `succeeded` 状态，也不要求旧 Task 重新变为 `running`。不增加强制的“service-operation Task”类别；修改、测试、运行均复用通用后续工作链路。

## Kernel 边界

Kernel 的战略决策、Task 终态阻断和服务类型判断退出主路径。Kernel 保留兼容入口，以便旧事件、旧决策记录和旧客户端继续工作，但新路径将其视为中继：

- 接收 Planner 已确认的结构化提案；
- 持久化提案、Turn、操作和执行关联；
- 将提案原样转交 Runtime；
- 记录 Runtime/Executor 返回的事实；
- 为旧客户端投影兼容的决策结果。

Kernel 不再因为以下原因直接拒绝用户的后续操作：

- 来源 Task 已经 `succeeded`；
- 当前操作是对已交付产物的启动、测试或预览；
- 请求没有 `.metawork-service.json`，但目标明确，Executor 能从项目取得运行方式；
- 系统无法自行判断一次性运行和长期服务的分类。

协调器保留协议结构、DAG、标识一致性、幂等、持久化和恢复所需的机械检查；Runtime/Host 负责实际进程、文件系统、网络、资源与凭证边界。发现技术错误时返回可修复的结构化事实，优先由 Planner/Executor 在本轮修正，不能把“信息尚未收集”直接当作拒绝用户意图的理由。

按 ADR-0053 延续兼容性迁移：旧 Kernel 接口、事件和决策账本可以保留，但不能继续担任语义决策或工具授权中心。持久协调职责保留在明确的 Coordinator seam；不将旧策略简单搬到另一个模块继续阻断。

## 已完成 Task 的后续操作

Task 状态描述历史工作是否完成，不描述产物是否失去使用价值。后续操作使用独立的操作身份：

```text
sourceTaskId
sourceGenerationId（可选）
workspaceId
targetPath
executionId（复用现有执行标识，不强制新增实体）
```

适用操作包括：

- 运行或预览已交付程序；
- 启动、停止、重启已有服务；
- 对已交付文件进行验证；
- 基于已完成结果继续修改；
- 生成后续交付物。

旧 Task 的结果、状态变化和交付记录保留历史；这不代表它曾修改的 Workspace 文件变成只读。新的操作可在同一 Workspace 内继续编辑文件并使用必要运行资源。

## 服务规格可选化

`.metawork-service.json` 继续支持明确声明长期服务的用户和执行器，但不再是唯一入口。

先确定目标项目，再在该目标范围内解析启动信息，优先级为：

1. 当前请求中的明确运行要求；
2. 目标项目的有效服务规格或与该项目明确关联的服务记录；
3. Executor 检查目标项目的 README、package scripts、入口文件和配置取得的运行方式。

来源冲突时结合当前明确意图和项目事实解决；只有影响用户目标且无法自行判定的选择才询问用户。不能把“缺少服务文件”直接升级为要求用户填写命令或端口。

目标和意图明确后，Executor 可以直接启动程序。Runtime 在创建进程时就记录实际句柄、目录、命令和所属执行身份；无需先猜测它属于“预览”还是“长期服务”。停止、重启、健康检查和恢复能力按需要使用这些事实，可形成内部服务规格，不要求写回用户 Workspace 文件。

因此：

- 有目标匹配且有效的 `.metawork-service.json` 时，作为启动信息来源，并记录实际使用的 revision；
- 没有时，Executor 仍可发现并执行项目启动命令；
- 文件过期、格式错误或目标不匹配时，返回诊断并继续检查目标项目，不直接终止用户任务；
- 无关旧规格不是当前目标的候选；不能回退到 Workspace 根目录任意旧服务；
- 不强制每个 Task 生成服务文件；
- 不允许旧 Workspace 根目录的服务文件覆盖当前项目的运行目标。

已有服务身份 `(accountId, workspaceId, serviceId)` 可复用；TaskId 记录来源或最近一次操作，不再作为用户能否继续使用产物的门槛。ADR-0051 的身份、revision 和移交事实继续可审计，服务复用或更新由当前操作驱动，不因来源 Task 已完成而拒绝。

## Planner、Runtime 与 Executor 分工

### Planner

- 识别用户是在修改、验证、运行、停止还是重启；
- 查询当前 Conversation 的 Workspace 和最近交付物；
- 选择目标目录和已有服务候选；
- 仅在上下文无法解决用户目标歧义时提问；
- 提交通用后续工作，关联当前 Turn、来源 Task 和目标项目；
- 不把“最近 Task”自动等同于“服务拥有者”。

### Kernel 兼容层

- 接收和持久化提案；
- 透传给 Runtime；
- 记录操作与执行关联；
- 投影旧协议所需的兼容结果；
- 不做新的语义拒绝和 Task 终态阻断。

### Runtime

- 解析并固定执行上下文；
- 检查 Workspace containment、资源和进程事实；
- 启动、观察、停止和恢复进程；
- 持久化运行状态、健康结果、日志尾部和时间；
- 创建进程时记录身份和实际启动参数，按需提供服务管理能力。

### Executor/Harness

- 检查项目、确定启动方式并执行程序；
- 自行处理技术探测、工具错误和可修复失败，不把普通实现细节推回用户；
- 保持自身工具和内部执行循环；
- 返回进程、输出和退出事实；
- 不决定用户是否可以继续使用已完成产物。

## 状态与轨迹一致性

对话中的任务卡片和轨迹中的 Task 卡片必须关联同一个执行实体，使用同一份持久状态投影。Turn、Planner、Task 和 Attempt 的完成分别命名，不能互相冒充：

- `queued` 只能在存在可追踪的入队事实时显示；
- 区分等待、执行、收尾阶段；执行阶段应有实际 Attempt 或进程开始事实；
- Task 成功由持久完成事实确认；Planner 返回、提案接受、Turn 回答结束不等于任务成功；
- 耗时注明口径：端到端耗时、排队时间、实际执行时间；同一口径使用同一实体和时间来源；
- 没有开始或完成时间时显示“尚未执行”或“暂无耗时”，不能用 0 伪装成实测值；真实不足一秒可显示“<1 秒”；
- 对话和轨迹的当前状态按单调 revision 更新；历史事件可以保留当时的 `queued`，但必须标明是历史事件，不能当成当前状态；
- 中继拒绝、提案接受、Runtime 执行和最终交付必须使用明确的阶段状态。

## 本次只读排查结果

本次未修改代码、数据库或运行中的 Server。对当前本地数据库和源码的核对结果如下：

1. 对话卡片的“已完成”和耗时来自 `conversation_read_turns.body_json` 的 Turn 投影。问题 Conversation 中，启动网站这一轮 `turn_TlQBC0HJN99R` 的 `status=completed`，`startedAt=2026-10-28T06:34:22.485Z`，`completedAt=2026-10-28T06:34:34.272Z`，所以它显示约 11.8 秒；它没有 `taskId`。
2. 该轮没有创建 Task 或 Attempt。`gateway_turn_task_observations` 对应行的 `taskIds=[]`、`completedAt=null`，进度只是“Planner completed the structured proposal handoff”；轨迹事件也只有 Planner/Kernel 阶段，最后一个事件是 `planner_agent_completed`。数据库当前没有与该轮相连的 queued Task。
3. Web 的对话投影使用 Turn 状态；存在 TaskId 时，`use-turn-presentation` 再用 `get_task_view` 的 Task 生命周期覆盖执行状态。轨迹视图则使用同一 Turn 的 trace，再按 TaskId 请求 `get_task_view` 和执行时间线。因本轮没有 TaskId，二者没有共同的执行实体可绑定。
4. 因而“对话已完成、轨迹排队中、耗时 0 秒”不能解释为一个 Task 真正同时处于两个状态。更可能是两套投影的混用：Turn 在 Planner 回答结束时被标记完成，而轨迹/会话活动仍展示了未关联操作或历史 `queued` 事实；没有截图和当时的前端响应，无法确定具体是轨迹页面、会话侧栏还是某个旧 Task 卡片。
5. 源码还存在两个会放大该问题的边界：`turnStatusFromTimeline()` 会把 Task 的 `queued` 映射成前端 `running`，而 `TrajectoryTimeline` 在缺少有效结束时间时以 `startedAt` 作为结束时间并显示最小 1ms，`TrajectorySummary` 对无效时间直接回退 `0s`。这说明“0 秒”可能是缺失/无效时间戳的显示回退，不代表真实执行耗时为零。

因此当前最可能的根因是：**Planner-only Turn 的完成事实、Task/活动投影和轨迹查询没有使用同一个 operation identity；提案被接受或 Planner 结束被误当成 Task 执行完成，而没有 Task 的轮次又允许另一侧保留 queued/空时间状态。** 这与“两个文件混在 Workspace”是不同层的问题，属于状态实体和投影绑定缺失。

后续修复应先为每个后续操作建立稳定的 execution identity，再让 Turn、Task/Attempt、轨迹和活动目录都引用它；若本轮没有执行实体，应显示“已完成规划/未启动执行”或“暂无耗时”，不能显示 Task 成功或 0 秒。所有状态更新还应携带同一 revision，并在终态后拒绝旧 queued 事件覆盖当前投影。

### 子任务状态记录带来的进一步审查

`.tmp/subtask-status-inconsistency-2026-10-28.md` 记录的是同一 Task 的另一种、证据更完整的状态裂缝。它支持“不同层投影不一致”的总判断，但需要修正前面的抽象：该案例并不是没有执行身份，而是同一个 `Task → Subtask → Attempt` 链上的 **Subtask 规范状态** 与 **Dispatch/Attempt 投影** 发生了冲突。

证据链是完整的：`st-site` 的 `subtasks.status` 为 `ready`，因为 Workspace 写租约冲突而等待重新调度；对应 dispatch item 却被写成 `terminal`，同时没有 `executor_attempt_receipts`、`executor_attempt_runtime`、WorkUnit 或 sandbox。也就是说，这个 Attempt 只被调度器启动过，实际 Executor 没有执行，更没有成功结果。DAG 读取 `ready`，显示“待执行”；执行卡片读取 Attempt 的 `terminal`，错误显示“已完成”，并用启动到关闭之间约 225ms 的调度时间显示 `0s`。

这里有三个相互独立的缺陷：

1. **执行事实缺陷**：`AttemptSupervisor.launch()` 在 `context.run()` 返回后无条件 `markTerminal()`。而 `wait_for_partition` 是让位/等待事实，不是执行成功事实；这条路径应保留为等待、取消或明确的未启动结果。
2. **投影语义缺陷**：`ExecutionProjector.displayAttemptStatus()` 将“无回执但 dispatch=terminal”映射为“已完成”，并把 `dispatch.status` 填入 `result`。前端 `LiveExecutionPanel.executionCardState()` 又让 Attempt 的“已完成”优先于 Subtask 的 `ready`，于是错误状态覆盖了规范状态。
3. **耗时口径缺陷**：`launch_started_at → terminal_at` 只反映调度尝试存活时间，不是 Executor 实际执行时间。没有 runtime/receipt 时，实际执行耗时应为未知，不能四舍五入为 `0s`。

因此，解决顺序应是先修状态契约，再修界面，最后处理并发策略：

1. 把 dispatch 的 `terminal` 定义为“该调度项不再活动”，不再隐含成功；成功必须由合法 receipt 的 `terminal_state=completed` 证明。无回执的让位项应回到可重调度状态，或明确标记 `not_started/parked/cancelled_or_stale`，并保留原因。
2. 让投影以 Subtask/Task 的当前规范状态决定卡片主状态，Attempt 只提供当前尝试的细节。无回执、无 runtime、无进度时不得显示“已完成”或“执行器已启动”；显示“等待资源/尚未执行/状态待确认”。
3. 分开记录排队时长、调度尝试时长和实际执行时长。实际执行时长只使用 runtime/receipt 的真实开始与结束时间；缺失时显示“—”或“尚未执行”，真实小于一秒才显示“<1 秒”。
4. 增加状态不变量和回归测试：`terminal + no receipt`、`wait_for_partition`、取消/恢复关闭旧 Attempt、旧 Attempt 与新 Attempt 并存，以及同一子任务在 DAG 和执行卡片中的投影必须一致。
5. 单独修正 Workspace 写租约与并行宣告：如果整个 Workspace 是单一写租约，系统不能宣称两个写子任务可并行；要么按路径细分租约，要么在调度层串行化并明确显示“等待资源”。这是产生本案例的调度原因，不应由 UI 用“已完成”掩盖。

这份子任务记录不能证明“对话 Turn 与轨迹没有共同 TaskId”是所有状态异常的唯一原因；它证明了另一条更底层的路径：即使 TaskId、SubtaskId 都正确，只要 Attempt 的终态契约错误，界面仍会出现“DAG 待执行、执行卡片已完成、耗时 0 秒”。因此完整修复需要同时覆盖 **执行事实契约** 和 **Turn/Task/Attempt 绑定** 两层。

## 实施顺序

### P0：运行目标和状态事实

1. 统一后续工作入口，分离来源 Task 引用与本轮执行身份。
2. 提供目标项目和实际运行记录的查询投影；缺少预登记不阻止 Executor 检查项目。
3. 将 `.metawork-service.json` 改为可选来源；缺失时允许 Executor 发现并执行启动方式。
4. 统一对话、轨迹和执行时间的投影来源，补齐开始/完成时间缺失时的状态规则。
5. 为“生成网站 → 下一 Turn 启动网站”增加端到端测试。

### P1：Kernel 兼容性中继

1. 保留旧 Kernel 事件和决策账本的读取兼容。
2. 新运行提案走中继路径，不因来源 Task 已完成而拒绝。
3. 将旧服务控制协议适配到通用后续执行路径，保留对历史 Task 的来源引用。
4. 按 ADR-0053 收敛协调与实际执行边界；不重新引入已移除的 Kernel 工具授权。

### P2：服务管理增强

1. 支持无用户服务文件的内部服务规格。
2. 根据实际进程记录提供停止、重启、健康检查和恢复能力，无需预先强分类。
3. 旧服务规格与当前项目不一致时排除旧规格；只有真实目标歧义需要用户确认。
4. 清理 Workspace 根目录残留服务文件造成的隐式发现路径。

## 验收场景

- 生成 `deliverables/ai-radar-site/server.js` 后，下一 Turn 说“启动刚才的网站”，系统能够定位并运行 `node server.js`，不要求旧 Task 重新变为运行中。
- 没有 `.metawork-service.json` 时，Executor 能从项目发现启动方式并执行，不增加形式化确认。
- Workspace 中存在旧烟花服务时，新网站不会继承 `fireworks-canvas-demo` 的命令或端口。
- 用户明确要求停止或重启时，系统使用本次运行操作或内部服务身份，不修改历史 Task 状态。
- 同一操作在对话和轨迹中显示相同当前状态与同口径耗时；覆盖实时更新、切换会话、刷新、历史回放和缺失时间戳。
- 提案被接受但启动失败、Planner 完成但 Task 仍排队等场景，不显示为任务成功。
- Planner 无法确定目标时先提问；Kernel 不替用户做语义拒绝。
- Server 重启或进程退出后，运行操作的状态、句柄和不确定结果可恢复或明确标记。

## 风险与取舍

- 迁移时需要保留事件身份、幂等和恢复事实；“透传”不等于删除持久协调或伪造成功。
- 无服务文件运行仍需记录真实命令与来源；README 和入口是可检查的工程证据，不能用无关旧项目代替当前项目。
- 内部服务规格减少了 Workspace 文件污染，但需要可靠的持久化和可读诊断。
- 旧客户端和旧数据库需要保留兼容投影；新路径不得把旧 `service_start` 语义继续扩大。

## 文档与 ADR 影响

本方案沿用已接受的 ADR-0053；实施时补充 ADR-0051 的可选服务规格和通用后续操作规则，更新旧 ADR 被取代部分的导航，并同步 `CONTEXT.md` 与中英文技术总览，避免把旧 Kernel 战略权限叙述继续当作现行目标。若公开契约、存储或恢复身份需要变化，应在具体实施设计中写明迁移和兼容测试。

本次仅完成方案文档，不宣称实现、部署或用户验收已完成。实施完成后另补完成日期、交付行为、验证证据和关闭提交；本次不创建提交。

## 完成记录（2026-10-28）

### 交付行为

- **通用后续操作身份**：`sourceTaskId` 只作为来源事实，服务操作的执行身份是本次
  decision/operation。`ManagedLocalServices.resolveServiceSpecification()` 成为启动类
  操作的唯一入口，`/service start`、Planner `service_start` 控制与发布后自动启动都
  走同一解析。Kernel 对 `managed_service_requested` 不再因来源 Task 终态拒绝，只保留
  Workspace 归属、登记身份、revision 与“代码是否已发布”的机械检查。
- **目标项目解析**：`src/execution/run-target.ts` 以 Task 已交付产物（入口文件或
  项目内服务规格）确定目标目录；Workspace 根目录的 `.metawork-service.json` 仅在
  Task 没有交付可运行项目时才是候选；多个候选返回真实歧义而不是猜测。
- **可选服务规格**：`src/execution/local-service-discovery.ts` 从
  `package.json` scripts/main 或入口文件发现启动方式并记录证据。契约来源
  `origin: 'manifest' | 'discovered'` 进入 revision；发现契约不声明端口与健康检查，
  Runtime 分配回环端口、仅在有端口时传 `HOST`/`PORT`，进程状态记为 `running`，
  公开视图不伪造 URL。目标项目内规格 / 该项目既有记录 / 发现结果的优先级已固化。
- **执行事实契约**：`kernel_dispatch_items.terminal` 明确为“该调度项不再活动”；
  schema 61 新增 `terminal_disposition`（`executed` / `not_started`）。
  `AttemptSupervisor` 对资源分区/容量让位调用 `markNotStarted()`，没有 receipt、
  Attempt runtime、Work Unit 或耗时。`ExecutionProjector` 的 Attempt 展示状态与结果
  改由 receipt + disposition 决定，并新增 `executionStartedAt` / `executionCompletedAt`
  区分调度尝试与实测执行窗口。
- **投影与界面一致性**：Subtask 规范状态决定执行卡片主状态，Attempt 只提供细节；
  缺失时间不显示耗时（或“尚未执行”），真实不足一秒显示 `<1s`；轨迹摘要分别显示
  端到端耗时与实际执行耗时；只有 Planner 的 Turn 显示“已完成规划，未启动执行”。
  服务端 `turnStatusFromTimeline()` 与 Web 侧逻辑对齐六态 Task。

### 验证

- `npx tsc --noEmit`（根与 `web/`）通过。
- 新增/更新聚焦测试：`tests/execution/run-target.test.ts`、
  `tests/execution/local-service-discovery.test.ts`、
  `tests/execution/managed-local-service-followup.test.ts`（真实进程：无服务文件启动、
  状态 `running`、停止、复用记录的契约、项目内规格优先、目标歧义拒绝）、
  `tests/execution/attempt-supervisor.test.ts`（让位记为 `not_started`）、
  `tests/management/execution-projector.test.ts`（receipt 驱动的状态与真实执行窗口）、
  `tests/storage/kernel-dispatch-disposition.test.ts`（schema 60→61 增量列与历史行保留）、
  `tests/kernel/control-kernel.test.ts`（终态来源 Task 不再拒绝后续服务操作）、
  `tests/web/turn-execution-presentation.test.ts`、
  `tests/web/trajectory-view.test.ts`、`tests/web/turn-task-presentation.test.ts`。
- 全仓 `npx vitest run`：4286 通过、53 失败；失败文件集合与实施前基线一致
  （`tests/kernel/control-kernel.test.ts` 由 14 项降至 13 项，其余文件相同），
  没有新增回归。既有失败属于此前 commit 留下的陈旧断言与 e2e 夹具，未在本方案范围内。

### 未关闭项

- 子任务记录第 5 条（整 Workspace 单一写租约与并行宣告的调度策略：按路径细分租约
  或调度层串行化）。本次让让位事实诚实可读（`not_started`、卡片“等待启动”、
  Task 原因“等待资源”），但同批 dispatch 仍可能宣告两个整 Workspace 写入子任务。
- 完整 Session 级“生成网站 → 下一 Turn 启动网站”端到端用例仍受既有 e2e 夹具失败
  影响，本次在 Runtime/Kernel 边界覆盖同一路径。
- 本次未创建提交；“关闭提交”在提交时补记。
