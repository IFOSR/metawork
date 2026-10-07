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

## 待通过的阶段门

- P0：原生 Windows 环境执行；标准用户前置；受限 Named Pipe DACL、内核取得的 Server PID/用户身份、跨账号拒绝、远程客户端拒绝、抢占/链接竞态；native adapter 选择及对应 ADR 修订。
- P1–P3：Windows 安装根/依赖闭包、安全 Desktop 会话、托盘及生命周期、NSIS 和事务升级/回滚；当前尚未实施这些生产适配。
- P4：最终 Windows 候选及同源 macOS 候选完整回归；本地开发壳层通过不能替代真实 `.app` 新装/升级/回滚、真实模型任务或 Intel 验收。
- P5：用户暂无 Windows 实体机/VM；GitHub Windows Server runner 不满足 Windows 11 干净 GUI 人工验收。需另有真实 Windows 11 x64 环境，缺失时不得宣布完成。

架构保持现有 macOS Desktop 基准。P0 没有通过前不放开 Windows Desktop 认证，也不发布“可用 Windows 版本”。
