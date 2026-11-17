# 已完成任务被重复派发恢复项阻塞：最终收敛方案

- 计划日期 / 最终方案整理日期：2026-11-14。
- 状态：**三项修复已实施；原始任务恢复、新四节点任务的真实账号 Web 验收通过**。
- 依据：ADR-0055（Task Runtime 与恢复职责）、ADR-0020（模块所有权）、
  ADR-0021（Work Graph）、ADR-0049（六状态任务结论）。
- 完成日期：2026-11-14。Closing commit：与本记录同批提交，主题
  `fix(execution): prevent duplicate dispatch from blocking completed tasks`；用户已明确授权提交并推送 GitHub。
- 触发样本：`task_plan_event_plan_conv_vEjqtdEqefPT_turn_pU-ddZXx7CcI_int_vFJWWhKR_K`
  （棕榈油反弹分析与 2705 多单胜率测算）。

> 时间：数据库使用 UTC；`2026-11-14 10:03Z` 对应北京时间 18:03。
> 本文替代此前的“五道防线”方案，旧提议不再作为实施要求。

## 0. 最终决定

**只修三个衔接：防止巡检重复驱动、正确结清确定的派发拒绝、恢复完成任务的收尾。**

四个子任务已经完成，用户也收到了答案，但系统把第二次派发被拒绝记成了未知操作；
该记录进入 `retry_authorized` 后未被正确推进或结清，持续阻塞 Task 结论。
这是调度与恢复的衔接缺陷，不需要重建任务状态模型。

保留现有任务状态、派发唯一性约束、恢复项和周期巡检。此次不新增持久租约表、
心跳、watchdog、通用请求队列、恢复 CLI 或 `pendingActions.blocking`。
不把“没有证明发生副作用”当成“证明没有副作用”。

实施前只读复核确认：Task 为 `needs_action`、state version 7；四个 Subtask 均为 `done`；
恢复项仍为 `retry_authorized`、apply attempts 2；s1/s2/s3 只有一组派发，s4 另有一条。
以下详细时间线保留原调查记录；快照时刻与触发路径推断不冒充逐条重放验证。

## 1. 用户看到的现象

- 页头：`待处理 · 19 步`（`needs_action` 的唯一用户话术，见
  [`web/src/task-status.ts`](../../web/src/task-status.ts)）。
- 卡片标题："需要你的处理才能继续"，原因："存在结果不明的外部操作，需要核实。"，
  下一步："点「查看恢复项」，查看未完成的步骤及可用的恢复操作。"
- 只有两个按钮：**查看恢复项**、**取消任务**。
- 子任务图（DAG）：子任务 1/2/3/4 全部显示"已完成"，各自有耗时和结果摘要。
- 用户困惑点很合理：**活儿都干完了，为什么还阻塞？而且阻塞卡在那里没法处理。**

---

## 2. 故障证据（原始调查记录，未手改数据库）

数据库：`~/.metawork/accounts/local-default/data/anyfusion.db`

### 2.1 执行已完成，Task 收尾未闭合

| 事实 | 值 |
|---|---|
| `tasks.status` | `needs_action`（state_version 7） |
| `state_detail.reason` | `external_outcome_unknown` / "存在结果不明的外部操作，需要核实。" |
| `requiredWork` | **9/9 全部 `completed`**（4 个 execution + 4 个 safety_report + 1 个 workspace_delivery） |
| `subtasks.status` | 4/4 `done` |
| `tasks.dependencies_json` | `[]`（没有任何 blocker） |
| `cleanup` | `pending`，`objects: ["kernel_application"]` |
| `tasks.summary` / `artifacts` | **空**（原记录；单凭空值不能证明退出位置，报告类任务允许 artifacts 为空） |

对照：同一 Task 的对话轮次已经 `completed`，答案正文 19,691 bytes 已交付，
但 `conversation_turn_answers.revision_key` 是 `result_..._safe`
（走"安全结果"通道），而不是 `complete_task` 通道。`interactions` 表**没有记录**
（结合状态变化，原调查判断完成收尾未走到 `recordInteraction`；不是仅凭空摘要推断）。

### 2.2 唯一异常：一条孤儿恢复项

```
task_recovery_items
  id            = decision_dispatch_event_exec_int_zz_MOYLYly
  status        = retry_authorized          apply_attempts = 2
  created_at    = 10:03:50.800Z             updated_at     = 10:10:45.730Z
  decision.action.type = dispatch_batch     （s1/s2/s3 三项）
  error_summary = "live dispatch attempt already owns ..._r1_s1_fundamental:
                   attempt_..._802c8344924720ba_..._primary"
```

### 2.3 时间线（0.1 秒粒度）

| UTC | 事实 | 来源 |
|---|---|---|
| 10:03:38.807 | Task 创建（已是 `queued`），`admitted_at` 同步 | `tasks` |
| 10:03:38.811 | 准入结果 `status = authorized`；schedule entry `enqueued_at=38.811` | `task_plan_admission_results`、`task_schedule_entries` |
| 10:03:42 前后 | **驱动 A** 拍"可派发快照"：s1/s2/s3 | 推断（见第 3 节） |
| 10:03:43.037 / 44.671 / 46.025 | 驱动 A 的 **3 次 Router 模型调用**（该样本记录的完成时序） | `route_decisions` |
| 10:03:45.721 / 45.822 | **巡检 tick**：先收回名额（`slot.last_served_at=45.721`，`fairness_sequence=2`），再 `markRunning`（entry `last_scheduled_at=45.822`） | `conversation_task_slots`、`task_schedule_entries` |
| 10:03:45.9 ~ 46.2 | **驱动 B** 拍"可派发快照"：**还是** s1/s2/s3（此时驱动 A 尚未落库） | 推断 |
| 10:03:46.032 | 驱动 A：`dispatch_resume` → `tasks.status: queued → running` | `task_state_changes` v2 |
| 10:03:46.388 | 驱动 A 写入 3 条 `dispatch_items`（decision `..._8PnEx3NAj`） | `dispatch_items` |
| 10:03:47.779 / 49.399 / 50.778 | 驱动 B 的 3 次 Router 调用（排在 A 之后） | `route_decisions` |
| 10:03:50.793 | 驱动 B：`dispatch_resume`（decision `..._zz_MOYLYly`） | `task_state_changes` v4 |
| 10:03:50.800 | 驱动 B 插入被守卫拦下 → **写入孤儿恢复项** | `task_recovery_items` |
| 10:06:00 ~ 10:09:54 | 4 个子任务全部完成，最终答案已交付 | `subtasks`、`executor_attempt_receipts` |
| 10:09:54.115 | 完成收尾 `completeTask` 重算结论 → **`needs_action`** | `task_state_changes` v7 |
| 10:10:45.730 | 巡检把孤儿恢复项从 `pending` 提升为 `retry_authorized`（attempts 1→2），**截至本次只读复核仍未结清** | `task_recovery_items` |

**重复派发请求的证据**：`route_decisions` 里 s1/s2/s3 各出现**两次**（43.0/47.8、44.6/49.4、46.0/50.8），
而 s1/s2/s3 的 `dispatch_items` 只有一组（3 条，来自 A）；另有 s4 的一条正常派发。
即同一批子任务产生了两次路由/派发请求，只有一次成功落库，没有执行两遍。

---

## 3. 根因与修复边界

1. `requeueQueuedTaskEntries()` 仅凭 Task 为 `queued` 重置调度记录；随后
   `convergeConversationSlots()` 释放名额并再次提升。准备派发时的 `queued`
   被误当成已经退让后的排队状态。
2. Router 与 Workspace 准备存在异步等待。另一轮可能拿到相同的可派发快照；
   SQLite 唯一性守卫拦住第二批插入，但普通 Error 被工作流记成未知恢复项。
3. 恢复扫描只看 `pending`，结论和残留判断却同时看 `retry_authorized`；
   本次 dispatch 的恢复授权没有闭合，导致完成收尾持续受阻。

已有 slot、reservation、schedule entry 可以提供持有事实，并非数据库完全无法区分。
`dispatch_resume` 在 `insertBatch` 之前；插入前还可能发生状态修改和 Git/Worktree 操作。
因此不能规定“所有提交前异常都是无副作用拒绝”。

参考实现：
[巡检](../../src/account/account-startup-recovery-service.ts)、
[调度记录](../../src/storage/conversation-task-scheduler-repo.ts)、
[派发事务](../../src/storage/dispatch-item-repo.ts)、
[工作流错误分类](../../src/execution/task-control-workflow.ts)、
[后置条件检查](../../src/execution/control-application-recovery.ts)。

## 4. 三项修改

### 4.1 正在准备派发的任务，不被巡检收回再提升

在账号共享的 Runtime 边界记录每个 Task 当前是否正在进行调度决策与应用。
优先复用现有运行中记录；缺少时使用进程内记录，不建表。准入、提升和恢复入口
必须看到同一份记录，不能各自在 Session 实例中维护互不相通的锁。

记录覆盖“读取派发快照 → Router/Workspace 准备 → 派发落库或本轮明确退出”的区间，
在 `finally` 释放。不要把等待 Executor、交付或清理的整个 `execute()` 都锁住。
进入关键区间后重新读取当前事实，不复用等待前的旧快照。

巡检统一读取当前驱动、reservation、调度记录、资源等待和残留事实：

| 情况 | 处理 |
|---|---|
| 正在准备或应用派发 | 保留当前 reservation，不重置 entry，不再次提升 |
| 已退出驱动，因资源不足退回 queued | 按原有资源/残留及版本检查释放、重排 |
| queued 且没有名额 | 按原有资格和容量规则等待提升 |
| 重启后的旧记录 | 沿用启动恢复，先核对 dispatch、进程、租约与残留，再决定恢复或释放 |

三个调度入口共享事实和规则，不强行把不同问题压成一个 `isActuallyQueued()`。
释放名额保留现有 reservation/version 校验，内存判断不能代替事务守卫。

同一 Task 重复的自动派发检查可合并；必要时在本轮退出后按新事实再检查一次。
携带独立意图的 resume、恢复决议等继续走现有控制事件路径，不以 taskId 相同为由丢弃，
也不排到整个任务执行完才处理。每个调用方都必须得到明确结果。

前提是同一运行数据由受实例锁保护的 Server 驱动。实施时核对现有 `runtime.lock`
覆盖相关启动入口和数据路径；本次不增加多进程共享数据库能力。

### 4.2 重复派发被守卫拦下，是明确拒绝，不是未知执行

保留 `insertBatch` 的整批事务、相同 attempt 身份幂等和 live attempt 唯一性守卫。
**此次不改成逐条跳过，不增加宽泛的 superseded 成功判定。**

由 Repository 在事务内识别确定的 live-owner 冲突，提供结构化冲突信息；
事务完整回滚后，由 Runtime 转成既有工作流可识别的明确结清结果。
不能通过解析错误文本决定是否安全，也不能让 Repository 承担恢复策略。

只在可证明本批没有新增执行授权、冲突所有者身份明确，且相关准备操作已有明确结果时结清。
轨迹如实记录“本次派发被已有授权拒绝”，不声称新 attempt 已经执行。
若整批因冲突回滚，下一轮按最新事实检查剩余工作，避免非冲突项被遗忘。

数据库故障、部分持久事实、身份不一致、Workspace 操作结果未知等，仍走原有恢复检查。
不增加“提交前任何异常一律 rejection”的全局 catch 或断言。

正常 continuation、fallback、contract correction、merge repair 和 service repair
继续按原有授权执行；历史上存在终态 attempt 不构成拒绝新 attempt 的理由。

### 4.3 旧恢复项要结清，Task 收尾要可恢复

沿用现有周期巡检和 `inspectApplicationAgainstSources`，检查 `pending` 与
`retry_authorized` 两类未结清记录。启动恢复和 `/task recovery` 使用同一判定。
不全局删除 retry，不为扫描到同一条已授权记录反复增加次数。

保留“本授权确实应用”的精确身份校验；为本次故障增加严格受限的结清分支：

- 原操作是重复的普通派发，Task、generation、图版本和 Subtask 归属一致；
- 本批自己的 attempt 未落库、没有关联执行或未决准备操作；
- 能核对原冲突对应的合法授权及回执，目标工作确已由这些执行完成；
- 不存在需要继续执行的修复/重试请求，也没有取消、跨代或身份冲突。

满足这些条件，结清的是“多余派发已失去执行必要”，不是宣称它执行成功。
复用现有结构化结清和审计机制，记录被结清的恢复项、证据及原因。
错误字符串、任意历史 attempt、单独的 `done` 或 `cancelled` 都不足以结清。
不能证明的记录保留，并报告具体缺少的证据。

`retry_authorized` 的后续按原操作归属处理：

| 检查结果 | 动作 |
|---|---|
| 精确后置条件已满足，或上述重复派发已证明可结清 | 结清一次，触发受影响 Task 的收尾检查 |
| 可安全重试且仍需工作 | 由现有 owner 推进；普通派发重新评估当前工作，完成/服务恢复走各自已有路径；随后复查旧项 |
| 已有重试正在推进 | 等待其结果，不重复授权或递增次数 |
| 证据不足、无可用恢复路径或达到预算 | 保留可诊断的阻塞，不静默忽略，不无限自动重试 |

结清后复用现有完成边界，补齐摘要、实际产物、认证结果交付、interaction、完成通知和图收尾；
再按既有残留检查释放名额并推进后续任务。复用已有结果和交付身份，不重跑四个 Executor，
不重复交付答案，不以直接更新 `tasks.status` 代替收尾。

**必须覆盖“恢复项已结清、收尾尚未完成时进程退出”的窗口。** 启动/周期恢复从已有
图、完成记录和 outbox 识别未完成收尾，重复执行仍只落一次；不能只靠一次内存回调。
若收尾失败，交给已有完成恢复路径，用户看到具体收尾原因。

终态不可变不禁止补写收尾记录：现有 `finishDeliveredWorkspaceTask()` 就在
`succeeded` 后调用 `completeTask()`。恢复不得因 Task 已成功而遗漏未完成的收尾。

## 5. 实施与当前样本恢复

顺序：先写可控竞态回归，再完成三项修复及负向测试，最后恢复实际样本。
三项作为同一修复验收，不拆成五个架构阶段。

实际数据操作前创建一致性备份（在线 SQLite backup 或停服后完整备份，不能只复制活跃主库文件）。
先只读输出候选记录、身份与结清依据；确认规则严格命中后，经相同恢复 owner 处理。
实施结果与实际数据恢复见第 7 节；未以手改状态或直接删除恢复项的方式处理样本。

当前样本恢复的完成标准：Task 成功、必要收尾记录完整、恢复项结清、残留消失；
原名额释放，存在后续排队任务时可正常提升。四个子任务及已有执行回执不重写。
不新增长期维护的 sweep CLI；使用既有启动/周期恢复和现有诊断入口。

## 6. 验收

| 场景 | 必须满足 |
|---|---|
| Router 用 deferred gate 暂停，期间运行巡检 | reservation/entry 不被误重置，无第二轮重复路由，无错误恢复项，最终完成 |
| 绕过入口保护，直接制造两批冲突授权 | 事务守卫仍有效；第二批明确拒绝，不增加未知项；整批回滚后剩余工作仍可推进 |
| 同 Task 有不同意图请求 | 用户控制事件不丢失，每个请求有明确回复，无等待整个任务结束的循环依赖 |
| 正常重试、fallback、修正与服务修复 | 允许合法的新 attempt，不被历史 attempt 误伤 |
| 资源退让、启动恢复 | 名额可正确释放和再次提升，有实际残留时不释放 |
| Git/Workspace 未知、提交后中断、部分/错配事实 | 不被重复派发规则误清理；查明后可自动结清，无法查明则保留阻塞 |
| retry_authorized 重复扫描 | 已满足项只结清一次；有工作者推进；无推进依据者可诊断，无空转和虚增次数 |
| 结清后、收尾前崩溃，再次启动/扫描 | 收尾能补齐，interaction/outbox 幂等，不重新执行 Executor |
| 当前样本 | dispatch/receipt 数量和身份不变；缺失 interaction 补一条；摘要与结果完整；artifacts 符合实际（允许空）；名额释放或已交给后续任务 |

聚焦测试覆盖 account recovery、scheduler、dispatch repo、workflow、postcondition 和 completion；
执行 lint/build 与 maintained-host suite，区分新增回归和已知基线失败。
最后做 macOS arm64 + Web 验收，确认状态、答案和恢复入口一致。

已按实际变更同步 ADR-0055、`CONTEXT.md` 和技术概览。以下记录区分代码回归、
真实账号验收及尚未通过的仓库/打包检查。

## 7. 实施与验收记录（2026-11-14）

### 7.1 实际落地

1. **同 Task 的关键区间串行。** `ControlExecutionRuntime.withTaskOperation()`
   由账号共享，覆盖每个事件的读取快照、决策及应用，`finally` 释放；Executor drain
   不在其中。不同意图不合并丢弃，各自读取新事实并回调。巡检的 entry 重排、slot
   收敛和 promotion 候选共同读取 `isTaskOperationActive()`，原有资源退让及版本守卫保留。
   已核对 Server 在可写恢复前获取现有 `runtime.lock`，不新增锁表。
2. **只结清确定的整批拒绝。** Repository 的 IMMEDIATE 事务返回结构化
   `DispatchAttemptConflictError`，整批回滚后 Runtime 记录 `dispatch_conflict_rejected`
   并按新事实检查剩余工作。其余错误仍保留未知恢复语义，不解析错误字符串放行。
3. **结清和收尾形成可恢复闭环。** 启动、周期和诊断共用后置条件 inspector，扫描
   `pending` 与 `retry_authorized`。严格核对普通重复派发的合法 owner、路由图身份、
   执行授权和已完成回执后，以结构化 settlement 标记结清，保留原错误和次数。
   普通可安全重试项由原 owner 重新评估当前 frontier，沿用原事件身份和既有预算；
   扫描本身不重复消耗授权。持久标记加现有 graph/outbox/answer 事实使未完成收尾
   在重启后仍可发现，复用 `completeTask()`、认证结果和稳定结果身份；周期巡检也
   继续交付 pending 完成通知。不重跑 Executor，不另建完成账本。

### 7.2 聚焦回归

以下 5 个文件 **96 项通过**（其中新增事故回归及完成测试 65 项，既有服务修复 31 项）：

- `tests/execution/task-control-workflow.test.ts`
- `tests/execution/duplicate-dispatch-recovery.test.ts`
- `tests/execution/dispatch-conflict-settlement.test.ts`
- `tests/execution/workspace-completion-result.test.ts`
- `tests/execution/service-repair-continuation.test.ts`（fixture 补齐新增查询依赖，行为断言保留）

覆盖实际 `execute()` 入口的 deferred Router 暂停与 `recoverPeriodic()` 竞态、
reservation 保持、独立 resume 回调、资源退让重排、整批冲突回滚与剩余工作复查、
合法 continuation/fallback/correction/merge repair、17 类证据不足负例、真实未知仍保留
恢复项、重复扫描不虚增次数、safe retry owner 的实际推进/预算，以及结清后跨 Repository
重建和终态任务的收尾重入。完成边界测试覆盖事务回滚、认证结果复用及交付幂等。
精确竞态由 gate 控制；真实账号 smoke 不冒充精确竞态复现。

额外运行 scheduler、application inspector 和旧 account/dispatch 测试：32 项通过，
3 个文件失败，分别为旧 `kernel-dispatch-item-repo.js` 引用缺失（2 个文件）及
`buildControlCoordinator` 旧 fixture（1 个文件）；三者均在 2026-11-12 失败基线内。

### 7.3 原任务：正常启动恢复通过

操作前使用 SQLite backup 创建一致性备份；备份与旧运行包保存于本机
`/tmp/metawork-duplicate-dispatch-20261114/`（目录 0700，含账号数据的文件 0600）。
将构建后的服务/Web 覆盖到本机已安装的 `0.1.29-desktoppayload-1741`，保留其打包
Pi、Node 与已验证 PDF runtime，再通过正常 Server 启动/周期恢复处理；未写 SQL 修状态。
这只是本地验收部署，不代表签名发行或干净机器验收。

| 核对项 | 恢复前 → 恢复后 |
|---|---|
| Task | `needs_action` v7 → `succeeded` v8 |
| summary | 长度 0 → 323；报告类任务 artifacts 仍为 `[]`，符合实际 |
| 孤儿项 | `retry_authorized` → `assumed_applied`，结构化原因 `duplicate_dispatch_completed` |
| apply attempts | 始终为 2；重复巡检不再修改结清记录 |
| dispatch / receipt | 各 4 条；与恢复前备份**全部字段逐行一致** |
| interactions | 0 → 1 |
| 图 / 完成通知 | graph `completed`；唯一完成 outbox `sent`，delivery attempts 1 |
| Conversation slot | `free`，active task 与 reservation 均为空 |
| Web | HTTP 200，显示成功、任务已完成和完整答案，无 pageerror |

原安全结果 revision/body hash 保留；新增完成边界使用唯一
`result_workspace_completion:<task>:<generation>` 身份，不新增重复聊天轮次。
经过多个周期后，完成结果身份、interaction、outbox 和派发数量保持稳定。
证据为本机 `acceptance-db.json`、`browser-acceptance.json`、
`historical-final.txt/png`；文件含用户任务信息，不入库。

### 7.4 新任务：真实官方账号 + Web 全链路通过

用户在重启后的 `http://127.0.0.1:8788` 重新登录官方账号，随后从 Web 发送四节点
验收请求（只做文字分析），由真实 Manager → Router → Executor → Manager 汇总完成。

- Task：`task_plan_event_plan_conv_JIVeoIR10aWp_turn_aE7pdUx8vN6q_int_INFA3PcYsp`。
- A/B/C 于 `13:26:15.093Z–15.094Z` 启动，均有重叠执行区间；
  三者最后一项于 `13:26:23.761Z` 完成，依赖三者的 D 于 `13:26:26.040Z` 启动。
- 4/4 节点 done，4 条 dispatch、4 条 completed receipt；每个节点只有 1 次 Router
  选择；无 recovery item。Task `succeeded` v7，summary 长度 521，interaction 1 条，
  完成通知 1 条且 sent，slot free。
- 浏览器显示“任务已完成。”及 `MW-DUPLICATE-DISPATCH-20261114-PASS`，
  HTTP 200，无 pageerror。该标记只用于识别验收结果；通过结论来自状态、回执和时序核对。
- 证据为本机 `acceptance-db.json`、`new-task-final.txt/png`；随后重复巡检核对无重复执行
  或重复完成记录。

### 7.5 构建和全仓检查

- `npm run lint` 通过。
- 服务 `tsup`、Planner schema/attempt extension 生成及 `npm run build:web` 通过；
  真实账号验收运行的正是该服务/Web 构建。
- 完整 `npm run build` 在 PDF runtime 外部下载环节因 GitHub 下载超时未通过；
  未伪造缓存或省略完整打包限制，本地验收保留原安装包 PDF runtime。
- 全仓按既有基线相同的 60 秒 test/hook timeout 运行：728 个文件，484 通过、
  27 跳过、217 失败；4302 项中 3833 通过、41 跳过、428 失败，另有 5 个异步错误。
  216 个失败文件与 `2026-11-12-web-recovery-review-test-failures.json` 完全对应；
  唯一新增失败为服务修复 fixture 缺少 `recoveryItems.findRecoveryItem`。补齐 fixture
  后该文件 31 项及上述合计 96 项全部通过；未修改其服务修复行为断言。
  原默认 600 秒超时的整仓运行长时间未退出，已中止；上面的完整结果来自有界重跑。
- 原生维护宿主检查显式启用 `RUN_PACKAGED_PI_E2E=1`：7 文件中 5 通过、2 失败，
  29 项中 24 通过、5 失败。实际 Pi Manager RPC、permission 与 Executor 进程测试通过；
  `permission-workflow-service` 和 `read-only-workspace-boundary` 的 5 个失败均与
  已有基线一致。没有将整套原生检查报告为通过。
- 全仓原始结果 `/tmp/mw-duplicate-full-bounded.json`，聚焦日志
  `/tmp/mw-duplicate-focused-final.log`，原生检查日志 `/tmp/mw-duplicate-native-host.log`；
  `git diff --check` 通过。上述日志均为本机验收证据，不提交。

本次验收确认了该样本、同类重复驱动的可控竞态和正常多节点链路；真实未知副作用
继续阻塞并要求核实。未扩大到多进程共享 DB、签名安装包、Linux、Desktop 或飞书验收。
代码、聚焦回归与本记录一同提交；数据库、账号状态、运行包及本机验收日志不入库。
