# AnyFusion Pi Planner 与原生 TUI 迁移计划

> 状态：待审核；尚未开始实现
> 计划日期：2026-07-31
> 完成日期：待实施完成后补写
> 目标产品名：AnyFusion；`MetaClaw` / `metaclaw` 继续作为内部运行时名称与兼容 CLI alias
> Pi fork 本地路径：`D:\Internships\AnyInt\AnyFusion-Pi`，与 `MetaClaw` 平级
> 初始上游基线候选：`earendil-works/pi@ec6311beb5b24fc918e5031173608447582d7262` / `0.80.2`
> 前序失败方案：[AnyFusion Codex 原生 TUI 定制迁移计划](../archive/plans/2026-07-30-codex-native-tui-migration.md)
> 核心边界：Pi 是 Planner 对话、查询和智能规划载体；MetaClaw Kernel 仍是唯一决策者，Execution/Executor 仍是唯一执行方

## 计划目的

以一个完整 fork 的 Pi 仓库替换已经终止的 AnyFusion-Codex Planner TUI 路线，交付：

1. 完全 AnyFusion 品牌、无用户可见 Pi 文案的原生终端界面；
2. 由 AnyFusion 固定管理模型、Provider、权限和发布版本的 Planner runtime；
3. 统一服务本地 TUI、Gateway、Feishu 和其他非交互入口的唯一 Planner 实现；
4. 只读 AnyFusion Task/Subtask/Executor 看板；
5. 经版本化 JSON 协议向 MetaClaw 提交 PlanningAgentPlan proposal；
6. 保持既有 Kernel、Work Graph、Storage、Execution、Executor、sandbox 和 Git publication 语义不变；
7. 保留 MetaClaw 现有 Ink TUI 源码、测试与依赖作为 standby 模块。

本计划只定义迁移、回滚、fork、接口、测试和发布工作。计划审核通过前不创建 fork、不回滚当前代码、不切换默认入口。

## 结论与已确认产品决定

本计划采用以下已经确认的产品决定，不在实施中重新讨论：

1. **统一 Planner runtime**：本地 TUI、Gateway、Feishu 和非交互入口全部使用 AnyFusion-Pi；不得保留 Codex Planner 作为并行 semantic router。
2. **只替换用户可见品牌**：所有用户和运维人员可见的 Pi 品牌、文案、路径、帮助、更新提示与产品链接替换为 AnyFusion；上游内部 package、import path、目录和 symbol 名可保留，以控制 fork 冲突。
3. **Planner 严格不执行用户工作**：Planner 只负责对话、只读查询、上下文获取和任务智能规划；不得编辑/写入用户项目，不得成为隐式 Executor。
4. **模型由 AnyFusion 固定管理**：用户不能自由登录 Provider、安装任意模型、切换账号或改变 Planner 权限；TUI 可以显示当前模型，但模型集合和凭证由 AnyFusion 配置决定。
5. **只保证 Linux runtime**：首期只交付 Linux 容器和 Linux 服务器；Windows 用户通过 Docker 使用，不设计原生 Windows Planner 进程或 named-pipe transport。
6. **仅作为 MetaClaw 自用 Planner 组件**：AnyFusion-Pi 不交付为独立用户产品，不维护 Pi 官方登录、账号 onboarding、OAuth/MFA 与多 Provider 用户体验等周边能力；只保留 MetaClaw 需要的对话、只读查询、规划与 proposal 能力。login/账号/onboarding 入口从 interactive 与 headless 两模式中入口级移除并加负向测试，代码保留以控制 upstream rebase 成本。完整 AnyFusion 品牌重做仍按 Phase 1/2 执行；Linux Planner artifact 仅服务 MetaClaw Docker，无公共发布渠道。

## 迁移依据与 Codex 路线终止

前序 Codex 方案的所有权和安全边界是正确的，但实现载体不可接受：

- Codex 是大型 Rust workspace；
- 本地无法在合理时间内完成编译；
- Linux 服务器经过数小时依赖下载和编译后仍未完成并出现资源饥饿；
- 为一项 Planner TUI 迁移承担该构建、发布和持续 rebase 成本不具备经济性；
- 继续投入不会改善 AnyFusion 的 Kernel 或 Executor 能力，只会扩大 presentation fork 的运维负担。

因此旧计划于 2026-07-31 标记为失败并归档。失败不推翻以下设计：

- Planner 提案、Kernel 决策、Executor 执行；
- Task 看板只读；
- Planner 与 MetaClaw 进程隔离；
- proposal 必须重新进入既有 validation 和 KernelWorkflow；
- Ink TUI 保留；
- Executor runtime 不随 Planner TUI 一同迁移。

Pi `0.80.2` 已在本机 Docker 完成源码级可行性验证：TypeScript 编译为秒级，底层 TUI 672 项测试通过，重点 interactive 测试 149 项通过，2 CPU/2 GB 限制下的构建与重点测试可在一分钟内完成。Pi 的主要风险是 TUI 耦合、默认在线模型目录生成和 fork 范围，而不是大规模原生编译。

## 权威文档与所有权

实施必须遵守：

- [ADR-0015：Planner-Owned Semantics And Tool-Mediated Context](../adr/0015-planner-owned-semantics-and-tool-mediated-context.md)
- [ADR-0020：Core Module Ownership And Dependency Direction](../adr/0020-core-module-ownership-and-dependency-direction.md)
- [ADR-0021：Work Graph v4 Subtask Execution Contract](../adr/0021-work-graph-v4-subtask-execution-contract.md)
- [ADR-0022：Unified Kernel Control Plane And Decision Ledger](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md)
- [ADR-0023：Durable Kernel Workflow, Recovery And Availability](../adr/0023-durable-kernel-workflow-recovery-and-availability.md)
- [ADR-0024：Resource Partition, Sandbox And Runtime Elevation](../adr/0024-resource-partition-sandbox-and-runtime-elevation.md)
- [ADR-0025：Single-Task Concurrency And Git Publication](../adr/0025-single-task-concurrency-and-git-publication.md)
- [ADR-0026：Phase 6 Single-Task Reliability Closure](../adr/0026-phase-6-single-task-reliability-closure.md)
- [`CONTEXT.md`](../../CONTEXT.md)
- [当前技术总览](../current/technical-overview.md)

本计划不修改上述 ADR 的职责分配，只替换 Planner runtime adapter 和默认本地 presentation adapter。

## 不可突破的边界

### 1. Planner 只拥有语义理解和 proposal

AnyFusion-Pi 可以：

- 与用户自然语言对话；
- 维护 Planner conversation history；
- resume、fork、archive 和 compact Planner conversation；
- 查询受控的只读 Planner MCP；
- 读取显式提供的 repo/context 文件；
- 在只读 sandbox 中搜索和分析；
- 生成 `direct_reply`、`clarification`、`task_control`、`no_action` 或 `plan_work_graph` proposal；
- 通过 Application Shell adapter 提交 proposal。

AnyFusion-Pi 不可以：

- 直接写 MetaClaw SQLite；
- 直接调用 Repository；
- 直接发 Kernel event；
- 直接创建、更新或取消 Task/Subtask；
- 直接调度、切换、暂停或恢复 Executor；
- 直接处理 retry、fallback、replan、permission、availability 或 recovery policy；
- 直接编辑或写入用户项目；
- 直接提交 Git commit、发布 artifact 或完成 Subtask；
- 从 transcript、工具文案或自然语言回答推断权威 Task 状态；
- 通过 extension、MCP、slash command 或 shell 绕过 proposal validation。

### 2. Kernel 完全不变

不得修改：

- `ControlKernel.decide(event, snapshot)` Interface；
- Kernel event/snapshot/decision v5 语义；
- `DurableKernelWorkflow` 的 inbox、ledger、application、apply、replay 和幂等语义；
- Task admission、dispatch、retry、fallback、replan、availability、permission 和 cancellation policy；
- Work Graph v5 状态机、图规则、handoff、completion 和 publication contract。

TUI、Pi extension、Pi RPC adapter 和 Planner runner 均不得成为第二个 policy owner。

### 3. Execution 与 Executor 完全不变

不得修改：

- `src/execution/` 的 attempt、sandbox、lease、recovery、publication 和 Git 逻辑；
- `src/executor/` 的 AgentClass、registry、image、permission profile 和 probe 逻辑；
- Codex/Pi Executor 的执行协议；
- Docker sandbox、workspace、resource partition 和 capability security contract；
- Executor 使用的 stock Codex 或 Pi attempt runtime。

Planner fork 和 Planner Node 22 runtime 不得进入 Executor attempt image。

### 4. Storage contract 完全不变

本计划不新增：

- SQLite schema；
- Planner 专属 Task 状态；
- TUI 专属 durable state；
- Pi session 到 Task 的重复权威映射表；
- 为看板服务的第二套状态存储。

Pi conversation 文件属于 Planner runtime；Task/Kernel/Executor facts 仍属于 MetaClaw storage。

### 5. Ink TUI 必须保留

`src/tui/` 继续作为显式 standby 模块：

- 保留源码、fixture、测试源码和 Ink/React 依赖；
- 不归档、不删除、不改造成 Pi compatibility shim；
- 不要求与新 TUI 同步新增功能；
- 不承诺本计划内持续可运行或提供即时 hard rollback；
- 未来删除或恢复必须另立计划并单独批准。

## 仓库结构

### AnyFusion / MetaClaw

路径：

```text
D:\Internships\AnyInt\MetaClaw
```

负责：

- PlanningAgent Interface；
- AnyFusion-Pi process lifecycle adapter；
- Linux Unix-socket JSONL bridge；
- headless Pi RPC client adapter；
- Session 到 Pi session identity 的映射与单 writer 协调；
- Planner-safe snapshot projection；
- PlanningAgentPlan v6 authoritative validation；
- `plan_proposed -> DurableKernelWorkflow -> ControlKernel`；
- Docker runtime 装配、版本 pin 和集成测试。

MetaClaw 不保存 Pi 源码，不 import Pi package，不依赖 Pi 的 TypeScript 类型作为内部编译依赖。

### AnyFusion-Pi

计划路径：

```text
D:\Internships\AnyInt\AnyFusion-Pi
```

负责：

- 完整 Pi upstream fork；
- AnyFusion 品牌和 binary；
- AnyFusion 原生 Planner TUI；
- Planner conversation/session/history/compaction；
- 固定模型和 Provider 配置；
- Planner-only tool catalog；
- read-only dashboard client；
- proposal envelope finalizer；
- interactive 和 RPC 两种运行模式；
- Linux build、test、package；Linux Planner artifact 仅服务 MetaClaw Docker（无公共发布渠道）；
- upstream pin、patch series 和按需升级说明。

建议远端仓库名为 `MetaAny/anyfusion-pi`；创建远端属于实施阶段，不在本计划编写阶段执行。

### AnyFusion-Codex

`D:\Internships\AnyInt\AnyFusion-Codex` 和远端 `MetaAny/anyfusion-codex` 进入停止开发状态：

- 不继续编译或增加功能；
- 在 Pi 替代路线通过验收前不删除；
- 保留作为失败路线和已有 patch 的历史证据；
- Pi 默认切换并完成观察期后，再单独确认是否 archive/delete 远端。

## 目标运行结构

```text
Local terminal / Docker PTY
        |
        v
AnyFusion-Pi interactive process (Node 22, Linux)
  - AnyFusion TUI
  - conversation/session/history/compact
  - Planner-only read/query tools
  - read-only Task dashboard
  - proposal envelope finalizer
        |
        | mode-0600 Unix socket, versioned JSONL
        v
MetaClaw Application Shell (Node 20)
  - process lifecycle
  - Session projection
  - authoritative proposal validation
  - single-writer/session coordination
        |
        v
plan_proposed -> DurableKernelWorkflow -> ControlKernel
        |
        v
Execution -> Executor attempts -> publication
```

非交互入口：

```text
Gateway / Feishu / backend client
        |
        v
MetaClaw Application Shell
        |
        | stdin/stdout JSONL RPC
        v
AnyFusion-Pi headless process (same fork, same policy/config)
        |
        | raw proposal returned to Application Shell
        v
same validation -> same Kernel path
```

本地 interactive 和 backend RPC 使用相同的：

- AnyFusion-Pi upstream pin；
- system prompt；
- PlanningAgentPlan v6 contract；
- tool policy；
- Provider/model 配置；
- repair/clarification 规则；
- session format；
- audit vocabulary。

它们是同一 Planner module 的两个 adapter，不是两套 semantic router。

## 进程与 Session contract

### 进程隔离

- MetaClaw 使用 Node 20；AnyFusion-Pi 使用 Node 22.19+；
- 两个仓库独立安装、构建、测试和发布；
- 不共享 `node_modules`；
- 不通过源码 import 或 workspace link 集成；
- 只通过版本化 JSON、环境变量、只读 schema/artifact 文件和进程退出码通信；
- Planner crash 不得导致 Kernel ledger、Task state 或 Executor attempt 损坏。

### PTY 与 transport

Pi interactive TUI 必须独占终端 stdin/stdout，因此：

- interactive 模式使用 Unix domain socket 作为控制/状态 side channel；
- socket 默认权限必须是 `0600`；
- headless RPC 模式使用 stdin/stdout JSONL；
- stderr 仅用于可诊断日志，不承载协议；
- 协议数据不得混入 TUI render stream；
- 首期不实现 Windows named pipe。

### Session identity

- 一个 live MetaClaw `sessionId` 映射到一个 Pi Planner session identity；
- Pi 拥有 conversation entries、history、fork、archive 和 compaction；
- MetaClaw 不把 SQLite interaction history 重放成 prompt；
- MetaClaw 只记录必要的 Planner run audit、continuation/session identity 和 redacted tool summary；
- 同一 Pi session 同一时刻只能有一个写进程；
- interactive 和 RPC process 不得并发写同一个 Pi session 文件；
- Application Shell 负责 serialize、attach、shutdown 和异常恢复；
- surface takeover 必须先关闭或释放原 writer，再由新 adapter attach；
- session 文件损坏或不可恢复时 fail closed，不静默创建第二个 conversation 并继续原 Task。

## Planner Host Protocol

协议必须有独立版本，不直接复用 Pi 内部 event type 作为 MetaClaw contract。

建议首版：

```text
AnyFusionPlannerHostProtocol v1
```

最小消息：

- `hello`：协议版本、runtime version、session identity、mode；
- `ping` / `pong`；
- `prompt`：backend surface 提交用户输入；
- `interrupt`：只中断 Planner turn，不取消 Task/Executor；
- `snapshot_get`；
- `snapshot_subscribe`；
- `snapshot`：只读 Planner-safe projection；
- `proposal_submit`：用户输入、raw plan、turn/session correlation；
- `proposal_result`：accepted/rejected、errors、plan id；
- `planner_event`：bounded、redacted 的状态/错误事件；
- `shutdown`。

协议要求：

- JSONL framing；
- 最大单行 1 MiB；
- request id 和 turn id correlation；
- schema version 拒绝而不是猜测兼容；
- malformed/oversized message fail closed；
- proposal 顺序串行；
- snapshot 可以丢弃中间帧，但 proposal response 不可丢失；
- 不传输数据库 handle、Repository 对象、Kernel object 或 Executor control capability；
- 协议 fixture 同时在两个仓库验证，防止 silent drift。

## Proposal finalizer

### 目标

Pi native conversation 必须保留用户友好的自然语言显示，同时每个需要进入 MetaClaw 的 turn 产生一个严格的 PlanningAgentPlan v6 proposal。

### 建议实现

在 AnyFusion-Pi fork 内增加 Planner 专属 finalizer：

1. system prompt 要求模型返回内部 proposal envelope；
2. `agent_end` 后由 AnyFusion extension/composition adapter 读取最终 assistant message；
3. adapter 提取 raw v6 plan，不直接修改任何业务状态；
4. 用户可见 transcript 只渲染 display text、clarification 或 direct reply，不显示内部 JSON；
5. raw plan 经 Host Protocol 交给 MetaClaw；
6. MetaClaw 使用现有 catalog、pending authorization 和 `PlanningAgentPlanSchema` 重新校验；
7. 只有验证通过才进入现有 `plan_proposed` 路径。

禁止为了 structured output 修改 Pi agent loop、message persistence protocol 或 MetaClaw Kernel contract。若 extension/composition seam 无法实现，应先做窄 fork seam；若仍需广泛修改 agent core，必须停止并重新评审。

### 失败语义

- raw plan 缺失或语法错误：同一 Planner turn 最多一次受控 repair；
- repair 后仍无效：返回 clarification/fail closed；
- MetaClaw authoritative validation 拒绝：TUI 显示拒绝原因，不产生 Kernel event；
- bridge unavailable：对话可显示 unavailable，但不得假装 Task 已创建或控制已执行；
- duplicate proposal：通过 turn/request id 去重；
- Planner timeout/crash：保留 conversation recovery 信息，不合成 fallback plan；
- 不恢复旧 schema，不增加 keyword fallback 或第二个 natural-language parser。

## Planner 工具与权限

### 允许

- 现有只读 Planner MCP；
- `search_tasks`；
- `get_task_context`；
- `get_current_session_context`；
- `get_runtime_state`；
- `list_executor_status`；
- `get_executor_diagnostics`；
- 受控的文件读取、目录枚举、文本搜索；
- 在只读 workspace/sandbox 中执行经过 allowlist 的诊断命令；
- 读取明确传入的附件和上下文。

### 禁止

- Pi 原生 `edit` 和 `write`；
- 不受限 `bash`；
- `git commit`、`git push`、branch mutation；
- package/extension install、remove、update；
- 任意网络下载作为默认 Planner 行为；
- 修改 MetaClaw、用户仓库或 Planner config；
- write-capable MCP；
- Task/Executor mutation tool；
- 通过 shell 访问 Docker socket、MetaClaw database 或 Executor workspace；
- 把 approval UI 当作越过 Kernel permission contract 的授权入口。

Planner read-only shell 的具体 allowlist 和只读 mount 必须沿用 ADR-0015/ADR-0020 的 tool-mediated context 原则。不能因为 Pi 原生提供 coding tools 就保留它们。

## Provider、模型与配置

AnyFusion 管理所有 Planner runtime 配置：

- 固定 Provider base URL、模型 catalog 和默认模型；
- 凭证通过独立 Planner env/config 注入；
- 用户可查看当前模型，但不能登录任意 Provider 或切换账号；
- login、onboarding、账号管理和多 Provider 用户体验入口从 interactive 与 headless 两模式中入口级移除，并配负向测试；代码保留以控制 upstream rebase 成本；
- `/model` 若保留，只能在 AnyFusion allowlist 中选择；首期默认隐藏交互式切换；
- 禁用 self-update、version check、telemetry 和 upstream announcement；
- 禁用 Pi package manager 和任意 extension 安装入口；
- Planner config home 使用 AnyFusion 路径，不暴露 `.pi` 产品路径；
- Pi 内部 package/import 名可以保留；
- Executor 的 Provider/model 配置与 Planner 配置继续隔离。

默认源码构建不得联网刷新模型 catalog。生成的模型数据必须随 upstream pin 锁定；模型 catalog 更新是显式、可审核的独立操作。

## AnyFusion 原生 TUI

### 完整替换原则

本计划不是“保留 Pi TUI 加一个 extension”。AnyFusion-Pi 维护完整的 Planner presentation：

- AnyFusion 欢迎页、标题、状态栏、帮助和错误信息；
- AnyFusion conversation transcript；
- AnyFusion composer、completion 和快捷键提示；
- AnyFusion tool/approval rendering；
- AnyFusion session/history/resume/fork/archive/compaction UI；
- AnyFusion Task dashboard；
- AnyFusion provider/model 状态展示；
- AnyFusion branding assets、主题和 terminal title。

保留 Pi 原生 agent/session 能力，但不保留任何用户可见 Pi、Earendil、Mario、Dax、Clank 或 upstream promotion 文案。

### 基础布局

默认采用响应式双栏：

```text
┌──────────────────────────────────────────────────────────────────┐
│ AnyFusion header / Planner session / current model               │
├──────────────────────────────────────┬───────────────────────────┤
│ Conversation transcript              │ Read-only Task dashboard  │
│ tool/query rendering                 │ Task/Subtask/Executor      │
│ clarification/proposal feedback      │ progress/blocked/diagnostic│
├──────────────────────────────────────┴───────────────────────────┤
│ Composer / completion / status / key hints                       │
└──────────────────────────────────────────────────────────────────┘
```

响应式规则：

- 宽终端默认显示右侧 dashboard；
- 中等宽度允许折叠和手动 toggle；
- 窄终端使用 overlay 或独立 panel view；
- dashboard 不得挤压 composer 到不可用；
- dashboard render failure 不得中断 conversation；
- 不要求复刻现有 Ink TUI 的每个动画或像素。

### 看板首期字段

首期争取展示：

- 当前 Task ID、标题、目标和状态；
- ready/running/blocked/parked 数量；
- 当前 Subtask、依赖和 active attempt；
- 当前 Executor/AgentClass；
- blocked reason；
- pending authorization；
- 最近 Kernel/Task event；
- 最近 Executor diagnostic；
- completion、artifact 和 publication 状态；
- stale/unavailable/reconnecting 指示。

数据不足时缩小字段，不新增 Kernel event、Storage schema 或 Executor semantics。

### 看板只读要求

- 只消费 Session 提供的 Planner-safe projection；
- 不直接读取 SQLite；
- 不从 Pi conversation 推断状态；
- 不提供 start/stop/retry/switch executor mutation button；
- 用户的 Task 控制意图仍通过自然语言 Planner proposal 或现有确定性命令进入 MetaClaw；
- dashboard polling/subscription 必须 bounded；
- stale snapshot 必须显示时间/状态，不伪装为实时事实。

## 品牌替换范围

必须建立用户可见字符串 inventory 和 allowlist 测试。

应替换：

- binary 和启动帮助中的 `pi`；
- welcome、help、footer、error、notification、announcement；
- terminal title；
- docs/support/update/privacy/telemetry 链接；
- theme schema title/description；
- session/config/cache 路径中用户可见部分；
- User-Agent 和可观测 runtime 名；
- package artifact 和 Docker image 展示名；
- upstream mascot、ASCII art 和图片；
- 模型可能读取并复述的 Pi 自我说明；
- command examples 和 shell completion 文案。

可以保留：

- `@earendil-works/pi-*` 内部依赖名；
- upstream package 目录；
- 不进入日志、帮助、UI 或用户文件的内部 symbol；
- 为 upstream rebase 必须保留的非产品注释。

若内部名字通过 stack trace、session 文件、config path、telemetry、HTTP header 或错误信息暴露给用户，则视为用户可见，必须替换或过滤。

## 源码与构建策略

### Fork 策略

- fork 整个 Pi monorepo；
- 保留 `upstream` remote；
- 固定 commit/tag，不使用浮动 `main`；
- 初始候选 pin 为已实测的 `0.80.2/ec6311b...`；
- Phase 0 最终确认 pin 后写入两个仓库；
- 不把完整源码 vendor 到 MetaClaw；
- 不依赖 Pi self-update；
- AnyFusion 发布只来自受控 CI/server build。

### Patch series

建议保持以下独立提交序列：

1. `chore: establish AnyFusion Planner fork baseline`
2. `build: add deterministic offline Planner build`
3. `feat(branding): replace user-visible Pi product identity`
4. `feat(planner): enforce AnyFusion model and tool policy`
5. `feat(tui): add AnyFusion Planner layout`
6. `feat(tui): add read-only Task dashboard`
7. `feat(planner): add proposal envelope finalizer`
8. `feat(protocol): add AnyFusion Planner host adapter`
9. `test: add branding, protocol and Planner boundary coverage`
10. `build: package pinned Linux Planner artifact`

禁止在 branding/TUI commit 中混入 agent loop、session storage、provider core 或 sandbox 语义修改。

### 可复现构建

必须新增 AnyFusion 专用离线构建命令：

```text
build:anyfusion-planner
  -> build pi-tui
  -> compile pinned pi-ai generated sources，不访问外部 model catalog
  -> build pi-agent-core
  -> build pi-coding-agent
  -> copy AnyFusion assets/config/schema
  -> produce Linux Planner artifact
```

不得在普通构建中调用 models.dev、OpenRouter、NVIDIA、Vercel 或其他动态 catalog API。

### Docker 缓存

- package manifests 在源码前 COPY；
- `npm ci` 使用 BuildKit cache；
- UI 源码变化不得破坏 dependency layer；
- build/test stage 与 runtime stage 分离；
- runtime artifact 不携带完整源码和 dev dependencies；
- Node 22 runtime 不进入 MetaClaw Node 20 dependency graph。

### 构建预算门

Phase 0 基线目标：

- 冷构建在本机 Docker 10 分钟内完成；
- 有依赖缓存的 UI 增量 build + focused tests 在 60 秒内完成；
- 2 CPU / 2 GB 内存下 focused gate 可以通过；
- 不需要 Rust、Cargo 或大型 native workspace 编译；
- 若连续两次正常网络冷构建超过 15 分钟，停止扩大 fork 并调查依赖闭包。

## MetaClaw 现有 Codex 迁移回滚与替换

不得 reset `QC` 或改写已推送历史。实施使用正常 revert/refactor commit，并保留无关工作。

### 删除的 Codex 专属内容

预计删除或恢复：

- `docker/anyfusion-codex.lock.json`；
- `docker/codex-config/planner/config.toml` 中 downstream TUI 专属配置；
- `scripts/anyfusion-planner-stop-hook.mjs`；
- `METACLAW_PLANNER_CODEX_HOME` 和 AnyFusion-Codex launcher 配置；
- AnyFusion-Codex binary/image pin；
- Codex Stop Hook 装配；
- Codex fork server handoff 文档；
- 只服务 Codex bridge/hook 的测试。

### 保留并泛化的内容

当前 `8413583` 中以下设计可以保留但必须去 Codex 命名：

- mode-`0600` Unix JSONL local bridge；
- `PlannerTuiSnapshot` 的只读 Session projection 思路；
- `submitPlannerTuiPlan` 中重新执行 v6 schema/semantic validation；
- proposal submission serialization；
- default native Planner process + standby Ink mode selection；
- planning-to-kernel path regression tests。

建议重命名为 vendor-neutral interface，例如：

- `PlannerSurfaceBridge`；
- `PlannerSurfaceSnapshot`；
- `submitPlannerProposal`；
- `PlannerProcessAdapter`；
- `AnyFusionPlannerHostProtocol`。

这些 adapter 仍属于 Application Shell/presentation seam，不进入 Planning policy、Kernel 或 Storage owner。

### 替换的 Planner runtime

- `CodexPlanningAgent` 替换为基于 AnyFusion-Pi RPC 的唯一 PlanningAgent implementation；
- `planner-codex-runner.ts` 替换为 Pi headless RPC runner；
- native Codex thread/session identity 替换为 Pi Planner session identity；
- Planner `CODEX_HOME` 替换为隔离的 AnyFusion Planner home；
- Planner MCP 保持只读；
- Executor Codex 配置、attempt image 和 runtime 不变。

## 分阶段实施

### Phase 0：冻结 Codex 路线与 Pi fork 可维护性 spike

目标：在修改 MetaClaw 默认路径前证明 fork、build、TUI composition 和 Planner restriction 可成立。

工作：

1. 标记并归档 Codex 计划；
2. 冻结 AnyFusion-Codex 开发；
3. 创建 `D:\Internships\AnyInt\AnyFusion-Pi`；
4. 设置 origin/upstream 并记录 pin；
5. 建立 Node 22 Linux Docker build；
6. 增加离线 deterministic build；
7. 修改一处品牌和一个静态 dashboard slot；
8. 禁用 edit/write/package install/provider login；
9. 证明 interactive 与 RPC 使用相同 Planner配置；
10. 执行一次小范围 upstream 前进/rebase 演练并记录冲突。

退出条件：

- 不修改 Pi agent loop、session persistence protocol 或 provider core 即可完成；
- build/test 满足预算；
- 用户可见品牌替换可通过 inventory test；
- read-only tool policy 可强制执行；
- fork 冲突主要集中在 branding、interactive composition、Planner adapter 和 packaging。

### Phase 1：AnyFusion 品牌与受控 Planner runtime

- 替换用户可见产品身份；
- 建立 AnyFusion binary/config/cache/session 路径；
- 入口级移除 login、onboarding、账号管理和多 Provider 用户体验（代码保留以控制 rebase 成本）；禁用 self-update、telemetry、announcement 和 package manager；
- 固定 Provider/model；
- 建立 Planner-only tool catalog；
- 保留 conversation/history/resume/fork/archive/compaction；
- 添加品牌和权限负向测试；
- 尚不接入真实 Task dashboard 或 MetaClaw proposal。

### Phase 2：AnyFusion 原生 TUI

- 建立完整 header/transcript/composer/footer layout；
- 保留必要的 native conversation、tool rendering、interrupt、completion 和 session behavior；
- 增加响应式 dashboard composition seam；
- 实现宽/中/窄终端布局；
- 增加 snapshot/render tests；
- 不读取 MetaClaw，不修改业务状态。

### Phase 3：Planner Host Protocol 与只读看板

- 在 MetaClaw 泛化现有 Unix bridge；
- 在 AnyFusion-Pi 增加 protocol client；
- 接入 snapshot_get/subscribe；
- 展示 Task/Subtask/Executor/diagnostics；
- 实现 loading、stale、unavailable、reconnect；
- 验证 dashboard failure 不影响 conversation；
- 不增加 mutation message。

### Phase 4：Proposal finalizer 与统一 PlanningAgent

- 实现 proposal envelope finalizer；
- MetaClaw authoritative validation；
- 一次 bounded repair；
- 替换 Codex PlanningAgent/runner；
- Gateway/Feishu 使用 Pi RPC；
- local TUI 使用同一 system prompt、schema、tool policy 和 model；
- 确认不存在第二个 Planner implementation；
- 保留既有 `plan_proposed -> KernelWorkflow` 路径。

### Phase 5：Codex TUI 回滚与默认入口切换

- 选择性撤销 `8413583` 的 Codex-only 内容；
- 保留并泛化 vendor-neutral bridge/validation；
- 删除 Codex Stop Hook 和 downstream lock；
- MetaClaw 默认启动 AnyFusion-Pi Planner artifact；
- `anyfusion` 与 `metaclaw` compatibility alias 使用同一默认入口；
- Ink TUI 继续 standby；
- Executor runtime 无变化。

### Phase 6：Linux 发布与观察期

- 生成带 upstream commit、AnyFusion commit 和 digest 的 Linux artifact（仅服务 MetaClaw Docker，无公共发布渠道）；
- 在服务器运行真实 PTY smoke；
- 验证 Gateway/Feishu RPC；
- 验证 session resume/fork/archive/compaction；
- 验证 dashboard degradation；
- 验证 proposal reject/repair/timeout/crash；
- 运行 bounded 观察期；
- 不删除 AnyFusion-Codex 或 Ink TUI；
- 观察期后再单独决定废弃仓库清理。

本计划没有自动删除旧仓库或旧 Ink TUI 的 Hard Cut 阶段。

## Upstream 更新策略

AnyFusion-Pi 是 MetaClaw 自用组件，不设定期升级、不建立公共 release 渠道；升级按需触发（上游安全修复、关键缺陷或 MetaClaw 需求），并按固定顺序执行：

1. 记录当前 upstream pin、AnyFusion patch series 和 artifact digest；
2. checkout 新 upstream 候选，构建并测试未应用 AnyFusion patch 的 upstream；
3. 验证 deterministic offline build；
4. 依次应用 branding、Planner policy、TUI/dashboard、proposal/protocol patches；
5. 运行 upstream session/RPC/interactive tests 与 AnyFusion branding/tool-denial/dashboard/proposal tests；
6. 运行 MetaClaw bridge 和 Kernel regression；
7. 全部通过才更新默认 pin。

升级范围以冲突预算为界：若 fork delta 扩散到 agent loop、session storage、provider core、sandbox 或 MetaClaw Kernel，应暂停升级并缩小需求，而不是扩大长期 fork。无升级需求时不主动跟进上游。

## 测试计划

### AnyFusion-Pi build gate

- `npm ci --ignore-scripts` 可复现；
- offline build 不访问动态 model catalog；
- Node 22 Linux build；
- 2 CPU/2 GB focused build/test；
- dependency cache 命中后的增量预算；
- artifact 可输出版本、upstream commit 和 AnyFusion commit。

### Pi 原生能力回归

- conversation 新建、resume、fork、archive；
- manual/automatic compaction；
- completion、interrupt、tool rendering；
- session recovery；
- RPC prompt/event/idle/shutdown；
- 不同终端尺寸；
- Linux PTY input、resize、signal 和 exit。

### 品牌回归

- 欢迎页、标题、帮助、错误、状态栏、链接和 assets；
- `pi`、Earendil、upstream mascot/announcement 的用户可见字符串扫描；
- binary/config/session/cache/user-agent 名；
- stack trace 和错误输出过滤；
- 仅允许内部 dependency/import allowlist 出现 upstream 名。

### Planner 权限负向测试

必须证明：

- edit/write 不注册；
- unrestricted bash 不可用；
- package/extension install/update 不可用；
- provider login/account switch 不可用；interactive 与 headless 均无法触达 login/onboarding/账号入口；
- Task/Executor mutation 不可用；
- Planner 无法访问 SQLite、Docker socket 或 Executor workspace；
- dashboard 不产生 mutation；
- proposal bridge 不能直接生成 Kernel decision；
- 模型诱导和 prompt injection 不能恢复被禁工具。

### TUI 与 dashboard

- 宽/中/窄布局；
- show/hide/collapse/overlay；
- loading/stale/unavailable/reconnect；
- snapshot burst/coalescing；
- conversation 在 dashboard failure 下继续；
- stale data 不显示为实时；
- Task/Subtask/Executor 字段只来自 projection；
- 无 mutation button 或隐藏快捷键。

### Proposal 与 protocol

- valid proposal accepted；
- invalid schema rejected；
- catalog/authorization semantic failure rejected；
- one repair then clarification；
- duplicate turn id 去重；
- oversized/malformed JSONL rejected；
- socket permission `0600`；
- protocol version mismatch rejected；
- Planner crash/restart；
- Session writer takeover；
- bridge unavailable；
- proposal accepted 后仍只通过既有 KernelWorkflow。

### Unified Planner surfaces

- local TUI、Gateway、Feishu 产生同一 v6 contract；
- 三个入口使用相同 Provider/model、system prompt 和 tool policy；
- 同 session 不并发写 Pi session file；
- Gateway/Feishu 不回退 Codex Planner；
- local TUI unavailable 不引入关键词或旧 schema fallback；
- 两轮 conversation 在同一 Pi session 上保持上下文。

### MetaClaw 核心回归

- `npm run lint`；
- focused Planner/Session/bridge tests；
- Docker full Vitest；
- container build；
- Planner-to-Kernel path；
- Kernel/Execution/Executor/storage regression；
- smoke:anyfusion conversation；
- artifact smoke；
- Git diff 不包含未经独立批准的 Kernel/Execution/Executor 逻辑修改。

## 安全与故障降级

- Planner socket `0600`；
- Planner env/config 不复用 Executor secrets；
- protocol 日志 redacted；
- proposal 和 snapshot 有大小上限；
- dashboard client 断开只影响展示；
- Planner process crash 不取消已运行 Task；
- MetaClaw shutdown 负责终止/回收 Planner child；
- orphan Pi writer 必须在 attach 前检测；
- session corruption fail closed；
- 不自动下载 extension、model、binary 或 update；
- Planner artifact 必须 pin digest；
- 不把 Planner tool approval 映射成 Kernel permission approval。

## 明确不做

- 不保留 Codex Planner 作为 fallback semantic router；
- 不修改 Kernel、Work Graph、Storage、Execution 或 Executor contract；
- 不修改 SQLite schema；
- 不让 Planner 编辑用户项目；
- 不让 Planner直接完成 Subtask；
- 不新增 write-capable Planner MCP；
- 不在首期支持原生 Windows Planner；
- 不实现 Windows named pipe；
- 不开放用户 Provider 登录和任意模型切换；
- 不开放 Pi package/extension marketplace；
- 不维护 Pi 官方登录、账号 onboarding、OAuth/MFA 与多 Provider 用户体验；
- 不建立独立公共发布渠道（Linux Planner artifact 仅服务 MetaClaw Docker）；
- 不把完整 Pi 源码复制进 MetaClaw；
- 不删除 Ink TUI；
- 不立即删除 AnyFusion-Codex 仓库；
- 不要求复刻 Ink TUI 的全部视觉细节；
- 不在本计划中升级 MetaClaw Node 20 runtime。

## 文档影响

实施时需要同步：

- `CONTEXT.md`：Codex PlanningAgent/thread 改为 AnyFusion-Pi Planner session/runtime；
- `AGENTS.md`：默认本地表面、进程隔离、fork build 和验证规则；
- `docs/current/technical-overview.md`；
- `docs/current/technical-overview.zh-CN.md`；
- `docs/README.md`；
- Planner/Executor 配置说明；
- Docker/server deployment；
- AnyFusion-Pi 按需升级说明（无公共 release 渠道）；
- AnyFusion-Pi 自身 `AGENTS.md`、README 和 architecture notes。

不得借文档同步改变 Kernel/Executor ownership。

## 停止条件

出现以下任一情况必须停止当前 phase 并重新评审：

- 需要修改 Pi agent loop 才能提交 proposal；
- 需要修改 Pi session persistence protocol 才能显示 AnyFusion TUI；
- 需要让 Planner 获得 edit/write/unrestricted shell；
- 需要让 dashboard 直接读 SQLite 或控制 Executor；
- 需要修改 MetaClaw Kernel、Execution 或 Executor 才能接入；
- interactive 和 RPC 无法共享同一 Planner semantic implementation；
- 同一 Pi session 无法建立可靠 single-writer contract；
- fork delta 持续扩散到 provider core、sandbox 或无关 package；
- 有缓存增量 build/test 不能控制在合理分钟级；
- 用户可见 Pi 品牌无法通过 bounded patch 隐藏；
- upstream 更新一次即要求大面积重写 agent core。

## 完成标准

- `AnyFusion-Pi` 完整 fork 存在于 MetaClaw 平级目录并记录 upstream pin；
- 用户界面、帮助、路径、链接和 artifact 无用户可见 Pi 品牌；
- 本地 TUI、Gateway、Feishu 使用唯一 AnyFusion-Pi Planner runtime；
- Planner 模型和 Provider 由 AnyFusion 固定管理；
- Planner 无 edit/write、unrestricted shell、package install 或 Task mutation 能力；
- conversation、history、resume、fork、archive 和 compaction 可用；
- AnyFusion 响应式 TUI 和只读 dashboard 可用；
- dashboard failure 不影响 conversation 或 Task 执行；
- proposal 经 MetaClaw authoritative validation 后进入既有 KernelWorkflow；
- Kernel、Work Graph、Storage、Execution、Executor 和 sandbox 设计无变化；
- MetaClaw Node 20 与 Planner Node 22 进程隔离；
- Linux Docker/server build、test、PTY smoke 通过；
- offline deterministic build 不访问动态 model catalog；
- Ink TUI 完整保留；
- AnyFusion-Codex 不再是默认路径且未被未经批准删除；
- 至少完成一次真实 upstream rebase 演练；
- 两个仓库记录最终 commit、artifact digest、验证证据和观察期结果。

## 完成记录

实施完成后必须补写：

- 完成日期；
- 最终 Pi upstream commit/tag；
- AnyFusion-Pi closing commit；
- MetaClaw closing commit；
- Linux artifact digest；
- Docker build/test 数据；
- interactive/Gateway/Feishu smoke 结果；
- upstream rebase 演练结果；
- 观察期和已知限制；
- 是否另立 AnyFusion-Codex archive/delete 计划。
