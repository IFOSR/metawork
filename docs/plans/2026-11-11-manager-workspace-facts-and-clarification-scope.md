# Manager 的 Workspace 事实与澄清边界

- 计划日期：2026-11-11。
- 状态：P0、P1、P2 文档与真实 Web 端到端验证已完成；停服务/执行命令契约、服务所有权
  提示与权限判定规则已修（2026-11-11 第二轮）；`execute` 三态与规划详情未做。
- 本批验证日期：2026-11-11（单元测试仅跑本改动直接相关文件；另做真实 Server + Admin Web 验证）。
- Closing commit：无。按仓库要求仅本地修改，未 commit、push。
- 依据：[ADR-0055 D6](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)、
  [ADR-0015](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)、
  [CONTEXT.md](../../CONTEXT.md) 的 Manager 边界与 Conversation Git Worktree 契约。

## 问题

一次真实 Turn 中，用户在同一 Conversation 里从“设计判定方案”继续到“直接把这个服务实现了吧”。
Manager 没有产出写计划，而是返回 `clarification`，正文为：

> 当前工作区 /Users/yuanjubian/program/test 是只读的，我没法把服务代码写进去并跑起来。两种方式你选一个：(A) … (B) …

用户被要求为“系统能不能写”做决策，而这既不是用户意图歧义，也不是真实阻塞。

## 证据

- Conversation `conv_DTAHMAkk0RBw`，Turn `turn_pQNI6VRbysuR`（2026-11-11T06:59:06Z）。
- Manager 会话记录（隔离实例）：
  `/tmp/mw-planning-e2e-RDW7Um/accounts/local-default/manager/sessions/401bc118…/2026-11-11T05-48-49-234Z_….jsonl`。
  Turn prompt 原文含 `workspace: /Users/yuanjubian/program/test (只读)`；Manager thinking 原文为
  “Note: workspace is 只读 (read-only). … If truly read-only, we can't implement files”，
  随后提交 `action: "clarification"`、`workspaceIntent.operation: "ambiguous"`。
- 同一 Conversation 的 Turn 1 已出现同一误判：`workspaceIntent.operation: "read_only"`，
  reason 写“工作区 … 为只读”，并对用户复述“工作区为只读”。
- 该 Workspace 实际可写：`workspace_git_roots` 为 `state=ready`，
  `conversation_git_worktrees` 已为本 Conversation 建好 worktree；
  同一 Workspace 的另一 Conversation `conv_v1WHidqdqcpe` 于 2026-11-11T03:36Z
  经合并队列交付 `workbuddy-vs-doubao-qwen.pptx`（用户目录 mtime 11:36），
  证明写入链路正常。
- 运行时侧没有拒绝：`workspaceIntent.operation='ambiguous'` 只是让
  `plan-admission-policy` 走 clarification 分支；clarification 不创建 Task、
  Attempt、Worktree 或写租约（`conv_DTAHMAkk0RBw` 仍只有 Turn 1 一个 Task）。

## 根因

三处叠加，全部是上下文构造问题，不是执行/权限判定问题：

1. **措辞层**：`renderTurnPrompt` 把 `mode === 'read_only'` 渲染成
   `workspace: <root> (只读)`，把“Manager 自己的检视范围”表达成“目标目录属性”。
2. **事实缺席层**：Manager system prompt 只有一串否定约束
   （read-only inspect、Never edit files），缺少正向授权
   （写由 Executor 在 Conversation Git Worktree 执行、由 Runtime 合并回 Workspace），
   模型自然选择最保守路径。
3. **数据层**：`resolveManagerScope` 在生产上恒为 `writable: false`，
   `mode: 'write'` 分支不可达，只存在于单元测试，属于二次踩坑地雷。

## 设计原则：三类事实分离

| 事实 | 归属 | 呈现对象 | 是否可变用户问题 |
| --- | --- | --- | --- |
| Manager 工具面只读、不能 shell/edit | Manager extension | 仅 Manager | 禁止（也不得向用户复述） |
| 任务执行面：写发生在 Conversation Git worktree，由 Runtime 合并回 Workspace | Runtime，逐 turn 提供 | Manager（用于正确规划） | 禁止 |
| 用户意图歧义：做什么、目标路径、范围、覆盖、高风险、冲突取舍 | 用户 | Runtime 提问 | 允许，且仅此一类 |

## 目标 Turn prompt

改前：

```
workspace: /Users/yuanjubian/program/test (只读)
```

改后：

```
workspace: /Users/yuanjubian/program/test
execution writes: Executor commits in this Conversation's Git worktree; the Runtime merges the result back into the Workspace. Declare file work with workspaceEffect/fileOutputs and workspaceIntent.
```

不再出现“只读/可写”二值标签，也不再出现任何关于 Manager 自身权限的描述。

## 落地清单

### P0-1 单一事实源与单一渲染点

- `src/planning/manager-host/protocol.ts`：`ManagerTurnInput.workspace` 收敛为 `{ root }`。
- `src/planning/manager-host/manager-planning-agent.ts`：`ManagerTurnScope` 删除 `writable`；
  planning 与 summary 两条路径都只传 `root`。
- `src/planning/manager-host/manager-agent.ts`：只保留一处渲染，
  输出 Workspace root 与执行写入事实。
- `src/server/server-composition.ts`：`resolveManagerScope` 删除 `writable: false` 死分支。

### P0-2 Manager 规则

`src/planning/manager-host/extension/index.ts` 的 system prompt 增加三条：

1. 请求要求产物时必须 `plan_work_graph` + `workspaceIntent`
   （`create_in_target` / `modify_existing` / `continue_existing_edit` / `run_in_target`），
   并在写子任务声明 `workspaceEffect` 与 `fileOutputs`；不得因“Manager 只读”降级为报告。
2. 仅在用户意图不明确时 `clarification`：功能范围、目标路径、覆盖既有文件、
   高风险确认、冲突取舍。
3. 禁止就自身工具权限、Workspace 写模式、Executor 能力或 Runtime 限制向用户提问，
   也禁止向用户报告这些内容；系统不可执行时由 Runtime 自己给出结论与原因。

### P0-3 测试

- `tests/planning/manager-agent-rpc.test.ts`：删除 `toContain('只读')`；
  断言 prompt 不含 `只读/可写`，包含执行写入事实。
- `tests/planning/manager-planning-agent.test.ts`：scope 契约改为 `{ workspaceRoot, permissionProfileRef }`。
- `tests/planning/manager-provider-config.test.ts`、`tests/planning/manager-host-process-runner.test.ts`、
  `tests/manual/manager-real-turn*.test.ts`、`tests/e2e/packaged-pi-native.test.ts`：同步 `workspace: { root }`。
- 新增确定性场景：用户要求“实现服务”时，写计划得到 `workspaceAdmission.kind === 'write'`
  且不产生 clarification（scripted Manager，不依赖真模型）。

### P1 Runtime 拥有“真不可写”

- 把 Workspace Git 就绪度加入 `WorkspaceAdmissionFacts`。
- `resolveWorkspaceExecutionDecision` 在 `writes=true` 且 Git 根 `failed` 时返回
  `status:'rejected'` 并携带可行动原因（如 `workspace_git_failed: <error>`）。
- 该结果走 Runtime 失败呈现，不进入 clarification 通道；`initializing` 不拒绝。

### P2 文档与真实验收

- `README.zh-CN.md`、`CONTEXT.md` 相关句子改为“Manager 检视范围为只读；写入在
  Conversation worktree 完成并合并回 Workspace”，避免读者继续复述“Workspace 只读”。
- `npm run smoke:metawork` 增加“在当前 Workspace 实现一个最小 BS 服务”scenario，
  验证真实模型产出写计划、合并队列落盘与服务启动。

## 合法澄清白名单（保留）

高风险确认、状态变更置信度 < 0.45、计划本身为 clarification、
resume/abandon 未指明 Task、`workspaceIntent` 为 `ambiguous` / 无 targetPaths /
置信度 < 0.3、未绑定 Workspace、合并冲突选择文件版本。

移出白名单：Manager 自身权限、Workspace 可写性、Executor/AgentClass 可用性。

## 不做

- 不做输出文本后置过滤（禁止出现“只读”字样）。
- 不改 `PlanningAgentPlan` schema 版本、不加 DB 字段、不新增语义路由器。
- 不放宽任何 admission / 权限闸；写入仍走 worktree + 合并队列 + publication gate。
- 不把 Manager 的能力状态放进 Web 的“需要你回答”卡片。

## 验收

P0 完成后重放该类请求，期望：Manager 直接产出 `plan_work_graph`（`create_in_target`，
前后端文件 + 启动验证子任务），Runtime 给 `write` admission，页面进入执行，
不再出现“需要你回答”。P2 的真模型 smoke 作为最终证据。

## 交付记录（2026-11-11）

改动的文件：

- `src/planning/manager-host/protocol.ts`：`ManagerTurnInput.workspace` 收敛为 `{ root }`。
- `src/planning/manager-host/manager-agent.ts`：删除“只读/可写”渲染，改为单一执行写入事实。
- `src/planning/manager-host/manager-planning-agent.ts`：`ManagerTurnScope` 删除 `writable`，
  planning/summary 两条路径只传 root。
- `src/planning/manager-host/extension/index.ts`：新增正向写授权、澄清范围与禁止能力提问三条规则。
- `src/server/server-composition.ts`：`resolveManagerScope` 删除恒假死分支；为
  `ConversationSession` 注入 Runtime 拥有的 Workspace 写就绪度。
- `src/core/workspace-execution.ts`：新增 `WorkspaceWriteState`、
  `WorkspaceAdmissionTargetFact` 与 `workspaceWriteStateOf`。
- `src/control/workspace-execution-decision.ts`：`writes=true` 且 Git 根 `failed` 时
  以 Runtime 原因 rejected；`initializing`/未知不阻塞。
- `src/control/control-contracts.ts`、`src/execution/plan-admission-policy.ts`、
  `src/account/generation-replan-worker.ts`、`src/session/conversation-session.ts`、
  `src/session/metaclaw-session.ts`：传递可选的 Workspace 写就绪事实。
- `README.zh-CN.md`、`CONTEXT.md`、`docs/README.md`：口径与索引更新。

测试（仅本改动直接相关文件，7 文件 90 项通过；`npx tsc --noEmit` 通过）：

- `tests/planning/manager-agent-rpc.test.ts`：prompt 不含只读/可写，包含执行写入事实。
- `tests/planning/manager-planning-agent.test.ts`：新增“实现服务 → 写计划 → write admission、
  无 clarification”确定性用例。
- `tests/planning/manager-extension.test.ts`：断言新的 Manager 规则。
- `tests/control/workspace-execution-admission.test.ts`：Git 根 `failed` 拒绝、
  `initializing`/未知放行、就绪度投影映射。
- `tests/planning/manager-provider-config.test.ts`、`manager-transport-selection.test.ts`、
  `manager-host-process-runner.test.ts`：scope 契约随类型收敛。
- `tests/manual/manager-real-turn*.test.ts`、`tests/e2e/packaged-pi-native.test.ts`
  仅同步类型，未运行（需要真实打包 Pi）。

待办：把该场景接入 `npm run smoke:metawork`（P2），以及用户在自有账号下复验。

## 真实环境端到端验证（2026-11-11）

环境：源码构建的 8788 实例（运行根 `/tmp/mw-planning-e2e-RDW7Um`，`dist/` 重新构建，
`METAWORK_PI_COMMAND` 指向打包 Pi），Admin 网页会话，真实模型与真实 Executor。
截图与日志保存在 `/tmp/mw-e2e/`（临时文件，非仓库交付物）。

1. **回归场景（本改动核心）**：在 Conversation `conv_DTAHMAkk0RBw`
   （Workspace `/Users/yuanjubian/program/test`）发送“请直接在当前 Workspace 里把最小可运行版本做出来：
   新建 price-in-service 目录，写 backend.py / index.html / README.md”。
   - Turn `turn_xNopHU3SRTdY`，plan `plan_event_plan_conv_DTAHMAkk0RBw_turn_xNopHU3SRTdY_int_7FI--auglJ`：
     `action=plan_work_graph`、`workspaceIntent.operation=create_in_target`、
     `targetPaths=[price-in-service/backend.py, index.html, README.md]`、`confidence=0.95`、
     `clarificationQuestion=null`。**没有出现“工作区只读/需要你回答”**。
   - Admission `authorized / work graph authorized`；Task
     `task_plan_event_plan_conv_DTAHMAkk0RBw_turn_xNopHU3SRTdY_int_7FI--auglJ` `succeeded`
     （407s，1 个 Executor attempt）。
   - Merge job `merge_02d46cf9…` `delivered`，三个文件 `add` 写回用户 Workspace；
     页面显示“任务已完成 / 已发布到工作区 / 本轮更新文件（3）”，刷新后保持。
   - 旧 Turn 2 的历史澄清卡片仍按原样保留（不重写历史），新 Turn 不再复现。
2. **普通问答不回归**：新 Conversation `conv_Nl0NGoJO2G7-` 发送
   “只回复一句话：MW-QA-20261111，不要修改任何文件。”
   plan `no_action`、admission `no_action / no runtime action required`，答复
   `MW-QA-20261111`，页面无澄清。
3. **周边功能**：既有会话历史加载、Workspace 切换、会话搜索（“鸡蛋”过滤到 1 条）、
   轨迹（执行 DAG：1 子任务、成功、1 attempt）、账单（Token 分组与区间）、记忆（13 条，含本次
   新提取的 L1）、交付文件预览与“下载原文件”均正常。

### 验证中发现但本批未修的既有问题

- Q&A（`no_action`）Turn 完成后，“规划中 / 正在理解请求并生成计划…”卡片仍停留在对话里
  （刷新后仍在，计时停在 0s）。该 Turn 的 trace 只有 `query_received` + `planner_started`，
  缺少终结性的 planning 事件，而 `web/src/components/LivePlanningPanel.tsx` 只根据最后一条
  planning 事件渲染，未结合 Turn 终态。与本批 Workspace 事实改动无关，待单独修复。


## 第二轮：执行命令 / 停止服务（2026-11-11）

### 问题与原因

用户要求“把 8000 端口的服务停掉”时，Manager 正确判断该进程不是平台托管实例，改为
`plan_work_graph + run_in_target` 去终止进程，但子任务被声明为 `workspaceEffect: read_only`
（因为不改文件）。准入规则要求“非 read 意图必须有独占写子任务”，于是 Turn 以内部英文
不变量 `a non-read-only intent cannot authorize a read admission` 失败；用户看到的是
“当前请求未通过执行校验”。在此之前两次 `task_control: service_stop` 均以
`planner_failed: 服务不存在` 静默结束：8000 端口的 uvicorn 是 Executor 自己在
`startServiceAfterPublish=false` 的任务里用 nohup 启动的，平台既未托管也未登记。

### 本批改动

- `workspaceEffect` / `run_in_target` 的 schema 描述改为“独占 Workspace 访问”语义：
  运行或终止进程即使不改文件也必须声明 `write`。Manager system prompt 同步该规则。
- 计划校验器新增可修复 issue：非 read 意图的图里必须至少有一个 `workspaceEffect: write`
  子任务，Manager 在同一次 Turn 内修复，而不是跌到准入。
- 准入保留该不变量做兜底，但返回中文可行动原因（`code: workspace_intent_requires_write`）。
- `service_stop` 找不到托管实例时不再静默：说明该进程不是平台托管实例，并给出
  “用你的进程管理器停止”或“执行定位并终止进程的命令任务”两条路径。
- Manager 规则：启动服务必须显式选择托管验证实例（`startServiceAfterPublish=true`，
  随 Runtime 停止）或交付常驻部署说明（独立于 MetaWork）；禁止 daemon 化。
- Executor 提示词：任何任务都不得 nohup/&/disown 起常驻进程；用户明确要求时允许终止
  可识别的进程并汇报 PID/命令/端口状态。
- 权限判定（permission 分支）：终止 attempt 之外的进程属外部副作用，仅在当前用户 Turn
  明确要求且目标有界（PID/端口/命令）时 grant，否则 escalate 一次用户确认。
- Web：Turn 终结且非规划失败时不再渲染规划卡（Q&A、澄清、取消后不再停留“规划中 0s”）。

### 真实验证（2026-11-11，Admin Web）

- **停 8000 端口（原失败场景）**：Turn `turn_xchcNevYoPO2`，plan `plan_work_graph |
  run_in_target | effects=write | clarify=null`，admission `authorized`，Task `succeeded`
  （65s），Executor 终止 PID 67819、`lsof` 与 `curl` 三轮验证端口释放；答复含 PID、命令行、
  端口状态与未触碰 4173 的说明。页面无澄清、无残留规划卡。
- **普通问答**：新会话发送 “只回复一句话：MW-CARD-OK-20261111”，答复正常，规划卡不再
  停留（刷新后一致）。
- **托管启动（部分验证）**：送“用平台托管方式启动 mini-service（8123）”，plan 为
  `plan_work_graph` 且 `task.startServiceAfterPublish=1`，代码 3 个文件已写回 Workspace；
  但服务启动验证失败，命中了下面的既有 DB 约束缺陷。

### 验证中发现的既有缺陷（未在本批修复）

`task_operation_results.outcome` 的 CHECK 只允许 `('success','definite_failure','unknown')`，
而 `TaskOperationResultRepo` 与 Runtime 会写入 `repair_pending`（服务验证失败待修复路径）。
结果是服务启动/验证失败时抛出 `CHECK constraint failed: outcome IN (...)`，Task 以
`service_start_failed` 结束、用户看到“需要处理 / 服务启动失败”而看不到真实原因。
- 影响：任何“服务未健康 → 自动修复”的路径都会在记录事实时崩溃。
- 修复需要把 CHECK 扩到 `repair_pending`，即 schema 67 → 68；当前仓库没有就地升级
  机制（`schema.ts` 明确拒绝旧版本，`database-release-snapshot.ts` 只复制不升级），
  升级会要求现有实例重建数据库。属独立决策，未在本批擅自变更。

## 第三轮：阻塞解除后的调度与接受结果收尾（2026-11-11）

真实任务 `task_plan_event_plan_conv_NjTzOAxW1x-2_turn_sjn36GJNvp5J_int_HppUn0ofn5`
（用户自己的 GEO 检索任务）暴露两个独立缺陷：

1. **阻塞原因不是权限，而是完成契约失败**：某个检索子任务在 `web_fetch` 拿到百度
   反爬验证页（`success:true`，正文“百度安全验证…”）后，最终完成证据与授权验收项
   不匹配（`completion_acceptance_mismatch`），子任务以 `contract_failed` 阻塞，任务
   进入 `needs_action`。
2. **“接受并交付”后下游不调度**：用户接受未认证结果后，`task_result_continuation`
   把子任务标记 done，`wakeAfterResultContinuation → recoverDue` 只做一次空队列
   recovery drain，从不提交 `dispatch_requested`；`synthesize-report` 保持 `ready`、
   `nextWakeAt=null`，页面一直“等待中”。
3. **接受结果后最终收尾失败**：`workspaceCompletionSources` 只把
   `terminalState==='completed'` 的 receipt 当来源，而 Task facts 已把“显式接受”
   的 receipt 视为节点完成证据，导致 `workspace_completion_missing_certified_results`
   把任务停在 `needs_action`。

修复与验证：

- `recoverDue` 在任务处于 `running` 且存在 `ready` 子任务时提交派发事件，而不是空 drain。
- `workspaceCompletionSources/Result` 接受显式接受过的 receipt（来自 Task facts 的
  `accepted` 标记）作为最终答案来源。
- 真实环境验证：重启后上述卡住的 `synthesize-report` 自动派发并完成，任务从
  `needs_action` 收敛为 `succeeded`；页面无“等待中/需要处理”，无残留规划卡。

仍未处理（下一批）：反爬验证页被 `web_fetch` 当作成功内容，导致 Executor 拿不到
真实数据并最终契约失败；需要“拦截页识别 + 换源/降级 + 可重试分类”，避免把技术失败
变成用户确认。schema 67→68（`repair_pending` CHECK）与规划详情（批 5）待做。

## 第四轮：schema 68 就地升级与反爬处理（2026-11-11）

- **schema 67 → 68**：`task_operation_results.outcome` 的 CHECK 扩为
  `('success','definite_failure','unknown','repair_pending')`，并新增一次显式的就地升级
  （`prepareDatabaseSchema`：空库安装、当前库校验、67→68 重建操作结果表并保留数据；
  更旧/未知/异常仍拒绝）。真实实例已升级到 68，现有数据保留；修复后服务启动失败的
  操作结果不再报 `CHECK constraint failed`，而是真实的
  `service_start_failed` 原因（重试任务验证）。
- **反爬/验证页**：`web_fetch` 识别百度安全验证、captcha、Cloudflare 等拦截页，返回
  `success:false, blocked:true, retryable:true, reason:anti_bot_or_verification_page`
  并给出“换源/官方站点/标注未核实，不要让用户逐个确认链接”的指引；`web_search` 在
  Bing/百度返回拦截页时报告“搜索被反爬验证页拦截”而不是“网络不可用”；Executor 提示词
  同步该规则，禁止把验证页当证据、禁止 curl 硬抓、禁止让用户确认单条链接。
