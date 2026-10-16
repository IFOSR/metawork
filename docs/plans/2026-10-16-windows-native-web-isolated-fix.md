# Windows 原生 Web 独立修复计划

- 计划日期：2026-10-16
- 状态：用户已同意分支隔离与 Windows 本机实施；运行代码尚未修改，Windows 验收待开始。
- 工作分支：`fix/windows-native-web`
- 起点：`main` 的 `cde31595`（`docs: record v0.1.16 packaged acceptance`）。此处记录分支基线，不代表 Windows 已通过该版本验收。
- 产品范围：Windows x64 原生 MetaWork Server + 浏览器 Web；不制作 Windows Electron Desktop。
- 完成日期、交付行为、验收证据、关闭提交：待实际完成后填写；本计划建立不代表修复完成。

## 1. 目标与实施边界

在 Windows 本机修复和验证，让普通用户无需管理员权限或开发者模式即可安装，
通过 `metawork server start` 启动本地 Server，通过 `metawork web` 使用浏览器。
官方登录、设置激活、Planner、Pi/Codex Executor、任务执行与文件交付沿用现有产品链路。
浏览器连接本机 Windows Server，不以连接远端 macOS/Linux Server 代替原生验收。

继续使用同一仓库和核心实现。Windows 差异限定在必要的平台适配和发布流程中，
不创建长期独立产品 fork，不新增语义路由、执行后端或账号登录持久化策略。
TUI 的专项 Windows 适配不是本次交付目标；共享代码仍须保留现有客户端契约。
不修改 macOS/Linux 当前安装、启动、更新入口，不更新本机已安装的 MetaWork。

旧的 [Windows 修复方案](metawork-windows-fix-plan.md)仅提供历史复现线索。
实现以当前代码、测试、已接受 ADR 和 `CONTEXT.md` 为准，不直接搬入旧 preload 补丁。

## 2. 分支与交接

Windows 开发机已有此仓库时，先确认没有未提交改动，再执行：

```powershell
git fetch origin
git switch --track origin/fix/windows-native-web
```

若本地分支已存在，切换该分支后使用 `git pull --ff-only`。
首次安装依赖使用兼容当前构建的 Node 22（最低 22.19），记录实际 Node、ABI、Git、
Windows 版本及提交号。构建以仓库脚本为准；vendored Planner 使用 `build:offline`。
原生 SQLite 测试需要可用的 Windows native binding；若依赖安装失败，记录错误并修复
构建环境，不反复运行已知不能加载 SQLite 的完整测试集，也不跳过数据库验收。

使用独立测试安装根和测试账号数据，避免旧 preload、全局 Git 配置、历史 PATH 或
已预热的 Python 缓存掩盖缺陷。至少保留一轮无应急补丁的干净用户验收。
不得提交凭证、数据库、安装目录、生成的 `dist/` 或用户工作区状态。

## 3. 修复顺序与责任边界

### W1：重新复现并收紧修复清单

逐项记录当前提交的实际失败、调用链和失败阶段；区别源码缺陷、旧包缺陷及机器环境问题。
当前 `PiCliDriver.probe()` 已不以 PDF import 阻断整个 Pi Executor，不能基于旧包现象
扩大修改发布目录权限。Provider 预设修复属于独立全平台事项，另行核实和提交。
官方账号登录保持现有内存态，Server 重启后重新登录是当前契约。

### W2：Windows 命令、运行时和依赖适配

- Owner：安装/发布模块负责运行时与启动器；Planner/Executor 各自的启动 adapter 负责进程参数与生命周期。
- 显式处理 `.exe`、受支持的 Node 入口和 npm shim，保留 managed Pi 优先级及损坏时拒绝回退的规则。
- 探测、配置验证和实际执行使用同一个确定的工具入口；不得将任务正文或用户参数转成 shell 命令串。
- 不统一替换全部 `spawn`/`execFile`，不对未知 shim 自动使用 `shell:true`。
- 保留环境、工作目录、stdio、退出码、取消与子进程清理契约。Windows 上直接启动 Node 也须验证超过原生命令行限制的提示词；若需调整输入传输，先定义驱动接口与对应验证。
- 安装器检测或捆绑 Git，并配置 Server 启动时的工具路径；长路径配置限定在受管 Git 调用或仓库，保留既有 ref 命名，不修改用户全局 Git 配置。
- 优先规划 Windows 包自带固定 Node；短期可明确限制为兼容的 Node 22.x（至少 22.19），但安装器、Server、Planner 和 Executor 的实际入口必须一致且可诊断。
- macOS/Linux 的工具发现、shell/shebang、managed Node/Pi 与进程生命周期行为保持原样。

### W3：文件系统与升级恢复专项设计

这是实施前的设计门，不把以下问题作为低层 helper 的静默 fallback：

- Owner：Installation 负责版本与数据库指针事务；Configuration 负责配置 revision 激活及恢复。通用平台操作不得拥有领域恢复政策。
- 目录 junction 与数据库文件指针分别设计。硬链接/复制不是文件符号链接的通用替代，必须覆盖 `SourceNativeUpdater`、`ReleasePointerTransaction`、迁移、备份、WAL 和回滚的完整读写链路。
- 不把“先删旧指针再 rename”当作原子替换；任何中间状态都须有持久记录及确定的恢复路径，不放宽现有失败关闭规则。
- 文件持久化与目录刷盘分别处理；rename 原子性不等于持久性。不能以此为由整体跳过文件 fsync。
- 不把所有 readlink 都改为相同语义；审计各消费者、持久目标格式和历史 journal 比较规则，覆盖盘符、UNC、越界目标与损坏指针。
- 路径包含关系使用平台原生 path 语义，保留真实路径与符号链接校验；不能全平台将反斜杠替换为正斜杠后做前缀授权。
- 保留 POSIX 现有相对 symlink、权限、fsync、数据布局、revision 身份和恢复语义。不得整体跳过 `makeImmutable`/`makeWritable` 来绕过局部问题。

若设计改变安装持久化、指针格式或恢复契约，应在实现前更新适用 ADR（尤其 ADR-0027、
ADR-0030）和 `CONTEXT.md`、当前技术总览，说明迁移、失败恢复及唯一 owner，遵守 ADR-0020。
不能在本计划中提前视为已批准新的存储协议。

### W4：Windows 本机验收与独立预发布

先完成下节验收，再生成独立 Windows 原生包。包含 Server、共享 Web 静态产物、
vendored Planner 及必要依赖；不包含 Windows Electron 壳，不运行 Desktop 打包目标。
任何共享改动返回主线前，再通过 macOS/Linux 回归；分支通过 Windows 测试不等于可以合并。

## 4. 发布隔离

- 仅建立独立 Windows 预发布，使用唯一版本和固定 tag 下载地址；manifest 使用现有 `preview` channel，GitHub 发布标记为 prerelease 且不设为 latest。
- 安装器使用现有 `-ManifestUrl` 与 `-Channel preview` 参数，指向该版本的签名 `manifest.win32-x64.json`；不修改稳定安装器默认地址，不跳过验签或散列验证。
- 不覆盖稳定 Release 文件，不修改共享更新入口，不触发现有完整发布流程。
- 当前 `.github/workflows/release-build.yml` 会在 `v*` tag push 或手动触发时构建完整发布并提升 latest。不得直接推送这类 tag 或运行该工作流来发布 Windows 试用版。
- 先完成专门的 Windows 构建/预发布流程审查，确保发布目标、产物和 channel 均已限定，再创建发布。当前步骤仅建立分支及计划，不创建 tag 或 Release。
- 独立发布流程还须审查默认分支安装脚本和网页下载地址，确保 macOS/Linux 继续指向原稳定版。

## 5. 验收门槛

| 阶段 | 必须验证 |
| --- | --- |
| Windows 干净环境 | Windows 10/11 普通用户，无管理员/开发者模式、无 preload；中文/空格路径；安装后启动 Server，浏览器进入 Web |
| 工具与 ABI | 安装/运行的实际 Node 版本与 native ABI；创建 SQLite 数据库并执行查询，不只 `require`；Server 能找到 Git、Planner、受支持的 Pi/Codex |
| Web 完整流程 | 官方登录、配置连续激活、新建 Workspace/Conversation、上传附件、真实任务、引用与文件交付、历史回看 |
| 参数与生命周期 | 多行、中文、引号、shell 元字符、长提示词；探测与执行入口一致；任务取消、子进程清理、Server 重启后按契约恢复 |
| 安装事务 | 重复安装、已有版本升级、回滚、卸载；真实 WAL 数据、分段 journal 伴随备份及恢复；指针切换前后注入中断/失败，不产生混合版本 |
| 路径边界 | 合法子路径；父目录、同名前缀目录、根自身、跨盘、UNC、符号链接/junction 越界；POSIX 合法反斜杠文件名不能被误授权 |
| macOS/Linux 合并门 | 受影响模块测试、lint/build；安装/升级/回滚/配置恢复；Planner/Pi/Codex、取消、Git 发布与交付；macOS 另验证现有 Desktop 的 Server/更新集成 |
| 发布门 | 固定版本下载、签名/散列/channel 校验；Windows 包原生验收；稳定 latest、macOS/Linux 文件及入口未改变 |

每次验收记录提交号、平台/架构、Node/ABI、安装根、命令、结果及日志位置；Windows-only
分支无法完成的 macOS/Linux 项须明确保留待验收，不以 Windows 成功或 Docker 成功代替。
完成时填写实际交付、平台证据、未解决限制、完成日期及关闭提交。
