# Windows Desktop 构建与交付方案

- 计划日期：2026-10-07
- 状态：In Progress / P0 管道/ACL、Job 创建压力与 macOS 双架构基线已验证；P1 原生文件/管道 adapter 通过阶段检查，完整资源封装进行中，尚未产出 Windows Desktop 安装包或发布
- 基线：`99442715e802c7ccdf09dd9a4f476a26f906a076`（当前 main，包含 v0.1.5 及后续 README 精简）
- 分支：`feat/windows-desktop`
- Worktree：`/Users/yuanjubian/program/metawork-windows-desktop`
- 目标：以现有 macOS Desktop 的架构与产品行为为基准，通过 Windows 平台适配交付可实际安装、启动、执行任务、升级及卸载的内部版。
- 完成日期 / 验收证据 / closing commit：实施完成后填写；本文不是完成报告。
- 实施记录：[Windows Desktop 实施与验证记录](2026-10-07-windows-desktop-implementation.md)。

## 1. 推荐交付范围

| 项目 | 首版方案 |
| --- | --- |
| 系统 | Windows 11 x64，NTFS 本地磁盘；ARM64、32 位、Windows Server 暂不承诺 |
| 安装包 | `MetaWork-win32-x64-setup.exe`，Electron Builder + NSIS，按当前用户安装 |
| 签名 | 内部版不要求 Authenticode 证书；保留 Ed25519 分发清单签名和 SHA256 校验 |
| 构建环境 | 原生 Windows x64 runner；macOS worktree 用于开发和平台无关检查 |
| 内置依赖 | Electron、Node 22.23.3 / ABI 127、Server/Web、隔离 Planner、Git for Windows、Pi Executor、现有 Python/PDF 依赖 |
| 安装体验 | 安装向导 → 启动 MetaWork → 配置模型地址 / ID / Key → 进入共享 Web 工作区 |
| Server | 沿用同一 Server；Desktop、Web、TUI、飞书共享同一安装及账号 |
| 发布方式 | 先产出候选包及验收记录，再发布新版本；建议 v0.1.6，不覆盖已发布的 v0.1.5 |

用户不需要安装 Node、npm、Python、Visual Studio、WSL 或 Docker。Codex 是可选 Executor，首版使用内置 Pi。
现有安装器依赖文件/目录符号链接：首版明确要求允许创建符号链接，推荐预先启用 Windows 开发者模式；若公司策略禁止，需要 IT 配置相应权限。不承诺普通用户在默认 Windows 配置下完全零前置。
安装前检测实际能力并给出操作说明，不能安装到一半才报 EPERM，也不默认让整个 App 以管理员权限运行。

### 1.1 已确认约束：与 macOS Desktop 保持一致

用户于 2026-10-07 明确要求 Windows Desktop 的架构方式与行为方式和 macOS Desktop 一样。
本计划以 ADR-0045、现有 `apps/desktop`、正式 Server 和 Installer/Updater 实现为基准；Windows 是同一 Desktop 产品的平台适配，不建立独立的产品流程或后台生命周期。
DeepSeek Harness 仅用于参考 NSIS、PE/原生依赖打包、文件占用处理和 Windows 原生交互的实现技术，其 Host、profile、认证代理和更新策略不作为 MetaWork 的行为规范。

| 契约 | 两个平台必须保持的架构与行为 | Windows 适配范围 |
| --- | --- | --- |
| 进程与依赖 | Electron 是客户端和安装适配器；独立 Node Server 持有 Runtime；Planner 保持隔离 | 可执行入口、路径、进程启动与清理；不改为 Electron RunAsNode Host |
| 业务界面 | 共用同一 Web 构建、业务流程和受限 DesktopBridge；认证后加载正式 Server 的 loopback origin | 原生菜单、快捷键、文件对话框、通知和窗口集成；不引入独立 Windows UI 或 `dsh-app` 式业务代理 |
| 首次启动与并存 | 验证分发、按现有启动页完成配置，通过正式安装器初始化；发现兼容安装并复用，同账号不启动第二个 Runtime | Windows 安装目录、NSIS 和已有安装发现 |
| 认证 | 本地 OS 用户身份验证、一次性 ticket、HTTP proof、Electron 私有会话；普通浏览器仍显式登录 | Named Pipe、SID、DACL 和 NTFS ACL 替代 Unix socket/owner/mode 原语 |
| 关闭窗口 | 隐藏并保留页面、草稿和会话，任务继续；可恢复同一窗口 | Windows 托盘及再次启动入口对应 macOS Dock/激活入口 |
| 退出 Desktop | 仅退出客户端，Server 与任务继续；之后可重新连接同一账号 | 托盘和菜单的退出动作调用同一客户端退出路径 |
| 停止服务 | 独立显式动作，展示全客户端/运行中工作的影响，经确认后调用正式 stop/drain | Windows 菜单入口；不把关闭或退出转换为停止服务 |
| 安装新版与修复 | 沿用安装新版应用、影响确认、独立 helper、事务升级、健康确认和修复未完成更新的流程 | EXE 选择、NSIS 协调、文件锁及壳层替换；不另建 Windows 自动/强制更新策略 |
| 数据与卸载 | 壳层与账号数据分离；移除壳层不自动删除账号/凭据，不静默取消工作；永久清理是单独明确操作 | Windows 卸载前的文件占用检查及显式停止提示、快捷方式/注册清理 |

平台差异只改变系统调用、安装包形式和原生入口，不改变上述动作的含义。Windows 独有前置条件及能力缺口必须在 P0 记录，并对照 macOS 产品行为处理；不能仅标注“不支持”就视为行为一致验收通过。

### 1.2 无本地 Windows 环境时的验证路径

2026-10-07 用户确认暂无 Windows 实体机或 VM。已准备独立的 `windows-desktop-validation.yml`：Windows Server 2022 x64 托管 runner 用于环境预检及原生源码/依赖构建，macOS arm64/x64 jobs 用于既有客户端和 Server 回归。此流程只上传验证证据，不读取发布签名密钥、不发布 Release、不更新 main；准备好流程不代表已执行或通过。

- Windows runner 已验证受限管道、进程身份、ACL、SMB 拒绝、文件链接竞态、普通用户符号链接前置、Node/Electron 同原生模块及 Job 进程树暂停/恢复/取消；提交与限制见实施记录。生产本地认证和安装器集成仍待实现/验证。
- 必须记录 runner 的 OS、架构、权限及交互会话事实；管理员账号通过不能证明普通用户可安装，需在临时标准账号下另行验证。Windows Server 的通过记录不能记为 Windows 11 客户端通过。
- P5 仍要求临时云端 Windows 11 x64 测试机或之后提供的实体机/VM，完成干净系统及真实 GUI 验收。该环境缺失时保持 P5 未完成；付费资源创建和 Windows 11 人工验收另行安排。
- 已在现有 Actions 云端容量上启动官方 Windows 11 Enterprise Evaluation VM 验证，使用 KVM、UEFI Secure Boot、TPM 2.0 和独立临时磁盘；目前仅证明进入系统安装流程，尚未取得 guest 桌面/产品验收。不会把安装画面或宿主 KVM 探测当作 Windows 11 Desktop 通过。
- `cargo-xwin` 可作为 Rust 原生 helper 的交叉编译候选工具，不负责整个 Electron/Node 分发，也不证明真实 Windows 安全与 GUI 行为。native adapter 方案仍由 P0 比较及实测确定；Wine 或交叉编译成功不替代原生门。
- 2026-10-08 用户已授权推送 `feat/windows-desktop` 并使用云端验证，明确不得合并主干。允许触发专用验证流程；不运行现有带发布步骤的 `release-build.yml`。

## 2. 代码现状与必须补齐的内容

以下结论来自基线源码；历史计划中的“已完成”不能代替 Windows 原生验收。

| 已有入口 | 当前事实 | 需要的工作 |
| --- | --- | --- |
| `apps/desktop/package.json`、`packaging/electron-builder.config.mjs` | 只有 macOS 打包；硬性要求 Darwin runner，artifact 名固定 darwin | 增加 Windows 配置、NSIS 生命周期及独立构建命令 |
| `src/installation/desktop-release.ts` | platform 限定 darwin，必需文件固定 `bin/node`、`bin/git`、`bin/pi`，验证 POSIX 执行位 | 支持 win32-x64，按平台定义工具入口与完整性规则，显式验证目标平台 |
| `apps/desktop/packaging/prepare-runtime.mjs` | manifest、工具探测和 Mach-O 签名逻辑为 macOS | Windows ZIP 解包、PE/原生模块探测及工具闭包验证 |
| `src/client/desktop-session-client.ts` | 明确拒绝没有 getuid 的系统；验证 Unix socket owner/mode | 安全的 Windows Named Pipe 本地身份适配，不能直接删除检查 |
| `src/platform/local-endpoint.ts`、`src/gateway/server.ts` | 已有命名管道地址和传输入口；没有 Desktop 所要求的 Windows 身份/ACL 验证 | 补齐服务器端访问限制与客户端身份校验 |
| Desktop installation/service/update helper | PATH 使用冒号；Node 路径、`.app`、codesign、`Contents/Resources`、`/usr/bin/open` 写死 | 收敛到平台适配，并保留现有安装/升级 authority |
| `apps/desktop/main/main.ts` | 关闭窗口隐藏，提示仍指向 Dock；已有再次启动恢复入口，没有 Windows 托盘 | 增加 Windows 恢复入口及平台文案；关闭、退出、停止服务共用现有行为 |
| `scripts/install.ps1` 与 `src/installation/paths.ts` | CLI 默认 `%LOCALAPPDATA%\MetaWork`，通用 resolver 默认用户目录 `.metawork` | 统一 Windows 默认根目录，检测已有安装，防止生成第二套账号 |
| native installer/updater/pointer transaction | 多处直接创建符号链接，包含数据库文件链接；目录 junction 不能替代文件链接 | 实测开发者模式、文件锁、指针切换和 rollback，不用目录复制替代事务 |
| `src/configuration/production-secret-store.ts` | 当前生产 SecretStore 是 credentials.json；不能按旧文档假定凭据在系统钥匙串 | Windows 使用现有 SecretStore，补 NTFS ACL；不宣称已用 Credential Manager 加密 |
| `.github/workflows/release-build.yml` | 有 Windows Runtime job，但 Desktop job 仅 macOS；preflight 要求 Apple secrets | 按平台/内部渠道拆开门禁，Windows 内部构建不依赖 Apple 凭据 |
| `src/execution/worktree-attempt-execution-backend.ts` | Windows 原生 pause/resume 明确不可用，停止子进程行为与 Unix 不同 | 如实声明能力并验证取消/退出后无遗留 attempt 子进程 |

## 3. 架构与模块责任

继续遵循 ADR-0020/0030/0034/0045：Web 是业务 UI；Electron 是客户端与安装适配器；Server 独立持有 Runtime；Installer/Updater 是唯一运行时激活方。

- `src/platform/`：平台路径、受限本地传输、Windows ACL/进程身份原语；不解释任务和授权策略。
- `src/client/`：发现并验证 Server、交换 Desktop session、启动/停止服务；只消费公开契约。
- `src/gateway/`、`src/management/`：连接身份与现有一次性 session ticket；不增加第二套账号/登录系统。
- `src/installation/` 与独立 helper：依赖清单、安装、激活、备份、回滚。
- `apps/desktop/`：窗口、菜单、NSIS/壳层资源与平台安装交互；不导入 Storage、Kernel、Planning 或 Execution 实现。
- `src/executor/`、`src/execution/`：只在拥有的适配边界补齐 Windows 进程树启动/终止，Kernel 仍唯一决定取消与恢复。

实施前为 ADR-0045 增补 Windows 本地身份、内部发布信任和安装升级决定，并同步 CONTEXT 与 technical-overview；不把本方案提前写成已接受架构。
不修改业务数据库 schema，不新增业务协议语义，不保留新旧两个 Windows 安装 authority。替换散落的 Darwin 路径拼接；macOS 行为通过平台适配保留。

### 3.1 本地认证：首个技术验证门

继续使用现有 15 秒、单次、绑定 installation/instance/nonce 的 ticket，并验证 HTTP proof 后才建立 Electron 私有 HttpOnly 会话。
Windows 必须同时实现：

1. 以当前用户 SID 限制 Named Pipe DACL，拒绝远程客户端与其他普通用户；服务身份验证在连接时完成。
2. 客户端从 Windows 获取实际管道 Server PID/进程用户身份，结合 endpoint manifest、release/instance proof 核验，不能信任对端 JSON 自报 PID。
3. endpoint、凭据、会话及升级请求目录/文件使用当前用户受限 NTFS ACL（允许必要的 SYSTEM/管理员管理权限）；不能用 chmod 0600 代替 ACL。
4. 拒绝越界 reparse point、管道抢占、非本用户端点和过期/重放 ticket。此边界不隔离同一用户权限下的恶意程序。

Node `net` 公共 API 不提供完整 DACL/peer identity 控制。推荐封装小型 Windows 原生适配（Node-API 或独立原生 helper），验证 Win32 安全描述符、管道端身份、创建与连接竞态；只暴露必要能力，不使用 Node 私有 handle API。
具体承载方式在首个 Windows spike 中比较并记录后选定；若用 Node-API，必须分别在内置 Node 与 Electron Main 探测加载，不让 Renderer 接触原生模块。
该门失败就修复方案，不以关闭验证、开放 TCP 免登录或自动输入默认密码代替。

### 3.2 安装目录与依赖

- App 建议安装在 `%LOCALAPPDATA%\Programs\MetaWork`；运行时与数据默认 `%LOCALAPPDATA%\MetaWork`，通过正式 resolver 统一 CLI/Desktop/子进程配置。
- 发现已有显式配置或旧 `%USERPROFILE%\.metawork` 安装时，验证并复用；两个位置都存在时让用户选择，不静默迁移/合并数据库。
- 所有工具路径使用绝对路径、平台 path delimiter；处理 Windows `Path`/`PATH` 大小写重复，避免继承宿主全局 Node/Pi。
- Pi 优先由内置 Node 加绝对 JS 入口启动；需要 `.cmd` 的入口使用受控 launcher，验证空格、中文和 shell 元字符参数，不将用户参数拼接为 shell 命令。
- Git 携带 Windows 可重定位分发的完整运行依赖、Bash（Pi 如需）、模板及 license；Python/PDF、SQLite 和 Planner native deps 都来自 Windows 构建，不能复用 macOS node_modules。
- x64 主程序/原生模块保持严格校验；Git Credential Manager 的 AnyCPU 程序集单独核验 CLR/IL。保留并实测 PortableGit 固定的 `usr/libexec/getprocaddr32.exe` WOW64 辅助进程，其余原生 x86 文件拒绝进入 Desktop payload；这不增加 32 位 Windows 支持或改变 MetaWork 的 Job 控制实现。
- 保留各依赖许可及固定版本/校验值；普通用户端不执行 npm install 或下载编译工具。
- ACL 从初始化到临时文件/原子替换全程有效，凭据不进入 renderer、日志、安装包或测试报告。

### 3.3 升级、退出与卸载

Windows 正在运行的 EXE/DLL 无法像 macOS `.app` 一样替换。复用 `DesktopActivation` 和原生 updater 的事务，补 Windows 壳层替换 adapter：

1. 新版安装包发现已有安装后，进入受控协调升级入口；不让 NSIS 在 Server 运行时直接覆盖应用。
2. 先验证候选完整分发和 release 信任链，展示全客户端影响；用户确认后，通过正式 Server stop/drain，再等待 Electron 和相关文件句柄释放。
3. 更新 helper 从不会被替换/删除的 staging 位置独立运行，切换 Runtime 与壳层，并记录升级日志。
4. 只有新 Server 身份匹配、Desktop 认证成功且真实 Web 根节点渲染后才提交；失败时按原有数据库 + journal companion 备份恢复。
5. 重启或中断后沿用持久 activation journal 恢复；测试磁盘满、文件锁/杀毒软件暂占、helper 崩溃和健康回执超时。

关闭窗口隐藏并保留页面，Windows 通过托盘或再次启动恢复同一窗口；首次关闭说明对应 Windows 实际入口。退出 Desktop 只结束客户端，Server 继续工作；显式“停止服务”才停任务服务。托盘只是平台入口，不拥有独立生命周期。首版不安装 Windows Service、不承诺开机自动启动。
Windows 的 Node `process.kill(pid, 'SIGTERM')` 是强制终止，不能作为已完成正式 drain 的证据。实施须把 Windows 显式 stop/restart 接到同一 ServerApplication.stop 路径，并验证 endpoint draining、客户端断连、Runtime 清理和锁释放；不能把向共享控制台广播 Ctrl-Break 或仅等待 PID 消失作为等价实现。
升级入口和“修复未完成的更新”沿用 macOS 的用户动作及事务语义。用户直接运行新版 EXE 时，NSIS 也必须交给同一协调升级路径；Windows 不另外引入后台下载、强制升级或第二套 updater。
卸载沿用 macOS 的壳层/数据分离语义。需要停止服务以释放文件或完成移除时，先展示运行中工作和全客户端影响，经用户明确确认后才走正式 stop/drain；未确认则退出卸载，不隐式停止任务。默认保留账号和凭据数据，永久清理须单独明确选择。
不得为适配 Windows 在 Electron 中增加自己的数据库备份、任务调度或恢复策略。

## 4. 构建和信任链

实施阶段在新分支增加 `package:win` 与 Windows Desktop workflow，使用固定的 Windows x64 runner 镜像（建议 windows-2022），依赖 npm locks。系统最低支持范围由干净 Windows 11 验收确认，runner 成功不等于客户端支持认证。

流水线按顺序：

1. 固定源提交，检查 Root/Web/Desktop 版本一致。
2. 原生 Windows 构建 Server/Web、离线 Planner、native dependencies 和工具；运行 owning-seam tests。
3. 使用既有 `package-release.mjs` 生成 `manifest.win32-x64.json` 与 Windows Runtime/Planner 归档。
4. Windows payload preparer 校验归档、版本、架构、ABI、工具调用与 inventory，再签 Desktop descriptor。
5. Electron Builder 生成 NSIS 候选包；在干净环境安装、运行、升级/回滚。
6. 汇总候选 EXE、desktop download manifest、Runtime/Planner、安装脚本、SHA256、依赖清单与验收日志。

未做 Authenticode 签名不代表不验证软件内容。内部渠道必须使用明确构建策略，不能仅因 payload 自报 development 就放开全部校验。
已有内部公钥与 GitHub 正式 signing secret 可能不一致：先在私钥不出日志的 preflight 中验证匹配，再选择已有可信 key 或设计明确的 key rotation。不得为让 CI 变绿静默替换信任根，也不把临时内部私钥提交到仓库。
按 Windows/内部渠道检查所需输入，不要求 Apple certificate/notary secrets；构建 job 不直接发布 GitHub Latest。

建议后续以 v0.1.6 提供 Windows 与 macOS 同源资产。若要发布新的统一 Latest，需同步构建/验证保留的 macOS DMG 和 CLI 资产，确保既有 README 的 latest 下载链接不失效；不能仅发布 Windows 资产后把 Mac 下载入口变成 404。
本轮不改版本、不打 tag、不上传 Release、不更新或合并 main。2026-10-08 用户授权推送实施分支并触发专用构建/测试 workflow；发布流程仍不在本轮范围。

## 5. 实施顺序及每阶段退出条件

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| P0 | 对照 macOS 行为基线，验证 Windows 原生环境、受限管道/身份、ACL、符号链接、干净依赖；记录 ADR 修订 | 能证明安全本地连接和普通用户安装前置；确定 native adapter 方案，列明并处理行为一致性阻塞 |
| P1 | 平台路径/工具入口、安装根目录、release schema/清单与安装器 | Windows isolated install 成功，Server 独立启动，依赖不来自开发机 |
| P2 | Electron 会话、Web 渲染、菜单/托盘、窗口恢复、任务执行、取消及 Server 生命周期 | EXE 内真实 Web 登录完成，任务产物可打开；关闭隐藏、恢复、退出、停止服务分别满足 macOS 对应语义 |
| P3 | NSIS 新装/升级/卸载、activation/rollback Windows 适配 | 新装、覆盖升级、失败回滚、中断恢复和保留数据卸载通过 |
| P4 | CI、候选分发清单与包、原有系统完整回归（§6.1） | Windows 原生门及 macOS Desktop、Server、Web、TUI、多客户端、安装升级回归全部通过，证据对应最终候选提交 |
| P5 | 干净 Windows 11 人工验收、README 与发布资料 | 用户能从下载到完成第一个任务；记录证据后再执行已确认的发布范围 |

每阶段记录实际执行的平台/版本/提交、失败及剩余阻塞；不把单元测试、构建成功或后台 HTTP 正常当作 packaged Desktop 启动成功。

## 6. 验收矩阵

- **平台无关检查**：Root/Desktop/Web 类型检查，Desktop 边界、安全、偏好及相关 release/installer/updater/session tests；修改存储/执行 seam 时运行归属测试及适用 Docker 回归。Windows ACL/pipe/安装门只能由真实 Windows 证据满足。
- **包体**：EXE x64；内置 Node 版本/ABI、SQLite 真实读写、Git init/worktree/commit、Pi probe、Planner RPC、Python/PDF 真实导入及样例处理；无源码目录/开发 PATH 也能工作。
- **干净机新装**：无预装 Node/Git/Python/VS，普通用户、开发者模式启用；安装前置不满足时清晰退出且无半安装；中文/空格用户名及工作目录、路径长度边界。
- **本地身份**：其他 Windows 普通账号不能读取凭据/注册 Desktop session；恶意占用 pipe、伪造 endpoint PID、重放/过期 ticket、越界链接被拒绝；Renderer 无票据/原始凭据。
- **真实客户端**：按完整 packaged-install 流程，窗口从安装页转到认证后的 Web，确认根节点渲染/可交互；重启、重连、Renderer 崩溃、下载与外链、通知可用。
- **跨平台行为一致性**：以同一源提交的 macOS/Windows 候选运行同一组场景，逐项核对 §1.1；覆盖首次启动、复用已有安装、本地自动会话、关闭隐藏后草稿/页面恢复、完全退出后 Server/任务存活、重新启动连接、显式停止、安装新版与修复未完成更新。记录平台入口差异和未通过项，不能用 macOS 通过代替 Windows 证据。
- **任务链**：使用测试模型配置完成一个 Planner → Pi → 本地文件产物任务，再验证取消及残留子进程；关闭 Desktop 后从 Web/TUI 观察同一账号任务；PDF 样例任务可运行。外部模型连通性单列记录，不能用 mock 代替该门。
- **并存**：Desktop 管理安装与独立 PowerShell 安装能被正确发现，版本冲突提示升级，不启动第二个同账号 Runtime。
- **升级/恢复**：旧→新安装，active work 拦截/确认，EXE 文件占用，中途进程终止，新 Server 或 Web 不健康时回滚；日志/数据库/journal 保持一致。
- **卸载**：后台任务存在时明确提示；默认保留数据；重装可恢复；无关进程/其他安装不受影响。
- **原有系统回归**：必须完成 §6.1 的 macOS Desktop、Server、Web、TUI、多客户端及安装升级检查。此前已发布包的磁盘校验或服务启动证据不作为本次候选通过证据。

现有 Windows pause/resume 能力缺口须在 P0 核对 macOS Desktop 是否暴露或依赖该行为；若属于对应产品场景，则作为一致性交付阻塞补齐等价实现，不以能力说明豁免。不得通过模拟 SIGSTOP 宣称支持。任务取消和子进程清理是首版必须通过的门。

### 6.1 原有系统回归：Windows 交付的强制门槛

用户明确要求 Windows 适配不能影响原有 macOS Desktop、Server、Web、TUI 的正常运行。共享代码的回归验收与 Windows 验收具有同等交付优先级；不能只验证 Windows，也不能以“未直接修改某客户端”跳过其端到端检查。

| 范围 | 必须验证的原有行为 | 证据要求 |
| --- | --- | --- |
| macOS Desktop | 干净安装和首次配置；Server 未运行时自动启动、已运行时复用；本地自动认证及真实 Web 渲染；工作区/会话切换、设置保存激活、文件选择/下载/打开；关闭隐藏与恢复草稿、退出后任务继续、重启重连、Renderer 崩溃恢复；显式停止前确认影响 | 使用同一候选提交的真实 `.app`，保留安装、界面和进程证据；覆盖本轮保留发布的 macOS 架构，不能只跑开发 Electron |
| Server 与执行链 | 正式 start/status/stop、runtime.lock、endpoint 发布和重复实例拒绝；Planner RPC → Kernel → Pi 执行 → 产物交付；任务取消及子进程清理；受控重启后的持久恢复；账号数据及凭据沿用 | 归属模块测试和隔离安装中的真实进程/真实模型任务；核对 Task、产物及恢复事实，不用仅 HTTP 健康检查替代 |
| 普通浏览器 Web | `metawork web` 打开已运行的 Server；浏览器显式登录，Desktop 自动会话不绕过浏览器认证；工作区/会话导航、历史分页、实时输出、断线重连、设置保存激活、权限处理、任务取消和产物下载 | 真实浏览器加载候选生产 Web 资源；记录交互与授权结果，不用 Electron 内 Web 通过代替普通浏览器验证 |
| 原生 TUI | `metawork tui` / 裸 `metawork` 连接同一 Server；工作区/会话选择、历史与实时输出、Task 面板、命令和权限响应、取消、断线重连；退出 TUI 后任务继续；Server 不可用时保留原有明确提示 | 构建 vendored AnyFusion-Pi 的 `build:offline`，运行协议/启动器测试及真实终端交互；不能用模拟 Gateway 客户端代替完整 TUI |
| 多客户端并存 | Desktop、浏览器、TUI 在同一隔离安装及账号下同时观察同一任务；状态、权限解决和终态一致；一端退出不停止其他客户端或任务；重连不重复提交命令、不创建第二个 Runtime；显式 Server stop 对所有客户端的影响一致 | 自动化协议检查与真实三客户端场景分别记录；核对 Server 实例、账号及 Task 身份 |
| macOS 安装、升级与回滚 | 现有受支持版本 → 候选版本；复用已有安装/配置/数据；运行中工作确认、安装新版应用、修复未完成更新；模拟新 Server 或 Desktop 健康失败后的壳层及数据库/journal companion 恢复；CLI 入口继续可用 | 在独立安装中使用旧版和候选分发，记录升级前后身份、数据、CLI/Desktop/Web/TUI 可用性；不在日常使用安装上做故障注入 |
| 其他共享入口与发布 | 飞书 Gateway 的账号/会话路由、权限、取消与结果投影；现有原生 CLI 安装入口及 macOS 下载资产、校验清单和发布版本一致性 | 跑现有飞书/集成契约测试；如改动相关边界，补对应集成验证。外部实发不属于默认回归授权；必要实发未验证时如实记录。正式发布前验证实际下载资产 |

执行与证据规则：

1. 实施前记录 macOS 基线提交、版本、架构、关键场景结果及已存在的问题；候选版本重复同一行为场景并比较。已有失败必须记录原因，不能冒充通过，也不能掩盖本轮引入的退化。
2. 所有安装、升级、恢复和真实任务测试使用独立安装根、配置目录、账号、工作区及测试模型配置；明确设置测试入口支持的隔离参数，避免 smoke 默认连接日常配置。不得覆盖日常 macOS 安装、停止用户正在使用的 Server、修改真实账号数据或污染凭据。
3. 自动化基础检查包括 `npm run lint`、`npm run lint:desktop`、`npm run build --prefix web`、`npm run test:desktop`，以及 `tests/client/`、`tests/gateway/`、`tests/tui-bridge/`、`tests/installation/`、`tests/server/`和受影响的 Session/Execution/Storage 归属测试。SQLite/POSIX 测试在可用的原生 macOS 或规定的 Docker 环境执行，不用 Windows 宿主失败替代验证。
4. 复用 `npm run smoke:clients`、`npm run smoke:gateway`、`npm run smoke:desktop`、`apps/desktop/tests/packaged-install-smoke.mjs` 和真实任务 smoke；先核对各入口的隔离配置及覆盖范围，再补齐上表未覆盖的浏览器、终端和安装升级场景。现有 `smoke:clients` 是协议集成测试，packaged-install smoke 使用模型配置夹具且不执行真实模型任务，均不能单独证明完整验收。
5. 每项记录候选源提交、分发版本/哈希、OS/架构、执行入口、结果及日志/截图位置；未执行、环境受阻或外部模型不可用均标为未完成。最终候选发生影响行为的修改后，重跑受影响检查；证据必须对应待交付代码和包。
6. macOS Desktop、Server、Web、TUI 或共享安装升级路径出现本轮回归，必须修复并复验后才能合并或发布 Windows 交付；任何必需验收缺失都不能将 P4/P5 标为完成。Windows 构建成功不构成原有系统正常运行的证明。

## 7. README 安装说明交付

保持当前精简后的中英文 README 结构与 License；增加 Windows Desktop 一节，包含：

1. Windows 11 x64、NTFS、开发者模式/符号链接权限的准备及检查方式。
2. 只在实际发布后加入有效 EXE 下载链接、版本和 SHA256；区分候选包与 Latest。
3. 双击安装、当前用户安装位置、开始菜单/桌面入口。
4. 内部未签名包的 SmartScreen 提示：在确认官方来源后使用“更多信息 → 仍要运行”；若企业策略禁止，由 IT 放行，不建议关闭 Defender 或全局防护。
5. 首次模型配置与进入工作区、创建第一个任务；解释 Desktop 自动会话与普通浏览器显式登录的区别。
6. 可选安装终端命令并验证 `metawork web` / `metawork tui` 共用同一 Server；修改用户 PATH 时明确提示打开新终端。
7. 正式协调升级、运行中任务影响、退出与停止服务的区别、卸载保留数据与故障日志位置。

文档承诺必须来自候选包实际验收；不将“未 Authenticode 签名”描述为 macOS 的“未公证”。

## 8. 本次 Review 的决定范围

已确认：Windows Desktop 与 macOS Desktop 架构及产品行为一致，具体约束见 §1.1。DeepSeek Harness 的调研不授权改动该基准。

建议接受：Windows 11 x64 + NSIS 当前用户安装；公司内部未 Authenticode 签名分发；内置 Node/Git/Pi/Python；安全本地自动登录；同一 Server 与安装根目录；沿用事务升级；首版明确开发者模式前置；候选通过后进入新版本发布。

用户已授权开始 P0 及按阶段实施，并已推送实施分支、运行 Windows/macOS 托管验证。逐次结果见[实施记录](2026-10-07-windows-desktop-implementation.md)。干净 Windows 11 GUI 环境尚不可用；具体路径见 §1.2。如 hosted runner 无法覆盖 GUI、双账号隔离或企业策略，用原生 VM/受控测试机补证据，不能将缺失验证标成通过。
