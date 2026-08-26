<p align="center">
  <strong>上海元聚变人工智能科技有限公司</strong>
</p>

<div align="center">

# AnyFusion

**面向持久化、可治理智能体工作的本地优先 AI Task OS。**

AnyFusion 将自然语言请求转化为可持久化的 Task 与 Work Graph。它们可以跨进程
重启存活，在受控的 Planner 与 Executor 边界内执行，并交付可验证的结果，而不
只是停留在一次聊天回复。

[![Developer Preview](https://img.shields.io/badge/status-Developer%20Preview-F59E0B)](#项目状态)
[![CI](https://github.com/IFOSR/metawork/actions/workflows/ci.yml/badge.svg)](https://github.com/IFOSR/metawork/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2563EB.svg)](#许可证)

[为什么用 AnyFusion](#为什么用-anyfusion) · [安装方式](#安装方式) ·
[使用](#使用) · [工作原理](#工作原理) ·
[项目状态](#项目状态) · [English](README.md)

</div>

## 为什么用 AnyFusion

运行更多 Agent 不应该意味着维护更多彼此割裂的入口。AnyFusion 提供一个由
持久化控制平面支撑的统一会话界面：Planner 理解请求，ControlKernel 授权状态
变化，Runtime 只执行已经获得明确授权的工作。

### 持久化工作，而非一次性会话

- **持久化 Task** 跨进程重启保留状态、恢复事实、结果和审计历史。
- **Work Graph** 描述依赖感知的 Subtask、类型化交接、验收标准和发布顺序。
- **结果优先交付** 可以在完成认证前先交付安全且有用的结果，但不会错误地把
  Subtask 标记为完成。
- **显式恢复策略**：retry、fallback、continuation、merge repair、取消和恢复
  始终由 ControlKernel 决策。

### 一个 Runtime，多种客户端

原生 TUI、Web 工作台、飞书集成、脚本和 Unix 客户端都使用同一套版本化 Gateway
命令与事件平面。它们共享账户级 Runtime，同时保持 Conversation 历史和展示
状态相互隔离。

### 可解释路由与可治理执行

AnyFusion 将 AgentClass 选择与具体执行绑定分离。每次获得授权的 attempt 都固定
到一个配置 revision，以及完整的 Provider、Model、AgentClass、Harness 和
Permission Profile 组合。

Executor Auto 路由会在用户允许的模型池中，根据兼容性、健康度、能力、上下文、
成本、时延和质量约束进行筛选，并记录最终绑定与有限的未入选原因。Runtime
不会使用当前配置悄悄替换历史任务或正在执行的任务所固定的配置。

```text
Plan -> Authorize -> Dispatch -> Execute -> Verify -> Publish -> Deliver
```

## 安装方式

macOS 是主要原生安装路径。Linux 与 WSL2 使用同一套面向 Unix 的源码安装流程，
并采用文件型 SecretStore。原生 Windows PowerShell 不是受支持的生产路径，请
使用 WSL2 或可选的 Docker 兼容路径。

### 前置条件

安装所需：

- Node.js `>=22.19.0`
- npm
- Git
- 用于编译 `better-sqlite3` 的原生构建工具
- 一个 OpenAI-compatible Provider base URL 与 API Key

推荐的构建工具：

```bash
# macOS
xcode-select --install
brew install node@22 git
export PATH="$(brew --prefix node@22)/bin:$PATH"

# Ubuntu、Debian 或 WSL2
sudo apt-get update
sudo apt-get install -y git build-essential python3 make g++
```

Codex CLI 和 Pi Agent 需要独立安装。安装流程会检测 `PATH` 中的 `codex` 与
`pi`，并启用当前可用的 canonical Executor class，但不会安装、升级、降级或
重新配置它们。执行型 Task 至少需要一个兼容且已启用的 Executor。

### 安装

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork

export ANYFUSION_PROVIDER_KEY='替换为你的密钥'
export ANYFUSION_PROVIDER_URL='https://你的-openai-compatible服务地址.example/v1'

# 可选。安装器默认使用 gpt-5.6-terra 和 international。
export ANYFUSION_PROVIDER_MODEL='你的模型ID'
export ANYFUSION_PROVIDER_REGION='international'

./setup.sh

export PATH="$HOME/.local/bin:$PATH"
anyfusion --help
```

在非 macOS 系统上，`setup.sh` 会自动选择权限为 `0600` 的文件型 SecretStore。
macOS 默认使用 Keychain 存储密钥，除非显式配置为其他方式。

安装器会：

- 分别构建 AnyFusion Runtime 与仓库内置的 `planner/AnyFusion-Pi` 源码，保持
  两套独立依赖树；
- 将公开启动器安装到 `~/.local/bin/anyfusion`；
- 将 release、账户状态、配置 revision、生成的 Runtime 文件和升级日志存放在
  `~/.anyfusion`；
- 将 Planner session 和 Executor Runtime home 与个人 `~/.codex`、`~/.pi`
  home 隔离。

### 运行时目录布局

```text
~/.local/bin/
└── anyfusion

~/.anyfusion/
├── app/
│   ├── current
│   └── releases/
├── data/
│   ├── gateway.sock
│   └── runtime.lock
├── accounts/local-default/
│   ├── config/
│   ├── secrets/
│   ├── generated/
│   ├── data/
│   │   ├── anyfusion.db
│   │   ├── database-revisions/
│   │   ├── backups/
│   │   └── results/
│   ├── planner/sessions/
│   ├── conversations/
│   ├── workspace-store/
│   ├── attempts/
│   └── gateway/
└── upgrade-journals/
```

如需使用其他安装根目录，请在安装前设置 `ANYFUSION_INSTALL_ROOT`。

## 使用

### 原生 TUI

```bash
cd /path/to/your/project
anyfusion
```

启动目录会成为 workspace 上下文。Planner 侧的仓库访问保持受控且只读；获得
授权的 Executor 在受管理的 Task/Subtask Git worktree 中修改文件，并通过发布
门禁合入结果。

### Web 工作台

```bash
anyfusion web
anyfusion web start
anyfusion web restart
anyfusion web --port 9000 --no-open
```

默认 Web 地址为 `http://127.0.0.1:8788`。正常启动会将短生命周期的 URL
fragment bootstrap 换成 HttpOnly、SameSite=Strict 的 session cookie。SSH、
端口转发或手动启动浏览器时使用 `--no-open`。

### CLI 参考

```text
anyfusion
anyfusion web [start|restart] [--port <端口>] [--no-open]
anyfusion --script <文件>
anyfusion --gateway
anyfusion --connect
anyfusion gateway <run|setup|pairing|doctor|install|start|stop|restart|status>
anyfusion <configure|config|provider|model|planner|executor|doctor|status> ...
```

常用管理命令：

```text
anyfusion status
anyfusion doctor
anyfusion config show | validate | history | diff | rollback
anyfusion provider list | add | edit | test | remove
anyfusion model    list | add | edit | test | remove
anyfusion executor list | add | edit | enable | disable | remove | test
```

源码安装器只创建 `anyfusion` 启动器。

## 工作原理

```text
Client
  -> ClientGateway
    -> ConversationSession
      -> AccountRuntime
        -> PlanningAgent
          -> ControlKernel
            -> Runtime
              -> Executor
```

- **ClientGateway** 负责版本化多客户端命令/事件协议、replay、attachment、
  权限请求和展示安全的事件流。
- **ConversationSession** 负责一个串行输入 mailbox、一个持久化 AnyFusion-Pi
  Planner session 和一份有限的 interaction trace。
- **AccountRuntime** 负责账户级配置、memory、Task、Kernel、执行、发布、交付
  和恢复服务。
- **PlanningAgent** 负责自然语言语义并提交严格的 `PlanningAgentPlan v8`
  提案。它不能修改存储、授权工作或控制 Executor。
- **ControlKernel** 是 admission、dispatch、retry、fallback、取消、恢复、
  权限与发布策略的唯一权威。
- **Runtime** 应用已授权的持久化决策，并向 Kernel 回报规范化事实。
- **Executor adapter** 通过原生 worktree 后端或显式 Docker 兼容后端传输一次
  已授权 attempt。

一个 AccountRuntime 同时只接纳一个活跃顶层 Task。Task 可以包含依赖感知的
Work Graph，并最多并行运行四个相互独立的 attempt。成功 attempt 会生成不可变
receipt 和候选 Git commit；发布流程按确定性顺序集成它们，之后完成事实才成为
权威状态。

配置采用 Provider-first 和 revision 化管理。Planner 使用一个 fixed 模型绑定。
Codex 与 Pi Executor 策略可以是 Fixed 或 Auto；Auto 在执行前必须解析为具体
binding。只有 AccountRuntime activation gate 空闲时才能激活配置，新配置只影响
新的 Planner turn 和 Task generation，不会改写正在执行的 attempt。

## 项目状态

| 项目 | 当前状态 |
| --- | --- |
| 版本 | `v1.2.0-preview.0` |
| 成熟度 | Developer Preview |
| Runtime | Node.js `>=22.19.0`，TypeScript ESM |
| Planner contract | PlanningAgentPlan v8 |
| Work Graph contract | v7 |
| Kernel contract | v5 |
| Completion contract | v4 |
| Persistence | SQLite schema v33 |
| Canonical Executor | Codex CLI 与 Pi Agent |
| 顶层调度 | 每个 AccountRuntime 一个活跃 Task |
| Subtask 并发 | 最多四个 attempt |

当前版本不是稳定生产版本。安装、配置、扩展和升级契约在首个稳定版本前仍可能
变化。多顶层 Task 调度被明确延后到独立的未来路线图。

## 文档

| 文档 | 内容 |
| --- | --- |
| [当前技术总览](docs/current/technical-overview.zh-CN.md) | 完整 Runtime、部署、配置与仓库说明 |
| [账户 Runtime 运维](docs/current/account-runtime-and-gateway-operations.md) | Server 生命周期、账户路径、Gateway replay 与诊断 |
| [运行时安全](docs/current/phase-5-runtime-security.md) | Workspace、resource lease、权限边界与执行后端 |
| [架构决策](docs/adr/README.md) | 已接受决策与权威矩阵 |
| [文档地图](docs/README.md) | 当前文档、计划、技术债与归档索引 |

## 许可证

AnyFusion 使用 [Apache License, Version 2.0](LICENSE)。

Copyright 2026 上海元聚变人工智能科技有限公司
