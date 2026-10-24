# 任务状态简化实施：诊断与代码评审

- 日期：2026-10-22。
- 状态：评审完成；本文保留发现时的证据。后续修复与重新验证见[修复记录](2026-10-22-task-state-review-fixes.md)，以下“当前”均指评审时的工作区。
- 对照目标：[产品设计](2026-10-22-task-state-simple-design.md)、[技术实施方案](2026-10-22-task-state-implementation-plan.md)。
- 评审对象：`feature/task-status-refactor` 当前工作区，包括未提交和未跟踪的实现文件；基线为 `d19e412e53f5adeea2d1c43de2bb77d9892758af`。
- 方法：静态追踪 Task Domain、Kernel、Runtime、SQLite 迁移、调度、恢复、服务、Gateway 和客户端；运行现有定向测试；增加临时反例测试验证设计不变量。未修改业务源码，未提交。

**结论：六态模型和写入口的基础结构已实现，但还不能按两份文档认定完成。接受结果、证据归属、迁移、安全放行和客户端版本一致性存在实质缺陷。** 其中部分“测试通过”来自断言继续保留旧规则，不能作为新目标的验收证据。

以下 P1 表示应在合并或启用前修复的行为/可靠性问题；P2 表示必须补齐的契约与呈现问题。本轮没有认定 P0。

## 1. 主要发现

### F01 · P1 · 接受结果仍绕过会话 slot 执行副作用

位置：[kernel-execution-runtime.ts](../../src/execution/kernel-execution-runtime.ts)，1151–1170 行；[subtask-attempt-runner.ts](../../src/execution/subtask-attempt-runner.ts)，243–320 行。对应方案 §4.3、§5.4。

接受分支先调用 `reconcile()`，紧接着直接 `await stageAcceptedResult(action)`。中间没有把续跑操作持久入队、等待 scheduler 预约、检查当前 reservation。后者会操作 Git、创建 publication；其 `assertCurrent()` 只要找到接受记录就直接返回，也不再检查当前图、取消和 slot。

**复现：**真实 Session/Kernel fixture 生成待接受结果后，让同一会话 slot 归另一个真实 Task 所有，再调用接受入口。仍生成了 1 条 `publication_accepted_*`；预期为 0，等待名额后才能生成。这是实际绕过，不只是注释与代码不一致。

应把“接受决定”和“获批后暂存/发布”拆为两个持久步骤；发布 Worker 每次启动和落库都验证 generation、reservation、取消 fence。接受记录只能证明用户同意，不能证明现在仍有执行资格。

### F02 · P1 · 接受落库与 application/续跑不原子，中断后无法补完

位置：[kernel-workflow.ts](../../src/kernel/kernel-workflow.ts)，201–218 行；[task-lifecycle-transition-port.ts](../../src/task/task-lifecycle-transition-port.ts)，299–333 行；[kernel-application-recovery.ts](../../src/execution/kernel-application-recovery.ts)，193–239 行。对应方案 §4.2、§6.2。

`DurableKernelWorkflow` 仍是 `await runtime.apply()` 完成后才 `markApplied()`。新 Task 事务只写状态、审计和投影 outbox，没有把 Kernel application 与续跑事件一起提交。恢复 inspector 没有 `accept_uncertified_result`、`retry_uncertified_result` 的后置条件，最终进入 `unresolved`。

另一方面，`readPendingTaskResult()` 已根据接受审计隐藏原结果。如果接受提交后、`stageAcceptedResult()` 前中断，会出现“接受按钮已经消失，publication 尚不存在，application 无法恢复”的断点。

**复现：**在真实 Session 的 `stageAcceptedResult()` 入口注入异常，恢复该方法后调用 `recoverDue()`。接受 publication 仍为 0，未补完。此测试是明确边界的故障注入，不冒充完整子进程崩溃测试。

需要实现方案要求的数据库动作原子 application seam、持久续跑 payload 与观察事件，并为接受/重试添加明确的恢复后置条件。当前 ADR/代码注释关于“application 同事务”的表述不符合实现。

### F03 · P1 · 取消单个 Subtask 会成为整 Task 的取消 fence

位置：[task-state-facts-reader.ts](../../src/storage/task-state-facts-reader.ts)，233–238 行。对应设计“独立分支继续”和方案 §4.4。

`readCancelFence()` 把 applied 的 `cancel_task` 和 `cancel_subtasks` 等价处理。下一次 Task 汇总会优先命中取消分支，即使只取消 A、B 仍应继续，也会把整个 Task 定为不可恢复的 `cancelled`。

**复现：**仅有一条 applied `cancel_subtasks` 时，真实 SQL reader 返回 `cancelFence=true`。整任务取消与子图取消必须保持不同作用域；部分取消只能更新目标子图及待接受事实。

### F04 · P1 · 完成证据未按工作身份匹配，且把“没有失败”当成成功

位置：[task-state-facts.ts](../../src/task/task-state-facts.ts)，410、451–461、558–565 行；[task-operation-result-repo.ts](../../src/storage/task-operation-result-repo.ts)。对应方案 §3.4、§5.1。

`latestOperation(raw, kind)` 只按操作种类过滤，再按 `operationKey` 字典序取最大值。没有匹配 requirement/subtask/publication/generation，也不是按操作轮次或完成时间选择。因此一个节点的 delivery 成功能用于满足另一个节点的要求；旧图操作也没有在 reader 层按当前授权图过滤。

此外，publication 只要 `integrated` 且 `deliveryStatus !== 'failed'` 就被计为交付完成，`null` 和 `pending` 都包含在内。execution/safety report 的部分判断又只看 Subtask `done` 标签，没有验证注释所称的 certified/accepted 证据。

**复现：**B 的 publication 明确交付失败，输入另一 publication 的 delivery success，B 的 requiredWork 被判 `completed`。另一个反例中，publication 已集成但 delivery 记录缺失，Task 被判 `succeeded`。

操作事实应携带精确身份，按 requirement 关联其有效结果；成功必须有明确成功证据。历史事实保留，但不能跨工作项、跨图替代当前证据。

### F05 · P1 · 确定交付失败仍进入待处理，并在原 Task 上重试

位置：[task-state-facts.ts](../../src/task/task-state-facts.ts)，417–421、463–473 行；[publication-delivery-recovery.test.ts](../../tests/e2e/publication-delivery-recovery.test.ts)。对应方案 §4.4、§5.1、§8。

已经规范化为 `definite_failure` 的 delivery 被显式改成 `waiting_for_user`，随后是 `needs_action`。现有 E2E 验证的也是同一 Task resume/restart 后变成功。方案要求的是确定失败终结原 Task，明确重试创建关联 Task，只补未完成交付。

**复现：**输入明确的 delivery failure，结论为 `needs_action`，不是 `failed`。

目前 `retryOfTaskId` 虽增加到类型/创建参数，`planTaskExecution()` 也返回了它，但生产调用链未找到消费该规划结果并创建剩余工作任务的入口，不能把字段存在视为功能交付。应区分临时且已授权重试、外部结果未知、确定失败，并补通关联重试任务链。

### F06 · P1 · 尚不能启动的必需服务被计为 runnable，覆盖等待接受

位置：[task-state-facts.ts](../../src/task/task-state-facts.ts)，631–635 行；[task-state.ts](../../src/task/task-state.ts)，390–437 行。对应方案 §3.3、§3.4。

`service + pending` 只要没有 conflicted publication 就被视为可自动推进，没有检查代码是否已验收、发布、交付，以及服务规格是否已具备。这样 pending acceptance 虽存在，也因 `runnableWork=true` 无法进入待处理。

**复现：**真实 Session 处理“生成代码并启动服务”，Executor 返回安全但未认证结果。稳定快照是 `queued`，预期是 `needs_action`。这正落在产品原案例的前半段。

服务要求必须有真实可执行的前置条件与驱动资格，不能仅凭“尚未完成”判定可运行。

### F07 · P1 · schema 51→52 的证据分类会保留幽灵运行并误报成功

位置：[migrations.ts](../../src/storage/migrations.ts)，1814–1822、1886–1894 行。对应方案 §6.3。

第一处用 `SIX_STATE_STATUSES.has(oldStatus)` 判断记录“已经采用新契约”。但旧契约也有 `running`、`cancelled`：旧 running 因而完全绕过后面的证据分类，旧 cancelled 也不会按迁移逻辑补齐终结时间/审计。

第二处把任意 full revision，或全部 Subtask 为 done/cancelled，作为旧终态成功证据。没有验证必需服务、交付、精确接受决定；历史图也没有充分限定到当前要求。

**复现使用基线 HEAD 的真实 schema 51 创建器，而不是只改新库版本号：**无 driver 的旧 running 迁移后仍 running；旧 done + `start_service_after_publish=1` + done 子任务、完全没有服务成功证据，迁移后变 succeeded。

schema 版本才是旧模型判定依据，不能按状态字符串重叠跳过迁移。应逐任务验证当前要求的证据，异常持久审计并隔离。当前迁移也未写 `task_state_changes` 的迁移记录；扩展 detail 中的 migration 字段会被常规规范化丢弃，不能替代不可变迁移审计。

### F08 · P1 · slot 的轮次隔离和安全释放协议未实现

位置：[conversation-task-scheduler-repo.ts](../../src/storage/conversation-task-scheduler-repo.ts)，122–153、238、282–305、325–333 行；[migrations.ts](../../src/storage/migrations.ts)，1767–1769 行。对应方案 §5.4。

新增 `slot_version` 只存在于迁移，生产代码不读取、不递增、不校验。reservation 仍固定拼接 conversation/task，Task 再入队时复用旧 token。release 仍接收事务外传入的 `hasResidue`，只匹配 taskId，没有预期 Task version 和预约轮次。重复 enqueue 还保留旧 enqueued/eligible 时间，会让接受后的旧 Task 保留原排队年龄。

**复现：**同一任务预约、释放、重新入队、再次预约，两次 reservationId 完全相同。旧轮次 Worker 无法据此被隔离，迟到释放也不能区分新旧轮次。

应实现新的轮次 token、版本条件释放、事务内安全事实复核和持久 scheduler wake。Repo 中的候选排序仍存在，未完成“仅 Kernel 排序”的删除目标。Kernel scheduler 也仍用 `runnableAttemptCount > 0` 排除无 Attempt 工作；服务/发布续跑候选模型未按方案扩展。

### F09 · P1 · 新增 blocker 会删除全部既有待处理依赖

位置：[kernel-execution-runtime.ts](../../src/execution/kernel-execution-runtime.ts)，3868–3878 行；[session-kernel-runtime.ts](../../src/session/session-kernel-runtime.ts)，139–149 行；[account-startup-recovery-service.ts](../../src/account/account-startup-recovery-service.ts)，943 行附近。对应方案 §4.2、§4.3。

这些路径先 `filter(dependency.status !== 'waiting')`，再追加新 blocker。即加入 B 时直接丢弃仍未解决的 A。A 可能是缺材料、权限或未知副作用；这既丢失当前原因，也可能在解决 B 后错误开放后续执行。

这是代码可直接确认的数据覆盖，不是理论上的事件乱序。更新应按明确 action/dependency 身份做增删，并与本次状态事务一同提交，不能批量清空 waiting 集合。

### F10 · P1 · 自动寻找转换路径绕过了等待用户和运行前置条件

位置：[task-state-authority.ts](../../src/task/task-state-authority.ts)，131–161、208–225 行。对应方案 §3.2。

`legalPath()` 用最短路径把不允许的直接转换拆成若干允许边。例如 needs_action→succeeded 会在同一事务自动经过 queued、running。边的名字合法，并不代表用户确认、排队、slot 和启动操作这些业务条件已经成立。

**复现：**needs_action Task 被动收到完成事实，调用 reconcile 后直接成为 succeeded，无用户处理、无 slot、无运行操作。

应验证一次真实事件允许的转换和前置事实；不允许以补写中间状态的方法消除非法转换。Kernel 应持有策略决策：当前 `evaluateTaskState()` 的生产调用者仅为 Authority，Runtime/恢复直接发起该调用，而非方案描述的 Kernel snapshot/Decision 链。

### F11 · P1 · 幂等键跨业务轮次复用，第二次阻塞会抛冲突

位置：[kernel-execution-runtime.ts](../../src/execution/kernel-execution-runtime.ts)，3880–3883、3378 行附近；[task-state-authority.ts](../../src/task/task-state-authority.ts)，96–125 行。对应方案 §4.1、§4.2。

block 的 operationKey 永远是 taskId+dependencyType，decisionId 却包含原因。首次 manual blocker 提交后，后续不同 manual blocker 使用同一 key、不同 payload，被 port 正确拒绝。此时 dependencies 已在事务外修改，状态/原因却仍是旧版。

**复现：**同任务先提交原因 A，再提交原因 B，抛 `TaskOperationConflictError`。

类似固定 key 也出现在一次 execution 的多轮 publication drain，以及可多次观察的服务状态路径。Authority 又是先从当前事实重新推导 payload，再查底层幂等记录；旧事件在状态变化后重放也可能因推导不同而被判冲突。应区分“同一操作重放”与“新事实版本”，前者先查已提交结果，后者使用新的稳定操作身份。

### F12 · P1 · 成功交付的服务不能再显式启动或重启

位置：[control-kernel.ts](../../src/kernel/control-kernel.ts)，835–848 行。对应方案 §4.4、设计“常驻服务由服务管理器接管”。

新增 terminal guard 把 succeeded 也纳入所有非 stop 服务操作的拒绝条件。正常服务交付会让 Task 成功，于是用户之后 `/service restart` 或 stop 后 start 被拒绝。服务独立生命周期被绑定到 Task 未结束，反而破坏接管后的管理能力。

**复现：**正确归属、已发布、succeeded Task 的 service restart，Kernel 返回 reject_request。

应区分任务中的启动要求和已接管服务的显式运维。后者通过服务归属与操作授权检查即可，不应改变原 Task 的成功结论。

### F13 · P2 · TUI 收到了 stateVersion，却没有用它拒绝旧覆盖

位置：[reducer.ts](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/reducer.ts)，386–392、420 行附近；[model.ts](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/model.ts)。对应方案 §6.1。

adapter 解析了 `stateVersion`，但 reducer/model 未保存并比较它，只比较 Conversation `asOfSequence`。Task 数据库版本可以变化而 Conversation 水位相同；连接流上后返回的旧查询仍会覆盖新状态。

**复现：**先应用 succeeded/v5，再应用相同 Conversation 水位、较晚到达的 running/v4，TUI 最终显示 running。

应按 account/task 保存已接受版本，同时保留 Conversation 水位规则；同版本冲突触发重取。该反例在真实 TUI reducer 上运行，不是另写的客户端模拟器。

### F14 · P2 · Task View 的响应升级了，hello/mirror/消费者测试未完成切换

位置：[client-protocol.ts](../../src/gateway/client-protocol.ts)，20 行；[gateway-protocol.ts](../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts)，121、174 行；[protocol-adapter.ts](../../planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/protocol-adapter.ts)，423 行。对应方案 §6.1、§6.3。

服务端响应为 v2，但 Server hello 能力和 vendored mirror 仍宣称 `task_view_v1`，新 adapter 却只接受 v2。新客户端连接旧 Runtime 会通过旧 capability 检查，随后静默丢弃旧快照；旧客户端连接新 Runtime 同样没有方案要求的明确拒绝。只改变响应常量不构成版本协商。

本次直接运行五个现有 TUI 文件，**104 通过、5 失败**：3 个 reducer 快照测试和 2 个 controller 接受/重试身份测试。相关 fixtures 仍发送 v1。这至少证明跨端契约及测试迁移没有完成，不能用根目录 Vitest 全量数覆盖 vendored suite。

应统一 hello、mirror、查询与响应约束，再测试新旧客户端/Runtime 的两个方向；更新 fixtures 后仍需保留真实版本拒绝与乱序测试。

### F15 · P2 · 端口错误码被丢弃，原案例无法显示 port_in_use

位置：[managed-local-service.ts](../../src/execution/managed-local-service.ts)，160–163 行；[kernel-execution-runtime.ts](../../src/execution/kernel-execution-runtime.ts)，3445–3466 行。对应方案 §5.2、§8。

probe 的 error 回调丢掉原始 Node error，把任何 listen 异常都改成相同中文 Error。外层再按 EADDRINUSE/port_in_use 字符串识别，自然拿不到原始 code；非占用错误也会被误描述为占用。

**复现：**本地真实 TCP listener 占住服务端口，运行真实 Session 的发布/启动链，Task 确实 failed，但原因是 service_start_failed，不是要求的 port_in_use。

应保留结构化 code/cause，仅将 EADDRINUSE 归为端口冲突。当前服务 catch 的 outcome 两个三元分支均为 definite_failure，也没有真正区分未知结果或缺外部凭证。

## 2. 其它尚未闭合的实施项

下表区分“静态确认未接入”和“尚缺验收证据”，不把所有风险都当作已复现故障。

| 实施目标 | 当前诊断 |
| --- | --- |
| 状态 outbox 的持久投递 | `TaskStateProjectionOutbox` 有写入和 list/mark 方法，但没有生产消费者调用 listPending/markDispatched；onProjection 也未找到注入点。已有 observation dirty triggers 能承担部分更新，因此不能简单断言所有客户端都丢通知；但新 outbox 不是已经闭合的恢复链，并会持续积累。 |
| 完整转换授权 | Task port 检查版本、转换表、部分 graph identity，但没有验证 Decision 存在/授权配置/slot token；缺 active graph 时也不拒绝带旧 graph 身份的命令。接口注释比实际保护范围更强。 |
| 有界 retry/核实 | facts 只看 armed/fired 和 resumeAt，就构造 boundedRecovery；未传入绝对截止时间与已用预算，observedAt 未参与判定。现有 Kernel retry policy 仍有部分保护，但不能据此宣称新汇总器能识别过期或无驱动 retry。 |
| 服务残留与接管 | `TaskResidueReader` 没有服务 effect/process/handover 类别。去掉 health_required 是正确方向，但“业务失败”与“本任务进程尚未退出”的分离还没有完整事实输入与超时隔离验收。 |
| 终态重试 | retryOf 字段和未被生产调用的规划函数不构成端到端重试；缺少只补服务/交付、精确引用旧成果与新授权的验收。 |
| 迁移旧 pending Kernel payload | schema 已到 52，但 Kernel wire 仍 v5；未看到对应旧 pending Decision/event 的证据分类、退役或显式兼容拒绝。不可变历史可以保留，未应用动作不能直接当新策略输入。 |
| 归档 | archivedAt 字段和 Repo 的 setArchivedAt 方法已存在，但未找到生产调用入口；该方法也不更新状态版本/审计。需明确正式归档流程及快照版本语义。 |
| 文档收口 | 产品文档和 docs/README 仍“待评审、未实施”；实施方案同时写“未实施”与“完成日期”；ADR-0049 为 Accepted。旧生命周期/四态计划仍在 plans，部分 current technical overview 保留 ready/blocked 等旧 Task 叙述。完成状态、契约与测试证据不一致。 |

## 3. 本次验证证据

| 验证 | 结果 | 含义 |
| --- | --- | --- |
| `npm run lint` | 通过 | 生产源码 TypeScript 可检查；不等于行为满足方案。 |
| Task、SQLite scheduler、取消、clarification、结果接受/服务、交付恢复定向套件 | 13 文件，83 通过 | 新结构及已有顺序流程可运行。 |
| Kernel、账户恢复、application recovery、历史迁移、Gateway query、Task View history | 6 文件，156 通过 | 这些现有回归通过。与上一行合计 239 项。 |
| vendored TUI overview/app/render/reducer/controller | 5 文件，104 通过、5 失败 | 根目录测试不覆盖的跨端契约缺口已实际出现。 |
| 临时状态/迁移/调度/TUI反例 | 11 个，11 个违反预期断言 | 包括使用旧 HEAD 真实 schema 51 的两项迁移反例。 |
| 临时真实 Runtime 反例 | 4 个分别运行，均违反预期断言 | 接受时 slot 被占、接受中断恢复、服务前等待接受、真实端口冲突。 |

本轮没有重跑根目录全部数千项测试，也没有进行 Docker、原生已安装 Runtime、Desktop 打包/升级、真实子进程 kill checkpoint 验收。没有把实施记录中“3871 通过、2 基线失败”当成本轮实测结果。

临时测试已从 `tests/` 和 `src/` 移出，避免给正常测试集留下故意失败的文件。复现源码、旧迁移副本和输出保存在本机：

`/tmp/metawork-task-state-review-20261022/`

- `review-state-diagnostics.test.ts`：11 项领域/SQLite/Kernel/TUI诊断。
- `review-runtime-diagnostics.test.ts`：复用现有 acceptance fixture 的 4 项运行时诊断。
- `review-schema51-baseline.ts`：来自基线 HEAD 的 migrations，仅用于建立真实旧库。
- `metawork-review-*.log`：原始测试输出。该目录为临时证据，重启或清理临时目录后可能不保留。

复跑时将三个 TS 文件分别放回 `tests/task/`、`tests/e2e/`、`src/storage/` 的同名位置，再运行对应 Vitest 文件；这些测试断言的是设计期望，在当前实现上失败是诊断结果，不能改成断言现状来“修绿”。

## 4. 修复与重新验收顺序

1. 先修接受事务/续跑、slot fencing、整任务/子图取消作用域和证据身份。这些决定能否安全运行，先不要补展示文案掩盖状态错误。
2. 修确定失败、服务前置条件、多 blocker 保留、单次转换授权和操作键轮次；随后补关联 Task 重试与服务接管后的运维。
3. 用真实 schema 51 夹具重做逐任务迁移与旧 pending action 分类，加入成功证据缺失、未知副作用、旧 running、部分取消和已接受结果的样本。
4. 同步 Gateway hello/mirror 与 Web/TUI 版本处理，接通或明确复用持久投影通知，删除未使用的重复设施。
5. 跑方案 §8 的完整链路：接受→交付→端口冲突→原任务失败→成果可见→清理→后继恰好启动一次；在每个提交边界注入中断，并核对 Task 版本、操作身份、slot token、队列及各端快照。

可以保留本轮已经做对的六态 vocabulary、metadata 类型隔离、Task 状态/CAS/审计事务基础、成功/失败分离和服务健康超时处理。需要补的是这些基础之间的真实执行与恢复闭环；在上述问题关闭前，实施文档应标为“部分实现，验收未通过”。
