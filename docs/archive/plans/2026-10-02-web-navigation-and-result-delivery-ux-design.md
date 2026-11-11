# Web 会话导航与结果交付体验改进方案

- 方案日期：2026-10-02
- 状态：已实施
- 实施日期：2026-10-02
- 完成日期：2026-10-02
- 范围：会话切换历史加载、执行完成后的结果交付与答案展示
- 相关契约：`CONTEXT.md`、ADR-0031、ADR-0032、ADR-0035

## 1. 决策结论

本方案采用两项配套设计：

1. 会话历史读取与实时会话激活解耦。点击会话后先展示历史，Gateway attach 在后台完成。
2. 结果采用渐进式交付。执行完成、artifact 可见和最终答案可用是三个可以先后发生的事实；界面在答案交付完成前显示“结果整理中”，不会把答案为空的 Turn 当作最终完成。

方案二优于让 Gateway 同步等待全部结果。同步等待会把长报告、文件生成和后台任务的交付时间直接变成用户等待时间；如果结果交付失败，任务还会长时间停留在运行中。渐进式交付可以立即展示已经确认的事实，并保留结果校验和持久化的可靠性。

## 2. 问题一：切换会话时历史记录出现等待

### 2.1 当前时序

Web 点击一个非当前 active 会话时，`web/src/App.tsx` 的 `handleSelectSession()` 会先清空 `selectedRecord`，随后等待 `handleActivation()` 完成。`handleActivation()` 依次执行：

```text
POST /api/conversations/:id/attach
  -> WebGatewaySessionRuntime.activateSession()
  -> attachOnce()
  -> attach Gateway client
  -> 读取会话记录
  -> 建立订阅
  -> 完整 history/replay
  -> consume 所有历史事件
  -> active_session_changed
GET /api/conversations/:id
显示历史
```

`src/management/web-gateway-session-runtime.ts` 的 `attachOnce()` 在返回前完成完整回放，因此历史页面被实时连接和历史事件消费阻塞。当前 `readSession()` 还要求目标会话已经是 active，会话浏览无法与会话激活并行。

### 2.2 目标行为

- 点击会话后立即显示该会话最近的历史页。
- 实时 attach 在后台完成。
- attach 未完成前，发送按钮保持禁用，并显示“正在连接实时会话”。
- attach 完成后才切换发送目标和实时事件订阅。
- 旧会话的迟到请求和事件不能覆盖当前浏览会话。
- 重复切换到已经读取过的会话时，优先显示前端缓存。

### 2.3 设计方案

#### A. 增加独立的历史读取路径

新增一个经过 Account、Workspace 和 Principal 授权的只读历史接口。它只读取目标 Conversation 的分页历史，不要求目标 Conversation 已经 active。现有 `GET /api/conversations/:id` 可以保留为 active 会话兼容路径，但导航应使用新的 browse/history 路径。

历史接口返回：

```text
session
turns
historyCursor
projectionVersion
```

如果历史读取与 attach 可以共享同一份初始页，则 attach 完成后复用该页，避免重复读取和重复 enrichment。

#### B. 前端拆分浏览状态与激活状态

前端分别维护：

```text
browsedConversationId   当前正在查看的会话
activeConversationId    当前可以接收消息的会话
activationState         idle | attaching | active | blocked
```

点击会话时按以下顺序处理：

1. 增加 navigation generation。
2. 从内存缓存或历史接口读取并显示目标会话。
3. 在后台发起 attach。
4. attach 成功后更新 active 会话和发送目标。
5. 只有 generation、Workspace 和会话 ID 都匹配时，才应用响应。

历史内容不应因为等待 attach 而被清空。切换到另一个会话时，旧会话的实时事件必须按 active connection 和会话 ID 双重过滤。

#### C. 分页与缓存

首次切换只加载最近一页；较旧记录通过现有 cursor 分页读取。前端缓存以 `workspaceId + conversationId + projectionVersion` 为键，目录发生变化时失效对应缓存。缓存只用于快速首屏，Server 返回的数据仍是权威来源。

## 3. 问题二：任务完成后答案晚于文件和状态出现

### 3.1 当前事件链

Gateway 对完整结果使用 `result_delivery_available`、`result_chunk`、`result_completed` 交付。对于结果型 Turn，`final_answer` 故意携带空 `lines`，正文通过结果流传输。相关路径是：

- `src/gateway/conversation-gateway-runtime.ts`：结果流完成后发布 `final_answer`。
- `src/gateway/background-result-delivery.ts`：后台结果先读取和持久化，再发布结果事件。
- `src/management/web-gateway-session-runtime.ts`：组装并校验结果流，同时异步持久化终端 Turn。
- `web/src/App.tsx`：execution、artifact、result 和 final answer 当前由多个 handler 分别更新 `liveTurn`。

后台任务尤其容易出现以下顺序：

```text
execution timeline -> completed
artifact           -> 文件可见
result delivery    -> 仍在读取/组装/持久化
result_completed   -> 完整答案可用
final_answer       -> 终端答案事件
```

因此当前页面可能先显示“任务已完成、文件已生成”，答案稍后才出现。切换会话后重新读取持久化 Turn，所以答案会显示出来；这说明主要是实时投影时序问题，而不是结果永久丢失。

### 3.2 空 `final_answer` 的语义

`final_answer` 的 `lines: []` 对结果流来说是合法的协议标记，表示正文在 `result_*` 事件中。它不表示“答案为空”。前端如果直接执行 `lines.join('\n')`，就可能清空已经收到的答案，或在结果尚未组装完成时显示空白。

### 3.3 目标状态模型

Turn 不再只用一个状态表达执行和交付两个事实，增加结果交付状态：

```text
executionStatus: running | completed | failed | blocked | cancelled
deliveryStatus:  none | streaming | verifying | ready | failed
```

用户可见状态建议为：

| 执行状态 | 交付状态 | 页面展示 |
| --- | --- | --- |
| running | none/streaming | 执行中 |
| completed | streaming/verifying | 执行已完成，正在整理结果 |
| completed | ready | 已完成，并显示最终答案 |
| failed/blocked/cancelled | 任意 | 对应终态，并保留已交付内容 |

执行时间线完成后，底层 Task 可以释放执行资源；Turn 在答案完成前进入“结果交付中”，不能被当作已经具备最终答案的完整终态。

### 3.4 后端方案

1. `result_delivery_available` 到达时，将 Turn 标记为 `streaming`，不改变执行状态。
2. `result_chunk` 只追加到按 `turnId + resultId` 管理的结果缓冲区。
3. `result_completed` 完成字节数和哈希校验后，标记 `verifying -> ready`，并生成完整答案。
4. 后台结果先持久化，再发布 canonical Turn 更新；更新中包含执行状态、artifact、交付状态和最终答案引用。
5. 终端事件必须按 Turn 串行化。迟到的旧结果不能覆盖新 Turn，重复事件必须幂等。
6. 如果持久化失败，明确发送 `deliveryStatus: failed` 和可重试信息，不能静默显示“已完成”。
7. 单个事件仍遵守 64 KiB 限制。大答案继续使用分块结果流，canonical snapshot 只携带结果引用、哈希和交付状态。

### 3.5 前端方案

将当前多个 handler 收敛为一个按 `turnId`、`taskId` 和结果身份合并的 reducer/状态合并器，统一处理：

```text
execution
artifact
result_delivery_available
result_chunk
result_completed
final_answer
terminal_error
```

合并规则：

- execution 完成只更新 `executionStatus`，不能在答案尚未 ready 时清除或伪造最终答案。
- artifact 只追加或幂等合并，不改变交付状态。
- 空 `final_answer.lines` 只作为终端事件标记，不能覆盖已有答案。
- 非空 `final_answer.lines` 才更新 inline 答案。
- `result_completed` 校验成功后，以组装出的正文作为答案权威来源。
- 迟到进度可以丰富已终态 Turn，但不能把终态重新打开为 running。
- 当前会话仍显示该 Turn 时，持久化完成后的 canonical snapshot 必须立即更新页面，不要求用户切换会话或手动刷新。

## 4. 实施顺序

### 阶段一：导航解耦

1. 定义历史 browse API 和授权规则。
2. 把历史读取与 attach 从前端导航流程中拆开。
3. 增加 generation、取消/忽略旧请求和会话缓存。
4. 增加 attach 状态提示及发送门禁。

### 阶段二：结果交付状态

1. 扩展 Web Session runtime event 和 Turn projection 的交付状态。
2. 后端统一结果组装、持久化和 canonical snapshot 发布顺序。
3. 前端引入 Turn reducer，替换独立字段覆盖逻辑。
4. 保留旧客户端对 `final_answer` 的兼容解释，但禁止空 lines 清空答案。

### 阶段三：回归与真实验收

1. 运行 focused unit/integration tests。
2. 使用长历史、多次快速切换和运行中会话测试导航。
3. 使用前台短回复、后台文件任务、长结果和断线重连测试结果交付。
4. 通过真实 Web 任务确认：任务执行完成后，答案无需等待额外刷新或切换会话即可出现。

## 5. 回归测试要求

### 导航

- 历史读取延迟时，页面先显示历史，attach 后才启用发送。
- 连续快速切换 A -> B -> C，A/B 的迟到响应不能覆盖 C。
- attach 回放较大历史时，首屏不等待完整 replay。
- 已缓存会话重复切换时立即显示缓存，并在版本变化后刷新。
- 运行中的 Turn 在切换和切回后仍能正确恢复。

### 结果交付

- execution completed 早于 `result_completed` 时，显示“结果整理中”，不显示空的最终完成。
- artifact 早于最终答案到达时，文件立即可见，答案随后流式显示。
- `final_answer.lines = []` 不清空已有答案。
- `result_completed` 晚于 `final_answer` 时，最终正文仍能补齐。
- 后台结果持久化完成后，当前页面立即收到 canonical snapshot。
- 结果分块超过 64 KiB 总量时仍能完整组装，单事件不超过限制。
- WebSocket 重连、重复事件和切换会话后重新 attach 都不会丢失或重复答案。

实施结果：

- 已新增非 active 会话的 Workspace 授权历史接口：`GET /api/conversations/:id/history`。
- 前端先展示历史缓存或首屏历史，再后台 attach；增加 navigation generation、会话缓存和 attach 发送门禁。
- 修复导航请求竞态：attach 启动会递增导航代次，历史读取现在在该代次建立后发起，避免历史首屏被自身 attach 请求误判为过期。
- execution、artifact、结果交付和 final answer 已统一进入 `mergeLiveTurnEvent()`；空 `final_answer.lines` 不覆盖已有答案。
- Turn 增加独立 `deliveryStatus`。结果流依次进入 `streaming`、`verifying`、`ready`，校验失败进入 `failed` 并发出明确 `delivery_status` 事件。
- 后台结果持久化后发送 `turn_updated` canonical Turn 更新，当前会话无需切换或刷新即可显示最终答案。
- 结果正文仍使用分块事件传输；未把大答案塞入单个事件，保留单事件 64 KiB 边界。

## 6. 验收标准

方案完成后应满足：

1. 切换会话时，历史首屏不再等待完整 Gateway attach/replay。
2. 用户能区分“执行已完成”和“最终答案仍在交付”。
3. 任务生成文件后，答案会在同一会话中自动出现，无需等待额外刷新或切换会话。
4. 结果交付失败会显示明确失败状态和重试入口。
5. 历史读取、实时事件和结果流都遵守 Workspace、Turn/Task 绑定、事件去重和 64 KiB 单事件限制。

## 7. 验证记录

- `npm run lint` 通过。
- `npm run build` 通过，包含 Web Vite 构建。
- `npx vitest run tests/management/web-gateway-session-runtime.test.ts`：66 tests passed。
- `npx vitest run tests/web/conversation-live-turn.test.ts tests/web/startup-navigation.test.ts tests/web/workspace-shell.test.ts`：45 tests passed。
- `npx vitest run tests/gateway/background-result-delivery.test.ts`：5 tests passed。
- `git diff --check` 通过。
- 全量 `npm test -- --run` 在当前受限环境未完成：需要监听本机 TCP/Unix socket 的测试收到 `EPERM`，并连带造成依赖真实 Executor/Planner socket 的用例失败；该环境限制与本次 Web 投影改动无关。

本次未提交 GitHub，也未重建 Release；此前 Planner 路径修复仍保留在同一工作区。
