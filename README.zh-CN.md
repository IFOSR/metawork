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

面向所有智能体工作的统一入口。你运行的 Agent 越多，越需要一个唯一入口：
你只需描述目标，MetaWork 在后台匹配最合适的 Agent、基座模型与 Harness。

### 一个入口，而非一份 Agent 清单

- **用户不该管理 Agent 清单。** 当每个 Agent 都有独立入口，你既难判断该用
  哪个，又会在它们之间反复迁移上下文。
- **固定组合不是最优解。** 任务特征变化后，最合适的模型、Harness、成本与
  时延组合也会随之变化。
- **能力扩展不应增加入口。** 垂类 Agent 应作为后台能力挂载，而不是继续
  增加需要学习的产品界面。

### 任务级路由，而非模型排行榜

同一个任务，模型 × Harness 的组合会同时改变质量、成本、上下文与完成时间。
MetaWork 不按模型排行榜做静态选择，而是为当前任务约束寻找更优的完整组合。

- 大多数真实工程任务属于低到中等复杂度，固定调用最强组合是系统性浪费。
- 单 Token 更便宜不等于任务成本更低：Harness 决定上下文被重复投喂的量，
  这才是真实任务成本的大头。
- 路由对完整组合评分——任务画像 × 模型层级 × Harness 画像——得到任务级
  Pareto 最优，优化的是任务成本与最终交付质量，而非单 Token 价格或单一
  模型分数。

### 持久化、可治理的任务控制平面

这套路由机制以 MetaWork 开源落地——不是又一个聊天窗口，而是一个本地、
可持久化、可恢复、可治理的 AI 任务控制平面。

```text
Plan → Govern → Schedule → Route → Execute → Verify
```

- **持久化任务** —— 任务不会随会话结束而消失，跨重启保留持久状态
  （`ready`、`running`、`parked`、`blocked`、`done`）。
- **工作图** —— 复杂目标被拆成依赖感知的 DAG，调度器只运行真正就绪的工作。
- **可治理执行** —— Planner 提出变化，Control Kernel 决定是否执行，校验
  状态、策略、预算与授权边界。
- **可扩展执行器** —— Codex、Pi、Hermes、自定义脚本与垂类 Agent 都挂载到
  同一个控制平面。

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
