# MetaWork Web 用户路径验收测试报告（架构 / Memory / 滚动）

- 报告日期：2026-10-27
- 被测代码：`36233dd1`（fix: preserve input context and stabilize conversation UX），工作区无未提交改动
- 被测形态：本地最新源码构建的 Server（`dist/index.js`，非 `~/.metawork/app/current` 旧发布包），端口 8788
- 测试角色：真实用户（浏览器 Web 端，`admin@163.com` 官方账号，内部永久权益）
- 约束：**未修改任何产品代码**；仅新增本报告、证据截图，以及 `/tmp` 下的临时浏览器驱动脚本
- 状态：**验收未通过**。架构层 17 例中 6 例通过、3 例部分通过、5 例失败、3 例仅测试级证据；Memory 层核心用户路径失败；滚动层 12 景中 9 通过、1 失败、1 未覆盖、1 部分

---

## 0. 结论摘要

| 层面 | 结论 | 关键事实 |
| --- | --- | --- |
| 功能完整性（A1–A17） | 部分通过，存在 2 个 P0 阻断 | 「连续修改」「执行后自然追问」在同会话内被 Kernel 拒绝；真实服务任务的 `runContract.serviceIntent` 生产路径缺失 |
| Memory | 未通过 | 用户偏好消息所在的会话在 25 分钟内从未被 flush（引擎 0 条消息），因此偏好未成为长期记忆；管理列表只显示 1/4 条 |
| 滚动 | 基本通过 | 跟随 / 阅读模式切换、防拉回、防抖动、回到最新、resize、切会话、完成不强跳均通过；Web 刷新不恢复阅读锚点 |
| 仓库基线 | 红灯 | 全量 `vitest`：54 failed / 4216 passed；`tests/kernel/control-kernel.test.ts` 单文件 14 failed；`npm run test:memory-e2e` 20 例全部 skipped |

已执行的门禁：

| 命令 | 结果 |
| --- | --- |
| 9 个聚焦测试（run-contract / service-repair-continuation / managed-local-service / managed-service-handover / kernel-execution-runtime-recovery / task-lifecycle / task-state-regressions / planner-mcp-server / blocked-task-interaction） | ✅ 9 文件 154 用例全通过 |
| `npx vitest run tests/memory tests/planning/planner-memory-tools.test.ts tests/e2e/memory-evidence-delivery.test.ts` | ✅ 16 文件 150 用例全通过 |
| `npm run test:memory-e2e` | ⚠️ 4 文件 20 用例 **全部 skipped**（无有效门禁） |
| `RUN_BROWSER_E2E=1 npx vitest run tests/e2e/conversation-scroll-follow.test.ts` | ✅ 1 用例通过 |
| `npm run lint`（tsc --noEmit） | ✅ 通过 |
| `npm run build`（tsup + schema + pi extension + web） | ✅ 通过 |
| 全量 `npx vitest run` | ❌ 615 文件：12 failed / 579 passed / 24 skipped；4325 用例：54 failed / 4216 passed / 55 skipped |

全量失败文件（与本次验收直接相关的标 ★）：

```text
14  tests/kernel/control-kernel.test.ts                    ★ A13/A14 判定与恢复决策
 9  tests/e2e/declared-file-delivery.test.ts               ★ A12 交付证据
 7  tests/e2e/task-state-recovery-journeys.test.ts         ★ A16 恢复
 6  tests/session/planning-kernel-path.test.ts             ★ Planner→Kernel 路径
 6  tests/e2e/task-result-service-acceptance.test.ts       ★ 服务类任务验收
 4  tests/e2e/publication-delivery-recovery.test.ts
 2  tests/session/blocked-task-user-journey.test.ts
 2  tests/e2e/span-recovery.test.ts
 1  tests/session/clarification-slot-release.test.ts       ★ 与本文缺陷 D2 直接相关
 1  tests/server/task-view-history-association.test.ts
 1  tests/release/version-consistency.test.ts
 1  tests/account/account-startup-recovery-service.test.ts
```

---

## 1. 测试环境与执行方式

- 启动方式：`npm run build` 后用仓库 `dist/index.js server start` 启动，显式指向仓库 Planner/Schema/Attempt 扩展与仓库记忆引擎：

```bash
METAWORK_INSTALL_ROOT=~/.metawork \
ANYFUSION_PI_SOURCE_ROOT=<repo>/planner/AnyFusion-Pi \
METACLAW_PLANNER_COMMAND=<repo>/planner/AnyFusion-Pi/packages/coding-agent/dist/cli.js \
METACLAW_PLANNER_SCHEMA_PATH=<repo>/dist/planning-agent-plan-v9.schema.json \
METACLAW_PI_ATTEMPT_EXTENSION=<repo>/dist/pi-attempt-tools.ts \
METAWORK_MEMORY_ENGINE_ROOT=<repo>/memory/tdai \
node dist/index.js server start
```

- Server：`http://127.0.0.1:8788`，PID 80292，`server-endpoint.json` state=ready；记忆引擎 sidecar 正常（`[memory] enabled (model custom-model-6-9)`）。
- 账号：官方账号登录成功（`admin@163.com`，`internal_perpetual` 权益有效）。
- 测试 Workspace：`/Users/yuanjubian/metawork-acceptance-20261027`（新建，空目录）。
- 数据面：`~/.metawork/accounts/local-default/data/anyfusion.db`（只读查询用于取证）；执行器会话记录 `~/.metawork/accounts/local-default/attempts/<attempt>/home/.pi/agent/sessions/*.jsonl`。
- 驱动方式：无头 Chrome + CDP 脚本（用户视角真实点击 / 输入 / 滚轮 / 窗口缩放 / 刷新），证据截图见 `docs/current/acceptance-evidence-2026-10-27/`。

---

## 2. 第一层：架构功能完整性（A1–A17）

| 编号 | 场景 | 判定 | 实测结论与证据 |
| --- | --- | --- | --- |
| A1 | 新建文件 | ✅ 通过 | 先弹出一次多余澄清「请确认是否可以直接覆盖目标工作区中的原文件」（目录为空），回答「可以，直接创建」后完成。`hello.py` = `print("Hello World")`（21 字节）真实落盘；**无「接受并交付」按钮**；任务 `task_plan_event_proposal_9386edba…1056b94` succeeded，1 Subtask done |
| A2 | 连续修改 | ❌ 失败（P0） | 直接说「把 Hello World 改成 See you later」被 Kernel 打回：`action=request_clarification`，`reason=unqualified context refs: interaction:turn_6d7ee4a1:user`（decision `decision_plan_event_proposal_71f90fb9…75346`）。UI 显示「计划引用了当前任务不可用的上下文（历史会话）。请重新说明需求…」。未产生第二次修改 |
| A3 | 运行程序 | ❌ 失败（同会话）/ ✅ 通过（新会话） | 同会话追问「运行这个程序并告诉我输出」被曲解为「请指定要创建的新文件路径」，并附加「当前请求未通过执行校验」；新开会话明确「运行当前 Workspace 里的 hello.py，并告诉我 stdout、stderr 和退出码」后通过：stdout `Hello World`(12B)、stderr 空、退出码 0，文件未改动 |
| A4 | 测试失败自动修复 | ✅ 通过 | 预置 `assert add(1, 2) == 4`；Executor 自建 venv，首次 pytest 输出 `E assert 3 == 4 … 1 failed`，随后改为 `== 3` 并复跑 `1 passed`，**全程一次 Attempt 内完成，无用户重试**；产物核验通过 |
| A5 | 服务首次启动失败 | ✅ 通过 | 故意 `node servr.js`：会话记录 `Cannot find module '/Users/…/servr.js'`，随后改为 `node server.js` 启动成功；`managed_local_services` = `node-health-service-9345` state=healthy；实时 `curl :9345/health` → 200 `{"status":"ok"}` |
| A6 | 健康检查 503 | ⚠️ 部分通过 | 未把 503 当成功：服务记录 `server503` state=unhealthy，`health_message=服务已启动，健康检查返回 503`；任务最终 failed，文案保留 `service_health_timeout，serviceId=server503，state=failed，进程已退出，健康检查=503`。但收敛耗时约 3.5 分钟且期间用户只看到「执行中」；未显示已尝试轮数（见 D7） |
| A7 | 旧 failed 服务记录 | ✅ 通过（测试级） | `managed-local-service.test.ts`「starts the current specification again after an earlier round recorded failure」「keeps the same service id separate per Workspace」通过；`managed-service-handover.test.ts`「lets a later Task in the same Workspace take over the manifest an earlier Task wrote」通过。Web 手工未单独构造历史 failed 记录 |
| A8 | 规格发生变化 | ✅ 通过（测试级） | `managed-local-service.test.ts`「binds a changed specification only through the authorized update」通过（未授权不得改绑，授权后按新 revision 启动） |
| A9 | 自动修复预算耗尽 | ⚠️ 部分通过 | 503 场景实际产生 1 次 primary + 3 次 `service_repair` continuation（`kernel_dispatch_items`），最终展示真实原因与下一步建议；**未显示「已尝试 3 轮」类信息**，用户无法判断预算已耗尽 |
| A10 | 普通任务无内部门槛 | ⚠️ 部分通过 | A1/A3/A4 完成态均无「接受结果 / 继续未完成任务 / 显式重启」按钮（DOM 校验为空）；但失败态直接暴露 `Task #task_plan_event_proposal_…`、`state=failed`、`serviceId` 等内部标识，并给出「重试未完成部分 / 取消任务」内部动作；成功任务下方仍残留「Task #… 尚未完成：系统正在执行任务。。」（见 D6） |
| A11 | 失败任务自然取代 | ❌ 失败（P0） | 失败后直接重新输入同一目标：「再试一次：这次把 /health 改成返回 200…」。新任务 `task_plan_event_proposal_e5fea319…` 一直停留在 `queued`（13:56:44 起 >4 分钟未执行）；`conversation_task_slots` 中该会话仍为 `state=releasing`，持有失败任务 2d62ff9e…；转录区不显示用户刚输入的消息，仅侧栏显示「排队中」（见 D2） |
| A12 | Executor 假成功 | ✅ 通过（测试级） | 运行 `completion-protocol.test.ts` + `control-kernel.test.ts` + `resource-lease-repo.test.ts` + `in-place-attempt-recovery.test.ts` + `kernel-application-recovery.test.ts`：138/152 通过；其中「holds downstream when a declared artifact handoff has no files」「rejects reportPath that was not produced by this attempt or escapes the workspace」通过，说明 Runtime 独立验收而非信任 Executor 成功 |
| A13 | Graph 被 Kernel 拒绝 | ❌ 失败（P0，真实路径） | 真实拒绝已发生（A2/A3），但：① decision 只带自然语言 `question` + reason 字符串，**没有结构化 issues 数组**；② Planner 未在同一流程内自纠正重提，而是把问题抛回用户；③ `control-kernel.test.ts` 14 例失败，Kernel 判定与测试契约不一致 |
| A14 | 依赖未完成 | ⚠️ 未能确证 | 依赖阻塞逻辑由 `control-kernel.test.ts` 覆盖，该文件 14 例失败（含 partial result / resume / retry wake 决策），因此不能确认「Kernel/Graph 阻塞后继 Subtask」在本次构建上成立 |
| A15 | ResourceLease 冲突 | ✅ 通过（测试级） | `tests/storage/resource-lease-repo.test.ts` 通过（租约互斥与等待语义）；Web 层未构造双任务并发 |
| A16 | 授权前崩溃窗口 | ⚠️ 部分通过 | `in-place-attempt-recovery.test.ts`、`kernel-application-recovery.test.ts` 通过；但 `task-state-recovery-journeys.test.ts`（7 例）与 `publication-delivery-recovery.test.ts`（4 例）失败；本次未在 8788 实例上做真实进程崩溃注入（避免影响在用服务） |
| A17 | 服务 Run Contract | ❌ 失败（P0，重点项） | 用**真实服务任务**验证（不是纯函数）：`executor_attempt_runtime.progress_json.diagnostics.runContract` 含 taskId/generationId/subtaskId/attemptId/workUnitId/workspaceId/accessMode/targetPathCount/acceptanceCount/fileOutputs/configurationRevision/bindingFingerprint，**没有 `serviceIntent` 字段**；同一任务在 `managed_local_services` 中确有 `specification_revision=service_revision_ed64d15df1565486214b7d744d27d0da`。全库 `progress_json like '%serviceIntent%'` = **0 行**。代码位置：`src/execution/execution-runtime.ts:497` 调用 `projectRunContract({ context, executionBinding })`，未传 `serviceIntent`（仅测试传入） |

### A17 详细取证

```jsonc
// executor_attempt_runtime.progress_json.diagnostics.runContract（真实服务任务 attempt）
{
  "taskId": "task_plan_event_proposal_e3540f53…b8b41",
  "generationId": "generation_plan_event_proposal_e3540f53…b8b41",
  "subtaskId": "…_r1_impl-and-start-health-service",
  "attemptId": "attempt_dispatch_event_exec_int_06837QPg4D_…_primary",
  "workUnitId": "executor-executor-da033bd0-…-int_uCogvC1aeV",
  "workspaceId": "workspace_c130837c-3010-49ae-a5da-0da6e85dcb30",
  "accessMode": "write",
  "targetPathCount": 2,
  "acceptanceCount": 5,
  "fileOutputs": ["server.js", ".metawork-service.json"],
  "configurationRevision": "revision-06122914-e96b-473b-b607-9028e5b58032",
  "bindingFingerprint": "d6c95ca0f00bef24bad70ea0d1c916a9c2e03c8be2184095bb363fcf7bd25ab7"
  // 缺少：serviceIntent: { requested: true, serviceId, specificationRevision }
}
```

结论：`projectRunContract()` 支持 `serviceIntent`，但生产调用未接线，Executor/Harness、诊断、trace 都无法看到「本 Attempt 被授权启动哪个服务、哪个 spec revision」。这是 A17 的失败本体。

### A2/A11 根因定位

**A2（P0）**：Planner 在 Work Graph 中使用 `contextRefs: interaction:turn_6d7ee4a1:user`。Kernel 用 `readAuthorizedInteraction()` 按 `interactions.id` 查库：全库 `interactions` 中 `id like 'turn_%'` 的行数 = **0**（实际 id 形如 `int_m-oPcAViV2`）。即 **Planner 把 turn id 当成 interaction id 使用**，触发 `interaction_source_missing` → ref 不可用 → `request_clarification`。同会话的后续追问因此全部不可用。

**A11（P0）**：失败任务没有释放 Conversation 槽位。`conversation_task_slots(conv_2BE_GiHdP7kU)` 长期为 `state=releasing`，`active_task_id` 仍是失败任务；新任务被 admitted 但 `queued`，且用户输入的轮次未进入转录。仓库里 `tests/session/clarification-slot-release.test.ts` 恰好失败，与本现象一致。

---

## 3. 第二层：Memory 验收

### 3.1 配置与生命周期

| 用例 | 判定 | 证据 |
| --- | --- | --- |
| 1. 关闭时不起 sidecar / 不 flush / 不耗模型 | ✅ 测试级 | `tests/memory/memory-configuration.test.ts`、`memory-sidecar-config.test.ts`、`memory-runtime.test.ts` 通过（150 例内）；未在真实 Web 上切换关闭做端到端观察 |
| 2. 引擎不可用时 Planner 继续、必须 degraded | ⚠️ 未能按需复现 | `kill 80334` 后运行时**自动重启 sidecar**（日志 `[memory] memory sidecar restart #1`），`/api/memory/status` 始终 `engineReady:true`、无 degraded 字段值。说明监督机制会掩盖「引擎停止」这一验收前提，该场景需故障注入配置而非杀进程 |
| 3. enabled→disabled 后不再召回 | ✅ 部分（API 级） | `POST /api/memory/assets/enabled {enabled:false}` → 返回 `enabled:false`，`memory_bindings.enabled=0`；随后恢复为 1。Eligibility 代码要求 `enabled=1` 才允许 memory ref，逻辑成立；未做 disable 后的真实召回对照 |
| 4. 更新 / 删除 / 禁用后管理列表同步 | ❌ 失败（P1） | 管理界面「记忆资产」**只显示 1 条**，而 `/api/memory/assets?limit=50` 返回 4 条（`total=4`）。原因：`/api/memory/assets` 无参时 `boundedQueryInt(null,50,1,200)` 里 `Number(null)===0` 是安全整数，被 `Math.max(1,0)` 夹成 **limit=1**（`src/management/server.ts:2131`），Web 客户端 `/api/memory/assets` 不传 limit（`web/src/api/memory.ts:97`） |
| 5. 跨账户不可见 | ✅ 测试级 | `memory-scope.test.ts`、`memory-context-boundary.test.ts`、`memory-bindings-repo.test.ts` 通过；本地只有 `local-default` 一个账户，未做真实双账户对照 |

### 3.2 写入与持久化

| 用例 | 判定 | 证据 |
| --- | --- | --- |
| 1. 输入「以后报告默认使用中文表格…」 | ✅ 已输入 | 新会话 conv_zZeB6Omesrh5 第 1 轮；Planner 把它当成落盘任务，产出 `report-style-preferences.md`（也算一种持久化，但**不是长期记忆**） |
| 2. Conversation flush 后引擎提取出记忆 | ❌ 失败（P1） | 该会话最后一轮 completedAt=13:47:26，等待 >25 分钟（idle 阈值 10 分钟）：`memory_flush_state` **无该会话行**；引擎侧 `data/memory/conversations/2026-10-27.jsonl` 中该 sessionKey **0 条消息**；`memory_bindings` 计数保持 4 未增。同账号其它会话（conv_b-B9xmv8aWx9、conv_DWdFVpMVAa-m、conv_Qu2BojW9WHCH）同一时间窗均正常推进 cursor 并写入引擎 → 非全局故障，是该会话/该类型轮次未进入沉淀 |
| 3. 重复 flush 不产生重复 | ✅ 测试级 | `memory-service.test.ts`（幂等/cursor 语义）通过 |
| 4. flush cursor 持久化 | ✅ 观察 + 测试级 | `memory_flush_state` 中 `last_sequence` 随 tick 单调前进（如 conv_b-B9xmv8aWx9 135→169），重启 Server 后未回退（本次重启后该表继续可用） |
| 5. 取消轮次不入库 | ✅ 测试级 | `memory-sanitizer.test.ts` + `memory-service.test.ts` 的「completed-only / skip ineligible」用例通过 |
| 6. 摘要 / 版本 / digest 稳定 | ✅ 观察 | `memory_bindings.content_digest` 在 enable/disable 后不变（如 mem_488b… 的 digest `17ce3a57…` 保持）；版本字段未见异常 |

### 3.3 Planner 使用

| 用例 | 判定 | 证据 |
| --- | --- | --- |
| 1. 新会话「帮我做一份本周销售周报」 | ✅ 已执行 | 会话 conv_96nJNc3JNhzq，产出 `weekly-sales.md`（中文表格 / 人民币 / YYYY-MM-DD 格式被满足） |
| 2. Planner 调用 `search_memory` / `get_planning_context` | ⚠️ 部分 | 该轮 `planner_tool_calls` 实际为 `get_planning_context → get_runtime_state → ls → read → read → get_current_session_context → submit_planning_proposal`，**未调用 `search_memory`** |
| 3. 只返回有界 preview + memoryId | ⚠️ 未能在真实链路验证 | 召回层确有候选：`memory_recall_candidates` 记录 `mem_48ebf273…`(score 0.467)、`mem_34835bb8…`(0.509)，但 Graph 中未出现 `kind: memory` 引用，未进入 evidence |
| 4. Work Graph 出现 `{kind:"memory", memoryId}` | ❌ 未出现 | 该轮 Kernel decision 的 graph 中无 memory contextRef |
| 5. Planner 不得伪造正文 | ✅ 测试级 | `planner-memory-tools.test.ts`、`memory-context-ref-eligibility.test.ts` 通过 |
| 6. 引擎不可用须报「引擎不可用」而非「无相关记忆」 | ⚠️ 未验证 | 见 3.1 第 2 条：无法让真实实例进入 degraded |

说明：`weekly-sales.md` 的格式确实符合偏好，但**不是记忆召回的结果**——同 Workspace 里已有上一轮写入的 `report-style-preferences.md`，Executor 读到了这个文件。这正是「记忆没沉淀、靠工作区文件兜底」的表现，不能算 Memory 链路通过。

### 3.4 Executor 证据交付

| 用例 | 判定 | 证据 |
| --- | --- | --- |
| 1. 授权 memoryId → materialize 成 `long_term_memory` evidence | ✅ 测试级 | `tests/e2e/memory-evidence-delivery.test.ts`、`memory-evidence-service.test.ts` 通过（在 150 例内） |
| 2. 同一 memoryId 多 Subtask 只物化一次 | ✅ 测试级 | 同上（去重用例通过） |
| 3. 禁用后已授权未执行任务 fail closed | ✅ 测试级 | `memory-context-ref-eligibility.test.ts` / `memory-evidence-service.test.ts` 通过；且真实 `enabled=0` 会同时体现在 bindings 与 eligibility |
| 4. 跨账户 memoryId 必须拒绝 | ✅ 测试级 | `memory-context-boundary.test.ts` 通过 |
| 5. 不存在的 memoryId 明确诊断 | ✅ 测试级 | `memory-evidence-service.test.ts` 通过 |
| 6. 超限截断并标 truncated | ✅ 测试级 | 同上 |
| 7. 正文只走 evidence channel | ✅ 测试级 | `memory-module-boundary.test.ts`、`memory-evidence-delivery.test.ts` 通过 |

### 3.5 真实 Web 用户路径（第 5 组）

| 步骤 | 判定 | 实测 |
| --- | --- | --- |
| 1. 输入偏好指令 | ✅ | 「以后所有报告默认使用中文表格，金额使用人民币，日期使用 YYYY-MM-DD，请记住这个偏好。」已提交并完成一轮 |
| 2. 等待 flush | ❌ | 25 分钟后仍无 flush_state 行、引擎无该会话消息 |
| 3. 新会话「帮我做一份本周销售周报」 | ✅ | 已执行并落盘 `weekly-sales.md` |
| 4. Planner 是否召回该偏好 | ❌ | 未召回（因为偏好从未成为记忆）；无 memory contextRef |
| 5. trace/上下文中出现 long-term memory evidence | ❌ | 无 `long_term_memory` evidence |
| 6. 管理界面禁用该记忆 | ⚠️ 无法针对该偏好执行 | 该偏好无 memory 资产；对既有资产 mem_488b… 的禁用/恢复通过 API 验证成功、UI 状态同步 |
| 7. 再次生成销售周报 | — | 跳过（无可禁用对象），改由 3.3/3.4 测试级覆盖 fail-closed |
| 8. 预期不再使用记忆 | — | 同上 |
| 9. 停止 Memory Engine 后重复查询 | ⚠️ 未达成 | sidecar 被自动重启（restart #1），status 保持 engineReady=true |
| 10. 界面与 Planner 显示 degraded | ❌ 未观察到 | 无 degraded 投影可观察；这既说明监督机制健壮，也说明「引擎异常」在验收中不可构造 |

---

## 4. 第三层：滚动验收（12 场景）

采集方式：真实 8788 Web 页面，`.workspace-canvas` 为唯一滚动容器；以 250–500ms 采样 `scrollTop` / 距底距离（gap）/「回到最新」按钮可见性。测试轮次为长流式任务（销售周报 5 小节，流式期间容器高度 3269→4431px 增长）。

| # | 场景 | 判定 | 实测数据 |
| --- | --- | --- | --- |
| 1 | 停在底部，流式增长 | ✅ | t=0–28s 全部采样 `gap=0`（内容 3094→3269px 增长期间保持在底部） |
| 2 | 上滚 200px 后继续流式 | ✅ | 滚轮 -200 后 `scrollTop 2924→2724`，随后 21 秒采样**恒为 2724**，内容同时从 3269px 增至 3538px（gap 235→0…1092 变化），未被拉回 |
| 3 | 继续上滚不回弹/抖动 | ✅ | 连续采样 `scrollTop` 完全一致（无 ±1 抖动），采样间隔 500ms 共 ~40 帧 |
| 4 | 距底 48px 内自动恢复 | ✅ | 滚回底部后 `gap=0`、「回到最新」按钮消失。实现阈值 `FOLLOW_LATEST_THRESHOLD=64`（`ObservedConversationView.tsx:25`），覆盖验收要求的 48px（见 D10 的文档/实现口径差异） |
| 5 | 点击「回到最新」 | ✅ | 点击后 `scrollTop=3770`（= max），`gap=0`，按钮立即消失 |
| 6 | Turn 高度因 Markdown/附件变大 | ✅ | 自动化回归 `tests/e2e/conversation-scroll-follow.test.ts`：阅读模式下 `growStream()` 增高后 `scrollTop` 偏移 ≤64px；真实页面观察同结论（阅读时内容增长 857px 而 scrollTop 不变） |
| 7 | 加载更早历史不跳动 | ⚠️ 未覆盖 | 当前会话轮次数不足以出现「加载更早的对话」游标；代码层面 `positions/total` 更新在阅读模式按 `turnId+offset` 重锚（`ObservedConversationView.tsx:176-215`），但缺少真实用例 |
| 8 | 窗口尺寸变化不误判为跟随 | ✅ | 窗口 1440×913 → 1000×673 后：锚点 Turn `turnTop` 由 -276 保持 -276，「回到最新」仍可见（未被误判为 FOLLOW） |
| 9 | 刷新后恢复历史锚点 | ❌ 失败（P2） | 在会话 A 阅读到 `gap=1464` 处刷新：恢复到**另一个会话**（turn_avX6TD9z5ph2）且 `gap=954`，非底部也非原锚点。根因：Web 端锚点只经 `desktopBridge()` 持久化（`ObservedConversationView.tsx:142`），`localStorage` 只有 `metawork.theme`，刷新即丢失 |
| 10 | 切换会话不继承锁定 | ✅ | 从阅读态切到另一会话：`gap=0`、按钮隐藏；切回原会话：`gap=747`、`turnTop=-276`，锚点精确恢复 |
| 11 | 任务完成但用户在上方阅读 | ✅ | 阅读位置 `gap=1093` 时任务完成（`running=false`），采样继续恒为 2724，无强制跳转 |
| 12 | 任务完成且一直跟随 | ✅ | A1 轮次与销售周报轮次：完成瞬间 `gap=0`，停在最终结果底部 |

已实现的机制（与验收建议的实现顺序一致，可作为通过依据）：`FOLLOW_LATEST` 状态（`followLatest` ref + `followingLatest` state）、只在跟随态写 `scrollTop`、`programmaticScroll` 抑制窗口（250ms/700ms）、`wheel/keydown` 立即脱离跟随、`.back-to-latest` 按钮、`overflowAnchor:none`。

---

## 5. 缺陷清单

### D1（P0）同会话自然追问被 Kernel 拒绝：interaction id 命名空间不匹配
- 现象：A2/A3 同会话追问全部失败，用户被迫开新会话并重复完整说明。
- 证据：decision `decision_plan_event_proposal_71f90fb9…75346`，`reason=unqualified context refs: interaction:turn_6d7ee4a1:user`；`interactions` 表 `id like 'turn_%'` 计数为 0（真实 id 形如 `int_m-oPcAViV2`）。
- 疑似位置：Planner 生成 contextRef 时用了 turn id（或错误编造）；`src/work-graph/context-ref-eligibility.ts:30-48`（`readAuthorizedInteraction` 仅按 `interactions.id` 查）；`src/kernel/control-kernel.ts:1137-1160`。
- 影响：最常见的多轮编辑场景不可用；每次追问都被计费。

### D2（P0）失败任务不释放会话槽位，新请求永久排队且不可见
- 现象：A11 重试任务 `task_plan_event_proposal_e5fea319…` 自 13:56:44 起 `queued` 超过 4 分钟未执行；`conversation_task_slots` 该会话 `state=releasing`，`active_task_id` 仍指向失败任务；转录区不显示用户刚输入的消息，仅侧栏显示「排队中」。
- 证据：DB 查询 + 截图 `16-a11-queued.png`；仓库 `tests/session/clarification-slot-release.test.ts` 失败佐证。
- 影响：失败后无法自然继续，与 A11「自然取代」目标相反；用户看不到自己已提交的请求。

### D3（P0）Run Contract 的 serviceIntent 在生产调用中缺失（A17）
- 证据：真实服务任务 `runContract` 无 `serviceIntent`；全库 0 行含 `serviceIntent`；`src/execution/execution-runtime.ts:497` 未传参。
- 影响：把「已授权的服务意图」从执行输入与诊断中抹掉，Executor/Harness 无法据 contract 判断服务边界；服务类问题只能靠运行时旁路状态，正是本次重构要消除的重复状态机。

### D4（P1）偏好会话从未 flush，长期记忆静默丢失
- 证据：conv_zZeB6Omesrh5（completed、ai_turn、sequence 3）是合法 pending candidate，但 25 分钟无 `memory_flush_state` 行、引擎 0 条消息；同账号其他会话正常。
- 影响：Memory 第 2 组与第 5 组核心路径失败；失败无任何用户可见信号。
- 建议：为 per-conversation flush 失败增加可观测日志与 health 计数，并排查 `flushConversation` 提前返回分支（`src/memory/memory-service.ts:110-140`）与 `completedTurnsAfter` 的返回。

### D5（P1）记忆管理列表默认只返回 1 条
- 证据：`/api/memory/assets` → items=1/total=4；`?limit=50` → items=4；`boundedQueryInt` 中 `Number(null)=0` 被夹到 min=1（`src/management/server.ts:2131`）；Web 端不传 limit（`web/src/api/memory.ts:97`）。截图 `15-memory-section.png`。
- 影响：用户只能看到 1 条记忆，无法管理其余记忆（与第 1 组用例 4 冲突）。

### D6（P1）成功任务残留「尚未完成」内部文案
- 证据：A5 任务 `succeeded`、服务 healthy，但转录中仍有「Task #task_plan_event_proposal_e3540f53… 尚未完成：系统正在执行任务。。」（含内部 Task ID 与重复句号）。
- 疑似位置：`src/execution/kernel-execution-runtime.ts:5303` 在 `completed=false` 分支写入 `finishExecution`，随后任务转为成功但该行不回滚。
- 影响：用户看到自相矛盾的完成状态（A10）。

### D7（P1）服务健康失败的收敛时间与预算可见性
- 证据：503 场景 22s 出现「已阻塞：Local service did not become healthy」，约 3.5 分钟后才失败收尾，期间只有「执行中」；最终文案无「已尝试 3 轮/预算耗尽」信息（`kernel_dispatch_items` 有 1 primary + 3 continuation）。
- 影响：A6/A9 的用户可解释性不足。

### D8（P1）只读/新建任务被要求确认「覆盖原文件」
- 证据：空目录创建 hello.py、以及「运行 hello.py」都弹出「请确认是否可以直接覆盖目标工作区中的原文件」，并伴随「当前请求未通过执行校验，请调整请求后重试。」
- 影响：普通任务出现多余门槛，与 A10「无内部门槛」冲突；且「执行校验」措辞泄露内部机制。

### D9（P2）Web 刷新不恢复阅读锚点
- 证据：场景 9；`desktopBridge()` 才持久化锚点，浏览器 `localStorage` 仅 `metawork.theme`。
- 影响：长报告刷新后阅读位置丢失，且恢复到非预期会话位置。

### D10（P2）滚动阈值口径不一致
- 实现 `FOLLOW_LATEST_THRESHOLD=64`，验收文档写 48px；行为满足（48<64），但建议统一文档与常量，避免后续回归误判。

### D11（P1）仓库测试基线红灯，且直接相关用例在失败集内
- 证据：全量 54 failed / 4216 passed；`control-kernel`(14)、`declared-file-delivery`(9)、`task-state-recovery-journeys`(7)、`planning-kernel-path`(6)、`task-result-service-acceptance`(6)、`clarification-slot-release`(1) 等。
- 影响：A12–A16 只能给出「部分」结论；D1/D2 这类问题在红灯基线下不会被门禁拦住。

### D12（P1）`npm run test:memory-e2e` 目前不构成门禁
- 证据：4 文件 20 用例全部 skipped（需要额外 env 才运行）。
- 影响：发布前「记忆 e2e」绿灯是假信号。

---

## 6. 未覆盖 / 阻塞项

1. A16 真实崩溃注入未在 8788 实例上执行（避免打断在用服务）；建议在独立临时账号/端口做。
2. Memory degraded 路径无法通过停止 sidecar 复现（自动重启），需要故障注入开关或把 sidecar 指向不可用二进制。
3. 滚动场景 7（加载更早历史）缺前提数据。
4. A7/A8/A15 仅有测试级证据，未构造真实服务并发/规格变更的真实 Web 用例。
5. 双账户记忆隔离未做真实对照（本地只有 `local-default`）。

---

## 7. 建议下一步（按优先级）

1. **修 D1**：统一 Planner contextRef 的交互标识来源（使用 `interactions.id`，或在 Kernel 侧支持 turn→interaction 解析），并给 rejection 增加结构化 `issues[]`；补一条「同会话追问修改同一文件」的 e2e。
2. **修 D2**：失败/澄清终态的会话槽位必须释放或转移（对齐 `clarification-slot-release` 测试），排队请求要在转录里可见。
3. **修 D3**：在 `execution-runtime.ts` 组装 `serviceIntent`（source: managed service manifest / service identity + specificationRevision），并补一条真实服务任务的断言测试（`diagnostics.runContract.serviceIntent.requested === true`）。
4. **修 D4/D5**：定位该会话 flush 静默失败；修正 `boundedQueryInt` 的 `null` 处理（`raw === null` 时用 fallback），管理列表默认 `limit=50`。
5. **修 D6/D8/D9**：清理「尚未完成」残留行；把「覆盖原文件」澄清限制到真正写入已存在文件的计划；Web 端锚点用 `sessionStorage/localStorage` 持久化。
6. **清基线**：先让 `tests/kernel/control-kernel.test.ts`、`clarification-slot-release`、`declared-file-delivery`、`task-state-recovery-journeys` 恢复绿灯，再把 `test:memory-e2e` 的 skip 条件改为显式 opt-in 并在 CI 中打开。

---

## 8. 附录

- 证据目录：`docs/current/acceptance-evidence-2026-10-27/`
  - `08-a1-done.png`（A1 完成、无接受按钮）
  - `09-a2-rejected.png`（A2 被 Kernel 拒绝）
  - `12-a5-done.png`（A5 服务自愈 + 残留「尚未完成」文案）
  - `15-memory-section.png`（记忆资产只显示 1 条）
  - `16-a11-queued.png`（A11 排队中、用户消息不可见）
  - `raw-notes.md`（测试过程原始记录）
- 关键查询（只读）：

```sql
-- A2
select action, reason from kernel_decisions
 where id = 'decision_plan_event_proposal_71f90fb94ccb93a4023a1839cf1a9bb389bf6548a92289148dda088246f75346';
select count(*) from interactions where id like 'turn_%';            -- 0
-- A17
select json_extract(progress_json,'$.diagnostics.runContract')
  from executor_attempt_runtime
 where attempt_id like '%e3540f53%';
select count(*) from executor_attempt_runtime where progress_json like '%serviceIntent%';  -- 0
-- A11
select conversation_id, active_task_id, state from conversation_task_slots
 where conversation_id = 'conv_2BE_GiHdP7kU';                          -- releasing
select substr(id,1,40), status from tasks order by created_at desc limit 3;  -- queued
-- Memory
select * from memory_flush_state where conversation_id = 'conv_zZeB6Omesrh5';  -- 空
select count(*) from memory_bindings;                                  -- 4（未新增）
```

- 测试后状态：Server 仍在 8788 运行（本地最新代码）；测试 Workspace 保留（`hello.py`、`calculator.py`、`test_calculator.py`、`server.js`、`.metawork-service.json`、`server503.js`、`report-style-preferences.md`、`weekly-report.md`、`weekly-sales.md`）；被禁用验证的记忆资产 `mem_488b5fdf…` 已恢复 `enabled=1`；无产品代码变更。
