<p align="center">
  <strong>上海元融合人工智能科技有限公司</strong>
</p>

<div align="center">

# MetaWork

**面向持久化、可治理 Agent 工作流的商业 AI Task OS。**

MetaWork 将自然语言需求转化为可持久化的 Task 与 Work Graph，通过受控的
Planner、ControlKernel 和 Executor 边界完成执行、恢复、验收与交付，而不是停留在
一次聊天回复。

[为什么用 MetaWork](#为什么用-metawork) · [安装方式](#安装方式) ·
[使用方式](#使用方式) · [系统架构](#系统架构) ·
[兼容策略](#兼容策略) · [English](README.md)

</div>

## 为什么用 MetaWork

MetaWork 为 Agent 工作提供统一的商业服务系统，覆盖规划、授权、执行、恢复与交付。

- **持久工作：** Task、Work Graph、结果、恢复事实和审计记录可跨进程重启保留。
- **受控执行：** Planner 负责提出工作，ControlKernel 负责授权状态变化，
  Executor 只执行明确获批的 attempt。
- **多端统一：** 原生 TUI、Web、飞书、脚本和 Unix 客户端使用同一套版本化
  Gateway 命令与事件平面。
- **可解释路由：** 每个获批 attempt 都固定到一个配置 revision 以及完整的
  Provider、Model、AgentClass、Harness 和 Permission Profile 绑定。
- **显式恢复：** retry、fallback、continuation、merge repair、cancel 和 resume
  都由 ControlKernel 决策。

```text
Plan -> Authorize -> Dispatch -> Execute -> Verify -> Publish -> Deliver
```

## 产品边界

MetaWork 是本仓库统一呈现的产品，是闭源商业软件。

[AnyFusion](https://github.com/IFOSR) 是独立的开源项目。MetaWork 可以复用或改造
其中已正确归属的组件与契约。当前仓库内置的 `planner/AnyFusion-Pi` 仍是隔离的
Planner 组件；为了不破坏已有安装，数据库名、协议 ID 和部分代码类型名继续保留
AnyFusion 标识。

## 安装方式

主要原生安装路径是 macOS。Linux 与 WSL2 使用同一套面向 Unix 的源码安装流程，
并默认使用文件 SecretStore。原生 Windows PowerShell 不是生产支持路径，请使用
WSL2 或可选的 Docker 兼容模式。

### 环境要求

- Node.js `>=22.19.0`
- npm
- Git
- `better-sqlite3` 所需的原生构建工具
- OpenAI-compatible Provider 地址与 API Key

Codex CLI 与 Pi Agent 独立安装。安装程序只检测 `PATH` 中已有的 CLI，不会安装、
升级、降级或修改它们。

### 安装

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork

export METAWORK_PROVIDER_KEY='替换为你的密钥'
export METAWORK_PROVIDER_URL='https://你的-openai-compatible服务地址.example/v1'

# 可选
export METAWORK_PROVIDER_MODEL='你的模型ID'
export METAWORK_PROVIDER_REGION='international'

./setup.sh

export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

安装程序会在独立依赖树中分别构建 MetaWork Runtime 与
`planner/AnyFusion-Pi`。release、账户状态、配置、生成的运行时文件和更新日志统一
存放在 `~/.metawork`。

### 运行目录

```text
~/.local/bin/
├── metawork
├── anyfusion
└── metaclaw

~/.metawork/
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

如需修改安装根目录，请在安装前设置 `METAWORK_INSTALL_ROOT`。

## 使用方式

### 原生 TUI

```bash
cd /你的/项目目录
metawork
```

启动目录会成为 Planner 的只读工作区上下文。Executor 的获批修改发生在托管的
Task/Subtask Git worktree 中，并经过 publication gate。

### Web 工作区

```bash
metawork web
metawork web start
metawork web restart
metawork web --port 9000 --no-open
```

默认 Web 地址是 `http://127.0.0.1:8788`。普通启动会使用短时 URL fragment
bootstrap 换取 HttpOnly、SameSite=Strict session cookie。SSH、端口转发或手动打开
浏览器时使用 `--no-open`。

### 管理命令

```text
metawork status
metawork doctor
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

## 系统架构

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

- `ClientGateway` 负责版本化的多客户端命令/事件协议。
- `ConversationSession` 负责串行输入 mailbox 与持久化 AnyFusion-Pi Planner session。
- `AccountRuntime` 负责账户共享服务和单一活跃顶层 Task 边界。
- `ControlKernel` 是确定性的策略授权方。
- Execution 负责 claim、lease、backend、attempt、Git publication 与标准化 observation。

完整契约见[当前技术总览](docs/current/technical-overview.zh-CN.md)和
[已接受 ADR](docs/adr/README.md)。

## 兼容策略

`anyfusion` 与 `metaclaw` 保留为 `metawork` 的兼容 CLI alias。已有
`ANYFUSION_*` 产品配置继续作为对应 `METAWORK_*` 配置的兼容入口；两者同时设置且
值冲突时会 fail closed。`ANYFUSION_PI_*` 与 `ANYFUSION_PLANNER_*` 继续保留，因为
它们明确标识 AnyFusion-Pi 组件。

已有 `~/.anyfusion` 安装会通过事务迁移到 `~/.metawork`。迁移成功后不会维持长期
双读或双写。`anyfusion.db`、`AnyFusionConfigurationV2` 和
`anyfusion-planner-host-v2` 等持久化兼容名称会继续保留。

## 项目状态

MetaWork 正在进行商业化开发。当前每个账户允许一个活跃顶层 Task，同时允许该 Task
内部有限并行执行多个 Subtask attempt。正式商业发布前，接口与运维契约仍可能调整。

## 许可

MetaWork 是闭源商业软件。它不通过仓库中历史遗留的开源许可证文件对外授权。对外分发
前必须由公司提供正式批准的商业许可条款。

AnyFusion 衍生组件及其他第三方开源组件继续遵守各自的版权、许可证、归属与 NOTICE
要求。根目录 `LICENSE` 暂时保留，供历史和第三方审查使用；它不代表 MetaWork
整体产品采用该许可证。
