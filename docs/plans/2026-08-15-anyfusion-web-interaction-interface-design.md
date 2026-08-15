# AnyFusion Web 交互界面设计

> 状态：设计中（待实现）
> 设计日期：2026-08-15
> 修订：2026-08-15（v4：锁覆盖矩阵、gateway socket 归属、投影触发跨模块预授权）
> 关联：Server 升级实现计划（2026-08-11）、ADR-0027（Configuration Control Plane）、ADR-0015（Planner-owned semantics）、ADR-0020（模块归属与依赖方向）
> 用途：为 AnyFusion 设计一个基于浏览器的用户交互主界面，作为命令行 TUI 的并存替代，让用户输入问题、观察 Agent 执行全过程、配置 agents 和基础模型。

## 1. 目标与定位

外部端是一个 Web 界面，做三件事：

1. **对话**：用户输入自然语言问题，交给 Agent 执行。
2. **执行可视化**：看到 Agent 从理解问题到交付产物的完整过程——Planner 如何规划、Kernel 如何决策、Executor 如何执行、每一步的详细逻辑。
3. **设置**：配置 agents 和基础模型（Provider / Model / AgentClass），范围见第 8 节的「生效范围」声明。

核心原则：**不重写执行链路，只做交互面的 Web 化 + 结构化投影**。现有 `MetaclawSession` 已经封装了 `问题 → Planner 提案 → Kernel 授权 → Executor 执行 → 交付` 的完整链路，外部端就是把这条链路变成浏览器里看得见的界面。

定位是「**可替换使用**」而非「同时运行」：`metawork`（Pi TUI）与 `metawork web`（浏览器）共享同一把实例锁（见第 4 节），一次只能运行一个交互面。两者不共存，但可随时切换——退出 TUI 后开 web，或反之。

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
| 协议 | REST（配置/查询）+ WebSocket（对话/执行事件流） | 见第 6、7 节 |
| 鉴权 | 绑 `127.0.0.1` + 启动生成的 bearer token | 见第 6.4 节 |

`web/` 是**完全独立的子项目**（自己的 `package.json` + `node_modules` + Vite 构建），不加入 npm workspaces，避免污染 metawork 的 Node 22 运行时依赖树。metawork 只在运行时托管 `web/dist` 静态产物。

## 4. 进程模型、实例锁与会话基数

### 4.1 进程拓扑（已决：复用主进程 composition）

`metawork web` **不是独立进程**。它复用 `src/index.ts` 的完整 composition（配置快照 → DB → recovery → planner host bridge + supervisor + executor runtime），与 `metawork`（TUI）的唯一差异是**交互面**：TUI 模式启动 Pi TUI 子进程，web 模式改为启动 HTTP/WS 监听并托管 `web/dist`，Planner 全程以 RPC 模式被 session 调用。

理由：

- 每个 `MetaclawSession.initialize()` 都会跑 durable startup recovery；KernelWorkflow 的串行化只在单进程内成立。两个进程并发操作同一个 SQLite 库会产生跨进程竞态，而全仓库目前没有任何单实例守卫。
- `src/gateway/server.ts` 和 `PlannerHostBridge` 启动时都会 `unlinkSync` stale socket——独立 Web 进程会抢走 TUI 进程的 planner socket，全程无报错。
- 复用 composition 使 web 模式自动获得与 TUI 完全一致的恢复、调度、执行语义，零分叉。

### 4.2 实例锁（composition 层，覆盖矩阵见下）

实例锁属于 **composition 而不是某个子命令**——只给 `metawork web` 一把私有锁，防不住「先开 TUI 再开 web」的双进程抢 socket 场景（TUI 侧无锁可取、socket 被 unlink 后 bridge 静默失效）。

**模式 × 锁覆盖矩阵**：

| 模式 | 取锁 | 理由 |
| --- | --- | --- |
| `metawork`（TUI） | 取 | 主交互面 |
| `metawork web` | 取 | 主交互面 |
| `metawork --gateway`（gateway 守护） | 取 | **持锁期间 TUI/web 被拒——这是显式的产品行为变更**：今天 gateway daemon 与 TUI 可以（带病）并存，上锁后互斥，方向正确但需知晓 |
| `metawork --script` | **不取** | 调试/脚本用途；文档注明「不得与运行中实例并用」；smoke 等自动验证在独立 install root 下运行，天然隔离 |
| admin 命令（`metawork config ...` 等） | 不取 | 纯配置操作，不经 composition，不碰 planner socket |

**gateway socket 属于交互面**：`MetaclawGatewayServer` 的 Unix socket 与 Pi TUI、HTTP/WS 并列——TUI 模式起 TUI + gateway socket（现状），web 模式**不启动** gateway socket（否则 gateway 的 per-connection session 与 web 的单例 session 同进程并存，与 §4.4 撞车）。web 模式只起 HTTP/WS。

```
任何取锁模式的启动序列：
1. 解析 CLI
2. 实例锁：O_EXCL 创建 <ANYFUSION_INSTALL_ROOT>/data/runtime.lock，写入 PID + 进程启动时间戳
   失败 → kill(pid, 0) 探测锁内 PID：
     · 存活（探测成功）→ 输出「AnyFusion 已在运行（PID ...）」，退出码非零
     · 已死（ESRCH）    → 回收 stale lock（unlink 后重试一次，仍失败才报错）
   （PID 复用竞态：锁内 PID 被无关进程占用会误判存活——本地单用户场景接受该风险，
     锁文件写入启动时间戳供人工排查）
3. web 模式额外：HTTP server bind 127.0.0.1:8788
   （EADDRINUSE → 报错退出，双保险；TUI/gateway 模式无此步）
4. 完整 composition（各模式相同）：配置快照 → DB → recovery
   → planner host bridge + supervisor + executor runtime
5. TUI 模式启动 Pi TUI + gateway socket；web 模式改为 HTTP/WS 监听 + 静态托管 web/dist
6. web 模式打印启动 URL + token（见第 6.4 节）
```

锁文件写入 PID；正常退出（含 SIGINT/SIGTERM handler）时清理。SIGKILL/断电无法清理，由第 2 步的 PID 存活探测回收——**这一步必须在任何 socket unlink 之前执行**，保证第二个实例在抢 planner socket 之前就被拒绝。

### 4.3 模块归属（ADR-0020）

`src/management/` 归 **Application Shell 侧**，与 `src/gateway/`、`src/tui-bridge/` 同级。依赖方向只允许：

```
Application Shell → Configuration Service（写路径）
Application Shell → durable read services（Task/Executor/Work Graph/decision ledger 只读投影）
```

禁止：直接读写 config.yaml、直接写 SQLite、调用 Executor、做任何调度/恢复决策。

`session-bridge.ts` 不复制 gateway 的生命周期逻辑：把 `src/gateway/server.ts` 的 per-connection session 处理（subscribe / cleanup / dispose，约 server.ts:92-156）**抽取为共享 adapter**（如 `src/session/session-transport-adapter.ts`），Unix socket JSONL 和 WebSocket 两个传输复用同一份代码。adapter 把「连接建立」（传输层）和「会话创建」（鉴权通过后附着 session）拆成两步——见第 6.4 节。

### 4.4 会话基数（已决：单例 session）

Web 模式**不沿用** gateway 的 per-connection session 模式（每个连接 new 一个 `MetaclawSession`）。所有 WS 连接附着到**同一个单例 `MetaclawSession`**：

- 第一个 WS 连接鉴权通过后创建 session 并 `initialize()`（一次 durable recovery）；
- 后续连接（多 tab、断线重连）附着同一 session，拿到当前输出和 runtime state 的完整快照，**不重跑 initialize**；
- session 生命周期绑定进程，不绑定连接：最后一个连接断开时 session 保留（上下文不丢），进程退出时 dispose。

保证：开两个 tab 看到同一对话上下文；刷新页面重连后上下文还在。gateway 的 Unix socket JSONL 维持 per-connection 行为不变（共享 adapter 支持两种基数）。

## 5. 项目结构

```
metawork/
├── src/                          # 现有 Server（不动核心链路）
│   ├── session/
│   │   └── session-transport-adapter.ts  # 新增：抽取 gateway 的 per-connection 处理
│   └── management/               # 新增（Application Shell 侧）
│       ├── server.ts             #   HTTP + WS + 静态托管 web/dist
│       ├── lock.ts               #   composition 实例锁（runtime.lock + PID 探测回收）
│       ├── token.ts              #   bearer token 生成与校验
│       ├── routes-config.ts      #   /api/config/* → ConfigurationService
│       ├── routes-execution.ts   #   /api/execution/* → durable read
│       ├── session-bridge.ts     #   单例 session + WS 附着（经共享 adapter）
│       └── execution-projector.ts#   执行时间线投影（核心新增，纯只读）
├── web/                          # 新增前端子项目（独立 package.json）
│   ├── index.html
│   ├── package.json              #   react/react-dom + vite + @vitejs/plugin-react
│   ├── vite.config.ts            #   dev proxy → 127.0.0.1:8788
│   └── src/
│       ├── main.tsx              #   React mount
│       ├── App.tsx               #   三栏布局 + 状态
│       ├── api/
│       │   ├── http.ts           #   REST 客户端（Authorization 头）
│       │   ├── ws.ts             #   WebSocket 客户端（重连 + 首条消息鉴权）
│       │   └── types.ts          #   与 Server 投影同构的类型
│       └── components/
│           ├── ChatPane.tsx          # 对话流 + 输入框
│           ├── ExecutionTimeline.tsx # 执行时间线（阶段视图）
│           ├── SubtaskCard.tsx       # 单个 subtask 卡片
│           ├── DecisionDetail.tsx    # Kernel 决策详情（展开）
│           ├── TokenGate.tsx         # 首次访问的 token 输入页
│           ├── SettingsPanel.tsx     # 设置抽屉
│           ├── ProviderForm.tsx
│           ├── ModelForm.tsx
│           └── AgentClassForm.tsx
└── package.json                 # metawork 脚本加 `web:build` 辅助（可选）
```

类型共享：`web/src/api/types.ts` 与 `src/management/` 的投影类型保持同构，初期手动同步，不引入跨端类型包。后续需要再抽 `shared/` 包。

## 6. 后端接口

### 6.1 配置（REST）

配置写操作全部走 `ConfigurationService` 的 activate 闭环（validate → compile → probe → activate），绝不直写 `config.yaml`。一次激活 = 一个新 revision，供 generation 钉住。

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/config` | — | `{ revisionId, contentHash, config }` |
| GET | `/api/config/revisions` | — | `[{ revisionId, contentHash, active }]` |
| GET | `/api/config/revisions/:id` | — | 指定 revision 的 snapshot |
| POST | `/api/config/activate` | `{ baseRevisionId, config }` | `{ ok:true, revisionId }` 或 `{ ok:false, code, activeRevisionId?, issues[] }` |
| POST | `/api/config/rollback` | `{ targetRevisionId }` | 同 activate 响应 |

**baseRevisionId**：前端从 `GET /api/config` 拿到的当前 revisionId，随 activate 一起提交，作为 `activateDraft` 的乐观并发预期。与当前 active 不一致时返回 `revision_conflict`——前端刷新配置后提示用户重试。没有这个字段，`revision_conflict` 的错误语义就没有落点。

激活失败码透传 `ConfigurationService`：`validation_failed` / `probe_failed` / `revision_conflict`，前端逐条展示 issues。

### 6.2 执行查询（REST，只读）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/execution/tasks` | Task 列表（id/title/status/updatedAt） |
| GET | `/api/execution/tasks/:id` | 单 Task 完整执行时间线（见第 7 节） |
| GET | `/api/execution/executors` | AgentClass + health 列表 |

数据源全部是 durable 事实的只读投影：`TaskRuntimeService`、`OrchestrationEngine.getDashboard()`、Work Graph、Kernel decision ledger、attempt receipts、`kernel_executor_status`。

### 6.3 对话（WebSocket）

复用现有 `MetaclawSession` 的 `submit` / `subscribe`（经 `session-transport-adapter`，Unix socket 与 WS 共用）。会话基数按第 4.4 节：单例 session。

| 方向 | 消息 | 含义 |
| --- | --- | --- |
| 前端 → Server | `{ type:'auth', token }` | **首条消息鉴权**（未鉴权前其他消息一律拒绝） |
| 前端 → Server | `{ type:'input', text }` | 用户问题，进 `session.submit` |
| 前端 → Server | `{ type:'close' }` | 关闭连接（不影响 session，见第 4.4 节；有意为之——web 端无 `/exit` 语义，会话随进程退出结束） |
| Server → 前端 | `{ type:'hello', sessionId }` | 鉴权通过，附着单例 session 成功 |
| Server → 前端 | `{ type:'output', lines[] }` | 文本输出（Planner 回复 / 交付摘要 / 错误） |
| Server → 前端 | `{ type:'execution', taskId, timeline }` | 执行时间线增量（核心新增） |
| Server → 前端 | `{ type:'error', message }` | 错误 |

### 6.4 鉴权与 token 传递

- 启动时生成随机 bearer token，**打印到终端**（不放在任何 URL 里，避免进浏览器历史和代理日志）。
- 浏览器首次访问 `127.0.0.1:8788` 时，前端显示 `TokenGate` 输入页；用户粘贴终端里的 token。
- token 存 `sessionStorage`（关页即失效）；此后所有 REST 请求带 `Authorization: Bearer <token>`，WS 连接后**首条消息**发送 `{ type:'auth', token }`，校验通过前拒绝一切其他消息。
- **鉴权通过前不创建 MetaclawSession**：未授权连接只占一个 socket，不触发 initialize/recovery（否则未授权连接白占一次 durable recovery）。共享 adapter 的「连接建立」与「会话创建」两步在 auth 通过处衔接。
- 提供「信任本机」按钮（可选优化）：token 存 `localStorage`，下次免输。不做 cookie。

### 6.5 CLI 注册

`src/cli/args.ts` 新增 `web` 子命令：

- `metawork web`：启动 web 模式（第 4.2 节序列）。
- 与 `--gateway`、`--script`、`--connect` 互斥，冲突时明确报错退出。
- 可选参数：`--port`（默认 8788）、`--no-open`（不自动打开浏览器）。
- 实例锁对 TUI 与 web 一视同仁（第 4.2 节）：TUI 运行中启动 web 被拒，反之亦然。

## 7. 执行时间线投影（核心）

`ExecutionProjector` 把分散的 durable 事实组合成一条结构化执行时间线。这是「看 Agent 执行过程和详细逻辑」的数据基础。

**颗粒度**（轻量方式，确认稿）：到「阶段 + subtask + attempt + Kernel 决策」这一层，纯读 durable 事实，零侵入 Executor 侧。不做「Executor 每条工具调用 / 文件写入」级别的细粒度。

### 7.1 时间线 schema

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

### 7.2 数据源映射（含推导规则）

| 阶段 | 数据源 | 投影内容与推导 |
| --- | --- | --- |
| planning | Work Graph（subtasks + 依赖 + delivery kind） | 拆成了哪几步、谁依赖谁 |
| authorization | Kernel decision ledger | 每步授权/拒绝/重规划 + 原因 |
| execution | subtask 状态 + attempt receipts | executor、probe、exit code、失败原因 |
| verification | receipt 的 verification facts + subtask `awaiting_integration` + publication 状态 | **无独立 verification 实体，状态推导**：有未终结 attempt 且 receipt 含 verification facts → `running`；全部 subtask receipt 的 verification facts 通过且无 `awaiting_integration` → `done`；任一 verification facts 失败 → `failed`；无任何 attempt 事实 → `pending` |
| delivery | artifacts + Git publication（merge attempts） | 产物清单 + 提交；publication 全部 `integrated` → `done`，任一 conflicted → `blocked` |

### 7.3 推送机制与触发源保真度

- 事件驱动：执行状态变化时对当前 task 做一次投影，diff 后把增量经 WS 推给前端。
- 查询兜底：前端首次连接用 `GET /api/execution/tasks/:id` 拉全量。
- 不依赖固定轮询。

**触发源保真度（第 4 步的验证动作，缺口不堵死不允许合入）**：`session.subscribe` 的 notify 只在 output/runtimeState 变化时触发；纯执行层的 durable 翻转（dispatch 落库、receipt 提交、publication 变 `integrated`）**不保证**当即产生 output 行（实证：`trackBackgroundWork` 完成时不 notify，metaclaw-session.ts:2495-2500）。因此：

1. 第 4 步实现后，必须跑一遍真实任务，验证 planning → authorization → execution → verification → delivery 的**每个阶段切换都有快照触发**；
2. 存在缺口时，投影触发点要挂到 execution progress / dispatch 的底层事件（而不是只挂 session 快照）——触发源的设计选择以这条验证的结果为准。

**预授权（跨模块例外，先上膛）**：execution 层当前没有 durable 变更的 change-feed。若第 4 步验证出缺口，**允许**为投影触发在 execution 落库点（dispatch / receipt / publication 提交处）新增**纯通知型 hook**（只发事件、不带任何语义决策）。这是对 §7「零侵入」承诺的唯一例外授权；按 ADR-0020 属跨模块改动，方向仍是 execution → 通知，不是 management → execution 写路径。未触发该例外时，不改 execution 模块。

## 8. 前端页面设计

### 8.1 布局（对话为主轴，时间线伴生）

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

设置是抽屉（顶栏点开），不占常驻空间。

### 8.2 设置页 scope 与生效范围（已决：收缩到非密字段）

**背景**：当前 Planner 实际使用的模型和凭证来自 `METACLAW_PLANNER_ENV_FILE`（provider.env）+ planner home 的 `models.json`/`settings.json`；Executor 凭证来自 `METACLAW_*_EXECUTOR_ENV_FILE` + home 模板。`ConfigurationService` 激活的 revision 里 Provider 只有 `apiKeyRef` 引用，**secret store 在生产路径尚未接线**（迁移只写 `secretImportPlan` 报告，`resolveRuntimePrivateConfigurationBinding` 无生产调用方）。因此激活 revision 不会改变 Planner/Executor 实际使用的模型 ID 和凭证。

**结论（按方案 (ii) 收缩）**：设置页只编辑「激活 revision 后确实生效」的非密字段：

| 可编辑（revision 钉住，激活即生效） | 不可编辑（安装期权威，明确标注） |
| --- | --- |
| AgentClass：enabled / modelPolicy（引用已存在 model）/ harnessRef / permissionProfileRef / routingCapabilities / 使用场景字段 | apiKey（凭证） |
| Model：enabled / capabilities / reasoning / costTier / latencyTier | modelId 的引入（新模型 ID 的创建） |
| Provider：enabled / region | baseUrl 变更、新 Provider 创建 |
| runtimePolicy：maxConcurrentAttempts 等 | — |

Provider 卡片上的 `apiKeyRef` **只读展示**（显示「凭证来自安装期配置」），不提供编辑。设置页页首固定声明：「模型 ID 与凭证的权威是安装期配置（provider.env + 模板）；此处激活的 revision 影响 Kernel/Planner 的绑定、路由与开关行为。」

**激活的真实成本（交互设计必须接受）**：`probeDraft` 会真实执行 `codex --version` / `pi --version`，executor CLI 缺失会导致**任何**配置变更激活失败（哪怕只改 runtimePolicy）。因此：激活是秒级操作但非零成本；`probe_failed` 时整页展示失败原因，并提示安装对应 CLI，不能静默。

**前置任务声明**：secret store + runtime binding 生产接线是独立的前置任务（可能触及 ADR-0027 范围）。完成之后，设置页才扩展凭证与模型 ID 管理，届时新增 `POST /api/config/secrets`（先写 secret store，再激活引用它的配置），并重新评估 scope。

### 8.3 交互细节

- **对话**：发送后消息进流；Planner 规划说明、交付摘要、错误都落在对话区。
- **时间线**：与对话同步推进——用户一提交，右侧立刻出现 `planning` 阶段，随授权/执行实时点亮。subtask 卡片状态色点（ready / running / done / blocked / failed），点开看 Kernel 决策原因和 attempt 回执（含失败错误码和详细原因）。
- **设置**：编辑本地副本 → 整体激活。apiKey 无编辑入口。
- **权限升级**：execution 中的权限请求沿用 RPC 自然语言授权（CONTEXT.md 已支持）——Planner 在对话区提出升级请求，用户直接在对话里回复同意/拒绝，**不做独立审批按钮**。

### 8.4 状态管理

不引 Redux/状态库，`App.tsx` 用 `useState` + `useReducer` 维护两类状态：

1. **会话状态**：输出行、当前 taskId、发送中标记（来自 WS 消息）。
2. **执行状态**：当前 task 的时间线对象（来自 WS `execution` 增量 + REST 全量合并）。

## 9. 实现步骤（5 步，每步独立可提交）

1. **前端骨架**：`web/` 子项目（Vite + React），三栏布局 + 空组件 + TokenGate，dev 能跑起来。
2. **Server 管理服务**：`src/management/`（HTTP + WS + 静态托管 + token + composition 实例锁），`src/cli/args.ts` 加 `web` 子命令，`src/index.ts` 走 web 分支（复用 composition）；同时把 gateway 的 per-connection 处理抽成 `session-transport-adapter`（含「连接建立/会话创建」两步）。
3. **对话桥接**：单例 session（第 4.4 节）+ WS 附着（经共享 adapter），先只推 `output` 文本，验证对话通、多 tab/重连上下文不丢。
4. **执行投影**：`execution-projector.ts` 按第 7.2 节映射（含 verification 推导），接 WS 增量推送 + REST 全量查询；**按第 7.3 节跑真实任务验证阶段切换都有触发，缺口挂底层事件**。
5. **配置 + 设置页**：`/api/config/*` 接 `ConfigurationService`（activate 带 baseRevisionId），前端 SettingsPanel 按第 8.2 节 scope 实现（含 probe 失败整页展示）。

## 10. 边界与不做什么

- **不重写执行链路**：Planner/Kernel/Executor 完全复用，Web 端只是输入口 + 观察面。
- **不做语义决策**：时间线是 durable 事实的只读投影，不含任何路由/调度逻辑。
- **配置只走 ConfigurationService**：不直写 config.yaml，不引入第二配置权威。
- **先本地**：绑 127.0.0.1，后续再考虑远程/多用户/Feishu。
- **不做**（本期）：Executor 工具调用级细粒度、WebSocket 固定轮询、数据库直写、第二套配置验证、apiKey 编辑与 secret store 接线（独立前置任务）。

## 11. 验收标准

- [ ] `metawork web` 启动后浏览器打开 `127.0.0.1:8788`，看到 TokenGate；粘贴终端 token 后进入三栏界面。
- [ ] 实例锁跨模式生效：TUI 运行中启动 `metawork web` 被拒绝（反之亦然）；SIGKILL 残留的 stale lock 能被 PID 探测回收。
- [ ] 鉴权通过前不创建 session（未授权连接不触发 initialize/recovery）。
- [ ] 两个 tab / 断线重连附着同一 session，对话上下文不丢；gateway 的 Unix socket JSONL 维持 per-connection 行为不变。
- [ ] 用户输入问题，对话区出现 Planner 回复，右侧时间线从 `planning` 推进到 `delivery`；verification 阶段按 receipt facts 推导，不会永远 pending。
- [ ] 时间线每个 subtask 卡片可展开，看到 Kernel 决策原因和 attempt 回执。
- [ ] 设置抽屉按第 8.2 节 scope 编辑，激活后顶栏 revision 更新，`GET /api/config` 返回新 revision；apiKey 无编辑入口且 apiKeyRef 只读。
- [ ] 激活失败（含 probe 失败）时逐条展示 issues，不静默；revision_conflict 时提示刷新重试。
- [ ] 不修改 config.yaml 直写路径；配置变更只经 `ConfigurationService`。
- [ ] 现有 `metawork` TUI 路径不受影响（实例锁除外——TUI 现在也取锁）。
- [ ] `npm run lint` / `npm run build` 通过；`web/` 内 `npm run build` 通过，且该步骤落入 `.github/workflows/ci.yml`。

## 12. 已决与挂起

**已决**：进程模型（复用主进程 composition）、实例锁（composition 层 runtime.lock，模式×锁覆盖矩阵：TUI/web/gateway 取锁、`--script`/admin 不取，PID 探测回收 stale）、gateway socket 归属（交互面，web 模式不启动）、会话基数（单例 session，鉴权通过前不创建）、设置页 scope（非密字段收缩）、apiKey 落点（本期无表单，挂起 secret store 前置任务）、token 传递（终端打印 + TokenGate + 首条消息鉴权）、模块归属（Application Shell 侧）、verification 推导规则、投影触发源保真度验证（第 4 步堵死缺口；例外授权 execution 落库点纯通知 hook）、权限升级呈现（对话内自然语言授权，无审批按钮）。

**挂起（独立前置任务，不在本期）**：secret store + runtime binding 生产接线（完成后再扩展设置页与 `POST /api/config/secrets`）。
