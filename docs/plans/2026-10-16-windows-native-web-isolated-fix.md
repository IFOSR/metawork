# Windows 原生 Web 独立修复计划

- 计划日期：2026-10-16
- 状态：Windows 平台适配已实施并本机验收 Web/Server 主链路；原生安装事务与
  数据库文件指针仍为开放设计门（W3），因此尚未完成可安装预发布。
- 工作分支：`fix/windows-native-web`
- 起点：`main` 的 `cde31595`（`docs: record v0.1.16 packaged acceptance`）。此处记录分支基线，不代表 Windows 已通过该版本验收。
- 产品范围：Windows x64 原生 MetaWork Server + 浏览器 Web；不制作 Windows Electron Desktop。
- 完成日期、交付行为、验收证据、关闭提交：见第 6 节"实施记录"；本计划建立不代表修复完成。

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

## 6. 实施记录（2026-10-16）

### 6.1 W1 复现（本机实测，非旧包现象）

环境：Windows 10.0.26100、x64、Node v22.19.0（ABI 127）、npm 11.19.0、
Git 2.56.0.windows.2、安装根位于用户目录之外、无管理员权限、无开发者模式。

| # | 触发点 | 实际错误 | 归属 |
| --- | --- | --- | --- |
| 1 | `metawork server start` 首次启动 | `EPERM: operation not permitted, fsync`（AccountLayoutMigrator.writeAtomicJson） | 源码缺陷 |
| 2 | 启动到配置加载 | `RecoveryBlockedError: active configuration pointer escapes revision storage` | 源码缺陷（junction 绝对目标） |
| 3 | 配置激活 | `fs.symlink(..., 'dir')` 普通用户 `EPERM` | 源码缺陷 |
| 4 | 启动到凭据加载 | `non-macOS native installation requires explicit METAWORK_SECRET_STORE=file` | 契约未文档化：应由 Windows launcher 设置 |
| 5 | `metawork web` | `spawn('start')` 找不到 cmd 内建命令（ENOENT） | 源码缺陷 |
| 6 | 依赖安装（环境） | better-sqlite3 11.10.0 无 Node 24 预编译包 → node-gyp → 无 Python/VS 失败 | 环境：按 W2 使用 Node 22.x |
| 7 | 依赖下载（环境） | `github.com` 不可达（release 资产 000），`api.github.com`/`codeload` 可达 → 预编译包与 `pi-pdf` Python 归档无法按默认地址获取 | 环境/发布通道 |

### 6.2 已实施修复

- 新增 `src/platform/durable-fs.ts`：统一文件刷盘与目录刷盘。文件刷盘在 Windows 上用
  可写句柄（`FlushFileBuffers` 要求写权限），目录刷盘在 Windows 上不可达故仅 POSIX 生效。
  收敛全部 18 处 `open(...,'r')+sync`／目录 `sync` 调用点（configuration、storage、
  session、gateway、installation），写句柄调用点保持不变。
- 新增 `src/platform/fs-links.ts`：目录指针在 POSIX 为相对符号链接、在 Windows 为
  junction（普通用户可建）；`readDirectoryLinkTarget` 把 junction 的绝对目标归一化回
  `revisions/<id>` 相对契约（POSIX 分隔符）。已接入配置仓库与账户布局迁移器。
- `FileConfigurationRepository`：激活用 `replaceDirectoryLink`（POSIX 单次原子 rename；
  Windows 先移除旧指针再 rename），`readActiveRevisionId` 走归一化读取；`recover()` 新增
  "prepared journal + 指针缺失"的确定性恢复分支：重新校验并恢复上一 revision，绝不激活未提交
  revision；无上一 revision 时保持未激活并失败关闭。POSIX 分支保持原失败关闭行为不变。
- `openBrowser`：Windows 改为 `cmd.exe /d /s /c start "" <url>`，URL 仍以 argv 传入，
  不拼接 shell 命令串。
- `metawork server restart`：就绪探测改用 `resolveGatewaySocketPath()`（Windows 为命名管道），
  不再硬编码 `data/gateway.sock`。
- **W2 执行器工具解析（命令入口）**：`src/utils/executor-tool-path.ts` 新增平台候选顺序与启动解析：
  Windows 先找 `.exe`/`.com`，再找 `.cmd`/`.bat`，最后才是裸名字（npm 会在裸名字下写 POSIX sh 脚本）；
  `resolveExecutorLaunch()` 把 shim 解析为它指向的 Node 入口（npm 的 `.cmd` 与 `sh` shim 都能解析），
  执行时变成 `node <cli.js> ...`，不经 cmd.exe、不会截断长提示词；只有无法解析入口的 shim 才返回
  `shellShim=true`，执行器对其 fail closed（仅短探测允许回退）。`commandExistsOnPath()` 改用同一候选顺序，
  因此安装期 `detectCommand`、readiness 探测与真实执行入口三者一致。接入点：readiness `defaultVersionProbe`、
  `SpawnLocalCliChildProcessRunner`、Pi/Codex `defaultProbeCommand`、`validateCodexCommand`；
  缺失工具仍返回 `.missing-tools/<name>`，使探针报 ENOENT（missing）而不是 broken。
- 文档：ADR-0027、ADR-0030 增补 2026-10-16 修正节（目录指针后备、非原子替换的恢复依据、
  刷盘语义、文件指针仍开放）；`docs/current/technical-overview.md` 的 Windows 安装与配置
  章节改为实际契约（不再要求开发者模式）。

### 6.3 Windows 本机验收证据

命令一律使用 Node v22.19.0；安装根为独立测试根（非本机既有安装）：

| 项 | 结果 |
| --- | --- |
| `npx tsup` + schema + pi-attempt 产物 | 成功 |
| `npm run build:web`（`npm ci --prefix web` + vite build） | 成功 |
| `npx tsc --noEmit` | 通过 |
| `npx vitest run tests/platform/*.test.ts tests/configuration/file-configuration-repository.test.ts` | 11/11 通过（含 Windows 缺失指针恢复与 `syncFile` 回归用例） |
| 首次配置激活（junction 创建） | 成功，`config/active` 为 Junction |
| 连续第二次激活（替换已存在 junction） | 成功，`/api/config` 返回新 revision |
| `node dist/index.js server start` | `MetaWork Web: http://127.0.0.1:8788`；`MetaWork Server ready: \\.\pipe\metawork-gateway.sock-...` |
| `GET /`、`/assets/index-*.js`、`/assets/index-*.css`、SPA 深层路由 | 200，静态产物正确 |
| `GET /api/auth/session` | 200，下发 `anyfusion_web_session` Cookie |
| `GET /api/workspaces`、`/api/config`、`/api/config/activation-status`、`/api/config/completion`、`/api/config/revisions`、`/api/agents/readiness`、`/api/execution/tasks`、`/api/client/notifications`、`/api/ws/diagnostics` | 全部 200 |
| `GET /api/workspaces/browse`（默认目录与 `C:\...` 显式路径） | 200，盘符根、面包屑与反斜杠路径正确 |
| `POST /api/workspaces/select` | `accepted`，Windows canonicalPath 正确落库 |
| WebSocket `/ws`（Cookie + Origin 原始握手） | `101 Switching Protocols`，收到 `hello` 能力帧 |
| `node dist/index.js web`（含打开浏览器） | 输出 `#launch=` URL，浏览器进程被拉起 |
| `node dist/index.js server stop` | 已停止对应 PID |

临时脚手架（一次性配置激活脚本、原始 WS/命名管道探测脚本、npm 日志）只用于本机验收，
未提交；`dist/`、`web/dist/`、`.tmp/` 未提交。

### 6.4 未完成 / 未验收（不得视为通过）

- **Windows 原生安装的端到端验收尚未在安装器上跑通**：本机没有 staged release 的
  Planner 产物（需 `planner/AnyFusion-Pi` 构建）与 Provider 凭据，安装器的配置 probe
  因此无法通过；数据库指针、发布指针、激活 journal、恢复与回滚逻辑已实现并有专项测试
  （见 6.5），但“安装 → 更新 → 回滚”整链尚未在真实 Windows 安装上逐项签字。
- **发布隔离（第 4 节）**：未创建 tag/Release，未改造 Windows 构建与预发布流程。
- **Planner / Pi / Codex Executor 在 Windows 的原生验证**：未开始（需要 staged release 的
  Planner 产物、Provider 凭据与 bundled Node/Git 决策）。本机没有 Provider 凭据，
  官方登录也未验证。
- **macOS/Linux 合并门**：本机无 Docker，未运行 SQLite/POSIX 套件；本机改动对 POSIX 均
  为等价替换（见 6.5 的等价性说明），但必须回到主线前补齐。
- **环境阻塞**：`github.com` 在当前网络不可达，`scripts/prepare-pi-pdf.mjs` 与 better-sqlite3
  预编译包默认地址无法使用（本次用 npmmirror 二进制镜像与 Node 22 预编译包完成本机构建）。

## 7. W3 数据库文件指针设计与实施（2026-10-16，已批准并实现）

选定方案（用户已确认）：**Windows 专用目录 junction 间接层**，复用 W2 已验证的目录指针原语；
POSIX 布局、权限、符号链接语义与恢复语义完全不变。

- 路径契约：POSIX `<account>/data/anyfusion.db` → `database-revisions/<revision>.db`（相对文件符号链接）；
  Windows `<account>/data/database-current`（junction）→ `database-revisions/<revision>/`，数据库文件为
  `<account>/data/database-current/anyfusion.db`。两种平台的 journal 目标均为“相对指针父目录”的路径字符串。
- 新增模块：`src/installation/database-pointer-paths.ts`（纯路径契约，无 I/O）与
  `src/installation/database-pointer.ts`（读取/替换指针、兼容性校验、明文库→revision 转换与恢复、
  `database-pointer-migration.json` journal）。
- 事务接线：`ReleasePointerTransaction` 的 database 成员走平台指针，其余三者仍为目录指针；
  `SourceNativeInstaller` / `SourceNativeUpdater` / `ensureRevisionedDatabasePointer` /
  `AccountLayoutMigrator` / gateway journal 伴随文件 / 回滚目标解析全部改为同一组 helper。
- WAL：Windows 上活动库的 `-wal`/`-shm` 落在活动 revision 目录内，跨 revision 的 WAL 混用
  在结构上不可能；候选 revision 由 `wal_checkpoint(TRUNCATE)` 后的 SQLite backup/迁移路径产生，
  发布前清除残留 `-wal`/`-shm`。
- 中间态：Windows 无法原子替换 junction，因此“明文库 → revision 指针”的转换先落 journal；
  `recoverDatabasePointerMigration()` 按 journal 收尾或修复，Server 启动在打开数据库前同时执行
  该恢复与 prepared release 激活恢复（`recoverInstallationPointers`，POSIX 直接返回）。

### 7.1 POSIX 等价性

以下替换均为“同一语义换实现”，POSIX 分支不引入新状态：

| 位置 | 原实现 | 现实现（POSIX 分支） |
| --- | --- | --- |
| 指针读取 | `readlink` | `readDirectoryLinkTarget` / `readDatabasePointerTarget` → `readlink` |
| 目录指针替换 | `symlink(target,tmp)+rename` | `replaceDirectoryLink` → `symlink(target,tmp,'dir')+rename`（POSIX 忽略 type） |
| 数据库指针替换 | `symlink(target,tmp)+rename` | `replaceDatabasePointer` → 同上，另加一次目录 fsync |
| 明文库 → revision | copy + symlink + rename | 同一算法，增加兼容性校验与目录 fsync；journal 在 file 类型平台不写 |
| 账户布局迁移 | 无条件建库符号链接 | 仅 file 类型平台建链接（directory 类型改为普通库路径，待首次转换） |
| Server 启动 | 不做指针恢复 | `databasePointerKind()==='directory'` 时才恢复，否则零改动 |

### 7.2 迁移与兼容

不存在已发布的 Windows 安装，因此不提供 `data/anyfusion.db` → `data/database-current/anyfusion.db`
的跨版本迁移：Windows 上该旧路径只可能来自未发布的本机开发根。正式安装由
`SourceNativeInstaller` 直接创建 revision + junction；先于指针存在的普通库（例如
先 `server start` 再安装的根）由 `ensureRevisionedDatabasePointer()` 转换。

### 7.3 W2 执行器工具解析（2026-10-16，本机验证）

问题：本机已安装 `@earendil-works/pi-coding-agent` 1.2.0（`%APPDATA%\npm\pi.cmd`），但
`/api/agents/readiness` 报 `pi-agent missing / command not found`，且安装期 `detectCommand('pi')` 也为 false。
根因：解析器只在 PATH 目录里试裸名字（拿到 npm 同时写下的 POSIX sh 脚本 `%APPDATA%\npm\pi`），
随后用 `execFile` 直接执行它——Windows 无法启动 sh 脚本，ENOENT 被归类为“未安装”。

修复后实测（试用根，release `0.1.16-win-trial-3`）：

```json
{"agentId":"pi-agent","status":"installed","version":"1.2.0",
 "path":"C:\\Users\\admin\\AppData\\Roaming\\npm\\pi.cmd","managed":false}
{"agentId":"codex-cli","status":"missing","detail":"command not found"}
```

单测：`tests/utils/executor-tool-path.test.ts`（9 项：候选顺序、npm `.cmd` shim 解析为 Node 入口、
`sh` shim 解析、镜像直启、不可解析 shim 回退、缺失工具保持 ENOENT、POSIX 不改行为）。
基线对比：`tests/utils + tests/executor + tests/management` 在改动前后失败文件数 22 → 20（无新增失败）。

遗留：无 Provider 凭据时安装器按设计把所有 AgentClass 置为 disabled，因此要在 Web 设置里选择
Provider 并启用 Pi 执行器后才能真正跑任务；执行器的完整 attempt 链路（worktree/Git/交付）尚未在
Windows 上跑过真实任务。Planner 仍复用旧安装里同一份 0.80.2 已构建产物（源码重建受 canvas devDep
+ 无 Python/VS + github.com 不可达阻隔）。

### 7.4 本机验证证据（Windows，Node v22.19.0）

- `npx tsc --noEmit` 通过。
- 新增 `tests/installation/database-pointer.test.ts`（11 项，含 Windows 明文库转换、
  中断转换恢复、journal 清理、指针往返、兼容性拒绝；POSIX 分支在本机 skip、在 Docker 执行）：
  与 `tests/platform/*` 一并运行 15/16 通过，唯一失败为既有 `local-endpoint.test.ts` 的
  POSIX 路径断言（基线同样失败）。
- 基线对比（`tests/installation tests/configuration tests/platform tests/account`，
  改动前 vs 改动后，同一 Windows 环境）：**新增失败 0**，改动前失败而改动后通过的测试文件 16 个
  （均为 fsync/durability 修复的收益）。
- W2 阶段的 Server/Web 主链路（启动、命名管道、静态资源、会话、WebSocket、目录浏览、
  连续两次配置激活、`metawork web` 拉起浏览器、`server stop`）保持通过。
