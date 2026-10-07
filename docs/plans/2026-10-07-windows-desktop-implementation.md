# Windows Desktop 实施与验证记录

- 日期：2026-10-07
- 状态：In Progress，P0 未通过；未交付 Windows Desktop。
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

## 待通过的阶段门

- P0：原生 Windows 环境执行；标准用户前置；受限 Named Pipe DACL、内核取得的 Server PID/用户身份、跨账号拒绝、远程客户端拒绝、抢占/链接竞态；native adapter 选择及对应 ADR 修订。
- P1–P3：Windows 安装根/依赖闭包、安全 Desktop 会话、托盘及生命周期、NSIS 和事务升级/回滚；当前尚未实施这些生产适配。
- P4：最终 Windows 候选及同源 macOS 候选完整回归；本地开发壳层通过不能替代真实 `.app` 新装/升级/回滚、真实模型任务或 Intel 验收。
- P5：用户暂无 Windows 实体机/VM；GitHub Windows Server runner 不满足 Windows 11 干净 GUI 人工验收。需另有真实 Windows 11 x64 环境，缺失时不得宣布完成。

架构保持现有 macOS Desktop 基准。P0 没有通过前不放开 Windows Desktop 认证，也不发布“可用 Windows 版本”。
