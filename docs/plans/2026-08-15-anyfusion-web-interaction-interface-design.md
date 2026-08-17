# AnyFusion Web 交互界面设计

> 状态：已实现
> 设计日期：2026-08-15
> 完成日期：2026-08-16
> 修订：2026-08-17（v5：所有 composition 模式统一取锁，Planner socket 增加活跃探测与所有权校验）
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
| `metawork --script` | 取 | 脚本同样创建 Session、Kernel、Runtime 和 Planner Host；必须在任何 socket cleanup 前被实例锁保护。smoke 等并行验证应使用独立 install root |
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

锁文件写入 PID；正常退出（含 SIGINT/SIGTERM handler）时清理。SIGKILL/断电无法清理，由第 2 步的 PID 存活探测回收——**这一步必须在任何 socket unlink 之前执行**，保证第二个实例在抢 planner socket 之前就被拒绝。`PlannerHostBridge` 还必须探测已有 socket 是否可达，并在 stop 时校验 socket inode 所有权；实例锁是主防线，socket 所有权校验是防御性兜底。详细契约见 [Web Interaction Trace And Planner Socket Reliability Design](2026-08-17-web-interaction-trace-and-planner-socket-reliability-design.md)。

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
| Server → 前端 | `{ type:'output', from, lines[] }` | 文本输出增量；`from` 是 `lines[0]` 的绝对行号（稳定游标） |
| Server → 前端 | `{ type:'execution', taskId, timeline }` | 执行时间线增量（核心新增） |
| Server → 前端 | `{ type:'error', message }` | 错误 |

**输出游标（防重连重复）**：新连接收到 `from=0` 的全量回放；前端不 append，而是按绝对行号幂等合并（同一行号覆盖同一内容）。重连回放因此天然去重，不需要事件 ID 协商。

**时间线补发**：增量广播只覆盖当时已连接的客户端；新连接在 `hello` 后立即收到一份当前时间线（若存在进行中的 task），不等到下一次状态变化。

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

### 8.2 设置页交互（已决：针对 AgentClass 的 Provider/Model 级联选择）

设置页**不单独编辑 Provider/Model 实体**，而是直接针对每个 AgentClass（planner、各 executor）配置其 Provider 与 Model——这才是配置的语义落点。

- **Provider 下拉**：预设 `Code CLI` / `Kimi` / `DeepSeek` 三个（baseUrl 与模型目录内置），外加 `Other（自定义）`。
- **Model 级联下拉**：选中 Provider 后展示该 Provider 底下的模型列表（预设目录内），用户选择。
- **Other 展开**：选中 Other 时才展开 Provider 名 / baseUrl / API Key / Model ID 输入（自定义）。

预设目录（`web/src/preset-providers.ts`）：

| Provider | baseUrl | 模型 |
| --- | --- | --- |
| Code CLI | `https://www.code-cli.cn/v1` | gpt-5.6-sol / gpt-5.6-terra |
| Kimi | `https://api.kimi.com/coding/v1` | k3 / kimi-for-coding / kimi-for-coding-highspeed / k3-256k |
| DeepSeek | `https://api.deepseek.com/v1` | deepseek-chat / deepseek-reasoner / deepseek-v4-pro |

凭证链路（前置任务已完成，见多 Provider 方案）：凭证只经 `POST /api/config/secrets` 写入 SecretStore，revision 只含 `apiKeyRef` 引用，任何 API 响应不回显明文。预设 Provider 的 API Key 在安装期/导入时已落 SecretStore，UI 不重复输入；仅 Other 需输入。

激活语义：针对 AgentClass 的选择组装成 `providers` + `models` + `agentClasses`（`modelPolicy.modelRef` 指向选中模型），走 validate → compile → probe → activate 闭环。`probeDraft` 真实执行 `codex --version` / `pi --version`，CLI 缺失导致任何激活失败，`probe_failed` 整页展示，不静默。

### 8.3 交互细节

- **对话**：发送后消息进流；Planner 规划说明、交付摘要、错误都落在对话区。对话内容按 Markdown 渲染（标题/表格/列表/代码块），模型输出经消毒后插入，链接强制 `target="_blank" rel="noreferrer"`。
- **对话内嵌执行轨迹（已决）**：时间线投影同时以「执行轨迹」卡片嵌入对话主视图——只展示可验证的 durable 执行事实（理解请求 → Planner 生成 N 个子任务 → Kernel 授权 → 分配给各 Executor → 验证 → 汇总交付），不展示模型 chain-of-thought。**默认紧凑一行摘要；任务进行中自动展开，完成后自动折叠；用户点击可随时覆盖，新任务出现时回到自动模式。** 右侧 Execution Timeline 面板保留，两者共用同一份投影数据。
- **时间线**：与对话同步推进——用户一提交，右侧立刻出现 `planning` 阶段，随授权/执行实时点亮。subtask 卡片状态色点（ready / running / done / blocked / failed），点开看 Kernel 决策原因和 attempt 回执（含失败错误码和详细原因）。
- **设置**：针对每个 AgentClass 选 Provider + Model（级联下拉）→ 整体激活。预设 Provider 无 apiKey 输入，仅 Other 展开输入。
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

**已决**：进程模型（复用主进程 composition）、实例锁（composition 层 runtime.lock，模式×锁覆盖矩阵：TUI/web/gateway 取锁、`--script`/admin 不取，PID 探测回收 stale）、gateway socket 归属（交互面，web 模式不启动）、会话基数（单例 session，鉴权通过前不创建）、设置页交互（针对 AgentClass 的 Provider/Model 级联下拉 + 预设 Code CLI/Kimi/DeepSeek + Other 自定义）、凭证链路（SecretStore 已接线，仅 Other 输入 apiKey）、token 传递（终端打印 + TokenGate + 首条消息鉴权）、模块归属（Application Shell 侧）、verification 推导规则、投影触发源保真度验证（第 4 步堵死缺口；例外授权 execution 落库点纯通知 hook）、权限升级呈现（对话内自然语言授权，无审批按钮）。

**已解决的前置任务**：secret store + runtime binding 生产接线已在 [多 Provider 与模型配置实施方案](2026-08-16-multi-provider-model-configuration.md) 完成（`POST /api/config/secrets` + 级联选择设置页均已落地）。

## 13. 实现记录

完成日期：2026-08-16。按 §9 五步实现，closing commits：

- 第 1 步（前端骨架）：`dcb54f6`（已预置于工作树）
- 第 2 步（管理服务 + 实例锁 + web 命令）：`e22ccd8`
- 第 3 步（对话桥接 + 单例 session）：`3b16c9d`
- 第 4 步（执行投影 + REST + WS）：`993af99`
- 第 5 步（配置端点 + 设置页）：`3fc4e14`
- CI（web build 门禁）：`380e903`

交付行为：

- `src/management/`：`server.ts`（HTTP + WS + 静态托管 + token + REST）、`lock.ts`（runtime.lock + PID 探测）、`token.ts`、`websocket.ts`（RFC 6455 最小实现）、`execution-projector.ts`（执行时间线投影）。
- `src/session/session-transport-adapter.ts`：抽取 gateway 的 per-connection 输出流，gateway 与 web 复用；gateway 行为不变。
- `src/cli/args.ts` + `src/index.ts`：`web` 子命令、composition 实例锁、web 分支（单例 session + HTTP/WS，不启动 gateway socket）。
- `web/`：Vite + React 子项目，三栏界面（对话 + 执行时间线 + 设置抽屉）+ TokenGate。
- `.github/workflows/ci.yml`：web 依赖安装 + build 门禁。

验证：

- `npm run lint` / `npm run build` 通过；`web/` 内 `tsc --noEmit` + `vite build` 通过。
- `tests/management/` + `tests/gateway/` 共 44 测试通过。
- 端点实测：静态托管、token 401、实例锁互斥（第二实例被拒 + PID 探测回收 stale）、WS 单例 session（多连接同一 sessionId）、`/api/config` active snapshot、`/api/execution/tasks` 空数据与 404。

未验证（挂起，需真实 planner + executor + 有效 provider 环境）：

- **§7.3 触发源保真度**：投影逻辑已单元测试覆盖，但「真实任务端到端每个阶段切换都有快照触发」未验证。当前触发源是 `session.subscribe`（不跨模块）；若实测出现缺口，按 §7.3 预授权在 execution 落库点新增纯通知 hook。
- 设置页 activate 的 probe → activate 闭环（需 `codex --version` / `pi --version` 可用）。

### 端到端测试（2026-08-16 补做）

用 `npm run smoke:anyfusion`（真实 Planner + Kernel + Executor，reasoning 模型 gpt-5.6-terra）验证完整执行链路：

- **执行链路真实工作**：`planner-session` 场景通过；`python-hello` 场景中 Planner 规划（`authorize_task_plan`）、Kernel 授权（`dispatch_batch`）、codex executor 真实创建 `hello.py` 并运行 `python3`（stdout 严格 `Hello world`）均通过。
- **投影在真实数据下正确**：对 smoke 产生的真实 durable 事实，五阶段推导为 `planning done / authorization done / execution blocked / verification failed / delivery pending`，与真实 subtask/receipt/decision 状态一致。
- **发现并修复两个执行链路问题（与 web 实现无关，`b4f8cfb`）**：
  1. Planner 默认超时 `60_000ms` 对 reasoning 模型偏小（单次响应约 24s，规划需多次调用）→ 调高为 `180_000ms`。
  2. completion contract 误判：`deliveryKind` 在 schema 里无语义说明，Planner 把「创建文件」误标为 `report` → 给 `deliveryKind` 加 `.describe()`（edit=改 workspace，report=只读不改 workspace）。修复后 `python-hello` 场景完整通过（任务 done，hello.py 正确创建并发布）。

**§7.3 触发源保真度仍未闭环**：上面验证的是投影逻辑（查询侧）在真实数据下正确，但「WS 增量在每次阶段切换时都有推送」仍需一次 web 模式下的真实任务观察；当前触发源是 `session.subscribe`，若出现停滞按 §7.3 预授权加 execution 落库点通知 hook。

### 对话体验加固（2026-08-16，`94f128b`）

针对已确认的三个对话层缺陷的修复与验证：

1. **Markdown 渲染**：`web/` 引入 `marked` + `dompurify`，整段输出作为单一 Markdown 文档渲染（标题/表格/列表/代码块），输出经消毒、链接强制新窗口。
2. **对话内嵌执行轨迹**：新增 `ExecutionTrace` 组件，从同一份 ExecutionTimeline 投影派生可验证执行步骤（理解请求 → Planner 生成 N 个子任务 → Kernel 授权 → 分配给各 Executor → 验证 → 汇总交付），不含模型 chain-of-thought。交互按确认方案：默认紧凑一行、运行中自动展开、完成后自动折叠、点击覆盖、新任务重置自动模式。
3. **重连重复回放**：`SessionStreamAdapter.onOutput` 携带绝对行号游标 `from`，WS 消息变为 `{ type:'output', from, lines }`，前端按下标幂等合并（`mergeOutputLines`），重连的 from=0 全量回放天然去重。
4. **顺带修复**：新连接补发当前执行时间线（此前增量广播只覆盖已连接客户端，重连后时间线空到下一次状态变化）；`AgentClassForm` 联合类型误取 `modelRef` 的预存在类型错误（`vite build` 不做类型检查所以长期未发现）。

验证：`tests/management/` 新增游标去重与时间线补发两个契约测试；协议级 E2E（真实 `ManagementServer` + 构建产物，REST/鉴权/双连接回放一致性/时间线补发）通过；`npm run lint`、`npm run build`、`web/` 内 `tsc --noEmit` + `vite build`、全量 `npm test`（233 文件 / 966 测试）通过。
