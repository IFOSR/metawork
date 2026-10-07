# Windows Desktop 实施与验证记录

- 日期：2026-10-07
- 状态：In Progress，P0 原生技术前置已验证，开始 P1 平台适配；生产安全 transport / process adapter 尚未接入，未交付 Windows Desktop。
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
