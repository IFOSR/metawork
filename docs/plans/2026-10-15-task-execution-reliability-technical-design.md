# MetaWork 任务执行可靠性技术方案

- 关联方案：[MetaWork 商业化前的任务执行简化方案](2026-10-15-task-execution-reliability-unified-plan.md)。
- 日期：2026-10-15。
- 状态：实施中（2026-10-15 用户授权）；阶段完成与发布验收分别记录。
- 基线：当前工作区源码。本文按当前 `TaskView`、`ControlKernel`、`KernelExecutionRuntime`、`SubtaskAttemptRunner`、`AttemptTerminalService`、`WorkspacePublicationWorker` 和 Planner v8 工作图契约设计。
- 验证范围：昨天的真实调研任务已经通过，不在本方案中重跑。

## 1. 技术目标

本方案只做一件事：让一次复杂任务可以稳定地拆开、执行、拼装和结束。

```text
Planner 提交工作图
  → Kernel 决定哪些 Subtask 可以开始
  → Runtime 启动一个已授权 Attempt
  → Executor 按原生方式工作
  → Runtime 保存结果和交付事实
  → Kernel 继续独立分支或启动依赖分支
  → TaskView 给所有页面一个一致的主状态
```

技术目标如下：

1. MetaWork 启动 Executor 时，使用已经授权的配置、协议、工具、工作区和权限；不因为 MetaWork 的包装改变 Executor 的能力。
2. 等待和失败只影响对应的 Subtask；不把局部问题扩大成整个 Task 的假阻塞。
3. 用户界面只显示四种主状态：等待中、执行中、需要处理、已结束。
4. Executor 的正常结果作为主要依据，MetaWork 只做身份、终态、声明交付物和下游输入的机械核对。
5. 结果保存失败和文件交付失败可以单独继续，不重新执行已经完成的业务工作。
6. 没有要求文件的任务不生成文件；没有要求文档的任务不生成文档。

本方案不建设第二个 Executor，不增加模型复评器，不把所有内部状态删除，也不把当前数据库表合并成一张新表。

## 2. 当前实现的事实和问题

### 2.1 已有的正确基础

当前代码已经具备以下基础，不需要推倒重来：

- `PlanningAgentPlanSchema` 的 v8 工作图有 `deliveryKind`、`artifacts`、`handoffs`、`acceptance` 和依赖边。
- `ControlKernel` 已有 `wait_for_capacity`、`wait_for_retry`、`block_work`、`resume_task`、`complete_task` 等决策。
- `KernelExecutionRuntime` 负责应用 Kernel 决策，Runtime 没有另起调度器。
- `SubtaskAttemptRunner` 负责一次 Subtask 的 claim、工作区、Executor 调用、结果解析和终态上报。
- `AttemptTerminalService.land()` 已在 SQLite 事务内保存 receipt、Subtask 结果、Publication 候选和终态事件。
- `TaskView` 已经从 durable facts 计算当前阶段，且知道 active Attempt、retry wake、publication residue 和 recovery residue。
- `WorkspacePublicationWorker` 已经区分内部 Git 集成和用户 Artifact 复制，只是当前完成顺序仍有缺口。
- `AuthorizedExecutorBinding` 和 `authorizedExecutorBindingFingerprint()` 已经把 AgentClass、Harness、Provider、Model、权限 Profile 和 configuration revision 固定下来。

### 2.2 当前真正需要改的地方

1. `TaskView.phase` 仍有 `queued`、`executing`、`retrying`、`waiting_for_plan`、`waiting_for_user`、`publishing`、`recovery_required`、`blocked` 等多个用户可见阶段。部分旧消费者仍直接看 `phase`、原始 Task 状态或 `canCancel`。
2. `wait_for_capacity` 已有 Subtask 作用域，但只有存在兄弟活动分支时才避免 Task 级阻塞；其他 `block_work` 路径仍可能把局部错误传成 Task 级状态。
3. `validateCompletionProtocol()` 在没有可解析报告时会合成 completed envelope 并认证成功。这违反“没有足够结果不能放行下游”。
4. `WorkspacePublicationWorker` 在事务中把 Subtask 置为 `done`、Publication 置为 integrated，随后才复制用户 Artifact；复制失败目前只写 warning。
5. `deliveryKind` 目前只有 `edit` 和 `report`。这不需要马上扩展：`report` 可以是文字结果，`edit` 可以是工作区修改；是否产生文档由 Planner 的交付声明决定。

## 3. 运行绑定：不做影子执行，只做启动前核对

### 3.1 绑定来源

当前生产绑定由以下链路产生：

```text
ConfigurationSnapshot
  → resolveRuntimePrivateConfigurationBinding()
  → AuthorizedExecutorBinding
  → bindingFingerprint
  → dispatch item / Attempt receipt
  → SubtaskAttemptRunner 启动 Executor
```

`AuthorizedExecutorBinding` 是本次授权的身份；configuration revision 是该身份背后的不可变配置版本。它已经包含：

- `agentClassRef`、`harnessRef`；
- `providerRef`、`modelRef`；
- `permissionProfileRef`；
- `configurationRevision`。

当前 fingerprint 由这些授权引用生成。它不是业务结果哈希，而是“这次按哪套配置执行”的身份。

### 3.2 每次任务启动前的核对

不在用户任务旁边再启动一个直接 Executor。生产只启动一次 Executor，启动前完成以下检查：

1. 从 dispatch item 读取 Kernel 授权的 `authorizedBinding` 和 `bindingFingerprint`。
2. 用 `runtime-private-binding-resolver.ts` 按同一 configuration revision 解析 AgentClass、Harness、Provider、Model 和权限 Profile。
3. 确认 AgentClass 仍启用，Harness 与 AgentClass 匹配，Provider/Model 属于该 revision，权限 Profile 仍存在。
4. 确认 `AgentRuntimeRenderer` 生成的 revision 目录存在；Pi 使用该 revision 的 `models.json/settings.json`，Codex 使用该 revision 的 `config.toml`。
5. 确认 Executor 工作目录、输入文件、handoff 目录和网络/权限规则来自当前 Attempt，而不是用户启动目录或最新未授权配置。
6. 再计算 fingerprint，与 dispatch item 的 fingerprint 比较；不一致则生成结构化 `configuration` 或 `adapter` failure，不启动进程。

Executor 启动后，Attempt receipt 继续保存授权绑定、fingerprint、实际模型身份和终态。这样可以回答“这次到底用了什么”，而不需要执行第二份任务作比较。

### 3.3 适配器测试只在发布前或适配器变化时运行

隔离测试不属于每次生产任务。对 Pi、Codex 和每个受影响协议，维护小型、无外部副作用的 adapter smoke：

- 读取一个输入文件；
- 写入一个临时文件；
- 执行一个受限命令；
- 返回一个文字结果；
- 需要网络时只访问测试端点或使用明确的 mock。

测试分别走“用户直接使用的 Executor 入口”和 MetaWork 正式启动入口，比较工具可用性、工作目录、权限边界和结果通道。测试只证明适配器没有改变能力，不把结果当作用户任务结果。配置协议、Pi/Codex 版本或运行适配器变更时必须重跑对应 smoke。

## 4. 四种主状态的技术实现

### 4.1 不删除内部状态

保留 `TaskLifecycleState`、Attempt lifecycle、Dispatch status、Publication status、Kernel application status 和 Lease 状态。它们分别负责生命周期、进程、交付、恢复和资源安全，不能混成一列。

新增一个由 Task Domain 拥有的展示枚举：

```ts
type TaskUserState = 'waiting' | 'executing' | 'needs_action' | 'finished';
```

名称只用于协议和代码；UI 文案映射为“等待中”“执行中”“需要处理”“已结束”。

### 4.2 `TaskView` 增加唯一主状态

`projectTaskView()` 继续读取现在的 durable facts，不新查数据库。新增：

```ts
interface TaskView {
  // 现有字段保留给详情、兼容查询和内部控制
  readonly phase: TaskUserFacingPhase;
  readonly lifecycle: TaskLifecycleState;

  // 新增，所有用户界面只读取它
  readonly userState: TaskUserState;
  readonly userStateReason: string;
}
```

`phase` 仍可用于执行详情的阶段时间线，但不能再作为活动列表判断“是不是还在运行”。`userStateReason` 使用已有 `explanation` 生成，不再让每个客户端自行拼接。

### 4.3 汇总规则

按当前事实执行固定优先级：

1. Task 已经 `completed`、`failed` 或 `cancelled`：`finished`。
2. 有 active Attempt，或有必须完成的 Publication/清理工作：`executing`。
3. 没有 active Attempt，但有 retry wake、queued dispatch、依赖等待或可运行的 Replan Job：`waiting`。
4. 没有自动推进者，但存在 blocked Subtask、uncertain application、权限请求、失败且需要人工决定的结果：`needs_action`。
5. 运行中的 Task 没有任何推进事实：`needs_action`，原因是“没有找到可以继续任务的执行记录”。

当 active Attempt 存在而另一个 Subtask blocked 时，主状态仍为 `executing`，原因附带“另有一个子任务需要处理，独立工作继续”。

当没有 active Attempt、只有容量等待时，主状态为 `waiting`，原因说明“等待执行名额”。当 Executor probe 返回 configuration/adapter failure 时，主状态为 `needs_action`，不能显示 waiting。

### 4.4 对外协议迁移

当前 `ConversationTaskSummary.phase` 和 `GatewayTaskViewLifecycle.phase` 已被多个客户端使用。采用兼容迁移：

1. 服务端先增加 `userState` 和 `userStateReason`，保留原 `phase`。
2. `ObservedActivity`、Dashboard、TUI、Feishu 和重连逻辑改为读取 `userState`。
3. `phase` 只留给详情时间线和旧客户端兼容，禁止新代码根据它推断活动。
4. 两个版本周期后，若所有客户端已迁移，再评估缩减旧字段；本次不贸然删协议字段。

`canCancel` 继续表示“当前控制请求是否允许取消”，不再参与 `userState` 计算。

## 5. 等待和局部失败的 Kernel 改造

### 5.1 `wait_for_capacity`

当前 Runtime 已对有兄弟活动分支的情况保留 Task 生命周期，并只记录 Subtask 等待。技术方案把这条规则变成统一前置条件：

- `wait_for_capacity` 永远首先记录 `subtaskId`、binding fingerprint 和唤醒条件。
- 有其他 active Attempt 时，不调用 Task 级 `blockTask`。
- 没有其他 active Attempt 时，可以复用现有 Task 级等待/Retry Wake 机制，但 TaskView 显示 `waiting`，不是 `needs_action`。
- capacity wake 只重新提交原 `taskId + subtaskId + generation + bindingFingerprint`，成功后只生成一个 dispatch。

### 5.2 `block_work`

`block_work` 需要明确是局部还是整体：

- 有 `subtaskId`：只把该 Subtask 转为 blocked，记录原因，随后提交一次 `dispatch_requested`，让 Kernel 继续检查独立 frontier。
- 没有 `subtaskId`：才允许 Task 级 needs-action，例如 Planner 无法继续、整个 generation 需要用户决策或全局资源安全无法确认。
- `block_work` 处理前检查当前 Task 是否仍有 active sibling；局部 blocker 不得取消或使 sibling Attempt stale。
- Runtime 不直接把局部 blocker 写成 Task 级错误；Task lifecycle 仍由 Kernel 授权转换。

### 5.3 失败后的自动恢复

保留当前 Kernel 的有限 `wait_for_retry`，但它只能用于明确可重试的网络、超时、基础设施或 heartbeat 失败。配置、权限、adapter、unknown 和外部非幂等不确定性进入 `needs_action`。

不新增 retry 类型。已有 Retry Wake 记录必须携带 Task、Subtask、generation、sourceAttemptId、bindingFingerprint、resumeAt 和 consumed 状态；重复 timer 或用户恢复由 Kernel inbox 幂等处理。

## 6. Executor 结果和完成判断

### 6.1 结果保存入口

继续使用当前链路：

```text
Executor adapter
  → SubtaskAttemptRunner
  → validateCompletionProtocol()
  → ResultObjectRepo / ExecutorAttemptReceiptRepo
  → AttemptTerminalService.land()
  → execution_outcome
  → ControlKernel
```

`AttemptTerminalService.land()` 仍是一次 Attempt 终态事实的事务入口。不得在页面或 Workspace 文件存在检查中直接写 Task 完成。

### 6.2 Completion Protocol 的最小修改

当前问题是 `!parsed.report` 会构造 completed envelope 并设置 certified。改为：

- 保留正文作为 safe/deliverable result；
- 把缺失或损坏的完成元数据记录为 `uncertified`；
- 不自动构造 certified envelope；
- 只有 Planner 声明的交付事实满足时，才允许下游 handoff 和 Subtask done；
- 正常文字回答可以没有文件；`edit` 任务需要的 workspace delta 仍按其声明核对；
- 不把“调用过工具”作为全局成功条件。

`CompletionAssessment` 的三轴继续使用，不新增第二套 assessment。格式问题和交付事实不足仍区分：格式问题可以有限 metadata correction；交付事实不足不能靠改写 trailer 变成成功。

`SubtaskAttemptRunner` 在主成功路径和 correction 路径都把同一个 assessment 写入 receipt，不能出现成功 receipt 的 `completionAssessment` 为空。

### 6.3 不强迫所有任务生成文档

> 2026-10-15 用户试用审计：以下是目标契约，尚未全部实现。当前只验证了无文件结果可以完成，未落实按声明约束文件生成与复制；详细缺口见文末“按需交付目标审计”。

当前 `deliveryKind` 只有 `edit/report`，实施不先改 schema。具体规则：

2026-10-15 审计后的最小修订（ADR-0032）：现有 `artifacts` 是结果字段，不能代替 Planner 声明，因此新增必填 `fileOutputs: string[]`，不新增 delivery kind。`[]` 表示无文件交付；相对文件路径或以 `/` 结尾的专用目录表示必须存在的文件。SQLite schema 50 持久化此声明；历史授权保留 NULL，不推测旧任务意图。下列早期规则中的“Planner artifacts 声明”由 `fileOutputs` 明确实现。

- `report` 的 body 可以直接作为文字答案；只有 Planner 的 `artifacts` 或 handoff 明确文件时才需要文件。
- `edit` 以 workspace delta 和指定 artifact 为准；不额外要求 Markdown 报告。
- 外部动作的完成依据是 Executor 返回的动作结果和已有回执；没有文件声明就不复制文件。

如果后续发现某类交付无法用现有 `artifacts`、`handoffs` 和 workspace facts 表达，再提出最小 schema 修订，不在本轮预先增加 delivery 类型。

## 7. 文件交付顺序

当前 `WorkspacePublicationWorker` 在一个 SQLite 事务里先将 Subtask 和内部 Publication 标记完成，之后调用 `publishUserArtifacts()`；用户文件复制失败只打印 warning。改为明确的两个阶段：

### 阶段一：内部成果已集成

- Git merge 成功；
- Publication 记录 `integrated`；
- 安全结果和内部 Artifact 可供查看；
- 必要的用户文件复制尚未完成时，不将 Subtask 视为最终完成。

### 阶段二：用户交付已完成

- 根据 Publication 的声明 artifact 集合逐项复制；
- `UserArtifactPublicationService` 返回 projections 和 failures；
- 每个 failure 写入持久的 Publication delivery fact，不只 `console.warn`；
- 重复执行按 task、publication、relative path、content hash 幂等；
- 全部必需 artifact 成功后，再由 Kernel 完成 Subtask/下游 handoff。

现有 `workspace_publications` 记录若无法表达 delivery failure，需要最小增加 delivery 状态或独立 delivery fact。不能把失败塞进 warnings JSON，因为 Kernel 和启动恢复必须能查询它。

文件系统复制与 SQLite 不能假装成一个原子事务。复制前持久化 pending，复制后记录 hash/projection，崩溃重启时根据 publication、目标路径和 hash 继续；只补失败文件，不重跑 Executor。

## 8. 唯一恢复入口

### 8.1 控制链路

继续复用：

```text
Web/TUI/Feishu
  → Gateway slash command `/task resume <taskId>`
  → ConversationSession mailbox
  → Kernel task_resume_requested
  → Kernel resume_task decision
  → KernelExecutionRuntime apply
  → dispatch_requested / delivery retry / result landing
```

不新增 `retry_all`、`recover_again` 或页面直写 Task 的路径。

### 8.2 Runtime 选择动作

`resume_task` 不靠文案猜原因，读取当前 durable facts：

1. 有未完成的 delivery fact：只提交交付恢复；
2. 有可安全重放的终态保存：重放原 Attempt 结果；
3. 有失败且可重新授权的 Subtask：只恢复该 Subtask；
4. 有未完成依赖：等待前置结果，不立即启动下游；
5. 有未知外部副作用：进入 needs-action，要求核对或用户确认；
6. 已完成或已取消的 Subtask 不重跑，已取消 Task 不复活。

每个恢复请求绑定 Task、generation、graph revision 和 requestId。旧卡片恢复新 generation 时拒绝；重复 requestId 返回已有控制结果。

## 9. 代码改动清单

### 9.1 TaskView 与对外投影

- `src/task/task-view.ts`：增加 `TaskUserState`、`userState`、`userStateReason` 和统一汇总函数。
- `src/session/conversation-activity-types.ts`：`ConversationTaskSummary` 增加两个字段。
- `src/gateway/task-view.ts`：`GatewayTaskViewLifecycle` 增加两个字段，保留 `phase`。
- `src/management/execution-projector.ts`、`src/gateway/task-view-facts.ts`：只从 `TaskView` 映射，不另算用户主状态。
- `web/src/observation/task-activity.ts`、`ObservedActivity.tsx`、Workspace controller：按 `userState` 判断活动和按钮。
- TUI/Feishu 对应 summary adapter：使用相同字段。

### 9.2 Kernel 与 Runtime

- `src/kernel/control-kernel.ts`：检查局部 `block_work`、capacity wait、retry wake 的作用域和 generation 约束；不新增决策类型。
- `src/execution/kernel-execution-runtime.ts`：局部 blocker 只触发独立 frontier 重评估；统一 capacity wake 和 resume 的幂等键。
- `src/account/account-startup-recovery-service.ts`：恢复 delivery pending、uncertain application 和失败 receipt 时，使用相同 TaskView/Kernel 事实，不自定成功状态。

### 9.3 Executor 结果和发布

- `src/execution/completion-protocol.ts`：缺少报告不再 certified；保留安全正文；现有 `CompletionAssessment` 继续使用。
- `src/execution/subtask-attempt-runner.ts`：主路径/correction 路径保存 assessment、binding 和结果引用；不重复业务执行。
- `src/execution/attempt-terminal-service.ts`：保持终态事实事务入口，补充 delivery 前置事实关联。
- `src/execution/workspace-publication-worker.ts`：将用户文件交付失败变成可查询、可恢复事实。
- `src/delivery/user-artifact-publication-service.ts`：保留幂等复制，返回结果必须进入持久发布状态。
- `src/storage/workspace-publication-repo.ts` 及 migration：只有当前表无法表达 delivery pending/failed/succeeded 时才做最小迁移。

### 9.4 运行绑定

- `src/configuration/runtime-private-binding-resolver.ts`：启动前完整解析并校验授权绑定。
- `src/configuration/agent-runtime-renderer.ts`：提供 revision runtime manifest 或等价可核对事实。
- `src/executor/pi-cli-driver.ts`、Codex adapter：报告实际启动协议、程序版本和工具入口，失败时返回结构化 adapter/configuration failure。
- `src/execution/subtask-attempt-runner.ts`：在创建 Executor 进程前完成 binding/fingerprint 核对。

## 10. 存储与兼容策略

原则是先复用现有字段，只有事实无法保存时才迁移。

优先复用：

- dispatch item 的 authorized binding、fingerprint、generation；
- attempt receipt 的 terminal state、failure、assessment、resultId；
- publication 的 candidate/integrated/pending/conflicted 状态；
- Retry Wake 的 source decision、wake time 和 consumed 状态；
- TaskView 从这些事实重新计算主状态。

可能需要的最小新增事实：

1. `user_artifact_delivery` 的 pending/partial/succeeded/failed 及逐项 hash；
2. Executor runtime manifest 的 hash 或受保护的绑定诊断；
3. TaskView 对外 `userState` 字段只属于 wire projection，不需要数据库列。

旧记录兼容规则：历史成功 receipt 不重写；缺少 assessment 的旧记录标为“历史记录，无新核对”，不自动补认证；旧 publication 没有 delivery fact 时只按已有历史状态读取，不伪造新的用户交付成功。

## 11. 测试设计

### 11.1 单元和 Kernel 测试

- `projectTaskView`：active sibling + blocked sibling → `executing`；只有 capacity wait → `waiting`；无 driver 的 running Task → `needs_action`；终态 → `finished`。
- Kernel：局部 `block_work` 不改变独立 Subtask 的 dispatch；Task 级 block 只在没有 subtask scope 时发生。
- capacity wake：同一 wake、timer 和手工 resume 只产生一个 dispatch。
- completion protocol：无 trailer 有安全正文 → 可展示但 uncertified；无声明文件的文字回答可完成；声明文件缺失不放行。
- binding：revision、protocol、model、permission 或 runtime manifest 不匹配时 Executor 不启动。

### 11.2 集成和故障注入

- `AttemptTerminalService` 重复 landing 同一 Attempt；结果只落一次。
- Executor 退出后终态保存失败；重放结果，不启动第二个 Executor。
- Git 集成成功、用户文件复制失败；状态为需要处理，恢复只复制文件。
- 复制后崩溃；重启检查 hash 后继续，不重复登记。
- 一个 Subtask capacity wait、一个 active、一个 dependency wait；只启动可运行分支。
- 一个 Subtask adapter failure、一个兄弟正常执行；兄弟不被取消。
- 取消、timer、resume 和迟到结果同时到达；取消优先，旧结果不能复活。

### 11.3 客户端测试

- Conversation activity、Dashboard、Task detail、TUI、Feishu 和重连都读取 `userState`。
- `canCancel=false` 不再意味着“没有运行”；`canCancel=true` 也不再意味着“正在运行”。
- 查询、新消息和恢复命令在 `needs_action` 时仍能完成。
- 只有 Planner 声明了文件时才显示文件交付；回答、代码修改和外部动作不生成额外文档。

## 12. 实施顺序与发布门槛

实施顺序固定为：

1. 先补 binding 启动前核对，确认 MetaWork 没改变 Executor 能力。
2. 再增加 TaskView 四种主状态，并迁移所有用户界面。
3. 再修正局部 wait/block 的 Kernel/Runtime 作用域。
4. 再修正 Completion Protocol 的错误认证和 Publication 的交付顺序。
5. 最后删除重复状态判断，补故障注入测试和兼容读取。

商业化版本的硬门槛：任一核心场景失败，都不能发布：

- Executor 接入条件与直接调用不一致；
- 独立分支被局部等待或失败拖住；
- Executor 已退出但界面仍显示执行中；
- 无结果或无声明交付物却显示完成；
- 文件交付失败却显示普通完成；
- 恢复重复执行或复活已取消任务；
- 受影响测试有未解释的红灯。

本文完成后仍需补写：实际代码改动、迁移版本（如有）、测试结果、平台限制、DMG 版本和收尾提交。技术方案文档本身不代表实现完成。

## 13. 实施记录（2026-10-15，进行中）

基线为用户已有未提交修改，保留既有恢复、Provider 和客户端修复。未提交、未推送、未替换用户安装。主机 Node 22.23.3；初始 `npm run lint` 通过。

阶段设计门：

| 阶段 | 唯一 owner / 接口 | 迁移与验证 |
| --- | --- | --- |
| 1 | Configuration 解析 revision；Executor 适配器核对启动事实；Runtime 核对 dispatch 指纹 | 删除固定 revision 被模板覆盖的路径；原生 CLI 对照与绑定漂移注入 |
| 2 | Task Domain `TaskView.userState`；客户端只投影 | 迁移各客户端的 phase/canCancel 活动判断；端到端重连 |
| 3 | Kernel 决策等待/阻塞；Runtime 应用授权 | 删除局部 blocker 的 Task 级冻结；并发/唤醒/故障注入 |
| 4 | Runtime 终态/交付事实；Kernel 决定后续；Storage 适配持久化 | 删除自动认证与交付失败 warning-only；保存、交付、重启竞争 |
| 5 | Application Shell 唯一恢复入口 | 复核重复入口和所有关闭条件，跨客户端和平台验收 |

依赖方向保持 ADR-0020：客户端不写 Storage，Kernel 不读文件或 Repository，Executor 不决定任务生命周期。没有新增第二调度器或第二恢复协议。没有新增架构临时例外。

阶段 1–4 已实施，阶段 5 正在进行；发布门尚未关闭。Docker 命令当前不可用，容器验收需要另行记录，不能以主机测试替代。

### 阶段 1 验证与 review

- 已修正 dispatch 指纹重算、固定 revision 配置优先级、生成配置逐文件 SHA-256 核对与启动清单。清单保存程序版本、绑定、协议、模型、输入/工作区与目标 hash，不保存凭据值。
- 主机相关 7 个测试文件 / 114 项通过；原生 Pi 1.2.0 与 Codex 0.160.0 分别以直接入口、正式 LocalCliExecutorAdapter 入口运行，实际进程读取输入、写文件、执行命令、返回结果。测试只模拟本地 Provider 响应，不模拟 CLI/工具。
- 配置文件被替换的故障注入通过：无 Provider 请求、无业务进程执行。脚本：`METAWORK_EXECUTOR_PARITY=1 npx vitest run tests/e2e/executor-runtime-parity.test.ts`（2 项通过）。
- Review：阶段运行链核对已落地；发布阶段仍需补齐其他受影响协议、容器路径和用户安装验收。不声称真实供应商或 Docker 已通过。阶段 2 开始。

### 阶段 2 验证与 review

- Task Domain 新增四态与原因；Conversation activity、Gateway TaskView、Timeline 增量提供字段，Web/TUI Dashboard/飞书活动消费统一字段；内部 phase 保留。旧活动缓存重建，不做客户端文案猜测。
- 8 个相关测试文件 / 86 项通过；Web build 通过；真实生产 Server + Chrome 的 needs-action/输入可用/重连验收通过；10/100/1000 Turn 浏览回归通过；TUI 观察与概览 10 项通过。
- Review：陈旧 running dispatch 有终态 receipt 时不再算活跃进程；终态优先。浏览器 fixture 的 Workspace 与 runtime 目录重叠已修正。
- 未关闭：Pi 全仓 `npm run check` 发现基线 5 warnings/12 infos；命令自动格式化的无关文件已恢复，仅保留本次修改。TUI 完整编译/界面与真实飞书验收仍需阶段 5 复核。

### 阶段 3 验证与 review

- 局部 block 保持既有 Kernel/Runtime 唯一控制链；修复已 blocked 的依赖目标反复 block、configuration/adapter 自动 fallback、局部容量等待的 application 后置条件，以及失败分支阻挡独立成果发布的问题。
- 5 个 Kernel/Runtime/Session 文件 102 项通过；完整 Session→Kernel→Runtime→终态/发布链故障注入验证独立分支完成、配置失败不重试、重复 timer 不重跑，连同 capacity/retry 端到端控制循环共 3 项通过。
- Review：新增容量等待事实供 TaskView 投影 waiting；仍使用原有 wake 和 inbox 幂等键。没有新增调度器。文件发布最终完成顺序进入阶段 4。

### 阶段 4 验证与 review

- 删除无 trailer 自动 certified、Attempt 提前复制文件以及 correction 绕过 publication 的路径。safe body 留在 Result Objects，缺少必要事实不放行下游；仅格式问题可以有限补写元数据。
- schema 49 保存 Publication delivery pending/failed/succeeded、逐项 projection/hash/failure。Git 集成和 pending 同事务；文件复制与 SQLite 分开，成功后才发布 handoff/Subtask done。复制从固定 integration commit 的临时快照读取，避免后续独立发布替换待交付字节。
- 7 个定向测试文件 84 项通过，含迁移回滚、协议、终态、发布/取消以及 Docker schema 配置静态检查。真实 Session→Kernel→Runtime→Git→文件系统端到端 4 项通过：复制失败、运行时重建、复制后保存前中断、取消；重复 resume 不重跑 Executor、不重复 Git merge、不重复 artifact 记录。
- 部分交付恢复保留已成功文件的 artifact identity/hash；不存在的 artifact handoff 保留正文但不认证。修复 macOS `/var` 与 `/private/var` 路径别名导致文件被静默漏交付的问题。
- Review：没有新增调度器/恢复协议。历史 publication 不回填 delivery，不自动重发。源代码路径通过；跨平台及安装版本验收继续作为阶段 5 门禁。

### 阶段 5 源码 review 与平台验收（发布门未关闭）

- `/task resume` 增加可选 generation/revision fence，命令层固定读取时的任务图，Kernel 拒绝旧卡片，Runtime 应用时二次核对。Web 继续使用相同 slash-command 入口。
- 删除 missing-marker → business continuation 的恢复分支；metadata correction 保留原始正文与 workspace，交付事实不足不得靠 trailer 修复。
- 扩大回归首次 349 文件 / 2319 项：2300 通过、16 失败、3 跳过。逐项修复测试替身/迁移夹具/旧行为预期；发现真实长路径 evidence ID 碰撞并修复，不以跳过测试隐藏失败。
- 最终 review 补齐三处约束：手动 metadata correction 同样核对 AgentClass 支持、128 KiB 输入上限、单次预算与 payload；外部非幂等未知结果不得经 orphan dispatch 继续业务；必需 artifact handoff 缺失不能被安全正文代替。
- 容器补齐镜像内 `--version` 探测和启动清单：探测无 Task 挂载、网络和凭据，15 秒超时并清理探测容器；实际业务使用相同不可变 image ID，消除 tag 在 inspect/create 之间漂移。容器健康不再取决于主机是否安装 CLI。适配器和 Docker command-runner 定向 12 项通过，真实 Docker 仍未验收。
- Pi 全仓质量收尾：删除无用局部变量/构造器，修正 undici 与 Gateway receipt 测试类型，旧扩展示例改用现有 Editor/CancellableLoader；没有恢复 standalone TUI。按既有 check 命令规范化格式/导入，740 文件检查最终无错误、warning 或 info。相关 3 文件 64 项及 6 文件 76 项通过；历史 standalone package 套件仍由原有产品边界配置排除，未新增跳过。
- 飞书 progress card 终态改为 `userState === finished`，删除 `canCancel` 终态判断；恢复 action cursor 固定 generation/revision。TUI 不生成旧恢复卡片，手工 slash command 在服务端捕获当前图身份；Web 恢复按钮携带观察到的身份。
- Web build、Pi offline build、根 TypeScript lint 与根 bundle 通过。生产 Server + Chrome 状态/输入可用/重连和 10/100/1000 Turn 浏览 2 项通过；TUI 最后变更的 3 文件 42 项通过，含 80/120 列交互与任务切换。
- Git merge 和 delivery 期间取消的 publication seam 注入通过；Session 全链路交付 4 项通过；部分交付 service 重建后保持已成功文件的 ID/hash。没有将直接修改 Task 状态、绕过取消控制链的人工夹具作为 Session 端到端通过证据。
- 最终完整根测试结果见下方验收表。初次完整运行的两个失败均已修复：Task8 schema hash 夹具过期，飞书夹具缺少统一状态字段；未放宽业务断言或跳过失败场景。
- 收尾提交：未创建。工作区包含用户既有的大量未提交修改，未将混合修改提交、推送或发布；最终验收记录与源码变更保留供审阅。

### 最终验收边界

| 验证 | 结果与范围 |
| --- | --- |
| 根全量测试 | 最后源码 `npm test`：546 文件通过、16 文件按环境跳过；3616 项通过、30 项跳过，零失败（97.82 秒）。包含“文件已 rename、artifact row 未保存”的 hash 核验与恢复、容器版本探测/清单、Session 交付 E2E；最终根 lint/bundle 通过 |
| 原生 Executor 对照 | 4 项通过：Pi 1.2.0 Chat Completions/Responses/Anthropic，Codex 0.160.0 Responses；真实 CLI、文件、shell 与本地 HTTP，模拟模型端点；配置篡改在业务请求前拒绝 |
| Web | build 通过；生产 Server + Chrome 2 项通过，含 needs-action 下输入可用和重连 |
| TUI | offline build 通过；本次受影响的显示/交互/overview 最后 42 项通过；此前其他 TUI 专项通过 |
| 飞书 | production bridge + durable delivery E2E 通过；会话端口与 E2E 共 15 项通过；新增测试核对 `canCancel=false` 仍保持 needs-action 卡片活跃和旧卡片恢复身份 |
| Desktop 源码 | lint 和 7 文件 17 项测试通过，Desktop build 通过 |
| 临时原生安装 + Electron | 最后源码构建后，`SourceNativeInstaller` 在 `/tmp/mw-reliability-ITDC6y` 安装 `reliability-20261015`；真实 Electron 约 1941 ms 就绪，macOS 名称/bundle identity、本地会话、10 次重连、渲染崩溃恢复、900/1100/1440 宽度和 200% 缩放通过；无 pageerror，退出后 Server 存活，已显式停止测试 Server。证据在该临时根的 `evidence/electron-smoke.json` |
| 安装测试限制 | 首次默认 macOS 临时路径过长触发 104-byte Unix socket 限制，改用短 `/tmp` 隔离根后通过。Electron 文件对话框与下载 HTTP 为测试替身；没有登录官方账号或运行付费供应商任务 |
| Docker / Windows | Docker 命令不可用，真实容器及 Windows 未运行；已实现镜像内程序版本探测和清单并通过定向测试，仍需真实 Docker 验收。schema 49 Docker 配置静态检查不能替代此验收 |
| DMG / 用户安装 | 2026-10-15 已生成本地 arm64 内部试用 DMG，完整性、ad-hoc 签名、包内清单及隔离首次安装通过；未 Apple 公证、未对外发布、未替换用户现有安装。详见下方试用包记录 |
| Pi 全仓质量检查 | `npm run check` 全部通过：Biome 740 文件无错误/warning/info，pinned-deps、ts-imports、shrinkwrap、全仓 tsgo 和 browser-smoke 通过。此前发现的格式、无用变量、旧示例导出和测试类型问题已关闭；offline build 同样通过 |

可复跑入口：`npm run lint`、`npm test`、`METAWORK_EXECUTOR_PARITY=1 npx vitest run tests/e2e/executor-runtime-parity.test.ts`、`RUN_BROWSER_E2E=1 npx vitest run tests/e2e/task-user-state-browser.test.ts tests/e2e/production-observation-browser.test.ts`。Pi 在独立依赖树运行 `npm run build:offline`；指定 TUI 测试从 `packages/coding-agent` 用本地 `node_modules/vitest/vitest.mjs --run` 执行。Electron 使用 `METAWORK_DESKTOP_DEVELOPMENT_ROOT=<临时安装根> node apps/desktop/tests/electron-smoke.mjs`。

Review 结论：阶段 1–4 核心行为及阶段 5 源码收敛已交付，已发现的源码测试/质量问题关闭；平台发布门尚未全部关闭，不能标记整个方案完成或发布商业化稳定版本。下一次验收必须补齐 Docker/真实飞书/正式安装平台；不能以已有主机通过记录代替。

### 本地 DMG 试用交付（2026-10-15）

- 用户要求自行安装试用。产物：`Release/MetaWork-0.1.15-internal-reliability-20261015-darwin-arm64.dmg`，447,832,895 bytes；release ID `0.1.15-internal-reliability-20261015`，Desktop 版本 0.1.15，schema 49。
- 使用当前工作区已验证的 Runtime/Web/Planner 构建；在独立 staging 剔除开发依赖，重新生成完整 PDF 资源，经正式 Runtime/Planner archive → Desktop payload → electron-builder 路径打包。清单为 preview channel、development=true，临时开发签名密钥未进入产物。sourceCommit 记录基线 `e165b3979bcfd5428ecfa03401dd8cb3a22507e3`；该包包含未提交修改，不声称对应干净提交。
- `hdiutil verify`、`codesign --verify --strict` 和挂载后 `verifyDesktopRelease` 全部通过；38,753 个 payload 文件逐项校验，应用架构 arm64，identifier `com.metawork.desktop`。ad-hoc 签名，未做 Apple Developer ID 签名或公证。
- 使用包内 Pi 1.0.0 补跑三种协议与主机 Codex 0.160.0 Responses 对照：4 项全部通过（真实 CLI、文件、命令、本地 HTTP，模型端点为替身）。此前主机 Pi 1.2.0 的记录仍独立保留。
- 从只读挂载 DMG 的应用运行 `apps/desktop/tests/packaged-install-smoke.mjs`，独立根 `/tmp/metawork-install-m45BOh`，HOME 隔离、PATH 仅 `/usr/bin:/bin`。首次安装、本地会话认证、空配置保存、设置激活无需重启、失败配置保留旧状态、菜单、Web reload、退出后 Server 存活均通过；无开发凭据导入，未执行付费模型任务。脚本已停止测试 Server，DMG 已卸载。
- 验证材料保存到 `Release/reliability-20261015-evidence/`；安装说明与同名 `.dmg.sha256` 随包提供。SHA-256：`1476fc6fa4523d9f1d5b9e9478c45afad5eebdd1b468c096ea38a6c4753123aa`。
- Review：本地试用打包及首次安装门已关闭；用户已有安装升级、真实供应商、Docker、真实飞书和正式签名发布门继续待验收。没有修改用户现有安装，也没有创建收尾提交。

### 用户试用跟进：PPT 执行详情重复（2026-10-15）

- 用户安装 `0.1.15-internal-reliability-20261015` 后启动“抽象 MetaWork × 企业主权AI 要素并生成 3 页商业化宣讲 PPT”。只读核查实际运行数据：一个 dispatch、一个 primary attempt；18:23:59 开始，18:58:05 Task done，Attempt completed、Publication integrated、Delivery succeeded，无交付失败。14 个已发布文件逐项 SHA-256 核验通过，主 PPT ZIP 无损坏且恰好 3 页。这是用户发起的真实任务观察，不是代理重新登录或重新派发的测试。
- 截图成对进度是 Web bug：`ExecutionDetailDrawer` 同时合并 trace 与 runtime history，用独立生成的毫秒时间戳去重，导致同一活动显示两次。实际 CLI 在核查来源、改文案、生成与验证 PPT，不是 Kernel 反复派发；不能仅凭 processing cycle 文案判断无限循环。
- 修复：同一 attempt 有进度 trace 时以 trace 为展示来源，尚未加载该 attempt 的 trace 时才使用 bounded durable history。保留真实重复工具调用，不按文案合并不同执行事件，不修改调度或中断用户工作。
- 验证：4 项回归覆盖毫秒偏差、真实重复活动、多 attempt 隔离、trace 到达/重连与 details identity；连同现有界面检查 15 项通过，根 lint、Web build 通过。真实任务安全投影的 Chrome 回放：80 条 trace，旧逻辑额外产生 20 条重复，新逻辑为 0；history fallback、trace 到达、reload 均通过，无 pageerror。证据：`.tmp/progress-detail-20261015/browser-evidence.json`、`task-completion-evidence.json`。
- Review：该显示修复已落源码，尚未重新打包或替换用户正在使用的 DMG。任务真实执行约 34 分钟的耗时不因显示修复缩短；本次未引入轮数上限或新的恢复策略。平台验收矩阵仍未全部关闭，未创建收尾提交。

### 用户试用跟进：相邻任务输入与路由大小（2026-10-15）

- 改版 PPT 任务的 Planner 已选中同一会话上次任务的 5 个产物，Runtime 也已核验并复制到本次 `inputs/`。Executor 的工作目录是相邻的 `files/`，旧 prompt 只有输入目录内的文件名，没有可从工作目录直接读取的路径；模型因此猜路径并执行 `find /`。这是输入说明缺失，不是缺少历史产物或需要用户重新上传。
- 修复：唯一 prompt renderer 为历史 Artifact 和当前 Attachment 同时提供 `readPath`，明确输入目录与工作目录关系、输入只读、缺失须报告且不得全盘搜索替代源。容器适配器先映射 `/workspace`、`/inputs`，不把主机布局用于容器 prompt。保留 Planner 选择、Kernel 验证、Runtime 物化的所有权边界，没有新增文件搜索器或语义路由。
- 路由失败来自本地 `SPAN_MAX_REQUEST_BYTES = 32 * 1024`，不是供应商的 32K token 窗口。实际固定 revision/proposal 回放为 7 个候选、39,771 个预算字节；上限提高到 128 KiB 后完整通过。保留候选/并发/截止时间约束，超过新上限仍明确回退，不删除合法候选凑预算。Web 文案明确本地限制且模型尚未调用。
- 验证：6 文件 96 项定向测试通过，覆盖路径、Windows 布局、容器映射、真实物化、候选边界与 Session 准备；包内 Pi 1.0.0 三协议和 Codex 0.160.0 Responses 真实 CLI 端到端 4 项通过，读取工作目录相邻的历史输入副本。端点为模拟模型，不能当作真实供应商决策成功证据。根 lint/bundle、Web 与 Desktop build、`git diff --check` 通过。实际请求回放证据：`.tmp/routing-input-audit/replay-evidence.json`。
- Review：未修改运行中 Task、历史绑定或数据库；新 prompt 和请求预算仅在新程序启动后的新调用生效。模型遵循输入路径说明的真实供应商案例仍需后续验收，不能以 fixture 测试承诺绝不再出现模型误操作。未创建收尾提交。
- 后续只读观察：本次改版 Task 于 19:29:57 完成，Subtask done、Publication integrated，全盘搜索进程已退出；这是用户在旧版本发起任务的结果，不作为新修复的验收。
- 修复包已生成：`Release/MetaWork-0.1.15-internal-input-routing-20261015-darwin-arm64.dmg`，447,886,224 bytes，SHA-256 `72b2bb2d9e9aad186b34266d20e4243774311da714105c5c49047c78f5600242`。该包同时包含执行详情去重修复；复用本地已安装 Electron 分发构建，避免重新下载。`hdiutil verify`、ad-hoc `codesign --verify --strict`、只读挂载后的 38,753 文件清单核验均通过；包内确认有新 prompt、128 KiB 常量及本地限制文案。
- 从挂载应用完成独立 HOME/安装根的首次安装、本地会话认证、设置激活、失败设置保留旧状态、菜单和退出后 Server 存活测试；测试 Server 已停止，DMG 已卸载。证据保存在 `Release/input-routing-20261015-evidence/`。未替换用户当前安装，未执行真实供应商任务。安装新版后须按界面完成后台更新，新调用才使用修复；正式签名、公证及整体平台验收仍未关闭。

### 用户试用跟进：按需交付目标审计（2026-10-15，未关闭）

- 真实案例：“打开浏览器进入百度。”Planner 只要求执行动作并简短说明命令、返回码与结果，`deliveryKind=report`，无 artifact handoff。只读 Executor 会话记录确认其自行调用 bash 写入 `browser_launch_result.txt`，再调用 write 生成 `browser_launch_report.md`；不是 Runtime 自动写报告，也不是 Planner 指定这两个文件。
- 提示缺口：固定 Planner Skill 与 proposal schema 只说明 edit/report 均可写文件，Executor prompt 要求 Markdown 完成正文并介绍 reportPath，但未明确纯动作/回答任务不得增加报告文件。方案 §2 的第 6 条和 §6.3 未完整转成执行指令。
- 契约缺口：`src/planning/planning-agent-plan-schema.ts` 的严格 SubtaskSchema 没有 `artifacts` 声明字段；`src/core/types.ts` 中 Subtask.artifacts 是执行结果存储字段，不能直接当作 Planner 预先声明。handoff 可以要求下游所需文件，但不能独自覆盖没有下游的最终文件交付。原设计关于现有字段足够承载全部交付意图的假设需要修正，不能仅凭 report/edit 或自然语言关键词进行机械筛选。
- 发布缺口：`validateWorkspaceDelivery()` 将 workspace delta 内仍存在的文件全部加入 normalizedArtifacts，经 Attempt runner 进入发布链；没有按纯动作/回答的交付意图隔离。与 §6.3 的“没有文件声明就不复制文件”和 §11 的“只有 Planner 声明了文件时才显示文件交付”不符。执行期可写临时文件与用户最终文件交付目前没有充分区分。
- 验收缺口：本次复跑 completion-protocol 与 prompt-builder-context-layering 共 43 项全部通过。它们覆盖无文件也可完成、输出区变更自动登记等既有行为，不能证明模型不额外生成文件或发布链不会交付额外文档。此前阶段 4 review 没有完整覆盖这项产品目标。
- Review 更正：本项为源码功能缺口，重新打开阶段 4 交付目标；不能仅归因于模型随机性或旧安装。需要补齐 Planner 明确交付意图、Executor 按需输出约束、Runtime 机械交付边界，以及纯文字/纯动作零额外文档、明确文件任务正常交付的端到端证据。若现有 schema 无法表达，按 §6.3 提出最小修订并同步对应契约；不得禁止全部 report 文件、按扩展名隐藏文档或增加 Runtime 语义复评器。本次仅完成审计与台账更正，尚未修复、打包或执行新的真实模型任务，未创建收尾提交。

### 按需交付补齐：实现与目标验收（2026-10-15）

状态：本地主机源码与真实模型验收通过；安装包验证单独记录。完成日期：2026-10-15。收尾提交：未创建，当前工作区包含既有修改。

- 依 ADR-0032 的增补，新计划必填 `fileOutputs`，允许安全的相对文件名或专用目录前缀，`[]` 表示无下载文件。拒绝缺省/null、绝对路径、越界、通配符、内部元数据目录；图规则核对去重、图片输出和 artifact handoff 源声明。字段贯通 Kernel 授权的 graph、SubtaskRepo、恢复 graph、Executor context、执行 trace 和完成校验。
- schema 50 事务增加 `file_outputs_json`。NULL 只保留历史已授权任务的旧规则，不以空列表重写旧任务。新 Planner 入口不允许省略；不增加新语义路由或模型复评器。
- Executor 提示区分 inline answer/action receipt、Git 修改和文件交付，明确不为操作或代码修改创建证明报告。Runtime 保留 workspace delta/Git 集成，只有匹配声明的实际文件被登记和复制；声明缺失是可展示正文但不能认证的交付事实，不通过 metadata correction 重做业务。
- 真实模型测试首次浏览器计划返回澄清，误把 workspace-command-validation 解释成不能启动本机浏览器。已在 Planner 固定规则中澄清原生命令启动与细粒度桌面自动化的边界，保留环境检测与实际权限限制；修正后同一请求完成，不用抓网页替代打开浏览器。

| 目标/故障 | 验收方式 | 结果 |
| --- | --- | --- |
| 纯回答无额外文档 | Session→Kernel→真实 SQLite/Git/发布链；真实 DeepSeek Planner + Pi Executor 计算 17×23 | 计划 `[]`、实际新增文件 0、认证完成 |
| 浏览器动作无额外文档 | 完整控制链 fixture；真实 Planner + Pi 原生命令打开百度 | 计划 `[]`、实际新增文件 0；独立 AppleScript 读取活动标签 URL 为 `https://www.baidu.com/` |
| Executor 仍多写 MD/TXT | 故障注入两个 browser_launch 文件 | 业务结果可完成；artifact 登记 0，用户交付目录不创建，任务不重派发 |
| 代码修改不带报告 | 真实 Git 集成 fixture；真实 Pi 修改并运行 hello.py | 只修改 hello.py；独立 python3 输出 `hello MetaWork`；无额外报告和下载 artifact |
| 明确要求报告 | 真实模型请求验收报告.md；实际读取文件 | 只生成指定文件，包含三条验收建议，文件交付认证通过 |
| 交付已有文件 | 完整控制链交付已有 README；真实模型请求原样交付明确命名的 `现有报告.md` | 文件内容 hash 不变，文件交付认证通过；不为交付而强迫改写 |
| Word/PPT/Excel/HTML 不误伤 | 完整控制链交付真实 OOXML fixture 与 HTML，逐字节比较 | 仅声明文件被复制，额外报告/脚本不交付 |
| 动态文件名/目录 | 专用 `site/` 与相似的 `site-copy/` 混合输出 | 只交付声明目录，前缀相似文件不混入 |
| 缺少必需文件 | 完整控制链注入只写 scratch；包括有下游的任务 | uncertified receipt，无 publication、无 handoff，不把缺文件当格式问题重做 |
| 下游文件交接 | 两个 Executor 的真实 Session/Kernel/发布链 | 下游只收到声明文件引用，不含 scratch |
| 发布失败/重启/取消 | 4 项交付恢复端到端，计划显式声明 answer.md | 只重试复制；Executor 一次、Git merge 一次；取消不发布 done/handoff |
| 历史迁移与回滚 | schema 49→50 幂等/故障回滚；用户数据库只读备份到隔离副本后迁移 | 8 张任务/事件/receipt/发布/产物表逐行摘要不变，历史声明保持 NULL；未修改源数据库 |
| 新协议与适配器 | native Planner proposal tool→服务端 validator→Kernel 合约；Pi 三协议和 Codex Responses 真 CLI 对照 | 新声明必填；4 项真实 CLI 对照通过（供应商端点为替身） |

验证总账：最后源码根目录全量 550 文件通过、17 文件按配置跳过；3,677 项通过、31 项跳过，零失败（102.28 秒）。包含文件交付完整控制链 11 项和交付恢复 4 项。Pi 定向 14 项通过，完整 check（740 文件、依赖、shrinkwrap、类型、browser-smoke）与 offline build 通过；根 lint/bundle 与 diff whitespace 检查通过。跳过项不能记作通过，Docker 命令不可用、Windows、真实飞书和正式签名/公证仍是整体方案未关闭的发布门。

真实模型证据位于 `.tmp/file-delivery-live-evidence/evidence.json`；Planner 使用生产 system prompt/schema、当前 revision 的真实模型和只读配置上下文，但查询工具/提案接收由隔离测试工具循环提供；Executor 使用生产 LocalCliExecutorAdapter 和真实受管理 Pi。它是模型行为与原生工具验收，不是官方账号登录后的完整 Desktop 用户链路。完整 Session/Kernel/发布链由上表端到端 fixture 独立覆盖。首次两次浏览器澄清失败保留在本地日志，不计为成功；修正后的四类案例均通过。补充的已有文件案例首次将“已有的现有报告.md”误读为 `报告.md`，在 Planner 文件名断言处失败，未启动 Executor；改用“名为 `现有报告.md` 的已有文件原样交付”后通过，文件 hash 不变。这证明明确文件名场景通过，不声称消除了自然语言歧义。五个成功案例均独立保留证据。未把账号凭据、原始用户数据库副本或模型密钥加入交付物。

最后边界复核补充：明确请求的已有文件/目录也可交付，不强迫改写。新增已有 README 的完整发布链、已有报告作为正文、已有目录和超过 1,000 项检查上限的测试；受限检查超限不静默截断为成功。该调整严格回到“声明交付物是否存在”的事实条件，保留纯动作零文件交付边界。

### 按需交付最终试用包与 review（2026-10-15）

- 产物：`Release/MetaWork-0.1.15-internal-file-delivery-20261015-darwin-arm64.dmg`，449,214,937 bytes；SHA-256 `7587749b806017133f13e5c820c952347e3b3952f7c79ad78a80fc5a1baa23ff`，release ID `0.1.15-internal-file-delivery-20261015`，schema 50。包含已有文件交付的最后修正及此前富文档预览修复。
- `hdiutil verify`、ad-hoc `codesign --verify --strict`、只读挂载后的 `verifyDesktopRelease` 全部通过，逐项验证 38,768 个 payload 文件；Runtime bundle、proposal schema、Planner 固定规则、Web index 与当前构建 hash 一致。sourceCommit 为基线 `e165b3979bcfd5428ecfa03401dd8cb3a22507e3`，development=true，不声称对应干净提交。
- 从挂载应用运行 `packaged-install-smoke.mjs`，独立 HOME/安装根 `/tmp/metawork-install-LnAfeE`、PATH 仅 `/usr/bin:/bin`。首次安装、本地认证、空配置激活、失败配置保留旧状态、首次模型配置无需重启、菜单、页面 reload、退出后 Server 存活通过。合成 Word/PPT/Excel/PDF 内容在包内阅读器显示，沙箱不可访问父页面或桌面桥接。未导入开发凭据或发起付费任务；安装后只读核对 schema 50 及新声明列。测试 Server 已停止，DMG 已卸载。
- 发布证据保存到 `Release/file-delivery-20261015-evidence/`，仅复制验收摘要、合成测试截图和筛选日志；原始用户数据库备份、生成配置、模型密钥与临时签名私钥不进入交付目录。说明见 `Release/安装说明-file-delivery-20261015.md`。
- Review：阶段 4 的按需交付源码缺口、正反向控制链验收、真实模型样本以及本地 DMG 首次安装门已关闭。只将 Runtime 可确定验证的文件事实作为认证条件；不引入关键词路由、第二模型复评或自动重复业务执行。真实模型测试中的早期失败与工具替身边界已记录。
- 尚未关闭：Docker/Windows、真实飞书、官方账号登录后的 Desktop 模型全链路、用户已有安装升级、正式签名公证。没有替换用户当前应用或修改源用户库，没有创建收尾提交；不能标记整个商业化方案完成。
