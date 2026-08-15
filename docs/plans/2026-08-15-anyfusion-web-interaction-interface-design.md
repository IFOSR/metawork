# AnyFusion Web 交互界面设计

> 状态：设计中（待实现）
> 设计日期：2026-08-15
> 关联：Server 升级实现计划（2026-08-11）、ADR-0027（Configuration Control Plane）、ADR-0015（Planner-owned semantics）
> 用途：为 AnyFusion 设计一个基于浏览器的用户交互主界面，作为命令行 TUI 的并存替代，让用户输入问题、观察 Agent 执行全过程、配置 agents 和基础模型。

## 1. 目标与定位

外部端是一个 Web 界面，做三件事：

1. **对话**：用户输入自然语言问题，交给 Agent 执行。
2. **执行可视化**：看到 Agent 从理解问题到交付产物的完整过程——Planner 如何规划、Kernel 如何决策、Executor 如何执行、每一步的详细逻辑。
3. **设置**：配置 agents 和基础模型（Provider / Model / AgentClass）。

核心原则：**不重写执行链路，只做交互面的 Web 化 + 结构化投影**。现有 `MetaclawSession` 已经封装了 `问题 → Planner 提案 → Kernel 授权 → Executor 执行 → 交付` 的完整链路，外部端就是把这条链路变成浏览器里看得见的界面。

定位是「并存」而非「取代」：`metawork` 保持现有 Pi TUI，新增 `metawork web` 启动 Web 界面。

## 2. 参考：DeepSeek WebUI

参考 `deepseek-ai/deepseek-harness` 的 `apps/web`，取三点架构骨架，不照搬：

1. **独立前端子项目**：`apps/web` 是 Vite + React 18 的独立构建，产物 `dist/` 由后端 CLI 托管，dev 模式走 `vite.config.ts` 的 proxy。metawork 同样做 `web/` 子项目 + `metawork web` 命令托管。
2. **对话式主布局**：以对话流为界面主轴，输入框固定底部，消息按角色流式渲染。
3. **前端薄、后端厚**：前端只做渲染，执行语义全部在 Server 已有的 session/kernel 链路里。

差异：DeepSeek 是纯 chat 产品，AnyFusion 是任务执行系统，所以界面多一根「执行时间线」主轴，展示 Planner → Kernel → Executor 的完整过程——这是 AnyFusion 界面的核心差异化。

## 3. 技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 | Vite 6 + React 18 + TypeScript | 对齐 DeepSeek WebUI，独立 `web/` 子项目 |
| 样式 | 纯 CSS（单文件或 CSS Modules），不引 UI 框架 | 保持轻，先不做组件库 |
| 后端 | Node 原生 `http` + WebSocket 握手（轻量 `ws`） | 不引 Express/Fastify |
| 协议 | REST（配置/查询）+ WebSocket（对话/执行事件流） | 见第 5、6 节 |
| 鉴权 | 绑 `127.0.0.1` + 启动生成的 bearer token | 先本地，不做远程/多用户 |

`web/` 是**完全独立的子项目**（自己的 `package.json` + `node_modules` + Vite 构建），不加入 npm workspaces，避免污染 metawork 的 Node 22 运行时依赖树。metawork 只在运行时托管 `web/dist` 静态产物。

## 4. 项目结构

```
metawork/
├── src/                          # 现有 Server（不动核心链路）
│   └── management/               # 新增
│       ├── server.ts             #   HTTP + WS + 静态托管 web/dist
│       ├── token.ts              #   bearer token 生成与校验
│       ├── routes-config.ts      #   /api/config/* → ConfigurationService
│       ├── routes-execution.ts   #   /api/execution/* → durable read
│       ├── session-bridge.ts     #   WS 桥接 MetaclawSession（移植 gateway 逻辑）
│       └── execution-projector.ts#   执行时间线投影（核心新增，纯只读）
├── web/                          # 新增前端子项目（独立 package.json）
│   ├── index.html
│   ├── package.json              #   react/react-dom + vite + @vitejs/plugin-react
│   ├── vite.config.ts            #   dev proxy → 127.0.0.1:8788
│   └── src/
│       ├── main.tsx              #   React mount
│       ├── App.tsx               #   三栏布局 + 状态
│       ├── api/
│       │   ├── http.ts           #   REST 客户端
│       │   ├── ws.ts             #   WebSocket 客户端（重连 + 心跳）
│       │   └── types.ts          #   与 Server 投影同构的类型
│       └── components/
│           ├── ChatPane.tsx          # 对话流 + 输入框
│           ├── ExecutionTimeline.tsx # 执行时间线（阶段视图）
│           ├── SubtaskCard.tsx       # 单个 subtask 卡片
│           ├── DecisionDetail.tsx    # Kernel 决策详情（展开）
│           ├── SettingsPanel.tsx     # 设置抽屉
│           ├── ProviderForm.tsx
│           ├── ModelForm.tsx
│           └── AgentClassForm.tsx
└── package.json                 # metawork 脚本加 `web:build` 等辅助（可选）
```

类型共享：`web/src/api/types.ts` 与 `src/management/` 的投影类型保持同构，初期手动同步，不引入跨端类型包。后续需要再抽 `shared/` 包。

## 5. 后端接口

### 5.1 配置（REST）

配置写操作全部走 `ConfigurationService` 的 activate 闭环（validate → compile → probe → activate），绝不直写 `config.yaml`。一次激活 = 一个新 revision，供 generation 钉住。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/config` | — | `{ revisionId, contentHash, config }` |
| GET | `/api/config/revisions` | — | `[{ revisionId, contentHash, active }]` |
| GET | `/api/config/revisions/:id` | — | 指定 revision 的 snapshot |
| POST | `/api/config/activate` | 完整 `AnyFusionConfigurationV2` | `{ ok:true, revisionId }` 或 `{ ok:false, code, activeRevisionId?, issues[] }` |
| POST | `/api/config/rollback` | `{ targetRevisionId }` | 同 activate 响应 |

激活失败码透传 `ConfigurationService`：`validation_failed` / `probe_failed` / `revision_conflict`，前端逐条展示 issues。

### 5.2 执行查询（REST，只读）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/execution/tasks` | Task 列表（id/title/status/updatedAt） |
| GET | `/api/execution/tasks/:id` | 单 Task 完整执行时间线（见第 6 节） |
| GET | `/api/execution/executors` | AgentClass + health 列表 |

数据源全部是 durable 事实的只读投影：`TaskRuntimeService`、`OrchestrationEngine.getDashboard()`、Work Graph、Kernel decision ledger、attempt receipts、`kernel_executor_status`。

### 5.3 对话（WebSocket）

复用现有 `MetaclawSession` 的 `submit` / `subscribe`（即 `src/gateway/server.ts` 已有的回路，从 Unix socket JSONL 换成 WebSocket）。

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| 前端 → Server | `{ type:'input', text }` | 用户问题，进 `session.submit` |
| 前端 → Server | `{ type:'close' }` | 关闭会话 |
| Server → 前端 | `{ type:'hello', sessionId }` | 连接建立 |
| Server → 前端 | `{ type:'output', lines[] }` | 文本输出（Planner 回复 / 交付摘要 / 错误） |
| Server → 前端 | `{ type:'execution', taskId, timeline }` | 执行时间线增量（核心新增） |
| Server → 前端 | `{ type:'error', message }` | 错误 |

## 6. 执行时间线投影（核心）

`ExecutionProjector` 把分散的 durable 事实组合成一条结构化执行时间线。这是「看 Agent 执行过程和详细逻辑」的数据基础。

**颗粒度**（轻量方式，确认稿）：到「阶段 + subtask + attempt + Kernel 决策」这一层，纯读 durable 事实，零侵入 Executor 侧。不做「Executor 每条工具调用 / 文件写入」级别的细粒度。

### 6.1 时间线 schema

```json
{
  "taskId": "task_xxx",
  "title": "给仓库加 CI 流程",
  "status": "running",
  "stages": [
    {
      "phase": "planning",
      "status": "done",
      "proposal": {
        "subtasks": ["s1 写配置", "s2 写脚本"],
        "dependencies": [["s1", "s2"]]
      }
    },
    {
      "phase": "authorization",
      "status": "done",
      "decisions": [
        { "type": "authorize", "subtask": "s1", "reason": "输入材料齐全" }
      ]
    },
    {
      "phase": "execution",
      "status": "running",
      "subtasks": [
        {
          "id": "s1",
          "status": "done",
          "executor": "codex-cli",
          "attempts": [{ "result": "success", "exitCode": 0 }]
        },
        {
          "id": "s2",
          "status": "running",
          "executor": "codex-cli",
          "attempts": []
        }
      ]
    },
    { "phase": "verification", "status": "pending" },
    { "phase": "delivery", "status": "pending" }
  ]
}
```

### 6.2 数据源映射

| 阶段 | 数据源 | 投影内容 |
| --- | --- | --- |
| planning | Work Graph（subtasks + 依赖 + delivery kind） | 拆成了哪几步、谁依赖谁 |
| authorization | Kernel decision ledger | 每步授权/拒绝/重规划 + 原因 |
| execution | subtask 状态 + attempt receipts | executor、probe、exit code、失败原因 |
| verification | 验证结果 | 通过/失败 + 证据 |
| delivery | artifacts + Git publication | 产物清单 + 提交 |

### 6.3 推送机制

- 事件驱动：session 状态变化时对当前 task 做一次投影，diff 后把增量经 WS 推给前端。
- 查询兜底：前端首次连接用 `GET /api/execution/tasks/:id` 拉全量。
- 不依赖固定轮询。

## 7. 前端页面设计

### 7.1 布局（对话为主轴，时间线伴生）

```
┌─────────────────────────────────────────────────────┐
│ 顶栏：当前 Task 状态 · revision 号 · 「设置」入口        │
├───────────────────────────────┬─────────────────────┤
│                               │  执行时间线            │
│  对话区（主）                  │  规划 → 授权           │
│  · 用户问题气泡                │  → 执行 → 验证 → 交付  │
│  · Planner 回复 / 交付摘要     │  每个 subtask 卡片     │
│  · 错误提示                   │  点击展开决策/回执详情   │
│                               │                     │
├───────────────────────────────┴─────────────────────┤
│ 输入框（固定底部）：[输入问题...]  [发送]                │
└─────────────────────────────────────────────────────┘
```

设置是抽屉（顶栏点开），不占常驻空间：

```
设置抽屉
├── Provider：protocol / baseUrl / apiKey / region / enabled
├── Model：modelId / providerRef / capabilities / reasoning / enabled
├── AgentClass：kind / harnessRef / modelPolicy / permissionProfile / enabled
└── [激活] → POST /api/config/activate → 显示新 revisionId 或逐条错误
```

### 7.2 交互细节

- **对话**：发送后消息进流；Planner 规划说明、交付摘要、错误都落在对话区。
- **时间线**：与对话同步推进——用户一提交，右侧立刻出现 `planning` 阶段，随授权/执行实时点亮。subtask 卡片状态色点（ready / running / done / blocked / failed），点开看 Kernel 决策原因和 attempt 回执（含失败错误码和详细原因）。
- **设置**：编辑本地副本 → 整体激活。apiKey 只回显「已配置」，不显示明文。

### 7.3 状态管理

不引 Redux/状态库，`App.tsx` 用 `useState` + `useReducer` 维护两类状态：

1. **会话状态**：输出行、当前 taskId、发送中标记（来自 WS 消息）。
2. **执行状态**：当前 task 的时间线对象（来自 WS `execution` 增量 + REST 全量合并）。

## 8. 实现步骤（5 步，每步独立可提交）

1. **前端骨架**：`web/` 子项目（Vite + React），三栏布局 + 空组件，dev 能跑起来。
2. **Server 管理服务**：`src/management/server.ts`（HTTP + WS + 静态托管 + token），`metawork web` 命令挂载；先托管 `web/dist`。
3. **对话桥接**：WS 连 `MetaclawSession`（移植 gateway 的 submit/subscribe），先只推 `output` 文本，验证对话通。
4. **执行投影**：`execution-projector.ts` 组合 Work Graph / decision ledger / attempts / executor status，接 WS 增量推送 + REST 全量查询。
5. **配置 + 设置页**：`/api/config/*` 接 `ConfigurationService`，前端 SettingsPanel 三块表单 + 激活。

## 9. 边界与不做什么

- **不重写执行链路**：Planner/Kernel/Executor 完全复用，Web 端只是输入口 + 观察面。
- **不做语义决策**：时间线是 durable 事实的只读投影，不含任何路由/调度逻辑。
- **配置只走 ConfigurationService**：不直写 config.yaml，不引入第二配置权威。
- **先本地**：绑 127.0.0.1，后续再考虑远程/多用户/Feishu。
- **不做**：Executor 工具调用级细粒度、WebSocket 实时轮询、数据库直写、第二套配置验证。

## 10. 验收标准

- [ ] `metawork web` 启动后浏览器打开 `127.0.0.1:8788`，能看到三栏界面。
- [ ] 用户输入问题，对话区出现 Planner 回复，右侧时间线从 `planning` 推进到 `delivery`。
- [ ] 时间线每个 subtask 卡片可展开，看到 Kernel 决策原因和 attempt 回执。
- [ ] 设置抽屉可编辑 Provider/Model/AgentClass，激活后顶栏 revision 更新，`GET /api/config` 返回新 revision。
- [ ] 激活失败时逐条展示 issues，不静默。
- [ ] 不修改 config.yaml 直写路径；配置变更只经 `ConfigurationService`。
- [ ] 现有 `metawork` TUI 路径不受影响。
- [ ] `npm run lint` / `npm run build` 通过；`web/` 内 `npm run build` 通过。

## 11. 待定（实现前确认）

- 端口：默认 `127.0.0.1:8788`，是否可配。
- `metawork web` 是否自动 `open` 浏览器（macOS `open` / Linux `xdg-open`）。
