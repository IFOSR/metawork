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
[许可](#许可) · [English](README.md)

</div>

## 为什么用 MetaWork

MetaWork 为 Agent 工作提供统一的商业服务系统，覆盖规划、授权、执行、恢复与交付。

- **持久工作：** Task、Work Graph、结果、恢复事实和审计记录可跨进程重启保留。
- **受控执行：** Planner 负责提出工作，ControlKernel 负责授权状态变化，
  Executor 只执行明确获批的 attempt。
- **多端统一：** Desktop、Web、TUI 与飞书客户端使用同一套版本化
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

[最新稳定版](https://github.com/IFOSR/metawork/releases/latest)是当前可安装版本的
统一发布入口。源码版本领先不代表已发布。

当前内部发布版本是 **v0.1.5**，包含 Server/Web/TUI 运行时和供公司内部使用的
Apple Silicon Desktop DMG。该 Desktop DMG **未使用 Apple Developer ID 签名且未公证**，专门用于公司内部
macOS 设备。[Release 页面](https://github.com/IFOSR/metawork/releases/latest)
是实际下载文件和校验值的唯一来源。

当前内部发布只提供 macOS Apple Silicon（`arm64`）DMG，没有 Intel（`x64`）Desktop
包；Intel 用户请使用 Server/Web/TUI 安装方式，或等待 x64 构建。暂不提供
Linux/Windows Desktop 安装包。

## 安装方式

Desktop、浏览器、TUI 与飞书共享同一套 Server；连接同一安装和账号时共享数据。
Web 已包含在 Server 安装包中，不需要安装 Desktop。

| 希望使用的界面 | 安装内容 | 入口 |
| --- | --- | --- |
| macOS 桌面应用 | 对应 Mac 架构的 Desktop DMG | 打开 MetaWork.app |
| 浏览器 | 原生 Server 安装包 | 启动 Server，再执行 `metawork web` |
| 终端 TUI | 同一 Server 安装包 | 启动 Server，再执行 `metawork tui` |
| 飞书 | 同一 Server 安装包，再配置飞书应用 | `metawork server setup-feishu` |
| 源码开发 | 下文源码步骤 | CLI 或隔离的 Desktop 开发版 |

### macOS Desktop 桌面应用（内部版，Apple Silicon）

1. 在 **苹果菜单 → 关于本机** 确认 Mac 使用 Apple Silicon（M 系列）。
2. 如果尚未安装 Apple Command Line Tools，先在终端执行 `xcode-select --install`，
   按 macOS 提示完成安装。内部包使用系统 Git wrapper 执行仓库操作。
3. 从最新 Release 下载 [MetaWork-darwin-arm64.dmg](https://github.com/IFOSR/metawork/releases/latest/download/MetaWork-darwin-arm64.dmg)，
   打开 DMG，把 **MetaWork.app** 拖入“应用程序”。
4. 由于这是未公证内部 DMG，首次启动可能被 macOS 拦截。在 Finder 中右键
   **MetaWork.app**，选择“打开”，再确认“打开”。如果仍被拦截，进入
   **系统设置 → 隐私与安全性**，找到安全提示并点击“仍要打开”，然后再次执行本步。
5. MetaWork 安装窗口会要求填写“模型 API 地址”“模型 ID”“API Key”。填入公司
   使用的模型服务信息后点击“安装并开始使用”。凭据保存在本机 macOS 凭据库。
6. 安装完成后会打开 Web 工作区；首次使用时完成登录并选择 Workspace。

安装包包含 Node、Pi Executor、Server/Web 与 Planner；macOS Command Line Tools 提供
仓库操作所需的系统 Git，Codex 为可选项。默认安装目录为 `~/.metawork`，兼容的已有安装会被复用，版本不兼容
时需要联合升级。可通过菜单 **安装终端命令…** 安装 `metawork`，让 Web/TUI 连接同一
Server。关闭窗口或退出 Desktop 后，后台服务和任务继续运行。

升级时下载并挂载最新 DMG，在当前 Desktop 中选择 **安装新版应用…**，选中新包的
`MetaWork.app`。程序协调 Desktop 与 Server 升级，并提示对运行中工作的影响。
Desktop 管理的安装应使用这一入口，避免只更新 Server 导致版本不匹配。

以后使用浏览器时，启动 Desktop（或已安装的 Server）后执行 `metawork web`；使用
原生终端界面执行 `metawork tui`。两者都连接 Desktop 创建的同一 Server 和账号数据，
不要为它们重复安装第二套运行时。

### Server + Web / TUI / 飞书

先准备 **Node.js 22.x（至少 22.19.0）**、Git、模型服务的 API 地址/模型 ID/API Key，
以及至少一种位于 `PATH` 的受支持 Executor CLI（Pi Agent 或 Codex）。安装器检测
Executor CLI，但不会代为安装。预构建包已包含原生依赖；npm 与原生编译工具用于
源码构建，普通预构建安装不需要编译。

macOS、Linux x64、WSL2 x64，在可输入的交互终端运行：

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh -o metawork-install.sh
bash metawork-install.sh
export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

Windows x64，在 PowerShell 中执行；需要启用 Developer Mode 或使用管理员终端，
以支持事务性 NTFS Release 指针：

```powershell
irm https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.ps1 -OutFile metawork-install.ps1
.\metawork-install.ps1
```

两个安装器均获取**最新稳定版的签名 manifest**，校验 Runtime/Planner 归档，并通过
配置向导设置模型服务。Linux/WSL2 默认使用文件 SecretStore。Release 页面会在对应
平台归档可用时附带 `install.sh` 和 `install.ps1`。当前内部版的预构建运行时是
Apple Silicon；Shell 安装器会对不支持的架构明确报错，不会安装不匹配的归档。

安装后，在一个终端启动 Server 并保持运行：

```bash
metawork server start
```

在另一个终端按需选择客户端：

```bash
metawork web                    # 浏览器；账号 admin，密码 123456
metawork tui                    # 原生终端界面
metawork server setup-feishu    # 可选：配置飞书应用
```

Web 打开 Server 实际使用的本机地址，默认端口为 8788；飞书接入也由这个 Server
管理。需要后台常驻时，使用 `scripts/supervision/` 的 launchd/systemd 模板。

CLI 管理的安装升级时，先执行 `metawork server stop`，重新运行同一安装命令，
再执行 `metawork server start`。升级保留配置、密钥和账号数据，重复安装同一版本
不会重置数据。`metawork server status` 查看运行中的服务，latest 页面显示可下载版本。

设置 AI 改写、能力解释和模型摘要等可选功能需要单独配置
[内部 LLM](docs/current/internal-llm-service.md)；缺少它不会阻止安装或手动配置。

### 源码安装与 Desktop 开发

源码构建需要 npm、原生编译工具，以及下载固定 Python/PDF 依赖的网络连接。
要构建**最新已发布源码**，先在 latest 页面取得 tag，替换下文的 `<latest-tag>`：

```bash
git clone --branch <latest-tag> --depth 1 https://github.com/IFOSR/metawork.git
cd metawork
./setup.sh
export PATH="$HOME/.local/bin:$PATH"
```

在已有源码目录开发 Desktop：

```bash
npm ci
npm ci --prefix web --ignore-scripts
npm ci --prefix apps/desktop
npm ci --prefix planner/AnyFusion-Pi --ignore-scripts
npm run dev:desktop
```

开发脚本使用独立的 `.tmp/desktop-development`，不共享正式安装的历史。
当前开发辅助脚本需要按内部 LLM 指南提前配置系统模型，正式 Desktop 安装没有
这一开发前提。修改后端后执行 `npm run dev:desktop -- --refresh`。
详见 [Desktop 开发说明](apps/desktop/README.md)。

非交互原生安装可设置 `METAWORK_PROVIDER_KEY`、`METAWORK_PROVIDER_URL`、
`METAWORK_PROVIDER_MODEL` 与 `METAWORK_PROVIDER_REGION`。密钥不能提交到源码
或放入发布产物。

### 卸载

删除 Desktop 应用保留账号数据，也不会停止 Server；如需停止，请先显式操作。
`bash metawork-install.sh --uninstall` 会删除托管命令和**整个安装目录，包括账号数据**，
请先备份需要保留的工作。

维护者请参阅[发布操作指南](docs/current/releasing.md)。

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

## 许可

MetaWork 是闭源商业软件。它不通过仓库中历史遗留的开源许可证文件对外授权。对外分发
前必须由公司提供正式批准的商业许可条款。

AnyFusion 衍生组件及其他第三方开源组件继续遵守各自的版权、许可证、归属与 NOTICE
要求。根目录 `LICENSE` 暂时保留，供历史和第三方审查使用；它不代表 MetaWork
整体产品采用该许可证。
