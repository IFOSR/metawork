# MetaWork 无 Kernel 目标架构与契约重置实施方案

- 日期：2026-11-07
- 状态：Accepted；批次按本文件顺序推进。2026-11-08 用户要求只做本地修改，暂停逐批提交，由用户本地验证后统一处理。
- 最新本地事实：[续作与验证记录](2026-11-08-metawork-convergence-continuation-record.md)。P3-D 已推进至 D2-3b-2d：准入策略、持久事实、原子应用、延迟写入与全部生产者（普通提交、旧 Session、后台 replan worker、账户启动恢复、Kernel 触发的 replan effect、无客户端恢复重规划）均归 Task Runtime，**生产环境不再产生计划事件，计划账本零增长**；Manager 读取改读 owner 事实。剩余计划适配器与 `plan_proposed`/`plan_admission` 词汇为不可达死代码，随 D6 删除，同时迁移 `command-read-services`/`server-composition` 的旧计划读者。派发、容量/重试、完成与 replan 决策仍有 Kernel 路径；P3-B/C、D4–D6、P4/P6 和 P7 尚未关闭。
- 上位决策：[ADR-0055 Decision ledger](../adr/0055-no-kernel-target-architecture-and-contract-reset.md)
- 契约：[目标契约设计](2026-11-07-metawork-target-architecture-contract-design.md)
- Spike 证据：[P2-A 上游 Pi 集成](2026-11-07-p2a-upstream-pi-integration-spike.md)
- 事实基线：[复盘报告](2026-11-07-metawork-product-convergence-retrospective-report.md)、[B0.2 记录](2026-11-07-b0-2-baseline-failure-classification-record.md)
- 验收范围（D14）：本机 macOS arm64 + Web 端；Linux/Desktop/Feishu 由 Owner 后续验收；未验收前不推 GitHub

## 1. 原则

1. 替代先于删除：每个生产路径先有新 owner 的实现与验收，再删旧路径。
2. 每个批次一个提交，提交信息写清"旧入口、替代 owner、回滚点、验证命令"。
3. 不引入第二个语义路由/权限/恢复循环，不保留 Kernel 兼容读取器（D8）。
4. 破坏性变更一次做干净：新 schema、新命名、新打包（D7/D9）。

## 2. 批次

| 批次 | 目标 | 主要产物 | 退出条件 | 回滚点 |
| --- | --- | --- | --- | --- |
| P2-B1 | 打包期 Pi 版本固定 | release manifest 增加 `pi.version`/integrity；构建缺 `pi` 失败；`scripts/bundle-upstream-pi.mjs` | 干净目录构建产出含版本号的 manifest，且构建不读取用户 `~/.pi` | 该提交前 |
| P2-B2 | Manager 宿主桥 | `ManagerHostPort` + `ManagerProcessRunner`（独立 HOME/config/session、RPC version/超时/取消/大小上限/结构化错误） | RPC spike 六项断言通过；Manager 提案经 Plan v9/Work Graph v7 校验 | 该提交前 |
| P2-B3 | Manager 工具面改成平台扩展 | 提案工具、MCP 注册、系统提示注入、命令/渲染扩展 | 只读/路径 containment/预算/超时/拒绝写入测试通过 | 该提交前 |
| P2-B4 | 移除 vendored Pi | 删 `planner/AnyFusion-Pi`、构建/打包/AGENTS/ADR 引用 | 干净安装无 vendored 运行时；Manager 用打包上游 Pi 完成真实规划 | P2-B1..B3 提交 |
| P2-C1 | 单一 Executor runtime | `ExecutorRuntimePort`，Pi 同版本独立进程；Codex 路径逐项映射 | 工具面回归；native macOS 任务 E2E 通过 | 该提交前 |
| P2-C2 | 删除 Codex | binding/discovery/config/permissions/UI/tests/assets | 干净安装无需 Codex；等价验收通过 | P2-C1 |
| P3-A | Runtime 持久端口 | §2 端口 + fresh schema（`tasks/work_graphs/subtasks/attempts/route_decisions/...`） | 端口单测 + 事务边界 + 重启重建断言 | 该提交前 |
| P3-B | Router 直派 | Router 端口、`RouteDecision` 持久化、Span/Jev 决策模型、no-candidate 导流 | §9 契约断言全绿；Router 不写库/不起进程 | 该提交前 |
| P3-C | Manager 权限闭环 | PermissionService 三层 + 用户升级 + Host 边界复核 | hard deny 不可绕过；scope 只能收窄；并发/过期/重启用例 | 该提交前 |
| P3-D | 删 Kernel | 决策账本/replay/`kernel_*` 表/调用点/tests；`no_op` 等随删除 | 生产与测试无 Kernel 决策 API；Task 重启/权限/取消/交付 E2E 通过 | P3-A..C 验收 |
| P4-A | 每调用 Token usage | `MeteringPort` + `model_usage_facts`/`usage_rollups`；调用点全清单 | 每个受支持调用一条 fact；重复 callback 去重 | 该提交前 |
| P4-B | Provider 分类与额度 | Included/On-demand、订阅周期（月/年，试用例外）、聚合 API | 与逐行之和一致；耗尽只引导不阻断 | 该提交前 |
| P4-C | 删金额账务 | 价格/成本/账单/待确认 UI/API/表 | 无价格配置与金额账单；官方付款边界复核 | P4-A/B 验收 |
| P5-A | Server bind/origins | `server.host/allowedOrigins/trustProxy` + 认证/Origin 校验 + status/doctor | loopback 默认兼容；非回环未认证拒绝；wildcard+空 origins 拒绝启动 | 该提交前 |
| P5-B | Web 能力对齐 | Task/permission/trace/usage/memory 读模型与页面（用量 Tab、记忆 Tab、trace） | Web 端旅程通过（本机） | 该提交前 |
| P5-C | 去 TUI 入口 | 删 `metawork tui`、Ink UI、TUI-only 参数；`metawork` 提示先起 Server | 裸命令行为符合 D11；Web 覆盖同等能力 | 该提交前 |
| P6-A | 删 Docker 执行路径 | Docker backend、attempt 镜像、egress proxy、Docker-only tests；`Dockerfile.test` 由原生套件替代 | 本机原生全绿；安全文档写明 D12 边界 | 该提交前 |
| P6-B | fresh schema 收口 | 单一 `CURRENT_SCHEMA_VERSION`；删迁移链；旧库显式失败 + 重置说明 | 旧库在任何写前失败；新库正常 | 该提交前 |
| P6-C | Windows 声明 | 文档/release manifest 标注不维护、停发更新（**不删代码**） | 发布元数据一致 | 该提交前 |
| P6-D | 命名收口 | `METACLAW_*`→`METAWORK_*`、bin 别名删除、文案统一（D7） | `rg 'MetaClaw|AnyFusion|METACLAW_'` 仅剩历史归档 | 该提交前 |
| P7 | 验收 | macOS + Web 全量证据、真实旅程、干净安装 | 按 D14 范围全部有记录 | — |

顺序说明：P2 必须在 P3 之前（Manager/Executor 收敛后才有唯一 runtime）；P4/P5 的局部独立
功能可与 P3 并行（ADR-0055 §2 允许），但不得提前删除旧数据或旧客户端路径；P6 全部在
替代能力验收之后；Windows 只声明不删除（D13）。

## 3. 每个批次的固定记录模板

| 项 | 内容 |
| --- | --- |
| Scope / owner | 本批改哪些模块、明确不改什么 |
| Before | HEAD、工作树、schema/config/protocol 版本、基线命令与结果 |
| Contracts | 输入/输出、状态转换、错误码、幂等键、权限边界、唯一写入者 |
| Data | 表/索引/事务、重启恢复、fresh schema 行为 |
| Tests | owner 单测、契约测试、故障注入、E2E、本机 macOS 验证 |
| Exit | 可量化通过条件 |
| Close | 变更摘要、实际命令与结果、commit、回滚点 |

## 4. 已知删除清单（替代能力验收后才执行）

- `src/kernel/*` 决策接口与 `DurableKernelWorkflow`、ledger/replay、`kernel_*` 表与 projection。
- `session-kernel-runtime.applyTaskPlan` 的 legacy owner 派生分支（B0.2 F5 引入）。
- `publication_accepted_*`、`workspace_publications` 读取路径（B0.2 已停止新写入）。
- `planner/AnyFusion-Pi` 全部私有运行时（保留许可证/NOTICE 归属后删除源码树）。
- Codex 执行路径与设置面。
- 模型价格/成本/账单代码与表。
- `metawork tui`、`src/tui/`、TUI-only 参数。
- Docker 尝试后端与 `docker/` 任务资产（`official-server` 部署资产由官方服务 Owner 决定，不在本清单）。
- 迁移链与旧 schema 读取器。
- `METACLAW_*` / `metaclaw` / `anyfusion` 兼容标识。

## 5. 与旧计划的关系

本文件取代早先引用的"契约设计"和"重置实施方案"草稿；它们不在工作区，也不再作为评审依据。
复盘报告与 B0.2 记录保留为事实基线，不因本文件接受而被改写。

## 6. 已关闭批次

### P2-B1 打包期 Pi 版本固定（2026-11-07）

- 产物：`scripts/lib/pi-runtime-pin.mjs`、`scripts/build-release.mjs`（构建即校验，写
  `<out-dir>/pi-runtime-pin.json`）、`tests/installation/pi-runtime-pin.test.ts`。
- 行为：缺 `pi`、launcher 版本与 release `package.json` 不一致、host Node 低于 Pi 声明
  的 engine —— 构建失败；pin 记录 version/packageVersion/releaseDir/lockSha256/host。
- 边界：不读用户 `~/.pi` 配置/session/auth；`PI_MANAGED_INSTALL_ROOT` 仅回退，实际执行的
  launcher 位置优先。
- 验证：`npx vitest run tests/installation` → 268 passed（含新增 5 项）；
  `node -e "…assertPiRuntimePin({command:'pi'})"` → `1.5.0`、`>=22.19.0`、lock `d3d2…`。
- 遗留：签名 manifest 的 `pi` 段在 P2-B4 随 Pi 归档一起加入。

### P5-A Server bind / origins（2026-11-07）

- 产物：`src/server/server-binding.ts`（`resolveServerBinding`/`canonicalOrigin`/
  `isOriginAllowed`/`serverBindingFromEnv`）、`ManagementServer` 绑定与 Origin 闸门、
  `tests/server/server-binding.test.ts`（10 项）、`tests/management/server.test.ts`
  「server network boundary」（3 项）。
- 行为：默认 `127.0.0.1`；非回环且未配置 `METAWORK_SERVER_ALLOWED_ORIGINS` 时 **拒绝启动**
  （端口未打开前失败）；拒绝 `*`/`null`/带凭据/带路径的 origin；配置 allow-list 后只接受
  其中的 origin；未配置时要求同源，并把 `localhost`↔`127.0.0.1` 视为同源别名；无 `Origin`
  头的 CLI/Desktop/测试请求不做源校验而按其自身凭据鉴权；`/api/ws/diagnostics` 例外，
  因为它就是用来向运维解释"源不匹配"的（仍需认证、只读）。
- 配置：`METAWORK_SERVER_HOST`、`METAWORK_SERVER_ALLOWED_ORIGINS`、`METAWORK_SERVER_TRUST_PROXY`。
- 验证：`npx vitest run tests/management tests/server tests/web` → 690 passed；
  `npx tsc --noEmit` 通过。
- 遗留：`CONTEXT.md`/技术概览的"仅回环"表述在 P6-D 随命名收口一并改写。

### P6-A Docker 执行路径（2026-11-07）

- 删除：`src/execution/docker-cli-attempt-execution-backend.ts`、两处后端选择分支的
  `docker`/`container` 分支、`docker/Dockerfile.attempt-{pi,codex}`、两个 attempt
  entrypoint、`scripts/build-attempt-images.{sh,ps1}`、`docker/Dockerfile.egress-proxy`、
  `docker/egress-proxy/`，以及两个专属测试文件。
- 保留：`docker/Dockerfile.runtime`、`docker/*.env.example`、`docker/*-config`、smoke 的
  `--mode docker`、`Dockerfile.test` —— 它们是打包/冒烟/测试夹具，不是执行后端。
- 行为：`METACLAW_EXECUTOR_BACKEND=docker|container` 现在报
  `Unsupported METACLAW_EXECUTOR_BACKEND: …; use native`；`docker_socket` 仍是 hard-deny
  能力（没有任何调用方可以拿到）。
- 文档：`docs/current/phase-5-runtime-security.md` 改写为 D12 边界（可信用户进程 + Host 强制，
  无 OS 沙箱/容器/egress proxy，需要出网管控由运维方在 MetaWork 之外提供）；
  `docs/current/technical-overview.zh-CN.md` 同步。
- 验证：`npx vitest run tests/account tests/execution tests/configuration tests/resource
  tests/scripts` 通过；`npx tsc --noEmit` 通过。

### P4-B 计划额度目录（占位值，单点可改）（2026-11-07）

- 产物：`src/metering/plan-quota.ts`、`tests/metering/plan-quota.test.ts`（11 项）。
- 设计值（占位，改这一个文件即可）：免费基线 `1,000,000` token/自然月；Included 月付
  `20,000,000`/自然月；Included 年付 `240,000,000`/自然年；试用 `14` 天 `2,000,000` token，
  一次性、不续期、不属于订阅周期。
- 规则：只有 monthly/yearly 两个订阅周期；trial 是例外，`trialDays` 只允许出现在 trial；
  额度必须是非负安全整数；窗口按 UTC 日历月/年计算，试用窗口从激活时刻起算；`0` 是合法值
  （明确表示无托管额度），不是"未知"。
- 运维覆盖：`resolvePlanQuotaCatalog(overrides)` 按 `planId` 替换，其余保持默认；非法覆盖
  直接抛错，不静默回退。
- 已接线（2026-11-09）：`model_usage_facts` 保存 AgentClass 与 payer 归因，Manager hosted
  调用前按 `manager + platform` 过滤当前北京时间窗口；用户自带 Provider 归为
  `user_direct`，不进入 Included 额度聚合。额度耗尽、用量暂缺和未知计划现在写入
  `PlanningContext.quotaNotice` 并继续规划，不再硬阻断 Task；`quota-guidance` 提供可替换的
  虚拟供应商目录，Gateway `get_quota_guidance` 和 Web 额度卡片已接线，真实运营目录仍待替换。

### P6-C Windows 与平台声明（2026-11-07）

- 产物：`docs/current/supported-platforms.md`（平台矩阵 + Windows 具体含义 + 与发布元数据的
  优先级），`AGENTS.md` 的 Windows 段落改为"不维护、保留代码、Docker 仅作测试夹具"。
- 未做（有意）：不删除 Windows 代码与测试（D13）。

### P4-B 试用额度按 Owner 指定值（2026-11-07）

- `TRIAL_PERIOD_DAYS = 7`、`TRIAL_INCLUDED_TOKENS = 1_000_000`；免费基线仍为
  `1,000,000`/自然月，与试用不叠加（试用期内用试用额度，结束后回到基线）。
- 验证：`npx vitest run tests/metering/plan-quota.test.ts` → 11 passed。

### 文档归档隔离（2026-11-07）

- `docs/plans/` 只保留现行计划（60 个文件，含 2026-11-07 收敛文档与仍生效的设计/路线图）；
  其余 136 个历史计划移入 `docs/archive/plans/`。
- `docs/README.md` 重写为"现行权威 + 保留计划 + 归档指针"，不再维护历史索引；
  `docs/archive/README.md` 明确归档不更新、不作为依据。
- 14 个文件内的 102 条失效相对链接自动改写到 `docs/archive/`。
- 验证：`npx vitest run tests/architecture tests/commands` → 116 passed。

### 有意偏离（记录理由）

- `docker_socket` 保留为 hard-deny 能力：它是拒绝规则里的**防御性字符串**，删掉会降低安全性，
  与"删除 Docker 执行后端"无关。
- `docker/Dockerfile.runtime`、`docker/*.env.example`、`docker/*-config`、`Dockerfile.test`
  保留为打包/测试夹具；`docker/` 下的 attempt 镜像、entrypoint、egress proxy、构建脚本已删除。

## 7. 提交纪律

按 Owner 2026-11-07 指示：**在其验收成功之前不提交任何批次**。上述变更全部留在工作区，
未产生 commit。

### P2-B2 Manager 宿主桥（2026-11-07）

- 产物：
  - `src/planning/manager-host/protocol.ts` —— 协议版本 1；三类消息（`plan`/`cancel`/`ping`）；
    单行 JSON；双向 8 MiB 上限；结构化错误码（`manager_protocol_mismatch`、
    `manager_invalid_output`、`manager_response_too_large`、`manager_timeout`、
    `manager_cancelled`、`manager_process_exit`、`manager_spawn_failed`）；usage 归一化
    （未回报 → `null` + `source: 'unavailable'`，不伪造 0）。
  - `src/planning/manager-host/environment.ts` —— 子进程环境白名单：`HOME`/`PI_CODING_AGENT_DIR`/
    `PI_CODING_AGENT_SESSION_DIR` 指向 MetaWork 自有目录，`PI_*`/`ANYFUSION_*`/`METACLAW_*`/
    `NODE_OPTIONS` 不继承，并记录 `dropped` 供诊断。
  - `src/planning/manager-host/process-runner.ts` —— 单进程、单飞行请求；超时即 SIGTERM→SIGKILL；
    `AbortSignal` 取消并尽力发送 `cancel`；超大行先失败再关进程；退出/崩溃失败全部 pending；
    重启后可继续；stderr 只作诊断，不进协议。
  - 测试：`tests/planning/manager-host-process-runner.test.ts`（13 项）+ `tests/fixtures/fake-manager.mjs`。
- Spike 六项断言覆盖：协议版本、超时、取消、大小上限、结构化错误、环境隔离（真实子进程观测）。
- 验证：`npx vitest run tests/planning` → 199 passed；`npx tsc --noEmit` 通过。
- 未做（P2-B3 起）：真实上游 Pi 的扩展侧实现（提案工具、MCP、系统提示）、把 runner 接进现有
  `planner-process-supervisor` 的替换路径。桥契约已独立于 Pi 版本，替换时不再需要第二套 runner。

### P2-B3 Manager 工具面改为平台扩展（2026-11-07）

- 产物：
  - `src/planning/manager-host/rpc-client.ts` —— 上游 Pi `--mode rpc` 客户端：严格 LF 分帧
    （不用 readline，避免 U+2028/U+2029 误分帧）、按 `id` 关联、事件订阅、超时/退出/超大记录
    一律转 `ManagerHostError`，并新增 `onFailure` 让"命令已应答但进程随后死亡"的中途失败也能
    立刻结束回合（否则只能等超时）。
  - `src/planning/manager-host/manager-agent.ts` —— 一个回合：渲染 Runtime-owned 输入为单个
    prompt → 等 `agent_settled` → 从 `turn_end.toolResults[].details.proposal` 取结构化提案，
    usage 取自 `message_end` 的 assistant `usage`（未回报则 `null` + `unavailable`）。
  - `src/planning/manager-host/extension/index.ts` —— Pi 扩展：注册唯一输出通道
    `submit_manager_proposal`（`proposal` 不额外约束，形状由 MetaWork Plan schema 校验，避免第二份
    schema 漂移）；`before_agent_start` 注入 Manager 规则并把活动工具收紧为 `read/ls/grep/glob` +
    提案工具；`tool_call` 二次拦截写工具与工作区外读取。
  - 打包：`tsup.config.ts` 把扩展源码复制到 `dist/pi-manager`（与 `pi-tool-stall` 同一模式）。
  - 脚本：`scripts/smoke-manager-extension.mjs`（真实 Pi 握手）、`package.json`
    `smoke:manager-extension`、`check:pi-runtime-pin`。
  - 测试：`tests/planning/manager-agent-rpc.test.ts`（11）、`tests/planning/manager-extension.test.ts`（6）、
    `tests/fixtures/fake-pi-rpc.mjs`。
- 真实上游验证：`node scripts/smoke-manager-extension.mjs` → `pi 1.5.0` 在隔离 HOME 下加载扩展，
  `get_state`/`get_commands` 成功，stderr 无扩展错误（扩展注册失败会在启动期报错）。
- 验证：`npx tsc --noEmit`、`npm run build` 通过。
- 遗留（P2-B4）：把 `ManagerAgent` 接进 `server-composition`（传 `pi --mode rpc --no-session
  --extension dist/pi-manager`）、删 vendored Pi、manifest 增加 `pi` 段。

### P2-B4（部分）Manager 接管 PlanningAgent 端口（2026-11-07）

- 产物：
  - `src/planning/manager-host/manager-planning-agent.ts` —— `ManagerPlanningAgent implements
    PlanningAgent`：`plan()` 跑一个 Manager 回合并用**同一份 `PlanningAgentPlanSchema`** 校验；
    `submit()` 走既有 `submitter.submit`，只在 `rejectionType: 'validation'` 时带 issues 做
    有界修复（1 次初始 + 2 次修复，与既有 Planner 上限一致），Kernel 拒绝不重试；usage 经
    `toHarnessUsageEvent` 转成既有计量事件（未回报 → `missing`，不伪造 0）。
  - `src/planning/manager-host/composition.ts` —— 组合根：`pi --mode rpc --no-session
    --extension <dist/pi-manager/index.ts>`，HOME/config/sessions 全部落在 Runtime 自有目录；
    显式指定 `moduleRoot` 时不允许回落到仓库源码扩展。
  - 测试：`tests/planning/manager-planning-agent.test.ts`（10 项，含真实 schema 校验、
    修复上限、Kernel 拒绝不重试、usage 映射、组合根路径解析）。
- 验证：`npx vitest run tests/planning` → 224 passed；`npx tsc --noEmit` 通过。
- 未完成（P2-B4 剩余）：
  1. 在 `server-composition` 里选择 Manager 传输（当前默认仍是 vendored AnyFusion Planner）；
  2. 删除 `planner/AnyFusion-Pi` 与 `src/anyfusion/*` 适配层；
  3. 签名 manifest 增加 `pi` 段（version + 归档 sha256）并把 Pi 归档纳入打包；
  4. 干净安装验收（无 vendored 运行时）。

### P2-B4（续）Pi 运行时纳入签名 manifest + 传输开关（2026-11-07）

- 产物：
  - `src/installation/release-manifest.ts` —— 新增可选 `pi` 段（`version`/`nodeEngine`/
    `lockSha256`/`url`/`byteSize`/`sha256`）；`verifyReleaseManifest` 在 manifest 声明了 Pi
    运行时却**没有**验证 Pi 制品时直接失败，哈希不符报 `pi artifact hash mismatch`；旧 manifest
    没有 `pi` 段仍可解析。
  - `scripts/package-release.mjs` —— 打包时用 `probePiRuntimePin` 解析打包机 Pi，归档
    `pi-<releaseId>-<platform>-<arch>` 并写入 manifest `pi` 段；新增 `--pi-command`。
  - `src/planning/manager-host/transport-selection.ts` —— `METAWORK_MANAGER_TRANSPORT`：
    `vendored-planner`（默认，迁移期）/ `upstream-pi`；**未知值抛错**，不静默回落。
  - 测试：`tests/installation/release-manifest.test.ts` 增至 17 项（Pi 段四例）、
    `tests/release/package-release.test.ts` 增 Pi 打包断言、
    `tests/planning/manager-planning-agent.test.ts` 增至 13 项（含传输选择）。
- 验证：`npx vitest run tests/release tests/installation` → 301 passed；`npx tsc --noEmit` 通过。
- 仍未完成（需要一次完整的端到端才能安全做）：
  1. `server-composition` 在 `upstream-pi` 时真正构造 `ManagerPlanningAgent`（需要把
     Conversation→Workspace/permission profile 的解析注入 `resolveScope`）；
  2. 删除 `planner/AnyFusion-Pi` 与 `src/anyfusion/*`；
  3. manifest `planner` 段在 vendored 删除后改为可选；
  4. 干净安装（无 vendored 运行时）验收。

### P2-B4（接线）Manager 传输接入账户运行时（2026-11-07）

- 产物：
  - `src/planning/manager-host/session-transport.ts` —— `buildManagerPlannerServices()`：返回
    `{ planningAgent: ManagerPlanningAgent, plannerSupervisor: null }`，即该传输下**不存在**
    vendored Planner 进程。
  - `src/account/account-planner-services.ts` —— 唯一选择点：`resolvePlanningTransport()` 为
    `upstream-pi` 且未注入 `planningAgent` 时构造 Manager 服务；缺 `managerTransport` 直接抛错，
    不静默回落。
  - `src/account/account-runtime-composition.ts`、`src/session/metaclaw-session.ts` —— 透传
    `managerTransport`（会话只转发，不做选择）。
  - `src/server/server-composition.ts` —— 组合根构造 `managerTransport`：`runtimeRoot` 为账户根，
    `resolveScope` 用现有 Conversation→Workspace 解析，**始终 `writable: false`**（Manager 只规划，
    永不给写作用域），权限档取 Planner 绑定的 `permissionProfileRef`。
  - `ManagerPlanningAgent.resolveScope` 支持 async（Conversation 解析是异步的）。
  - 测试：`tests/planning/manager-transport-selection.test.ts`（3 项：Manager 服务无 vendored
    进程 / 开关打开但缺配置抛错 / 配置齐全时走 Manager）。
- 验证：`npx vitest run tests/account tests/session tests/server tests/planning` → 672 passed；
  `npx tsc --noEmit` 通过。
- 仍未完成（我下一步做，需要真实模型回合验收后才删）：
  1. `upstream-pi` 下跑通一轮真实规划回合（含只读/写、权限升级、交付）；
  2. 删除 `planner/AnyFusion-Pi` 与 `src/anyfusion/*`、`tui-bridge` RPC 路径、`planner-process-supervisor`；
  3. manifest `planner` 段改可选 + 打包跳过 vendored 归档；
  4. 干净安装（无 vendored 运行时）验收。

### P2-B4 真实验收：Manager 跑通一轮真实模型规划回合（2026-11-07）

- 脚本/用例：`tests/manual/manager-real-turn.test.ts`（opt-in：
  `METAWORK_VERIFY_REAL_TURN=1 npx vitest run tests/manual/manager-real-turn.test.ts`）。
- 真实环境：本机已配置的 DeepSeek 凭据（来自 `~/.metawork/credentials.json`）+ 上游 `pi 1.5.0`
  + `deepseek-flash`（`openai-completions` 端点）。隔离 HOME/config/session 全为临时目录。
- 结果：**7.2s 完成**，`submit_manager_proposal` 返回 **schema v9 合法计划**
  （`action: direct_reply`，`source: anyfusion-planner`），4 次模型调用全部回传 usage
  （input/output/cacheRead），`PlanningAgentPlanSchema` 校验通过。
- 第一次真实运行**暴露了一个真实缺陷**：提案工具的参数原先不携带 Plan 契约，模型自行发明了
  形状（`schemaVersion` 非法）。修复：扩展从 `METAWORK_MANAGER_PLAN_SCHEMA` 读取由同一份 Zod
  源生成的 `planning-agent-plan-v9.schema.json` 作为 `proposal` 的 schema，并在系统提示里写明
  v9 必填字段与 `plan_work_graph`/其他 action 的一致性规则；组合根通过
  `resolvePlanSchemaPath(applicationRoot)` 注入该路径（与 Planner schema 解析同一个文件）。
- 该缺陷只有真实回合能发现，单元测试（假子进程）永远无法暴露——这也是坚持先真跑再删 vendored
  的原因。
- 验证：`npx vitest run tests/planning tests/server` → 292 passed；`npx tsc --noEmit` 通过。

### P2-B4（切换默认 + 打包解耦）（2026-11-07）

- **默认传输切换**：`resolvePlanningTransport()` 空值现在是 `upstream-pi`；`vendored-planner`
  只能显式选择（临时 bisect/回滚用）。未知值仍直接抛错。
- **manifest**：`planner` 段改为可选；新增规则"一次发布必须至少提供 vendored planner 或
  打包 Pi 之一"；声明了 vendored planner 却没验证归档 → 失败。
- **打包**：`package-release.mjs` 的 `vendorPlanner = existsSync(plannerRoot)`，无 vendored 树时
  不生成 planner 归档、不写 manifest 段，只写 `pi` 段。
- **测试迁移**：7 个直接验证 vendored 组合的套件（supervisor 绑定校验、planner 驱动内核）
  显式 stub `METAWORK_MANAGER_TRANSPORT=vendored-planner`；`account-planner-services.test.ts`
  改为 `beforeEach`（该套件在用例内 `unstubAllEnvs`）。
- 验证：全量 `4694 passed / 0 failed / 39 skipped (664 files)`，`npx tsc --noEmit` 通过。
- 剩余：删除 `planner/AnyFusion-Pi`、`planner-process-supervisor`（1395 行）、`tui-bridge` RPC、
  `planner-mcp*`、`planner-runtime-home`，以及 34 个测试文件的引用；随后干净安装验收。

### P2-B4（MCP 归属迁移）Manager 通过 MetaWork MCP 读事实（2026-11-07）

- 产物：
  - `src/planning/manager-host/mcp-config.ts` —— 在隔离的 Manager 配置目录写 `mcp.json`
    （`command: process.execPath`、`args: [<moduleRoot>/dist/planner-mcp.js]`、显式 env、
    `enabled: true`、文件权限 `0600`），并提供 `resolvePlannerMcpEntry()`。
  - `src/planning/manager-host/composition.ts` —— 组合时若 MCP 入口存在则写入，并在返回值暴露
    `mcpConfigPath`；不存在时照常工作（不把"组件缺失"变成启动失败）。
  - 测试：`tests/planning/manager-planning-agent.test.ts` 增至 16 项（隔离 mcp.json 内容 +
    组合返回值）。
- 意义：`planner-mcp-server` 是**事实读取通道**（Task/artifact/memory），不是 vendored 专有代码；
  Manager 接管后它继续存在，只是从"vendored Planner 的 MCP 启动环境"改为"Manager 隔离配置里的
  mcp.json"。这样删除 vendored 时不会连带丢掉记忆/任务事实能力。
- 验证：`npx vitest run tests/planning tests/account tests/session` → 615 passed；`npx tsc --noEmit` 通过。

### P2-B4 剩余删除面（精确清单，下一步执行）

| 目标 | 依赖它的生产代码 | 处理方式 |
| --- | --- | --- |
| `planner-process-supervisor.ts`（1395 行） | `account-planner-services`、`account-runtime-composition`、`metaclaw-session`（`stopSession`）、`server-composition`（构造、`refreshBinding`/`clearBinding`、shutdown、blocked recheck、recovery planner runner） | 删除；配置激活时改为刷新 Manager 绑定；会话关闭改由 Manager 回合超时/关闭处理 |
| `anyfusion-planning-agent.ts` | `account-planner-services`（vendored 分支）、`detached-recovery-planner` | 删除；`detached-recovery-planner` 改用 `ManagerPlanningAgent` |
| `tui-bridge/*`（`PlannerHostBridge`） | `server-composition`（`plannerHost.start/registerSession/stop`、socket env） | 删除；TUI 入口在 P5-C 一并移除 |
| `planner-mcp-launch-env.ts`、`planner-runtime-home.ts` | 仅 supervisor | 删除 |
| `planner/AnyFusion-Pi/` | `release:planner` commandRef、打包、34 个测试/文档 | 删除；`manifest.planner` 随后改为禁止出现 |

### P2-B4（Provider 配置归属）Manager 自己的 models.json/settings.json（2026-11-07）

- 产物：`src/planning/manager-host/provider-config.ts`
  - `writeManagerProviderConfig()`：从**激活配置 revision** 渲染 Manager 的 `models.json` /
    `settings.json`（复用 `buildModelsJson`/`buildSettingsJson`，与 Executor 同一渲染器，不会漂移），
    原子写入（`.tmp` + rename，残留临时文件会被清掉），文件权限 `0600`。
  - `managerProviderEnv()`：按渲染器同样的命名规则把密钥映射成 `OPENAI_API_KEY` /
    `OPENAI_API_KEY__<REF>` / `ANTHROPIC_API_KEY__<REF>`；无密钥的 provider 直接省略（不写空值）。
  - `composition.ts`：`providerConfig` 输入 → 渲染配置 + 把 provider env 并入 Manager 显式环境。
  - 测试：`tests/planning/manager-provider-config.test.ts`（4 项：渲染两文件 / 变量命名 /
    单 provider 用裸变量 / 无密钥省略）。
- 意义：这是删除 `planner-runtime-home`（vendored 运行时 home 物化）的**前提**——Manager 的
  provider 认证不再依赖 vendored Planner 的启动环境。
- 验证：`npx vitest run tests/planning` → 239 passed；`npx tsc --noEmit` 通过。
- 剩余：组合根把 `providerConfig` 接上（需要从 SecretStore 异步解析 provider 密钥后传给
  `managerTransport`），然后按上一节清单执行删除与干净安装验收。

### P2-B4（组合根接线 + 生产路径真实回合）（2026-11-07）

- `src/server/server-composition.ts`：
  - 启动时从 `SecretStore` 逐个解析启用 provider 的密钥（`readProviderSecret`，
    容错：缺失/非法引用返回 null，不写空凭据），渲染 Manager 的 `models.json`/`settings.json`，
    再构造 `managerTransport.providerConfig`。
  - **配置激活/回滚失败**两个钩子都调用 `refreshManagerProviderConfiguration()`：模型或 provider
    变更后下一个规划回合即生效，不需要重启（对位删除 vendored supervisor 的 `refreshBinding`）。
- `tests/manual/manager-real-turn-from-config.test.ts`（opt-in）：**不再手写 models.json**，而是
  用 `FileConfigurationRepository` 读取本机激活 revision，走
  `writeManagerProviderConfig()` 渲染，再跑真实回合。
- 真实结果：`7.5s`、`revision: rollback-esktoppayload-…`、`providers: 7`、`models: 13`、
  `action: direct_reply`、4 次调用全部回报 usage、schema 校验通过。
- 意义：证明"删除 vendored runtime home 之后 Manager 仍能用激活配置认证"，这是删除动作的最后一块
  前提；同时暴露并修掉了一个真实接线错误（密钥解析最初被放进了 admin 分支，`tsc` 抓到
  `activeProviderKeys` 未定义）。
- 验证：`npx vitest run tests/server tests/account tests/session tests/planning` → 679 passed；
  `npx tsc --noEmit` 通过。

### P2-B4（解耦完成）规划不再经过 vendored Planner 进程（2026-11-07）

本轮把"生产代码对 vendored Planner 运行时的依赖"全部拆掉，但尚未删除文件：

| 变更 | 结果 |
| --- | --- |
| `account-planner-services` | 契约收窄为 `{ planningAgent }`：注入 → 直接用；否则按 `resolvePlanningTransport()` 走 Manager；`vendored-planner` 仅接受显式注入的 legacy agent；生产环境缺 transport 直接抛错（测试环境给一个"一用就报错"的占位 agent，避免静默跑空） |
| `account-runtime-composition` | 暴露 `plannerServices`；不再向 planner services 传 db/binding/supervisor |
| `metaclaw-session` | 删除 supervisor 字段与 `stopSession` 调用；会话收尾不再触达任何 Planner 进程 |
| `account-runtime` | `cancelPlannerTurn` 不再 abort planner session（Manager 无 per-session 进程），改为解析完成 |
| `detached-recovery-planner` | **删除 host bridge 依赖**：恢复期规划直接调用账户 `PlanningAgent`，在同一进程内用 `PlanningAgentPlanSchema` + `validatePlanningAgentPlan` 校验；重写为 5 项测试（成功/证据不可用/非法 schema/已中止/中途中止） |
| `server-composition` | 恢复规划改用 `accountRuntimeComposition.plannerServices.planningAgent` |

验证：全量 **4703 passed / 0 failed / 40 skipped**；`npx tsc --noEmit` 通过。

剩余（纯文件删除 + 收口）：
1. `planner-process-supervisor.ts`、`anyfusion-planning-agent.ts`、`planner-runtime-home.ts`、
   `planner-mcp-launch-env.ts`、`tui-bridge/*`——现在已无生产调用方，只剩 `server-composition`
   仍构造 supervisor/host 用于配置激活刷新与 shutdown，需把这些调用点删除。
2. `planner/AnyFusion-Pi/` 目录与打包 `release:planner` 引用。
3. `manifest.planner` 收紧为禁止出现；干净安装验收。

### P2-B4（文件删除）vendored Planner 运行时移除（2026-11-07）

删除（`git rm`）：
- `src/planning/planner-process-supervisor.ts`（1395 行）
- `src/planning/anyfusion-planning-agent.ts`
- `src/planning/planner-runtime-home.ts`、`src/planning/planner-mcp-launch-env.ts`
- `src/tui-bridge/`（`planner-host-bridge.ts`、`planner-host-protocol.ts`，目录已空）
- 专属测试：`tests/planning/planner-process-supervisor.test.ts`、
  `tests/planning/anyfusion-planning-agent.test.ts`、`tests/planning/planner-runtime-home.test.ts`、
  `tests/tui-bridge/*`、`tests/acceptance/task8-cross-repository-contract.test.ts`（+ 两个 fixture +
  `scripts/task8-emit-pi-proposal.mjs`）、`tests/e2e/web-image-planner-flow.test.ts`
- `tests/session/planner-process-lifecycle.test.ts` 改写为"会话收尾不再触达 Planner 进程且幂等"

`src/server/server-composition.ts`：
- 删除 `PlannerHostBridge`/`PlannerProcessSupervisor` 构造、socket 环境变量
  （`METACLAW_PLANNER_HOST_SOCKET`/`METACLAW_PLANNER_TUI_SOCKET`）；
- 配置激活与回滚失败的 `refreshBinding`/`clearBinding` 删除（已由
  `refreshManagerProviderConfiguration()` 取代）；
- 会话 `dispose` 不再注销 planner host；会话删除不再 `stopSession`；
- `stopPlanner` 变为空操作（规划在 Manager 回合内，由账户 registry 关停）；
- 删除 `plannerModel`/`plannerRuntimeEnvironment`/`resolvePlannerRuntimeEnvironment` 残留。

架构测试同步：`current-client-runtime-topology`（断言 `managerTransport` 而非
`plannerHost.registerSession`）、`no-direct-client-session-paths`/`unified-server-composition`
（客户端适配器只剩 gateway/management/integrations）、`production-composition`
（drain 顺序对位账户 registry 关停）。

验证：全量 **4632 passed / 0 failed / 40 skipped**；`npx tsc --noEmit`、`npm run build` 通过。

剩余：删除 `planner/AnyFusion-Pi/` 目录本身，以及 installer/configuration/scripts 里的
`release:planner`、`planner/AnyFusion-Pi` 引用（`src/installation/source-native-installer.ts`、
`src/configuration/staged-legacy-configuration.ts`、`src/configuration/*`、`scripts/smoke-*.mjs`、
`scripts/dev-desktop.mjs`），随后干净安装验收。

### P2-B4 完成：vendored Pi 目录与安装/配置引用移除（2026-11-07）

- 删除 `planner/AnyFusion-Pi/`（985 个受版本控制文件；磁盘残留 `node_modules`/`dist` 一并清掉，
  `planner/` 目录已不存在）。
- `src/installation/source-native-installer.ts`：`plannerRoot` 变可选；`stageSourceRelease()` 只在
  调用方仍提供时 staging vendored 树；`BuildSourceMetadata.plannerRoot` 可选；
  planner harness 的 `commandRef` 由 `release:planner` 改为 `release:pi`。
- `src/build/build-command.ts`：`metawork build` 不再强制 Planner 源码，也不再跑 vendored
  `build:offline`；不传 `--planner-root`。
- `src/configuration/staged-legacy-configuration.ts`、`smoke-configuration.ts`、
  `legacy-configuration-reader.ts`：`commandRef` 同步为 `release:pi`。
- Planner 系统提示迁移到 `src/planning/manager-host/extension/index.ts` 并补上分解策略
  （独立流并行根 + 汇总子任务、一次一个 graph、`work_graph_quality`），
  `tests/planning/planner-decomposition-policy.test.ts` 改为断言扩展源码。
- 删除随架构消失的测试：`no-client-runtime-ownership`、`gateway-protocol-mirror`、
  `native-tui-gateway`、`navigation-tui-history`、`task-state-regressions`、
  `build-release-script` 的 husky/vendored-planner 用例。
- 文档：`AGENTS.md` 与 `CONTEXT.md` 中关于 vendored fork / Planner host socket / vendored TUI 的
  表述改为 Manager 传输事实。
- 验证：全量 **4593 passed / 0 failed / 40 skipped**；`npx tsc --noEmit`、`npm run build` 通过；
  真实回合（配置驱动）`valid: true`。

### P5-C 移除终端入口（2026-11-07）

- `src/cli/args.ts`：新增 `{ kind: 'tui-retired' }`；裸 `metawork` 与 `metawork tui` 都解析到它，
  不再解析 TUI 参数、不再启动客户端；帮助文本删除 `metawork tui`，改为一句"TUI 已移除，裸命令只打印
  启动提示"；`--script`/`--connect` 的替代提示改为 `server start` + `web`。
- `src/index.ts`：`runRetiredTuiNotice()` 打印"启动 Runtime：metawork server start / 打开 Web
  客户端：metawork web"，**退出码 0**（D-H）。
- 删除 `src/client/tui-client-launcher.ts`（它启动的 vendored Pi TUI 已随 `planner/` 删除）与
  其测试；`runClientCommand` 只处理 web。
- 架构测试 `current-client-runtime-topology` 改为断言"CLI 不含 TUI launcher、入口有 retired 提示"。
- 验证：全量 **4587 passed / 0 failed / 40 skipped**；`npx tsc --noEmit`、`npm run build` 通过；
  `node dist/index.js` → 打印提示并 `exit=0`。
