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
- **多端统一：** 原生 TUI、Web、飞书和 Unix 客户端使用同一套版本化
  Gateway 命令与事件平面；Server 独立常驻，Client 退出不会停止 Runtime。
- **可解释路由：** 每个获批 attempt 都固定到一个配置 revision 以及完整的
  Provider、Model、AgentClass、Harness 和 Permission Profile 绑定。
- **能力驱动路由：** 每个 Executor 都有独立的中文 Skill-style 能力说明书。
  说明书由当前选择的模型、模型能力证据、Executor 运行支撑条件和用户自然语言定义
  统一编译；Planner 使用最终说明书做语义匹配，机器可读的路由投影用于校验和模型选择。
- **上下文连续：** Planner 通过持久化的 Pi session 理解“这张图片”“刚才生成的报告”
  等自然表达；MetaWork 的 Context Bridge 提供有界的 Conversation 事实，验证选中的历史
  Artifact，并只向 Executor 物化已授权的输入。
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

### 构建与运行生命周期

无论当前在哪个目录，都可以执行 `metawork build`。它使用该安装记录的固定源码
checkout，重新安装依赖并构建 Runtime、Planner 和 Web，然后原子激活一套新
release，不改变账号数据。构建前先停止常驻 Server：

```bash
metawork server stop
metawork build
metawork server start
```

`metawork server start`、`metawork tui` 和 `metawork web` 都使用同一个已激活的
`app/current` release。`metawork build` 不启动 Server 或 Client；Server 仍在
运行时构建会直接失败。

### Web 工作区

```bash
metawork web
metawork web --no-open
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

### Executor 能力配置

每个 Executor 都有独立的能力说明书，而不是所有 Executor 共用一组可自由编辑的标签。
用户应先配置该 Executor 允许或自动选择的模型，再用自然语言描述它擅长什么、不擅长什么，
以及哪个模型为它带来了什么具体能力。页面上的“更新能力画像”是一个统一操作，会同时完成：

1. 根据当前模型池重新计算系统能力事实；
2. 将用户自然语言定义与系统事实语义合并；
3. 为这个 Executor 生成中文 Skill-style 说明书；
4. 从同一份能力画像提炼只读标签和结构化路由投影。

最终说明书是 Planner 进行语义理解和路由匹配的依据；结构化路由投影是它的机器可读视图，
供 Planner 校验和 ControlKernel 选择具体模型。用户定义优先于冲突的系统定位，但不能借此
授权未配置的模型、扩大权限或绕过 Kernel 授权。移除一个模型后，刷新能力画像会自动移除
仅由该模型提供证据的能力。

## 系统架构

```text
Client
  -> ClientGateway
    -> ConversationSession
      -> AccountRuntime
        -> PlanningAgent（只负责语义规划）
          -> PlanningAgentPlan v8
            -> ControlKernel（授权与恢复）
              -> Work Graph / Runtime
                -> Executor attempt
```

- `ClientGateway` 负责版本化的多客户端命令/事件协议。
- `ConversationSession` 负责串行输入 mailbox 与持久化 AnyFusion-Pi Planner session。
  新的语义 Planner 回合不能直接回复工作型请求；除斜杠开头的系统命令外，都必须提交给
  Executor 执行。历史 direct-reply 记录仍可用于审计和回放。
- `AccountRuntime` 负责账户级共享服务和调度策略。每个 Conversation 拥有一个持久执行槽位，
  不同 Conversation 可以在配置的并发上限内并行执行。
- `ControlKernel` 是确定性的策略授权方。
- Execution 负责 claim、lease、原生 worktree 或 Docker 兼容 backend、attempt、Git publication
  与标准化 observation。

### Planner 到 Executor 的路由链路

```text
用户请求
  -> Planner 读取能力说明书和结构化路由投影
  -> PlanningAgentPlan v8
  -> Validator 校验工作图和所需能力
  -> ControlKernel 授权不可变 binding
  -> Auto Model Resolver 从允许池选择能力匹配的模型
  -> Executor 执行获批 attempt
```

Planner 负责自然语言理解和任务拆解，不直接修改 Task、不授权执行、不直接访问存储，也不
执行 shell。Kernel 是唯一负责调度、选择获批模型 binding、处理恢复以及启动 Executor attempt
的权威。

### Planner、MetaWork 与 Executor 的上下文连续性

上下文连续性遵循一条单向桥接链路：

```text
Pi session 历史 + 用户输入
  -> Planner 理解并选择上下文
  -> MetaWork Context Bridge 提供并验证 Artifact 事实
  -> Runtime 物化已授权输入
  -> Executor 执行当前 Subtask
```

历史图片、文档、HTML、文本和 Executor 结果使用明确的 Artifact 引用，不通过猜测文件名
或私有路径获取。MetaWork 会在 Artifact 进入 attempt 前校验 Conversation 与 Workspace
归属、发布状态、普通文件安全性和内容哈希。Executor 只接收当前 Subtask 与 attempt-local
输入，不直接读取 Conversation 历史或 Artifact 存储。这样可以保持 Planner 负责语义理解、
MetaWork 负责确定性校验、Executor 负责执行。

### Pi Agent 与图片执行

`pi-agent` 仍然是一个用户可见的 Executor，也只有一份能力说明书。它在运行时使用复合
Executor Adapter：

```text
pi-agent
  ├─ 普通研究、分析、编码和工具任务
  │    -> 用户安装的标准 `pi --mode json`
  └─ image-generation / image-editing Subtask
       -> MetaWork Image API Runner
```

图片任务使用 Kernel 已授权的 Model 和 Provider binding。MetaWork 会校验输入和输出图片签名，
把图片产物写入 attempt workspace，并通过 Completion Protocol v4 验收。Image Runner 不是
第二个 AgentClass，也不会修改 vendored AnyFusion-Pi Planner。因此用户升级本机 Pi 不会覆盖
MetaWork 的图片执行代码。

macOS 原生 worktree 执行不依赖 Docker。Docker 只是受限部署的显式兼容 backend；它在固定的
attempt 镜像中同时打包标准 Pi CLI 和 MetaWork Image Runner，并通过 attempt-scoped model
gateway 转发图片请求，Provider 凭据不会进入容器。

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

MetaWork 正在进行商业化开发。当前支持不同 Conversation 之间有限并行的顶层 Task，
同时每个 Conversation 自己的 Task 执行槽位保持串行。Planner-first 路由、统一 Executor
能力画像和 Pi 图片执行链路已经实现，并由仓库测试覆盖。真实 Provider 图片生成与编辑仍
需要配置 OpenAI-compatible endpoint；生产 smoke 可能产生 Provider 用量费用。

## 许可

MetaWork 是闭源商业软件。它不通过仓库中历史遗留的开源许可证文件对外授权。对外分发
前必须由公司提供正式批准的商业许可条款。

AnyFusion 衍生组件及其他第三方开源组件继续遵守各自的版权、许可证、归属与 NOTICE
要求。根目录 `LICENSE` 暂时保留，供历史和第三方审查使用；它不代表 MetaWork
整体产品采用该许可证。
