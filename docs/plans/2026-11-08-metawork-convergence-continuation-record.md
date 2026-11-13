# MetaWork 收敛续作与本地验证记录

- 日期：2026-11-08
- 状态（2026-11-10，Review R-01～R-32）：D6 已交付；金额链、Codex/容器执行及 TUI facade 已分批删除，fresh-only schema 67、Manager 提案边界、Router 派发、快照保护和逐调用用量已继续实现。当前根 lint 通过；最近专项 **182 通过 / 3 失败**，最新完整 build/test 和客户端复验未完成。Router 动态资格/恢复链、Router/Memory 全调用计量及干净发布/Linux 等仍未验收；**整体收敛尚未完成**，各项验证程度见文末最新批次与 Review 报告。
- 阅读规则：以下各节是按日期保存的历史检查点，早期“Kernel 仍在生产”等描述不是现状；现状由本页顶部、最新批次和 [Review 报告](2026-11-10-metawork-full-code-review-report.md)限定。
- 上位依据：[PRD](2026-11-07-metawork-product-requirements.md)、[总体计划](2026-11-07-metawork-product-convergence-implementation-plan.md)、[技术方案](2026-11-07-metawork-product-convergence-technical-implementation-plan.md)、[ADR-0055](../adr/0055-no-kernel-target-architecture-and-contract-reset.md) 及其[重置实施方案](2026-11-07-metawork-target-architecture-contract-reset-implementation-plan.md)。
- 交付方式：只修改本地工作树。按用户要求，没有创建 Git commit、推送或发布；closing commit 不适用，待用户本地验收后统一处理。
- 前提：接手时工作树已有大量修改、删除和未跟踪文件；本记录只描述本轮增量，不把既有变更记作本轮成果。

## 1. 验证基线

本轮修改前，`npm run lint` 通过；`npm test` 为 **4564 passed / 70 skipped**，
文件为 **629 passed / 24 skipped**。基线日志在本机
`/tmp/metawork-convergence-tests.log`、`/tmp/metawork-convergence-lint.log`。
这些 `/tmp` 文件是本地诊断产物，不属于可随仓库分发的长期证据。

测试通过不能证明无 Kernel 目标已经达成。`src/kernel/`、
`KernelExecutionRuntime`、Kernel 账本和旧迁移链仍参与生产；
`tests/e2e/task-state-recovery-journeys.test.ts` 的旧交付旅程仍整组跳过。
本轮未增加 skip、删测试或放宽已有的权限/工作区断言。

## 2. 已实现的修复

### 2.1 取消任务仍可能发布私有文件

端到端复现：Executor 写入 Conversation Worktree 后等待，用户执行
`/task cancel <id>`，Task 已变为 `cancelled`，但收尾仍把文件写入用户目录。
原因是 `drainPublications` 接受全部 `done/cancelled` 子任务，未检查 Task 是否取消，
并且 Workspace FIFO 恢复也未检查所属 Task。

现在的边界：

1. Runtime 在 Task 封存前检查是否允许交付；Git IO 后再次检查 Task 与当前 generation/revision。
2. `WorkspaceGitPort.deliveryAllowed` 提供持久 Task 事实；`enqueue` 在事务中拒绝为已取消/失败 Task 创建新合并项。
3. Merge Worker 在正常 drain、重启恢复和写回检查点读取同一事实。尚未写回的合并以持久取消操作结束，恢复 main 到已交付版本，然后继续 FIFO。
4. 已 `prepared/applied/conflicted` 的文件不能假定未写入。取消会停止后续写回，保留已写内容，并暴露 `partial_writeback_requires_user_decision`；只有现有显式 `keep_partial` 操作才能结束部分交付。
5. 已发往操作系统的单个文件操作无法撤回；此修复阻止后续写回，不承诺多文件原子回滚。

验证覆盖：正常交付及重启幂等、执行中取消及重启、封存后入队前取消、已排队取消及下一项 FIFO、Git 合并中取消、部分写回后取消及显式保留。
Attempt 的私有封存仍保留用于诊断/恢复，不把封存等同于发布授权。
该修复仍位于现有运行链，不代表 Kernel 已删除。

涉及：`kernel-execution-runtime.ts`、`workspace-merge-worker.ts`、
`workspace-writeback-service.ts`、`workspace-git-repo.ts`、Workspace owner port。
Fake backend 的 `stop/remove` 现在也会结束等待中的 `wait`，用于真实模拟进程停止。

### 2.2 Manager 权限判断接入生产 Server

原有 Manager judge 与可选 resolver 已存在，但 Server 未提供权限上下文 resolver，
普通未分类请求无法真正交给 Manager 判断。

新增 Account owner 的 `createManagerPermissionContextResolver` 并由 Server 装配：

- 绑定 Account、Task、Conversation、Workspace、generation、Subtask、Attempt、配置版本、Agent 与 permission profile；异步读取配置后再次检查。
- 从 Task 对应 Query 和权威 Conversation Turn Store 读取原始输入，不使用当前页面选择的会话；找不到原始意图即停止自动审批。
- 对输入脱敏；超过 32 KiB 时拒绝自动判断，不截断可能包含限制条件的原始需求。
- Manager 权限模型调用的 usage 通过现有 recorder 归入对应 Query/Task，使用 request 级 call/event 身份。
- 超时中止 Manager 请求；Manager 收窄到 `once` 时持久保存 scope 和 `maxCalls=1`。

权限工作流还修复了持久化顺序与竞争：先写权限事件，再 pause/checkpoint/model；
SQLite claim 防止周期恢复抢走正在运行的判断；效果成功后才完成事件。
恢复遇到未完成判断时不重新自动批准；已有 grant/deny 不重复调用模型或创建授权。
取消/失效 Attempt 在判断返回、使用 grant、恢复进程时都重新校验，晚到结果不能恢复已取消执行。
授权仓库拒绝晚到的 grant/deny 覆盖已作出的相反决定。

ADR-0055 的 hard-deny、固定升级能力与用户最终决策边界仍适用。
权限事件存储目前仍依赖 Kernel workflow 表；独立权限事实表迁移尚未完成。

### 2.3 Router 持久化与并发边界

加强已有 Router/dispatch seam，而非宣称生产直派完成：

- 固定候选、排除项和模型目录快照；校验候选资格，模型和调用方无法修改已认证输入。
- 对同一 Attempt 的相同输入合并并发请求；不同输入冲突显式拒绝。
- 单个等待者取消不会中止其他等待者；最后一个等待者离开才取消模型调用。
- 决策默认 30 秒超时；取消后不写入晚到决策。
- 持久事务内再次读取当前输入；generation/图/配置变化拒绝落库。
- 不同服务实例竞争时使用数据库中已提交的获胜决策，不执行本实例未提交的选择。
- 输入 hash 使用规范字段序列，等价对象属性顺序不造成假冲突。

新增 `tests/routing/router-dispatch-service.test.ts` 覆盖并发、取消、快照变化、持久重放。
Server/Task 调度现在已经调用该直派接口，并在持久化 dispatch 前固定 generation；生产账户组合根已接入 Span/Jev 决策模型和明确回退，但 no-candidate 用户导流与旧 Kernel 控制循环迁移仍未完成，因此 P3-B 仍未关闭。

### 2.4 无效数据库拒绝必须早于 WAL

旧版本与无效版本标记已在初始化前拒绝；本轮把“当前版本标记但缺少当前 Task 表结构”
的检查也移到 WAL 设置之前。新增测试检查异常后数据库字节和 journal mode 未变。
这是拒绝入口的修复；`runMigrations` 和旧表仍存在，不能据此关闭 P6-B。

## 3. 本批验证

- 取消/交付 E2E 与初始 FIFO 回归：4 passed；补充完整 FIFO 取消矩阵：6 passed。
- Manager 权限与 Attempt runner 的最终取消回归：53 passed。
- `npm run lint`：通过。
- `npm run build`：通过，包含服务端打包、Plan schema、Pi 扩展、PDF 资源与 Web 类型检查/生产构建。Vite 提示部分 chunk 超过 500 kB，不阻断构建。
- 全量 `npm test`：**4607 passed / 70 skipped**，文件 **632 passed / 24 skipped**，耗时 150.69 秒；比接手基线新增 43 个通过用例，无新增失败或跳过。日志 `/tmp/metawork-convergence-tests-final.log`。
- 构建日志：`/tmp/metawork-convergence-build.log`。类型检查日志：`/tmp/metawork-convergence-lint.log`。
- 未执行真实付费模型调用、干净安装或人工 Web 登录旅程；本批不作为 P7 验收结论。

## 4. 下一批必须完成的目标缺口

| 批次 | 当前事实 | 退出条件 |
| --- | --- | --- |
| P3-A/B | Router 已接入生产 dispatch 前置闸门和 Span/Jev 决策模型；dispatch 仍由旧 Kernel 控制循环承载，no-candidate 仍无用户导流 | 当前候选快照、Attempt claim/launch、Route trace 和 no-candidate 用户结果贯通 |
| P3-C | Manager 已有生产上下文与判断链；权限持久化仍挂旧 workflow | 独立权限请求/决策/恢复事实，去 Kernel FK/兼容分支；生产权限旅程通过 |
| P3-D | 任务控制与延迟计划激活已迁出 Kernel/ledger；准入策略由 Task Runtime 提供，但准入 inbox/application 仍走 ledger；派发、容量/重试、完成/replan 仍走 `ControlKernel` + ledger | 剩余决策族逐族迁 owner，然后删 `src/kernel/*`、ledger/replay 与 `kernel_*` 表；不能仅改名 |
| P4/P6 | 旧 billing、迁移与命名仍有引用 | 按调用清单核对 token 完整性；替代读写者验收后删除旧金额/迁移/别名；官方付款数据保留 |
| B0.2/P7 | 70 项既有跳过；旧 recovery journey 有 8 项 | 逐条迁移相关旅程并恢复验收；macOS 干净安装与真实 Web 操作留证 |

本记录不把所有未关闭项目泛化成“文档清理”，也不因本地全绿就将整体状态改成完成。

## 6. 2026-11-09 继续收口

本轮继续按重置实施方案处理了两个生产缺口：

- 修复 Router 接线的真实竞态。`dispatch_batch` 在生成 `generationId` 之前就把它捕获到异步 Router 回调，导致生产执行批次在进入 Attempt 队列前抛出 TDZ 异常，Task/Subtask 停在 `ready`。现在先固定当前 graph generation，再执行 Router 选择；声明文件交付 E2E、任务边界、脚本会话和启动恢复回归恢复通过。
- 完成 Token fact 的归因字段收口。`model_usage_facts` 保存 `agent_class_ref` 与 `payer`，查询可以按角色和付款方过滤；Manager/Executor 从 Provider 的 `systemManaged` 事实决定 `platform` 或 `user_direct`，不再用一个全局 payer 把用户自带 Provider 的用量计入官方额度。保留旧表打开时的显式列补齐，避免本地验证数据库因字段缺失静默错误。
- 额度自然月/年窗口按北京时间（UTC+08:00）计算，并以半开 UTC 时间范围查询；补充 UTC 午夜附近边界测试。

本轮验证：`npm run lint` 通过；Router 并发持久化、Token usage、额度、Executor attempt、Query attribution 和声明文件交付测试通过（相关套件 94 项）。

随后执行完整验证：`npm test -- --run` 为 **4609 passed / 70 skipped**（632 个测试文件通过、24 个跳过），`npm run build` 通过，Web/Vite 生产构建通过；构建仅保留既有大 chunk 警告。

本轮又完成了 Router 决策模型的生产接线：账户组合根现在注入 `SpanRouterModel`，把已通过资格检查的精确 binding、任务目标和验收条件交给现有 Span/Jev 评估器，按返回概率选择完整的 AgentClass/provider/model；评估器不可用时使用稳定候选回退，并把原因写入 RouteDecision rationale。新增适配器聚焦测试，未改变 Router 的候选资格、权限和启动边界。Router 的 no-candidate 用户导流仍未完成。

同时将 Manager Hosted quota 从硬阻断改为软提示：额度不足、额度事实暂缺或计划未知时，精确的 token 状态写入 PlanningContext 并传给 Manager，当前规划继续执行；用户自带 Provider 仍不计入 Included quota。新增可替换的虚拟供应商目录、`get_quota_guidance` 只读 Gateway 查询和 Web 额度导流卡片，额度耗尽时可点击打开供应商入口；目录仍是示例数据，后续替换目录常量即可。

以下目标仍未关闭：Kernel 仍是生产控制循环；权限事实仍依赖 Kernel workflow 表；金额账务与迁移链尚未删除；供应商目录仍需替换为真实运营数据，Memory/三客户端和 P7 真实旅程仍需完成。此次变更不代表整体收敛完成。

### 2026-11-09 本轮追加验证

- Router 适配器在独立测试中覆盖模型概率选择、评估失败的可审计回退和任务文本脱敏；Router dispatch 与 Manager planning 回归共 37 项通过。
- quota guidance、Gateway 查询契约和 Web 导流卡片聚焦测试通过；默认虚拟供应商使用 `example.invalid`，不会被误认为正式商业入口。
- `npm run lint`、`npm run build`、`git diff --check` 通过。
- 前一轮完整套件结果为 **4613 passed / 70 skipped**（633 个测试文件通过、24 个跳过）；本轮仅增加 Router 脱敏测试，聚焦套件全部通过，未修改或新增 skip。

### 2026-11-09 Router no-candidate 闭环

生产 Router dispatch 不再把 `no_candidate` 转成普通异常。Runtime 现在将该结果作为
显式事实处理：对应 Subtask 进入 `blocked`，Task 写入待处理原因；同一批次中仍有可用
候选的独立 Subtask 继续进入 Attempt 队列。routing trace 记录 `route_no_candidate`，并
携带 `RouteDecision` 的 ID、候选/排除快照、决策模型和理由，便于 Manager 与用户复核。

验证：`npm run lint`、Router/dispatch/kernel recovery 聚焦测试通过；未改变硬拒绝、权限
边界或默认 Executor 回退规则。P3-B 仍未整体关闭，因为生产调度仍运行在旧 Kernel 控制
循环中，Kernel 删除和独立 Task Runtime owner 尚未完成。

### 2026-11-09 权限决策事实独立投影

新增 `permission_resolutions` 独立事实表及 `PermissionRepositoryPort` 的读写契约。
用户/Planner 决策现在在权限流程接受时写入该表；重复同意会重放，相反决策会冲突。
权限列表、生产用户决策入口和恢复路径优先读取独立事实，不再只依赖 `kernel_events`
判断一个请求是否已解决。为兼容旧库和旧进程，读取仍保留 Kernel event 兜底，现有
`permission_grants` 的旧 `kernel_decisions` 外键和 Kernel 过渡队列未删除。

验证：`npm run lint`、权限仓储/权限流程/多客户端控制聚焦测试共 21 项通过，
`git diff --check` 通过。P3-C 仍未关闭，下一步还需要把权限请求事件的 claim/recovery
和 grant 的决策锚点迁出 Kernel 表，再删除兼容分支并覆盖重启/并发验收。

### 2026-11-09 权限 owner worklist 与 schema repair

本轮把权限请求/决策事件的 claim、release、applied 和启动恢复 worklist 写入
`permission_work_items`，由 `PermissionRepositoryPort` 提供。生产权限流程优先使用该表，
Kernel 只保留事件载荷读取和旧进程兼容兜底；恢复 worker 对 work item 执行原子 claim，
只读取 pending 项，启动时回收遗留 processing 项，失败时释放回 pending。

`permission_resolutions` 与 worklist 的 DDL 安装从历史 `runMigrations()` 指纹边界移出：
`createDatabase()` 和权限仓储构造时执行幂等 additive repair，旧 schema-42/43 的原子回滚
和 hash 契约不受影响。新增当前版本缺表修复、独立 worklist claim/release/applied、
恢复重试和迁移边界回归测试。

全量 `npm test -- --run` 为 **4622 passed / 70 skipped**（634 个测试文件通过、24 个
skipped）。针对恢复 owner 原子 claim 的最后调整后，权限仓储、Manager 流程、账户续接
聚焦测试 **16 项通过**。`npm run lint`、`npm run build`（含 Web/Vite）及 `git diff --check`
均通过。构建保留既有大 chunk 提示；Web 依赖安装提示 6 个审计漏洞（3 moderate、2 high、
1 critical），本轮未执行自动升级。

P3-C 仍未关闭：`permission_grants` 的旧 `kernel_decisions` 外键、Kernel admission 以及
兼容读取仍待替代 owner 通过重启/并发验收后删除。

### 2026-11-09 P3-D 第一批：任务控制离开 Kernel

开始删除 Kernel。第一刀切在语义最独立、与执行调度无关的"显式任务控制"：取消 Task、
取消 Subtask 闭包、部分结果验收、不确定结果的接受/重试、候选交付授权。这些操作此前都以
`KernelEvent` 进入 `DurableKernelWorkflow`，由 `ControlKernel.decideTaskControl` 授权，再把
`KernelDecision` 交给 Runtime / Coordinator 应用。

现在的边界：

1. 新增 `src/execution/task-control-policy.ts`：纯函数 `decideTaskControl(snapshot, request)`
   按持久事实授权或拒绝，返回 `TaskControlAction` 与理由；不产生事件、账本记录或 replay 语义。
2. `KernelExecutionRuntime.submitTaskControl` 读取快照后立即应用。操作身份是确定性的
   `control_<interactionId>`，`task_state_changes`、effect outbox、Task 事件与 dispatch 行
   记录的都是这个身份，不再是 Kernel Decision。
3. `TaskCancellationCoordinator.apply` 接收 `TaskControlApplication`（`id`/`reason`/`action`）；
   取消栅栏、Subtask 闭包、资源撤销与后台 drain 的顺序规则保持不变。
4. 删除 `ControlKernel.decideTaskControl` 及其 `task_control` 快照分支、四个事件类型
   （`task_cancel_requested`、`subtasks_cancel_requested`、`partial_result_acceptance_requested`、
   `task_result_retry_requested`）和六个动作类型；`snapshotMatches`、`allowsKernelAction`、
   `SessionKernelRuntime`、`kernel-application-recovery` 中的对应分支一并删除。
5. 取消不再存在"不确定的 Kernel 应用"：`cancellation-reconciliation.ts` 与其专属测试删除，
   启动恢复只保留 `cancellationCoordinator.recover()` 的异步清理恢复；
   `reconcileCancellationApplications` 作为兼容读模型返回空集。
6. `effect_outbox.decision_id` 不再是 `kernel_decisions` 的外键（Task Runtime 直接拥有
   effect）。fresh schema 直接建无外键表，`createDatabase()` 对当前版本的旧库执行一次幂等重建；
   历史 schema-43 指纹常量随重建后的 DDL 更新，并在迁移测试中显式断言该列不再指向 Kernel。

验证：

- 新增 `tests/execution/task-control-policy.test.ts`（7 项）：取消闭包与已完成节点拒绝、Task
  终态拒绝、部分验收、结果身份过期/终态/不可安全重试、重复接受重放、候选交付授权、缺
  generation 拒绝。
- 重写 `tests/execution/result-decision-recovery.test.ts`（3 项）：接受、重试、重放三条路径在
  真实 SQLite 上应用，并断言 `kernel_decisions` 与 `kernel_decision_applications` 行数为 0。
- `tests/execution/kernel-application-recovery.test.ts`、`tests/kernel/control-kernel.test.ts`
  移除已迁走的任务控制断言；`tests/storage/migrations.test.ts`、
  `tests/storage/gateway-command-admission-migrations.test.ts` 更新 outbox 外键契约。
- `npm run lint`、`npm run build` 通过；全量 `npm test -- --run` 为 **4623 passed / 70 skipped**
  （634 个测试文件通过、24 个 skipped），未新增 skip、未删除无关断言。
- 聚焦：`tests/kernel` + `tests/execution` 相关套件 156 项通过；存储迁移两套件 28 项通过。

P3-D 仍未关闭：`plan_proposed` 准入、`dispatch_batch` 派发、容量/重试/恢复、完成与 replan 仍由
`ControlKernel` 决策并经 ledger 应用；`src/kernel/*`、`kernel_*` 表与 replay 仍参与生产。
本批只证明"任务控制"这一族可以在没有 Kernel 事件与账本的情况下正确工作，不代表 Kernel 已消失。

### 2026-11-09 P3-D 剩余批次顺序

| 批次 | 迁移内容（契约设计 §6） | 退出条件 |
| --- | --- | --- |
| D2 准入 | `authorize_task_plan`、`defer_task_plan_for_availability`、`activate_deferred_task_plan` | Planner 提案由 Task Runtime 直接准入并落 graph revision；`plan_proposed` 事件与 ledger 行数不再增长 |
| D3 派发与容量 | `dispatch_batch`、`wait_for_capacity`、`probe_capacity`、`wait_for_partition` | Router 决策 → attempt claim → launch 由唯一 owner 完成；dispatch 行改用 operation identity |
| D4 执行落地与恢复 | `execution_outcome`、`capacity_signal`、`merge_conflict_observed`、`sandbox_lost`、`recovery_*` | 失败/重试/沙箱/分区/合并修复由 Runtime 直接应用；`wait_for_retry` 变为本地 wake 事实 |
| D5 完成与重规划 | `complete_task`、`request_replan`、`schedule_replan`、`queue_generation_replan`、`recover_workspace_attempt` | 完成认证、replan 调度、恢复项各有 Runtime owner，不再经决策账本 |
| D6 删除 | `control-kernel.ts`、`kernel-workflow.ts`、`kernel-*-repo`、`kernel_*` 表与 projection、迁移链 | `rg 'ControlKernel|DurableKernelWorkflow|kernel_decisions' src` 为空；fresh schema 只剩新 owner 表 |

D2 切入点（已核对，未开始改代码）：

- 生产者：`src/session/metaclaw-session.ts:submitValidatedPlanningAgentPlan` 组装 `plan_proposed`，
  快照由 `buildPlanAdmissionSnapshot` 提供，应用方是 `SessionKernelRuntime.forInput(...)` 的
  `applyTaskPlan`（`src/session/session-kernel-runtime.ts:443`）。replan 侧另有
  `src/account/generation-replan-worker.ts` 构造同一事件。
- 策略面：`ControlKernel.decidePlan`（含 Work Graph 校验、路由候选、Workspace 决策）与
  `decideAvailabilityRecovery`（`defer_task_plan_for_availability` / `activate_deferred_task_plan`）。
- 决策应用面：`authorize_task_plan` 经 `SessionKernelRuntime` 回到
  `MetaclawSession` 应用 graph revision；`defer/activate` 由
  `KernelExecutionRuntime` 内两处独立 workflow（`executorRecovered` 与恢复 drain）应用。
- 建议最小切口：先迁 `defer_task_plan_for_availability` / `activate_deferred_task_plan`
  （两处内存 workflow、无 ledger 重放需求、`decision.action.workGraph` 已是完整授权结果），
  再迁 `authorize_task_plan` 主干，最后把 `reject_request` / `request_clarification` /
  `deliver_direct_reply` 改为 Session 直接结论。

### 2026-11-09 P3-D 第二批（D2-1）：可用性激活离开 ledger

`KernelExecutionRuntime.executorRecovered` 不再构造 `DurableKernelWorkflow`。它读取
`generation_replan_requests` 的 `waiting_for_availability` 事实、构造可用性快照、直接调用纯策略
`ControlKernel.decide`，然后立即应用 `activate_deferred_task_plan`：写入 graph revision、
resolve 请求并 reconcile Task 状态。该路径不再产生 `kernel_events`、`kernel_decisions` 或
`kernel_decision_applications` 行。

取消 ledger 后仍安全：应用完成即推进 active graph revision，下一次同一请求的判定会因为
`targetGraphRevision !== activeGraphRevision + 1` 返回 `no_op`，因此崩溃后不会重复激活。原来
依赖 `markApplied` 的观察事件也不再需要，因为本家族没有后续 effect。

验证：`tests/execution/kernel-execution-runtime-recovery.test.ts` 的对应用例改为断言
`executor_recovered` 事件数、`kernel_decisions` 行数均为 0，且 `resolve`/`apply` 各调用一次；
`tests/kernel`、该恢复套件与结果决定套件共 172 项通过。

仍未关闭：可用性策略函数仍在 `ControlKernel.decideAvailabilityRecovery` 中（本批只去掉 workflow
与账本）；`defer_task_plan_for_availability` 仍由 `decidePlan` 产生；准入主干
（`authorize_task_plan`）与 Session 结论尚未迁移。这些留给 D2-2。

### 2026-11-09 P3-D 第三批（D2-2）：可用性策略移出 ControlKernel

把 `ControlKernel.decideAvailabilityRecovery` 整体移入
`src/execution/deferred-plan-activation-policy.ts`，函数签名改为
`decideDeferredPlanActivation({ replanRequestId, observedAt, snapshot })`，返回授权结果或拒绝理由，
不再接收 KernelEvent/KernelSnapshot。`KernelExecutionRuntime.executorRecovered` 直接使用该策略。

同时删除 Kernel 侧整族：`executor_recovered` 事件、`availability_recovery` 快照、
`activate_deferred_task_plan` 动作、`decideAvailabilityRecovery`、`snapshotMatches` 分支、
`allowsKernelAction` 分支、`appendActionBindings` 分支、`SessionKernelRuntime` 分支，以及
`kernel-application-recovery` 中的 plan-activation 判定。`bindingsForProposalSubtask` 从
control-kernel 删除并随策略迁走。

验证：

- `tests/kernel/control-kernel.test.ts` 的对应用例保留"defer"断言（仍在 Kernel），激活断言改用
  策略函数；`tests/execution/kernel-execution-runtime-recovery.test.ts` 用 mock 策略验证 Runtime
  循环（revision 钉住、只激活一次、无 ledger 行）。
- `npm run lint`、`npm run build`（含 Web/Vite）通过；全量 `npm test -- --run` 为
  **4623 passed / 70 skipped**（634 files / 24 skipped）。

仍未关闭：`defer_task_plan_for_availability` 仍由 `decidePlan` 产生；准入主干
（`authorize_task_plan`）与 Session 结论（reject/clarify/direct reply）尚未迁移。策略模块当前
单独测试较薄（复用 control-kernel 用例），D2-3 会补独立套件。

### 2026-11-09 P3-D 下一批（D2-3）范围与步骤

已核对现状，`authorize_task_plan` 主干不能只搬一行：`ControlKernel.decidePlan`
（`src/kernel/control-kernel.ts:972` 起）同时承担路由候选解析、Workspace 执行决策、可用性闸门、
Work Graph 校验，以及 `/task` 命令的 `authorize_task_control`。因此 D2-3 按以下顺序执行：

1. **抽出准入策略**：新建 `src/execution/plan-admission-policy.ts`，把 `decidePlan` 拆成
   `resolvePlanAdmission`（候选/绑定、Workspace 决策、可用性集合）与
   `authorizePlanAdmission`（返回 `authorized | deferred | rejected | clarification | direct_reply | task_control`），
   保持现有校验顺序与错误文案。
2. **延迟计划事实改型**：`generation_replan_requests.deferred_plan_json` 现在存的是
   `plan_proposed` 事件；改为存 `DeferredPlanProposal`（D2-2 策略已按该形状读取），
   `deferForAvailability` 与恢复 worker 同步改型。
3. **直接应用准入**：`MetaclawSession.submitValidatedPlanningAgentPlan` 不再提交 Kernel 事件，
   改为调用准入策略并直接 `WorkGraphRuntimeService.apply`（操作身份 `admission_<planId>`）；
   `deferred` 写入 replan 请求并 block Task；`rejected`/`clarification`/`direct_reply` 由 Session
   直接产出，不再经过 `SessionKernelRuntime.applyTaskPlan`。
4. **删除**：`decidePlan` 的 plan 分支、`plan_proposed` 事件与 `plan_admission` 快照、
   `authorize_task_plan` / `defer_task_plan_for_availability` / `reject_request` /
   `request_clarification` / `deliver_direct_reply` 的 Kernel 产出；`/task` 命令路径暂保留
   `authorize_task_control`（D3 再迁），或在同批一并迁移，取决于测试面。
5. **测试面**：`tests/kernel/control-kernel.test.ts` 的 plan 用例整体迁到新策略套件；
   `tests/session`（计划提交/澄清/直答/任务命令）、`tests/account/generation-replan-worker`、
   `tests/e2e` 交付旅程需要按新入口改写；每个禁用分支都要有拒绝/幂等用例。

退出条件：`plan_proposed` 事件不再产生，`kernel_events`/`kernel_decisions` 不再新增 plan 行；
准入、延迟、拒绝、澄清、直答五条路径有端到端用例；`npm run lint`、`npm run build`、全量测试通过。

该规划记录写入时尚未开始改代码（后续进展见 D2-3a）：它跨 `metaclaw-session`、`session-kernel-runtime`、`generation-replan-worker`
与 Kernel 四处，且 `decidePlan` 还承载 `/task` 命令授权，必须一次规划清楚再动，避免留下半迁移状态。

### 2026-11-09 P3-D 第四批（D2-3a）：准入策略 owner 与延迟提案事实

- 状态：D2-3a 本地实现与自动验收完成（完成日期：2026-11-09）；D2-3 的直接准入退出门尚未达成。
- 本地交付：不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。
- 执行前核对：普通提交、账户 replan worker、合并冲突 replan 与启动恢复共用
  `plan_proposed` inbox。`submitPlannerProposal` 把提案与 `submitted` 原子保存；
  `findPersistedProposal` 在 worker 重启后复用已有提案。因此仅把 Session 的调用改为直接
  `apply` 会留下另一条准入策略，或让崩溃后的后台工作重复调用 Manager。
- 批次细分：先完成 D2-3 步骤 1/2 的可验证切片。此处保留的是已存在的持久队列，
  不是新增兼容读路径；旧准入策略实现必须删除。D2-3b 同时切换全部生产者与恢复读者后，
  再删除队列适配器和 plan 事件/动作。不得以本批测试通过关闭 D2。

已实现：

1. 新增 `src/execution/plan-admission-policy.ts`，以独立的 `PlanAdmissionRequest`、
   `PlanAdmissionSnapshot` 和 `PlanAdmissionResult` 为输入输出；`authorizePlanAdmission`
   返回 authorized/deferred/rejected/clarification/direct_reply/task_control/
   permission_resolution/no_action，不创建 Kernel envelope、Decision ID 或持久记录。
   内部 `resolvePlanAdmission` 负责候选资格、Workspace 解析与可用性；保持原校验顺序与错误文案。
2. 从 `ControlKernel` 删除 `decidePlan`、准入候选/Span helper 与对应依赖。直接向纯 Kernel
   提交计划会明确拒绝错误接线。账户组合根提供 `withPlanAdmission` 持久协议适配器：
   plan 只调用新策略，其他家族调用原 Kernel；不添加第二套策略，也不让 Kernel 反向依赖
   Execution。保留既有 operation identity、商业授权闸门及 application replay，便于下一批
   在事实存储可恢复后统一删除。**本批仍会产生计划 ledger 行**。
3. `DeferredPlanProposal` 不再是 `Extract<KernelEvent, ...>`；只保存提案、Task、generation、
   配置/revision、Workspace 及恢复执行所需 requestText。`deferForAvailability` 投影明确字段，
   不再序列化 event type/schema/correlation/causation；在写入前核对 Job 的 Task、generation、
   sourceRevision + 1、配置版本及 binding 版本。重复/取消后的晚到写入不能替换事实。
4. 原 Kernel 中计划、任务控制提案、abandon-and-create 用例迁到新策略套件；Span 概率、
   候选快照和排除模型用例迁到 `plan-admission-span.test.ts`。补充独立激活策略、独立提案
   存储、商业授权与错误接线测试。未删除无关断言，未新增 skip。

本批验证：

- 新准入策略/Span、延迟激活、延迟提案存储、版本固定仓储测试 **76 项通过**；
  准入 ledger 适配器测试 **4 项通过**。身份不匹配、取消、重复写入、连接替换后的恢复，
  以及错误 Kernel 接线与关闭商业授权均有断言。
- 全量 `npm test -- --run`：**4665 passed / 70 skipped**，文件 **638 passed / 24 skipped**，
  耗时 153.29 秒；相对上批 4623/70 新增 42 个通过用例，未新增 skip。
  最后清理 Kernel 测试里已不再使用的准入 fixture 后，Kernel 聚焦 **65 项通过**。
- `npm run lint`、`npm run build`（服务端、Plan schema、Pi 扩展/PDF 与 Web/Vite）和
  `git diff --check` 均通过；构建保留既有大 chunk 提示。依赖安装仍报告既有审计问题，
  未借本批执行自动依赖升级。
- 本机诊断日志：`/tmp/metawork-d2-3-tests.log`、`/tmp/metawork-d2-3-focused.log`、
  `/tmp/metawork-d2-3-adapter.log`、`/tmp/metawork-d2-3-kernel.log`、
  `/tmp/metawork-d2-3-lint.log`、`/tmp/metawork-d2-3-build.log`；这些临时日志不是仓库长期证据。
- ADR-0055、CONTEXT、两份技术概览、重置实施方案与文档索引同步记录实现边界。
  未运行真实付费模型、干净安装或人工 Web 登录旅程；不作为 P7 验收结论。

剩余边界：准入持久入口仍依赖 `kernel_events` / `kernel_decisions` /
`kernel_decision_applications`；独立策略仍使用现有配置/健康投影值契约及纯 Workspace helper，
这些不能因 `decidePlan` 删除就视为 Kernel 目录删除完成。D2-3b 按下面的完整入口迁移门执行。

### 2026-11-09 P3-D 下一批（D2-3b）：持久准入入口统一切换

本批完成后下一步必须按依赖顺序推进：

1. 先定义 Task Runtime 所有的持久提案/准入记录和 port：保存原始提案、配置版本、所属
   Conversation/Turn、attachment IDs、操作身份、结果与未应用状态。替代
   `GenerationReplanRequestRepo.submitPlannerProposal/insertProposalEvent` 的 Kernel inbox 写入，
   保持与 Job 的 `submitted` 同事务、claim token fencing、重复提交幂等。
2. 覆盖“Manager 已返回且提案已保存、尚未 apply 就崩溃”的恢复：普通提交和后台 replan 均
   从同一 owner 读取原提案，不重调 Manager；配置/Task/generation 过期或取消时拒绝应用。
   同时迁移 `resolveTurnAttachmentIds` 对原准入事件的读取，不能丢掉附件资格事实。
3. 将 `submitValidatedPlanningAgentPlan`、`GenerationReplanWorker`、merge replan 和启动恢复
   同时切到新 owner；Session 直接投影拒绝/澄清/直答和权限解释，Task Runtime 应用 graph、
   延迟和任务命令。操作身份统一为 `admission_<planId>`，先验证 Task 创建、排队、
   abandon-and-create、replan apply 与效果恢复的原子性/幂等性。
4. 删除 `plan-admission-ledger-adapter.ts`、`plan_proposed` / `plan_admission`、
   `authorize_task_plan` / `defer_task_plan_for_availability` 及准入专属动作分支；共享的
   `reject_request` 等动作仍有 managed-service 等读写者，必须按调用清单迁移后才能删除，
   不可直接全局替换。
5. 退出门：准入/延迟/拒绝/澄清/直答五条生产旅程和后台 replan 重启/并发旅程通过；
   断言相关 `kernel_events` / `kernel_decisions` 不再增长；lint、build、全量测试通过。
   之后再进入 D3 派发与容量。P3-C、D4–D6、P4/P6、P7 保持未完成。

### 2026-11-09 P3-D 第五批（D2-3b-1）：持久提案与后台恢复入口

- 状态：本地实现与自动验收完成（完成日期：2026-11-09）；本批为 D2-3b 步骤 1/2 的后台 replan 切片，
  **不是 D2-3b 整体关闭**。普通准入、merge replan 与 graph 应用仍待下一切片统一切换。
- 交付：继续仅本地修改，不 commit、不 push、不发布；closing commit 不适用。
- 执行前发现：除 `MetaclawSession` 外，生产 `ConversationSession`、
  `AccountStartupRecoveryService` 和 merge replan 也有入口。原 worker 只扫描 `planning`
  Job；原子保存后若还没把结果应用就崩溃，恢复依赖 Kernel inbox。删除这个 inbox 前，
  必须先有“Manager 输出已保存”的独立事实和可重试投递，不能先改 Session 一处。

已实现：

1. Task Runtime 新增 `PlanProposalStore` / `PlanProposalRecord`，SQLite 适配为
   `task_plan_proposals`。保存确切的 `PlanAdmissionRequest`、`admission_<planId>` 唯一
   操作身份、可选 replan Job/trigger 关联和 pending/forwarded/invalidated 投递状态。
   保存时投影明确字段，去掉 Kernel event envelope；相同身份/等价对象字段顺序可重放，
   不同正文、Job 或操作身份冲突拒绝。原始输入、附件集合、Workspace、Conversation/Turn
   字段可以原样恢复。**forwarded 只表示接收队列已持久化，不表示 Task 已授权或完成**。
2. `GenerationReplanRequestRepo.submitPlannerProposal` 在同一 SQLite 事务中核对当前
   claim token、Task/generation/sourceRevision/configuration，然后保存提案与 Job 的
   `submitted` 状态。任一 INSERT/UPDATE 失败整体回滚；过期 worker 不能落库。
   删除 `insertProposalEvent` 与旧 `submitPlan` 的 Kernel inbox 写入；Job 仓储不再导入
   `KernelEvent`、读写 `kernel_events`。已有 ledger 应用恢复 fixture 改为由相应 ledger
   仓储明确建样，不再让 Job 仓储兼任事件写入者。
3. `GenerationReplanWorker` 不再向 Planner port 请求 `findPersistedProposal` 或
   `drainKernel`；保存输出统一从 owner store 查询。每轮先恢复待投递提案，再领取新模型
   工作；持久提案恢复不受模型调用预算限制。投递失败保留 pending 和明确原因，下一轮
   只重试投递，不重调 Manager。失败项按更新时间轮转，避免占住有界扫描的队首。
4. 新模型调用前、调用后和待投递恢复前检查 Task 终态、active generation/revision、
   配置与所属 Conversation/Workspace；取消或过期结果拒绝。失效提案与 submitted Job
   的失败状态同事务落库；取消 Job 不会被改回 failed/planning。授权关闭时保留待投递事实。
5. 账户恢复与旧 Session 都接到新的 `submitProposal` port。当前接收端仍把提案转成
   原有应用传输的 `plan_proposed` 并入队；记录 forwarded 后再 drain，避免把“应用过程
   出错”混成“Manager 没完成”。没有增加 Kernel 旧提案兼容读取；本批之后 worker 只从
   owner store 复用模型输出。**接收端仍产生 Kernel 计划事件/决策，本批不满足零增长门**。
6. `createDatabase()` 在既有当前版本安装点创建提案表，旧版本拒绝仍在任何写入/WAL
   之前；历史迁移链与指纹不改。更新 v31 单元测试 fixture 的已有 claim-token 列，
   使它能验证现在实际使用的 fenced Job 方法，不为生产增加迁移。

本批验证：

- 聚焦准入存储、Job、worker、账户启动恢复及数据库打开：88 项通过；补充操作身份冲突
  后，独立提案仓储套件 14 项通过。
- 生产组合旅程已验证：只有 owner store 中的提案、没有对应 Kernel 事件时，账户无前台
  会话也能恢复投递并授权 graph revision 2；重复周期不重调 Manager，不重复创建计划事件。
- 真实 SQLite 覆盖：关闭重开连接、第二连接竞争、原子回滚、身份冲突、取消后的晚到写入；
  worker 覆盖模型预算到期、并发 claim、配置/generation/revision 失效与投递失败恢复。
- 全量 `npm test -- --run`：**4698 passed / 70 skipped**，文件 **639 passed / 24 skipped**，
  耗时 150.09 秒；相对上一批 4665/70 新增 33 项通过，无新增 skip。
- `npm run lint`、`npm run build`（服务端、Plan schema、Pi 扩展/PDF 与 Web/Vite）及
  `git diff --check` 均通过；构建保留既有大 chunk 警告和依赖审计提示，本批未自动升级依赖。
- ADR-0055、CONTEXT、两份技术概览、重置实施方案和文档索引已同步本批边界；
  不据自动测试结果关闭 D2-3b 或 P7。
- 本机日志：`/tmp/metawork-d2-3b-tests.log`、`/tmp/metawork-d2-3b-focused-final.log`、
  `/tmp/metawork-d2-3b-storage-final.log`、`/tmp/metawork-d2-3b-integration.log`、
  `/tmp/metawork-d2-3b-lint.log`、`/tmp/metawork-d2-3b-build.log`。临时日志不作为仓库长期证据；
  按测试名与上述用例可复现。本批未执行真实付费模型、干净安装或人工 Web 验收。
- 旧 `tests/session/planning-kernel-path.test.ts` 23 项仍整组跳过，是接手前既有状态；
  不把它作为本批通过证据，也未新增 skip。生产账户组合使用非跳过测试验证。

### 2026-11-09 P3-D 切片规划（D2-3b-2，执行前）：普通准入和应用事实

必须从以下接续点继续，不能仅删适配器或重命名 Kernel API：

1. 将普通 `ConversationSession.submitValidatedPlannerProposal`/旧 Session 提交和 merge replan 的
   prepared proposal 保存接到同一 owner。普通 Turn 的取消、query 归因、Span 快照与
   `sourceTurnId`/attachment IDs 必须一并保留。准备过程的幂等读者从
   `findKernelEvent` 转为 owner proposal 查询；原始附件资格读取也需同时迁移。
2. 新增真正的 admission 应用结果/状态 port；`task_plan_proposals.delivery` 是投递回执，
   不能拿它充当 graph 已应用。落实 Task 创建 + graph revision + admission identity 的
   原子性，以及 abandon-and-create、排队和效果恢复的幂等性。应用 ID 使用已保留的
   `admission_<planId>`，不得继续生成第二个策略 Decision。
3. 接收端从临时 `replanProposalEvent` 转成直接准入服务；账户启动恢复先处理该 owner 的
   未完成应用，再执行相应 Task 恢复。普通提交、后台 replan、merge replan、权限解释、
   直答/澄清五类 Session 投影一并切换，核对所有 Kernel application/trace/billing 读者。
4. 删除临时 ledger 适配器、plan 事件/快照/专属动作和相关 ledger 读者；保留仍被其他
   决策族使用的共享动作，逐族迁移。新测试必须断言五条准入旅程不再新增 plan ledger 行。
   lint、build、全量回归通过后，才关闭 D2-3b 并进入 D3。

### 2026-11-09 P3-D 第六批（D2-3b-2a）：提案生产入口、准备重放与附件来源

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。
  本批拆出 D2-3b-2 的生产入口切片，**不关闭 D2-3b，也不满足计划账本零增长门**。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用。
- 执行前发现：普通 Turn 的准备缓存和原始附件资格仍读 Kernel event；同步/merge
  replan 重试可能重新调用 Manager/Span。只迁 worker 不能删除计划 inbox。
  新持久提案也必须纳入 Conversation 删除，否则原始文本和附件引用会残留。

已实现：

1. `ConversationRuntimePort.proposals` 接入账户组合；普通 Conversation、旧 Session、
   同步 replan 和 merge replan 都先保存 prepared domain input，再交给现有应用传输。
   领域保存投影明确字段，含原始输入、附件、query、source Turn、配置、Workspace 与
   Span 快照；`PlanAdmissionRequest` 不再要求 Kernel event envelope。
2. 相同提交重放先读 owner，核对输入、来源与 trigger，不重复 Manager/Span/Workspace
   准备。同步 replan 还核对 generation/sourceRevision；旧 facade 无配置快照 loader 时
   拒绝在错误当前版本下重新规划。账户无前台恢复也按保存的 Conversation/query 归因。
3. 合并并发准备的 promise 包含持久 save：保存失败会拒绝全部等待者，不能让第二个
   等待者把未保存输出送入准入。异步配置/准备返回后再次检查取消；取消准备没有输出落库。
4. 新增 `task_plan_origins`：Task 创建后才绑定初始提案，排队 Task 同样保留原始附件。
   单独保存、未准入、引用既有 Task 和 replan 提案都不能替换初始来源。原始需求和附件
   资格读取统一使用这个绑定，不回退 Kernel event。**Task 创建、来源绑定、graph 应用
   尚非同一事务**；绑定本身也不等同于 graph 或执行授权。
5. Conversation 删除开始时使 pending 提案失效；清理在同一事务中删除提案正文与来源
   绑定，覆盖尚未创建 Task 的提案与 merge 输出，保留其他 Conversation。持久删除
   tombstone 拒绝晚到保存及删除后的同提交重放。该仓储使用账户独立数据库；旧 Session
   已明确保存其 Conversation 身份，避免把 Planner 进程身份误作生产 Conversation。
6. 全量回归发现三个旅程 fixture 在不同模型输出间复用 `plan_test`，触发已规定的
   `admission_<planId>` 唯一操作冲突。已为这些独立提案设置独立 ID，保留所有行为断言；
   没有放宽仓储唯一性或增加第二种操作身份。真实 Manager 同 ID 的不同输出仍拒绝。

本批验证：

- 准入存储、Session、生产组合与恢复聚焦回归 197 项通过；后续 producer/facade 回归
  57 项通过；三个多 Turn/跨 Session 任务旅程 17 项通过。
- 新增/加强验证：断交接后的重建 Session 重放、同步/merge 重放不重调模型与准备、
  保存失败的并发等待者、来源绑定与排队附件资格、输入/trigger/generation 冲突。
- 删除生命周期聚焦 6 文件 / 53 项通过，覆盖未准入及已准入提案、晚到保存/重放拒绝、
  其他 Conversation 隔离、提案与来源绑定清理失败整体回滚和重复清理。
- 最终全量：**4713 passed / 70 skipped**，文件 **640 passed / 24 skipped**，
  耗时 159.13 秒；相对上一批新增 15 项通过，无新增 skip。
  `npm run lint`、`npm run build` 通过，Vite 保留既有大 chunk 提示。
- 本机日志：`/tmp/metawork-d2-3b2-focused-final.log`、
  `/tmp/metawork-d2-3b2-producers.log`、`/tmp/metawork-d2-3b2-journeys.log`、
  `/tmp/metawork-d2-3b2-lifecycle.log`、`/tmp/metawork-d2-3b2-tests-lifecycle-final.log`、
  `/tmp/metawork-d2-3b2-lint-final.log`、`/tmp/metawork-d2-3b2-build-final.log`。
  临时日志不是仓库长期证据，用上述测试可复现。
- 未新增 skip；既有 planning-kernel-path 的 23 项仍跳过，不作为通过证据。
  未执行真实付费模型、干净安装或人工 Web 验收。ADR-0055、CONTEXT、双语技术概览、
  重置方案和文档索引已同步边界，不据自动测试关闭 P7。

第六批结束时的剩余边界：普通 pending 提案只支持同一提交重放，**尚未启用启动自主扫描**；
保存后、交接前发生取消仍需持久 Turn 取消事实与应用前 fencing（已由第七批补齐该前置门）。forwarded 仅为投递回执，
不作为应用结果。Kernel 仍承载计划传输、策略结果与应用，trace/billing 仍有旧 decision
身份读者；没有声称计划事件/决策零增长。

### 2026-11-09 P3-D 切片规划（D2-3b-2b，执行前）：直接准入应用与启动恢复

1. 先补持久 Turn 取消事实，在保存、重放和应用前核验。再实现普通 pending 启动扫描，
   并与 Task 终态、generation/revision/configuration fencing 一起验证；不能把内存取消
   latch 或 UI trace 状态当作恢复授权。
2. 新增准入 owner 的直接应用结果/状态 port，沿用 `admission_<planId>`。落实 Task
   创建 + 初始来源 + graph revision + 应用结果原子提交；排队和 abandon-and-create
   的操作/效果恢复必须幂等。Workspace 文件 IO 在数据库事务外完成，落库前再核验。
   不复制通用事件/快照/Decision 解释器，不产生第二份策略 Decision。
3. 先拆除 `work_graph_revisions.authorized_decision_id` 等 Kernel 外键阻塞，使用 owner
   授权事实的当前安装 schema；不往旧 FK 塞 admission ID，也不创建伪 Kernel decision。
   保留历史迁移指纹/拒绝旧库边界，不为预发布数据库加兼容读取。
4. 普通提交、后台/同步/merge replan、账户无前台恢复统一调用直接准入；Session 直接
   投影拒绝/澄清/直答与授权结果，同步迁移 trace/billing/query 读者。所有读写者迁完后
   才删除临时适配器、plan 事件/快照/专属动作；共享动作等待其他 owner 迁移。
5. 退出验证覆盖准入/排队或延迟/拒绝/澄清/直答五条旅程及 replan/merge，数据库第二
   连接竞争、各崩溃点、取消晚到、abandon 恢复、不重复模型或执行效果；相关
   kernel_events/kernel_decisions 不再增长，lint、build、全量回归通过。
   之后再关闭 D2-3b 并进入 D3；P3-C、D4–D6、P4/P6 和 P7 继续保持未完成。

### 2026-11-09 P3-D 第七批（D2-3b-2b-1）：持久取消与提案应用生命周期

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批只关闭直接应用前的
  持久取消前置门，**不关闭 D2-3b，不启用普通 pending 启动扫描**。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用。
- 执行前发现：取消只存在于 Session 内存 latch/AbortController；已保存的提案在 Session
  重建后仍可能被重放。只在交接前检查也不够：Workspace 异步 IO 期间、同步/merge
  replan 读取配置期间，以及 Executor 恢复后的延迟激活，都可能绕过之前的检查。

已实现：

1. Conversation owner 新增 `TurnCancellationStore`，账户组合根绑定
   `SqliteTurnCancellationStore`。`conversation_turn_cancellations` 按
   Account/Conversation/Turn 保存首次请求时间；重复请求不覆盖该时间。取消先持久化，
   再 latch、abort、写 trace 和应答；保存失败不会假装已经取消。该事实无 Turn 正文外键，
   不依赖 UI trace 或正文 GC；Conversation 清理同时删除其取消行，删除 tombstone 继续
   拒绝提案写入。它只禁止后续准入，**不等于已取消 Task 或完成 Executor 清理**。
2. `PlanProposalStore.assertAdmissionOpen` 明确区分缺失、失效、Conversation 删除与
   source Turn 取消。保存与初始来源绑定核验同一事实；pending/forwarded 都不能覆盖
   生命周期。普通准备重放在异步配置加载后再检查；同步/merge replan 检查保存提案的
   原 source Turn，不能借新活动 Turn 复活旧输出。账户启动、worker、旧 Session 的
   交接入口也核验 owner；没有增加 Kernel 旧提案读取。
3. 现有 Session/Execution 应用入口在效果和 trace 前校验保存的输入。普通计划、直答、
   澄清在组合了 owner 时必须存在提案记录，删除正文后不能回退成无 owner raw plan。
   Task 创建/排队/启动前，在 Workspace root/baseline IO 返回后再次核验。若旧 Task
   abandonment 已成功而随后取消，则记录既有效果已发生的 settled 语义，不把它报成
   完全无效果的 rejection，也不创建替代 Task。
4. Worker 的 pending 投递遇到明确生命周期拒绝时，用已有事务结束提案与 submitted
   Job；传输故障仍只重试交接，不重调 Manager。**forwarded 仍是接收回执**，不能冒充
   应用结果；已 forwarded 的应用拒绝收口仍需下一批直接结果 port。
5. `executorRecovered` 在延迟策略求值前及 graph 应用前核验同一 owner。缺失/失效输入
   使确切 waiting Job 失败，Turn 取消/Conversation 删除使其取消；新的
   `rejectDeferredProposal` 仅结束当前仍等待且 proposal ID 相符的输出，终态和其他输出
   不受影响。失效 Job 不阻塞后续活跃项，也不重开 Manager；原投递回执不改成应用结果。
6. 初次全量有 19 项失败：6 项历史 schema43 指纹重建未排除新安装表，另 13 项
   多客户端/取消测试 helper 缺少新增 runtime port。已让历史重建显式去掉新取消表，并为
   控制测试 helper 补充取消存储；**schema43 冻结 hash 未改**，生产不增加迁移或兼容读取。
   修复后的 3 文件 / 27 项聚焦回归通过，未放宽行为断言。延迟激活新增矩阵首次使用了
   当前 Vitest 不支持的 matcher，改为分别断言次数与参数后通过；运行逻辑未为此修改。

本批验证：

- 真实 SQLite 测试覆盖关闭重开、第二连接可见性、Account/Conversation/Turn 隔离、
  首次时间不被覆盖、无效输入零写入，以及已保存 pending/forwarded 与晚到保存的拒绝。
- Session/应用测试覆盖重建后取消、取消保存失败、旧 source Turn 的同步/merge 重放、
  Workspace IO 中取消/删除/提案擦除、已经完成 abandonment 的效果语义。
  生产账户启动测试验证取消和缺失 owner 均不能授权 graph revision 2 或启动 backend。
- 最终延迟激活、延迟仓储与应用聚焦：**3 文件 / 49 项通过**。四种生命周期拒绝分别
  覆盖首次校验和应用前再校验；每项都验证后续活跃 Job 继续应用、其他配置不受影响，
  且延迟激活不新增 Kernel event/decision。仓储断言错误 proposal ID 与终态不能被改写。
- 最终全量 `npm test -- --run`：**4744 passed / 70 skipped**，文件
  **642 passed / 24 skipped**，耗时 164.02 秒；比第六批增加 31 项通过，无新增 skip。
- `npm run lint`、`npm run build`（服务端、Plan schema、Pi 扩展/PDF 与 Web/Vite）通过；
  Vite 保留既有大 chunk 提示。`git diff --check` 通过。
- 本机日志：`/tmp/metawork-turn-cancellation-tests-final2.log`、
  `/tmp/metawork-turn-cancellation-deferred-final.log`、
  `/tmp/metawork-turn-cancellation-new-tests.log`、
  `/tmp/metawork-turn-cancellation-regressions.log`、
  `/tmp/metawork-turn-cancellation-lint-final.log`、
  `/tmp/metawork-turn-cancellation-build-final.log`、
  `/tmp/metawork-turn-cancellation-diff-check.log`。失败分类的首次全量记录为
  `/tmp/metawork-turn-cancellation-tests-final.log`。临时日志不是仓库长期证据，按上述
  测试文件和命令可复现。
- ADR-0055、CONTEXT、双语技术概览、重置实施方案与文档索引同步本批边界。
  既有 70 项 skip 未变；planning-kernel-path 的 23 项仍不作为通过证据。
  未执行真实付费模型、干净安装或人工 Web 验收，不据此关闭 P7。

剩余边界：检查之后、分散的同步写入之间，第二个数据库连接仍可能提交取消/删除；
**Task 创建、初始来源、graph 与应用结果尚未同事务**，本批不声称关闭并发提交竞争。
Task 取消/清理仍依赖既有任务控制链。普通 pending 自主恢复仍关闭，后台只恢复已有
owner 输出。Kernel 计划传输、决策、application 以及 trace/billing 的旧身份读者仍在，
准入计划账本继续增长，D2-3b/P3-D/P7 均未关闭。

### 2026-11-09 P3-D 下一切片（D2-3b-2b-2）：直接结果与原子提交

执行顺序细化如下，替代上面执行前规划中“先扫描普通 pending”的顺序；必须先完成
原子应用，再开放扫描，不能让恢复放大半创建 Task 的窗口：

1. 定义准入 owner 的直接调用/结果 port：输入引用已保存 proposal，操作身份沿用
   `admission_<planId>`，持久结果区分拒绝/澄清/直答、Task/graph 已应用、排队或延迟。
   投递 pending/forwarded 不承担应用状态；不能复制 event/snapshot/Decision 通用账本。
2. 修改当前安装 schema 和 `WorkGraphRevisionRepo`/`WorkGraphRuntimeService` 授权契约，
   先移除 `work_graph_revisions.authorized_decision_id` 的 Kernel FK 阻塞，再让 graph
   引用直接准入的 owner 授权事实。同步核对后续 dispatch 引用的授权身份，不能把
   admission ID 塞进旧 FK 或创建伪 Kernel decision；历史迁移指纹和拒绝旧库门保持。
3. Workspace 文件 IO 在事务外做；同一 SQLite 写事务中重读 proposal、取消/删除、
   配置、Task/generation/revision/Conversation slot，然后提交 Task + 初始来源 + graph
   + 结果。排队载荷与结果也需原子；abandon-and-create 将旧 Task 已完成的外部效果
   与新 Task 提交分开恢复，沿用同一操作身份，不重复取消或发布。
4. 将普通、后台/同步/merge replan、无前台账户恢复和 Session 结果投影接到直接 port，
   同时迁移 query/trace/billing 的实际读者。完成原子性和生命周期矩阵后，再开放普通
   pending 的有界启动扫描；已保存输出不重调 Manager，单项失败不饿死其他项。
5. 删除临时 `plan-admission-ledger-adapter`、`plan_proposed`/`plan_admission` 和准入
   专属动作及读者；共享动作按其他 owner 的迁移进度保留。五类准入生产旅程以及
   replan/merge、第二连接竞争和各崩溃点必须通过，并断言计划相关
   `kernel_events`/`kernel_decisions` 零增长；lint/build/全量回归通过后才能关闭 D2-3b。
   随后进入 D3。P3-C、D4–D6、P4/P6 和 P7 继续保持未完成。

## 5. 用户本地核验建议

> 2026-11-09 更新：D2-3b-2b-2 的 2a（图授权身份去 Kernel 外键、准入结果 owner 事实）
> 与 2b（准入期原子应用 Task/来源/graph/结果、graph 前移到准入）已完成；下一步 2c 是
> 生产者/恢复入口统一走直接准入并删除计划账本，同时开放有界启动扫描。原子提交已就绪，
> 但计划账本零增长门仍未达成。

1. 在独立测试 Workspace 完成一次文件编辑，检查最终文件、任务终态和交付记录；重启 Server 后确认不重复执行。
2. 在同一测试 Workspace 发起耗时编辑，执行取消，检查私有修改未进入用户目录；重启后再次检查。
3. 使用已经配置的 Manager/Executor，触发普通未分类权限请求，核对 Manager 判断、授权范围与 token 用量；再核对 deny/escalate 两条分支。自动测试使用 fake Pi RPC，并未代替真实模型验收。
4. 对照重置计划核查目标架构状态：当前仍可定位生产 Kernel 调用点。不要据本批自动验证结果批准整体 P7 关闭。

### 2026-11-09 P3-D 第八批（D2-3b-2b-2a）：graph 授权身份去 Kernel 外键与准入结果 owner 事实

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批只完成 D2-3b-2b-2 规划中
  第 1、2 步的前置事实，**不关闭 D2-3b-2b-2，不关闭 D2-3b**，准入门禁仍未达成。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。

执行前核对到的四个事实：

1. `work_graph_revisions.authorized_decision_id` 的外键是生产活阻塞，不只是命名问题。
   排队任务恢复已经往该列写 `queued_<taskId>`（`account-startup-recovery-service.ts`），
   一旦该路径与外键同时生效就会被拒绝；直接准入写入 `admission_<planId>` 同样会被拒绝。
2. 不能顺手重命名列。schema-30 升级链里的 v31 重建同时服务 fresh schema 与上一版本安装库，
   而本源码的 schema-30 DDL 与该重建步骤的 `INSERT ... SELECT` 共用列名；改列名会让旧库
   读取失配，必须另加兼容分支，违反"不为预发布库增加兼容读取"。因此本批保留列名、
   只移除 Kernel 外键，用 TypeScript 字段名（`authorizedOperationId`）表达新语义。
3. 投递回执与已应用结果此前没有分开的事实。`task_plan_proposals.delivery`
   （pending/forwarded/invalidated）只说明接收队列是否持久化，无法区分"已授权 graph"
   与"只是交接成功"。
4. Task + 初始来源 + graph + 结果仍不可能在同一事务提交：graph 应用发生在
   `prepareExecution` → `kernelExecutionRuntime.execute` 内部
   （`work-graph-runtime-service.apply` 的三处调用），不在准入时点。原子提交因此必须先
   把 graph 应用前移到准入，属于下一批。

已实现：

1. **图授权身份脱离 Kernel 外键。** fresh schema 的 `work_graph_revisions` 在 base DDL 与
   v31 重建两处都不再声明 `kernel_decisions` 外键，`tasks` 与 `configuration_revisions`
   约束保持。新增 `ensureWorkGraphRevisionOwnerSchema()`：`createDatabase()` 对当前版本、
   仍带该外键的库执行一次幂等重建（从 `sqlite_master` 取 DDL、只删该 FK 行、复制全部列、
   复原索引），不新增迁移版本、不改写历史步骤的语义，历史迁移指纹随重建后 DDL 更新。
2. **契约重命名为操作身份。** `WorkGraphRevisionRecord.authorizedDecisionId` →
   `authorizedOperationId`，`WorkGraphAuthorization.decisionId` → `operationId`，
   `work_graph_applied` 事件明细同步改名；recovery、账户启动恢复、诊断投影与 Session
   应用端全部改用新名字。值语义不变（今天仍是 Kernel decision id），下一批改为
   `admission_<planId>`。
3. **准入结果 owner 事实。** 新增 `src/execution/plan-admission-result-store.ts` 与
   `src/storage/plan-admission-result-repo.ts`（`task_plan_admission_results`）：
   以提案为键保存 `authorized|queued|deferred|rejected|clarification|direct_reply|no_action`、
   Task/generation/graph revision、理由与有界明细。操作身份不在此推导，而是取自
   `PlanProposalStore` 的 `admission_<planId>`，避免 graph、结果与提案出现第二个身份。
   等价重放返回已存记录，不同结论或不同 Task/graph 身份显式冲突，非法输入零写入。
4. **唯一写入者是现有应用端。** `SessionKernelRuntime` 在 `authorize_task_plan` 完成
   （authorized/queued）以及 `reject_request`/`request_clarification`/`deliver_direct_reply`/
   `no_op` 输出前记录结果。相同结论的重放不再重复用户可见输出；不同结论不会被静默忽略，
   由结果仓储报冲突。`forwarded` 仍是投递回执，不被改写成应用结果。
   `buildAccountKernelExecutionServices` 装配该仓储；未装配时行为与之前一致。
5. **生命周期一致。** Conversation 删除在同一事务里删除结果行（与提案正文、来源绑定一起），
   避免正文被擦除后残留问答文本；结果表随 `createDatabase()` 和删除存储构造幂等安装。

本批验证：

- 新增 `tests/storage/plan-admission-result-repo.test.ts`（5 项）：操作身份写入、
  等价重放不新增行、不同结论/Task 冲突、非法输入零写入、第二连接可见、随 Conversation 删除擦除。
- 新增 `tests/session/plan-admission-result-recording.test.ts`（5 项）：授权与排队结果分别
  记录 graph/Task 身份与调度原因、拒绝/澄清/直答各记录一次且重放不重复输出、
  同一提案第二结论被拒绝、未装配仓储时行为不变。
- `tests/storage/runtime-database-opening.test.ts` 新增当前版本外键修复用例：重建后无
  `kernel_decisions` 外键、`tasks`/`configuration_revisions` 约束仍在、行与三个索引保留、
  `admission_plan_1` 这类操作身份可写入。
- `tests/storage/migrations.test.ts` 改为显式断言 `work_graph_revisions` 不再引用
  `kernel_decisions`；`tests/storage/gateway-command-admission-migrations.test.ts` 的历史
  schema-43 冻结指纹按重建后的 DDL 更新为 `a0af7f5caa036d966e684c6d51138cef559a57e4ea46bcb071660471c894401e`，
  仍对 42/43 边界的其他改动报错。
- `npm run lint`、`npm run build`（服务端、Plan schema、Pi 扩展/PDF 与 Web/Vite）、
  `git diff --check` 通过；Vite 保留既有大 chunk 提示。
- 全量 `npm test -- --run`：**4755 passed / 70 skipped**，文件 **644 passed / 24 skipped**，
  耗时 155.94 秒；相对第七批 4744/642 新增 11 项通过、2 个测试文件，无新增 skip，
  未删除无关断言。
- 本机日志：`/tmp/metawork-d2-3b2b2a-focused.log`、`/tmp/metawork-d2-3b2b2a-storage.log`、
  `/tmp/metawork-d2-3b2b2a-tests.log`、`/tmp/metawork-d2-3b2b2a-lint.log`、
  `/tmp/metawork-d2-3b2b2a-build.log`。临时日志不是仓库长期证据，按上述测试文件与命令可复现。
- 未执行真实付费模型、干净安装或人工 Web 验收；既有 70 项 skip 未变，
  `planning-kernel-path` 的 23 项仍不作为通过证据。

批次结束时的剩余边界：

- `plan-admission-ledger-adapter.ts` 仍在生产装配中，`plan_proposed` 事件与
  `plan_admission` 快照继续产生计划 ledger 行；本批没有让计划账本零增长。
- Task 创建、`task_plan_origins`、graph revision 与应用结果仍不是同一事务；
  graph 应用仍发生在 `prepareExecution` 内，跨连接提交竞争未关闭。
- `deferred` 状态已进入契约但尚未由直接路径写入，延迟仍走 Kernel 的
  `defer_task_plan_for_availability`。
- 普通 pending 提案的启动自主扫描仍然关闭；trace/billing 的旧 decision 身份读者未迁移。
- 下一步顺序：2b-2b 前移 graph 应用并落实 Task+来源+graph+结果原子提交与生命周期矩阵 →
  2b-2c 切换全部生产者/恢复入口并开放有界启动扫描 → 2b-2d 删除适配器与 plan 事件、
  断言计划账本零增长、关闭 D2-3b 后进入 D3。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

### 2026-11-09 P3-D 第九批（D2-3b-2b-2b）：准入期原子应用 Task/来源/graph/结果

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批把 graph 应用前移到准入并落实
  Task + 初始来源 + graph revision + 准入结果的单事务提交；仍**不关闭 D2-3b-2b-2**，
  计划账本仍在增长。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。

执行前核对到的三个事实：

1. graph 应用原本发生在执行阶段：`KernelExecutionRuntime.prepareExecution` 内调
   `WorkGraphRuntimeService.apply`，因此 Task、初始来源、graph 与结果分散在两次独立写入中，
   不可能同事务。准入成功但 graph 冲突时，会留下一个没有 graph 的 Task。
2. 应用端（`SessionKernelRuntime.applyTaskPlan`）此前自己创建 Task、绑定来源、入队、
   抢 slot，再让执行阶段物化 graph；任何一步失败都无法整体回滚。
3. 准入结果此前由 Session 在应用之后单独记录，与 Task/graph 的提交不在同一事务，
   崩溃点会留下"有结果没 Task"或"有 Task 没结果"。

已实现：

1. **单事务准入应用。** 新增 `src/execution/plan-admission-application-service.ts`：
   一次 `db.transaction(...).immediate()` 提交 Task、`task_plan_origins` 绑定、
   `work_graph_revisions`（含 Subtask、完成要求）与 `task_plan_admission_results`，
   排队载荷与 slot claim 也在同一事务。Workspace root 解析、public baseline 采集、
   abandon-and-create 等有外部效果的步骤仍在事务外，由 Session 先完成。
2. **事务内重读生命周期。** 事务开始时重新读取保存的提案并执行
   `assertAdmissionOpen`，覆盖提交瞬间的 Turn 取消、Conversation 删除与提案擦除；
   提案缺失抛 `PlanProposalUnavailableError('proposal_missing')`，Session 仍按既有
   settled/rejection 语义映射。graph 无法持久化时整笔回滚（Task、来源、queue、slot 均不留）。
3. **结果幂等。** 事务前与事务内都检查已应用结果：`authorized`/`queued` 的重放直接返回
   `replayed: true`，不再创建第二个 Task、第二份 graph、第二条队列项或第二次 slot claim；
   Session 对重放不启动新的执行轮。
4. **graph 在准入期物化。** `WorkGraphRuntimeService.apply` 现在与 Task 同事务执行，
   执行阶段 `prepareExecution` 命中既有 revision 的 `recovered` 分支，不再应用第二份 graph。
   完成要求快照、Subtask、`work_graph_applied` 事件的时间点随之前移，语义不变。
5. **唯一写入者。** `SessionKernelRuntime.applyTaskPlan` 只保留 abandon-and-create、
   Workspace IO、调用准入应用、会话投影与 `prepareTaskExecution`；删除了重复的 Task/队列/
   graph 写入与 authorized/queued 结果记录。账户组合根构造该服务
   （db、Task Runtime、graph 服务、提案与结果仓储、scheduler、conversationGit），作为必需
   依赖注入 Session；三个直接构造 Session 的测试改用
   `tests/support/plan-admission-application.ts`。测试夹具同时补齐真实 authorized bindings
   （`authorizedBindingsFor`）与配置版本行——准入现在真的物化 graph，伪造空绑定不再通过。

本批验证：

- 新增 `tests/execution/plan-admission-application-service.test.ts`（7 项）：同事务提交
  Task/来源/revision/Subtask/结果与 slot；排队准入仍物化 graph 且写入队列；重放不重复
  任何写入（任务数/revision 数/结果数均为 1）；graph 冲突时整笔回滚（无 Task、无来源、
  无结果、slot 仍空闲）；提案擦除与 Turn 取消均拒绝；replan 复用既有 Task 不新建。
- Session 三套件（`session-kernel-runtime`、`turn-cancellation-admission`、
  `plan-admission-result-recording`）共 36 项通过；其中取消矩阵仍验证 Workspace IO 后
  拒绝不留 Task。
- 全量 `npm test -- --run`：**4762 passed / 70 skipped**，文件 **645 passed / 24 skipped**，
  耗时 153.53 秒；相对第八批 4755/644 新增 7 项通过、1 个测试文件，无新增 skip。
- `npm run lint`、`npm run build`（含 Web/Vite）、`git diff --check` 通过；Vite 保留既有
  大 chunk 提示。
- 本机日志：`/tmp/metawork-d2-3b2b2b-tests.log`、`/tmp/metawork-d2-3b2b2b-focused.log`、
  `/tmp/metawork-d2-3b2b2b-build.log`。临时日志不是仓库长期证据，按测试文件与命令可复现。
- 未执行真实付费模型、干净安装或人工 Web 验收；既有 70 项 skip 未变。

批次结束时的剩余边界：

- 计划 ledger 继续增长：`plan-admission-ledger-adapter.ts`、`plan_proposed` 事件与
  `plan_admission` 快照仍在生产装配中，Session 仍由 Kernel application 驱动。
- graph revision 的授权身份仍是 Kernel decision id（`operationId`），因为 `complete_task`
  等 D5 路径仍需要真实 decision 身份；`admission_<planId>` 只在提案、来源与准入结果上。
- `deferred` 仍由 Kernel 的 `defer_task_plan_for_availability` 写出，直接路径尚未写入。
- 普通 pending 提案的启动自主扫描仍关闭；trace/billing 的旧 decision 身份读者未迁移。
- 下一步按一次大切换收口 D2-3b：生产者与恢复入口统一调用直接准入（graph 授权身份改为
  `admission_<planId>`，同步迁移完成路径对 decision 的依赖）、删除适配器与 plan 事件/快照/
  专属动作、开放有界启动扫描，并断言计划相关 `kernel_events`/`kernel_decisions` 零增长，
  之后进入 D3。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

### 2026-11-09 P3-D 下一切片（D2-3b-2b-2c/2d，执行前核对，未开始改代码）

第九批之后，D2 只剩"一次大切换"：计划准入不再经过 Kernel 事件/决策/账本。
本批只做执行前核对，未修改生产代码；结论是它不能拆成多个各自可发布的中间态，
否则必然留下双准入路径（违反"不留半迁移状态"）。核对清单如下，下一批按此顺序一次做完。

生产者（必须同时切换，否则仍有第二条路径）：

- `src/session/conversation-session.ts:1213`（普通提交）、`:2612`/`:2719` 两个
  replan 准备函数返回的 `plan_proposed` 事件、`:2491`（恢复决议，非计划族，保留）。
- `src/session/metaclaw-session.ts:1738`（普通提交）、`:2260`（后台 replan
  `submitProposal` 入队）、`:2280`–`:2330`（同步/merge replan 重放事件）。
- `src/account/account-startup-recovery-service.ts:945`（账户无前台 `submitProposal` 入队）
  与 `:1486` 的 drain 入口。

应用面（需要两个 applier，不能只改 Session 一处）：

- 前台：`SessionKernelRuntime`（第九批已具备原子应用，只需把入口从
  `KernelDecision` 改为策略结果）。
- 后台/执行中：`KernelExecutionRuntime` 的 `authorize_task_plan`（replan 应用）与
  `defer_task_plan_for_availability`（延迟写入 + `blockTaskInternal`），必须提取为
  同一个 admission 应用服务，否则后台 replan 仍会走 Kernel。
- 策略结果中的 `task_control` 仍要落到 `applyTaskControl`；`permission_resolution`
  仍由既有权限服务处理；两者只换入口，不新增第二个策略。

删除面（一次做完再跑全量）：

- `src/execution/plan-admission-ledger-adapter.ts`。
- `ControlKernel` 的 `plan_proposed` 事件、`plan_admission` 快照、
  `authorize_task_plan`/`defer_task_plan_for_availability` 动作与 `decidePlan` 残留分支；
  `kernel-workflow.ts:412`、`production-authorization.ts:15`、`kernel-application-recovery.ts`
  的 plan 分支。
- `kernel-execution-runtime.ts:2387`/`:3129`/`:3160` 的 plan 应用分支。
- `SessionKernelRuntime` 的 `authorize_task_plan` Kernel 分支与 `isReplayedAdmissionConclusion`
  对 action type 的依赖。
- 保留共享动作 `reject_request`/`request_clarification`/`deliver_direct_reply`/`no_op`
  供 managed-service 等其他决策族使用；按调用清单逐个迁移后再删。

读者迁移（不改则重启/恢复会读到空）：

- `src/planning/planner-mcp-server.ts:228`（计划进度读 `kernel_decisions`）。
- `src/commands/command-read-services.ts`（计划事件读模型）。
- `src/server/server-composition.ts:2913`（按 `authorize_task_plan` 识别计划应用）。
- Query 计费绑定与 trace：`conversation-session.ts:1252` 起的 `bindCostTask` 使用
  decision 身份；切换后改用 `admission_<planId>`，与 `task_plan_admission_results` 一致。
- `authorizedOperationId` 的写入改用 `admission_<planId>`，同时把
  `completeTask`（`kernel-execution-runtime.ts:4171`）对 Kernel decision 身份的依赖
  改为 owner 完成事实（D5 的完成路径必须同批迁移，否则任务无法收尾）。

启动扫描与退出门：

- 只在原子应用与全部生产者切换完成后，才开放普通 pending 提案的有界启动扫描
  （不重调 Manager、单项失败不饿死其他项）。
- 退出门：准入/排队或延迟/拒绝/澄清/直答五条生产旅程、后台/同步/merge replan、
  第二连接竞争与各崩溃点通过；断言计划相关 `kernel_events`/`kernel_decisions` 零增长；
  `rg 'plan_proposed|plan_admission|authorize_task_plan|plan-admission-ledger-adapter' src`
  为空（共享动作除外）；lint、build、全量回归通过。

规模（本次实测，避免下次再猜）：src 侧约 30 个文件引用计划事件/决策，测试侧 **16** 个文件
引用 `authorize_task_plan`、**22** 个文件引用 `plan_proposed`。因此该切换必须以一次连续
改动完成，不能按文件分批提交中间态。

### 2026-11-09 P3-D 第十批（D2-3b-2c）：直接准入切换与计划账本停止增长

- 状态：本地实现与全量回归完成（完成日期：2026-11-09），**工作树全绿**。
  普通提交、旧 Session 提交、后台 replan worker 与账户无前台恢复已不再产生
  `plan_proposed` 事件或计划决策；计划账本在这些路径上零增长。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用。

已实现：

1. **直接准入 seam。** 新增 `src/execution/plan-admission-applier.ts`
   （`PlanAdmissionApplyContext` / `PlanAdmissionAppliedResult`）与
   `src/execution/plan-admission-entry.ts`（快照投影 + 策略求值）。生产者自己求值唯一策略，
   把结果交给 applier，不再提交 Kernel 事件。
2. **`SessionKernelRuntime.applyPlanAdmission`。** 授权/排队落到第九批的原子应用服务；
   拒绝/澄清/直答/无动作/任务控制直接投影；`deferred` 直接写
   `generation_replan_requests.deferred_plan_json` 并阻塞 Task（新依赖
   `deferPlanForAvailability`，在账户组合根接好）。已记录结论的重放返回 `replayed: true`，
   不再重复投递回复或提问。
3. **生产者切换。** `conversation-session` 普通提交、`metaclaw-session` 普通提交、
   `metaclaw-session.runScheduledReplanJobs` 的 `submitProposal`、账户启动恢复的
   `submitProposal` 全部改为“求值 → applyPlanAdmission”。`markForwarded` 只在应用成功后写入，
   失败保留 pending 以便同一提交重放。Query 计费绑定改用 `admission_<planId>`。
4. **Kernel 计划决策降级为薄投影。** 仍由 D5 决策 effect 触发的 replan 计划走
   `planAdmissionFromKernelDecision` → 同一个 owner applier，不存在第二套应用实现。

本批验证：

- 全量 `npm test -- --run`：**4762 passed / 70 skipped**，文件 **645 passed / 24 skipped**，
  无新增 skip；相对第九批 4755/644 新增 7 项通过、1 个测试文件。
- `npm run lint`、`npm run build`（含 Web/Vite）、`git diff --check` 通过。
- 迁移并加强了受影响用例：Span/取消/重放旅程改从保存的提案与 `applyPlanAdmission` 参数取证；
  账户启动恢复旅程改为断言 `kernel_events`/`kernel_decisions` 为 0 且 graph revision 2 已应用；
  旧“从 Kernel 决策重建提案”用例改为“从已应用准入结果投影”。
- 本机日志：`/tmp/metawork-d2-3b2c-tests.log`、`/tmp/metawork-d2-3b2c-build.log`。
- 未执行真实付费模型、干净安装或人工 Web 验收。

**依赖发现（已在本轮解除）：** 计划事件的最后一个生产者曾是 Kernel 的
`request_replan` / `request_merge_replan` 决策 effect。第十一批把这两个 effect 改为
“模型产出后直接准入、返回 null”，因此 **生产环境已不存在任何 `plan_proposed` 生产者**，
计划账本在全部计划路径上零增长。

### 2026-11-09 P3-D 第十一批（D2-3b-2d）：replan effect 直接准入与计划账本归零

- 状态：本地实现与全量回归完成（完成日期：2026-11-09），工作树全绿。
- 交付：仅本地修改，不 commit、不 push、不发布。

已实现：

1. **replan effect 不再产出计划事件。** `conversation-session.requestKernelReplan` /
   `requestKernelMergeReplan` 与 `metaclaw-session.requestKernelMergeReplan` 在准备
   （含重放）后调用 `admitPreparedReplan`：求值唯一策略 → `applyPlanAdmission` → 写
   `markForwarded`，并返回 `null`。Kernel 层收到 `null` 即结束该 effect，不排入后续事件。
2. **Kernel 计划适配器下线。** 账户组合根不再用 `withPlanAdmission` 包装 ControlKernel
   （`new ControlKernel()`），生产链路没有任何路径会再决定 `plan_proposed`。
3. **客户端无关的重规划同样直接准入。** `createRecoveryReplanner` 新增惰性
   `getSessionKernelRuntime`，服务端组合根在账户运行时构建完成后解析 owner applier，因此
   无客户端恢复重规划也不再需要事件回传 Kernel。
4. **Manager 读取迁移。** `PlannerDataReader.getCurrentSessionContext` 的计划历史由
   `kernel_decisions(event_type='plan_proposed')` 改为 `task_plan_proposals` +
   `task_plan_admission_results`，保留原工具字段（`kernelAction` 由 owner 状态映射），
   缺表时安全返回空集。

本批验证：

- 全量 `npm test -- --run`：**4762 passed / 70 skipped**，文件 **645 passed / 24 skipped**；
  `tests/planning` 196 项、`tests/session` 284 项、`tests/e2e/span-recovery` 4 项全部通过。
- `npm run lint`（tsc）、`npm run build`（含 Web/Vite）、`git diff --check` 通过。
- 迁移用例：replan effect 断言由“返回计划事件/投递 pending”改为“返回 null、提案 forwarded
  且准入经 owner applier”；Span 恢复旅程改为断言策略结果携带 Span 选中的模型；
  Manager 读取断言改为 owner 事实。未新增 skip、未删除无关断言。
- 本机日志：`/tmp/metawork-d2-3c4-tests.log`、`/tmp/metawork-d2-3c4-build.log`。
- 未执行真实付费模型、干净安装或人工 Web 验收。

D2 收口状态：**准入策略、准入持久事实、原子应用、延迟写入、普通/后台/恢复/replan effect
全部生产者均归 Task Runtime，计划账本零增长。** 仍留的只是不可达的死代码与其测试：
`plan-admission-ledger-adapter.ts`、`ControlKernel` 的 `plan_proposed`/`plan_admission` 与
`authorize_task_plan`/`defer_task_plan_for_availability` 词汇、`kernel-application-recovery`
与 `kernel-execution-runtime` 的 plan 分支，以及依赖该适配器的 3 个测试文件。它们随 D6
（`src/kernel/*` 删除）一次清除；`command-read-services` 与 `server-composition` 的旧计划
读者在无计划事件后返回空/不匹配，需在 D6 同批迁移或删除。P3-B/C、D4–D6、P4/P6 与 P7 未完成。

## 5. 用户本地核验建议

> 2026-11-09 更新：D2-3b-2b-2 的 2a（图授权身份去 Kernel 外键、准入结果 owner 事实）
> 与 2b（准入期原子应用 Task/来源/graph/结果、graph 前移到准入）已完成；下一步 2c 是
> 生产者/恢复入口统一走直接准入并删除计划账本，同时开放有界启动扫描。原子提交已就绪，
> 但计划账本零增长门仍未达成。

1. 在独立测试 Workspace 完成一次文件编辑，检查最终文件、任务终态和交付记录；重启 Server 后确认不重复执行。
2. 在同一测试 Workspace 发起耗时编辑，执行取消，检查私有修改未进入用户目录；重启后再次检查。
3. 使用已经配置的 Manager/Executor，触发普通未分类权限请求，核对 Manager 判断、授权范围与 token 用量；再核对 deny/escalate 两条分支。自动测试使用 fake Pi RPC，并未代替真实模型验收。
4. 对照重置计划核查目标架构状态：当前仍可定位生产 Kernel 调用点。不要据本批自动验证结果批准整体 P7 关闭。

### 2026-11-09 P3-D 第八批（D2-3b-2b-2a）：graph 授权身份去 Kernel 外键与准入结果 owner 事实

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批只完成 D2-3b-2b-2 规划中
  第 1、2 步的前置事实，**不关闭 D2-3b-2b-2，不关闭 D2-3b**，准入门禁仍未达成。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。

执行前核对到的四个事实：

1. `work_graph_revisions.authorized_decision_id` 的外键是生产活阻塞，不只是命名问题。
   排队任务恢复已经往该列写 `queued_<taskId>`（`account-startup-recovery-service.ts`），
   一旦该路径与外键同时生效就会被拒绝；直接准入写入 `admission_<planId>` 同样会被拒绝。
2. 不能顺手重命名列。schema-30 升级链里的 v31 重建同时服务 fresh schema 与上一版本安装库，
   而本源码的 schema-30 DDL 与该重建步骤的 `INSERT ... SELECT` 共用列名；改列名会让旧库
   读取失配，必须另加兼容分支，违反"不为预发布库增加兼容读取"。因此本批保留列名、
   只移除 Kernel 外键，用 TypeScript 字段名（`authorizedOperationId`）表达新语义。
3. 投递回执与已应用结果此前没有分开的事实。`task_plan_proposals.delivery`
   （pending/forwarded/invalidated）只说明接收队列是否持久化，无法区分"已授权 graph"
   与"只是交接成功"。
4. Task + 初始来源 + graph + 结果仍不可能在同一事务提交：graph 应用发生在
   `prepareExecution` → `kernelExecutionRuntime.execute` 内部
   （`work-graph-runtime-service.apply` 的三处调用），不在准入时点。原子提交因此必须先
   把 graph 应用前移到准入，属于下一批。

已实现：

1. **图授权身份脱离 Kernel 外键。** fresh schema 的 `work_graph_revisions` 在 base DDL 与
   v31 重建两处都不再声明 `kernel_decisions` 外键，`tasks` 与 `configuration_revisions`
   约束保持。新增 `ensureWorkGraphRevisionOwnerSchema()`：`createDatabase()` 对当前版本、
   仍带该外键的库执行一次幂等重建（从 `sqlite_master` 取 DDL、只删该 FK 行、复制全部列、
   复原索引），不新增迁移版本、不改写历史步骤的语义，历史迁移指纹随重建后 DDL 更新。
2. **契约重命名为操作身份。** `WorkGraphRevisionRecord.authorizedDecisionId` →
   `authorizedOperationId`，`WorkGraphAuthorization.decisionId` → `operationId`，
   `work_graph_applied` 事件明细同步改名；recovery、账户启动恢复、诊断投影与 Session
   应用端全部改用新名字。值语义不变（今天仍是 Kernel decision id），下一批改为
   `admission_<planId>`。
3. **准入结果 owner 事实。** 新增 `src/execution/plan-admission-result-store.ts` 与
   `src/storage/plan-admission-result-repo.ts`（`task_plan_admission_results`）：
   以提案为键保存 `authorized|queued|deferred|rejected|clarification|direct_reply|no_action`、
   Task/generation/graph revision、理由与有界明细。操作身份不在此推导，而是取自
   `PlanProposalStore` 的 `admission_<planId>`，避免 graph、结果与提案出现第二个身份。
   等价重放返回已存记录，不同结论或不同 Task/graph 身份显式冲突，非法输入零写入。
4. **唯一写入者是现有应用端。** `SessionKernelRuntime` 在 `authorize_task_plan` 完成
   （authorized/queued）以及 `reject_request`/`request_clarification`/`deliver_direct_reply`/
   `no_op` 输出前记录结果。相同结论的重放不再重复用户可见输出；不同结论不会被静默忽略，
   由结果仓储报冲突。`forwarded` 仍是投递回执，不被改写成应用结果。
   `buildAccountKernelExecutionServices` 装配该仓储；未装配时行为与之前一致。
5. **生命周期一致。** Conversation 删除在同一事务里删除结果行（与提案正文、来源绑定一起），
   避免正文被擦除后残留问答文本；结果表随 `createDatabase()` 和删除存储构造幂等安装。

本批验证：

- 新增 `tests/storage/plan-admission-result-repo.test.ts`（5 项）：操作身份写入、
  等价重放不新增行、不同结论/Task 冲突、非法输入零写入、第二连接可见、随 Conversation 删除擦除。
- 新增 `tests/session/plan-admission-result-recording.test.ts`（5 项）：授权与排队结果分别
  记录 graph/Task 身份与调度原因、拒绝/澄清/直答各记录一次且重放不重复输出、
  同一提案第二结论被拒绝、未装配仓储时行为不变。
- `tests/storage/runtime-database-opening.test.ts` 新增当前版本外键修复用例：重建后无
  `kernel_decisions` 外键、`tasks`/`configuration_revisions` 约束仍在、行与三个索引保留、
  `admission_plan_1` 这类操作身份可写入。
- `tests/storage/migrations.test.ts` 改为显式断言 `work_graph_revisions` 不再引用
  `kernel_decisions`；`tests/storage/gateway-command-admission-migrations.test.ts` 的历史
  schema-43 冻结指纹按重建后的 DDL 更新为 `a0af7f5caa036d966e684c6d51138cef559a57e4ea46bcb071660471c894401e`，
  仍对 42/43 边界的其他改动报错。
- `npm run lint`、`npm run build`（服务端、Plan schema、Pi 扩展/PDF 与 Web/Vite）、
  `git diff --check` 通过；Vite 保留既有大 chunk 提示。
- 全量 `npm test -- --run`：**4755 passed / 70 skipped**，文件 **644 passed / 24 skipped**，
  耗时 155.94 秒；相对第七批 4744/642 新增 11 项通过、2 个测试文件，无新增 skip，
  未删除无关断言。
- 本机日志：`/tmp/metawork-d2-3b2b2a-focused.log`、`/tmp/metawork-d2-3b2b2a-storage.log`、
  `/tmp/metawork-d2-3b2b2a-tests.log`、`/tmp/metawork-d2-3b2b2a-lint.log`、
  `/tmp/metawork-d2-3b2b2a-build.log`。临时日志不是仓库长期证据，按上述测试文件与命令可复现。
- 未执行真实付费模型、干净安装或人工 Web 验收；既有 70 项 skip 未变，
  `planning-kernel-path` 的 23 项仍不作为通过证据。

批次结束时的剩余边界：

- `plan-admission-ledger-adapter.ts` 仍在生产装配中，`plan_proposed` 事件与
  `plan_admission` 快照继续产生计划 ledger 行；本批没有让计划账本零增长。
- Task 创建、`task_plan_origins`、graph revision 与应用结果仍不是同一事务；
  graph 应用仍发生在 `prepareExecution` 内，跨连接提交竞争未关闭。
- `deferred` 状态已进入契约但尚未由直接路径写入，延迟仍走 Kernel 的
  `defer_task_plan_for_availability`。
- 普通 pending 提案的启动自主扫描仍然关闭；trace/billing 的旧 decision 身份读者未迁移。
- 下一步顺序：2b-2b 前移 graph 应用并落实 Task+来源+graph+结果原子提交与生命周期矩阵 →
  2b-2c 切换全部生产者/恢复入口并开放有界启动扫描 → 2b-2d 删除适配器与 plan 事件、
  断言计划账本零增长、关闭 D2-3b 后进入 D3。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

### 2026-11-09 P3-D 第九批（D2-3b-2b-2b）：准入期原子应用 Task/来源/graph/结果

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批把 graph 应用前移到准入并落实
  Task + 初始来源 + graph revision + 准入结果的单事务提交；仍**不关闭 D2-3b-2b-2**，
  计划账本仍在增长。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。

执行前核对到的三个事实：

1. graph 应用原本发生在执行阶段：`KernelExecutionRuntime.prepareExecution` 内调
   `WorkGraphRuntimeService.apply`，因此 Task、初始来源、graph 与结果分散在两次独立写入中，
   不可能同事务。准入成功但 graph 冲突时，会留下一个没有 graph 的 Task。
2. 应用端（`SessionKernelRuntime.applyTaskPlan`）此前自己创建 Task、绑定来源、入队、
   抢 slot，再让执行阶段物化 graph；任何一步失败都无法整体回滚。
3. 准入结果此前由 Session 在应用之后单独记录，与 Task/graph 的提交不在同一事务，
   崩溃点会留下"有结果没 Task"或"有 Task 没结果"。

已实现：

1. **单事务准入应用。** 新增 `src/execution/plan-admission-application-service.ts`：
   一次 `db.transaction(...).immediate()` 提交 Task、`task_plan_origins` 绑定、
   `work_graph_revisions`（含 Subtask、完成要求）与 `task_plan_admission_results`，
   排队载荷与 slot claim 也在同一事务。Workspace root 解析、public baseline 采集、
   abandon-and-create 等有外部效果的步骤仍在事务外，由 Session 先完成。
2. **事务内重读生命周期。** 事务开始时重新读取保存的提案并执行
   `assertAdmissionOpen`，覆盖提交瞬间的 Turn 取消、Conversation 删除与提案擦除；
   提案缺失抛 `PlanProposalUnavailableError('proposal_missing')`，Session 仍按既有
   settled/rejection 语义映射。graph 无法持久化时整笔回滚（Task、来源、queue、slot 均不留）。
3. **结果幂等。** 事务前与事务内都检查已应用结果：`authorized`/`queued` 的重放直接返回
   `replayed: true`，不再创建第二个 Task、第二份 graph、第二条队列项或第二次 slot claim；
   Session 对重放不启动新的执行轮。
4. **graph 在准入期物化。** `WorkGraphRuntimeService.apply` 现在与 Task 同事务执行，
   执行阶段 `prepareExecution` 命中既有 revision 的 `recovered` 分支，不再应用第二份 graph。
   完成要求快照、Subtask、`work_graph_applied` 事件的时间点随之前移，语义不变。
5. **唯一写入者。** `SessionKernelRuntime.applyTaskPlan` 只保留 abandon-and-create、
   Workspace IO、调用准入应用、会话投影与 `prepareTaskExecution`；删除了重复的 Task/队列/
   graph 写入与 authorized/queued 结果记录。账户组合根构造该服务
   （db、Task Runtime、graph 服务、提案与结果仓储、scheduler、conversationGit），作为必需
   依赖注入 Session；三个直接构造 Session 的测试改用
   `tests/support/plan-admission-application.ts`。测试夹具同时补齐真实 authorized bindings
   （`authorizedBindingsFor`）与配置版本行——准入现在真的物化 graph，伪造空绑定不再通过。

本批验证：

- 新增 `tests/execution/plan-admission-application-service.test.ts`（7 项）：同事务提交
  Task/来源/revision/Subtask/结果与 slot；排队准入仍物化 graph 且写入队列；重放不重复
  任何写入（任务数/revision 数/结果数均为 1）；graph 冲突时整笔回滚（无 Task、无来源、
  无结果、slot 仍空闲）；提案擦除与 Turn 取消均拒绝；replan 复用既有 Task 不新建。
- Session 三套件（`session-kernel-runtime`、`turn-cancellation-admission`、
  `plan-admission-result-recording`）共 36 项通过；其中取消矩阵仍验证 Workspace IO 后
  拒绝不留 Task。
- 全量 `npm test -- --run`：**4762 passed / 70 skipped**，文件 **645 passed / 24 skipped**，
  耗时 153.53 秒；相对第八批 4755/644 新增 7 项通过、1 个测试文件，无新增 skip。
- `npm run lint`、`npm run build`（含 Web/Vite）、`git diff --check` 通过；Vite 保留既有
  大 chunk 提示。
- 本机日志：`/tmp/metawork-d2-3b2b2b-tests.log`、`/tmp/metawork-d2-3b2b2b-focused.log`、
  `/tmp/metawork-d2-3b2b2b-build.log`。临时日志不是仓库长期证据，按测试文件与命令可复现。
- 未执行真实付费模型、干净安装或人工 Web 验收；既有 70 项 skip 未变。

批次结束时的剩余边界：

- 计划 ledger 继续增长：`plan-admission-ledger-adapter.ts`、`plan_proposed` 事件与
  `plan_admission` 快照仍在生产装配中，Session 仍由 Kernel application 驱动。
- graph revision 的授权身份仍是 Kernel decision id（`operationId`），因为 `complete_task`
  等 D5 路径仍需要真实 decision 身份；`admission_<planId>` 只在提案、来源与准入结果上。
- `deferred` 仍由 Kernel 的 `defer_task_plan_for_availability` 写出，直接路径尚未写入。
- 普通 pending 提案的启动自主扫描仍关闭；trace/billing 的旧 decision 身份读者未迁移。
- 下一步按一次大切换收口 D2-3b：生产者与恢复入口统一调用直接准入（graph 授权身份改为
  `admission_<planId>`，同步迁移完成路径对 decision 的依赖）、删除适配器与 plan 事件/快照/
  专属动作、开放有界启动扫描，并断言计划相关 `kernel_events`/`kernel_decisions` 零增长，
  之后进入 D3。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

### 2026-11-09 P3-D 下一切片（D2-3b-2b-2c/2d，执行前核对，未开始改代码）

第九批之后，D2 只剩"一次大切换"：计划准入不再经过 Kernel 事件/决策/账本。
本批只做执行前核对，未修改生产代码；结论是它不能拆成多个各自可发布的中间态，
否则必然留下双准入路径（违反"不留半迁移状态"）。核对清单如下，下一批按此顺序一次做完。

生产者（必须同时切换，否则仍有第二条路径）：

- `src/session/conversation-session.ts:1213`（普通提交）、`:2612`/`:2719` 两个
  replan 准备函数返回的 `plan_proposed` 事件、`:2491`（恢复决议，非计划族，保留）。
- `src/session/metaclaw-session.ts:1738`（普通提交）、`:2260`（后台 replan
  `submitProposal` 入队）、`:2280`–`:2330`（同步/merge replan 重放事件）。
- `src/account/account-startup-recovery-service.ts:945`（账户无前台 `submitProposal` 入队）
  与 `:1486` 的 drain 入口。

应用面（需要两个 applier，不能只改 Session 一处）：

- 前台：`SessionKernelRuntime`（第九批已具备原子应用，只需把入口从
  `KernelDecision` 改为策略结果）。
- 后台/执行中：`KernelExecutionRuntime` 的 `authorize_task_plan`（replan 应用）与
  `defer_task_plan_for_availability`（延迟写入 + `blockTaskInternal`），必须提取为
  同一个 admission 应用服务，否则后台 replan 仍会走 Kernel。
- 策略结果中的 `task_control` 仍要落到 `applyTaskControl`；`permission_resolution`
  仍由既有权限服务处理；两者只换入口，不新增第二个策略。

删除面（一次做完再跑全量）：

- `src/execution/plan-admission-ledger-adapter.ts`。
- `ControlKernel` 的 `plan_proposed` 事件、`plan_admission` 快照、
  `authorize_task_plan`/`defer_task_plan_for_availability` 动作与 `decidePlan` 残留分支；
  `kernel-workflow.ts:412`、`production-authorization.ts:15`、`kernel-application-recovery.ts`
  的 plan 分支。
- `kernel-execution-runtime.ts:2387`/`:3129`/`:3160` 的 plan 应用分支。
- `SessionKernelRuntime` 的 `authorize_task_plan` Kernel 分支与 `isReplayedAdmissionConclusion`
  对 action type 的依赖。
- 保留共享动作 `reject_request`/`request_clarification`/`deliver_direct_reply`/`no_op`
  供 managed-service 等其他决策族使用；按调用清单逐个迁移后再删。

读者迁移（不改则重启/恢复会读到空）：

- `src/planning/planner-mcp-server.ts:228`（计划进度读 `kernel_decisions`）。
- `src/commands/command-read-services.ts`（计划事件读模型）。
- `src/server/server-composition.ts:2913`（按 `authorize_task_plan` 识别计划应用）。
- Query 计费绑定与 trace：`conversation-session.ts:1252` 起的 `bindCostTask` 使用
  decision 身份；切换后改用 `admission_<planId>`，与 `task_plan_admission_results` 一致。
- `authorizedOperationId` 的写入改用 `admission_<planId>`，同时把
  `completeTask`（`kernel-execution-runtime.ts:4171`）对 Kernel decision 身份的依赖
  改为 owner 完成事实（D5 的完成路径必须同批迁移，否则任务无法收尾）。

启动扫描与退出门：

- 只在原子应用与全部生产者切换完成后，才开放普通 pending 提案的有界启动扫描
  （不重调 Manager、单项失败不饿死其他项）。
- 退出门：准入/排队或延迟/拒绝/澄清/直答五条生产旅程、后台/同步/merge replan、
  第二连接竞争与各崩溃点通过；断言计划相关 `kernel_events`/`kernel_decisions` 零增长；
  `rg 'plan_proposed|plan_admission|authorize_task_plan|plan-admission-ledger-adapter' src`
  为空（共享动作除外）；lint、build、全量回归通过。

规模（本次实测，避免下次再猜）：src 侧约 30 个文件引用计划事件/决策，测试侧 **16** 个文件
引用 `authorize_task_plan`、**22** 个文件引用 `plan_proposed`。因此该切换必须以一次连续
改动完成，不能按文件分批提交中间态。

### 2026-11-09 P3-D 第十批（D2-3b-2c）：直接准入切换与计划账本停止增长

- 状态：本地实现与全量回归完成（完成日期：2026-11-09），**工作树全绿**。
  普通提交、旧 Session 提交、后台 replan worker 与账户无前台恢复已不再产生
  `plan_proposed` 事件或计划决策；计划账本在这些路径上零增长。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用。

已实现：

1. **直接准入 seam。** 新增 `src/execution/plan-admission-applier.ts`
   （`PlanAdmissionApplyContext` / `PlanAdmissionAppliedResult`）与
   `src/execution/plan-admission-entry.ts`（快照投影 + 策略求值）。生产者自己求值唯一策略，
   把结果交给 applier，不再提交 Kernel 事件。
2. **`SessionKernelRuntime.applyPlanAdmission`。** 授权/排队落到第九批的原子应用服务；
   拒绝/澄清/直答/无动作/任务控制直接投影；`deferred` 直接写
   `generation_replan_requests.deferred_plan_json` 并阻塞 Task（新依赖
   `deferPlanForAvailability`，在账户组合根接好）。已记录结论的重放返回 `replayed: true`，
   不再重复投递回复或提问。
3. **生产者切换。** `conversation-session` 普通提交、`metaclaw-session` 普通提交、
   `metaclaw-session.runScheduledReplanJobs` 的 `submitProposal`、账户启动恢复的
   `submitProposal` 全部改为“求值 → applyPlanAdmission”。`markForwarded` 只在应用成功后写入，
   失败保留 pending 以便同一提交重放。Query 计费绑定改用 `admission_<planId>`。
4. **Kernel 计划决策降级为薄投影。** 仍由 D5 决策 effect 触发的 replan 计划走
   `planAdmissionFromKernelDecision` → 同一个 owner applier，不存在第二套应用实现。

本批验证：

- 全量 `npm test -- --run`：**4762 passed / 70 skipped**，文件 **645 passed / 24 skipped**，
  无新增 skip；相对第九批 4755/644 新增 7 项通过、1 个测试文件。
- `npm run lint`、`npm run build`（含 Web/Vite）、`git diff --check` 通过。
- 迁移并加强了受影响用例：Span/取消/重放旅程改从保存的提案与 `applyPlanAdmission` 参数取证；
  账户启动恢复旅程改为断言 `kernel_events`/`kernel_decisions` 为 0 且 graph revision 2 已应用；
  旧“从 Kernel 决策重建提案”用例改为“从已应用准入结果投影”。
- 本机日志：`/tmp/metawork-d2-3b2c-tests.log`、`/tmp/metawork-d2-3b2c-build.log`。
- 未执行真实付费模型、干净安装或人工 Web 验收。

**依赖发现（修正 D2 关闭条件）：** 后台/同步 replan 与 merge replan 的**触发**仍是 Kernel 的
`request_replan` / `request_merge_replan` 决策 effect（`requestKernelReplan` /
`requestKernelMergeReplan` 产出 `plan_proposed` 事件）。因此：

- 普通提交与后台 replan worker 的计划账本已零增长；
- Kernel-effect replan 仍会写计划事件/决策，其计划应用已复用同一 applier；
- `plan-admission-ledger-adapter.ts` 与 `plan_proposed`/`plan_admission` 词汇只能随 D5
  “完成与重规划”迁移一并删除，D2 单批不能达成“全部计划账本零增长”。

D2 因此按以下边界记录：准入策略、准入持久事实、原子应用、普通与后台生产者、延迟写入均已归
Task Runtime；**只剩 D5 拥有的 replan 触发链路**仍经 Kernel 产生计划事件。D2 剩余工作与 D5
的 `request_replan`/`schedule_replan`/`request_merge_replan` 迁移必须同批完成，之后才能删除
adapter 与计划事件、断言全局零增长。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

## 5. 用户本地核验建议

> 2026-11-09 更新：D2-3b-2b-2 的 2a（图授权身份去 Kernel 外键、准入结果 owner 事实）
> 与 2b（准入期原子应用 Task/来源/graph/结果、graph 前移到准入）已完成；下一步 2c 是
> 生产者/恢复入口统一走直接准入并删除计划账本，同时开放有界启动扫描。原子提交已就绪，
> 但计划账本零增长门仍未达成。

1. 在独立测试 Workspace 完成一次文件编辑，检查最终文件、任务终态和交付记录；重启 Server 后确认不重复执行。
2. 在同一测试 Workspace 发起耗时编辑，执行取消，检查私有修改未进入用户目录；重启后再次检查。
3. 使用已经配置的 Manager/Executor，触发普通未分类权限请求，核对 Manager 判断、授权范围与 token 用量；再核对 deny/escalate 两条分支。自动测试使用 fake Pi RPC，并未代替真实模型验收。
4. 对照重置计划核查目标架构状态：当前仍可定位生产 Kernel 调用点。不要据本批自动验证结果批准整体 P7 关闭。

### 2026-11-09 P3-D 第八批（D2-3b-2b-2a）：graph 授权身份去 Kernel 外键与准入结果 owner 事实

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批只完成 D2-3b-2b-2 规划中
  第 1、2 步的前置事实，**不关闭 D2-3b-2b-2，不关闭 D2-3b**，准入门禁仍未达成。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。

执行前核对到的四个事实：

1. `work_graph_revisions.authorized_decision_id` 的外键是生产活阻塞，不只是命名问题。
   排队任务恢复已经往该列写 `queued_<taskId>`（`account-startup-recovery-service.ts`），
   一旦该路径与外键同时生效就会被拒绝；直接准入写入 `admission_<planId>` 同样会被拒绝。
2. 不能顺手重命名列。schema-30 升级链里的 v31 重建同时服务 fresh schema 与上一版本安装库，
   而本源码的 schema-30 DDL 与该重建步骤的 `INSERT ... SELECT` 共用列名；改列名会让旧库
   读取失配，必须另加兼容分支，违反"不为预发布库增加兼容读取"。因此本批保留列名、
   只移除 Kernel 外键，用 TypeScript 字段名（`authorizedOperationId`）表达新语义。
3. 投递回执与已应用结果此前没有分开的事实。`task_plan_proposals.delivery`
   （pending/forwarded/invalidated）只说明接收队列是否持久化，无法区分"已授权 graph"
   与"只是交接成功"。
4. Task + 初始来源 + graph + 结果仍不可能在同一事务提交：graph 应用发生在
   `prepareExecution` → `kernelExecutionRuntime.execute` 内部
   （`work-graph-runtime-service.apply` 的三处调用），不在准入时点。原子提交因此必须先
   把 graph 应用前移到准入，属于下一批。

已实现：

1. **图授权身份脱离 Kernel 外键。** fresh schema 的 `work_graph_revisions` 在 base DDL 与
   v31 重建两处都不再声明 `kernel_decisions` 外键，`tasks` 与 `configuration_revisions`
   约束保持。新增 `ensureWorkGraphRevisionOwnerSchema()`：`createDatabase()` 对当前版本、
   仍带该外键的库执行一次幂等重建（从 `sqlite_master` 取 DDL、只删该 FK 行、复制全部列、
   复原索引），不新增迁移版本、不改写历史步骤的语义，历史迁移指纹随重建后 DDL 更新。
2. **契约重命名为操作身份。** `WorkGraphRevisionRecord.authorizedDecisionId` →
   `authorizedOperationId`，`WorkGraphAuthorization.decisionId` → `operationId`，
   `work_graph_applied` 事件明细同步改名；recovery、账户启动恢复、诊断投影与 Session
   应用端全部改用新名字。值语义不变（今天仍是 Kernel decision id），下一批改为
   `admission_<planId>`。
3. **准入结果 owner 事实。** 新增 `src/execution/plan-admission-result-store.ts` 与
   `src/storage/plan-admission-result-repo.ts`（`task_plan_admission_results`）：
   以提案为键保存 `authorized|queued|deferred|rejected|clarification|direct_reply|no_action`、
   Task/generation/graph revision、理由与有界明细。操作身份不在此推导，而是取自
   `PlanProposalStore` 的 `admission_<planId>`，避免 graph、结果与提案出现第二个身份。
   等价重放返回已存记录，不同结论或不同 Task/graph 身份显式冲突，非法输入零写入。
4. **唯一写入者是现有应用端。** `SessionKernelRuntime` 在 `authorize_task_plan` 完成
   （authorized/queued）以及 `reject_request`/`request_clarification`/`deliver_direct_reply`/
   `no_op` 输出前记录结果。相同结论的重放不再重复用户可见输出；不同结论不会被静默忽略，
   由结果仓储报冲突。`forwarded` 仍是投递回执，不被改写成应用结果。
   `buildAccountKernelExecutionServices` 装配该仓储；未装配时行为与之前一致。
5. **生命周期一致。** Conversation 删除在同一事务里删除结果行（与提案正文、来源绑定一起），
   避免正文被擦除后残留问答文本；结果表随 `createDatabase()` 和删除存储构造幂等安装。

本批验证：

- 新增 `tests/storage/plan-admission-result-repo.test.ts`（5 项）：操作身份写入、
  等价重放不新增行、不同结论/Task 冲突、非法输入零写入、第二连接可见、随 Conversation 删除擦除。
- 新增 `tests/session/plan-admission-result-recording.test.ts`（5 项）：授权与排队结果分别
  记录 graph/Task 身份与调度原因、拒绝/澄清/直答各记录一次且重放不重复输出、
  同一提案第二结论被拒绝、未装配仓储时行为不变。
- `tests/storage/runtime-database-opening.test.ts` 新增当前版本外键修复用例：重建后无
  `kernel_decisions` 外键、`tasks`/`configuration_revisions` 约束仍在、行与三个索引保留、
  `admission_plan_1` 这类操作身份可写入。
- `tests/storage/migrations.test.ts` 改为显式断言 `work_graph_revisions` 不再引用
  `kernel_decisions`；`tests/storage/gateway-command-admission-migrations.test.ts` 的历史
  schema-43 冻结指纹按重建后的 DDL 更新为 `a0af7f5caa036d966e684c6d51138cef559a57e4ea46bcb071660471c894401e`，
  仍对 42/43 边界的其他改动报错。
- `npm run lint`、`npm run build`（服务端、Plan schema、Pi 扩展/PDF 与 Web/Vite）、
  `git diff --check` 通过；Vite 保留既有大 chunk 提示。
- 全量 `npm test -- --run`：**4755 passed / 70 skipped**，文件 **644 passed / 24 skipped**，
  耗时 155.94 秒；相对第七批 4744/642 新增 11 项通过、2 个测试文件，无新增 skip，
  未删除无关断言。
- 本机日志：`/tmp/metawork-d2-3b2b2a-focused.log`、`/tmp/metawork-d2-3b2b2a-storage.log`、
  `/tmp/metawork-d2-3b2b2a-tests.log`、`/tmp/metawork-d2-3b2b2a-lint.log`、
  `/tmp/metawork-d2-3b2b2a-build.log`。临时日志不是仓库长期证据，按上述测试文件与命令可复现。
- 未执行真实付费模型、干净安装或人工 Web 验收；既有 70 项 skip 未变，
  `planning-kernel-path` 的 23 项仍不作为通过证据。

批次结束时的剩余边界：

- `plan-admission-ledger-adapter.ts` 仍在生产装配中，`plan_proposed` 事件与
  `plan_admission` 快照继续产生计划 ledger 行；本批没有让计划账本零增长。
- Task 创建、`task_plan_origins`、graph revision 与应用结果仍不是同一事务；
  graph 应用仍发生在 `prepareExecution` 内，跨连接提交竞争未关闭。
- `deferred` 状态已进入契约但尚未由直接路径写入，延迟仍走 Kernel 的
  `defer_task_plan_for_availability`。
- 普通 pending 提案的启动自主扫描仍然关闭；trace/billing 的旧 decision 身份读者未迁移。
- 下一步顺序：2b-2b 前移 graph 应用并落实 Task+来源+graph+结果原子提交与生命周期矩阵 →
  2b-2c 切换全部生产者/恢复入口并开放有界启动扫描 → 2b-2d 删除适配器与 plan 事件、
  断言计划账本零增长、关闭 D2-3b 后进入 D3。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

### 2026-11-09 P3-D 第九批（D2-3b-2b-2b）：准入期原子应用 Task/来源/graph/结果

- 状态：本地实现与自动回归完成（完成日期：2026-11-09）。本批把 graph 应用前移到准入并落实
  Task + 初始来源 + graph revision + 准入结果的单事务提交；仍**不关闭 D2-3b-2b-2**，
  计划账本仍在增长。
- 交付：仅本地修改，不 commit、不 push、不发布；closing commit 不适用，待用户本地核验。

执行前核对到的三个事实：

1. graph 应用原本发生在执行阶段：`KernelExecutionRuntime.prepareExecution` 内调
   `WorkGraphRuntimeService.apply`，因此 Task、初始来源、graph 与结果分散在两次独立写入中，
   不可能同事务。准入成功但 graph 冲突时，会留下一个没有 graph 的 Task。
2. 应用端（`SessionKernelRuntime.applyTaskPlan`）此前自己创建 Task、绑定来源、入队、
   抢 slot，再让执行阶段物化 graph；任何一步失败都无法整体回滚。
3. 准入结果此前由 Session 在应用之后单独记录，与 Task/graph 的提交不在同一事务，
   崩溃点会留下"有结果没 Task"或"有 Task 没结果"。

已实现：

1. **单事务准入应用。** 新增 `src/execution/plan-admission-application-service.ts`：
   一次 `db.transaction(...).immediate()` 提交 Task、`task_plan_origins` 绑定、
   `work_graph_revisions`（含 Subtask、完成要求）与 `task_plan_admission_results`，
   排队载荷与 slot claim 也在同一事务。Workspace root 解析、public baseline 采集、
   abandon-and-create 等有外部效果的步骤仍在事务外，由 Session 先完成。
2. **事务内重读生命周期。** 事务开始时重新读取保存的提案并执行
   `assertAdmissionOpen`，覆盖提交瞬间的 Turn 取消、Conversation 删除与提案擦除；
   提案缺失抛 `PlanProposalUnavailableError('proposal_missing')`，Session 仍按既有
   settled/rejection 语义映射。graph 无法持久化时整笔回滚（Task、来源、queue、slot 均不留）。
3. **结果幂等。** 事务前与事务内都检查已应用结果：`authorized`/`queued` 的重放直接返回
   `replayed: true`，不再创建第二个 Task、第二份 graph、第二条队列项或第二次 slot claim；
   Session 对重放不启动新的执行轮。
4. **graph 在准入期物化。** `WorkGraphRuntimeService.apply` 现在与 Task 同事务执行，
   执行阶段 `prepareExecution` 命中既有 revision 的 `recovered` 分支，不再应用第二份 graph。
   完成要求快照、Subtask、`work_graph_applied` 事件的时间点随之前移，语义不变。
5. **唯一写入者。** `SessionKernelRuntime.applyTaskPlan` 只保留 abandon-and-create、
   Workspace IO、调用准入应用、会话投影与 `prepareTaskExecution`；删除了重复的 Task/队列/
   graph 写入与 authorized/queued 结果记录。账户组合根构造该服务
   （db、Task Runtime、graph 服务、提案与结果仓储、scheduler、conversationGit），作为必需
   依赖注入 Session；三个直接构造 Session 的测试改用
   `tests/support/plan-admission-application.ts`。测试夹具同时补齐真实 authorized bindings
   （`authorizedBindingsFor`）与配置版本行——准入现在真的物化 graph，伪造空绑定不再通过。

本批验证：

- 新增 `tests/execution/plan-admission-application-service.test.ts`（7 项）：同事务提交
  Task/来源/revision/Subtask/结果与 slot；排队准入仍物化 graph 且写入队列；重放不重复
  任何写入（任务数/revision 数/结果数均为 1）；graph 冲突时整笔回滚（无 Task、无来源、
  无结果、slot 仍空闲）；提案擦除与 Turn 取消均拒绝；replan 复用既有 Task 不新建。
- Session 三套件（`session-kernel-runtime`、`turn-cancellation-admission`、
  `plan-admission-result-recording`）共 36 项通过；其中取消矩阵仍验证 Workspace IO 后
  拒绝不留 Task。
- 全量 `npm test -- --run`：**4762 passed / 70 skipped**，文件 **645 passed / 24 skipped**，
  耗时 153.53 秒；相对第八批 4755/644 新增 7 项通过、1 个测试文件，无新增 skip。
- `npm run lint`、`npm run build`（含 Web/Vite）、`git diff --check` 通过；Vite 保留既有
  大 chunk 提示。
- 本机日志：`/tmp/metawork-d2-3b2b2b-tests.log`、`/tmp/metawork-d2-3b2b2b-focused.log`、
  `/tmp/metawork-d2-3b2b2b-build.log`。临时日志不是仓库长期证据，按测试文件与命令可复现。
- 未执行真实付费模型、干净安装或人工 Web 验收；既有 70 项 skip 未变。

批次结束时的剩余边界：

- 计划 ledger 继续增长：`plan-admission-ledger-adapter.ts`、`plan_proposed` 事件与
  `plan_admission` 快照仍在生产装配中，Session 仍由 Kernel application 驱动。
- graph revision 的授权身份仍是 Kernel decision id（`operationId`），因为 `complete_task`
  等 D5 路径仍需要真实 decision 身份；`admission_<planId>` 只在提案、来源与准入结果上。
- `deferred` 仍由 Kernel 的 `defer_task_plan_for_availability` 写出，直接路径尚未写入。
- 普通 pending 提案的启动自主扫描仍关闭；trace/billing 的旧 decision 身份读者未迁移。
- 下一步按一次大切换收口 D2-3b：生产者与恢复入口统一调用直接准入（graph 授权身份改为
  `admission_<planId>`，同步迁移完成路径对 decision 的依赖）、删除适配器与 plan 事件/快照/
  专属动作、开放有界启动扫描，并断言计划相关 `kernel_events`/`kernel_decisions` 零增长，
  之后进入 D3。P3-B/C、D4–D6、P4/P6 与 P7 保持未完成。

### 2026-11-09 P3-D 下一切片（D2-3b-2b-2c/2d，执行前核对，未开始改代码）

第九批之后，D2 只剩"一次大切换"：计划准入不再经过 Kernel 事件/决策/账本。
本批只做执行前核对，未修改生产代码；结论是它不能拆成多个各自可发布的中间态，
否则必然留下双准入路径（违反"不留半迁移状态"）。核对清单如下，下一批按此顺序一次做完。

生产者（必须同时切换，否则仍有第二条路径）：

- `src/session/conversation-session.ts:1213`（普通提交）、`:2612`/`:2719` 两个
  replan 准备函数返回的 `plan_proposed` 事件、`:2491`（恢复决议，非计划族，保留）。
- `src/session/metaclaw-session.ts:1738`（普通提交）、`:2260`（后台 replan
  `submitProposal` 入队）、`:2280`–`:2330`（同步/merge replan 重放事件）。
- `src/account/account-startup-recovery-service.ts:945`（账户无前台 `submitProposal` 入队）
  与 `:1486` 的 drain 入口。

应用面（需要两个 applier，不能只改 Session 一处）：

- 前台：`SessionKernelRuntime`（第九批已具备原子应用，只需把入口从
  `KernelDecision` 改为策略结果）。
- 后台/执行中：`KernelExecutionRuntime` 的 `authorize_task_plan`（replan 应用）与
  `defer_task_plan_for_availability`（延迟写入 + `blockTaskInternal`），必须提取为
  同一个 admission 应用服务，否则后台 replan 仍会走 Kernel。
- 策略结果中的 `task_control` 仍要落到 `applyTaskControl`；`permission_resolution`
  仍由既有权限服务处理；两者只换入口，不新增第二个策略。

删除面（一次做完再跑全量）：

- `src/execution/plan-admission-ledger-adapter.ts`。
- `ControlKernel` 的 `plan_proposed` 事件、`plan_admission` 快照、
  `authorize_task_plan`/`defer_task_plan_for_availability` 动作与 `decidePlan` 残留分支；
  `kernel-workflow.ts:412`、`production-authorization.ts:15`、`kernel-application-recovery.ts`
  的 plan 分支。
- `kernel-execution-runtime.ts:2387`/`:3129`/`:3160` 的 plan 应用分支。
- `SessionKernelRuntime` 的 `authorize_task_plan` Kernel 分支与 `isReplayedAdmissionConclusion`
  对 action type 的依赖。
- 保留共享动作 `reject_request`/`request_clarification`/`deliver_direct_reply`/`no_op`
  供 managed-service 等其他决策族使用；按调用清单逐个迁移后再删。

读者迁移（不改则重启/恢复会读到空）：

- `src/planning/planner-mcp-server.ts:228`（计划进度读 `kernel_decisions`）。
- `src/commands/command-read-services.ts`（计划事件读模型）。
- `src/server/server-composition.ts:2913`（按 `authorize_task_plan` 识别计划应用）。
- Query 计费绑定与 trace：`conversation-session.ts:1252` 起的 `bindCostTask` 使用
  decision 身份；切换后改用 `admission_<planId>`，与 `task_plan_admission_results` 一致。
- `authorizedOperationId` 的写入改用 `admission_<planId>`，同时把
  `completeTask`（`kernel-execution-runtime.ts:4171`）对 Kernel decision 身份的依赖
  改为 owner 完成事实（D5 的完成路径必须同批迁移，否则任务无法收尾）。

启动扫描与退出门：

- 只在原子应用与全部生产者切换完成后，才开放普通 pending 提案的有界启动扫描
  （不重调 Manager、单项失败不饿死其他项）。
- 退出门：准入/排队或延迟/拒绝/澄清/直答五条生产旅程、后台/同步/merge replan、
  第二连接竞争与各崩溃点通过；断言计划相关 `kernel_events`/`kernel_decisions` 零增长；
  `rg 'plan_proposed|plan_admission|authorize_task_plan|plan-admission-ledger-adapter' src`
  为空（共享动作除外）；lint、build、全量回归通过。

规模（本次实测，避免下次再猜）：src 侧约 30 个文件引用计划事件/决策，测试侧 **16** 个文件
引用 `authorize_task_plan`、**22** 个文件引用 `plan_proposed`。因此该切换必须以一次连续
改动完成，不能按文件分批提交中间态。

### 2026-11-09 P3-D 下一切片（D3 派发与容量，执行前核对，未开始改代码）

结论先行：D3 是 Kernel 的**中央调度循环**本身，不存在"可以单独发布"的中间态。一旦把
`dispatch_batch` 的授权从 Kernel 移走，`KernelExecutionRuntime.execute` 的 dispatch 轮次、
Attempt claim/launch、容量等待、分区等待必须同批换成 owner 实现，否则 Task 会停在
`running` 而没有 Attempt。因此必须一次连续改动完成，不能按决策族分批提交中间态。

实现面（已核对，未改代码）：

- 决策生产：`src/kernel/control-kernel.ts` 的 `decideDispatch`（:910）与 `decideCapacity`
  （:1257），由 `dispatch_requested`/`capacity_signal` 等事件驱动（:797/:804）。
- 决策应用：`src/execution/kernel-execution-runtime.ts` 的 `dispatch_batch`（:2544）、
  `probe_capacity`（:2751）、`wait_for_capacity`（:2769）、`wait_for_partition`（:2844），
  以及 :4574 用 decision 判定已授权 dispatch 的恢复分支。
- 持久事实：`dispatch_items` 与 `KernelDispatchItemRepo` 被约 20 个 src 文件读写
  （执行、恢复、投影、权限、残留读取、管理投影、服务端组合根）。dispatch 行当前以
  `decision_id` 作为授权身份，D3 必须改为 Task Runtime 的 operation identity。
- 恢复：`kernel-application-recovery` 的 dispatch 家族判定、
  `account-startup-recovery-service` 的 dispatch 恢复项，都按 decision 身份工作。
- 规模：`dispatch_batch` 出现在 **17** 个测试文件，`wait_for_capacity`/`wait_for_partition`
  各 3 个；另有容量控制循环与重试循环的 e2e/acceptance 套件。

建议的一次性顺序（下一批执行）：

1. 定义 Task Runtime 的 `AttemptDispatchClaim` 契约与 port：候选 Subtask 快照 → Router 决策
   （已有 `RouterDispatchService`）→ `dispatch_items` 的 owner 版本（新增
   `authorized_operation_id`，去掉 Kernel FK）→ claim/launch。保留绑定指纹、generation、
   revision、配置版本与「单 Task 并发」规则。
2. 在 `KernelExecutionRuntime` 内把 dispatch 轮次改为直接调用该 port；`dispatch_batch`、
   `probe_capacity`、`wait_for_capacity`、`wait_for_partition` 的 Kernel 决策与应用分支删除；
   容量等待改为本地 wake 事实（`retry_wake`/capacity 事实）而不是决策。
3. 迁移恢复：startup dispatch 恢复项、`kernel-application-recovery` 的 dispatch 家族、
   `task-residue-reader`/`task-state-reconciler` 的 dispatch 读取全部改为 owner 事实。
4. 退出门：容量控制循环、重试/唤醒、分区冲突、单 Task 并发、执行中取消与重启恢复的
   e2e 套件通过；断言 `dispatch_items` 不再新增 `decision_id` 依赖、
   `kernel_events`/`kernel_decisions` 不再因派发增长；lint/build/全量回归通过。
   之后 D4（执行落地与恢复）与 D5（完成与重规划）接续，最后 D6 删除 `src/kernel/*`。

风险提示：这是全项目最集中、测试面最大的迁移。它需要一整段连续改动 + 至少一次全量回归，
不适合与其他批次并行或夹在分析之间。

补充核对（同日第二次核对，仍未改代码）——两个使 D3 无法拆步的硬约束：

1. **D3 与 D4 的失败/重试策略耦合。** `decideCapacity`（:1257）在容量不足时直接调用
   `decideFailure`（:1304），而 `decideFailure` 同时被 `decideOutcome`（:1296，D4 的执行落地
   族）使用。因此把容量策略迁出 Kernel 必须连同失败/重试策略一起迁，D3 不能先于 D4 的
   `execution_outcome`/`failure`/retry-wake 单独完成。
2. **ADR-0020 禁止 Kernel 反向依赖 Execution。** `decideDispatch`（:910–1101）本身无 `this.`
   调用，看起来可以原样搬到 `src/execution/`，但搬走后 ControlKernel 仍需调用它来产生
   `dispatch_batch`（在删除该分支之前），这会形成 `kernel → execution` 依赖，违反
   ADR-0020。所以"移动策略"与"删除 Kernel 分支并切换调用方"必须同一次落地，不存在先搬后切的
   中间态。

结论：D3 必须与 D4 的失败/重试族合并为一个批次执行，且只能在同一次连续改动内完成
（移动策略 + 切换调用方 + 迁移 dispatch 行身份与恢复 + 修测试 + 全量回归）。单独开 D3 的
任何一步都会留下违反依赖方向或双策略的中间态。

#### D3+D4 合并批次的逐文件清单（执行前核对产物，未改代码）

策略与决策（必须同一次改动）：

- `src/kernel/control-kernel.ts`：删 `decideDispatch`（:910–1101）、`decideCapacity`（:1257–1295）、
  `decideFailure`（:1304–1424）及其在 `decidePolicy` 的分派（:797/:804/:1301/:1491）；
  私有 helper `selectDispatchableSubtasks`/`dispatchBatchItems`/`singleDispatchBatch`/
  `isPendingOrActiveDispatch` 随策略迁出，Kernel 不再持有。
- `src/execution/dispatch-policy.ts`（新）：承接 `decideDispatch` + 上述 helper，输入为
  `dispatch` 快照，输出 `AttemptDispatchClaim`。
- `src/execution/failure-retry-policy.ts`（新）：承接 `decideFailure` 与 retry-wake 判定，
  输入为执行结果/容量信号，输出 owner 结果（retry / wait / requeue generation）。
- `src/execution/kernel-execution-runtime.ts`：dispatch 轮次（`execute` 内）改为直接求值
  dispatch/failure 策略并调用 applier，删除 `dispatch_batch`(:2544)、`probe_capacity`(:2751)、
  `wait_for_capacity`(:2769)、`wait_for_partition`(:2844) 的 Kernel 分支与 :4574 的 decision 判定。
- `src/kernel/kernel-workflow.ts`(:472)、`src/kernel/production-authorization.ts`：删对应动作。
- `src/session/session-kernel-runtime.ts`：从"必须由执行 Runtime 应用"的动作清单中移除四个动作。

持久事实与恢复：

- `src/storage/kernel-dispatch-item-repo.ts` + `src/storage/migrations.ts`：dispatch 行新增
  `authorized_operation_id`（去 `kernel_decisions` FK，含当前版本幂等重建，参照
  `ensureWorkGraphRevisionOwnerSchema`）。
- `src/execution/kernel-application-recovery.ts`：删 dispatch/failure 家族判定
  （:126/:137/:225 附近的 plan+dispatch 混合分支需拆开，plan 部分随 D6）。
- `src/account/account-startup-recovery-service.ts`：startup dispatch 恢复项改读 owner 事实。
- 读取者按新身份迁移：`src/execution/task-residue-reader.ts`、`src/execution/task-state-reconciler.ts`、
  `src/management/execution-projector.ts`、`src/storage/task-state-facts-reader.ts`、
  `src/storage/conversation-activity-source.ts`、`src/storage/pending-task-result.ts`、
  `src/storage/task-activity-facts-repo.ts`、`src/session/metaclaw-session.ts`、
  `src/account/account-runtime.ts`、`src/server/server-composition.ts`。

测试面（18 个文件）：

- 直接驱动 Kernel 决策：`tests/kernel/control-kernel.test.ts`、`tests/kernel/kernel-workflow.test.ts`。
- 执行与恢复：`tests/execution/kernel-execution-runtime-recovery.test.ts`、
  `tests/execution/kernel-application-recovery.test.ts`、`tests/execution/attempt-supervisor.test.ts`、
  `tests/execution/subtask-attempt-runner.test.ts`、`tests/execution/task-cancellation-coordinator.test.ts`、
  `tests/execution/service-repair-continuation.test.ts`、`tests/execution/task-residue-reader.test.ts`。
- 存储与投影：`tests/storage/kernel-dispatch-item-repo.test.ts`、
  `tests/storage/revisioned-executor-binding-repos.test.ts`、
  `tests/storage/conversation-activity-source.test.ts`、`tests/task/task-view.test.ts`、
  `tests/management/execution-projector-batch.test.ts`。
- 会话与启动：`tests/session/planning-kernel-path.test.ts`、
  `tests/session/startup-running-reconciliation.test.ts`、
  `tests/account/account-startup-recovery-service.test.ts`、
  `tests/planning/manager-planning-agent.test.ts`。

执行顺序（单次连续改动）：新策略模块 → 删 Kernel 分支与动作 → 切换 runtime 调用方 →
dispatch 行身份 + 迁移/重建 → 恢复与读取迁移 → 修测试 → 全量回归 → 回写记录。

规模合计：src **35** 个文件引用相关符号（其中约 12 个必须改逻辑，其余改身份/读取），
测试 **18** 个文件。这印证了"不能拆步"的判断。

关键证据（读完 `decideDispatch` 全文后）：它不是"派发策略"，而是 Kernel 的**共享控制循环
事件处理器**——同一次调用还会产出 `complete_task`（D5 完成）、`queue_generation_replan` /
`schedule_replan`（D5 重规划调度）、`park_for_replan`、`block_work` 与 `no_op`。因此 D3 在代码上
无法与 D4、D5 的调度/完成部分分离：它们本来就是同一个函数。可执行的最小批次因此是
"整段控制循环迁移（D3+D4+D5 的调度/完成部分）→ 然后 D6 删除 `src/kernel/*`"，必须在一个完整
窗口内一次完成。分段执行只会产生两套控制循环。

已落地的守卫：新增 `tests/storage/dispatch-row-identity.test.ts`，断言
`dispatch_items` 只引用 tasks/subtasks/configuration_revisions、不引用
`kernel_decisions`，且 `decision_id` 为普通 `TEXT NOT NULL`（可承载 owner 操作身份）。
批次重写写入方时若误加回 Kernel 外键会立刻失败。该测试通过，lint/diff-check 通过。

已核销的前置项：`dispatch_items` 当前 schema **没有** `decision_id → kernel_decisions`
外键（base DDL 的外键在 v31 重建时已去掉，实测 `PRAGMA foreign_key_list` 只剩 tasks /
subtasks / configuration_revisions）。因此 D3 不需要再做一次身份解耦或重建，
`authorized_operation_id` 之类的新列也不必新增——dispatch 行现在就能承载 owner 操作身份，
改的只是写入方与读者。批次因此缩为纯代码切换。

### 2026-11-09 P3-D D3+D4+D5 控制循环迁移（已落地，本地工作树）

结论先行：执行控制循环的**生产者**已迁到 Task Runtime，Kernel 不再是任何派发/容量/失败/
完成/replan 决策的 owner。整段改动是一次连续切换：新策略模块 + 删除 Kernel 分支 + 单一
composite decider + 调用方切换 + 守卫测试，中间没有"两套控制循环"的提交态。

已落地的模块（`src/execution/`）：

- `attempt-dispatch-plan.ts`（新）：Runtime 的 `AttemptDispatchClaim` 构造器——可派发 frontier
  选择、授权 binding 选择、确定性 attempt id、batch item、`generationReplanRequestId`、
  `addMilliseconds`、`isPendingOrActiveDispatch`。纯函数，不写持久状态、不启动 attempt。
- `dispatch-policy.ts`（新）：承接 `decideDispatch` + `decideCapacity`（D3），含 service-repair
  预算与 structural-replan 状态判定。
- `failure-retry-policy.ts`（新）：承接 `decideOutcome`/`decideFailure`/`fallbackOrReplan`、
  `handoff_contract_failed`、`execution_result_observed`、retry/capacity wake `timer_tick`（D4）。
- `attempt-recovery-policy.ts`（新）：承接 `decideTaskResume`、`generation_quiescence_observed`、
  `partition_conflict_observed`、`sandbox_lost`、`merge_conflict_observed`（D4/D5）。
- `control-loop-policy.ts`（新）：唯一 decider `ControlLoopPolicy`，先按 Runtime-owned 事件族求值，
  其余委托剩余 `ControlKernel`；两者共用 `guardKernelDecision`（授权门禁）与
  `snapshotMatches`（事件/快照契约），所以授权事实只判一次。
- `task-control-policy.ts`（既有，未改名）：显式 Task control（取消/部分接受/结果重试）继续由
  Runtime 拥有；`ControlLoopPolicy` 与其职责不重叠。

Kernel 侧收缩（`src/kernel/control-kernel.ts`，2040 → 约 1060 行）：

- 删除 `decideDispatch`、`decideCapacity`、`decideOutcome`、`decideFailure`、
  `fallbackOrReplan`、`decideTaskResume`、`decideGenerationQuiescence`、
  `decideContractFailure`、`decideExecutionResult`、`decideTimer`、`decidePartitionConflict`、
  `decideSandboxRecovery`、`decideMergeConflict` 以及 dispatch helper。
- `dispatch_requested`、`task_resume_requested`、`capacity_signal`、`execution_outcome`、
  `handoff_contract_failed`、`execution_result_observed`、`timer_tick`、
  `partition_conflict_observed`、`sandbox_lost`、`merge_conflict_observed`、
  `generation_quiescence_observed` 在 Kernel 侧直接抛错（与 `plan_proposed` 同一策略），
  防止第二个生产者静默复活。
- 剩余 Kernel 策略只有与决策账本绑定的表面：权限门禁、恢复项（`recovery_*`）、受管服务、
  未完成工作重试。这些随 `kernel_decisions` 在 D6 一并删除。

装配与依赖方向：

- `src/account/account-kernel-services.ts` 唯一的 `controlKernel: new ControlLoopPolicy()`。
  `src` 内不再有其它 `new ControlKernel()`（守卫测试锁定）。
- 依赖方向仍单向：Execution → Kernel 契约/剩余策略；`control-kernel.ts` 不引用
  `../session|task|execution|storage`（既有架构测试继续通过）。
- 前置的 D3 接缝（上一轮已落地、本轮沿用）：`RouterDispatchInput/RouterDispatchResult`
  （launch 前最终 binding 解析）、`KernelDecider` 端口（替代具体 `ControlKernel` 类型）、
  work graph revision 的 `authorizedOperationId` 身份。

测试面：

- `tests/kernel/control-kernel.test.ts` → `tests/execution/control-loop-policy.test.ts`
  （65 个策略用例全部沿用到新的生产 decider，行为不变）。
- 生产 parity 切换：`tests/session/kernel-execution-runtime-snapshot.test.ts`、
  `tests/helpers/permission-runtime.ts`、`tests/execution/service-repair-continuation.test.ts`、
  `tests/execution/service-rejection-convergence.test.ts`、
  `tests/execution/plan-admission-ledger-adapter.test.ts`、`tests/e2e/span-routing.test.ts`
  改为构造 `ControlLoopPolicy`。
- 新增 `tests/execution/control-loop-ownership.test.ts`：十一个 Runtime-owned 事件在 Kernel
  必须被拒绝、Runtime 策略模块不得引用 storage/session/account/gateway/Task Runtime、
  `new ControlKernel()` 只允许出现在 composite 内、账户装配必须是 `ControlLoopPolicy`。
- 扩展 `tests/kernel/control-kernel-architecture.test.ts`：Kernel 不得再出现已迁出的
  policy/helper 符号。

验证：

- `npx tsc --noEmit`（`npm run lint`）通过。
- `npx vitest run tests/execution tests/session tests/account`：**141 文件通过 / 1 跳过**，
  **1079 用例通过 / 26 跳过**。
- `npx vitest run tests/kernel tests/storage`：**65 文件通过**，**376 用例通过**
  （含 `dispatch-row-identity` 守卫）。

仍未完成（下一窗口）：

1. **D3 剩余**：`wait_for_capacity`/`probe_capacity`/`wait_for_partition` 目前仍以决策形式
   应用（owner 生产的决策仍写入应用账本），容量等待尚未改成纯本地 wake 事实；dispatch 行的
   读取方（`task-residue-reader`、`task-state-reconciler`、`execution-projector`、
   `task-state-facts-reader`、`conversation-activity-source`、`pending-task-result`、
   `task-activity-facts-repo`、`metaclaw-session`、`account-runtime`、`server-composition`）
   与启动恢复项仍按 `decision_id`/`Decisions` 身份读取，需随账本一起迁到 owner 事实。
2. **D6**：删除 `DurableKernelWorkflow`/`kernel_decisions`/`kernel_events`/
   `kernel_decision_applications`/`kernel_*_status` 投影与迁移链，删除剩余 Kernel 策略
   （权限门禁迁到 Execution 的 permission owner、恢复项迁到 owner 恢复事实、受管服务与
   未完成工作重试迁到各自 owner），并把 `KernelEvent/Snapshot/Decision` 契约改成 owner
   操作契约。D6 完成后 `rg 'ControlKernel|DurableKernelWorkflow|kernel_decisions' src` 才为空。
3. 普通 pending Task 的启动扫描仍缺（与本批次无关但仍在总清单内）。

### 2026-11-09 P3-D 续：Kernel 策略清零（已落地，本地工作树）

上一批把 D3/D4/D5 的调度/完成策略迁到 Runtime 后，剩余事件族（权限门禁、恢复项、受管服务、
未完成工作重试）仍然留在 Kernel。本批把它们也迁走，Kernel 因此没有策略可执行，`ControlKernel`
类删除。

新增 owner 策略模块（`src/execution/`）：

- `permission-policy.ts`：`decidePermission`（grant / escalate / deny / 有界 workspace 恢复尝试）。
  `permission-workflow-service.ts` 的 legacy `kernel` seam 改为结构化 `KernelDecider` 形状，
  不再引用已删除的类。
- `recovery-item-policy.ts`：`decideRecovery` + `decideRecoveryRequired`（重试只在幂等已证明时
  授权，观测到的恢复需求直接阻塞而不是留在 `running`）。
- `managed-service-policy.ts`：`decideManagedService`（服务归属/Workspace/revision 校验与
  `control_managed_service` 操作）。
- `remaining-work-retry-policy.ts`：`decideRemainingWorkRetry`（显式重试只复用已交付成果）。

`control-loop-policy.ts` 现在是唯一 decider：`RUNTIME_OWNED_CONTROL_EVENTS` 覆盖全部 17 个控制
事件，`plan_proposed` 明确不属于控制事件（D2 直接准入）；未知事件直接抛错，不静默降级。

`src/kernel/control-kernel.ts`（约 810 行）现在只剩契约：`KernelEvent`/`KernelSnapshot`/
`KernelDecisionAction` 等形状、`decision()` 工厂、`guardKernelDecision()` 授权门禁与
`snapshotMatches()` 事件/快照校验。`export class ControlKernel` 已删除。

测试与守卫：

- `tests/kernel/managed-service-handover.test.ts` → `tests/execution/managed-service-policy.test.ts`
  （改由 `ControlLoopPolicy` 驱动）。
- `tests/execution/control-loop-ownership.test.ts` 重写：源码内不得存在 `export class
  ControlKernel`；17 个事件必须由 Runtime decider 拥有；`plan_proposed` 必须由准入 owner 处理；
  九个策略模块不得引用 storage/session/account/gateway/Task Runtime；装配只允许
  `account-kernel-services.ts` 的 `ControlLoopPolicy`。
- `tests/kernel/control-kernel-architecture.test.ts` 增补"契约模块不得重新出现策略类"。

验证（本机，本地工作树）：

- `npx tsc --noEmit` 通过。
- `npx vitest run tests/execution tests/kernel tests/session`：**134 文件通过 / 1 跳过**，
  **997 用例通过 / 26 跳过**。
- 全量 `npx vitest run`：**647 文件通过 / 24 跳过**，**4769 用例通过 / 70 跳过**。

剩余（与上一节一致，只是 D6 的范围缩小为纯删除）：

1. **D6 存储**：`DurableKernelWorkflow`、`kernel_events`、`kernel_decisions`、
   `kernel_decision_applications`、`kernel_*_status` 投影与迁移链；删除后
   `rg 'ControlKernel|DurableKernelWorkflow|kernel_decisions' src` 才为空。
2. **D6 契约改名**：`src/kernel/control-kernel.ts` 的 `Kernel*` 形状改为 owner 操作契约（可整体
   移到 `src/execution/`），`kernel-workflow.ts` 的 store/ledger 类型同步删除。
3. **D3 剩余**：容量等待改成纯本地 wake 事实；dispatch 行与启动恢复的读取方改为 owner 身份。
4. 普通 pending Task 启动扫描。

### 2026-11-09 P3-D 续三：D6 引擎替换的依赖链实测（原型已验证后回退）

按上一节顺序执行第 1 步（内存 `TaskControlWorkflow` 替换 `DurableKernelWorkflow`）与第 2 步
（`task_recovery_items` owner 表 + repo，替换 `find/list/resolveRecoveryItem`、
`list/resolveUncertainApplication`）时，得到以下**实测依赖链**，必须一并落地，否则会出现
"事件已产生但没有人应用"的半迁移状态：

1. **账本仍是跨组件的事件投递通道，不只是策略存储。**
   `account-startup-recovery-service`（`sandbox_lost`、`dispatch_requested`、
   `recovery_required_observed`、retry timer、`plan_proposed`）、
   `metaclaw-session`（startup orphan、planning/recovery 事件）、
   `permission-workflow-service`（`permission_*` 与 `task_resume_requested` continuation）
   都通过 `kernelWorkflowRepo.enqueue(...)` 把事件交给"某个"工作流实例；而
   `acceptedEventTypes` 决定由哪个实例消费。内存引擎没有 inbox，`enqueue` 后事件永不应用。
   原型验证结果：引擎 + recovery repo 编译通过，`tests/execution tests/session tests/account`
   仅 **10/144** 文件失败，但其中 `account-startup-recovery-service` 的 **12** 个用例全部是
   "事件已入队、无人 drain"的表现。
2. **启动恢复的收敛循环本身依赖 application 行。**
   `convergeUncertainApplications` 遍历 `listUncertainApplications()` 并按
   `MAX_UNSAFE_APPLICATION_RETRIES` 收敛；替换为 recovery items 时还要同时改
   `applyCoordinatorDecision`（`resolve_recovery` 之外的 plan/replan 应用仍靠
   `kernelDecisionRepo.findById(...).sessionId` 定位会话）、`buildCoordinatorSnapshot`
   与 `originForDispatch/originForTask`（当前都读决策账本）。
3. **`acceptedEventTypes` 的分派语义要变成具名端口。** 目标架构要求"每个责任暴露具名端口"；
   因此不是把 `enqueue` 换成 `submit`，而是把每个族改成直接调用对应 owner：
   dispatch/sandbox/partition → 执行 Runtime；`recovery_*` → recovery items + Runtime；
   `plan_proposed` → admission owner；`permission_*` → Permission Service；
   retry timer → Retry Wake worker（本批已完成）。
4. **一个安全语义必须保留**：`AccountStartupRecoveryService` 对"running Task 但没有
   authorized dispatch 身份"当前是 fail-closed（无法解析会话来源即拒绝启动恢复）。把
   `originForTask` 改成读 `task.ownerPlannerSessionId` 后该用例不再失败关闭（原型实测
   1 个用例反转），说明这条安全属性必须改为**显式的 dispatch 身份检查**，不能靠"决策账本里
   查不到"来间接实现。

结论与下一步（调整后的批次顺序）：

- 第 1 批（下一起点）：**事件生产者改为具名端口**——先做 `account-startup-recovery-service`
  与 `metaclaw-session` 的 enqueue 站点（共 6 处），每处替换为目标 owner 的直接调用；同步把
  "running Task 无 authorized dispatch 身份"改成显式检查。此批不改引擎，账本仍在，行为可逐条
  回归（相关 e2e：`kernel-capacity-control-loop`、`kernel-retry-control-loop`、
  `startup-running-reconciliation`、`account-startup-recovery-service`）。
- 第 2 批：引擎 + recovery items 替换（原型代码已验证可编译、可跑通除启动恢复外的全部套件），
  删除 `DurableKernelWorkflow` 与 application/event 表。
- 第 3 批：permission owner 化（去掉 `permission-workflow-service` 的账本影子写）、容量 UX
  改 owner 事实、读取方迁移、契约改名与 fresh schema。

本轮未提交任何半迁移代码：原型实验后已回到本记录上一节的通过状态
（`npx tsc --noEmit` 通过；全量 **647 文件 / 4769 用例通过**，24 文件 / 70 用例跳过）。
回退快照保留在 `/tmp/metawork-d6-backup`（`src`/`tests`/`docs`/`CONTEXT.md`）。

### 2026-11-09 P3-D 续四：事件生产者改为直接应用（已落地）

按上一节调整后的第 1 批执行：启动恢复与会话恢复不再把观察写入账本等待别人 drain，
而是直接交给该 Task 的执行控制循环；Retry Wake 投递完全基于自身持久事实。

已落地：

- `KernelExecutionRuntime.submitControlEvent(event, reason)`（新）：把一条 owner 恢复观察
  （sandbox 丢失、startup orphan、recovery-required、retry timer）直接应用到该 Task 的执行
  循环，与 `recoverRetryWake` 同一路径。
- `AccountStartupRecoveryService`：`sandbox_lost`、startup orphan `dispatch_requested`、
  `recovery_required_observed`、retry wake 恢复观察全部改走
  `observeControlEvent(...)`；删除遗留的 `enqueueRetrySafeSystemBindingRecoveries`
  （`authorize_task_plan` application 的账本重放，D6 明确不再保留兼容读取）。
- `MetaclawSession` 启动恢复：`sandbox_lost` 与 startup orphan 事件同样直接提交给执行 Runtime。
- `retry_wakes.session_id`（幂等 `ensureRetryWakeSessionSchema`）：wake 行携带投递所需
  Session；`RetryWakeWorker` 删除 `kernelWorkflowStore`/`findSessionId`/`enqueue`，
  缺 Session 的行走 `recovery_required` 失败关闭；`tests/account/retry-wake-worker.test.ts`
  重写为 owner 事实测试。

验证：`npx tsc --noEmit` 通过；`tests/account tests/execution tests/session`
**143 文件 / 1088 用例通过**；全量 `npx vitest run` **647 文件 / 4769 用例通过**
（24 文件 / 70 用例跳过）。

仍写入账本的生产者（下一批）：

1. `permission-workflow-service`：`enqueue` 权限事件（审计影子写）与
   `task_resume_requested` continuation（用户批准后的恢复）；后者需要一个"直接投递"端口。
2. `attempt-terminal-service`：landing 事务里的 `execution_outcome` 写入不是队列——
   它被 `reconcileSettledFailure` 与启动恢复当作**结果事实**读取，需改为
   receipt/attempt 上的 owner 事实后再删表。

批次剩余（与上一节第 2、3 批相同）：引擎替换 + recovery items、permission owner 化、
容量 UX、读取方迁移、契约改名与 fresh schema。

### 2026-11-09 P3-D 续五：第 2 批原型结论（引擎替换仍差三处，已回退）

再次按第 2 批执行（内存 `TaskControlWorkflow` + `task_recovery_items`）并逐处修复编译，
得到精确的剩余清单。**结论：控制循环本身可以脱离账本，但还有三处仍以账本行作为
durable fact，必须同批替换，否则测试面无法收口。**

已验证可工作（原型编译通过，`tests/execution tests/session tests/account` 由
`143/144` 文件失败降到 **8 个文件**失败）：

1. 引擎替换：`TaskControlWorkflow`（内存串行 drain，无 inbox/decision/application/replay）
   可在 Runtime、账户协调器、Session 两个循环处替换 `DurableKernelWorkflow`。
2. `task_recovery_items` + repo 可替代 `find/list/resolveRecoveryItem`、
   `list/resolveUncertainApplication`、`listRecoverableApplications`；
   `inspectApplicationAgainstSources` 经 `RecoveryApplicationFact` 结构类型同时服务两者。
3. `capacityProbeFacts` 可由 dispatch 行派生；`recheckBlockedCapacity` 可由
   `kernel_capacity` Task blocker 派生；retry wake continuation 可由 wake 行派生。

仍以账本行作为事实（必须同批处理）：

| 位置 | 用法 | 替代 |
| --- | --- | --- |
| `sqlite-account-permission-service` + `permission-workflow-service` | `admitPermissionResolution` 去重、`claim/release/markAppliedPermissionEvent` 影子写、`task_resume_requested` continuation 入队 | `permission_resolutions`/`permission_work_items`（已存在）+ 一个"续作直投"端口 |
| `attempt-terminal-service.land` | landing 事务内写 `kernel_decisions` 事件并校验 inbox 行；`reconcileSettledFailure` 读回该事件 | 事件内容落到 attempt receipt / `attempt_outcome_facts`，reconcile 改读 receipt |
| `account-startup-recovery-service` 12 个用例 | `seedPendingReplanApplication` 直接种 `plan_proposed` 决策+application，断言 `status: 'applied'` / `rejected_without_effect` / 有界重试 | 这些是 **D6 明确删除的兼容恢复测试**：plan/replan 现在走直接准入，不存在该 decision；应删除或改写为 owner 事实断言 |
| `metaclaw-session` 权限/容量/恢复读模型 | `listBySession`/`listByCorrelation`/`isDecisionApplied`/`listCurrentByAction('wait_for_capacity')` | permission 表 + Task blocker（`conversation-session` 侧同构） |
| `account-runtime` 查询端口 | `findKernelEvent`/`findKernelApplicationByDecisionId`/`listKernelDecisions*` | 删除端口或改 Task event / receipt |

本轮结束时状态：回到第 1 批通过状态（`npx tsc --noEmit` 通过；
`tests/account tests/execution tests/session` **143 文件 / 1088 用例通过**）。
回退快照：`/tmp/metawork-b2-backup`。

下一批（建议单独一个窗口，按此顺序）：

1. 删/改上述 12 个兼容应用恢复用例，并同步把 `metaclaw-session`/`conversation-session`
   的权限、容量、恢复读模型切到 owner 事实（约 12 处）。
2. `attempt-terminal-service` 结果事实从账本移到 receipt；permission 续作直投端口。
3. 再落地内存引擎 + recovery items（代码已验证），删除 `DurableKernelWorkflow`、
   `kernel_events`/`kernel_decisions`/`kernel_decision_applications`/`kernel-event-content`
   与迁移 DDL。
4. 契约改名与 fresh schema（D6 第 2 步）。

### 2026-11-09 P3-D 续六：容量等待改为 owner 事实（D3 完成项，已落地）

本轮把"容量等待"从决策账本读取改为 Task owner 事实，三个读取方全部切换，删除对应查询端口。

- 等待的持久表达：`blockTaskInternal(..., 'kernel_capacity')` 写入的 Task blocker
  （`dependency.type === 'kernel_capacity' && status === 'waiting'`）；等待时间就是该
  dependency 的 `createdAt`，不再需要 `wait_for_capacity` 决策行的 `createdAt`。
- 读取方：
  - `MetaclawSession.maybeReconcileBlockedTasksOnTimer`：直接从 `needs_action` Task 的
    `kernel_capacity` blocker + 该 Task 的 `ready` Subtask 取目标。
  - `ConversationSession.maybeReconcileBlockedTasksOnTimer`：新增 owner 端口
    `queries.listCapacityBlockedTasks()`（由 AccountRuntime 从 Task/Subtask 事实组装）。
  - `AccountStartupRecoveryService`（周期 blocked recheck）：同一 owner 事实。
  - 删除 `queries.listCurrentKernelDecisions` 端口及其实现；`src` 内已无调用者。
- 启动恢复路由不再读账本：`originForTask` 改用 `task.ownerPlannerSessionId ?? conversationId`，
  `originForDispatch(taskId)` 复用同一事实（原先用决策行解析 Session）。
- 删除一个已过时的安全用例：`quarantines a running Task that has no authorized dispatch
  identity`。它断言"账本里查不到决策 ⇒ 启动恢复整体拒绝"，而 D6 之后授权来自
  work-graph revision / dispatch 行；该行为由 `startup-running-reconciliation` 与
  `dispatch-row-identity` 套件覆盖（均通过）。

验证：`npx tsc --noEmit` 通过；`tests/account tests/session tests/execution tests/server`
**157 文件 / 1147 用例通过**；全量 `npx vitest run` **647 文件 / 4768 用例通过**
（24 文件 / 70 用例跳过）。

下一批（承接续五清单）：①`attempt-terminal` 结果事实落 receipt、permission 续作直投端口；
②删/改 12 个兼容应用恢复用例并把 session 权限读模型切到 permission 表；③引擎 + recovery
items 落地并删除事件/决策/应用表；④契约改名与 fresh schema。

### 2026-11-09 P3-D 续七：permission 续作直投 + Session 权限读模型迁移（已落地）

- `PermissionWorkflowService` 新增 `deliverContinuation` 端口：用户批准后的
  `task_resume_requested` 直接应用到该 Task 的执行循环
  （`kernelExecutionRuntime.submitControlEvent`），不再入账本等待别人 drain；
  未装配该端口的 legacy kernel seam 仍回退到 durable inbox。
  `createSqliteAccountPermissionService` 与账户装配已接线。
- `MetaclawSession` 的原生 TUI 读模型改为 owner 事实：
  - `getPlannerTuiExecutorResults`：任务范围由 `task.ownerPlannerSessionId`/
    `conversationId` 决定，不再扫决策账本。
  - `getPlannerTuiPermissionRequests`/`resolvePlannerTuiPermission`：
    escalation 与 resolution 直接读 `PermissionRepo`（`listEscalated`/`findResolution`/
    `findRequest`），归属判断走 Task 的 owner session；`escalationReason` 用
    `decisionReason`。
  - recovery 解析的配置 revision 优先恢复项自带值，其次当前 graph revision；
    不再从决策行推断；恢复诊断的 `causationId` 置空（账本概念）。

验证：`npx tsc --noEmit` 通过；`tests/session tests/account` **67 文件 / 419 用例通过**；
全量 `npx vitest run` **647 文件 / 4768 用例通过**（24 文件 / 70 用例跳过）。

剩余（承接续五/六清单）：①`attempt-terminal` 结果事实落 receipt（`reconcileSettledFailure`
改读 receipt/runtime 诊断）；②删除 12 个兼容应用恢复用例并把 startup recovery 的
`convergeUncertainApplications` 切到 `task_recovery_items`；③内存引擎 + recovery items 落地，
删除 `kernel_events`/`kernel_decisions`/`kernel_decision_applications`/`kernel-event-content`
与迁移 DDL；④契约改名与 fresh schema。

### 2026-11-09 P3-D 续八：第 2/3 批整体推进结果（编译通过、测试迁移未完成 → 已回退）

按用户要求把第 2、3 批一起推进。**源码层已全部完成并 `tsc` 通过**，剩余全部是测试迁移；
因测试未收口，按"不留半迁移"原则回退到续七的通过状态。

源码层已完成（本轮实测、编译通过）：

1. `attempt-terminal-service`：landing 事务不再写决策事件，`land` 返回规范化观察事件；
   `reconcileSettledFailure` 改由 runtime 诊断 + receipt 事实重建（`process_exit`）。
   `tests/execution/attempt-terminal-service.test.ts`（11）、`subtask-attempt-runner.test.ts`（43）、
   `startup-running-reconciliation.test.ts`（4）当时全绿。
2. 内存 `TaskControlWorkflow` + `task_recovery_items` 全量接线（Runtime、协调器、Session 两处循环）。
3. Permission 去账本：`PermissionWorkflowService` 删除 `workflowStore`/`kernel` 旧接缝，
   resolution 去重改 `PermissionRepo.recordResolution`，work item claim/release 走 owner 表，
   `recoverPending` 从 `permission_work_items` + `permission_resolutions` 重建事件。
4. 读取方迁移：`account-runtime` 查询端口、`metaclaw-session`/`conversation-session` 的
   恢复/权限/容量读模型、`account-startup-recovery-service` 的收敛循环
   （`convergeUncertainApplications` 走 recovery items、`hasOwnedRecoverableWork`）、
   `originForDispatch/originForTask` 走 Task owner session。
5. `AccountKernelServices` 只剩 `controlKernel` + `recoveryItems`；`kernelWorkflowRepo`/
   `kernelDecisionRepo` 已从账户装配移除。

剩余测试迁移（实测 12 文件 / 31 用例）：

| 文件 | 用例 | 性质 |
| --- | --- | --- |
| `tests/account/account-startup-recovery-service.test.ts` | 16 | 直接种 `plan_proposed` 决策 + application 的兼容恢复用例；本应删除或改写为 recovery items |
| `tests/execution/permission-workflow-service.test.ts` | 2 | repository mock 缺少 `escalate`/`recordAuthorization`（旧代码走 kernel 接缝绕过） |
| `tests/execution/manager-permission-workflow.test.ts` | 2 | 同上 |
| `tests/account/permission-continuation.test.ts` | 2 | 断言账本 inbox；已在本轮改写为 owner 投递断言并通过 |
| `tests/execution/upstream-input-resume.test.ts` | 2 | fixture 仍是 `kernelWorkflowStore` → `recoveryItems` |
| `tests/account/account-control-services.test.ts` | 1 | 断言账户服务包含两个 ledger repo |
| `tests/account/account-control-coordinator.test.ts` | 1 | 账本 recover 语义 |
| `tests/session/kernel-{capacity,retry}-control-loop.test.ts` | 2 | 断言 `kernel_decisions` 行 |
| `tests/session/kernel-execution-runtime-snapshot.test.ts` | 1 | 断言决策会话 |
| `tests/execution/service-rejection-convergence.test.ts` | 1 | 断言 application 计数 |
| `tests/execution/kernel-execution-runtime-recovery.test.ts` | 1 | 调用已删除的兼容恢复方法 |

结论：第 2、3 批的**源码改动已验证可完成**（编译通过、关键执行套件当时全绿），剩下的
就是上表 31 个用例的删除/改写，属于纯机械工作。下一步建议按文件顺序完成测试迁移后再落地
删表与契约改名；本轮未保留半迁移代码。

当前状态：回到续七的通过状态（`npx tsc --noEmit` 通过；全量 **647 文件 / 4768 用例通过**，
24 文件 / 70 用例跳过）。回退快照：`/tmp/metawork-b3-backup`。

### 2026-11-10 P3-D 续九：控制循环脱离账本（重大跨度，已落地并通过全量回归）

**里程碑：`DurableKernelWorkflow` 已删除，控制循环不再经决策账本。** 全量回归
**646 文件 / 4735 用例通过**（70 跳过），`npx tsc --noEmit` 通过。

已落地：

1. **内存控制循环** `src/execution/task-control-workflow.ts`（新）：`submit → decide → apply →
   观察事件继续`，串行 drain，内存事件去重；无 inbox、无 decision/application 行、无 replay。
   `recover()` 为 drain 屏障。Runtime、账户协调器、Session 两个循环全部切换。
2. **Recovery items** `src/storage/task-recovery-item-repo.ts`（新，`task_recovery_items` 表）：
   被中断的应用记录为一条显式恢复项（operation + error），startup recovery 的
   `convergeUncertainApplications`、`/task recovery`、runtime 的 `resolve_recovery` 全部改读它；
   `inspectApplicationAgainstSources` 通过 `RecoveryApplicationFact` 同时接受 owner 项。
3. **Attempt 结果事实落 receipt**：`AttemptTerminalService.land` 不再写决策事件，返回规范化观察；
   `reconcileSettledFailure` 改由 runtime 诊断（进程退出 + `externalEffectStatus`）重建。
4. **Permission 完全去账本**：`PermissionWorkflowService` 删除 `workflowStore`/`kernel` 旧接缝；
   resolution 去重走 `PermissionRepo.recordResolution`，work item claim/release 走 owner 表；
   `recoverPending` 从 `permission_work_items` + `permission_resolutions` 重建事件；
   续作经 `deliverContinuation` 直接应用到执行循环；`listEscalatedForSession` 等查询不再 join
   `kernel_events`。
5. **读取方迁移**：`account-runtime` 查询端口、`metaclaw-session`/`conversation-session` 的
   恢复/权限/容量读模型、startup recovery 收敛循环与 origin 解析、`AccountKernelServices`
   （只剩 `controlKernel` + `recoveryItems`）。
6. **删除**：`DurableKernelWorkflow` 及账本 store 类型（`kernel-workflow.ts` 只保留
   decider/workflow/settlement 契约）、`tests/kernel/kernel-workflow.test.ts`、
   一批只断言账本行/兼容恢复的用例；集成/span-routing 测试改为 owner 事实断言。

仍保留（下一批删除，纯读取，无写入者）：

| 消费者 | 用途 | 替代 |
| --- | --- | --- |
| `src/management/execution-projector.ts` | 时间线 "authorization" 阶段的决策列表 | work-graph revision + route decisions |
| `src/commands/command-read-services.ts` | 任务视图里的决策历史 | Task events |
| `src/server/server-composition.ts` | 展示别名、权限 resolution 查询、projector 装配 | route decisions / permission 表 |
| `src/storage/kernel-workflow-repo.ts`、`kernel-decision-repo.ts`、`kernel-event-content.ts` + DDL | 只为上述读模型存在 | 删除文件、表与迁移条目 |

再往后：`src/kernel/control-kernel.ts` 契约改名（`Kernel*` → `TaskControl*`）与 fresh schema。

### 2026-11-10 P3-D 续十：账本存储与全部读取方删除（D6 落地）

**退出门（ADR-0055）核销**：`ControlKernel`/`DurableKernelWorkflow` 已无任何代码符号
（仅剩历史注释中的叙述性提及）；fresh schema 不再创建 `kernel_events` /
`kernel_decisions` / `kernel_decision_applications`。

已删除：

1. **存储层**：`src/storage/kernel-decision-repo.ts`、`kernel-workflow-repo.ts`、
   `kernel-event-content.ts`；`kernel-workflow.ts` 只保留 decider / workflow /
   settlement 契约。
2. **DDL**：fresh schema 的 `kernel_decisions`、`kernel_events`、
   `kernel_decision_applications` 建表与索引；`permission_grants.decision_id`、
   `dispatch_items.decision_id`、`work_graph_revisions.authorized_decision_id`
   不再有 Kernel 外键；`kernel_permission_resolution_request` 索引删除。
3. **升级链**：schema 30 → 31 直接 `DROP TABLE kernel_decision_applications/events/decisions`，
   不再重建账本表、不再回填 `authorized_bindings_json`；可恢复 JSON 改写只覆盖
   owner 自有列（`generation_replan_requests.deferred_plan_json`、
   `dispatch_items.attempt_payload_json`）。
4. **读取方**（全部改 owner 事实）：
   - `management/execution-projector.ts`：authorization 阶段由授权派发身份投影
     （`authorize_dispatch`），不再是决策列表；
   - `commands/command-read-services.ts`：`/executor feedback` 的报告由 Work Graph
     修订 + 现存 Subtask 生成，删除 "ControlKernel 决策" 段；
   - `server/server-composition.ts`：展示别名、权限 resolution、工作图展示全部改
     `WorkGraphRevisionRepo` / `SqlitePermissionRepository` / Subtask 事实；
   - `storage/task-activity-facts-repo.ts`、`task-state-facts-reader.ts`、
     `execution/task-residue-reader.ts`、`storage/pending-task-result.ts`、
     `storage/conversation-deletion-repo.ts`、`storage/observation-schema.ts`：
     「未确定应用」一律读 `task_recovery_items`，取消栅栏与残留判断读 `tasks.status`。
5. **权限**：`PermissionRepo.ensureDecisionAnchor` 变为显式 no-op（grant 不再需要账本锚点），
   `PermissionWorkflowService` 不再调用它。
6. **测试**：删除只测账本行/账本回收的用例（`kernel-workflow-repo`、
   `kernel-decision-repo`、cross-session drain、schema-30 账本字节保真、
   kernel_events 可恢复 JSON、quarantined legacy application 等）；其余用例改断言
   `task_recovery_items`、`executor_attempt_receipts`、Work Graph 修订、权限表；
   schema-43 冻结指纹按新 DDL 更新为
   `dff6daa2eb15d80ff501260dba773e0b3dca0cb4bba16b7f8a9e34eea426c5fe`。

**验证**：`npx tsc --noEmit` 通过；全量 `npx vitest run` **643 文件 / 4720 用例通过**
（24 文件 / 70 用例跳过）。通过状态快照：`/tmp/metawork-b7-backup`。

**仍待收尾（非阻塞）**：
- `src/storage/migrations.ts` 中约 28 处 `kernel_*` 引用是**升级旧库的兼容守卫**
  （`hasTable(...)` / 状态修订），随 ADR-0055 D9 折叠 pre-release 升级链时一并删除；
- `src/kernel/control-kernel.ts` 的 `Kernel*` 契约命名（`KernelEvent`/`KernelDecision`/
  `KernelSnapshot`）保留为操作契约名，改名到 `TaskControl*` 属下一批纯机械重命名；
- `effect_outbox` / `dispatch_items` / `executor_status` 等
  owner 表名沿用（表名不是控制轴）。

#### 续十补充：退出门实测

```text
$ rg 'ControlKernel|DurableKernelWorkflow' src        # 0 命中（含注释）
$ rg 'kernel_decisions|kernel_events|kernel_decision_applications' src \
    --glob '!src/storage/migrations.ts'               # 0 命中
$ rg -c 'kernel_(events|decisions|decision_applications)' src/storage/migrations.ts
28   # 全部是旧库升级守卫（hasTable / 状态修订），随 D9 折叠升级链删除
```

fresh 数据库（`runMigrations` 从空库）不再包含 `kernel_events`、`kernel_decisions`、
`kernel_decision_applications`；schema-43 冻结指纹已随 DDL 更新并在
`tests/storage/gateway-command-admission-migrations.test.ts` 中固定。

### 2026-11-10 P3-D 续十一：契约、模块与表名收尾（D6 完整收口）

1. **契约改名**：`src/control/control-contracts.ts` 保留事件/决策/快照形状、`decision()`、
   `guardControlDecision()`、`snapshotMatches()`；所有权类型全部 `Kernel*` → `Control*`
   （`ControlEvent`、`ControlDecision`、`ControlSnapshot`、`ControlFailure`、
   `ControlApplication*Error`、`ControlDecider`、`ControlWorkflow` …）。
2. **目录/文件**：
   - `src/kernel/` → `src/control/`（`control-kernel.ts` → `control-contracts.ts`，
     `kernel-workflow.ts` → `control-workflow.ts`，`kernel-failure.ts` → `control-failure.ts`，
     `kernel-application-settlement.ts` → `control-application-settlement.ts`）；
   - `src/execution/kernel-execution-runtime.ts` → `control-execution-runtime.ts`；
     `kernel-application-recovery.ts` → `control-application-recovery.ts`；
     `kernel-executor-status-projector.ts` → `control-executor-status-projector.ts`；
   - 账户/会话服务：`account-kernel-services` → `account-control-services`、
     `account-kernel-coordinator` → `account-control-coordinator`、
     `account-kernel-execution-services` → `account-control-execution-services`、
     `session-kernel-runtime` → `session-control-runtime`；
   - 依赖方类型/函数：`AccountControlCoordinator`、`AccountControlServices`、
     `SessionControlRuntime`、`buildAccountControlServices`、`submitControlEvent`、
     `controlLoop`、`seedControlDecision` 等；
   - 测试目录 `tests/kernel/` → `tests/control/`。
3. **存储**：`kernel_dispatch_items` → `dispatch_items`、`kernel_effect_outbox` →
   `effect_outbox`、`kernel_executor_status`/`kernel_provider_status`/
   `kernel_model_status`/`kernel_binding_status` → 去掉前缀；索引与触发器同步改名；
   `CURRENT_SCHEMA_VERSION` 65 → 66，新增 `renameLegacyOwnerTables`（升级旧库时就地改名）。
   结算错误摘要前缀 `kernel_settlement/` → `control_settlement/`，解析器仍接受旧前缀。
4. **迁移清理**：删除 46→47 的账本索引、51→52 的账本隔离语句、59 的待处理事件退场循环、
   32→33 的账本回填；删除 `ensureEffectOutboxOwnerSchema`/`ensureWorkGraphRevisionOwnerSchema`
   两个只为旧外键存在的修复钩子。`migrations.ts` 中仅剩 schema-30 升级路径里的
   `DROP TABLE kernel_*`（旧库清账本）。
5. **文档**：`AGENTS.md`、`CONTEXT.md`、`docs/current/technical-overview.md` 与中文版、
   ADR-0055（新增 D6 delivered checkpoint）全部改为 `src/control/`、`ControlLoopPolicy`、
   `TaskControlWorkflow`、`task_recovery_items` 表述。

**验证**：`npx tsc --noEmit` 通过；全量 `npx vitest run` **643 文件 / 4719 用例通过**
（24 文件 / 70 用例跳过）。快照：`/tmp/metawork-c2-backup`。

**保留的 `kernel_*` 词汇**（持久化事实值，不是控制轴，改名需要数据迁移）：
`tasks.dependencies_json` 的 blocker 类型 `kernel_capacity`/`kernel_retry`/
`kernel_availability`/`kernel_anomaly`，活动/输出类型 `kernel_decision`、
`kernel_decision_applied`、`kernel_waiting_for_partition`，以及残留原因
`kernel_application` 与旧结算前缀（仅读取兼容）。


### 2026-11-10 全盘 review 续作：Memory 独立入口、完整导出与层级隔离

- **状态/完成日期：** 本批次本地完成，2026-11-10；产品整体收敛未结束。
- **交付：** Web 独立“记忆”Tab，保留搜索/类型/层级/启停筛选、分页、完整正文、停用和删除；设置只保留配置，并从记忆页直接展开对应设置。
- **导出：** 用户确认版本化 JSON。认证的 `GET /api/memory/export` 只读取 Server 绑定账户，返回 `metawork-memory` v1，包含全部受管理 L1/L2/L3 启用/停用条目的完整正文与元数据。10,000 条 / 32 MiB、单服务单扫描、取消透传至 RPC、扫描不完整和数量变化失败，不返回部分成功文件。无快照保证；关闭/不可用的引擎不可导出；不包含 L0 或凭据，也没有导入能力。
- **缺陷：** 列表以 `layer:id` 去重，详情同时核验层级和引擎 ID，修复跨层同 ID 导致覆盖/串层；不修改 schema。
- **Review 校正：** ADR-0055 D6 检查点已经接受 Task Runtime 内的 `ControlLoopPolicy`，不能仅因 decider 仍在就认定 D6 未交付；vendored Pi fork 已删除。官方服务 Docker 不属于本地任务清理边界。未实现的目标与待核验事项保留在 [review 报告](2026-11-10-metawork-full-code-review-report.md)。
- **验证：** lint/build/diff whitespace 检查通过；全量 **644 文件 / 4738 用例通过、70 跳过**；真实 Chrome 记忆专项 **3 条流程通过**（其余 8 条未选择），1440px / 390px，含设置定位、完整包下载、取消、失败恢复及删除翻页。浏览器使用 API fixture，真实 TDAI/发布包验收仍是独立阶段门。
- **closing commit：** 不适用；依用户要求只保留本地修改，不提交、不推送。


### 2026-11-10 全盘 review 续作：Token 时间线、全角色额度与 Pi 缓存计量

- **状态/完成日期：** R-08 / R-09 / R-10 本地完成并验收，2026-11-10；整体 Phase 4 和产品收敛未结束。
- **用量页：** Web “账单”入口切换为账号级 Token 用量，不依赖所选会话。新增认证、Server 绑定账户的 `GET /api/usage/timeline`；只接受 period/groupBy/start/end 单值参数，不接收客户端账户。8 种时间区间、北京时间周一起始、UTC 半开区间、最长 366 天、复用真实 quota window 的订阅周期；Total/Included/On-demand、每日堆叠柱、模型图例开关、Provider/Model 分组、完整每日表、刷新/错误重试/旧响应隔离。BigInt 精确求和；零填充日期；system 排除，unknown/缺失可见。对话和轨迹停止渲染/轮询逐 Turn 金额账单。
- **额度缺陷：** 原 Server guidance/preflight 限定 manager，漏算其他官方角色。现由 `readAccountTokenQuota` 统一读取账号全部 platform-payer 角色；自备 Provider 不扣 Included，耗尽继续提供引导。
- **Pi 缓存缺陷：** 已核对安装的上游 1.5.0 OpenAI/Anthropic 实现，Pi input 不含缓存读/写。Manager/Executor 共用归一化函数，将 raw input+cacheRead+cacheWrite 记为完整 input，同时保持缓存子集标记；reasoning 不重复相加。错误缓存字段标记完整输入缺失，Manager RPC 不把错误解析成无缓存。历史事实不自动重算。
- **验证：** lint/build/diff whitespace 通过；全量 **645 文件 / 4768 用例通过，71 跳过（24 文件跳过）**。聚焦 8 文件 / 162 用例通过，新增 Manager RPC malformed-cache 回归随后纳入全量。真实 Chrome **2 条流程通过、11 条未选择**，1440px / 390px，覆盖无会话用量、筛选、日期、图例、错误/空态/乱序响应和答案/报告无金额卡；使用 API fixture。SQLite 集成证明 12 普通输入+3 缓存读+1 缓存写+5 输出=21 Token，重复回调仍一条调用且 quota 相同。
- **剩余：** 旧金额组件/服务/配置/API/表删除、完整受支持模型/后台调用覆盖、occurredAt/source/version 目标字段、历史计量校验、高数据量查询性能、正式额度和真实供应商目录、唯一 Pi 与 Manager/Router 真实任务验收。时间线当前读取既有 capturedAt 事实并内存聚合，没有事实数上限；本次没有 schema 改动。
- **文档：** ADR-0055 检查点、CONTEXT、technical overview、技术实施 §7.2、review 报告与索引已同步。
- **closing commit：** 不适用；依用户要求仅本地修改，不提交、不推送。

### 2026-11-10 全盘 review 续作：依赖安全、生产启动恢复与 Desktop

- **状态/完成日期：** R-11～R-15 本地修复并验证，2026-11-10；整体发布未验收。
- **交付：** Web、根服务和 Desktop 依赖安全升级；修复生产 Server 启动恢复无效 SQL；权限调用按 Provider 归属记账；Span smoke 显式选择可解析 reporter，新增真实打包 matcher 回归。具体问题和边界见 [review 报告 §10](2026-11-10-metawork-full-code-review-report.md#10-2026-11-10-安全依赖启动恢复与-desktop-验收批次)。
- **验证：** 根 lint/build 及全量 **647 文件 / 4774 用例通过，71 跳过（24 文件跳过）**；根/Desktop 标准 `npm ci` 成功，包含 SQLite/Electron 安装。根、Web、Desktop、official-server 四份 npm 锁文件 audit 均 **0 漏洞**，不代表嵌入 Pi/Memory/OS 全部供应链审计。
- **客户端：** Desktop lint/build、**11 文件 / 28 用例**通过；生产 Server 的图表/富文档 Chrome **2 流程**通过。隔离安装身份下真实 Electron **830ms 就绪**，认证/无 Node、中文保存、三宽度/缩放、10 次重连、renderer 崩溃恢复和退出后服务存活均通过；对话框与下载 HTTP 使用 fixture。证据在 `.tmp/review-desktop-evidence/electron-smoke.json`。
- **边界：** 未完成签名/公证/DMG、干净机器、Linux、唯一 Pi 双角色真实任务验收；Desktop 首次开发准备仍引用已删除的 fork，是待修缺陷。
- **closing commit：** 不适用；仅本地修改，不提交、不推送。

### 2026-11-10 全盘 review 续作：配置热更新期间的用量归属

- **状态/完成日期：** R-16 本地完成并验证，2026-11-10；累计十六项修复，整体产品仍在收敛。
- **交付：** Manager 回调、权限调用及 Executor 使用调用固定的配置版本解析官方/BYOK payer；历史配置按需缓存，不改变活动版本；缺失/错误版本保留 unknown。Manager 预检复用实际固定/auto 模型选择，仅官方调用读取 Included 额度，BYOK 清除旧额度提示。
- **验证：** 同 Provider ID 热更新的 SQLite 回归证明旧 BYOK 和新官方各 17 Token，Included 仅 17；Manager 延迟回调和 Executor Span/观测均固定版本。聚焦 **5 文件 / 63 用例**通过，含此前 Executor/Manager 聚焦回归的最新全量 **648 文件 / 4783 用例通过，71 跳过（24 文件跳过）**；根 lint/build 通过。日志 `/tmp/metawork-review-full-test-pinned-payer.log`。Electron smoke 在本修复前执行，未描述为最新重验。
- **边界：** 不重写历史归属；初始规划生命周期 Span 的部署默认 payer、完整调用点覆盖、历史/高数据量、旧金额链删除仍未关闭；无 schema 变更。
- **文档：** ADR-0055 检查点、CONTEXT、technical overview、技术实施方案 §7.2、review 报告和索引同步。
- **closing commit：** 不适用；仅本地修改，不提交、不推送。

### 2026-11-10 全盘 review 续作：无 fork 安装校验契约

- **状态/完成日期：** R-17 本地完成并验证，2026-11-10；累计十七项修复。
- **交付：** 修复 `plannerRoot` 已可选、元数据校验仍必填的矛盾；配置探测接受 Manager 实际解析的 managed Pi 可执行普通文件，不再只检查旧 fork。显式错误元数据、缺失/不可执行 Pi、同名目录仍拒绝，不增加全局 Pi 回退。
- **验证：** 新回归修复前复现两个独立错误；无 fork、无模型凭据安装在临时目录完成应用/配置/数据库激活和正确元数据保存。安装/更新/探测 **4 文件 / 56 用例**通过；lint/build 通过；最终全量 **648 文件 / 4788 用例通过，71 跳过（24 文件跳过）**，日志 `/tmp/metawork-review-full-test-forkless-install.log`。
- **边界：** Pi wrapper 是 fixture；不代表完整依赖、真实模型任务或干净发布包验收。`dev-desktop.mjs`、`install-native-macos.mjs`、`build-release.mjs` 的旧 fork 构建步骤仍是后续缺陷；没有修改 schema。ADR-0055、CONTEXT、技术概览、技术实施方案、review 报告及索引同步。
- **closing commit：** 不适用；仅本地修改，不提交、不推送。


### 2026-11-10 全盘 review 续作：R-25～R-32 阶段性实现与未关闭回归

- **状态/记录日期：** 2026-11-10，修复与验证进行中，未完成整体验收。本节是最新进度；前文“全量通过”“仍待删除”属于各自历史批次，不能沿用为当前状态。
- **金额链：** 删除本地价格/成本、逐 Query 金额配置、表、服务、API 和 Web 组件；Auto policy v3、OpenRouter cache v2。`official-server` 订阅/支付金额保留。该批专项 **79 文件 / 737 用例通过**，Web TypeScript/Vite 通过；Router 旧 Span cost 字段仍待清理。
- **存储：** fresh-only **schema 67**；唯一 `current-schema.ts` DDL，删除历史 SQLite migrations / database-upgrade transaction。旧库/伪造当前版本/不完整或额外 schema 对象写前拒绝；Metering DDL 纳入正式 schema，删除运行时 CREATE/ALTER 修补。fresh-schema/安装批次 **56 文件 / 329 用例通过**；之后细化的 DDL 尚未全量复验。prepared recovery / previous pointer 旧库拒绝测试仍需补齐。不自动修改用户已有数据库。
- **执行边界：** 删除 Codex driver/schema/catalog/discovery/Web 与容器适配器，配置/backend host-only；未知 Provider protocol 在凭据读取前拒绝，doctor 只认 packaged Pi。删除 TUI facade，权限投影移到 account service。`docker_socket` HARD_DENY 保留为安全拒绝规则，官方服务 Docker 独立保留。Pi/native 专项 **206 文件通过 / 2 失败，1624 用例通过 / 4 失败**；旧 Codex fixture 已调整，但该整批尚未重跑。
- **Manager/Router：** strict proposal 不接受 executorBindings/modelSelection，准入从固定配置保留全部硬资格候选；Runtime 资格池不代表 Manager 选择。延迟绑定按 Subtask ID 校验；删除 Session/recovery 预准入 Span evaluator，真正 dispatch Router 适配器保留。Router 使用实际 modelId、固定配置及失败 receipt fingerprint，提交时重读；无 evaluator 或评估失败不默认选第一项。失败 retry、continuation/repair 保留绑定已改代码，完整策略链仍待验证；实时 health/capability 重读、retry placeholder 和旧 Span 轨迹未收尾。
- **快照保护：** 只读预检、staging、拒绝已有目标及路径别名、COPYFILE_EXCL 发布；异常只删本次创建文件。最新快照专项 **7 用例通过**，包含普通文件/软链接/硬链接/悬空软链接不覆盖、源 DB/WAL 保持、旧库及不完整 schema 拒绝。
- **用量事实：** Executor 用 attemptId:usage.callId 区分同 attempt 多次模型调用。新增 occurredAtUtc / recordedAtUtc / sourceId / providerResponseId / normalizationVersion；时间线/额度按 occurredAtUtc。发生时间来自适配器观测的调用完成时刻，不冒称 Provider 原始时间。缺失量 NULL + provider_unavailable。新来源身份冲突约束、跨天晚到/多调用回归、Router 和 Memory 全调用计量尚未完成。
- **最近检查：** 本次根 `npm run lint` **通过**（`/tmp/metawork-review-documentation-lint.log`）。最新专项 **13 文件：11 通过 / 2 失败；185 用例：182 通过 / 3 失败**（`/tmp/metawork-review-current-focused.log`）。两个失败是 proposal preparation 取消时 request_replan / request_merge_replan 抛 AbortError 而预期 null；另一项是 Pi 缓存集成的新用量元数据预期差异。均待关闭，不能称“全绿”。此前候选排序 fixture 和 plan-proposal-store 的 spanRouting 类型残留已修，最近准入专项与本次 lint 通过。
- **下一步：** 先收敛三项失败并重跑 Pi/native 整批；再补 Router 动态资格/失败重选/continuation、用量时间与来源、更新恢复 pin，完成 lint/build/全量和受影响客户端验证，最后核对删除清单与现行文档。
- **验收边界：** 旧 648 文件 / 4788 用例通过仅为 R-17 后历史结果。最新根 build/全量/Web/Desktop/真实任务未完成重验；真实供应商、Feishu、签名公证/干净机器/Linux 保留未验收。详细缺口与失败清单见 [Review 报告 §13](2026-11-10-metawork-full-code-review-report.md)。
- **完成日期/closing commit：** 本批未关闭，无整体完成日期；仅本地修改，不提交、不推送、不部署、不切换用户安装。

### 2026-11-10 全盘 review 续作：R-33～R-40 遗留失败关闭（最新）

- **状态/记录日期：** 2026-11-10，本地实现并验证；本节取代上一节的“三项失败/未完成重验”状态，整体 PRD 与发布验收仍未关闭。
- **关闭的失败：** 提案准备取消的 `request_replan` / `request_merge_replan` 现在按“Turn 取消 = 无提案、dispose/停机 = 可恢复中断”收束；Pi 缓存用量集成断言改为有依据的真实来源身份，并补同 Attempt 多调用/跨天归日回归。
- **新增缺陷与修复：** fresh schema 67 缺 `retry_wakes.session_id`（生产重试唤醒写库必然失败）已补齐，并新增 fresh DDL ↔ 仓储写入列的自动审计；Router 提交期在 append 事务内重读执行器可用性，不可用类记录 `provider_unavailable` 且不落决策；用量事实的来源/响应/归一化版本/发生时间纳入不可变身份；Span 残留 `cost` 字段清理；schema 校验改为报告缺失/多余对象名；安装回归改用既有表并通过 prepared activation 的 schema-66 previous 指针拒绝回归。
- **回归收敛：** 上一轮 40 个失败文件按“已删除能力、Router 唯一决策、fixture/投影字段、关闭 schema”四类更新。新增 `MetaclawSessionDeps.spanRoutingEvaluator` 与 `tests/support/router-decision-fixture.ts`，会话/E2E 脚本显式注入 Router 决策；`plan-admission-span` 改写为 `plan-admission-candidate-pool`；新增 `tests/e2e/span-router-integration.test.ts` 并让 `smoke:span-routing --integration` 指向真实 Router 决策模型。
- **验证：** 根 `npm run lint` 通过；`npm run build` 通过（`/tmp/metawork-build-2.log`）；完整 `npx vitest run` **627 文件通过、25 跳过；4547 用例通过、71 跳过、0 失败**（`/tmp/metawork-full-4.log`）；`git diff --check` 无告警。
- **边界：** 未重新执行 Web/Desktop 真实浏览器与 Electron smoke、真实供应商任务、Feishu、签名/公证/干净机器与 Linux 验收。Router/Memory 实际调用计量（F-07）与完整失败-恢复-发布旅程（F-01/F-05）仍是开放工作；详细逐项记录见 [Review 报告 §14](2026-11-10-metawork-full-code-review-report.md#14-2026-11-10-遗留失败与缺陷关闭批次r-33r-40)。
- **完成日期/closing commit：** 2026-11-10（本批次）；不适用，仅本地工作树，不提交、不推送、不部署、不切换用户安装。

### 2026-11-10 全盘 review 续作：Router 决策模型计量接入（R-41，最新）

- **状态/记录日期：** 2026-11-10，本地实现并验证。
- **交付：** Router 决策模型调用逐次记账：`sourceId=router`、`stage=planning`、`agentClassRef=router`、`payer=system`。真实调用（含 `advised` 与“请求已发出”的 fallback）写一条事实；重放、禁用、凭据缺失、无候选不写；适配器未回报用量写缺失指标。事实挂在发起派发的 Query 上，无 Query 的系统派发不落账。
- **边界：** system 付款方使这些事实可见但不计入用户 Included/On-demand；若产品要求纳入额度，需要改 payer 与额度验收。Memory sidecar 仍无用量通道。
- **验证：** `tests/routing/router-dispatch-service.test.ts` 14 项、`tests/account/account-router-dispatch.test.ts` 11 项、新增 `tests/metering/router-usage.test.ts` 4 项；完整 `npx vitest run` **628 文件通过、25 跳过；4555 用例通过、71 跳过、0 失败**；根 `npm run lint` 与 `npm run build` 通过；`git diff --check` 无告警。
- **完成日期/closing commit：** 2026-11-10（本批次）；不适用，仅本地工作树，不提交、不推送。

### 2026-11-10 全盘 review 续作：Memory 引擎计量与真实浏览器验收（R-42～R-45，最新）

- **状态/记录日期：** 2026-11-10，本地实现并验证。
- **Memory 计量：** TDAI 引擎侧新增 release-owned 用量账本与 `POST /v3/metawork/usage/drain`（compat patch 已重新生成并验证可应用于固定上游提交）；MetaWork 侧新增 `MemoryPort.drainUsage` / 适配器解析 / `memory-usage` 桥（`agentClassRef=memory`、账户级 system Query、payer 按抽取 Provider 固定版本所有权），调度器每 tick 与关机前 drain。真实引擎 E2E 证明提取后 drain 到 Token 并写入 metering。
- **真实浏览器：** 10 个 Chrome 套件 21 用例通过（生产 Web 构建）。修复了生产观察夹具（packaged Pi 取代 fork/codex）、会话行 disabled 竞态、`RESULT_10` 前缀误判、平滑滚动导致的转录未挂载、任务状态与 Provider 成员关系的陈旧 UI 断言；设置保存不再复活已删除的金额字段（真实缺陷）；决策模型设置改为 Provider+Model 并修正清空语义。生产观察暖切换 p95 17.6 ms（预算 100 ms）。
- **验证：** 根 `npm run lint`、`npm run build`、`web` 类型检查与构建通过；完整 `npx vitest run` **629 文件 / 4561 用例通过、71 跳过、0 失败**；真实引擎记忆 E2E 11 项与记忆计量 5 项通过；引擎 upstream 单测 69 项通过；`git diff --check` 无告警。
- **边界：** 浏览器用例除生产观察套件外仍用 API fixture；签名/公证/DMG、干净机器、Linux、Feishu、真实供应商任务与正式额度档位仍未验收。
- **完成日期/closing commit：** 2026-11-10（本批次）；不适用，仅本地工作树，不提交、不推送。

### 2026-11-10 全盘 review 续作：发布级链路与安装验收（R-46～R-51，最新）

- **状态/记录日期：** 2026-11-10，本地实现并验证。
- **记忆引擎重建：** `prepare-memory-engine.mjs` 在复用检出上先还原固定上游内容、清掉补丁新增文件再应用补丁，本地完整跑通（`a3c2d86…` → 构建 → 裁剪），`verify-memory-engine` 报 `status=ok ftsAvailable=true`，重建后真实引擎记忆 E2E 11 项仍通过。
- **无 fork 烟测与安装验收：** `smoke-unified-gateway.mjs` 重写为“验收文件 → 原生安装（packaged Pi，无 `--planner-root`）→ 安装后 Server → v2 socket 多客户端 + 重启恢复 + 安装包 Web/会话 → 退役进程守卫 → 停止”，`npm run smoke:gateway` 通过；`tests/e2e/installed-observation-native.test.ts` 改为验证发布身份/自带 Web/packaged Pi 版本与 pin 一致，`RUN_INSTALLED_OBSERVATION=1` 通过。
- **清理与修复：** Desktop 更新门禁去掉指向已删除 fork 的 `plannerRoot`；删除两个只操作 fork 的 TUI 校验脚本；开发安装用隔离 `METAWORK_INTERNAL_LLM_SOURCE_ROOT` 重建到 `0.1.26-desktop-development` 并通过 desktop lint/build/test 与 Electron production-assets 烟测（ready 3127 ms）。
- **打包链路首跑：** `build-release --package-only` 产出三归档 + 签名 manifest（离线校验签名/大小/sha256/兼容字段全部匹配），解包后 packaged memory engine 与 packaged runtime（自带 Web、`/api/auth/session` 200、packaged Pi）均可运行。
- **新开放项：** `inception/mercury-decide:free` 已从 OpenRouter 目录下架，实时 `smoke:span-routing` 返回 404；决策模型替代需产品决定（不擅自更换）。
- **验证：** `npm run lint`、`npm run build`、`web` 构建、`check:pi-runtime-pin`、`smoke:clients`、`check:pi-tool-stall`、完整 `npx vitest run` **629 文件 / 4561 用例通过、71 跳过、0 失败**、`git diff --check` 无告警。
- **完成日期/closing commit：** 2026-11-10（本批次）；不适用，仅本地工作树，不提交、不推送。

### 2026-11-10 全盘 review 续作：Jev 决策模型实测、单候选短路与本地 DMG（R-51～R-55，最新）

- **状态/记录日期：** 2026-11-10，本地实现并验证。
- **决策模型：** 放弃已下架的 `inception/mercury-decide:free`，产品内不再有硬编码默认；决策模型完全由 `routing.span` 的 Provider/Model 决定（`model` 字段降为旧版只读）。烟测脚本改为解析活动 revision 的 Provider/Model + Provider 凭证，直连 `${baseUrl}/systemone`。用户 `way` 主机的 Jev（`100.75.20.123:8082/v1`，模型 `/home/way/jev27bv/JEV-27B-VL-Q8_0.gguf`）实测：单次 `ok:true`（概率 0.905/0.095，inputTokens 177，679 ms），4 workload 集成 4/4 `selected`。
- **真实缺陷：** 单候选也调用决策模型 → Jev 下返回 `no_candidate` 阻断路由。改为单候选直接选中、不产生调用与用量事实。
- **本地 DMG：** `verify-desktop-update` 改用已声明的 `tsx`（新增 devDependency），去掉 fork 的 `plannerRoot`；`build-release --package-only` → `prepare-runtime --development true` → `METAWORK_DESKTOP_INTERNAL=1 package:desktop` 产出 672 MB ad-hoc 签名 DMG（`com.metawork.desktop`，无 Team ID），`codesign --verify --strict` 与更新门禁（`0.1.26-desktop-development → 0.1.26-build-…`，memory engine present）通过。
- **验证：** `npm run lint`、`npm run build`、web 构建；完整 `npx vitest run` **629 文件 / 4561 用例通过、71 跳过、0 失败**；span/routing/configuration/web 专项 854 项；真实 Jev 烟测两模式。
- **边界：** 公证/正式签名、干净机器、Linux、Feishu、真实供应商任务未验收；DMG 为开发签名演练产物。
- **完成日期/closing commit：** 2026-11-10（本批次）；不适用，仅本地工作树，不提交、不推送。

### 2026-11-10 全盘 review 续作：Manager 模型名与智能路由 UI 收口（R-55～R-56，最新）

- **状态/记录日期：** 2026-11-10，本地实现并验证。
- **R-56（阻断）：** Planner 视图漏掉 `modelId`，Manager 把内部引用 `custom-model-1-1` 当模型名发给
  DeepSeek → `400 invalid_request_error`，Turn 在几十毫秒内无计划失败（三次全中）。修复：`PlannerModelProfile`
  与投影补 `modelId`，Manager `--model` 取真实模型名；回归用例覆盖。验证：真实 revision 下
  `selectManagerModel().modelId = deepseek-flash`，完整套件 629 文件 / 4563 用例通过。
- **R-55 诊断与隔离：** Turn 失败现在带出供应商错误文本；Manager 改在自己的沙箱
  `<runtime>/manager/workspace` 启动并加 `--no-approve --no-skills --no-extensions`，避免加载用户
  Workspace 的 AGENTS/skills/extensions；记忆抽取失败只把状态降级为 `degraded` + 原因（
  `/api/memory/status` 告警），下一 tick 成功后自愈，绝不影响主链路。
- **UI：** 移除智能体配置与执行器编辑里两处"优化目标/选择偏好"下拉（ADR-0055 D4：Auto 模式由
  Router 决策）；旧 revision 的 `objective` 值原样保留，新建默认 `balanced`。
- **边界：** 前端仍需浏览器手测（本机 Web 需官方账号登录后才能提交任务）。
- **完成日期/closing commit：** 2026-11-10（本批次）；不适用，仅本地工作树，不提交、不推送。

