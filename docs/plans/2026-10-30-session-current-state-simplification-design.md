# 会话当前状态简化设计：采用 DeepSeek Harness 会话模型

- **日期：** 2026-10-30
- **状态：** 已实施并通过本地验收（2026-10-30）
- **范围：** Web 会话列表、会话切换、消息发送、后台运行状态、删除与重连
- **参考：** DeepSeek Harness `@deepseek-ai/dsh-session`、dsh-TUI 0.17.0 会话管理器、MetaWork ADR-0031、ADR-0043

## 1. 目标

MetaWork 当前同时维护服务端 `activeSessionId`、前端 `browsedSessionId` 和界面 `selectedSessionId`。这些状态的职责重叠，导致用户切换会话后出现两个绿色选中行，并且最后创建的会话会因为仍被服务端标记为 active 而无法删除。

本方案采用 DeepSeek Harness 的会话模型，收敛为三个清晰概念：

1. **当前会话（current session）**：当前客户端正在打开、查看、发送消息和执行会话操作的会话。
2. **会话运行状态（session activity）**：每个会话自己拥有的空闲、排队、规划、执行、等待或阻塞状态。
3. **界面焦点（UI focus）**：浏览器当前获得键盘/鼠标焦点的控件，只属于界面，不属于会话领域状态。

方案明确取消连接级默认目标。Server、WebSocket 连接和客户端都不再维护一个“默认发送会话”或“全局活动会话”作为隐式路由目标。

## 2. DeepSeek Harness 的可借鉴模型

公开的 `@deepseek-ai/dsh-session` 将每个 Session 作为独立的事件日志和交互历史。SessionStore 负责创建、列出、恢复和 fork Session，Session 自己保存消息、Turn 和工具事件。该模型没有一个表示“最后创建或最后运行会话”的全局执行所有者。

dsh-TUI 的会话管理器仍区分两个界面事实：

- `current`：当前终端已经打开的会话；
- `focused`：会话列表中键盘光标所在的行。

这两个状态的职责不同，但都不代表“系统唯一执行会话”。切换会话只是停放当前会话，原会话的运行继续在后台进行。会话行单独展示当前会话、焦点和运行状态，删除判断也依据会话是否仍被本终端占用，而不是依据最近创建时间。

MetaWork 借鉴其核心原则：会话身份是消息和操作的明确目标，运行状态属于会话本身，客户端焦点不改变运行事实。

## 3. 当前问题与根因

当前流程如下：

```text
创建会话 B
  -> WebGatewayClientSession._activeSessionId = B

点击会话 A
  -> Web 控制器只更新 browsedSessionId = A
  -> _activeSessionId 仍然是 B

SessionSidebar
  -> B: data-active="true"
  -> A: data-selected="true"
```

两种属性使用相同或近似的绿色背景和边框，因此用户看到两个会话同时被选中。

删除路径还使用以下判断：

```ts
if (sessionId === this._activeSessionId) return 'active';
```

这会把“当前连接最后激活过的会话”错误当成“仍有任务运行的会话”。即使 B 已完成，B 仍可能因为 `_activeSessionId` 没有变化而无法删除。

该问题不是用户操作错误，也不是单纯 CSS 问题，而是会话目标、执行状态和连接状态混用造成的模型错误。

## 4. 目标状态模型

### 4.1 客户端唯一当前会话

每个 Web 客户端只保留一个 `currentSessionId`。它表示用户当前正在操作的会话：

- 会话内容读取目标；
- 消息发送目标；
- 当前会话的取消/审批目标；
- 会话编辑草稿的归属；
- 侧边栏唯一的“当前”视觉标识。

点击会话 A 时，`currentSessionId` 立即变为 A。点击不会修改 B 的运行状态，也不会停止 B 的任务。

### 4.2 会话运行状态属于会话本身

运行状态按会话 ID 投影：

```text
session.activity[A] = idle | queued | planning | executing | waiting | blocked
session.activity[B] = idle | queued | planning | executing | waiting | blocked
```

不存在跨会话的 `activeSessionId` 作为执行权威。若 B 正在执行而用户查看 A，B 仍显示“执行中”状态点或文本，A 显示“当前”。这两个标识可以同时存在于不同会话，但不会再使用相同的选中样式。

### 4.3 界面焦点不进入领域状态

浏览器焦点、键盘焦点、滚动位置、搜索词和鼠标悬停只由前端组件管理。它们不写入 Server，不参与消息路由、任务授权或删除判断。

桌面端或未来 TUI 需要保存焦点时，也只能保存客户端本地 UI 状态，不能恢复成一个服务端活动会话。

### 4.4 不存在连接级默认目标

连接建立、Workspace 切换、WebSocket 重连和会话列表刷新都不产生隐式目标：

- `send` 必须携带明确的 `conversationId`，该 ID 来自当前会话；
- `cancel_turn` 必须携带明确的 Conversation 和 Turn；
- `cancel_task` 必须携带明确的 Conversation、Task 和执行代际；
- 读取历史、轨迹、产物和账单都必须携带明确的 Conversation；
- 服务端不得因为“连接最近使用了 B”而把没有目标的操作路由到 B。

没有当前会话时，操作直接返回明确错误或保持控件禁用，不自动回退到最近创建的会话。

## 5. 用户行为

### 5.1 创建会话

1. 用户创建会话 B。
2. B 成为当前会话 `currentSessionId`。
3. B 的运行状态初始为 `idle`，除非已经提交了用户 Turn。
4. 旧会话 A 保持自己的 activity 和历史。
5. 侧边栏只把 B 标为“当前”。

### 5.2 切换会话

1. 用户点击 A。
2. A 成为当前会话。
3. 页面加载 A 的历史和投影。
4. B 继续后台运行；如果 B 正在执行，B 显示执行状态。
5. A 是唯一带当前会话样式的行。

切换不创建新 Task、不启动新的 Planner、不停止后台执行，也不改变任何会话的持久运行状态。

### 5.3 发送消息

发送请求必须包含当前会话 A 的明确 ID：

```text
Web client -> Gateway
  scope: conversation(A)
  command: user_message
```

服务端不从连接状态、最近创建记录或最近活动记录推断目标。

### 5.4 停止任务

停止操作仍使用精确目标：

```text
conversationId + taskId + executionGeneration
```

当前查看的是 A 时，不能因为 B 是最近运行会话而停止 B。用户需要先切换到 B，或者在后台任务列表中明确选择 B 的任务。

### 5.5 删除会话

删除资格只由目标会话的真实运行事实决定：

- `idle`、已完成、已失败、已取消或已归档：允许删除；
- `queued`、`planning`、`executing`、`waiting`、`blocked`：拒绝删除，并提示先停止任务；
- 停止完成后，状态投影变为终态，用户可以再次删除。

当前会话身份本身不阻止删除。删除当前会话成功后，客户端清除 `currentSessionId`、URL 会话目标及预览/详情，回到空状态，等待用户明确选择后继。服务端不能把“当前”当成“不可删除”。

因此，最后创建的会话只要已经完成，就可以正常删除。

## 6. 服务端改造边界

### 6.1 移除 Web Runtime 的活动会话权威

`WebGatewayClientSession` 不再维护 `_activeSessionId` 作为全局活动执行会话。需要替换的职责包括：

- 不再用它给目录条目标记 active；
- 不再用它保护删除；
- 不再用它决定 Workspace 内唯一活动会话；
- 不再用它为缺少目标的命令提供回退路由。

服务端可以维护客户端当前打开会话的短生命周期信息，但该信息只能用于观察订阅和显式命令校验，命名应为 `currentSessionId`，不能继续使用带有“全局活动执行”含义的 `activeSessionId`。

### 6.2 目录投影

会话目录条目只返回：

- 会话元数据；
- Workspace 绑定；
- 会话自身 activity；
- 是否已归档；
- 最近更新时间。

目录条目不返回一个由连接推导的 `active` 标志。客户端根据 `session.id === currentSessionId` 计算当前会话，根据 `session.activity` 计算运行标识。

### 6.3 删除准入

删除入口查询目标会话的持久 Activity/Task 投影，检查是否存在未完成或外部副作用未收敛的任务。删除保护不再读取连接级当前会话字段。

该检查必须在服务端执行，不能只依赖前端是否显示删除按钮。所有客户端，包括 Web、TUI 和 Feishu，都遵循同一规则。

### 6.4 多客户端

两个客户端可以同时打开不同会话：

- 客户端 1 的 `currentSessionId = A`；
- 客户端 2 的 `currentSessionId = B`；
- A、B 的任务和会话事实由 AccountRuntime 统一维护；
- 一个客户端切换会话不会改变另一个客户端的当前会话；
- 任意客户端发送、停止和审批都必须携带明确资源 ID。

这与 ADR-0043 的“客户端焦点与服务端事实分离”一致，也不引入连接级拥有者或接管流程。

## 7. 前端改造边界

### 7.1 状态收敛

目标状态为：

```ts
currentSessionId: string | null
sessions: WebSessionMetadata[] // 每个条目包含自身 activity
```

`browsedSessionId` 不再作为独立领域状态。若切换期间需要防止异步响应覆盖新页面，可以保留一个纯请求代次或导航 token，但它不能参与选中、发送、删除或服务端授权。

### 7.2 SessionSidebar

每一行只使用一个当前会话判断：

```tsx
const current = session.id === currentSessionId;
```

运行状态由 `session.activity` 和 `running` 投影控制：

- 当前会话：明确的边框或当前标签；
- 执行中：状态点、动画或“执行中”文字；
- 排队中：黄色状态点；
- 阻塞：红色状态点。

运行状态和当前会话可以同时成立，但只会有一个行拥有当前会话样式。

### 7.3 消息和草稿

草稿、附件、失败输入恢复和消息确认都以 `currentSessionId` 为 key。切换会话时保存/恢复对应草稿，但不产生任何服务端 attach 或 active 变化。

### 7.4 重连与刷新

重连后恢复客户端自己保存的 `currentSessionId`；如果该会话已经不存在或不属于当前 Workspace，则清空当前会话并要求用户明确选择。重连不得自动选择最新创建或最近活动的会话。

## 8. 明确保留的安全和一致性机制

简化会话状态不意味着删除执行安全机制。以下机制继续保留：

- Conversation 内输入 mailbox 串行化；
- Task、Subtask、Attempt 的持久状态；
- 精确 `taskId` 和 `executionGeneration` 取消 fence；
- Workspace、ResourceLease 和执行路径边界；
- Planner、Kernel Coordinator、Executor 的职责边界；
- 账户和 Workspace 授权；
- 幂等键、事件恢复和读模型 revision；
- 运行中任务的停止、收尾和外部副作用确认。

这些机制解决的是执行和数据一致性问题，不应该再被一个 `activeSessionId` 兼任。

## 9. 不采用的方案

### 保留 `activeSessionId`，只修改颜色

不能解决删除错误，也会继续让服务端把“最后激活会话”误认为“运行中会话”。视觉修复只能掩盖模型问题。

### 点击历史会话时调用服务端 attach 并覆盖 active

这会让浏览行为再次改变执行路由，违反 ADR-0043 的观察与执行解耦原则，也可能让另一个客户端的目标被错误覆盖。

### 为每个客户端设置一个连接级默认会话

这仍然允许无目标命令被错误路由，并保留“最近会话”和“当前会话”混淆的来源。本方案明确不采用。

### 用最近创建的会话作为回退目标

这正是当前“最后创建会话永远被选中、无法删除”问题的来源之一。没有明确目标时应报错或保持禁用。

## 10. 实施顺序

1. 在服务端删除 `activeSessionId` 对目录 active 标志和删除保护的依赖。
2. 将客户端当前目标统一为 `currentSessionId`，删除 `browsedSessionId` 的领域语义。
3. 修改 Gateway 命令和查询调用，所有操作都携带明确 Conversation ID。
4. 将删除准入改为基于目标会话真实未完成 Activity/Task。
5. 修改 SessionSidebar，使当前、运行、排队和阻塞使用不同的视觉语义。
6. 修正创建、切换、重连、Workspace 切换和删除后的当前会话收敛规则。
7. 删除旧 `activeSessionId` 字段及兼容投影；如协议暂时需要兼容，只允许读取旧字段，不再依据它做决策。
8. 运行聚焦单元测试、Gateway 测试、浏览器验收和多客户端并发验收。

## 11. 验收矩阵

| 场景 | 预期结果 |
|---|---|
| 创建 A，再创建 B | B 是唯一当前会话；A 不受影响 |
| 从 B 切换到 A | A 是唯一当前会话；B 只显示自己的 activity |
| B 执行时查看 A | B 继续执行；A 可以查看和发送；不会出现两个选中行 |
| B 完成后删除 B | 删除成功，不受最近创建或最近当前状态影响 |
| B 执行中删除 B | 明确提示任务仍在运行，不静默删除 |
| 当前会话 A 删除 | 当前目标清空或由用户明确选择后继，不自动绑定旧 active |
| Web 客户端 1 查看 A、客户端 2 查看 B | 两个客户端互不覆盖当前目标 |
| WebSocket 重连 | 恢复原客户端当前会话；不存在时清空，不选择最新会话 |
| 无当前会话发送消息 | 请求被禁用或返回明确错误，不回退到最近会话 |
| 取消任务 | 只取消用户明确指定的 Conversation/Task/Generation |
| 目录刷新 | 不改变当前会话，不因排序或新会话插入改变选择 |

## 12. 已交付行为与验证

- **完成日期：** 2026-10-30。
- **收尾提交：** 未提交；本轮仅本地实施与验证，尚未推送 GitHub。
- **客户端状态：** 唯一 `currentSessionId`，同步 ref 只供异步回调捕获同一选择；没有 active/browsed 两套状态。目录条目不再含 `active`，侧边栏只用 `data-current` 表达当前行，activity 独立展示。
- **协议与路由：** 删除旧 active 字段及兼容别名。旧打开接口的 `current*` 返回信息不被前端用作选中来源，不被服务端用作执行默认值。发送/取消必须有明确 Conversation；Task 取消继续携带执行代际。附件与历史读取按显式会话授权，发送重试沿用请求幂等键。
- **导航与竞态：** 启动仅恢复客户端保存/链接明确指定的会话，无目标不按最近时间选中；WebSocket hello、目录排序、分页与 current 通知不抢占选择。迟到的创建响应受导航代际约束；删除响应检查实时当前 ID，不清空用户已切换的另一会话。失效/撤权目标清空 URL 与视图，删除或切换也清理旧预览与详情。
- **删除与清空：** Runtime 点查会话 activity，Workspace Directory 在归档入口重新检查当前事实。非 idle 均要求先停止；`blocked` 对应仍未结束的 needs_action Task，且其投影优先级可能覆盖同时运行的 Task，因此不能直接当作空闲。历史 blocked Turn 不再构成永久禁删。清空历史逐个复用删除入口，返回 `deletedIds`、`skipped`，只移除真正删除的会话。
- **边界：** 没有新增缓存、连接默认目标、语义路由、调度器或持久化格式；保留已有显式 observation、Workspace/账户授权及 Task generation fence。

验证记录：

1. `npm run lint` 和 `npm run build`（含服务端打包、Schema 生成、Web TypeScript/Vite 构建）：通过。
2. Web、受影响 Management、Workspace Directory、Gateway 和多客户端生命周期集成回归：111 个文件、874 个测试通过。
3. `RUN_BROWSER_E2E=1 npx vitest run tests/e2e/workspace-conversation-directory-browser.test.ts`：真实 Chrome 的两组流程通过。覆盖创建 A/B、唯一当前行、切回 A、重连不改选择、发送到 A、停止 B 的精确 Task/代际、运行中拒删、停止后删除、删除当前会话、迟到删除响应不清空新选择、两客户端互不覆盖、Workspace 切换及移动端布局。
4. 同一浏览器测试保留 1000 轮历史压力场景，100 次切换的 P95 为 67.5 毫秒，未调用旧历史/执行 attach 读取路径。
5. 最终预览/详情与失效 URL 清理完成后，重跑 35 项导航/会话聚焦测试及以上两组浏览器流程，全部通过。
6. 浏览器使用真实前端、WebSocket 和 SQLite Conversation 读投影；账户状态、命令执行由隔离测试服务提供。Management 测试另行验证真实 HTTP/WS 身份入口、缺失目标拒绝和删除状态码。本轮未调用真实模型供应商，也未重启用户当前运行的服务。
7. 广泛回归发现一个既有文案断言仍要求“未登记”，组件已使用“尚未写回”；仅同步了该测试断言，未更改相关产品逻辑。

## 13. 方案结论

MetaWork 不需要连接级默认目标，也不需要一个服务端全局活动会话来表达用户当前操作对象。DeepSeek Harness 的可借鉴核心是：Session 独立、运行状态归属 Session、切换只改变当前打开会话，后台工作继续运行。

本方案最终保留一个客户端 `currentSessionId`，把 activity 作为每个会话的事实投影，把 UI focus 留在前端；删除、停止、发送和读取都使用明确的会话或任务 ID。这样既能保留 MetaWork 的多客户端和持久执行能力，也能消除当前两个会话同时选中、最后创建会话无法删除以及连接状态污染会话语义的问题。

