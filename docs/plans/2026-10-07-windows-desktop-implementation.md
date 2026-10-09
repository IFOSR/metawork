# Windows Desktop 实施与验证记录

- 日期：2026-10-07
- 状态：In Progress（2026-10-08 更新）。原生安全 transport、私有文件与 Job process adapter 已接入，正式隔离安装/Server/会话/drain 已通过阶段验收；packaged EXE、NSIS、真实模型任务及 Windows 11 验收推进中。协调升级/回滚尚未交付，不能发布。
- 方案：[Windows Desktop 构建与交付](2026-10-07-windows-desktop-build-plan.md)
- 源码基线：`bc7ad127d0ac9d6df36a03ddacc916e93806ec5d`（包含计划，运行时代码对应 `99442715e802c7ccdf09dd9a4f476a26f906a076`）。
- 本次验证环境：macOS 27.0.1（26A434），arm64，Node 22.23.3，npm 10.9.9。
- 完成日期 / closing commit：未完成，未填写。

## 已执行工作

1. 按四份 npm lockfile 安装当前 worktree 的 Root、Web、Desktop、Planner 依赖；Planner 使用 `--ignore-scripts` 和 `build:offline`，没有修改依赖版本或复用另一个安装的 node_modules。
2. 跑原有系统回归基线。发现并修正两个测试入口过时问题，未修改生产 Runtime、Server 或客户端实现：
   - `desktop-clean-install.integration.test.ts` 使用过期的 `METAWORK_DESKTOP_DEVELOPMENT`；改为安装入口实际读取的 `METAWORK_DESKTOP_INTERNAL`。保留签名及生产兼容性验证。
   - `smoke-unified-gateway.mjs` 调用已移除的 `GatewayClient.resume()`；改用 ADR-0043 的 `followConversation()`，分别验证命令的实时完成投影和第二客户端后连接时的相同 Turn/答案，保留未观察客户端隔离断言。
3. 增加 `scripts/smoke-desktop-isolated.mjs`：每次使用短路径临时安装根及无效本地模型配置夹具，清除继承的产品安装环境变量；不读取个人模型凭据。运行现有开发壳层/生产 Web smoke，保存证据并通过正式 CLI 停止本次隔离 Server。
4. 已推送 `feat/windows-desktop` 并运行 `windows-desktop-validation.yml`，负责 Windows 环境预检、原生管道探针、Windows 原生源码构建、macOS 双架构回归。只有 `contents: read`，不使用发布密钥，不发布包；未合并主干。
5. 准备 `probe-windows-desktop-environment.mjs`，在原生 Windows x64 上收集系统/权限事实并检查 NTFS、Unicode/空格路径的文件及目录链接、指针替换、受限 ACL 继承与文件替换。报告明确标注 `p0Accepted: false`、`windows11Acceptance: false`，不把环境探针当作完整身份认证或产品验收。

## 本地验证结果

以下是 P0 基线和验证工具的证据，不是 Windows 候选或完整 macOS 发布验收。日志保留在本机 `/tmp/metawork-win-*`，云端流程运行后需另存与提交绑定的 artifact。

| 检查 | 结果 | 证据 / 限制 |
| --- | --- | --- |
| Root / Desktop 类型检查 | 通过 | `/tmp/metawork-win-baseline-lint.log`、`/tmp/metawork-win-baseline-desktop-lint.log` |
| Web、Root 生产构建与 Planner 离线构建 | 通过 | `/tmp/metawork-win-baseline-web-build.log`、`/tmp/metawork-win-baseline-build.log`、`/tmp/metawork-win-baseline-planner-build.log` |
| Desktop 单元检查 | 3 文件、6 测试通过 | `/tmp/metawork-win-baseline-desktop-tests.log` |
| 平台、Client、Gateway、TUI bridge、Installer、Server、Web、Management、架构和独立客户端测试 | 首跑 166 文件/1,075 测试通过；1 个安装夹具失败 | `/tmp/metawork-win-baseline-core-tests.log`；失败发生在生产代码改动前 |
| 安装夹具及 release/install-cli 复验 | 3 文件、6 测试通过 | `/tmp/metawork-win-baseline-installer-recheck.log`；未重复全量基线，不合并伪称一次全绿运行 |
| 修正后 smoke 脚本契约及安装夹具 | 通过 | `/tmp/metawork-win-validation-harness-tests.log` |
| Unified Gateway smoke | 通过 | `/tmp/metawork-win-baseline-gateway.log`；包含 7 个 Planner/TUI 测试文件的 124 项检查，以及真实隔离 Server、已安装 TUI 启动/退出、CLI Web URL、多个 Gateway 客户端观察、Server 重启和目录恢复。不是完整浏览器人工交互 |
| 隔离 Electron smoke | 通过 | `.tmp/windows-desktop-validation/macos-arm64-1791384614933/`；真实生产 Web 渲染、私有认证、草稿、窗口尺寸/缩放、原生动作夹具、10 次重连、Renderer 崩溃恢复、客户端退出后 Server 存活；测试后已正式停止隔离 Server |
| 新脚本/工作流静态校验 | Node 语法检查、YAML 解析、`git diff --check` 通过 | Windows PowerShell/NTFS 部分尚未在 Windows 执行 |

PDF 构建首次被 GitHub 下载连接阻塞；本次从已有开发缓存读取固定版本的 Python 原始归档，重新验证方案锁定 SHA256 后解压到当前 worktree 的缓存，再复用依赖缓存并通过实际导入检查。没有复制用户配置或运行态数据库，也没有绕过完整性校验。

## 云端验证与修复（2026-10-08）

- `cad4f82`：[首次运行](https://github.com/IFOSR/metawork/actions/runs/37696449230)。Windows Server 2022 x64 上 Root/Desktop/Planner 构建、类型检查、原生 SQLite 读写和 Planner CLI 通过。NTFS、中文/空格路径链接和替换通过，但 runner 是管理员，不能作为普通用户验收。
- `90511e2`：[第二次运行](https://github.com/IFOSR/metawork/actions/runs/37696763988)。Windows 构建再次通过。原生 C++ 探针编译成功，但管道实例上限先触发 `ERROR_PIPE_BUSY`，尚未测到首实例抢占限制；修正为留出第二实例容量，以独立验证 `FILE_FLAG_FIRST_PIPE_INSTANCE`。
- Windows PowerShell 继承 PowerShell 7 模块路径的问题已修复；文件替换的 `$null` 参数被转换为空字符串，改用受限目录内明确的备份路径。探针不写入真实配置或凭据。
- macOS arm64 的共享回归、Desktop 单元检查、生产构建和 Gateway smoke 通过；真实 Electron smoke 因英文 runner 上菜单查找硬编码中文而失败。测试入口接受产品现有的中英文菜单标签，保留实际点击/侧栏/焦点断言。
- macOS Intel 基线生产构建失败：固定的 `cryptography==50.0.2` 不再提供 Intel macOS wheel。保留固定版本，为 Intel 构建机添加静态 OpenSSL 源码构建路径，并用 `otool` 拒绝构建机动态库依赖；最终用户仍使用完整内置 PDF 环境。arm64 原有缓存/构建路径的实际导入检查通过，Intel 修复需原生云端复验。
- 两次运行均不是完整全绿验收。P0、普通用户安装和 Windows 11 GUI 门仍然开放；生产 Windows Desktop 认证没有放开。
- `8e9809d`：[第三次运行](https://github.com/IFOSR/metawork/actions/runs/37697457472)。原生管道探针通过：owner-only DACL、首实例抢占拒绝、内核 Server/Client PID 与用户 SID、错误 PID 拒绝、另一普通账号拒绝和真实往返；Server 本身仍运行在管理员 runner。远程拒绝仅配置了 Win32 标志，尚无跨机器证据。
- 第三次环境探针暴露提升权限进程新文件默认 owner 为 Administrators 的问题；补显式文件 owner 初始化，在私有目录中完成后再替换，并校验备份的权限。新增两普通账号的管道场景和普通用户环境探针；后者仅在临时云端 VM 设置方案要求的开发者模式，运行后恢复策略值并清理测试账号。普通用户报告必须实际确认未提升权限。当前这些扩展尚待云端执行。
- `8e9809d` 的 macOS arm64 完整 workflow job 已通过，包括修正语言查找后的真实 Electron smoke；Intel job 仍在验证。此处的完整 job 只涵盖 workflow 声明的基线场景，仍不是 §6.1 的 packaged-install/真实模型完整验收。
- 增加 Node-API 载体比较探针：复用同一组 Win32 管道安全原语，验证由 Node 和 Electron Main 分别创建的管道实际 PID 为宿主进程、owner/SID 一致；同一 `.node` 二进制同时加载，不使用 `ELECTRON_RUN_AS_NODE`，不接入产品或 Renderer。独立 helper 探针已有证据，但正式载体选择仍待此探针及异步生命周期验证。
- `8b53ec7`：[后续运行](https://github.com/IFOSR/metawork/actions/runs/37698118822)。Windows 环境和管道两个 job 通过：管理员和普通用户均完成检查，普通用户 Server 的原生报告明确 `elevated: false`；开发者模式下中文/空格目录链接、文件指针替换、私有目录 ACL/文件替换通过。标准账号 A 的管道拒绝标准账号 B，实际 Server/Client 身份和首实例限制通过。文件跨账号读取、越界 reparse、远程连接及正式安装仍需覆盖。
- Intel cryptography 源码编译成功，但现有 `otool -L` 检查也读取模块自身的 `LC_ID_DYLIB`，不能据此直接判断外部依赖。改为解析实际动态库加载指令，并在复制后的内置 Python 中执行 PDF 导入和 AES-GCM 加密/解密；本地 arm64 验证通过，Intel 待云端复验。
- 复查发现 Server 的 ticket 签发不能仅依赖 Desktop 客户端的 Unix 限制。按 ADR-0045 当前 Unix-only 契约，普通 Node Named Pipe 不再宣告或签发 Desktop ticket；正式安全 transport 接入前保持拒绝。新增真实本地连接测试，同时保留 macOS 签发行为。本地 Gateway 生命周期、ticket 安全与 admission 共 3 文件/21 测试及 Root 类型检查通过；Windows 同一测试加入云端构建 job。
- `8b53ec7` 的 Node-API 同二进制验证通过：Node 22.23.3 与 Electron 44.5.1 Main（内嵌 Node 24.21.0 / N-API 10），实际 pipe PID 分别属于各自宿主。ADR-0045 选定窄 Node-API platform adapter，避免 helper 额外进程身份/转发协议；尚未完成异步 transport，未接入生产认证。CONTEXT/current overview 同步此实施中状态。
- 增加基于文件句柄的私有文件 spike：读取前检查 owner、允许 ACE、reparse/hard-link、路径及大小界限；保持目录/文件句柄直到读取结束，验证并发文件/链接替换不会返回链接目标内容；第二标准账号尝试读私有夹具。只读生成的测试内容，不导入真实配置；需等待 Windows 原生执行。
- 私有文件首次云端验证在正向读文件时拒绝了 TEMP 的 8.3 用户名路径；补 Win32 长文件名展开后再与实际句柄路径比较，不把短路径别名当成越界链接。此前的环境/管道检查及 Windows ticket admission 测试通过。
- 增加 overlapped I/O spike：在 Node 和 Electron Main 中验证 12 个并发连接、双向读写、缓冲界限、背压和取消 pending accept/read/write，保留内核使用的缓冲和 OVERLAPPED 直到取消完成。不使用 Node 私有 handle，不接入生产 Gateway；原生结果待云端执行。
- 增加 SMB loopback 的远程标志检查：同一台临时 VM 经机器名访问管道，先用同 SID DACL/允许远程的单字节夹具证明路径可达，再检查 `PIPE_REJECT_REMOTE_CLIENTS` 的拒绝。该模式只用于 probe，不签发 ticket，不处理产品请求；即使通过，也单列为 SMB loopback，不冒称另一实体机器的连接证据。
- `f7cbe6e` 的 macOS arm64 与 Intel 完整 workflow job 均已通过，包括共享回归、PDF 静态依赖构建、Gateway/TUI smoke、真实 Electron smoke。源提交包含 Server ticket transport 拒绝门。Intel 证据保留在 run `37698966249`；仍不替代正式 `.app` 安装/升级和真实模型任务验收。
- `a48a72b`：[原生扩展验证](https://github.com/IFOSR/metawork/actions/runs/37700531477) 的 Windows 三个 job 全部通过。SMB 正向对照及拒绝、私有文件正/负向检查、跨账号文件访问拒绝、并发 reparse 替换，以及 Node/Electron Main 的 overlapped I/O 生命周期均已执行。PowerShell 5.1 子进程需要预先取得 Process.Handle 后才能可靠读取退出码；保留子进程结构化的真实 OS 拒绝结果双重断言。
- [Windows 11 云端宿主预检](https://github.com/IFOSR/metawork/actions/runs/37700531578) 确认 Ubuntu runner 有 KVM、4 CPU、16 GB 内存和 86 GB 空闲空间。准备独立临时 VM workflow：微软官方 Windows 11 Enterprise Evaluation 26H2 x64 镜像，QEMU/KVM、UEFI Secure Boot、软件 TPM 2.0；只上传环境报告和桌面截图，不上传虚拟磁盘、无人值守密码或安装应答文件。尚未证明 guest 启动成功，更不代表 Desktop 验收。
- `859f1b8` 的强化 reparse 竞态通过：500 次读取中 207 次合法读、293 次拒绝、14 次真实替换，未返回链接目标内容。此前测试全拒绝不能证明合法文件恢复路径，因此保留强化证据作为这一项的有效验收。Node/Electron 异步管道检查同时通过。
- P0 行为核对发现权限工作流 `permission-workflow-service.ts` 实际调用 backend pause/resume；Windows 当前未实现，且 stop 只杀直接 child。新增 Job Object 进程树 spike：执行前绑定 Job，公开 Win32 thread API 多轮枚举到静止后暂停，恢复只撤销本次 suspend count，取消通过 Job 终止全部成员。用三个真实进程、持续创建线程的写入夹具检查 10 次暂停/恢复和暂停中的取消。此项尚待原生结果及正式 backend 接入，不用“无暂停按钮”豁免权限审批语义。
- Windows Node-API spike 使用静态 CRT，避免把 CI 已安装的 VC runtime 当作干净用户机依赖；Windows 11 guest 仍需验证实际分发闭包。
- Job spike 的计数不假设恰好只有三个 Job 成员，而是逐一确认三个实际写入进程属于本次 Job。恢复检查使用两秒内的实际进度，取消后等待已固定身份的每个进程对象终止，不能把 Job accounting 归零当作已经退出。新增普通用户与中文/空格目录场景；尚待最终原生结果。
- Windows 11 首轮为诊断而取消，最后屏幕显示官方系统正在安装（33%），没有完成 guest 验收。新流程在运行中上传阶段截图；另准备 raw 临时磁盘与 Hyper-V enlightenment 参数改善嵌套虚拟化执行，保留 TPM/Secure Boot，不绕过系统安装前置。
- 仅修改 Windows spike/探针或文档时，后续 push 不重复已通过的 macOS 源码基线；共享源码、构建配置及 Desktop 变化仍触发双架构回归。最终候选使用手动 full workflow，始终执行双架构检查。专用 Windows jobs 与 macOS jobs 分别排队，避免互相阻塞。
- `4b50dcb`：[普通用户进程树验证](https://github.com/IFOSR/metawork/actions/runs/37703647552) 通过。管理员和普通用户均执行 10 次暂停/恢复、暂停状态下整 Job 取消；保留的三个工作进程对象全部退出，Job 剩余成员为零。实际 Job 包括三个工作进程及其额外成员，共 6 个；普通用户报告 `elevated: false`。结合前述管道、ACL、SMB、文件竞态和符号链接结果，P0 的原生技术前置与载体选择已验证；个别 probe 的 `p0Accepted:false` 表示其单项结果不能独立作为整体/产品验收。

## P1 平台适配（进行中）

- `desktop-platform.ts` 收敛 release-local Node/Git/Pi/Python 路径和子进程环境，DesktopInstallation 与 DesktopServiceManager 消费同一适配。Windows 使用 Node/Git `.exe`、分号 PATH，清除大小写变体的 Node/Electron 控制变量，避免 `Path`/`PATH` 重复；后台子进程隐藏额外控制台窗口。
- macOS 的既有安装器/服务 PATH 顺序、独立 Node 进程及 Server start/stop 路径不变；本地 3 文件/6 项路径与安装检查、Root/Desktop 类型检查、Desktop 3 文件/6 项边界/安全/偏好测试通过。共享生产代码变化已安排云端双架构回归。
- release schema、Windows 默认根目录、原生 adapter 生产封装、完整依赖闭包与安装验证尚未完成。本节不是 P1 完成声明。

## 待通过的阶段门

- P0 技术前置已验证；生产 transport/文件写入与替换/Job process adapter 必须分别在 owning seam 接入并复验。SMB 证据来自 loopback 网络路径，不宣称物理双机或企业域策略验证。
- P1–P3：完成 Windows 安装根/依赖闭包、安全 Desktop 会话、托盘及生命周期、NSIS 和事务升级/回滚；当前仅开始路径/子进程环境适配。
- P4：最终 Windows 候选及同源 macOS 候选完整回归；本地开发壳层通过不能替代真实 `.app` 新装/升级/回滚、真实模型任务或 Intel 验收。
- P5：用户暂无 Windows 实体机/VM；GitHub Windows Server runner 不满足 Windows 11 干净 GUI 人工验收。需另有真实 Windows 11 x64 环境，缺失时不得宣布完成。

架构保持现有 macOS Desktop 基准。安全原语 probe 通过不自动放开 Windows Desktop 认证；生产适配及 owning-seam 验证通过前继续拒绝，不发布“可用 Windows 版本”。

### 共享重启就绪竞态修复（2026-10-08）

`ea81078` 的 Windows 三项 job 通过，但 macOS arm64/Intel 的 Gateway smoke 暴露现有 `server restart` 的就绪竞态：仅检查 `gateway.sock` 就报告成功，此时新 Server 尚未发布 endpoint manifest。该检查也无法用于 Windows Named Pipe。重启现等待实际新 child 的 PID、协议、release 与 ready manifest 匹配，提前退出/启动失败立即报错；不改变停止、恢复或任务策略。新增覆盖旧 PID、draining、错误 release、延迟发布、命名管道和提前退出/超时的测试。本地 3 文件/14 测试、类型检查、完整 build 和隔离 Gateway/TUI/多客户端重启 smoke 通过；双架构云端复验待运行。

### Windows 安装根选择（2026-10-08）

通用 resolver 与 PowerShell bootstrap 对齐：显式根优先，新装默认 LOCALAPPDATA/MetaWork，旧用户目录 .metawork 单独存在时复用，两根同时存在时明确报错并要求设置 METAWORK_INSTALL_ROOT；不自动迁移/合并。自动发现拒绝被普通文件或链接占据的根。Windows launcher 放在选定根的 bin，避免复用旧根时又在新默认位置创建 bin 而制造双根。macOS 默认及 launcher 位置保持不变。目录选择不替代后续原生 ACL/句柄验证。

本地根选择、现有 paths/product-root migration、Root/Desktop 类型检查通过；新增 Windows 原生 PowerShell/Node resolver 对照验证随云端执行，包含重定向 LOCALAPPDATA、中文/空格路径、旧根、双根、显式 override 与兼容变量冲突。尚未作为完整安装验收。

### 分平台 release 校验（2026-10-08）

Desktop descriptor 按 platform 区分：macOS v1 继续使用既有 executable/mode inventory；Windows x64 使用内容 hash/size 与 PE/data 格式，核对 PE32+、AMD64、可执行 image 和有界 header，拒绝跨平台/架构 payload、伪装 native 文件、Windows 路径别名/ADS/设备名和大小写冲突。所有正式 verifier 调用方显式传入期望 platform。Windows 的必要清单包括独立 Node、Git/Bash、Pi JS、Python/PDF、SQLite 及后续生产 Node-API adapter 的固定入口 `metawork/native/windows/metawork-platform.node`，并保留工具 license。

本地 macOS release、Windows signed fixtures、Desktop installer 与 clean-install integration 共 4 文件/10 测试通过；Root 类型检查和 Desktop build/边界测试通过。PE fixture 从不执行，header 校验不代表 DLL 依赖闭包或真实运行验证；Windows 生产 adapter/依赖包尚未生成，当前也未放开 Windows Desktop 会话。云端原生 Windows 对应测试与 macOS 双架构回归继续执行。

### Windows Pi 与安装器工具入口（2026-10-08）

Windows Pi driver 的 probe/launch 使用同一内置 Node + 绝对 Pi JS 入口，不执行 npm `.cmd` 或拼接 shell 参数。Attempt 同时设置隔离 USERPROFILE，并在自己的 Pi settings 中固定内置 Bash；既有模板/provider 配置仍保留，macOS 调用方式保持不变。Windows Executor 使用独立 npm lock 安装在 executor 下，命令发现目录为 executor/node_modules/.bin；安装/更新 helper 的 Node 与搜索路径使用同一平台适配，命令发现支持 Windows PATHEXT（发现不执行脚本）。

本地 Pi、配置探测、路径/安装器与真实进程 argv 检查共 5 文件/32 测试通过，2 个 Windows-only 用例交给云端；空格/中文脚本路径及引号、换行、shell 元字符均作为原样参数传递。Root/Desktop 类型检查通过。`4f8aeac` 的 macOS arm64 整个 job 已通过；Windows root 对照测试因 TEMP 8.3 别名与 .NET 自动展开的长路径文本不同而失败，现用真实临时目录长路径固定夹具并明确 UTF-8 输出，仍执行真实 PowerShell/Node 双端选择。没有改成跳过或忽略错误。

### 固定 Windows 工具依赖与原生目录回归（2026-10-08）

新增独立 Windows 工具 manifest：Node 22.23.3 官方 SHA256、PortableGit 2.56.0.windows.2 官方 release asset digest，以及维护中的 upstream `@earendil-works/pi-coding-agent` 1.1.0/npm integrity 与完整 npm lock。构建器先核对 hash 再用构建机 7-Zip 解压，保留 Git/Bash/模板/许可证，使用内置 Node 安装 locked Pi，再以受控 PATH 实际运行 Node/Git/Bash/Pi 并验证 Windows inventory，输出来源报告。普通用户无 npm/编译工具步骤。Windows Pi 的 JS 入口随正式包名固定；macOS 现有 PATH 启动方式不变。Windows 工具原生执行尚待云端结果，不代表依赖闭包验收。

`5b43cb8` 的 Windows 测试已通过安装根/PowerShell 对照与 PE release 校验，但暴露 RuntimeHomeMaterializer 的 POSIX `/` 前缀判断使合法 Windows HOME 子目录被拒绝。改用平台 relative/sep 检查，保留绝对路径、越界、Windows drive-relative 与 ADS 拒绝；扩展真实目录用例并调整 Planner/Executor 分离测试的 Windows 预期，不跳过行为检查。本地相关 5 文件/31 项通过、2 Windows-only 项待云端，类型检查通过。macOS 云端回归追加完整 Executor 与配置域测试。

### Windows 构建信任策略（2026-10-08）

Windows Main 的 development admission 改为 native builder 编译进去的内部构建标志；payload 自报 development 或运行时设置 METAWORK_DESKTOP_INTERNAL 都不能改变已构建 Main 的策略。macOS 现有处理保持不变，签名、hash、版本/平台矩阵始终需要通过。新增实际 esbuild 产物的正/负策略测试，分别用反向 runtime env 执行，证明只有编译标志生效；Root installer helper 仍需显式内部调用配置和完整签名验证。Windows workflow 加入 Desktop 测试。

另修复 Windows PDF extension 的 ESM 路径：使用 file URL 并由真实 Node 进程加载生成的 extension，保持 macOS 行为。此前 Windows Pi/PDF 用例并非执行失败豁免，现以真正的 import 验证替代只比较路径字符串。

### 生产原生文件适配封装（待 Windows 复验，2026-10-08）

在 `native/windows` 开始封装独立 Node-API 模块。已验证的 PID/SID/DACL 与私有文件读取原语抽成共享头，原有 P0 探针继续消费同一份实现。新增当前 SID owner/受限可继承 ACL 的目录创建、有界私有临时文件写入、内容 flush 与相对于固定父目录句柄的原子替换；拒绝重解析、硬链接、越界及已有宽权限目录，不通过 chmod 假装 Windows ACL。失败清理临时文件。当前仍未接入 Gateway、凭据或 Endpoint 的生产调用，认证继续关闭；原生模块的 pipe/Job 能力和写入竞态/锁故障覆盖仍待完成。

新增 Node 与真实 Electron Main 使用同一二进制的初始化/读写/替换检查，保留独立证据。模块为静态 CRT / N-API 8；只做文件系统/OS 原语，不引入业务或恢复策略。云端工具准备此前在 bundle 导出路径处失败，已改为消费 Desktop 的正式 release-tools/platform-tools 构建输出，本地 Desktop build 与 9 项测试通过，Windows 实际工具运行结果仍待获得。

### 云端扩展回归发现与处理（2026-10-08）

`59d9513` 的 macOS arm64 完整 job 通过。Windows 的 Desktop 测试首次真实运行后，偏好存储仍依赖 POSIX mode 的问题未被忽略：Windows Preferences 改为显式接收原生 private-file adapter，没有 adapter 时拒绝启动该存储。加载/保存按固定父目录与文件句柄验证 ACL/owner，偏好数据用显式 9 MiB 上限，其他 native file 调用仍默认 64 KiB。Main 从已验证的资源 payload 加载模块，Renderer 不可访问。Windows 测试使用真实原生读取验证隐私权限；macOS 保留既有 0600 原子写入断言和路径。本地类型检查、Desktop build 与 9 项测试通过，Windows 新接入待原生结果。

同次普通用户 Job spike 的暂停 heartbeat 断言失败，已重新打开该门，不以历史通过结果覆盖新失败。检查发现 SuspendThread 返回不代表目标线程已经停稳，且目录枚举的文件大小可能滞后于打开文件的实际状态。新增 GetThreadContext 停稳确认，以实际文件句柄读取 heartbeat size；OpenProcess/OpenThread 的非退出类错误不再静默略过。修复仍待 Windows 复验与更强进程创建竞态覆盖，尚未提升为生产进程 adapter。

Windows 11 run `37702596665` 45 分钟超时，无 guest report，最终 QMP 截图黑屏；不能判断已完成安装，更不是 GUI 验收。后续 raw disk/Hyper-V enlightenment/禁用嵌套 VMX/SVM 暴露的 run `37703046385` 已开始，尚待环境证据。

### 原生 Windows 复验反馈（2026-10-08）

`5791c403` 的 Windows 管道与普通用户/管理员 Job 暂停、恢复、取消检查通过；进程创建竞态覆盖仍待补齐。生产文件模块实际 MSVC 编译成功，但首次写入报 Win32 87：当前相对 RootDirectory 调用组合在原生 runner 被拒绝。修正为先以禁止 delete-sharing 的句柄固定从盘符下到目标父目录的全部祖先，再使用绝对目标路径原子替换；保留 ACL/owner/链接校验与 flush，待原生重跑。此前记录中的相对父目录 rename 不是已通过实现。

补充生产文件 adapter 原生检查：管理员 Node/Electron Main 与临时普通用户分别验证文件占用失败保留旧内容/清理临时文件、显式 9 MiB 偏好上限、无效数值拒绝和双写双读并发整记录。读取也固定祖先目录，允许原子替换期间的 delete-sharing、仍拒绝原地并发写入；夹具只允许短暂 sharing violation 重试，其他异常仍失败。以上新增用例待 Windows 运行，macOS 路径未修改。

### 持续管道监听 adapter 开始实现（2026-10-08，待原生验证）

生产 Node-API 模块新增独立监听句柄和连接句柄：首次实例防抢占，当前 SID 的 DACL 与远程拒绝，每次 accept 先创建下一实例再交付连接，避免客户端轮换期间丢失名称所有权。所有读写使用 overlapped I/O；JS 轮询完成状态，单次写入最多 64 KiB，保留写入缓存直到完成，关闭时取消并等待内核释放 OVERLAPPED。连接的 Server PID 来自 OS 并匹配期望值，双端核验当前 SID；句柄用 N-API type tag 隔离。

新增 Node/Electron 同模块的 24 次顺序重连、同名 12 并发连接、双向字节/EOF、背压、待完成读写取消、错误 PID 和名称抢占检查。尚未接入 Gateway/客户端，Windows Desktop ticket 继续关闭；公共流封装、跨账号生产模块实测和完整认证回归仍待完成。

`f511e7e2` 的原生文件 Node/Electron、Desktop 偏好测试和 SQLite/Planner/Node-API 已通过。固定工具已实际执行 Node、Git、Bash、Pi 版本验证；inventory 阶段遇到带 native 扩展名的非 PE 文件，补充具体路径诊断后复验，没有跳过检查。

并发原生复验 `e11aa801` 暴露 Win32 5：替换后的文件句柄关闭前，原临时文件的零共享模式短暂阻止其他 writer 原子替换。调整为 READ/DELETE sharing，继续拒绝 WRITE sharing；这允许后续原子替换而不允许原地修改。测试仍只重试明确的 sharing violation，未放宽 ACL 或把 ACCESS_DENIED 视为通过。新增云端 VM 串口回传和非点击式唤醒显示诊断，后续运行可区分 guest 未登录与网络回传不可用；当前运行继续等待，不取消安装。

新增 WindowsPipeStream/Server 公共 Duplex/EventEmitter 封装：按原生完成状态轮询，读侧服从 highWaterMark，写侧切分为最多 64 KiB 的有界块；限制每轮工作量和活跃连接数，close 等待连接释放。传输层仅提供 OS 同用户身份与生命周期，不拥有 ticket、账号或任务权限。新增真实 `.node` 的顺序/并发客户端、2 MiB 背压与事件循环可用性、关闭后名称释放测试，Windows 云端执行，macOS 显式跳过此原生专用用例。共享 Gateway 尚未切换，接入前继续维持认证关闭。Root 类型检查通过。

P0 Job 测试扩展为主 worker 持续创建短生命周期子进程（同时保留原线程创建压力），暂停时同时核对固定 worker 与新增子进程 heartbeat，取消前持有当时所有 Job 成员的进程句柄并等待真实退出。此新增压力门待原生通过。工具包验证改为只依赖已成功的 Desktop 工具构建，不再被相互独立的文件/管道测试失败短路，以一次运行收集独立缺陷，整体 workflow 仍保留失败状态。

`6e8f049a` 的并发替换仍报 ACCESS_DENIED，证明共享标志修正尚不足以关闭该门。对照 Microsoft FILE_RENAME_INFO / FILE_RENAME_INFORMATION 文档，补用 Windows 11/NTFS 支持的 FileRenameInfoEx + REPLACE_IF_EXISTS/POSIX_SEMANTICS，以允许持有 delete-sharing 的旧读句柄继续读旧内容、新打开读新内容；不使用忽略 ACL/只读限制的标志。SDK target 显式设为 Windows 10 API 级别（产品最低仍 Windows 11），保留不允许 delete-sharing 的锁定目标负例，待原生验证。

### 共享清单与压力验证跟进（2026-10-08）

`1c3590d5` 的子进程创建压力在管理员/普通用户下通过，后续 `6a93bc45` 再现线程退出时 SuspendThread 失败而 exit code 尚未更新。新增 SYNCHRONIZE 权限并等待保留的线程对象实际 signaled；不会仅凭 ACCESS_DENIED 略过存活线程，超过 100 ms 仍失败。该门继续开放，不能将一次压力通过记为生产能力完成。

`1c3590d5` 的 Windows 源码检查捕获 endpoint 被读取时 Node rename 偶发 EPERM。`6013f571` 的 replaceFile 仅在 Windows 对锁/权限类错误进行最多 500 ms 的有界重试，始终原子 rename，不先删除目标；持续错误仍失败，清单写入清理自己的临时文件。readiness 测试的旁路观察 Promise 补失败处理，避免原断言失败后清理 child 产生额外 unhandled rejection。macOS 本地清单/readiness 8 项、基本替换 1 项及类型检查通过，真实 Windows 短锁/持续锁测试待云端。

macOS payload 依赖检查与已有 Intel PDF 构建检查一致：读取 otool -l 的 dependency load commands，排除模块自己的 LC_ID_DYLIB。本地实际 cryptography Mach-O 提取 libiconv/libSystem 通过；未据此宣称签名分发已验收。

`6a93bc45` 的 FileRenameInfoEx 已越过旧写入失败，双写双读暴露另一处误判：旧文件被原子替换后，打开的旧 inode 路径可以变化或链接数变为 0，不能再拿后续路径文本判定其来源。reader 现在固定并验证全部祖先，再 OPEN_REPARSE_POINT 打开最终文件，核验该句柄的磁盘类型、ACL/owner 和不超过一个链接；只对该已打开 reader 允许替换后的零链接。保留所有 reparse/hardlink 拒绝检查，不把路径比较错误加入重试白名单。

工具清单失败已定位为 upstream Pi TUI 1.1.0 在同一 npm tarball 中携带 Darwin/Linux/Windows arm64 原生预构建。检查其实际 native-module-path/native-platform loader 后，在锁定版本的构建阶段仅移除三个不适用的 prebuild 目录，保留 Windows x64、源码与许可；额外用内置 Node 实际 require Windows TUI helper 并验证导出。完整 inventory 继续拒绝任何剩余错误平台二进制，待云端验证。

### 原生平台 adapter 阶段结果与候选资源准备（2026-10-08）

`33c162c6` 已通过 Node/Electron 同模块的文件并发/锁/权限检查、普通用户文件检查、持续同名管道的顺序和并发连接、Duplex 背压与关闭、Windows endpoint 短锁/持久锁、Desktop 偏好、SQLite/Planner/Node-API 检查；Job 创建 churn 也通过。尚未将管道接入 Gateway，不能视为 Windows Desktop 自动认证完成。工具包清单继续发现非 x64 PE，补充全部 PE 失败路径诊断，不放宽执行文件验证。

公共 prepare-runtime 开始支持 Windows 原生 ZIP/平台工具路径和完整库存；提取前检查 Windows 路径/设备名/ADS，复制生产 adapter，验证内置 Node/SQLite/Git/Bash/Pi/Planner/Python，并要求明确内部构建策略。按已核实版本移除 Planner 两份 TUI 副本中的外平台预构建。新增只允许专用 CI 分支运行的 candidate 脚本：在一次性 checkout 中 prune 开发依赖，调用原有正式 Runtime/Planner packager，再用一次性测试密钥封装资源；私钥不上传，暂时只上传校验报告，不产生安装器或 Release。Windows 资源包实际封装尚待工具门通过。本地 release/归档校验 8 项、Desktop build 和 Root 类型检查通过。

`99071a0b` 再次通过原生文件/管道/流/endpoint/偏好检查，工具失败定位为 Git Credential Manager 的 Atlassian.Bitbucket.dll（.NET AnyCPU）。inventory 新增 `pe-managed`，要求 PE32/I386 下有界且唯一映射的 CLR/BSJB metadata、ILONLY，拒绝原生入口和强制/偏好 32 位；固定必需原生工具仍要求 `pe-x64`，不能以 AnyCPU 替代 Node/Git/SQLite/MetaWork adapter。新增格式正负例和内置 Git Credential Manager 的实际 `--version`，后者待云端；本地 release 检查 9 项通过。普通用户套件增加同一生产管道探针，关闭原生连接时立即释放 I/O event handles，不等 JS GC。candidate channel 使用现有 manifest 的 preview 值，development 仍由独立签名 descriptor/编译策略决定。

`d05e069b` 的标准用户生产管道及其他原生门通过，Credential Manager 实际启动通过，下一处完整性拦截为 PortableGit 的 `usr/libexec/getprocaddr32.exe`。核对 upstream getprocaddr.c：这是 MSYS 的 WOW64 helper，单参数形式只查询本进程导出函数地址，多参数形式才涉及目标 PID。保留完整工具依赖，只允许该固定 payload 路径为 `pe-x86`，增加单参数 ExitProcess 查询探测，不调用目标进程或注入模式；所有其他 x86 文件以及替换核心 x64 工具仍拒绝。格式测试本地 10 项通过，原生执行待云端。

第三次 Windows 11 VM `37703046385` 仍于 45 分钟超时且最终黑屏、没有 guest report，尚不能判断登录/网卡情况。带串口回传和显示唤醒的 `37708656202` 已启动，保持环境验收未完成。

### 工具闭包与托盘入口（2026-10-08）

`d6464050` 的固定 Node/Git/Bash/Pi 工具准备及原生文件/管道/Job 检查通过，完整候选资源首次执行，库存拒绝 Python pip/distlib 携带的 ARM launcher。Windows preparer 只移除 distlib 四个非 x64 launcher，保留 pip、源码/许可及 x64 launcher；完整库存与实际 Python/PDF 导入继续验证，待云端复验。相同提交 macOS arm64 全部 CI 回归通过，Intel 尚在运行。

Windows Main 新增托盘恢复、设置、显式停止确认和退出入口，以及 AppUserModelId；关闭隐藏/退出保留独立 Server，复用现有安装和生命周期 owner。macOS Dock 入口保留。本地 Desktop 类型检查、构建、9 项测试和隔离真实 Electron/生产 Web smoke 通过，确认客户端退出后 Server 仍存活，证据 `.tmp/windows-desktop-validation/macos-arm64-1791422373671`。Windows 实际 GUI 行为仍待验证，不将托盘源码完成视为 P2 通过。

Gateway 新增显式原生模块入口；只有实际 WindowsPipeStream 才能在 Windows 注册 Desktop ticket，普通 Node 管道继续禁用。Desktop discovery 新增受 ACL 保护的 manifest 读取及 OS pipe PID 核对，保留 release/installation/origin/nonce 校验；原有 Unix 分支不变。Windows 原生集成测试覆盖连续/并发 ticket、重放、错误 PID、越界 manifest 和缺少 native identity。本地 Root/Desktop 类型检查和相关 Gateway/会话 21 项通过。生产 composition 与 Desktop 尚未选用新入口，须在云端集成和跨账号/远程拒绝通过后再启用；当前不是认证交付完成。

`294cc6bf` 增加真实 production Gateway 的两普通账号与 SMB 检查：同账号 Desktop discovery 正例、另一账号普通 Node 管道连接/直接 endpoint 读取被 OS 拒绝，以及同一 owner 的 SMB 正对照与原生管道远程拒绝，待云端运行。VM 第四次环境准备的 10 分钟截图为安装 77%，尚无登录报告；下一次增加 QMP 状态/磁盘 I/O 证据及停机后的只读 NTFS setup 诊断，只输出有界且过滤敏感行的故障信息，磁盘/应答文件/密码不上传。

`9d8bad0d` 已通过完整 payload 的本机工具调用及二进制库存，最终 manifest schema 拒绝默认相对 artifact URL。CI candidate 现显式传入本地 file URL，正式发布 packager 默认行为未改；资源包门仍待通过。凭据 store 和 endpoint publisher 新增显式 native private-root 参数，保留原 schema、命名空间及原子替换语义。只有已固定/校验父目录后的最终文件确实不存在，原生 read 才返回 ENOENT；ACL、链接及祖先错误不能被当作空凭据。macOS 19 项凭据/endpoint 测试和 Root/Desktop 类型检查通过；Windows 原生 store 测试与生产装配待完成。

`294cc6bf` 的原生 Gateway/discovery 连续、并发、PID/manifest 负例全部通过；跨账号套件在前置 SMB 正对照超时，尚未执行到 Gateway，未据此启用生产入口。正对照改为有界异步读写并增加阶段诊断，普通账号正例/跨账号负例提前独立执行。Windows Desktop 安装 helper 先用已验证 payload 的模块保护 root，再创建锁和凭据；正式 staging 携带模块，初次指针创建按真实目标明确文件/目录 symlink。macOS 安装相关 8 项测试和类型检查通过。candidate 后续新增正式隔离安装、原生凭据读取及真实 SQLite integrity 检查，使用固定无效域名/假 key，不调用模型；该门待 Windows 实测。

### Intel Desktop 回归发现与修复（2026-10-08）

`d6464050` 的 Intel 原有模块检查/Gateway smoke 通过，但真实 Electron 在隐藏侧栏后菜单“搜索对话”聚焦超时（electron-smoke.mjs:94），该候选不能标为 macOS 全通过。原实现 setSidebarHidden 后用 requestAnimationFrame 聚焦，回调可能早于 React 提交可见 DOM，导致 display:none 输入框拒绝焦点。改为受请求状态控制的 useLayoutEffect，在同一组件可见状态提交后聚焦；普通浏览器未增加 native menu。实际 smoke 连续三次验证隐藏→搜索，失败时也保留界面和安全诊断。本地 arm64 构建及真实 Electron 通过，Server 退出存活检查通过，证据 `.tmp/windows-desktop-validation/macos-arm64-1791423608199`；Intel 云端复验待完成。隔离安装检查使用现有打包后的 platform-tools，不能假定 tsup 分发保留 src 目录结构。

`795a9dea` 的 native store 4 项、Gateway/discovery 3 项以及管道/锁检查通过。`e3ff1e1f` 的真实普通 owner Gateway 会话通过；其他普通账号的 Node pipe connect 返回 EPERM，测试只接受 EACCES 导致失败。修正为仅接受 libuv 的两种权限拒绝码 EPERM/EACCES，不接受端点缺失/超时；endpoint 跨账号拒读和 SMB 后续门仍待执行。安装选择恢复从 Unix 字符前缀改为平台 isAbsolute，避免 Windows 重启时忽略 C:\\ 安装根。

`480b601f` 已通过 production Gateway 的普通账号会话、另一普通账号 pipe/endpoint OS 拒绝、同 owner SMB 正对照及原生远程拒绝，并再次通过原生 stream/store/discovery。正式 Server 现选用 installed release 的 native 模块，先保护 root 再初始化子路径，Provider/internal credentials 和 endpoint publication 使用 native private adapter；DesktopServiceManager 从已核验的 immutable release 取得模块并执行 PID 身份验证。缺模块的普通 Node pipe 继续禁用 ticket，不做安全降级。Root/Desktop 类型检查及 macOS client/server/认证 52 项通过，完整原生 Server/安装/GUI 仍待验收。

`e417ae61` 完整 payload 拒绝未获准的 x86 文件，已增加所有具体路径诊断；未扩展白名单。官方固定 Windows Python archive 已单独下载并 SHA256 验证，确认只有 pip/distlib 四个外架构 launcher（已由 preparer 移除），其他路径来源继续定位。第四次 Windows 11 环境 run `37708656202` 超时未回报，下一次 `37713269208` 带只读 setup 诊断继续；这不是 Windows 11 验收成功。

### 锁定依赖的 Windows x64 闭包（2026-10-08）

已定位 Planner 的 ssh2@1.17.0 自带 `util/pagent.exe` 为 x86。新增构建步骤核验包版本和原始 C 源码 SHA256，以 MSVC x64/static CRT 重建该辅助程序，强制包含标准头文件避免旧 C 隐式声明截断指针；不改上游源码、不删除 SSH agent 功能、不扩展 x86 白名单。打包前验证 PE 架构、参数拒绝、无 agent 拒绝及临时 Pageant 窗口的 SSH identities 二进制往返，并记录来源/产物哈希。原生构建与完整资源门待云端执行。

第四次 Windows 11 最终截图已确认进入真实桌面（官方 Enterprise Evaluation，MWCI 登录），但 bootstrap 未回报，故仍不是环境或产品验收通过；第五次继续收集 setup/首次登录诊断。macOS `e417ae61` 两架构的模块回归、Gateway smoke 和实际 Electron 均通过，最新提交仍需同提交矩阵验收。

### Windows 正式停止的 Server 生命周期接入（2026-10-08）

源码新增仅原生身份管道允许的停止请求，绑定 OS PID、endpoint startedAt 和随机 nonce。Gateway 不拥有清理政策，只转交现有 ServerApplication.stop；正常清理或失败都写受 ACL 保护的对应凭据，CLI 同时要求成功凭据和进程退出，不把强杀造成的 PID 消失当作成功。正式 stop/restart 共用此入口，Windows 缺 native adapter 时明确失败，禁止 SIGTERM/共享控制台 Ctrl-Break 降级；Unix 信号路径不变。ADR-0045、CONTEXT 与技术概览已记录边界。

本机 Root/Desktop 类型检查及生命周期、锁、普通管道拒绝、模块边界 50 项通过。新增 Windows 原生测试覆盖完整 drain 顺序、失败清理回报及错误 PID/startedAt 拒绝；云端与实际安装中的活跃任务停止仍待通过，不能据源码补齐关闭 P1/P3。

`cd6ec78c` 云端原生 Server 停止测试 3 项通过（同批 stream/store/锁 22 项通过、Unix 信号专属 1 项跳过）。macOS arm64 完整回归发现 PDF 取消 fixture 偶发未经历 SIGKILL：fixture 先发布 PID 再写 stderr，取消可在两者之间关闭父管道，使 EPIPE 提前结束本应忽略 SIGTERM 的 worker。就绪发布移至首次 stderr 写完成回调，保留真实 group 消失和 SIGKILL 断言；不改变生产取消逻辑。修正后本地 PDF 两项通过，云端复验待完成。

### 配置持久化的 Windows 句柄适配（2026-10-08）

run `37717090425` 的原生探测确认普通文件及 NTFS 目录在 GENERIC_WRITE 句柄下 FlushFileBuffers 成功，而只读句柄均返回 Win32=5；未吞掉 fsync 错误。生产 platform 新增带祖先固定/重解析拒绝/ACL 检查的可写刷新，原子替换后刷新文件和父目录；替换后的刷新失败保留完整新文件供 journal 恢复，不再把它当临时文件删除。配置 revision 和 activation journal 显式接受同一 Windows 私有根，Desktop 安装/Server composition 接入，旧 schema/激活政策/Unix fsync 保持。

新增普通/管理员 file probe 和配置两版本激活、中断恢复、回滚检查，原生云端待执行。本地类型检查与配置/安装/PDF 23 项通过。完整 updater 的指针切换及所有 Windows 初始化入口尚需继续接入，不据此宣称安装/升级完成。

Server 账户迁移 manifest、Conversation metadata/pending-history、兼容 presentation JSON 及唯一 segmented journal writer 已显式接入同一 Windows 私有文件根；不新增 writer，不改 SQLite schema、事件索引提交点或恢复政策。Unix 路径保留原实现。本机相关 38 项及 Root/Desktop 类型检查通过，新增 native store 重建后事实读取检查。因涉及持久化，专用 workflow 同时增加既有 Dockerfile.test 的 Linux owning-seam 回归，Windows/macOS/Docker 实测结果分别记录，尚不代表 P1 安装通过。

`59a9be55` 的 Pageant x64 源码构建/二进制往返与完整 Windows Runtime/Desktop 资源校验已通过，正式安装随后在旧 FileConfigurationRepository 的只读 fsync 报 EPERM；`8dc2a666` 已接入可写句柄，待云端安装复验。candidate 保存 Pageant 来源/产物哈希证据。`8dc2a666` macOS 回归的唯一失败是架构测试精确匹配旧构造器参数，更新为仍严格核对 accountPaths.config + Windows adapter；35 项模块边界复验通过。此项不代表 Windows 配置或完整安装已通过。

配置/首次安装指针新增原生 Windows 相对 symlink 创建及 FileRenameInfoEx 替换：固定祖先，拒绝 junction/非符号链接目标覆盖，验证最终目标类型与安装根边界，父目录刷新成功后返回。保留原相对链接格式及原激活 journal；Windows 普通用户 probe 显式配置并恢复开发者模式前置。新增目录/文件指针切换、越界目标和普通文件保留负例；macOS 配置/安装/架构 18 项与类型检查通过，原生结果待云端，尚未作为 updater 全量交付证据。

`8dc2a666` 的原生 flush 与普通用户写入已通过，但配置 revision 的 Node mkdir 子目录被 owner/ACL gate 拒绝。Windows 提权 token 的默认 owner 可为 Administrators，目录虽然继承封闭 ACL，仍不满足旧 exact-user owner 条件。按方案允许 SYSTEM/管理员管理权限，private-file owner 与 allow ACE 统一限定 current SID/SYSTEM/Administrators；不接受其他用户、宽泛组、null DACL 或 unsafe links，pipe peer SID 仍严格要求当前用户。新增 Node 创建子目录/文件的管理员与普通用户回归，复用已有跨账号拒绝；该修正待云端确认，未移除安全门。

candidate 后续增加安装后的 DesktopServiceManager 自动启动/复用真实 Server、单次票据 HTTP 会话、普通浏览器未认证检查和正式 stop/drain 凭据/endpoint/runtime.lock 清理；使用无效域名假 provider key，不调用模型，真实 GUI/模型任务仍独立验收。错误证据只保留有界过滤后的 Server 错误栈，不上传登录 token。

ReleasePointerTransaction 新增显式 Windows adapter，仍按 database/configuration/generated/application 顺序切换及原 journal/health/rollback 政策执行；用原生相对 symlink 替换和私有 journal 读写/删除。新增 guarded file removal，拒绝 reparse/hardlink，删除后刷新父目录。新增候选健康失败时完整指针回滚及提交后恢复测试；本机原指针事务/journal 6 项和类型检查通过。尚未在 SourceNativeUpdater/协调壳层全入口选用，待原生门与备份 companion 适配完成。

`845e1aa8` 的 macOS arm64 和 Linux Docker 持久化回归通过；`41b1ff1c` 同两门通过，Intel 与原生尚在执行。`59a9be55` 两 macOS 架构已通过；均不是最新同提交发布矩阵，不能关闭 P4。

### 干净 Windows 11 环境诊断（2026-10-08）

第五轮 `37713269208` 未完成：UEFI 日志和进度截图显示安装盘启动后重启，磁盘已分区但未写入 Windows 系统文件，随后没有可启动设备。ISO SHA256 与此前到达真实桌面的第四轮相同；不能把这一环境失败解释为产品验收通过。下一轮保留启动前三分钟的逐十秒截图，发现无启动设备即退出并收集只读诊断，避免无证据等待。FirstLogon 改为执行 specialize 阶段复制到本地的 bootstrap，移除首次登录时对光驱 WMI 枚举的依赖；仍须收到实际 Windows 11 / Secure Boot / TPM / 交互桌面回执才通过。

`a9e06f8f` 的 macOS arm64 与 Docker owning-seam 回归通过，普通用户的原生私有文件/原子替换/相对指针/管道 probe 通过。管理员侧及完整安装尚有失败，继续处理；P1/P4/P5 未关闭。

`a9e06f8f` 完整正式隔离安装已通过，实际安装的 DesktopServiceManager 自动启动并复用同一 Server；随后浏览器未认证检查错误预期 `{authenticated:false}`，正式契约为 `401 {error:unauthorized}`，已修正测试断言，未更改浏览器认证。完整会话与 stop 结果仍待复验。该提交 macOS arm64、Intel 及 Docker 回归均通过。

原生配置 revision 中断恢复与整套 release pointer 健康失败回滚通过。其余失败已定位：Conversation 两个存储与 journal close 使用写死 `/` 的路径边界，改用平台 sep；原生并发 writer 检查旧目标句柄时另一 writer 已使 link count 归零，允许这个已取消路径链接的旧 inode 完成只读检查，仍拒绝多硬链接。新增真实 Conversation 读写覆盖；本地原有存储、journal、companion 45 项与类型检查通过。另增加不可覆盖的原子私有文件发布原语，为 companion 恢复保留冲突拒绝语义，原生云端待验证。

### 升级日志 companion 的 Windows 适配（2026-10-08，待原生复验）

Gateway journal backup/restore 显式接收 Windows 私有文件 adapter，保留原 manifest/hash/index 身份检查和全量 preflight。新增 guarded staging-directory move 及不可覆盖原子文件发布，恢复不用覆盖 rename 或暂时多硬链接，遇到并发目标必须复验原 hash，失败不更改冲突正文。更新器的配置、迁移、activation journal、companion 以及 prepared recovery 路径传递同一 adapter；旧普通数据库切换为版本指针使用专门的已验证 regular-file promotion，常规指针 API 仍拒绝覆盖普通文件。数据库 clone/backup 在 Windows 激活前用可写私有句柄刷新。

新增原生目录发布/冲突拒绝/文件指针迁移，以及真实 SQLite 索引+segment companion 的中断发布、重试、冲突保留测试。本机 updater/companion/指针事务 58 项及 Root/Desktop 类型检查通过。完整 Desktop 协调 helper/NSIS 尚未接入，不据本次源码适配宣称 P3 升级完成；Windows 原生与 Docker 持久化回归待此提交执行。

`11dd03b8` / run `37720845429` 全部当前自动化 job 成功：Windows build/原生 transport/store/process spike/完整资源/正式隔离安装/真实安装 Server 自动启动复用/Desktop 票据 HTTP 会话/普通浏览器 401/正式 drain 与退出清理；macOS arm64、Intel（含真实 Electron）及 Linux Docker owning-seam 回归全部通过。此矩阵未覆盖 packaged GUI、真实模型任务或 NSIS，不能关闭 P2–P5；后续提交仍需复验。

### 生产 Job 进程适配开发（2026-10-08，未选择为运行默认）

新增 Node-API process adapter：CreateProcess suspended、仅三个 stdio 句柄继承、执行前加入 KILL_ON_JOB_CLOSE Job，异步线程 quiescence/pause/resume 使用已验证的公开 Win32 API，取消终止整个 Job。TS 字节流抽为不含身份授权的公共平台流，Gateway 仍只接受原 authenticated WindowsPipeStream；进程 stdio 不会被误当成本地身份管道。进程退出仅在全部 Job 成员与输出收敛后报告，并显式释放句柄；原 CLI root 退出时清理其仍存活后代。

新增真实 Node argv/Unicode env/2 MiB stdin/out 往返，以及后代暂停/恢复/取消和无关进程保留原生测试。本机类型检查、argv/env 纯检查和 Unix 本地会话检查通过，Windows 原生编译/执行待云端。此 adapter 尚未注入 Planner、Executor 与 worktree backend，P0 spike 仍不能代替生产链验收。

生产进程适配继续：Server composition 显式加载安装内平台模块，为 Planner、worktree backend、每个独立 Local CLI/Image API runner 注入 Windows spawner。每个 adapter 保留独立 attempt map，避免一个 adapter 的 abort 扩大至其他运行实例；Unix 默认 spawn、信号和回收路径不改。新增最小 ManagedProcess 公共事件/流契约，不使用 Node 私有句柄或伪造 ChildProcess。Windows launch 明确使用 exe/com + CRT argv 编码，不把参数交给 shell；可选 npm cmd shim 需通过固定 Node 入口配置，完整可选 Codex 入口仍待评估。

本机 Planner/Executor/worktree/Account composition/模块边界共 97 项通过（3 个原生 Windows 检查在 macOS 跳过），Root/Desktop 类型检查通过。新增实际 Executor cancellation receipt 等待后代消失的 Windows 集成检查。`172c48fe` 原生编译/进程门当前通过，完整 job 尚未结束；安装内真实模型任务仍不算通过。

`45a71af6` 的 native companion 中断/恢复/冲突保留、全部私有文件/pointer 测试、正式安装与会话门、两个 macOS 架构和 Docker 回归通过；独立 P0 carrier 测试的 reparse 拒绝异常文本出现不可解码字节，导致严格消息断言失败，后续提交复验，不把该失败掩盖为整体通过。

### Packaged EXE 与 Windows 11 回执补充（2026-10-08，云端待执行）

新增仅用于内部候选的 Windows x64 unpacked Electron packaging 配置，打包前继续验证签名资源 inventory，保留 macOS 原构建配置。候选流程以受限 PATH 启动实际 MetaWork.exe，在独立根目录走首次配置、正式安装、自动 Server/本地会话、共享 Web 渲染、刷新及退出后 Server 存活，并正式 stop 清理。不是 NSIS 安装/升级验收，不关闭 P2/P3。

Windows 11 首次登录先保存本地阶段、截图与结构化回执，串口/HTTP 无响应时在 VM 停止后只读提取有界证据；网络上传失败独立记录，不等同于 OS 验收失败。通过仍要求 Windows 11 Client、Secure Boot、TPM、交互桌面与实际截图，缺失不通过。磁盘、答案文件与临时凭据不上传。

`172c48fe` / run `37722602210` 全矩阵通过（Windows 原生 Job/companion/正式安装、macOS 双架构真实 Electron 和 Docker）；先前 carrier 异常文本失败未在该提交重现，仍保留严格断言。新生产 injection 提交 `813d5056` 正在云端验证，本机 Desktop 类型、脚本语法、差异检查通过。

### Planner Host 原生管道接入（2026-10-08，Windows 待复验）

安装内 Server 为 Planner Host 注入与 Gateway 相同的受限原生 listener，保留现有 MCP/JSONL 协议、Session 提案校验与 Unix socket 身份回收。新连接在 stop 后拒绝，管道抢占必须失败。Windows 原生测试覆盖公共 Node net 客户端握手/响应、RPC 权限边界、关闭及重新绑定；双账号/SMB probe 扩展到实际 Planner Host。macOS 上原有 Planner Host、Server composition、客户端 ownership 20 项及 Root 类型检查通过；不据此标记 Windows 原生或真实模型任务通过。

### Windows Desktop activation 持久边界（2026-10-08，未接通 NSIS）

DesktopActivation 与 shell health 读写增加显式 Windows private-files adapter，沿用原状态机、challenge/instance/PID 核验和 companion 恢复先后顺序；Unix 默认路径保留。原生测试覆盖各中断 phase、companion 缺失保持 recoverable journal、重建 helper 后恢复、旧 Server 回执拒绝及 journal reparse 拒绝。本机原有 activation/health 10 项和 Root 类型检查通过；Windows 12 项私有存储检查待云端执行，NSIS 与 helper 的生产接入仍未完成。

`813d5056` / run `37723271152` Windows、macOS arm64/Intel、Docker 全部现有自动门通过。后续检查发现 Planner 正式配置指向 cli.js，Windows CreateProcess 不能直接执行 shebang；Supervisor 三个入口统一通过当前独立 Server 的固定 Node 启动绝对 JS 入口，仍使用 owned Job，不引入 cmd 参数拼接。新增中文/空格脚本路径的原生 probe 回归。本机 Planner 43 项通过（4 个 Windows 项跳过），Root 类型检查通过。真实模型任务继续准备，不能用 probe 代替。

### 发布验收续验（2026-10-08，未完成）

本轮范围仍为 `feat/windows-desktop` 的候选构建和验收，不改版本、不合并 main、不打 tag、不发布 Release。完成日期与 closing commit 暂不填写：必需发布门仍有缺口。

- `1b843760` 增加 NSIS current-user 安装/卸载和数据保留探针，production 依赖改由锁文件重新 `npm ci --omit=dev`；`1b73c3e1` 修复 Windows Planner Host 测试的管道字符串。
- [`37738473847`](https://github.com/IFOSR/metawork/actions/runs/37738473847) 的 Windows 原生安全门、两个 macOS 回归 job 和 Docker 通过；完整资源与正式隔离安装通过。packaged GUI 停在错误页，截图显示“版本不匹配”，不是模型或网络故障，NSIS 探针未执行。
- `ad44c096` 把完整 payload 哈希/PE 校验改为最多 24 个并发 worker。早期将 GUI 失败归因于校验过慢的判断被截图推翻；此性能修改不能作为 GUI 修复证据。[`37742309639`](https://github.com/IFOSR/metawork/actions/runs/37742309639) 仍失败；普通用户并发私有文件 probe 也发生一次原生异常文本截断（`Error: m`）。后续严格原生 probe 通过不抹去该记录。
- `86800f18` 避免 Electron Builder 的文件 walker 丢弃已签名工具树中的 `.gitkeep` / `.DS_Store`：Windows `afterPack` 精确复制 descriptor、trust keys 和 payload，再对实际包内树做完整验证。此验证在 [`37768460630`](https://github.com/IFOSR/metawork/actions/runs/37768460630) 通过；新 GUI probe 的异步 `waitForFunction` 却把 Promise 当作 truthy，过早读取 connecting 状态。`a5b5e7af` 改为等待真实页面 setup/error 元素，保留独立状态断言，不放宽产品验收。
- `a5b5e7af` 同时修复正式 Desktop install helper 的 update/rollback 分支漏传 Windows private-files adapter，并增加回归测试。这只修复运行时 helper 的接线，不代表 Windows Desktop 协调更新、NSIS 覆盖安装、回滚或中断恢复已完成。
- 用户确认 `METAWORK_TEST_MODEL` 是 `{baseUrl, modelId, apiKey}` JSON。NSIS 安装后 smoke 使用这个测试连接，从已安装 EXE 的 Web 页面提交实际文件任务及取消任务；核对 Task/Subtask/attempt/publication、文件内容和实际命令进程退出。provider 输入不进入报告、不继承给依赖安装/构建或 Electron 进程环境；任务产物截图只在离开首次配置页后保存。[`37769961441`](https://github.com/IFOSR/metawork/actions/runs/37769961441) 的原生、macOS 双架构和 Docker 回归通过；packaged GUI 已进入首次配置页，但提交配置后仍处于安装 connecting 状态，超过 180 秒测试预算，NSIS/真实任务门未执行。没有证据可将本次失败归因为模型或复制性能。
- 本机 `npm run lint` 与 Desktop release/Windows release/install helper/activation/shell-health 共 5 文件 24 测试通过。云端仅在全部声明检查成功后上传带 SHA256/source commit 的 NSIS 内部候选；它不是真正 Release。

Windows 11 证据：[`37739922946`](https://github.com/IFOSR/metawork/actions/runs/37739922946) 的最终 QEMU 截图已显示 Windows 11 Enterprise Evaluation 交互桌面，但没有 guest JSON/TPM/Secure Boot 回执，不能判定环境门通过。`86800f18` 改为首次登录时重新定位安装介质上的 bootstrap，并在只读磁盘诊断中允许读取未正常关机的 NTFS；[`37768460803`](https://github.com/IFOSR/metawork/actions/runs/37768460803) 复验中。此 workflow 目前只验证 OS 环境，`desktopAppVerified` 固定为 false，不能代替 Windows 11 上的 NSIS/产品验收。

`468d537f` 修正环境 bootstrap 的确定性配置错误：原 FirstLogonCommands 的编码命令长 1538 字符，超过 [Microsoft 文档](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-shell-setup-firstlogoncommands-synchronouscommand-commandline) 规定的 1024 字符上限；现为 838 字符，并在生成时校验长度。只读磁盘诊断增加固定失败阶段及有界挂载错误。新 run [`37771405476`](https://github.com/IFOSR/metawork/actions/runs/37771405476) 等待环境复验；修正配置不等于已取得 guest 回执。

首次安装续验为独立 helper 增加固定阶段进度（验证、复制、配置、激活），只允许这些枚举进入 Desktop 状态，不转发任意 stdout 或模型配置。packaged smoke 记录阶段变化，将首次安装预算调整为 10 分钟并保留失败断言；NSIS 总预算容纳两个真实任务。payload 并发验证在首个失败后等待所有在途文件句柄关闭才返回，避免 Windows 清理 staging 时竞争。取消验收同时检查命令及其后代 PID。上述补充仍待原生执行证据，不能标记验收通过。

仍必须关闭：Windows 11 普通用户真实 packaged 产品验收；真实任务和取消门的实际结果；Windows 协调升级（目前 UI/helper 仍有 `.app`、`codesign`、`/usr/bin/open` 假设）、失败回滚和中断恢复；运行中任务的卸载确认与重装数据复用；§6.1 同源 macOS packaged/Web/TUI/三客户端和安装升级完整验收。基础 CI 通过只覆盖 workflow 已声明场景，不能据此关闭 P3–P5。

### 2026-10-09 继续验收（未完成）

- `e9a12fe4` / [`37772227553`](https://github.com/IFOSR/metawork/actions/runs/37772227553)：原生、Docker 与两个 macOS job 通过；packaged 安装约 20 秒进入复制，125 秒进入激活，170 秒回到安装失败页。NSIS 和真实任务仍未执行。此证据排除了“只是 180 秒不够”的判断。
- `468d537f` / [`37771405476`](https://github.com/IFOSR/metawork/actions/runs/37771405476)：Windows 11 交互桌面可见，但仍无回执；固定挂载第 3 分区报 NTFS signature missing。不能从截图宣称 TPM/Secure Boot 通过。
- `9daeec1b` 加入仅错误码/调用名的安装失败报告，省去已失败后继续等待 10 分钟；显式为后续 packaged 测试启用计划要求的 Developer Mode（普通用户 probe 会恢复之前的设置）。环境验收改为探测 NTFS 系统分区，并在首次登录回执缺失时从交互控制台启动同一无密钥 bootstrap。Windows 复验 [`37868006653`](https://github.com/IFOSR/metawork/actions/runs/37868006653)，Windows 11 环境复验 [`37868006655`](https://github.com/IFOSR/metawork/actions/runs/37868006655)，结果待收集。本机两个类型检查、安装/诊断 12 测试通过。
- Windows 协调更新源码已接入 NSIS 独立 staging、既有安装转交 Desktop 确认、平台路径、Windows 私有 request/lock/journal、SourceNativeUpdater、候选 workspace 渲染回执和保留 user-data 目录；拒绝壳层与 Runtime 根互相包含。macOS 保持 `.app`/签名验证。当前仅通过 Root/Desktop 类型检查、16 个路径/activation/health 测试及 11 个 Desktop 测试；NSIS 编译及真实升级/失败回滚/中断恢复尚待执行，不能据此关闭 P3。
- `0c279c31` 已提交上述协调更新，复验 [`37868572666`](https://github.com/IFOSR/metawork/actions/runs/37868572666)。后续卸载接线用 Desktop 读取实际任务影响、确认并正式 drain，NSIS 等待有界回执及 Main 退出后才移除文件，不使用强制 kill。静默卸载不能跳过运行任务确认。新增真实任务运行时拒绝卸载后进程仍存活、正式卸载及重新安装复用同一 Task 记录的验收脚本；目前只通过 13 个 Desktop 本地测试、类型和语法检查，未取得 NSIS 原生结果。
- `9daeec1b` / `37868006653` 最终失败：packaged helper 的安全报告给出 `FileConfigurationRepository.writeRevisionFile` / Win32 3，发生在配置激活；Developer Mode 不是充分修复。排查发现原生文件操作仍受 MAX_PATH 限制，而配置 staging + 随机临时文件路径可能超过 260 字符。新增经原有 DOS 路径校验后才应用的 extended-length 路径，以及超过 400 字符的读写/flush/move/pointer/删除/越界拒绝原生 probe；Windows 执行结果待收集。
- 补充已安装升级验收：同源、同一临时签名信任根生成独立测试 release identity，分别走实际菜单/NSIS 的正常更新、有意不渲染 workspace 的签名故障候选回滚、Runtime 切换后终止 helper 再从修复菜单恢复。每次检查持久 activation、Server 与 shell 重新启动、数据库完整性、原任务保留、实际认证 workspace 截图。故障候选不上传为产品候选；当前仅完成脚本和类型检查，尚无原生通过证据。Windows job 预算覆盖这些额外场景，成功条件未放宽。

- `da1d85ae` 提交长路径修复及已安装更新验收，复验 https://github.com/IFOSR/metawork/actions/runs/37870151697 排队中。补充 macOS arm64 当前源码 packaged 验收：只从已验证签名及哈希的 v0.1.8 DMG 提取 Node/Git/Pi 工具，Runtime/Planner/Web/Desktop 全部来自本分支当前提交；独立短路径安装，真实模型产物及取消子进程清理。既有 Intel 源码回归保留；尚未取得 packaged 原生结果，也不声称覆盖完整 §6.1。
- 增加独立普通浏览器的同安装验收脚本：从安装版 `web --no-open` 入口打开，独立 Cookie 必须先拒绝匿名会话并要求账密登录；观察 Desktop 创建的相同任务，通过认证下载实际产物并校验内容，拒绝匿名下载，核对取消终态及重载后的历史/Server PID。使用 runner 自带 Chrome/Edge；尚待真实执行，不能据此宣称 Web 或三客户端完整通过。
