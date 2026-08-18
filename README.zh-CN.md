<p align="center">
  <strong>上海元聚变人工智能科技有限公司</strong>
</p>

<div align="center">

# MetaWork

**面向持久化、可治理智能体工作的本地优先 AI Task OS。**

MetaWork 将自然语言目标转化为持久化任务，这些任务可以跨进程重启存活，
经过相互隔离的 Planner/Executor 流水线执行，并交付可验证、可审计的成果——
而不只是一次聊天回复。

[![Developer Preview](https://img.shields.io/badge/status-Developer%20Preview-F59E0B)](docs/releases/v1.2.0-preview.0.md)
[![CI](https://github.com/IFOSR/metawork/actions/workflows/ci.yml/badge.svg)](https://github.com/IFOSR/metawork/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2563EB.svg)](#许可证)

[为什么用 MetaWork](#为什么用-metawork) · [安装方式](#安装方式) ·
[使用](#使用) · [工作原理](#工作原理) ·
[项目状态](#项目状态) · [English](README.md)

</div>

## 为什么用 MetaWork

大多数 AI 智能体会话都是短暂的：回答完当前回合就结束，没有持久状态、没有
治理、也拿不出可验证的成果。MetaWork 把智能体工作提升到「任务操作系统」
的高度。

### 持久化任务，而非一次性的对话回合

- Task 是一等对象，拥有显式状态机——`created`、`ready`、`running`、
  `parked`、`blocked`、`done`、`archived`、`cancelled`。
- 工作跨进程重启存活，并带着上下文恢复，而不是从头再来。
- 任务可搜索（本地 SQLite 全文索引），可以在缺少资源或等待人工授权时暂停，
  之后从断点继续。

### 治理与执行分离

每一次战略状态变更都经过同一条确定性控制链：

```text
Planner proposes → ControlKernel decides → Runtime applies → Executor performs one authorized attempt
```

- Planner 只提语义提案；它从不调度、授权，也不写存储。
- ControlKernel 是唯一的战略决策入口，把每一个决策写入 append-only、不可变
  的账本。
- 不存在第二套语义 Router，没有隐藏重试循环，也没有静默回退路径。

### 隔离且真实的执行

- Planner 与每个 Executor 以独立进程运行。
- 每次 attempt 拥有一个私有的 `(task, generation, subtask)` Git worktree，
  在重试和重启后依然保留。
- Codex 与 Pi 复用你本机已有的 CLI，且不共享它们的个人 home。worktree 后端
  是默认受信任的原生路径。

### 验证与确定性发布

- Completion Protocol v3 要求结构化证据，或一次受控失败。
- Runtime 为每次 attempt 计算唯一的权威 workspace delta。
- 成功的 attempt 生成不可变 receipt 与候选 Git commit，并按确定性顺序集成；
  合并冲突走有界、由 Kernel 授权的修复链路。
- 结果、产物和 handoff 只有在发布成功后才对外可见。

### 本地优先、可自托管

- macOS 原生安装，无需 Docker。
- 密钥保存在 macOS keychain；运行状态保存在本地 SQLite 数据库。

### 修订化配置、签名升级

- 静态配置是不可变的、按 revision 作用域管理；每一代 Work Graph 绑定唯一的
  一个 revision。
- 升级是签名、崩溃可恢复的事务：固定信任根、经校验的备份与迁移、候选健康
  检查、原子指针切换与回滚。

### 多种接入面

- 原生 TUI（默认）、浏览器 UI、飞书交付，以及本地 Gateway。

## 安装方式

当前原生安装器面向 macOS。Linux 与 WSL2 仍是开发与运行环境；Docker 只保留
为兼容性与 CI 验证路径。

### 前置条件

- Node.js `>=22.19.0`
- npm
- Git
- 用于编译 `better-sqlite3` 的 macOS 原生构建工具
- 已安装并位于 `PATH` 中的 `codex` 与 `pi`
- 一个 OpenAI-compatible Provider URL 与 API Key

```bash
xcode-select --install
brew install node@22 git
export PATH="$(brew --prefix node@22)/bin:$PATH"

node --version
npm --version
git --version
codex --version
pi --version
```

### 安装

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork

export ANYFUSION_PROVIDER_KEY='替换为你的密钥'
export ANYFUSION_PROVIDER_URL='https://你的-openai-compatible服务地址.example/v1'

./setup.sh
```

可选 Provider 变量：

```bash
export ANYFUSION_PROVIDER_MODEL='你的模型ID'      # 默认：gpt-5.6-terra
export ANYFUSION_PROVIDER_REGION='international'  # 默认：international
```

安装器会：

- 分别构建 MetaWork Runtime 与仓库内置的 Pi planner，保持两套独立依赖树，
  直接从检入的 `planner/AnyFusion-Pi` 源码构建。
- 将启动器安装到 `~/.local/bin/anyfusion`。
- 将所有状态与配置写入 `~/.anyfusion`（可用 `ANYFUSION_INSTALL_ROOT` 覆盖）。
- 不安装、升级、降级、链接或重新配置 Codex/Pi，也不读取或写入你的
  `~/.codex` 与 `~/.pi` home。

### 运行时目录布局

```text
~/.local/bin/
└── anyfusion                # 启动器

~/.anyfusion/
├── app/current              # 当前生效的 release
├── app/releases/            # 版本化 release
├── config/active/           # 当前生效的不可变配置 revision
├── config/secrets/          # 密钥（macOS：keychain；Linux：file，0600）
├── data/metaclaw.db         # 持久化运行状态
├── data/planner-sessions/
├── data/execution-workspaces/
└── upgrade-journals/
```

在非 macOS 平台上需设置 `ANYFUSION_SECRET_STORE=file`；keychain 存储仅支持
macOS。

## 使用

### 原生 TUI（默认）

```bash
cd /path/to/your/project
anyfusion
```

启动目录就是 Planner 只读检查的根目录，不会被强制为 MetaWork 仓库或固定
`/workspace`。

### Web 界面

```bash
anyfusion web
anyfusion web restart          # 将正在运行的实例重启为 Web 模式
anyfusion web --port 9000 --no-open
```

`anyfusion web` 会打开 `http://127.0.0.1:8788`，并通过短生命周期的 URL
fragment 自动完成浏览器认证，随后立即换发为 HttpOnly、SameSite=Strict 的
会话 Cookie。SSH、端口转发或手动打开浏览器时使用 `--no-open`。

### CLI 参考

```text
anyfusion                                   # 原生 TUI
anyfusion web [restart] [--port <端口>] [--no-open]
anyfusion --script <文件>                   # 脚本化会话
anyfusion --gateway                         # 本地 Gateway
anyfusion --connect                         # 接入正在运行的 Gateway
anyfusion gateway <run|setup|pairing|doctor|install|start|stop|restart|status>
anyfusion <configure|config|provider|model|planner|executor|doctor|status> ...
```

管理命令：

```text
anyfusion status
anyfusion doctor
anyfusion config show | validate | history | diff | rollback
anyfusion provider list | add | edit | test | remove
anyfusion model    list | add | edit | test | remove
anyfusion executor list | add | edit | enable | disable | remove | test
```

命令行入口为 `anyfusion`；兼容别名有 `metawork`、`metaclaw`。

## 工作原理

MetaWork 把智能体工作划分为四道明确的运行时边界：

- **Planner** —— 负责自然语言理解，产出严格的 `PlanningAgentPlan v8` 提案
  （直接回复、Task 绑定、Work Graph 提案）。它只读检查你的仓库，从不修改
  状态。
- **ControlKernel** —— 负责 admission、dispatch、retry、fallback、取消、
  恢复、权限与发布策略。`decide(event, snapshot)` 是唯一的战略决策入口。
- **Runtime** —— 应用已授权的决策：持久化 Task 与 Subtask 状态、Work Graph
  执行、WorkUnit 认领与 lease、workspace、进程生命周期，并向 Kernel 回报
  规范化事实。
- **Executor adapter** —— 每次调用只传输一次已授权的 attempt，通过 worktree
  后端（默认）或 Docker 兼容后端执行。

当前发布边界是同一时间一个活跃顶层 Task，该 Task 内可包含依赖感知的
Subtask，最多并行运行四个相互独立的 attempt。

## 项目状态

| 项目 | 当前状态 |
| --- | --- |
| 版本 | `v1.2.0-preview.0` |
| 成熟度 | Developer Preview |
| Runtime | Node.js `>=22.19.0`，TypeScript ESM |
| Planner contract | PlanningAgentPlan v8 |
| Work Graph contract | v7 |
| Kernel contract | v5 |
| Completion contract | v3 |
| Persistence | SQLite schema v31 |
| Canonical Executor | Codex CLI 与 Pi Agent |

当前版本不是稳定生产版本。安装、配置与扩展契约在首个稳定版本前仍可能调整。

## 文档

| 文档 | 内容 |
| --- | --- |
| [当前技术总览](docs/current/technical-overview.zh-CN.md) | 完整 Runtime、部署、配置与仓库说明 |
| [运行时安全](docs/current/phase-5-runtime-security.md) | Workspace、resource lease、权限边界与执行后端 |
| [架构决策](docs/adr/README.md) | 已接受决策与权威矩阵 |
| [文档地图](docs/README.md) | 当前文档、计划、技术债与归档索引 |

## 许可证

MetaWork 使用 [Apache License, Version 2.0](LICENSE)。

Copyright 2026 上海元聚变人工智能科技有限公司
