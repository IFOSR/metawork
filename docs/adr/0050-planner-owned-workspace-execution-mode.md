# ADR-0050: Planner 主导的 Workspace 执行模式与隔离发布

- 状态：Accepted
- 日期：2026-10-25
- 影响：ADR-0011、ADR-0022、ADR-0025、ADR-0035、ADR-0049；不废止任何既有 ADR
- 契约依据：[Planner 主导的 Workspace 执行模式与临时 Worktree 设计](../plans/2026-10-25-planner-owned-workspace-mode-design.md)
- 实施记录：[技术实施方案](../plans/2026-10-25-planner-owned-workspace-mode-implementation-plan.md)

## 决策

MetaWork 只有两种写入执行模式：`in_place` 与 `worktree`。

1. **Planner 是唯一语义判断者。** Planner 在每个 `plan_work_graph`（plan schema 9）
   中提交一个结构化 `workspaceIntent`（目标 Workspace、目标相对路径、操作类别、
   原文件策略、隔离策略、建议模式、置信度、理由）。它只表达语义，不授权副作用。
2. **Kernel 只做确定性校验**（`resolveWorkspaceExecutionDecision`）：目标 Workspace
   必须是 Conversation 受信绑定的 Workspace；目标路径必须是 Workspace 相对路径
   （绝对路径、`..`、控制字符一律拒绝）；`in_place` 与强制隔离矛盾时拒绝；
   `worktree` 必须给出隔离、风险、候选或接受理由；语义存在副作用歧义、高风险且
   无模式、Workspace 缺失或隔离后端不可用时追问或拒绝，不产生 Task、Attempt、
   Worktree 或写租约。
3. **in_place 是普通编辑主路径。** Executor 在目标 Workspace 内直接执行，文件
   就地更新；不创建任何任务目录，也不复制交付副本。运行期的
   `authorizedWorkingDirectory` 必须位于目标 Workspace 之内。
4. **worktree 是隔离执行后端。** Executor 只在内部 Generation 执行目录中工作；
   目标 Workspace 在执行期间零写入。发布只应用经 Kernel 授权的变更集或声明文件，
   落在声明的 Workspace 相对路径；不再复制整棵执行目录，也不再用
   `publicTaskDirectory` 作为 Worktree 成果目录。
5. **发布策略由 Kernel 固定。** `none`（in_place 与只读候选）、`auto_publish`
   （隔离仅为安全性实现细节）与 `await_acceptance`（用户明确要求候选版本或人工
   接受）三选一；`await_acceptance` 只由显式任务结果接受动作释放，且该释放本身
   走 Kernel 授权动作 `authorize_workspace_delivery`。
6. **模式对 Task 不可变。** 决策随 Task 持久化（模式、来源、交付策略、目标路径、
   Workspace 意图）；Generation binding 固定 `workspaceId`、canonical path、
   `executionMode`、`authorizedWorkingDirectory` 与 fingerprint。重试、恢复和同一
   Task 的后续轮次沿用原模式，只有新 Task 才重新判断。
7. **高级设置只提供 fallback。** `workspaceExecution.fallbackMode`（默认
   `in_place`）只用于低风险且语义明确但 Planner 未给出模式的请求；它不能覆盖
   Planner 的明确判断，也不能绕过 Kernel 安全规则。环境变量
   `METAWORK_WORKSPACE_EXECUTION_DEFAULT` / `METAWORK_WORKSPACE_IN_PLACE_ENABLED`
   不再是新 Task 的准入依据。
8. **旧计划与旧发布路径退役。** plan schema 8 的计划映射为
   `workspaceIntent = null`，由 Kernel 采用隔离兜底（`kernel_safety`）；旧的
   Worktree 全树复制路径、`legacy` 发布标记和「任务目录」默认成果位置删除。

## 验收约束

- 普通目标 Workspace 编辑与新建文件均为 `in_place`，不因「新文件」切到 Worktree；
- 明确隔离、候选版本或人工接受才使用 `worktree`；有副作用歧义时必须追问；
- Worktree 执行期间目标 Workspace 无写入，发布只应用授权变更；
- 内部执行目录在同一 Generation 的多轮之间复用，终结且无残留后清理，
  未决副作用期间保留；
- 同一 Workspace 的 In-place 写入与 Worktree 发布由 ResourceLease 串行化；
- Planner 失效、输出非法或模式缺失时不得静默覆盖用户文件。

## 关联

- Workspace 身份与 Conversation 绑定仍由 ADR-0035 拥有；本 ADR 只固定执行模式与
  发布语义。
- 单活动 Task 准入仍由 ADR-0011 拥有；发布等待用户接受时 Task 进入
  `needs_action` 并释放执行名额，不改变单 Task 边界。
- Kernel 事件/快照/决策接口仍由 ADR-0022 拥有；本 ADR 只新增
  `plan_proposed.workspaceAdmission` 事实、`authorize_task_plan.workspaceExecution`
  固定事实与 `authorize_workspace_delivery` 授权动作（Kernel wire 版本不变）。
