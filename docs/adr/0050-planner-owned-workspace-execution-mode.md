# ADR-0050: 单一 Workspace 执行模型

- 状态：已接受并实施；2026-10-30 起由 Workspace 内部 Git / Conversation Worktree 修订
- 日期：2026-10-25
- 取代：[Planner 主导的 Workspace 执行模式设计](../plans/2026-10-25-planner-owned-workspace-mode-design.md)
- 实施方案：[单一 In-place Workspace 技术实施方案](../plans/2026-10-25-in-place-only-workspace-execution-implementation-plan.md)

## 决策

MetaWork 新任务只有一种 Workspace 写入语义：Executor 在 Conversation 绑定的
Workspace 中直接执行。Planner 只声明读写意图、目标 Workspace-relative 路径和
文件策略；Kernel 将其解析为 `read` 或 `write` admission。写入 admission 在
Executor 启动前申请物理路径 Workspace write lease，冲突任务进入
`resource_waits` 并在租约释放后重新校验 binding。

普通编辑、新建文件、继续编辑和目标 Workspace 命令都使用同一目标目录。系统不
为新任务复制 Workspace、创建 Git worktree、生成候选目录或执行二次 publication。
Attempt 记录 before/after snapshot、变更清单、receipt 和 uncertainty；成功的
In-place Attempt 直接完成 Subtask，并由结果记录服务登记声明的文件。

`read_only` 是访问事实，不是第二种执行模式。只读 Attempt 可以通过受控的只读
边界读取 Conversation Workspace，临时文件进入 Runtime scratch 目录，不申请
Workspace write lease，也不创建 publication。声明 `fileOutputs` 的报告自动按
写入 admission 处理。

### 2026-11-02 修订：Conversation 内共享读锁

Subtask 可声明 `workspaceEffect: read_only | write | unknown`。只有明确的
`read_only`、`report`、`fileOutputs=[]` 且没有 artifact outgoing handoff 的节点才
取得 Conversation 业务根的共享 read lease；`write`、`unknown`、文件交付或不确定
效果仍取得独占 write lease。一个 Task 可以混合两种节点，DAG 依赖和现有 Task/账户
容量仍独立生效，因此读者可以真实重叠运行，写者等待全部读者退出。

共享读者从稳定的 Conversation Git 提交读取，cwd 是会话目录外的 Attempt scratch；
scratch 内的下载、缓存和脚本不进入业务 Git。只读 Attempt 完成时记录输入提交和
结果 receipt，不调用 `sealAttempt`，也不推进分支或合并队列。业务树发生意外变化时
会话进入恢复隔离，取消相关读者并阻止新调度，现场不会被当作只读成果封存。

每个 Attempt 的读写占用记录在 `conversation_attempt_owners`，所以重启、TTL 到期
和单个读者释放都不会错误地把仍有读者的 Conversation 标记为空闲。历史节点缺少
`workspaceEffect` 时保持 unknown/独占语义。

旧 Worktree binding、候选 publication 和自动复制结果只作为历史事实迁移并停放，
不得重新 dispatch 或静默切换目录。显式配置
`METACLAW_EXECUTOR_BACKEND=worktree` 会失败并要求重新规划为目标 Workspace
执行。

## 约束

- `authorizedWorkingDirectory` 只能是目标 Workspace 根或受控 scratch 根。
- 目标路径必须是 Workspace-relative，并由 Kernel 校验 containment 和声明输出覆盖。
- 同一物理 Workspace 或重叠父子路径遵循读读兼容、读写/写写互斥；不同 Workspace 可并行。
- Executor 崩溃后存在未知写入时进入 uncertainty，恢复不得盲目重放。
- Web、Desktop、TUI、Gateway 只展示目标 Workspace 和变更事实，不展示候选发布模式。

## 迁移

schema 58 将未完成的历史 Worktree publication 停放；旧 binding 在恢复时明确拒绝。
历史 nullable/兼容列可以保留用于诊断，但新代码不得读取其模式选择语义。

## 2026-10-30 修订：Conversation Worktree 唯一新任务路径

Workspace 内部 Git 与会话 Worktree 方案取代本 ADR 中“新任务直接写入用户
Workspace”的执行细节。所有新 Task 的 Workspace admission 固定为
`conversation_git`：Executor 写入 Conversation Worktree，结果封存到 Workspace
私有仓库，再由 Workspace FIFO 合并队列写回用户目录。Planner 不再判断或选择
`in_place`，Kernel 不再为新 Task 发出 `in_place`。数据库中的旧
`in_place`/旧 Worktree 值只用于只读展示、恢复和迁移诊断，不会重新成为新任务的
执行路径。

## 2026-11-02 实施边界

本修订在现有 Work Graph v7 / PlanningAgentPlan v9 上增加可选字段，不改变旧提案
JSON；SQLite 64→65 增加 nullable effect 和 durable Attempt owner 表，不回填猜测
历史只读权限。owner_token 仅投影一个仍存活的 owner 供既有生命周期观察，多读者
归属以 owner 表为准。资源申请使用 immediate 事务，等待写者阻止新读者插队。

结果接受和 response-only correction 引用原 Attempt 已确认的提交，不重新扫描封存
共享目录。污染会话保留 failed 状态与现场，不自动回滚；同进程读者立即取消，其他
进程的读者在心跳/完成校验中观察 fence。原生 Harness 仍是可信用户进程，这不是 OS
沙箱；Git 检测不覆盖 ignored 文件或执行中写入后恢复的瞬态变化。

## 2026-11-03 修订：移除 in_place 执行分支

上一条修订只停了新任务的模式选择，Runtime 里仍留着 `in_place` 的单根目录执行
分支、`InPlaceWriteUncertaintyError`、`WorkspaceStore.bindInPlaceWorkspace`、
`WorktreeAttemptExecutionBackend` 以及 `METACLAW_EXECUTOR_BACKEND=in_place` 的
环境契约。这些分支在生产组合中不可达（`conversationWorktrees` 恒注入，缺失
Conversation binding 的 Attempt 在 dispatch 前即 fail closed），因此按要求整体
删除，不再保留兼容路径：

- `ExecutionMode` 只保留 `conversation_git` 与 `service_git`；历史取值集中在
  `RetiredExecutionMode` 类型，仅用于识别旧行并显式拒绝。
- Attempt 必须在 dispatch 前拿到 Conversation binding，否则抛
  `legacy_execution_requires_replan`；不存在无 binding 的单根目录回退。
- `workspace_execution_bindings` 表与 `WorkspaceExecutionBindingRepo` 只作为
  历史读取保留；`executionContextFromBinding` 遇到退役模式直接拒绝。
- `METACLAW_EXECUTOR_BACKEND` 只接受 `native`/`docker`（含 `container`），
  launcher、Docker 脚本与 smoke 覆盖统一写入 `native`。
- 删除 `resolveExecutionModeFromEnvironment`、`parseExecutionMode`、
  `isWorkspaceExecutionMode` 等无调用者的模式解析入口。

迁移与 schema 历史（`resource_leases`、`tasks.execution_mode`、
`workspace_records.workspace_kind` 的旧 CHECK 约束）保持不变，因为它们记录的是
已发生的持久事实，不是可执行路径。
