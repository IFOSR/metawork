# Windows Desktop 实施与验证记录

- 日期：2026-10-07
- 状态：In Progress，P0 管道/ACL 已验证，Job 暂停竞态复验中；P1 原生文件/平台适配进行中，安全 transport / process adapter 尚未接入，未交付 Windows Desktop。
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
