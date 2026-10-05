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
[Release](#release) · [快速开始](#快速开始) · [使用方式](#使用方式) ·
[系统架构](#系统架构) ·
[兼容策略](#兼容策略) · [English](README.md)

</div>

## 为什么用 MetaWork

MetaWork 为 Agent 工作提供统一的商业服务系统，覆盖规划、授权、执行、恢复与交付。

- **持久工作：** Task、Work Graph、结果、恢复事实和审计记录可跨进程重启保留。
- **受控执行：** Planner 负责提出工作，ControlKernel 负责授权状态变化，
  Executor 只执行明确获批的 attempt。
- **多端统一：** Web、飞书和 Unix 客户端使用同一套版本化
  Gateway 命令与事件平面；Server 独立常驻，Client 退出不会停止 Runtime。
- **多端统一观察：** Web、飞书和原生 TUI 可以查看同一批 Task 与会话。
  会话切换读取有界客户端读模型，不需要重放整段历史；TUI 任务面板可以
  汇总查看执行中、排队中和阻塞中的任务。
- **可解释路由：** 每个获批 attempt 都固定到一个配置 revision 以及完整的
  Provider、Model、AgentClass、Harness 和 Permission Profile 绑定。
- **能力驱动路由：** Planner 根据智能体职责和能力证据规划任务；决策模型结合
  模型的具体优势、局限、适用任务、可用工具和价格，选择合适的智能体与模型组合。
  通用能力标签不用于质量评分，执行兼容性和权限条件仍严格校验。
- **上下文连续：** Planner 通过持久化的 Pi session 理解“这张图片”“刚才生成的报告”
  等自然表达；MetaWork 的 Context Bridge 提供有界的 Conversation 事实，验证选中的历史
  Artifact，并只向 Executor 物化已授权的输入。
- **长任务可靠执行：** Executor 没有总体执行时长上限。可选 watchdog 只在 Harness
  确实处于 idle 时过期；权威 operation 正在执行期间会暂停计时。
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

## Release

当前正式版本是
[MetaWork `v0.1.4`](https://github.com/IFOSR/metawork/releases/tag/v0.1.4)，
发布在 stable 安装通道。四个平台的 Release identity 记录在签名 manifest 中，
所有目标均由同一个 tag 提交构建。

| 目标平台 | 原生发布标识 |
| --- | --- |
| macOS Intel | `darwin-x64` |
| macOS Apple Silicon | `darwin-arm64` |
| Linux x64 | `linux-x64` |
| Windows x64 | `win32-x64` |

每个平台都发布 Runtime 归档、内嵌 AnyFusion-Pi Planner 归档和对应的
Ed25519 签名 manifest。Manifest 使用签名密钥
`metawork-release-2026-03`，固定 Runtime/Planner revision 为 tag 提交，
并记录安装器会校验的 SHA-256 哈希。当前 Release 不提供 Linux arm64
预构建产物；请在原生 Linux arm64 主机上执行 `npm run build:release`。

## 安装方式

当前预构建 Release 覆盖 macOS Intel、macOS Apple Silicon、Linux x64 和
Windows x64。Linux 与 WSL2 使用面向 Unix 的安装器并默认使用文件
SecretStore；Windows 使用签名 PowerShell 安装器，通过 named pipe 连接本地
Runtime。Linux arm64 支持原生构建，但不包含在当前预构建 Release 中。

### 环境要求

- Node.js `>=22.19.0`
- npm
- Git
- `better-sqlite3` 所需的原生构建工具
- 任一 OpenAI 兼容模型服务的 API Key（DeepSeek、Kimi、Code CLI 或自建网关），
  由安装后的配置向导采集并验证

Codex CLI 与 Pi Agent 独立安装。安装程序只检测 `PATH` 中已有的 CLI，不会安装、
升级、降级或修改它们。

### 一条命令安装（macOS、Linux、WSL2）

官方分发源是 GitHub Releases。下面的安装命令会跟随最新 stable Release；当前仓库
对应的正式版本是 `v0.1.4`。归档文件和签名 manifest 都直接从 GitHub Release CDN
下载。

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh | bash

export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

一条命令从官方 GitHub Release 下载并校验已签名的预构建 Runtime 与内嵌 Planner 产物，然后自动进入
Provider 配置向导。Linux 与 WSL2 上安装器会自动选用文件型 SecretStore
（`METAWORK_SECRET_STORE=file`），无需手动 export。重复执行同一命令会对已有
安装原地升级——配置、密钥和任务数据全部保留。Windows 用户请使用下面的
PowerShell 安装器。向导完成后，继续阅读[快速开始](#快速开始)。

### 一条命令安装（Windows x64）

在当前用户的 PowerShell 中执行：

```powershell
irm https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.ps1 -OutFile metawork-install.ps1
.\metawork-install.ps1
```

Windows 版本要求 Node.js `>=22.19.0`、Git，以及 Windows Developer Mode
（或管理员终端），以便事务性 Release 指针使用 NTFS 链接。安装器会先校验
签名 manifest 与两个 ZIP 产物，再执行离线安装。

在 IDE 内嵌终端、agent 或 CI 等无法把向导接到键盘的场景，请先下载再用真实
终端运行（或改用下文的环境变量非交互安装）：

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh -o metawork-install.sh
bash metawork-install.sh
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh | bash -s -- --uninstall
```

会先停止运行中的 Server，移除托管的启动器（`metawork`、`anyfusion`、`metaclaw`），
并删除安装目录。追加 `--purge` 可同时清理旧版启动器备份。

### 让 Server 常驻运行

`metawork server start` 是前台进程。需要长期运行时，可使用
`scripts/supervision/` 下的守护模板（macOS 用 launchd plist，Linux 用
systemd unit），Server 退出后会自动拉起。

### 源码安装

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork
./setup.sh

export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

构建完成后，安装程序会启动一个简短的配置向导：选择预设 Provider（DeepSeek、
Kimi、Code CLI）或输入任意 OpenAI 兼容地址，确认模型，粘贴 API Key。向导会用
一次真实请求验证 Key，存入本地 SecretStore，然后完成安装。无需预先 export 任何
配置。

<details>
<summary>非交互安装（CI、Docker、脚本）</summary>

跳过向导，在运行 `./setup.sh` 前导出 Provider 环境变量：

```bash
export METAWORK_PROVIDER_KEY='你的密钥'
export METAWORK_PROVIDER_URL='https://api.deepseek.com/v1'
# 可选（Linux/WSL2 会自动选用文件型 SecretStore）
export METAWORK_SECRET_STORE='file'
export METAWORK_PROVIDER_MODEL='deepseek-chat'
export METAWORK_PROVIDER_REGION='international'
```

</details>

<details>
<summary>发布预构建产物（维护者）</summary>

`npm run build:release` 会在当前原生主机上构建 Runtime/Web/Planner，安装生产依赖，
再按平台打包为归档文件和 Ed25519 签名 manifest。目标平台必须与构建主机一致；
不能在 macOS 上交叉构建 Linux Release。Linux x64 主机构建 Linux x64 Release
示例：

```bash
npm run build:release -- \
  --platform linux \
  --arch x64 \
  --release-id 0.1.4-build-<tagged-revision> \
  --signing-key /secure/path/metawork-release-key.pem \
  --out-dir /tmp/metawork-release
```

Windows 使用 ZIP 与 `scripts/install.ps1`；macOS/Linux 使用 tarball 与
`scripts/install.sh`。`--package-only` 只用于打包已经准备好的目标依赖，不会执行构建。
发布必须使用真实签名密钥（`--signing-key` 或
`METAWORK_RELEASE_SIGNING_KEY`）；`--generate-dev-key` 仅限本地测试。GitHub Actions
使用 macOS Intel、macOS Apple Silicon、Windows x64 和 Linux x64 的原生 runner
构建。Runtime、Web、Planner 或依赖产物缺失时，打包命令会直接失败。

</details>

安装程序会在独立依赖树中分别构建 MetaWork Runtime 与
`planner/AnyFusion-Pi`。release、账户状态、配置、生成的运行时文件和更新日志统一
存放在 `~/.metawork`。

### 运行目录

macOS 和 Linux 使用以下目录，并通过 Unix socket 连接本地 Client：

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

Windows 使用 `%LOCALAPPDATA%\MetaWork\bin\*.cmd` 启动器，并通过 named pipe
连接本地 Gateway：

```text
%LOCALAPPDATA%\MetaWork\
├── bin/
│   ├── metawork.cmd
│   ├── anyfusion.cmd
│   └── metaclaw.cmd
├── app/
│   ├── current
│   └── releases/
├── data/
│   ├── runtime.lock
│   └── planner-sessions/
└── accounts/local-default/
    ├── config/
    ├── secrets/
    ├── data/
    ├── conversations/
    ├── workspace-store/
    ├── attempts/
    └── gateway/
```

如需修改安装根目录，请在安装前设置 `METAWORK_INSTALL_ROOT`。

## 快速开始

全新安装到跑通第一个交付任务只需三步：

```bash
# 1. 启动 Server（前台运行；长期部署请用上文的 supervision 模板）
metawork server start

# 2. 另开一个终端，在项目目录下启动单一 MetaWork TUI
cd /你的/项目目录
metawork

# 或使用 Web Client
metawork web            # 在浏览器中打开 http://127.0.0.1:8788
```

3. 用自然语言描述任务。Planner 负责理解需求并提出 Work Graph，ControlKernel
负责授权，Executor 在托管 Git worktree 中完成获批的 attempt。结果经验收后
通过 Git publication gate 发布，并交付回当前 Conversation。

更习惯在飞书里工作？完成第 1 步后运行 `metawork server setup-feishu`，
见下文[飞书](#飞书)。

### 命令速查

```text
metawork server start | stop | restart | status | doctor   # Server 生命周期与健康检查
metawork web [--no-open]          # Web Client，默认 http://127.0.0.1:8788（连接已运行的 Server）
metawork server setup-feishu      # 接入飞书机器人（交互式向导）
metawork gateway pairing list | approve | revoke <open_id>   # 飞书私聊准入
metawork build                    # 重新构建并原子激活 release
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

随时可用 `metawork provider test` 验证 Provider Key。

## 使用方式

### Web 工作区

连接已运行的 Server（`metawork server start`）：

```bash
cd /你的/项目目录
metawork web
metawork web --no-open
```

启动目录会成为该 Conversation 中 Planner 的只读工作区上下文，浏览器打开
`http://127.0.0.1:8788`。普通启动会使用短时 URL fragment bootstrap 换取
HttpOnly、SameSite=Strict session cookie；SSH、端口转发或手动打开浏览器时使用
`--no-open`。Executor 的获批修改发生在托管的 Task/Subtask Git worktree 中，
并经过 publication gate。

同一个 Conversation 中的每个 Turn 都会保留在页面和持久化 Planner session 中。
对话页展示完整的有界 Turn 历史；轨迹页默认只展示最新 Turn 对应的 Task。需要查看
旧任务时，可从对应历史 Turn 的执行卡片打开该任务的精确轨迹。

### 飞书

把飞书机器人接入同一个 Runtime：

```bash
metawork server setup-feishu    # 向导：扫码登录或 App ID/Secret，私聊与群聊策略
metawork server restart
```

推荐 WebSocket 连接模式，无需公网回调地址。默认 Pairing 私聊策略下，用户向
机器人发消息即发起接入申请，由管理员批准：

```bash
metawork gateway pairing list
metawork gateway pairing approve <open_id>
```

获批用户直接在飞书里把任务交给 MetaWork，结果也会交付回同一个会话。

### 构建与运行生命周期

无论当前在哪个目录，都可以执行 `metawork build`。它使用该安装记录的固定源码
checkout，重新安装依赖并构建 Runtime、Planner 和 Web，然后原子激活一套新
release，不改变账号数据。构建前先停止常驻 Server：

```bash
metawork server stop
metawork build
metawork server start
```

`metawork server start`、`metawork web` 和飞书 Gateway 都使用同一个已激活的
`app/current` release。`metawork build` 不启动 Server 或 Client；Server 仍在
运行时构建会直接失败。安装、升级或构建完成后需要重启 Server，所有 Client 才会
使用新激活的 Runtime 和 Web 静态产物。

工作区的 `dist/` 仅是构建产物，绝不作为 Server Runtime 运行。仓库中的
`npm run server:*` 和 `npm start` 也会统一代理到已安装的 `app/current`
release。修改源码后，执行 `metawork server stop`、`npm run setup:native`、
`metawork server start`，确保改动经过构建并激活到唯一的生产 Runtime。

`runtimePolicy.executorIdleTimeoutMs` 是可选的 Executor watchdog。它表示 idle
超时，不是 Task 或 attempt 的总体时长限制。已有安装如果使用过旧的
`attemptTimeoutMs` 字段，读取配置时会自动归一化为新字段。

### 管理命令

```text
metawork server status
metawork server doctor
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

### Provider 模型目录与能力标签

设置工作台的顺序是「运行时容量 → Provider 模型目录 → Planner → Executor 路由」，
因为 Planner 与 Executor 的模型都必须来自已配置的 Provider。

新增或修改 Provider 时，填好 Base URL 与 API Key 后点「**获取模型列表**」，即可用你刚
填写的凭据现场探测该 Provider 的 OpenAI 兼容 `/models`，列出它提供的全部模型；内置的
模型能力目录会为已收录的模型自动标注能力标签，未收录的模型显示「能力待确认」，可通过
「**补充能力**」手工勾选。点「加入候选」时能力标签会一并写入，因此不会出现能力为空的
模型。保存前的预检会直接指出「哪个 AgentClass 绑定的哪个模型缺少什么能力」，不再等到
激活时才给出难以定位的报错。

### Planner 的独立更新

Planner 与其它设置分开更新：Planner 板块有自己的「**更新 Planner**」按钮，只提交 Planner
绑定以及它依赖的 Model/Provider（含这些 Provider 的密钥），其余配置保持运行中状态不变；
「保存并激活」不会修改 Planner。这样更新其它设置时，不会顺带用尚未更新的 Planner 执行。

约束：有任务运行中时不能更新 Planner（按钮禁用并显示原因）；Planner 绑定的模型缺少必需
能力（如 `planning` / `structured-output`）或已不在模型目录中时，会先给出预检提示；更新
成功后只同步 Planner 基线，其它板块尚未保存的编辑会保留。

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
TUI / Web / Feishu / CLI
  -> ClientGateway
    -> ConversationSession
      -> AccountRuntime
        -> 隔离的 AnyFusion-Pi Planner
          -> PlanningAgentPlan v8
            -> 校验 + DurableKernelWorkflow
              -> ControlKernel
                -> Execution Runtime
                  -> Executor attempt
                    -> 验收 -> Git publication -> 交付
```

- 持久化 Server 是 Runtime owner。Client 只是 Gateway-only 客户端，不直接访问
  Storage、Kernel 或 Executor 进程。
- `ClientGateway` 负责版本化的多客户端命令/事件协议。
- `ConversationSession` 负责串行输入 mailbox 与持久化 AnyFusion-Pi Planner session。
  新的语义 Planner 回合不能直接回复工作型请求；除斜杠开头的系统命令外，都必须提交给
  Executor 执行。历史 direct-reply 记录仍可用于审计和回放。
- `AccountRuntime` 负责账户级共享服务和调度策略。每个 Conversation 拥有一个持久执行槽位，
  不同 Conversation 可以在配置的并发上限内并行执行。
- AnyFusion-Pi Planner 以隔离进程运行，只负责提出工作方案，不修改 Storage、不调度工作、
  不授权执行，也不执行 shell 命令。
- `ControlKernel` 是唯一负责授权、调度、模型 binding、恢复、retry、fallback、
  continuation、cancel 和 resume 的权威。
- Execution Runtime 负责应用 Kernel 决策，以及 claim、lease、原生 worktree 或 Docker
  兼容 backend、attempt、Git publication 与标准化 observation。
- Storage 通过领域 port 持久化事实，不是业务策略或生命周期决策的 owner。

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

MetaWork 正在进行商业化开发。当前正式版本为 `v0.1.4`，已提供 macOS
Intel、macOS Apple Silicon、Linux x64 和 Windows x64 的签名原生包。当前 Runtime
已经包含 Server/Client Gateway 分离、多端统一观察、用于快速切换会话的有界读模型、
原生 TUI 任务面板、隔离 Planner-first 路由、统一 Executor 能力画像、不同 Conversation
之间有限并行的顶层 Task，以及 Pi 图片执行链路。真实 Provider 图片生成与编辑仍需要
配置 OpenAI-compatible endpoint；生产 smoke 可能产生 Provider 用量费用。

## 许可

MetaWork 是闭源商业软件。它不通过仓库中历史遗留的开源许可证文件对外授权。对外分发
前必须由公司提供正式批准的商业许可条款。

AnyFusion 衍生组件及其他第三方开源组件继续遵守各自的版权、许可证、归属与 NOTICE
要求。根目录 `LICENSE` 暂时保留，供历史和第三方审查使用；它不代表 MetaWork
整体产品采用该许可证。
