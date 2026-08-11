# MetaWork Server 升级总体技术设计

Status: Revised after architecture review; Conditional Go
Design date: 2026-08-07
Approved: 2026-08-11
Last verified: 2026-08-11
Review update: 2026-08-11
Implementation gate: Phase 0 contracts, the complete schema 30-to-31 migration, database rollback, and release-signing trust model must be accepted before destructive migration or legacy-authority removal.
Scope: Server 安装、配置、Planner、Kernel、Executor、Gateway 与现有冗余收敛
Product note: AnyFusion 是公开产品名；`MetaClaw`、`metaclaw` 和 `Metaclaw*` 仍是内部运行时名称及兼容 CLI alias。本设计不在无关范围内重命名这些内部标识。

## 1. 结论

本次升级不重写现有 Task OS 控制主轴，而是在 Server 侧补齐产品化安装、统一配置和管理能力，并删除与现行架构冲突的旧入口。

保留的核心控制链为：

```text
Planner proposes
  -> ControlKernel decides
  -> Runtime applies side effects
  -> Executor Adapter transports one authorized attempt
  -> Runtime reports normalized facts
  -> ControlKernel decides the next strategic action
```

总体采用以下方案：

1. 保留 AnyFusion-Pi 代码库、独立进程和独立依赖树。
2. Planner 安装为 MetaWork 安装根目录下的子目录，不再与 MetaWork 同级。
3. 建立唯一的 Agent Configuration Store，Planner、Kernel 和 Runtime 从同一版本化配置生成各自的安全投影。
4. 将 Harness、Model、AgentClass 和 Runtime Home 分离建模。
5. 提供一句命令安装 Server、可重复执行的配置向导和 Server Admin CLI。
6. 本机 Executor 继续调用用户已经安装的 CLI，但使用 AnyFusion 独立配置和独立 Home，不读写用户的 `~/.codex`、`~/.pi`。
7. Future remote Executor 通过现有 `ExecutorAdapter` 扩展 A2A，不建立第二套调度器。
8. 删除或收敛安装、配置、路由、UI、Guidance 和 Executor 注册中的重复实现。

## 2. 需求归纳

### 2.1 安装

- 用户通过一句命令完成 MetaWork Server 安装。
- 安装过程逐步完成 Provider、Planner、Model 和 Executor 配置。
- 安装失败必须可恢复，不留下半安装状态。
- 安装不得使用 Docker。
- 安装不得安装、升级、降级、链接或重配置用户现有 Codex/Pi。
- Planner 继续复用 AnyFusion-Pi 仓库，但安装在 MetaWork 子目录。

### 2.2 安装后配置

- 用户可以在安装后重新进入配置流程。
- 配置支持推荐默认值和用户明确选择。
- Planner Harness 与 Planner Model 独立配置。
- Executor Harness 与 Executor Model 独立配置。
- 同一个本地 Harness 可以创建多个互相隔离的 AgentClass。
- 每个 AgentClass 使用独立模型策略、权限、Skill、Provider 绑定和 Runtime Home。

### 2.3 模型策略

- Planner 默认支持 `auto`，也支持用户固定模型。
- `auto` 可以根据发行区域、Provider 可用性、能力和成本策略选择推荐模型。
- 图片中提到的国际版和国内版模型名称视为候选发行配置，不作为 Core 代码硬编码常量。
- Executor 支持固定模型和 `auto`。
- Executor 的 `auto` 含义不是 Executor 自行绕过控制面选模型，而是 Planner 为具体 Subtask 提议模型，Kernel 校验授权，Runtime 注入最终模型。

### 2.4 Server 管理面

- 本次升级不涉及 Desktop Client 的设计或开发。
- 安装向导和安装后配置均由 Server Installer 与 Admin CLI 提供。
- Admin CLI 支持 Provider 验证、Planner 配置、Executor Profile 管理和运行状态检查。
- 当前 AnyFusion-Pi TUI、Gateway Client、Feishu 和 scripted session 继续作为已有访问面。
- 所有 Server 管理入口必须调用同一个 Configuration Service，不得分别修改 YAML、环境变量或 SQLite。

### 2.5 配置唯一性

- 新增一个 Executor 时只登记一次。
- Planner 不维护独立 Executor 枚举。
- Kernel 不维护另一份 Executor 定义。
- Runtime 不再维护独立 allowlist 和命令映射。
- 安装器不再维护一份与 Runtime 能力不一致的 Executor 清单。
- Planner、Kernel 和 Runtime 可以读取不同字段，但必须来自同一配置版本。

## 3. 当前架构基线

当前架构已经完成以下关键能力：

- AnyFusion-Pi 作为独立 PlanningAgent 进程运行。
- Planner 通过 Host Protocol 和 JSONL RPC 提交 `PlanningAgentPlan v7`。
- `ControlKernel` 是唯一战略决策权威。
- `DurableKernelWorkflow` 负责 inbox、decision ledger、application 和恢复。
- `ExecutionRuntime` 负责 WorkUnit、attempt、workspace、lease 和 Executor 调用。
- `ExecutorAdapter` 已提供 `execute`、`probe` 和 `abort` 稳定 seam。
- Codex/Pi 默认在独立 Git worktree 中作为本机子进程执行。
- 每次 attempt 已使用 AnyFusion 管理的 Codex/Pi 临时 Home。
- Gateway 已支持本地 Unix Socket 和 Feishu 接入。

本设计不得破坏以下边界：

- Planner 只能提案，不能授权、调度、写数据库或直接调用 Executor。
- Kernel 只能解释结构化事实，不调用外部进程或 Repository。
- Runtime 只能应用 Kernel Decision，不自行决定 retry、fallback、replan 或 park。
- Executor Adapter 只能执行单次已授权 attempt 并规范化结果。
- Gateway 和 Server Admin CLI 属于 Application Shell，不拥有 Task、Kernel 或 Executor 策略。

### 3.1 当前实现与目标设计差距

截至 2026-08-11，当前代码已经完成本机 Planner/Executor 进程隔离、
Planner nested 安装、Executor 独立 attempt Home、按用户启动目录运行
Planner，以及 `AttemptExecutionBackend` 术语收敛。但本设计描述的是 Server
升级完成后的目标架构，以下内容尚未全部实现：

| 项目 | 当前实现 | 本设计目标 |
| --- | --- | --- |
| 静态配置权威 | 安装器直接生成 `provider.env`、Planner `models.json/settings.json`、Codex `config.toml` 和 Pi `models.json/settings.json` | `ConfigurationService` 管理唯一版本化 `config.yaml`，其余 Harness 文件均为可重建的编译产物 |
| Planner/Kernel/Runtime 配置一致性 | 内置 Catalog、Planner Schema、SQLite AgentClass、Runtime allowlist 和 Adapter binding 仍有重复定义 | 三者从同一个 `ConfigurationSnapshot.revisionId` 生成安全投影 |
| Server 安装入口 | `./setup.sh` 和 macOS Node 安装器用于源码安装 | 正式一句话入口和源码入口调用同一个 Installer Core，并支持 staging、校验、原子切换与 rollback |
| 正式发布地址 | 文档中的 `https://get.metaany.ai/metawork` 仅为建议地址 | 发布域名、release manifest、checksum/signature 和 channel 机制确认后才作为正式安装契约 |

因此，本文档可作为升级实施和最终 Review 的目标技术基线，但不能被解释为
上述能力已经全部在当前安装器和 Runtime 中交付。每个实施阶段完成后必须同步
更新本节、相关 ADR、`CONTEXT.md` 和 current technical overview。

## 4. 当前问题与冗余审查

### 4.1 P0：Executor 配置不是单一事实源

当前 Executor 定义分散在以下位置：

1. `src/executor/builtin-executor-catalog.ts`
   - 内置 Codex/Pi Routing Capability、用例、affordance 和 AgentClass 默认值。
2. `src/planning/planning-agent-plan-schema.ts`
   - 再次硬编码 `codex-cli`、`pi-agent` 和 Routing Capability enum。
3. SQLite `agent_classes`
   - Kernel/Runtime 实际查询的 AgentClass 数据。
4. `src/execution/execution-runtime.ts`
   - worktree backend 再次硬编码只允许 Codex/Pi。
5. `src/executor/backend-executor-adapter.ts`
   - 再次硬编码 Codex/Pi command、args、配置文件和 Home 处理。
6. `setup.sh`
   - 仍维护 Codex、Pi、Hermes、Claude、DeepSeek TUI、OpenClaw 等安装检测选项。
7. `scripts/install-native-macos.mjs`
   - 单独生成 Planner、Codex 和 Pi 模型配置模板。

内置 Codex/Pi 会从同一 TypeScript Catalog seed 到 SQLite，因此不是完全无关的两套配置；但是从“新增 Executor”的角度，仍需要同步修改多处代码和模板，存在明确漂移风险。

当前直接后果：

- 数据库中注册一个自定义 AgentClass 后，Planner Schema 仍无法输出该名称。
- Planner Catalog 只暴露内置 Executor，不会自动读取完整 AgentClass 定义。
- worktree Runtime 即使查到新 AgentClass，也会被硬编码 allowlist 拒绝。
- `AgentClass.model` 虽已持久化，但没有形成有效的 Planner/Kernel/Runtime 模型选择协议。

### 4.2 P0：安装逻辑分裂

`setup.sh` 当前存在两条不同产品路径：

- macOS 立即委托新的 Node 安装器；
- 非 macOS 继续执行旧 Bash 安装和 Executor 选择逻辑。

两条路径在以下方面不一致：

- 安装目录；
- 配置文件位置；
- Executor 支持范围；
- 是否交互选择默认 Executor；
- 是否使用旧 `executor.command`；
- 是否支持已被 Runtime 拒绝的自定义本机 CLI。

这会造成“安装器显示支持，但 Runtime 无法执行”的假能力。

### 4.3 P0：配置介质过多

当前配置同时来自：

- `config.yaml`；
- `provider.env`；
- Planner `models.json` / `settings.json`；
- Codex `config.toml`；
- Pi `models.json` / `settings.json`；
- 大量 `METACLAW_*` / `ANYFUSION_*` 环境变量；
- SQLite `agent_classes`；
- Docker 配置模板。

这些介质中有些是合法的最终渲染产物，但目前缺少一个明确的 Configuration Compiler 和配置 revision。调用方难以判断哪个位置是权威来源。

### 4.4 P0：`executor.command` 已失去路由权威

`Config.executor.command` 仍存在并默认为 `codex`，但实际 dispatch 已由 Work Graph、AgentClass、Kernel 和 ExecutorRegistry 决定。

该字段目前主要服务旧展示、timeout 配置和历史 smoke 模板。继续保留会让用户误以为系统只有一个全局默认 Executor。

建议：

- 删除 `executor.command`。
- timeout/max duration 迁入 runtime policy。
- 默认 AgentClass 或模型偏好迁入 Agent Configuration Store。

### 4.5 P0：`AgentClass.model` 是未完成配置

AgentClass 已包含 `harness` 和 `model` 字段，但：

- Built-in AgentClass 的 `model` 均为 `null`；
- Planner Plan 不携带模型选择；
- Kernel 不校验 AgentClass/Model tuple；
- Executor args 没有统一从 Model Profile 生成；
- 安装器直接改写各 Harness 私有配置。

因此当前字段是展示数据，不是完整控制契约。

### 4.6 P1：Executor 注册向导与真实 Runtime 冲突

`ExecutorAdminService` 仍可创建自定义 AgentClass，并要求 Docker image、immutable image ID、permission profile、command 和 args。

但当前：

- 命令树已隐藏 `/executor register wizard`；
- worktree backend 只允许 canonical Codex/Pi；
- Planner Schema 只允许 canonical Codex/Pi；
- 注册后的自定义 AgentClass 不能完整进入 Planner -> Kernel -> Runtime 主链。

该向导属于半失效生产实现。应由新的 Agent Configuration Service 和 Server Admin CLI Profile 管理替代。

### 4.7 P1：`BackendExecutorAdapter` 职责过重

当前一个类同时负责：

- worktree/container backend 差异；
- Codex/Pi Harness 命令构造；
- Provider env 读取；
- Attempt Model Gateway；
- Codex/Pi Home materialization；
- execution backend lifecycle；
- probe；
- result collection；
- failure normalization。

这会阻碍：

- 同一 Harness 多个独立 AgentClass；
- 不同模型策略；
- A2A remote Executor；
- backend-specific 测试；
- 配置 revision 审计。

### 4.8 P1：Composition Root 重复装配

`src/index.ts` 分别为默认 Planner TUI、Gateway、script 和 standby Ink TUI 创建 Session、Gateway、timer 和 shutdown 生命周期。

重复装配导致：

- 生命周期逻辑难以验证；
- 新增 Server 管理入口时会再复制一条分支；
- Gateway session 和 interactive session 的行为容易漂移。

### 4.9 P1：Guidance/Orchestration 仍保留影子调度语义

`OrchestrationEngine`、`GuidancePolicyEngine` 和 `TaskSignalService` 仍包含主动建议、优先级和 next-task 语义。

当前产品边界已经是：

- 自然语言语义归 Planner；
- 战略授权归 Kernel；
- 单活跃顶层 Task；
- 多 Task 优先级和公平性属于未来路线图。

因此旧 Guidance 中的主动调度解释与 Planner/Kernel 存在职责重叠。

建议：

- 保留纯展示型恢复提示；
- 删除主动评分、next-task suggestion 和隐式 preemption 语义；
- 不建立新的 Guidance 策略模块替代它。

### 4.10 P1：Feishu 通知与 Gateway Delivery 重叠

当前同时存在：

- `notifications.feishu` webhook notifier；
- Gateway Feishu adapter；
- Gateway home channel notifier；
- Gateway Delivery Router。

如果产品仍需要 webhook-only 通知，可以保留其 transport adapter；但消息格式、目标解析和完成事件分发应统一进入 Delivery port，不应保留两套业务投递决策。

### 4.11 P1：结构化 UI 投影尚未统一

当前 TUI、Feishu 和 Gateway Client 仍有部分逻辑依赖文本行和格式前缀。Server 应建立 versioned View Event / ViewModel：

```text
Session domain fact
  -> Presentation projection
  -> Client Gateway event
  -> CLI / TUI / Feishu renderer
```

### 4.12 P2：多个本地 UI

当前存在：

- AnyFusion-Pi native TUI：默认本地表面；
- `src/gateway/client-ui.tsx`：连接 Gateway 的 Ink client；
- `src/tui/app.tsx`：standby Ink UI。

根据现有仓库约束，本轮不得直接删除 standby Ink UI。升级步骤应为：

1. 冻结 standby Ink UI，不增加新功能；
2. 完成 Server 安装、配置和默认 AnyFusion-Pi TUI 的稳定性验收；
3. 单独提交 ADR/retirement plan；
4. 再决定删除还是保留诊断模式。

### 4.13 P2：测试保活或无有效交付路径的模块

以下内容需要在实施前通过生产调用图和行为测试再次确认：

- `GuidanceRepo` 当前主要由专用测试保活；
- `task-execution-planner.ts` 当前只通过 session helper export 暴露；
- skill install/update 审计仍存在，但当前 Executor 已不支持实际安装；
- 旧 Dashboard/Guidance acceptance tests 可能只保活 standby UI 行为。

清理原则：

- 删除生产实现时同步删除只验证旧实现的测试；
- 不为了旧测试继续保留无生产调用的模块；
- 不删除 Kernel ledger、attempt receipt、outbox、publication、lease 等可靠性事实。

### 4.14 P1：Planner 进程生命周期重复

当前非交互 Planner turn 使用 `PlannerProcessRunner`，默认本机 TUI 使用
`runPlannerTuiProcess`。两条路径分别构造 command、args、environment、
Home、session 和 process cleanup，存在协议和隔离行为漂移风险。

建议：

- 收敛为进程内 `PlannerProcessSupervisor`；
- 统一 interactive 与 RPC 的 bootstrap、probe、timeout、shutdown；
- 将 `PlannerTuiBridge` 的目标职责命名为 `PlannerHostBridge`；
- 明确 Supervisor 和 Bridge 都属于 MetaWork Server 进程；
- AnyFusion-Pi 保持唯一独立 Planner 子进程，不并入 Server 进程。

## 5. 目标总体架构

```text
                           MetaWork Server

  One-line Server Installer                 Admin CLI
                 |                              |
                 +----> Configuration API <-----+
                                |
                                v
                    Agent Configuration Store
                    one revisioned source of truth
                                |
             +------------------+------------------+
             |                  |                  |
             v                  v                  v
       Planner-safe       Kernel-safe        Runtime-private
         Catalog           Projection           Binding
             |                  |                  |
             v                  v                  v
       AnyFusion-Pi       ControlKernel      ExecutionRuntime
       Planner process          |                  |
             |                  |          Executor Gateway
             |                  |          / Adapter Registry
             |                  |           |             |
             +-- proposal ------+      Local CLI       Future A2A
                                      Codex / Pi      Remote Executor

  Client Gateway
  CLI / TUI / local socket / Feishu / future HTTP-WebSocket
              |
              v
        MetaclawSession
              |
              +---- Planner Host Bridge
              +---- DurableKernelWorkflow
              +---- Delivery / View Events
```

架构上增加两个逻辑平面：

1. Configuration Control Plane
   - 安装后唯一的静态配置权威。
2. Connectivity Plane
   - 统一 Client、Planner 和 Executor transport，但不拥有调度策略。

现有 Control Plane 保持不变：

- Planner proposal；
- Kernel authorization；
- Runtime side effects；
- normalized facts；
- durable recovery。

### 5.1 进程边界

默认交互模式只有两个主要操作系统进程：

```text
Process 1: MetaWork Server
├── MetaclawSession
├── PlannerProcessSupervisor
├── PlannerHostBridge
├── ControlKernel
├── ExecutionRuntime
└── ClientGateway
          |
          | Unix socket / JSONL RPC
          v
Process 2: AnyFusion-Pi Planner
└── user-visible native TUI / Planner model loop
```

`MetaclawSession`、`PlannerProcessSupervisor` 和 `PlannerHostBridge` 都是
MetaWork Server 进程内组件，不是独立进程。用户执行 `anyfusion` 时先启动
MetaWork Server；Server 完成数据库、Kernel、Runtime 和 Gateway 初始化后，
再启动受控的 AnyFusion-Pi 子进程。默认前台终端由 AnyFusion-Pi 原生 TUI
占用，但 Proposal validation、Kernel authorization 和 Executor dispatch 仍由
MetaWork Server 完成。

交互模式使用一个持续运行的 AnyFusion-Pi TUI 子进程。Feishu、Gateway 和
scripted session 使用短生命周期 RPC Planner 子进程，每个 planning turn 完成后
退出，但复用 `data/planner-sessions/` 下的持久会话。两个模式共用
`PlannerProcessSupervisor` 的环境构建、协议检查、Home、session 和进程清理
逻辑，避免维护两套 spawn 路径。

## 6. 安装与目录布局

### 6.1 一句命令安装 Server

正式发行建议提供：

```bash
curl -fsSL https://get.metaany.ai/metawork | sh
```

该 URL、签名体系和发布域名在实施前确认。Core 设计不依赖具体域名。

对于源码开发继续支持：

```bash
./setup.sh
```

两条入口必须调用同一个 Installer Core，不得维护两套行为。

### 6.2 安装阶段

```text
bootstrap
  -> preflight
  -> resolve release manifest
  -> download to staging
  -> verify checksum/signature
  -> acquire update lock and quiesce Server
  -> checkpoint WAL and snapshot the database when migration is required
  -> install MetaWork runtime
  -> install/update nested AnyFusion-Pi
  -> detect existing Harness commands
  -> run configuration wizard
  -> compile runtime homes/config
  -> migrate database and durable contract payloads
  -> doctor
  -> atomically activate release
  -> restart/reconnect Server
  -> run release health check
```

安装器要求：

- 幂等；
- 可重复执行；
- staging + atomic rename/symlink；
- 保留上一版用于 rollback；
- 不在验证完成前切换 current release；
- 不读取或修改用户个人 Codex/Pi 配置；
- 不在安装期间运行真实任务；
- Provider probe 使用明确的最小验证调用；
- 所有包含秘密的文件 mode 为 `0600`；
- 可在非交互环境通过参数或 env 完成。
- 同一安装根同一时间只允许一个 install/update/rollback transaction；
- update 必须阻止新 Task admission，并等待可中断 attempt 排水；不可中断
  attempt 存在时 fail closed；
- 数据库 migration、程序 release 和配置 revision 必须共享一份 activation
  journal，崩溃恢复不得留下混合版本；
- health check 失败时，只有数据库、程序和配置均可恢复到兼容组合才允许自动
  rollback。

### 6.3 目录布局

建议布局：

```text
~/.anyfusion/
├── app/
│   ├── current -> releases/<release-id>/
│   └── releases/
│       └── <release-id>/
│           ├── dist/
│           ├── node_modules/
│           ├── package.json
│           ├── release-manifest.json
│           └── planner/
│               ├── packages/
│               ├── node_modules/
│               └── package.json
├── config/
│   ├── active -> revisions/<revision-id>/
│   ├── revisions/
│   │   └── <revision-id>/
│   │       ├── config.yaml
│   │       ├── planner-view.json
│   │       ├── kernel-view.json
│   │       └── runtime-view.json
│   └── secrets/
├── data/
│   ├── metaclaw.db
│   ├── configuration-revisions/
│   ├── planner-sessions/
│   └── execution-workspaces/
├── generated/
│   └── agent-runtime/
│       └── <revision-id>/
│           ├── planner/
│           └── executors/
├── tmp/
│   └── attempts/
├── logs/
└── cache/

~/.local/bin/
└── anyfusion
```

关键约束：

- `<release-id>/` 本身就是 MetaWork Server release 根目录，不再增加
  `metawork/server/` 层级。
- Planner 直接安装在 `<release-id>/planner/`；该目录本身就是
  AnyFusion-Pi checkout/build 根目录，不再增加 `planner/AnyFusion-Pi/`
  重复层级。
- Planner 与 MetaWork 仍是两个 Node 进程和两个 dependency tree。
- 程序 release、configuration、durable data、generated artifact、temporary
  attempt、workspace 和 cache 明确分离。
- `config/revisions/<revision-id>/` 和
  `generated/agent-runtime/<revision-id>/` 均不可变；`config/active` 是唯一
  原子切换指针。
- `generated/agent-runtime/<revision-id>/<kind>/<agent-class-id>` 是从指定
  配置 revision 编译出的 AgentClass 运行模板，不是第二个配置源。
- 每次 attempt 从模板生成 `tmp/attempts/<attempt-id>/home/` 私有 Home。
- `data/execution-workspaces/` 存放 Task/Subtask 隔离工作副本，不是用户原始
  项目目录，也不限制 Planner 的启动目录。
- `~/.local/bin/anyfusion` 只是 launcher；Installer 必须检测 PATH 中已有的
  `anyfusion`，不得静默覆盖不属于本次安装的命令。

`~/.local/share` 不是强制安装位置。开发环境可通过
`ANYFUSION_INSTALL_ROOT` 覆盖 `~/.anyfusion`，但目录关系保持一致。

### 6.4 更新

提供：

```bash
anyfusion update
anyfusion update --channel stable
anyfusion update --channel preview
anyfusion rollback
```

更新 MetaWork 和 Planner 时使用一份 release manifest：

```yaml
releaseId: 1.3.0
channel: stable
platform: darwin
arch: arm64
minimumNodeVersion: 22.19.0
metawork:
  source: ...
  revision: ...
planner:
  source: ...
  revision: ...
compatibility:
  configurationSchema: 2
  plannerHostProtocol: 2
  planningPlanSchema: 8
  workGraphSchema: 7
  kernelDecisionSchema: 6
  databaseSchema: 31
artifacts:
  metawork:
    url: ...
    sha256: ...
  planner:
    url: ...
    sha256: ...
signature:
  algorithm: ed25519
  keyId: release-2026-01
  value: ...
```

Planner 不再独立跟随一个未受控 branch；release manifest 固定兼容 revision。
manifest 必须由 bootstrap 内置信任根验证；只校验 artifact checksum 不构成
发布身份验证。信任模型必须定义 key rotation、revocation、channel 分离和
过期策略。bootstrap 脚本自身必须通过 HTTPS 加 sidecar signature/checksum
或等价的受控发布机制验证，不得把首次下载内容直接当作信任根。

## 7. 单一 Agent Configuration Store

### 7.1 原则

新增 Executor 只能通过一个权威定义进入系统：

```text
Agent Configuration Store
  -> Planner Catalog Projection
  -> Kernel Authorization Projection
  -> Runtime Binding Projection
  -> Installer/Admin CLI View
```

禁止：

- Planner Schema 独立硬编码 Executor 名称；
- Kernel 维护另一份 AgentClass 定义；
- Runtime 使用名称 allowlist 判断可执行类型；
- Adapter 通过名称 if/else 推断 Harness；
- Installer 维护未从 Registry 生成的 Executor 列表；
- 模型模板成为事实源；
- UI 直接写 SQLite 或多个配置文件。

### 7.2 权威介质

第一阶段以 `~/.anyfusion/config/active/config.yaml` 为当前静态配置权威；
`active` 原子指向一个不可变 revision directory。

要求：

- `ConfigurationService` 是唯一读写 facade；
- Admin CLI 和 Installer 只能调用 ConfigurationService；
- 启动时解析、严格校验并生成 immutable `ConfigurationSnapshot`；
- 每个 snapshot 有 `revisionId` 和内容 hash；
- Planner、Kernel 和 Runtime 在一个 planning/execution cycle 内使用同一 revision；
- Runtime 将 revisionId 写入 Planner run、Kernel Decision 和 Attempt Receipt；
- SQLite 保存 revision audit 和动态运行事实，不反向成为第二套静态定义；
- secrets 单独保存，只通过 secret reference 进入 Runtime-private projection。

后续若改为数据库权威，需要 ADR；不得让 YAML 和数据库同时可写。

### 7.3 配置模型

```yaml
schemaVersion: 2

providers:
  openai-international:
    protocol: openai-compatible
    baseUrl: https://example.com/v1
    apiKeyRef: keychain:anyfusion/openai-international
    region: international
    enabled: true

models:
  planner-best-international:
    providerRef: openai-international
    modelId: release-resolved-model-id
    capabilities: [planning, structured-output, long-context]
    reasoning: high
    enabled: true

  engineering-fast:
    providerRef: openai-international
    modelId: release-resolved-model-id
    capabilities: [coding, tools]
    reasoning: medium
    enabled: true

harnesses:
  anyfusion-pi:
    kind: planner
    transport: local-process
    commandRef: release:planner
    adapter: anyfusion-planner-host-v2
    enabled: true

  codex-cli:
    kind: executor
    transport: local-cli
    command: codex
    adapter: codex-cli
    enabled: true

  pi-cli:
    kind: executor
    transport: local-cli
    command: pi
    adapter: pi-cli
    enabled: true

agentClasses:
  planner-default:
    kind: planner
    harnessRef: anyfusion-pi
    modelPolicy:
      mode: auto
      allowedModelRefs:
        - planner-best-international
    generatedRuntimeRef: planner-default
    enabled: true

  codex-engineering:
    kind: executor
    harnessRef: codex-cli
    routingCapabilities: [workspace-engineering]
    modelPolicy:
      mode: auto
      allowedModelRefs:
        - engineering-fast
    permissionProfileRef: workspace-engineering
    generatedRuntimeRef: codex-engineering
    enabled: true

  codex-review:
    kind: executor
    harnessRef: codex-cli
    routingCapabilities: [workspace-engineering]
    modelPolicy:
      mode: fixed
      modelRef: planner-best-international
    permissionProfileRef: restricted-custom
    generatedRuntimeRef: codex-review
    enabled: true
```

### 7.4 Harness、Model、AgentClass、WorkUnit

#### Harness Definition

描述“怎么运行”：

- local process；
- local CLI；
- container compatibility；
- A2A remote；
- command、protocol、adapter factory；
- probe、abort、continuation 能力。

Harness 不拥有：

- Task 语义；
- AgentClass 路由能力；
- retry/fallback；
- Provider secret。

#### Model Profile

描述“调用哪个模型”：

- Provider reference；
- model ID；
- region；
- capability tags；
- context limit；
- reasoning level；
- cost/latency tier；
- structured output/tool support。

Model Profile 不绑定具体 Harness，除非声明 compatibility constraint。

#### AgentClass Definition

描述一个可被 Planner 和 Kernel 路由的配置模板：

- kind；
- Harness reference；
- Routing Capability；
- Model Policy；
- permission profile；
- Skills/MCP/plugins；
- runtime home；
- enable/disable；
- rollout policy。

同一 Harness 可以被多个 AgentClass 复用，但每个 AgentClass 配置、Home 和模型策略独立。

#### Permission Profile

Permission Profile 不是任意 YAML 策略脚本。其语法、默认值、风险等级和可授权
能力由 Resource/Kernel 侧的版本化代码契约定义；Configuration Store 只能：

- 引用内置且在 Routing Catalog 注册的 profile；
- 在 schema 明确允许的范围内参数化；
- 为 profile 绑定静态资源和能力约束。

Configuration Service 不解释或扩展权限规则。配置不得创建新的决策语义、绕过
Resource claim、扩大 Kernel 已知权限或把 Runtime elevation 变成自由字符串。
新增 permission grammar 必须先修订 ADR-0024 或新增安全 ADR。

#### WorkUnit

继续表示一个动态运行实例：

- claim；
- state；
- heartbeat；
- lease；
- attempt ownership。

WorkUnit 不进入静态配置 Store。

### 7.5 三种投影

#### Planner-safe Projection

允许字段：

- AgentClass ID；
- Routing Capability；
- primary/avoid use cases；
- Planner-visible affordance；
- allowed model profile 的安全标签；
- fixed/auto 模式；
- enabled 和当前安全健康摘要。

禁止字段：

- API key；
- raw endpoint credential；
- runtime command；
- host path；
- Docker image secret；
- A2A auth token。

#### Kernel-safe Projection

允许字段：

- AgentClass ID；
- Routing Capability；
- enabled/disabled；
- permission/risk class；
- authorized model profile set；
- static transport class；
- dynamic health/status；
- retry/continuation support facts。

Kernel 仍不读取：

- command；
- credentials；
- raw probe logs；
- Repository。

#### Runtime-private Projection

允许字段：

- command/args；
- adapter factory key；
- model/provider binding；
- credential reference；
- runtime home template；
- transport endpoint；
- timeout；
- execution backend / permission profile binding。

Runtime-private projection 不传给 Planner。

## 8. Planner、Kernel 与模型选择协议

### 8.1 Planner 模型

Planner AgentClass 的模型策略：

```yaml
modelPolicy:
  mode: auto | fixed
```

`fixed`：

- 用户指定一个 Model Profile；
- ConfigurationService 在启动前验证 Harness compatibility。

`auto`：

- 根据用户配置区域、Provider 健康、Planner capability 和发行推荐顺序解析；
- 每次 Planner turn 开始前解析为确定 Model Profile；
- 将 resolved model 和 configuration revision 写入 Planner run audit；
- 不允许 Planner 进程自行扫描用户个人模型配置。
- 本 turn 内不得再次静默切换模型。

`fixed` 模型不可用时，Planner turn 失败并返回结构化错误。除非用户显式配置
fallback policy，否则不得自动改用其他模型。

### 8.2 Executor 模型

Executor `auto` 采用“Planner 提议、Kernel 授权、Runtime 执行”：

```text
Planner:
  propose AgentClass + Model Profile preference

Kernel:
  validate tuple against one ConfigurationSnapshot

Runtime:
  inject exact model into isolated attempt home/args
```

如果 Planner 只选择 AgentClass 而没有明确模型提议，Kernel 可以按照
AgentClass 已配置的确定性顺序解析：

```text
Planner valid proposal
  -> AgentClass defaultModelRef
  -> first available allowed model
  -> waiting_for_availability
```

这不是 Kernel 重新解释自然语言，而是对静态配置进行确定性授权。

不得采用：

- Executor 在启动后自由选择任意模型；
- Adapter 根据自然语言重新判断模型；
- Runtime 未经 Kernel 授权替换模型；
- fallback AgentClass 复用未经授权的原模型。

模型 fallback 必须显式配置，并由 Adapter 先上报 normalized failure fact，
再由 Kernel 产生新的 Decision 和 attempt。Runtime 或 Adapter 不得在同一个
attempt 内隐藏切换模型。`fixed` 默认禁用 fallback。

### 8.3 Contract 升级

当前 Work Graph 只记录：

```text
preferredAgentClassList
```

目标 Planner contract 应表达 AgentClass 与模型提议：

```ts
interface ProposedExecutorBinding {
  agentClassRef: string;
  modelSelection:
    | { mode: 'fixed-by-agent-class' }
    | { mode: 'proposed'; modelRef: string; reason: string }
    | { mode: 'agent-class-default' };
}
```

Kernel Decision 固化完整授权绑定：

```ts
interface AuthorizedExecutorBinding {
  agentClassRef: string;
  harnessRef: string;
  modelRef: string;
  permissionProfileRef: string;
  configurationRevision: string;
}
```

Runtime 只接受 `AuthorizedExecutorBinding`，不接受 Planner 原始模型提议。

一个 Work Graph generation 在创建时固定一个 `configurationRevision`。该
generation 的 Planner proposal、所有 Work Graph revisions、Kernel
decisions、deferred availability proposal、dispatch、retry/fallback attempt、
recovery packet 和 receipt 必须全部引用该 revision。配置激活只影响后续
generation；若当前 Task 需要采用新配置，必须由 Kernel 产生显式 replan 并
创建新 generation，不能在原 generation 内混用。

attempt identity 必须包含完整 authorized binding fingerprint，至少覆盖：

```text
generationId
subtaskId
agentClassRef
harnessRef
modelRef
permissionProfileRef
configurationRevision
attempt kind
```

同一 AgentClass 内切换模型属于新的 Kernel-authorized attempt，不得被
AgentClass-only 的历史去重逻辑吞掉。

建议：

- `PlanningAgentPlan v8`；
- `Work Graph v7`；
- Kernel event/snapshot/decision 是否升级版本由 ADR 评估；
- 不在 v7/v6 上增加未版本化字段；
- pre-release 只支持一次明确迁移，不增加双读兼容路径。

Kernel admission 需要校验：

- AgentClass 是否存在并 enabled；
- Model Profile 是否存在并 enabled；
- Model 是否在 AgentClass allowed set；
- Harness 是否支持该 Model Profile；
- required capabilities 是否覆盖；
- permission profile 是否匹配；
- AgentClass/Model 当前是否可用；
- fallback tuple 是否完整有序。

Planner JSON Schema 只负责结构校验，AgentClass/Model reference 使用普通受限
字符串；具体 ID 是否存在、enabled、兼容以及是否属于该 revision，由 catalog
semantic validation 完成。不得同时宣称使用运行时动态枚举，又只发布一个与
revision 无关的静态 schema 文件。若未来选择 revision-specific schema，schema
路径和 hash 必须进入 Planner launch binding 和 release/debug receipt。

### 8.4 健康事实

静态配置与动态健康必须分离：

```text
Configuration Store:
  what is configured and authorized

Kernel Executor Status:
  whether the class currently works

Provider/Model Status:
  whether a provider/model is currently reachable
```

Planner 看到的是同一 AgentClass 定义加安全健康投影，而不是另一份配置。

动态健康至少区分：

```text
AgentClass Status:
  configuration/adapter/class-wide availability

Provider Status:
  authentication, endpoint, region and rate-limit availability

Model Status:
  model-specific reachability, capability mismatch and temporary degradation
```

健康 identity 必须包含 `configurationRevision`，Model 状态还必须包含
`providerRef` 和 `modelRef`，或使用不可变 binding fingerprint，避免同名配置
修改后继承旧健康状态。

normalized failure fact 的 scope 扩展为：

```text
attempt | task | agent_class | provider | model
```

Provider/Model 状态由 Kernel-owned projection 根据 attempt facts 和显式 probe
facts 更新并持久化。Runtime 只能上报和持久化规范化事实，不能直接选择
fallback、重置熔断或改变健康策略。恢复事件必须携带 health identity 和 probe
generation，防止旧 probe 覆盖新状态。

## 9. Configuration Service

### 9.1 公开接口

建议逻辑接口：

```ts
interface ConfigurationService {
  getActiveSnapshot(): Promise<ConfigurationSnapshot>;
  createDraft(input: CreateDraftInput): Promise<ConfigurationDraft>;
  validateDraft(id: string): Promise<ValidationReport>;
  compileDraft(id: string): Promise<CompilationReport>;
  probeDraft(id: string): Promise<ProbeReport>;
  activateDraft(id: string): Promise<ConfigurationSnapshot>;
  rollback(revisionId: string): Promise<ConfigurationSnapshot>;
  diff(leftRevisionId: string, rightRevisionId: string): Promise<ConfigurationDiff>;
  getPlannerProjection(revisionId: string): PlannerAgentCatalog;
  getKernelProjection(revisionId: string): KernelAgentCatalog;
  getRuntimeBinding(agentClassId: string, modelProfileId: string, revisionId: string): RuntimeBinding;
  exportRedacted(): unknown;
}
```

实现要求：

- draft -> validate -> compile -> probe -> activate 生命周期；
- optimistic concurrency；
- immutable revision directory；
- 单一 active pointer 的 atomic replace；
- durable activation journal 和 crash recovery；
- schema validation；
- referential integrity；
- redacted diff；
- audit revision；
- secret reference validation；
- probe 与 apply 分离；
- apply 后失败可 rollback。

配置激活顺序固定为：

```text
acquire activation lock
  -> write and fsync staging revision
  -> compile immutable projections and generated runtime
  -> validate hashes and secret references
  -> rename staging to final immutable revision directory
  -> persist prepared activation journal
  -> atomically replace the single active pointer
  -> fsync parent directory
  -> persist committed activation journal
```

进程启动时必须恢复或隔离未完成的 journal。`active` pointer 是生效 revision
的唯一判据；pointer 指向不存在、hash 不匹配或 projection 不完整时进入
recovery-blocked，不得猜测回退。旧 revision 和 generated runtime 在 Planner
turn、Work Graph generation、deferred recovery、decision、dispatch 或 attempt
仍引用时不得删除。

### 9.2 CLI

建议命令：

```text
anyfusion setup
anyfusion configure
anyfusion configure planner
anyfusion config show|validate|diff|history|rollback
anyfusion provider list|add|edit|test|remove
anyfusion model list|add|edit|test|remove
anyfusion executor list|show|add|edit|enable|disable|remove|test
anyfusion planner show|configure|test
anyfusion doctor
anyfusion status
anyfusion config export --redacted
```

命令只调用 Configuration Service，不直接修改 YAML、env 或 SQLite。

自动化部署支持：

```text
anyfusion config apply --file server-config.yaml --non-interactive
```

### 9.3 配置变更语义

- 修改 Planner 配置：下一个 turn 生效，不中断当前 turn。
- 修改 Executor AgentClass：只影响新 Work Graph generation；现有 generation
  的新 attempt、retry、fallback 和 recovery 继续使用其固定 revision。
- 希望运行中 Task 使用新配置时，必须显式触发 Kernel replan，生成绑定新
  revision 的新 generation。
- 配置中的 disable 只影响新 generation。需要立即阻止旧 generation 新
  dispatch 时，使用独立、持久、可审计的 operational deny，由 Kernel 决定
  cancel、block 或 replan，不修改历史 immutable revision。
- 删除被 Task/receipt 引用的配置：只允许 tombstone，不物理删除历史定义。

### 9.4 Server 管理 API

本轮只在 Server 侧实现版本化 API，不开发 Desktop Client：

```text
GET  /api/v1/config/active
GET  /api/v1/config/revisions
GET  /api/v1/config/revisions/:id
POST /api/v1/config/drafts
PUT  /api/v1/config/drafts/:id
POST /api/v1/config/drafts/:id/validate
POST /api/v1/config/drafts/:id/probe
POST /api/v1/config/drafts/:id/activate
POST /api/v1/config/rollback

GET  /api/v1/providers
POST /api/v1/providers/:id/test
GET  /api/v1/models
GET  /api/v1/harnesses
GET  /api/v1/agent-classes
POST /api/v1/agent-classes/:id/probe
GET  /api/v1/server/health
```

API 只返回脱敏数据。默认通过本地 Unix socket 暴露；可选 HTTP 管理面必须
显式启用，默认绑定 loopback，并配置 TLS、认证、审计、rate limit 和 replay
防护。Secret 字段只允许写入，不允许回读。

配置生效结果必须明确区分：

```text
activated
activated_restart_required
saved_as_draft
rejected
```

## 10. Connectivity Plane

Gateway 是逻辑连接平面，不是统一业务控制器。

### 10.1 Client Gateway

承接：

- CLI/TUI；
- local Unix Socket；
- Feishu；
- future HTTP/WebSocket；
- future remote-client ingress；具体 A2A ingress 不在本轮定义。

职责：

- auth；
- session binding；
- input normalization；
- attachments；
- progress/final delivery；
- versioned View Events。

### 10.2 Planner Host Bridge

承接：

- AnyFusion-Pi TUI；
- non-interactive Planner RPC；
- proposal submit；
- read-only projection；
- command completion；
- idempotency/turn lock。

`PlannerHostBridge` 是 MetaWork Server 进程内的本地 Application-Shell
adapter，不是独立进程，也不是拥有业务策略的通用 Gateway。它通过 mode
`0600` Unix socket 为受控 AnyFusion-Pi 进程提供 bounded host capabilities。

`PlannerProcessSupervisor` 统一当前 `PlannerProcessRunner` 与
`runPlannerTuiProcess` 的重复生命周期逻辑，对外提供：

```text
startInteractive()
runRpcTurn()
probe()
stop()
```

它统一 command、args、cwd、environment、Planner Home、session、schema、
timeout 和 cleanup。用户执行 `anyfusion` 时先启动 MetaWork Server，再由
Supervisor 启动 release 内 `planner/` 的 AnyFusion-Pi 子进程；用户看到的前台
界面是 AnyFusion-Pi TUI，但控制权仍在 MetaWork Server。

保持禁止：

- database mutation；
- direct Kernel call；
- direct Executor call；
- scheduling；
- artifact publication。

### 10.3 Executor Gateway

基于：

```text
ExecutionRuntime
  -> ExecutorRegistry
  -> ExecutorAdapter
```

目标 Adapter：

```text
LocalCliExecutorAdapter
  -> Codex Harness
  -> Pi Harness

ContainerCompatibilityAdapter

A2AExecutorAdapter  # future, not delivered by this plan
  -> remote Executor
```

本轮只验证 `ExecutorAdapter` 和 authorized attempt envelope 是
transport-neutral，不创建 A2A production adapter 或配置分支。未来 A2A Adapter
只负责 transport mapping、probe、stream/poll、cancel、artifact reference 和
failure normalization。

Planner 不直接调用 A2A Executor。正确路径仍是：

```text
Planner -> Kernel -> Runtime -> A2AExecutorAdapter
```

## 11. Executor Adapter 重构

建议拆分：

```text
ExecutorRegistry
  -> HarnessAdapterFactory
      -> LocalCliExecutorAdapter
      -> ContainerExecutorAdapter
      -> A2AExecutorAdapter  # future follow-up

LocalCliExecutorAdapter
  -> HarnessCommandBuilder
  -> RuntimeHomeMaterializer
  -> AttemptModelGateway
  -> AttemptExecutionBackend
  -> ResultNormalizer
```

术语约束：

- `AttemptExecutionBackend` 是统一执行载体 seam，worktree 与 container 都实现它；
- worktree backend 是受信任的本机子进程，不称为 sandbox；
- sandbox 只用于 Docker 容器隔离、Codex nested sandbox 和明确的安全策略；
- schema v30 的 `attempt_sandboxes`、`sandbox_container_id`、`sandbox_lost`
  暂不改名，避免为术语调整引入 v31 迁移；Repository 层负责隔离这些
  legacy physical names。

Codex/Pi 差异下沉到 Harness driver：

```ts
interface HarnessDriver {
  readonly id: string;
  probe(binding: RuntimeBinding): Promise<ExecutorProbeResult>;
  materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome>;
  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec;
  parseResult(input: HarnessResultInput): ExecutorResult;
}
```

新增 Harness 时：

1. 注册 Harness driver；
2. 在唯一配置 Store 增加 Harness Definition；
3. 创建 AgentClass；
4. Planner/Kernel/Runtime projection 自动生成；
5. 不修改 Planner schema enum 或 Runtime name allowlist。

## 12. Runtime Home 隔离

每个 AgentClass 必须有独立的 generated runtime 模板：

```text
generated/agent-runtime/
├── planner/
│   └── planner-default/
└── executors/
    ├── codex-engineering/
    ├── codex-review/
    └── pi-research/
```

每个 attempt 再生成私有 Home：

```text
tmp/attempts/<attempt-id>/
├── home/
│   ├── config rendered from exact configuration revision
│   ├── session
│   └── model binding
├── environment.json
├── receipt.json
└── logs/
```

约束：

- `generated/agent-runtime/` 是可重建的 Configuration Compiler 产物，不是
  用户直接维护的配置，也不是第二套静态配置；
- Codex 设置独立 `CODEX_HOME`；
- Pi 设置独立 `HOME`、`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`；
- Planner 设置独立 Planner Home 和 Session Directory；
- child `cwd` 仍是 Task-owned worktree；
- Home 和 worktree 是两个不同 path contract；
- 同一 Harness 的两个 AgentClass 不共享 session、settings 或 provider file；
- attempt 完成后按 retention policy 清理临时 Home；
- 用户 `~/.codex`、`~/.pi` 永远不是 fallback。
- `environment.json`、receipt 和日志必须脱敏，scoped credentials 只在启动
  attempt 前解析并注入授权子进程。

## 13. View Event 与现有访问面协议

建议引入结构化事件：

```ts
type ClientViewEvent =
  | TaskStateChanged
  | PlannerStateChanged
  | ExecutorAttemptChanged
  | ConfigurationChanged
  | PermissionRequested
  | ArtifactPublished
  | NoticeRaised;
```

每个事件包含：

- schemaVersion；
- eventId；
- timestamp；
- sessionId；
- taskId/attemptId；
- severity；
- user-facing summary；
- structured payload；
- suggested actions。

CLI、TUI、Gateway Client 和 Feishu 使用同一语义事件，各自渲染。

迁移期间可保留文本输出作为兼容 projection，但不得反向解析文本恢复状态。

## 14. 安全与秘密

### 14.1 Secret Store

优先级：

1. 本轮原生 macOS 安装使用 Keychain；Linux 使用 Secret Service，或在明确
   声明不支持系统 store 时要求用户显式选择文件 fallback；
2. 用户显式选择文件 fallback 时使用 `~/.anyfusion/config/secrets/`，目录
   mode `0700`、文件 mode `0600`；
3. 配置文件只保存 `secretRef`。

系统 credential manager 访问失败不得静默降级。legacy `provider.env` 迁移
必须先写入 SecretStore、验证引用可解析，再激活新 revision；旧明文文件的
归档或删除需要用户确认并记录 redacted audit。

禁止：

- secret 写入 Planner projection；
- secret 写入 Kernel snapshot；
- secret 写入 decision ledger；
- secret 写入 AgentClass 普通字段；
- secret 写入 revision diff、View Event、attempt receipt 或日志；
- 非受信客户端或 Gateway adapter 直接读取原始 secrets file。

Runtime 只在启动 attempt 前解析本次授权所需的 scoped secrets，并只注入该
子进程。临时 credential material 在 attempt 结束后按 retention policy 清理。

### 14.2 配置供应链

- release manifest 使用受信 key 签名；
- bootstrap 内置版本化 trust root，并在执行任何下载的 Node/shell payload
  前完成 manifest 验签；
- manifest 包含 channel、platform、arch、发布时间、过期时间、artifact URL、
  byte size、hash、signature algorithm、key ID、signature 和完整兼容矩阵；
- 定义 key rotation、revocation、channel isolation 和 downgrade policy；
- MetaWork/Planner revision pin；
- checksum verification；
- atomic activation；
- rollback；
- 配置 migration dry-run；
- redacted audit；
- 禁止从任意 project URL 自动推断并执行 command。

现有 ExecutorAdminService 的 GitHub README/package.json command inference 不进入新系统。

本机 worktree backend 是受信任子进程执行载体，不等同于完整 OS sandbox。
安全边界来自独立 execution workspace、private attempt Home、Permission
Profile、scoped credentials、timeout/abort、Completion Protocol 和 Git
publication gate。只有容器、Codex nested sandbox 或明确的系统级隔离能力
可以使用 sandbox 术语。

## 15. 错误处理

### 15.1 安装错误

- preflight failure：不创建 current release；
- Planner clone/build failure：保留 staging 日志，可重试；
- Provider test failure：允许保存草稿，但不激活对应 AgentClass；
- Executor command missing：Profile 保存为 disabled/unavailable；
- config validation failure：不覆盖上一 revision；
- doctor failure：安装可以完成，但必须明确区分 blocking/non-blocking。

### 15.2 配置错误

Configuration Service 返回结构化错误：

```text
path
code
message
severity
suggestedFix
```

### 15.3 运行错误

- Adapter 规范化外部错误；
- Runtime 上报 facts；
- Kernel 决定 retry/fallback/replan/block；
- Gateway 和现有 Server 访问面只展示结果和可执行下一步。

## 16. 迁移方案

### 16.1 配置迁移

从当前配置读取：

- `~/.metaclaw` legacy Bash 布局；
- `~/.config/anyfusion` 和 `~/.local/share/anyfusion` native macOS 布局；
- `ANYFUSION_CONFIG_HOME`、`ANYFUSION_BIN_HOME`、
  `ANYFUSION_PI_SOURCE_ROOT` 等旧 override；
- Provider env；
- Planner model/settings；
- Codex/Pi model/settings；
- `config.yaml` runtime policy；
- SQLite canonical AgentClass。

生成一次 version 2 配置：

```text
legacy sources
  -> migration reader
  -> candidate ConfigurationSnapshot
  -> secret import plan
  -> source hash inventory and conflict report
  -> validation/report
  -> user confirmation
  -> staged immutable revision
```

pre-release 原则：

- 只支持明确的一次迁移；
- 不长期双读；
- 迁移准备阶段不改变当前运行权威；只有 Planner、Kernel、Runtime 和 Harness
  consumers 全部支持新契约后，才执行一次原子 authority cutover；
- cutover 完成后旧位置只作为隔离归档或停止读取；
- 模糊配置必须 fail closed。
- 两套 legacy root 同时存在且值冲突时 fail closed，不按隐含优先级覆盖；
- dirty sibling checkout 不移动、不覆盖；
- migration report、revision copy 和日志不得包含 secret。

### 16.2 Planner 路径迁移

历史 sibling：

```text
<parent>/MetaWork
<parent>/AnyFusion-Pi
```

目标：

```text
~/.anyfusion/app/releases/<release-id>/
├── dist/
├── node_modules/
├── package.json
└── planner/
    ├── packages/
    ├── node_modules/
    └── package.json
```

迁移步骤：

1. 检测现有 sibling checkout；
2. dirty checkout 不移动、不覆盖；
3. 使用其 revision 作为安装输入或重新 clone pinned revision；
4. 将 AnyFusion-Pi checkout/build 直接安装到 release 的 `planner/`；
5. doctor 验证 Host Protocol；
6. 原 sibling checkout 保留给用户自行处理；
7. launcher 只引用当前 release 内的 `planner/`。

### 16.3 程序与配置回滚

程序、配置和数据库是三个独立版本对象，但 update/rollback 必须作为一个
可崩溃恢复的事务协调：

```text
program:
  app/current -> app/releases/<previous-release-id>/

configuration:
  active revision -> previous compatible revision

database:
  schema/data -> verified pre-upgrade snapshot when the old release is incompatible
```

回滚前必须检查：

- 旧 Server 是否支持当前 database schema；
- 旧 Server 是否支持目标 configuration schema；
- 是否存在新版本创建但旧版本无法解释的运行中 Task；
- 是否存在不可中断的 attempt；
- Planner Host、Planning Plan、Work Graph 和 Kernel Decision protocol 是否兼容。

数据库 migration 优先采用向前兼容策略。不可逆 migration 必须提供备份、
恢复命令和明确维护窗口。本轮所有 schema 变化必须集中为一次显式
`30 -> 31` migration，覆盖表、列、外键、索引、trigger 以及可恢复 Plan v7、
Work Graph v6、deferred replan、dispatch、Kernel event/snapshot JSON 的转换。

update transaction 必须执行：

```text
acquire update lock
  -> close Task admission
  -> quiesce new dispatch
  -> drain attempts/outbox/publication
  -> stop Planner/Gateway/timers
  -> WAL checkpoint and verified database backup
  -> migrate a clone and validate foreign keys/hashes
  -> stage release and configuration revision
  -> switch database/config/generated/app pointers
  -> start candidate and run health check
  -> reopen admission
```

health check 通过前不得产生新版本业务写入。失败时按 database、configuration、
generated runtime、app/current、old daemon 的顺序恢复完整旧组合；任何阶段
崩溃后只能恢复为完整旧版本或完整新版本。

## 17. 分阶段实施

### Phase 0：ADR 与契约冻结

- 新增 Configuration Control Plane ADR；
- 确认 AgentClass/Harness/Model ownership；
- 确认 Configuration Store 权威介质；
- 确认 Plan/Work Graph schema 升级；
- 确认 Server Admin CLI、Gateway 与 Configuration Service 边界；
- 建立现有配置和冗余调用图。

### Phase 1：Release、Path 与持久化基础

- `~/.anyfusion` 统一根目录；
- signed release manifest、trust root、channel/platform/arch contract；
- immutable configuration revision layout 和 activation journal；
- 完整 schema `30 -> 31` migration specification；
- WAL checkpoint、database backup/restore 和 update transaction；
- macOS Keychain 及显式文件 fallback contract。

### Phase 2：Configuration Service 与迁移候选

- version 2 schema；
- revision/hash/audit；
- Provider、Model、Harness、AgentClass；
- code-owned Permission Profile reference；
- Planner/Kernel/Runtime projections；
- secret references；
- migration reader、source inventory、secret import plan 和 candidate revision；
- 本阶段不切断 legacy runtime authority。

### Phase 3：Planner/Kernel Routing Contract

- Plan v8 / Work Graph v7；
- AgentClass/Model tuple；
- 通用结构 schema 加 revision-scoped catalog semantic validation；
- generation-scoped configuration revision；
- Kernel admission 校验；
- Provider/Model health identity、failure scope 和恢复投影；
- deferred replan、decision、dispatch、receipt 记录 configuration revision。

### Phase 4：Executor Adapter 重构与原子 Cutover

- `PlannerProcessSupervisor`；
- `PlannerHostBridge`；
- HarnessDriver；
- Local CLI adapter；
- backend strategy；
- per-AgentClass Home；
- 删除 name allowlist；
- Codex/Pi 行为回归；
- 两个仓库的 protocol pin 和联调门禁；
- 在所有 consumers 就绪后执行一次 legacy authority cutover；
- 不增加 dual-read/dual-write；
- 为后续 A2A 留稳定 adapter seam。

### Phase 5：Server 管理面、生命周期与 Installer

- 统一 Server daemon lifecycle；
- update lock、admission close、quiesce、drain、restart 和 crash recovery；
- setup/configure/update/rollback CLI；
- 统一 macOS/Linux Installer Core；
- Planner 直接安装到 release 的 `planner/`；
- signed manifest verification、staging、database migration 和 atomic activation；
- PATH 冲突检测；
- Provider/Model probe；
- AgentClass 管理命令；
- doctor 与诊断输出；
- versioned local Configuration API，为 future Desktop 保留协议但不开发客户端；
- 为现有 CLI/TUI、Gateway Client 和 Feishu 提供结构化 View Events。

### Phase 6：冗余清理与 Release Gate

- 删除旧 ExecutorAdminService；
- 删除 `executor.command`；
- 删除 Planner schema hardcoded Executor enum；
- 删除旧 setup 非一致路径；
- 收敛 Guidance/Orchestration；
- 收敛 Feishu notification/delivery；
- 删除确认无生产消费者的 repo/service/schema；
- 冻结并完整保留 standby Ink TUI；
- 仅通过后续独立 retirement ADR 评估删除。
- macOS 与 Linux CI；
- 干净 HOME install/update/rollback，包含 schema 30-to-31 和 database restore；
- legacy 双布局迁移、SecretStore、签名失败和 daemon restart 验收。

### 后续独立计划：Remote Executor

本轮不实现 A2A Adapter、remote endpoint registration、认证、streaming、
cancel 或 artifact transport，只确认现有 `ExecutorAdapter` seam 和
authorized attempt envelope 足以承载后续 transport。A2A 实施前必须新增 ADR
和独立计划，定义 version negotiation、trust、idempotency、uncertain outcome、
artifact integrity、remote permission boundary 和 failure normalization。

## 18. 测试策略

### 18.1 配置

- schema validation；
- reference integrity；
- revision conflict；
- immutable revision activation；
- activation journal crash recovery；
- rollback；
- redaction；
- Planner/Kernel/Runtime projection consistency；
- property test：一个 AgentClass 在三个投影中的 ID/revision 必须一致。

### 18.2 安装

- clean install；
- repeated install；
- interrupted install；
- staging recovery；
- checksum/signature failure；
- unknown/revoked signing key and expired manifest；
- wrong channel/platform/arch；
- dirty Planner source；
- missing Codex/Pi；
- existing Codex/Pi hash/config unchanged；
- Planner 直接位于 release `planner/`；
- current-directory launch；
- schema 30-to-31 update and database rollback；
- daemon quiesce/drain/restart；
- candidate health failure restores the old compatible combination；
- native macOS Keychain and explicit Linux fallback；
- both legacy root layouts and conflict handling；
- non-interactive install；
- shell PATH conflict；
- existing npm-installed AnyFusion migration。

安装前后必须校验用户 `codex`、`pi` 的 command path、version、binary hash，
以及 `~/.codex`、`~/.pi` 内容 hash 不变。

### 18.3 路由

- 新增 Executor 只登记一次即可出现在 Planner Catalog；
- Planner 不可输出未注册 AgentClass；
- Kernel 拒绝未授权 AgentClass/Model tuple；
- Runtime 使用 Kernel 授权的 exact tuple；
- 同一 Work Graph generation 的 proposal、所有 graph revisions、deferred
  recovery、decision、dispatch、retry/fallback、attempt 和 receipt 使用相同
  configuration revision；
- active revision 改变不影响已有 generation；
- 同一 AgentClass 的不同 Model fallback 使用不同 binding fingerprint 和
  attempt identity；
- Provider/Model failure scope、projection 和恢复事件按 revision 隔离；
- disabled AgentClass 不获得新 attempt；
- fallback 使用预授权 tuple。

### 18.4 Runtime Home

- 同一 Harness 两个 AgentClass 配置互不影响；
- 不读取用户 `~/.codex` / `~/.pi`；
- generated runtime 与 attempt Home 分离；
- attempt session 隔离；
- worktree cwd 不被 Home 替代；
- cleanup/retention；
- crash recovery。

### 18.5 Planner 进程与 Bridge

- `anyfusion` 先启动 MetaWork Server，再启动 AnyFusion-Pi TUI；
- interactive 与 RPC 共用 `PlannerProcessSupervisor` bootstrap；
- 同一 session 的 turn 串行写入；
- Planner session 持久化；
- 用户当前目录作为 Planner `cwd`；
- `PlannerHostBridge` socket mode 为 `0600`；
- proposal submission 幂等与 turn lock；
- Planner View 不包含 secret；
- Bridge 断线、重连、timeout 和进程退出清理；
- Planner 不得直接启动 Executor。

### 18.6 Server 管理面

- Installer/Admin CLI 修改同一配置；
- stale revision 冲突；
- Server daemon restart/reconnect；
- structured View Event；
- config probe 不触发正式 Task；
- 配置失败不影响运行中 attempt；
- local API schema/version rejection；
- secret 字段不可回读；
- Unix socket mode、local caller audit 和 replay-safe mutation；
- Gateway 不直接写 Repository 或调用 Executor。

### 18.7 回归

- PlanningAgent -> Kernel -> Runtime 主链；
- single-Task admission；
- concurrent Subtask dispatch；
- cancellation fence；
- completion protocol；
- Git publication；
- recovery/availability；
- schema 30-to-31 recoverable payload migration；
- signed update crash/failure injection；
- macOS 与 Linux native release smoke；
- Feishu delivery；
- native Planner session smoke。

本轮普通本机安装不使用 Docker。Docker 仅保留为可选 Linux compatibility/CI 验证，不得重新成为产品安装前置条件。

## 19. 验收标准

### 安装

- 一句命令完成 Server 安装并进入终端配置向导。
- release 根目录直接包含 MetaWork Server 程序，Planner 位于同一 release
  的 `planner/` 子目录。
- 安装前后用户 Codex/Pi command、version、binary hash 和个人配置 hash 不变。
- 可重新运行配置向导。
- 可通过受信签名执行 update，并可 rollback 程序、配置、generated runtime 和
  数据库。
- 用户可在任意项目目录执行 `anyfusion`，先启动 MetaWork Server，再进入
  受控 AnyFusion-Pi 原生 TUI。
- `~/.local/share` 不是强制安装位置，默认用户级根目录为 `~/.anyfusion`。

### 配置

- 新增 Executor 只修改一份 Agent Configuration。
- 同一 Work Graph generation 的 Planner、Kernel、Runtime、recovery 和 receipts
  使用相同 configuration revision。
- Planner Schema 不硬编码 Executor name。
- Runtime 不使用 Executor name allowlist。
- Harness、Model 和 AgentClass 可独立配置。
- 同一 Harness 多个 AgentClass 使用独立 Home。
- generated Agent runtime 是可重建产物，不构成第二配置源。
- active revision 通过单一 pointer 原子切换，旧 revision 在仍被 durable facts
  引用时不会被清理。

### 模型

- Planner 支持 auto/fixed。
- Executor 支持 auto/fixed。
- auto Executor 模型由 Planner 提议、Kernel 授权、Runtime 注入。
- 未授权模型不能执行。
- AgentClass、Provider、Model 和 binding health 拥有显式、revision-scoped
  identity。

### Server 管理面

- Installer 和 Admin CLI 使用同一 Configuration Service。
- Admin CLI 不拥有 Planner、Kernel 或 Runtime 策略。
- Task、Executor 和配置状态使用结构化协议。
- 本轮不交付 Desktop Client。

### 架构

- 不出现 Planner -> Executor 直连。
- 不出现第二套 scheduler/retry/fallback。
- Gateway 不拥有 Kernel policy。
- `PlannerProcessSupervisor` 和 `PlannerHostBridge` 均位于 MetaWork Server
  进程内，AnyFusion-Pi 是独立 Planner 子进程。
- 动态健康与静态配置清晰分离。
- Permission Profile 语义由 Resource/Kernel 版本化代码拥有，配置只能引用。
- 发布物在执行前通过版本化 trust root 验签。
- A2A 不在本轮交付，只保留 transport-neutral authorized attempt seam。
- 删除的冗余模块没有测试保活残留。

## 20. 需要新增或更新的权威文档

实施前：

- 新增 Configuration Control Plane ADR；
- 新增 AgentClass/Model routing contract ADR，或修订 ADR-0018；
- 新增 native release trust/update transaction ADR；
- 冻结 future A2A Executor transport 边界并创建独立后续 roadmap；
- 如退休 standby Ink TUI，单独新增 retirement ADR/plan。

实施时同步更新：

- `CONTEXT.md`；
- `docs/current/technical-overview.md`；
- `docs/current/technical-overview.zh-CN.md`；
- `AGENTS.md`，仅在导航或 onboarding 发生变化时；
- `README.md` / `README.zh-CN.md`；
- installer/update/doctor operational docs。

## 21. 不在本轮范围

- 多顶层 Task 调度；
- 让 Planner 直接控制 Executor；
- 让 Runtime 自行决定 retry/fallback；
- 自动安装或修改用户 Codex/Pi；
- 将 Planner 合并进 MetaWork Node 进程；
- 将 AnyFusion-Pi 源码并入主仓库；
- 强制 Docker；
- A2A Executor Adapter、remote endpoint registration、认证、streaming、
  cancel、artifact transport 和动态 discovery；
- Desktop Client 的设计与开发；
- 新增 Web 管理控制台。

## 22. 最终判断

本次升级的核心不是增加更多安装脚本，而是建立一个稳定的 Server 产品控制面：

```text
one installer
one configuration authority
one Planner proposal path
one Kernel decision authority
one Runtime execution path
multiple isolated Harness/Model/AgentClass bindings
multiple clients through one connectivity plane
```

只要单一 Agent Configuration Store 没有建立，新增 Executor、模型和 Server 管理入口都会继续放大当前配置漂移。该能力应作为本次升级的 P0 前置，而不是后续补丁。
