<p align="center">
  <strong>上海元融合人工智能科技有限公司</strong>
</p>

<div align="center">

# MetaWork

**面向持久化、可治理 Agent 工作流的商业 AI Task OS。**

MetaWork 把自然语言需求变成可持久化的 Task 与 Work Graph，只经过一条有主的控制链
（Manager 提议 → 准入 → Router 决策 → Executor 执行 → 验收 → 交付），结果、回执与
恢复事实跨进程重启保留，而不是停留在一次聊天回复。

[安装](#安装) · [快速开始](#快速开始) · [0.1.29 新增](#0129-新增) ·
[架构](#架构) · [从旧架构升级](#从旧架构升级) · [使用方式](#使用方式) ·
[许可](#许可) · [English](README.md)

</div>

## 安装

**当前版本：v0.1.29（内部版），所有资产来自同一个构建
`0.1.29-build-0ab2ee7`（revision `0ab2ee7`）。** 下载入口：
[latest release](https://github.com/IFOSR/metawork/releases/latest)。

| 平台 | 用途 | 下载 |
| --- | --- | --- |
| macOS Apple Silicon（`arm64`） | **桌面应用**（内含 Runtime、Web 与 Executor Pi） | [MetaWork-darwin-arm64.dmg](https://github.com/IFOSR/metawork/releases/latest/download/MetaWork-darwin-arm64.dmg) — 345,085,425 字节，SHA-256 `b6053c22b1e816a64c80c63cdd45da4a77a6f2a29ebe806ba789fe2b128812c1` |
| macOS Apple Silicon（`arm64`） | **Server 包**，用 Web 客户端访问 | [install.sh](https://github.com/IFOSR/metawork/releases/latest/download/install.sh) · [manifest.darwin-arm64.json](https://github.com/IFOSR/metawork/releases/latest/download/manifest.darwin-arm64.json) |
| macOS Intel（`x64`） | **Server 包**，用 Web 客户端访问 | [install.sh](https://github.com/IFOSR/metawork/releases/latest/download/install.sh) · [manifest.darwin-x64.json](https://github.com/IFOSR/metawork/releases/latest/download/manifest.darwin-x64.json) |
| Linux / WSL2（`x64`） | **Server 包**，用 Web 客户端访问 | [install.sh](https://github.com/IFOSR/metawork/releases/latest/download/install.sh) · [manifest.linux-x64.json](https://github.com/IFOSR/metawork/releases/latest/download/manifest.linux-x64.json) |

该 Release 共 15 个资产、全部是同一个构建：9 个归档（三个平台的 `metawork`、
`memory`、`pi`）、3 个签名 manifest、`install.sh`、Pi 构建期 pin，以及 1 个桌面 DMG。

- **只有 macOS Apple Silicon 有桌面安装包。** macOS Intel 与 Linux x64 只发 Server
  包、通过 Web 使用；没有 Intel DMG、没有 Linux 桌面包、没有 Linux arm64 归档。
- **不发布任何 Windows 产物**（既无 Server 包，也无 `install.ps1`）。Windows 源码已
  标记为不维护，仅保留在
  [`fix/windows-native-web`](https://github.com/IFOSR/metawork/tree/fix/windows-native-web) 分支。
- 桌面 DMG 是**内部版 ad-hoc 签名、未做 Apple 公证**，首次启动需要在访达里右键
  **打开**，或在「系统设置 → 隐私与安全性」里选择 **仍要打开**。
- Server 归档由安装器按签名 manifest 校验（`sha256` + 字节数，信任根
  `metawork-release-2026-03`）；每个归档包含 Runtime（`dist` + 生产依赖 + Web 资产）、
  Memory 引擎与固定版本的 Pi Executor。

两种用法：**桌面应用**（macOS arm64，见下）或**Server 包 + Web 客户端**（三个平台
均可用）。二者共用同一个安装根目录与同一份账号数据。

## 安装步骤

下面分别说明桌面应用、Server 包、源码安装，以及如何卸载。

### macOS Desktop 桌面应用（内部版，Apple Silicon）

1. 在 **苹果菜单 → 关于本机** 确认 Mac 使用 Apple Silicon（M 系列）。
2. 如果尚未安装 Apple Command Line Tools，先在终端执行 `xcode-select --install`，
   按 macOS 提示完成安装。内部包使用系统 Git wrapper 执行仓库操作。
3. 从最新 Release 下载 [MetaWork-darwin-arm64.dmg](https://github.com/IFOSR/metawork/releases/latest/download/MetaWork-darwin-arm64.dmg)，
   打开 DMG，把 **MetaWork.app** 拖入“应用程序”。
4. 由于这是未公证内部 DMG，首次启动可能被 macOS 拦截。在 Finder 中右键
   **MetaWork.app**，选择“打开”，再确认“打开”。如果仍被拦截，进入
   **系统设置 → 隐私与安全性**，找到安全提示并点击“仍要打开”，然后再次执行本步。
5. 首次启动不要求填写模型凭据。应用会把 `.app` 内置的 Runtime 自动安装到
   `~/.metawork` 并重启后台服务，窗口内显示进度与最终状态，不需要手动确认。若上次
   更新被中断，它会隔离不兼容的安装、干净安装当前版本，干净安装失败则还原原安装。
   已有凭据、对话和工作数据都会保留。
6. 后台服务就绪后会打开 Web 工作区；模型可稍后在设置中配置，再完成首次登录并选择
   Workspace。

安装包包含 Node、Pi Executor、Server/Web 与 Memory 引擎（不再包含 Planner fork）；
macOS Command Line Tools 提供仓库操作所需的系统 Git，Codex 为可选项。默认安装目录为
`~/.metawork`。已有安装的模型配置、对话和工作数据会保留；请勿为接入 Desktop 删除该
目录。可通过菜单 **安装终端命令…** 安装 `metawork`，让 Web 连接同一 Server。关闭窗口
或退出 Desktop 后，后台服务和任务继续运行。

升级时下载并挂载最新 DMG，退出 MetaWork，将 `MetaWork.app` 替换到“应用程序”。下次
启动会自动采用应用内置的 Runtime、重启后台服务并显示进度，不再需要手动点击。没有单独
的文件安装菜单。不要删除 `~/.metawork` 或应用支持目录。

以后使用浏览器时，启动 Desktop（或已安装的 Server）后执行 `metawork web`；裸
`metawork` 也会打开同一个 Web 客户端。早期版本文档中的 TUI 已移除，不再是受支持的
客户端。Web 使用 Desktop 创建的同一 Server 与账号数据，不要重复安装第二套运行时。

### Server + Web / 飞书

先准备 **Node.js 22.x（至少 22.19.0）**、Git、模型服务的 API 地址/模型 ID/API Key，
以及至少一种位于 `PATH` 的受支持 Executor CLI（Pi Agent 或 Codex）。安装器检测
Executor CLI，但不会代为安装。预构建包已包含原生依赖；npm 与原生编译工具用于
源码构建，普通预构建安装不需要编译。

macOS Apple Silicon 或 Intel、Linux x64、WSL2 x64，在可输入的交互终端运行：

```bash
curl -fsSL https://github.com/IFOSR/metawork/releases/latest/download/install.sh -o metawork-install.sh
bash metawork-install.sh
export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

该命令使用**最新稳定版的签名清单**，并在安装前校验 Runtime/Memory/Pi 归档。

Linux/WSL2 默认使用文件 SecretStore。安装器会对不支持的架构明确报错，
不会安装不匹配的归档。

安装后，在一个终端启动 Server 并保持运行：

```bash
metawork server start
```

在另一个终端按需选择客户端：

```bash
metawork web                    # 打开本机 Web 工作区（裸 `metawork` 效果相同）
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

如需修改安装根目录，请在安装前设置 `METAWORK_INSTALL_ROOT`。

## 快速开始

### 路径 A —— macOS Apple Silicon 桌面应用

1. 打开 DMG，把 **MetaWork.app** 拖进 **应用程序**（内部版未公证，首次启动可能需要
   访达右键 **打开**）。
2. 启动它。应用会把 `.app` 内置的 Runtime 安装到 `~/.metawork`，启动后台 Server
   并显示进度 —— 不需要手动确认，也不需要命令行。若上次更新被中断，它会隔离不兼容
   的安装后重新干净安装，干净安装失败则还原原安装。
3. 窗口进入 Web 工作区后，打开 **设置** 完成一次性配置：新增 Provider（Base URL +
   API Key，然后点 **获取模型列表**），选择模型，为每个必需角色绑定各自的模型
   （总管 Manager 始终启用，助理/分析师为 Executor），最后 **保存并激活**。
4. 用 **＋** 添加 Workspace（本机目录），点 **新建会话**，用自然语言描述任务。Manager
   给出 Work Graph 提案，MetaWork 准入，Router 为每个 Subtask 选定 Agent/模型，结果
   经统一验收与 Git 发布门禁后回到该 Conversation。

### 路径 B —— Server 包 + Web 客户端（三个平台通用）

```bash
# 1. 安装或更新到 ~/.metawork 下唯一激活的 release
curl -fsSL https://github.com/IFOSR/metawork/releases/latest/download/install.sh | bash

# 2. 启动 Server（前台运行；后台运行用 scripts/supervision 模板）
metawork server start

# 3. 打开 Web 客户端（裸 `metawork` 效果相同）
metawork web            # http://127.0.0.1:8788
```

随后与路径 A 第 3 步相同地配置模型与角色，再建立 Workspace 与 Conversation。
`metawork web --no-open` 只使用/打印地址（SSH、端口转发时用）。飞书可选：
`metawork server setup-feishu`。

### 首次配置清单

1. **Provider 与模型** —— 设置 → 模型 → 新增模型；工作台会探测该 Provider 的
   `/models` 并标注已知能力。
2. **角色绑定** —— 设置 → 智能体；每个必需角色都必须绑定自己的模型，**保存并激活**
   才会通过校验（校验会点名缺绑定的角色）。
3. **Workspace** —— Executor 可修改的本机目录；改动发生在托管的 Git worktree 中并
   经过发布门禁。
4. **Conversation** —— 一个 Conversation 保存 Turn 历史；Trajectory 默认显示最新
   Turn 的 Task，可展开更早 Turn 的执行卡片。

### 命令速查

```text
metawork server start | stop | restart | status | doctor   # Server 生命周期与健康检查
metawork web [--no-open]          # Web 客户端 http://127.0.0.1:8788
metawork server setup-feishu      # 接入飞书机器人（交互向导）
metawork gateway pairing list | approve | revoke <open_id>
metawork build                    # 重建源码 checkout 并原子激活一个 release
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

## 0.1.29 新增

0.1.29 把 Executor 的联网工具迁到 DeepSeek，并把它的计费请求纳入用量统计。完整列表见
[发布说明](docs/releases/v0.1.29.md)。

- 配置了 DeepSeek Provider 凭据时，`web_search` 优先使用 DeepSeek 搜索 API，否则回落到
  Bing HTML；结果新增发布日期、站点与权威度。百度抓取后端已删除。
- `web_fetch` 按 affordance 分流：研究类 attempt 走 DeepSeek 提取 API，工作区任务保留
  curl，仍可访问自己启动的本地服务。
- DeepSeek 凭据就是 Provider 的 Key（没有独立搜索 Key）；凭据不可解析时回落到 Bing，
  不会让 attempt 失败。
- 计费的联网请求计入用量：每次计费搜索记一条 `search` 请求、每次计费抓取记一条
  `tool_request` 请求，在账号用量页展示；免费兜底与被拒 URL 不计入。

## 0.1.27 新增

0.1.27 是落地目标架构及其周边恢复能力的版本。以下内容都在本构建中，完整证据见
[发布说明](docs/releases/v0.1.27.md)。

**架构**
- 内核控制轴移除：任务准入、生命周期、派发、恢复与发布由 Task Runtime 基于
  `src/control` 契约负责；Manager 只产出提案，由 MetaWork 校验。
- Manager 与 Executor 都运行**固定版本的上游 Pi（`1.5.0`）**；内置的
  `planner/AnyFusion-Pi` fork 已删除、不再随包发布。
- 规划事实改为携带**执行可写事实**（Executor 在 Conversation Git worktree 中提交、
  Runtime 负责合并回写），不再把 Manager 的只读工具面当作 Workspace 属性；澄清只用于
  用户意图歧义。
- Schema `67 → 68` **原地升级**（`task_operation_results.outcome` 增加
  `repair_pending`）；更老或畸形的 schema 仍在任何写入前拒绝。

**执行与恢复**
- 可恢复的阻塞 Subtask 不再把 Task 判死，Task 保持 `needs_action`，**继续未完成部分**
  可带原回执续跑。
- 处于 `executing` 却没有活跃派发的 Task 会被就地停放：取消空转 replan，并通过 Task
  状态权威收敛阻塞。
- 收敛阶段会取消终态 Task 的孤儿 replan，失败 Task 不再让 Conversation 槽位卡在
  `releasing` 而阻塞后续任务。
- `recoverDue` 在有可运行工作时真正派发；被显式接受的回执计为完成来源。
- 运行或终止进程需要 Workspace 独占访问；外部进程终止必须由显式用户轮次触发。
- `web_fetch`/`web_search` 识别到反爬/验证页时返回可重试的阻塞来源，而不是把验证页
  正文交给模型。
- Router 决策模型不可用时使用确定性默认绑定（`selection: default_fallback`）；只有
  候选集为空才阻塞。

**Web**
- Manager 规划过程可观测：阶段时间线、工具名、参数/结果字段名与耗时，在规划卡片内
  就地展开，轮次收尾后随之消失。
- 轨迹事件不再携带状态，已结束的轮次不再出现常驻 `running` 与呼吸动画。

**桌面**
- 更新中断且恢复阶段失败时会自动修复：隔离不兼容安装（不处理符号链接、不在更新
  helper 或后台仍在运行时动手），干净安装当前版本，干净安装失败则还原原安装。
- 数据目录选择允许空目录开始全新安装，拒绝非 MetaWork 安装的非空目录。
- `electron-builder` 使用本地固定的 Electron 发行包，不再额外拉取校验元数据。

**打包**
- 归档按显式运行时白名单构建，剔除开发工具链（`typescript`、`vitest`、`esbuild`、
  `tsup`、`vite`、`rollup`、`@types`、`.bin`）以及仓库 `docker`/`.github` 目录。
- Apple Silicon DMG 在同等功能面下从约 465 MB 降到约 345 MB，15 个资产使用同一个
  release 身份。

## 架构

### 控制流

```text
用户 -> Manager:      理解意图，产出 Work Graph 提案
                     （不含 Agent/模型字段，不写存储）
    -> Task Runtime:  准入提案、校验图、持久化图修订
    -> Router:        为每个就绪 Subtask 决定 {Agent, 模型, 理由}
    -> Task Runtime:  持久化路由决策、领取 attempt、启动 Executor
    -> Executor:      在强制边界内完成被授权的工作
    -> Task Runtime:  回执、生命周期、发布、机械恢复
    -> Manager:       向用户汇总 Task 结果
```

只有三个角色：**Manager**、**Router**、**Executor**，没有 Kernel。Work Graph 是纯规则
模块，Task Runtime 是应用/运行时模块，Host 是强制边界，Storage 是适配器，Application
Shell 负责准入与客户端投影。

### 一个事实只有一个归属

| 关注点 | 归属 |
| --- | --- |
| Turn/Conversation 准入、Task 创建 | Application Shell + Task Runtime 准入契约 |
| 意图理解、图提案、重规划语义、最终汇总 | Manager（`src/planning`，经 `src/planning/manager-host` 运行上游 Pi） |
| 图 schema、DAG、依赖与前沿规则 | Work Graph（`src/work-graph`） |
| 每个 Subtask 的 Agent/模型选择及其理由 | Router（`src/routing`） |
| 路由持久化、候选事实、派发身份 | Task Runtime（`src/task`、`src/execution`） |
| Task/Subtask/Attempt 生命周期、租约、取消、恢复 | Task Runtime（`src/task`、`src/execution`） |
| Executor 工具面、回合循环、工具重试/修复 | Executor/Harness（`src/executor`、上游 Pi） |
| 权限语义 | Manager |
| 权限记录、范围校验与应用 | Permission Service（`src/resource`、`src/execution/permission-workflow-service`） |
| 权限强制 | Host/Executor 进程边界 |
| 完成认证与结果交付 | Delivery/Completion（`src/delivery`） |
| Workspace 发布、合并顺序、冲突修复请求 | Task Runtime 发布 worker |
| 每次模型调用的 token 事实 | Metering（`src/metering`） |
| Server 监听、认证、允许来源、内网回环 | Server/Gateway（`src/gateway`、`src/management`） |
| 重启恢复机制 | Task Runtime 启动恢复（`src/account`、`src/execution`） |

`ControlLoopPolicy` 是单 Task 的**进程内**生命周期门面，逐条调用上述归属方的策略；它
不是持久化 inbox/决策账本、不是 replay 引擎、也不对 Router 输出做二次审批。重复的决策
通路、Kernel 兼容 API 与改名后的“中央协调器”都被禁止。

### 持久化与恢复

- Task、Subtask、attempt、结果、发布、权限、用量与客户端事实各有唯一归属表，跨重启
  存活；被中断的操作记录在 `task_recovery_items`，不再依赖被回放的控制账本。
- SQLite schema `68` 由 `src/storage/current-schema.ts` 定义：启动时接受当前 schema、
  只对紧邻的上一版（`67 → 68`）做一次原地升级，更老或畸形 schema 在任何写入前拒绝。
- Executor 工作没有总墙钟上限；可选看门狗只在 Executor 进程真正空闲时触发，权威操作
  进行中暂停。
- 交付前必须先完成认证；未交付的发布永不会显示为完成；只有 Manager 声明为可选的
  Subtask 才能从成功结果中缺席。

### 发布包包含什么

| 组成 | 来源 | 为什么 |
| --- | --- | --- |
| Runtime | `dist/`（tsup 构建）+ 生产 `node_modules` + `web/dist` | 一个 Server 进程、一份 Web 资产 |
| Memory 引擎 | 固定版本的 `memory/tdai` 目录树 | 本地长期记忆离线可用 |
| Executor Pi | 固定版本的上游 Pi 发行包 | 不依赖宿主全局 Pi，也不再维护 fork |
| Manifest | Ed25519 签名（`metawork-release-2026-03`） | 安装器按字节数与 SHA-256 校验每个归档 |
| 桌面 payload（仅 DMG） | 与上面相同的 Runtime/Memory/Pi 归档 | 应用直接采用内置 payload，无需下载 |

Manager 与 Executor 运行**同一个**固定版本的上游 Pi，其版本与 lock 摘要写入 manifest；
Pi 缺失或不是该固定版本时构建直接失败。Manager 由 `src/planning/manager-host` 在独立
进程中运行，并且只产出提案。

### 网络与强制边界

- Server 只说 HTTP，TLS 在反向代理终止；配置面为 `server.host`、
  `server.allowedOrigins`、`server.trustProxy`；通配绑定 + 空允许列表会拒绝启动。
- 浏览器访问需要账号登录，登录会话即传输层，Origin/CSRF 校验保留。
- 内部端点（Manager bridge、Memory sidecar、官方本地服务、MCP）只走回环或 Unix
  socket。本构建的隔离声明是“可信用户进程 + Host 强制”，没有 OS 沙箱，退役的 Docker
  attempt 后端不是受支持的替代路径。

## 从旧架构升级

本版本是切换到目标架构的版本，因此有必要写清：改了什么、为什么合理、以及已有安装会
发生什么。

### 移除的内容

| 已移除 | 替代者 |
| --- | --- |
| `ControlKernel`、`DurableKernelWorkflow`、Kernel 事件/快照/决策、决策账本与 replay | `src/control` 契约 + Task Runtime 上的 `ControlLoopPolicy`；中断操作记入 `task_recovery_items` |
| 内置 `planner/AnyFusion-Pi` fork | Manager 与 Executor 都使用固定版本的上游 Pi（`src/planning/manager-host`） |
| Manager 提案中的 Agent/模型选择 | Router 为每个 Subtask 决策并持久化理由 |
| Ink TUI、独立 agent TUI 及 TUI 专属参数 | Web 客户端（`metawork web`；裸 `metawork` 也打开它） |
| Docker attempt 后端、attempt 镜像、出网代理、Docker 专用测试 | 可信宿主执行 + Host 强制 |
| Codex 执行适配器及其配置/目录 | 仅本机执行的配置面 |
| 模型价格、单任务成本、金额确认状态 | Metering 只保留 token 事实；计费权威留在 `official-server` |
| 原生 Windows 支持 | 声明为不维护；源码留在侧分支，不产出任何包 |

### 为什么新架构更合理

- **一个事实只有一个归属。** 生命周期、路由、权限、发布、用量各有唯一写入方，故障因此
  能定位到“谁产生的事实”，而不是归给“系统”。没有重复决策通路、没有账本回放、也没有
  对 Router 输出的二次审批。
- **每次请求的部件更少。** 被移除的 Kernel 为了回答归属方能直接回答的问题，额外引入了
  持久化 inbox、决策账本与回放机制。删除它们消除了一整类“卡死状态”缺陷：0.1.27 修复的
  停放 Task、孤儿 replan、可续跑阻塞，正是过去会被第二决策权威掩盖的故障。
- **发布可复现。** Manager 与 Executor 同源固定 Pi，归档按显式白名单构建，每个资产都有
  签名与哈希校验，"本机能跑"的漂移大幅减少。
- **升级可预期。** 一次前向 schema 步骤、同一个安装根目录、桌面端自动采用 Runtime，并在
  干净安装失败时还原 —— 而不是迁移链加手工修复脚本。
- **失败语义诚实。** 硬拒绝不能被任何模型覆盖，未知能力 fail closed，`no_candidate` 明确
  阻塞而不是静默回退，未交付的发布不会显示为完成。
- **交付更轻。** DMG 从约 465 MB 降到约 345 MB，归档不再携带开发工具链。

### 已有安装如何升级

- **同根目录、同数据。** 安装根目录（`~/.metawork`）与账号数据（Conversation、
  Workspace、记忆资产、任务结果、配置修订）保持原位；除了登记在案的 schema 升级之外，
  不重新导入、不改写其它内容。
- **数据库。** 启动时接受 schema `68`，只对 `67` 做一次原地升级，更老或畸形 schema 在
  **写入之前**拒绝并给出备份路径与重置指引；没有导出/半开路径，被移除的 Kernel 账本不再
  读取。
- **桌面（macOS arm64）。** 用新 DMG 替换 `MetaWork.app` 后启动：它会采用应用内自带的
  Runtime、重启后台 Server 并显示进度，无需手动步骤；若上次中断留下了不兼容安装，会隔离
  该目录、干净安装，干净安装失败则还原原安装。凭据、Conversation 与 Workspace 全部保留。
- **Server 包。** 重跑 `install.sh`（源码 checkout 用 `metawork build`）：安装器先校验
  归档，再在 `app/releases/<releaseId>` 下激活一个 release 并由 `app/current` 指向它；
  重启后 `metawork server start` 与 Web 客户端即使用新版本，端点（默认
  `http://127.0.0.1:8788`）不变。
- **有意不兼容的部分。** 不提供 Kernel API、决策账本、TUI 入口、Windows 包或 Docker
  attempt 后端的回退路径，也没有兼容 shim。历史运行时标识（`MetaClaw`、`anyfusion`、
  `METACLAW_*`）只在改名会破坏已安装数据或已签名契约的地方保留名称，不携带第二套行为。
  依赖这些被移除面的脚本需要迁移到 Web 客户端、下面的 CLI 命令或 `src/control` 契约。

## 为什么用 MetaWork

MetaWork 为 Agent 工作提供统一的商业服务系统，覆盖规划、准入、执行、恢复与交付。

- **持久工作：** Task、Work Graph、结果、恢复事实和审计记录可跨进程重启保留。
- **受控执行：** Manager 提出工作，MetaWork 负责准入与校验，Executor 只执行明确获批的
  attempt。
- **多端统一：** Desktop、Web 与飞书客户端使用同一套版本化 Gateway 命令与事件平面；
  Server 独立常驻，Client 退出不会停止 Runtime。
- **多端统一观察：** Web 与飞书可以查看同一批 Task 与会话。会话切换读取有界客户端读
  模型，不需要重放整段历史；执行中、排队中与需要处理的任务在各端一致可见。
- **可解释路由：** 每个 attempt 都固定到一个配置 revision，以及 Provider、Model、
  AgentClass 与 Permission Profile 绑定，并在轨迹中携带 Router 持久化的选择理由。
- **能力驱动路由：** Router 依据各 AgentClass 的职责与能力证据，对照 Subtask 的目标与
  验收条件选择智能体与模型。通用能力标签不用于质量评分，不保留任何模型价格状态，执行与
  权限条件仍严格校验。
- **上下文连续：** Manager 通过持久化的 Pi session 理解「这张图片」「刚才生成的报告」等
  自然表达；MetaWork 的 context bridge 提供有界 Conversation 事实、校验选中的历史资产，
  并只向 Executor 物化已授权的输入。
- **长任务可靠执行：** Executor 没有总体执行时长上限。可选 watchdog 只在 Executor 进程
  确实空闲时触发，权威操作进行中暂停计时。
- **显式恢复：** retry、fallback、continuation、merge repair、cancel 与 resume 都由
  MetaWork 的持久控制契约负责。

```text
提议 -> 准入 -> 路由 -> 派发 -> 执行 -> 验证 -> 发布 -> 交付
```

## 产品边界

MetaWork 是本仓库统一呈现的产品，是闭源商业软件。

[AnyFusion](https://github.com/IFOSR) 是独立的开源项目。MetaWork 可以复用或改造其中已
正确归属的组件与契约；为不破坏已有安装或已签名契约，`MetaClaw`、`anyfusion`、
`METACLAW_*` 等历史 runtime 标识在必要处保留名称。Manager 与 Executor 运行固定版本的
上游 Pi（ADR-0055 D6）；内置的 `planner/AnyFusion-Pi` fork 已删除，不再属于本仓库或它的
发布包。

## 使用方式

### Web 工作区

连接已运行的 Server（`metawork server start`）：

```bash
cd /你的/项目目录
metawork web
metawork web --no-open
```

启动目录会成为该 Conversation 的 Workspace：Manager 以自己的只读工具面检视它，
但 Workspace 本身不是只读的。浏览器打开
`http://127.0.0.1:8788`。普通启动会使用短时 URL fragment bootstrap 换取
HttpOnly、SameSite=Strict session cookie；SSH、端口转发或手动打开浏览器时使用
`--no-open`。Executor 的获批修改发生在托管的 Task/Subtask Git worktree 中，
并经过 publication gate。

同一个 Conversation 中的每个 Turn 都会保留在页面和持久化的 Manager session 中。
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
checkout，重新安装依赖并构建 Runtime 和 Web，然后原子激活一套新
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

设置工作台的顺序是「运行时容量 → Provider 模型目录 → Manager → Executor 路由」，
因为 Manager 与 Executor 的模型都必须来自已配置的 Provider。

新增或修改 Provider 时，填好 Base URL 与 API Key 后点「**获取模型列表**」，即可用你刚
填写的凭据现场探测该 Provider 的 OpenAI 兼容 `/models`，列出它提供的全部模型；内置的
模型能力目录会为已收录的模型自动标注能力标签，未收录的模型显示「能力待确认」，可通过
「**补充能力**」手工勾选。点「加入候选」时能力标签会一并写入，因此不会出现能力为空的
模型。保存前的预检会直接指出「哪个 AgentClass 绑定的哪个模型缺少什么能力」，不再等到
激活时才给出难以定位的报错。

### 智能体与模型绑定

设置工作台分三组：**模型**（Provider 与模型）、**执行工具**（内置 Executor Pi 与各
AgentClass 就绪状态）、**智能体**（角色）。总管（Manager）始终启用，是规划入口；助理与
分析师是 Executor 角色。每个必需角色都必须绑定自己的模型，「保存并激活」才会被接受；
激活前校验会点名仍然缺绑定的角色，而不是给出难以定位的错误。

保存即一次激活：草稿先校验、写成配置修订，再作为一个整体应用到运行中的 Server。有任务
运行中时不能替换 Manager；其它板块尚未保存的编辑会保留。

### Executor 能力配置

每个 Executor 都有独立的能力说明书，而不是所有 Executor 共用一组可自由编辑的标签。
用户应先配置该 Executor 允许或自动选择的模型，再用自然语言描述它擅长什么、不擅长什么，
以及哪个模型为它带来了什么具体能力。页面上的“更新能力画像”是一个统一操作，会同时完成：

1. 根据当前模型池重新计算系统能力事实；
2. 将用户自然语言定义与系统事实语义合并；
3. 为这个 Executor 生成中文 Skill-style 说明书；
4. 从同一份能力画像提炼只读标签和结构化路由投影。

最终说明书是 Manager 进行语义理解和路由匹配的依据；结构化路由投影是它的机器可读视图，
供 Manager 校验和 MetaWork 选择具体模型。用户定义优先于冲突的系统定位，但不能借此
授权未配置的模型、扩大权限或绕过 Kernel 授权。移除一个模型后，刷新能力画像会自动移除
仅由该模型提供证据的能力。

## 许可

MetaWork 是闭源商业软件。它不通过仓库中历史遗留的开源许可证文件对外授权。对外分发
前必须由公司提供正式批准的商业许可条款。

AnyFusion 衍生组件及其他第三方开源组件继续遵守各自的版权、许可证、归属与 NOTICE
要求。根目录 `LICENSE` 暂时保留，供历史和第三方审查使用；它不代表 MetaWork
整体产品采用该许可证。
