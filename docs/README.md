# MetaWork Documentation

[Desktop 无模型安装与内部版本升级修复](plans/2026-10-08-desktop-model-free-installation.md)：
无模型安装已实现；首次启动不要求填写模型信息。
[Finder 更新进程修复](plans/2026-10-08-desktop-finder-update-lifecycle.md)
已修正后台生命周期、内部包签名和更新进度提示；v0.1.17 DMG 与 Runtime 已发布到 GitHub。

MetaWork is the proprietary commercial product represented by this repository.
AnyFusion references identify the separate open-source upstream, attributed
components such as `AnyFusion-Pi`, compatibility contracts, or historical
records.

Current release: [v0.1.19 publication plan](plans/2026-10-20-v0.1.19-release.md).

Current release reliability work is tracked in
[Customer Desktop upgrade reliability](plans/2026-10-08-customer-upgrade-reliability.md).

This directory contains both current technical documentation and historical planning material. Start with the current docs before opening dated plans.

## Current Docs

- [Web 用户路径验收测试报告](current/2026-10-27-web-acceptance-test-report.md)（2026-10-27）：真实浏览器对照架构 A1–A17、Memory 五组与滚动 12 景验收；结论为未通过，含 P0 阻断（同会话追问被 Kernel 拒绝、失败任务不释放会话槽位、Run Contract `serviceIntent` 生产路径缺失）与证据截图。

- [Agent 执行架构重构方案](plans/2026-10-27-agent-execution-architecture-realignment-plan.md) 与 [技术实施方案](plans/2026-10-27-agent-execution-architecture-realignment-implementation-plan.md)：收敛 Planner → Work Graph → Kernel → Executor 链路，让 Runtime 不再干预 Harness 内部循环。已固化“Executor 内部失败由 Harness 消化、MetaWork 验收失败默认反馈 continuation、只有硬边界或预算耗尽才交给用户”的原则。P0/P1/P2 已实施：Run Contract 投影、服务身份与失败修复 continuation（ADR-0051）、失败诊断进入 Planner 与 Executor、终态 Task 自然取代、In-place 交付语义收敛；实施记录与未完成项见文档末尾。

- [Executor Pi 打包入口修复](plans/2026-10-23-executor-pi-packaging-fix.md)：修正本地 DMG 将 Executor 指向定制 Planner 的错误，增加打包与安装参数校验，修复包已完成本地自动验收。

- [单一 In-place Workspace 技术实施方案](plans/2026-10-25-in-place-only-workspace-execution-implementation-plan.md)：已于 2026-10-25 实施。新任务直接在 Conversation 绑定 Workspace 执行；只读任务使用受控 scratch，不申请写租约，不创建 publication；旧 Worktree 事实只停放并拒绝恢复（ADR-0050）。
- [Workspace 内部版本库与会话 Worktree 并行模型](plans/2026-10-29-workspace-internal-git-session-worktree-design.md)：待评审方案。为 Git 与非 Git Workspace 建立统一内部版本库，让可写 Session 使用独立 Worktree 并行执行，通过持久化 Merge Queue 串行合并，并将受管服务绑定到 Application Revision。
- [被取代的 Planner Workspace 模式设计](plans/2026-10-25-planner-owned-workspace-mode-design.md)：历史方案，仅用于理解迁移背景。
- [Executor 工具能力与 Kernel 边界（ADR-0052）](adr/0052-executor-owned-tool-capabilities-and-kernel-boundary.md)：Planner 的 Workspace effect 只用于 admission 与验收；Harness 自己拥有工具注册和内部执行循环，Kernel 保留持久化协调与恢复，不再把 `read_only` 转成工具 allowlist。
- [Planner、持久协调与 Executor 权责（ADR-0053）](adr/0053-planner-graph-coordinator-and-executor-authority.md)：重新审查 Kernel 边界；Planner 只负责语义和 Work Graph，Executor/Host 负责工具与 capability policy，剩余 Kernel 仅作为迁移期的 durable Task Coordinator。

- [斜杠指令参考](current/commands.md)：唯一的当前指令清单与 Desktop/Web 联想说明；[精简与联想验收记录](plans/2026-10-22-command-simplification-and-desktop-completion.md)。

- [记忆系统接入 TencentDB Agent Memory 设计方案](plans/2026-10-22-memory-system-tdai-integration-design.md)：记忆体系现状审计（采集/晋级/送达三处断链）、以 TDAI 为唯一记忆引擎的目标架构、记忆沉淀契约、证据投递 pull 语义、开关与 Provider 配置、凭证纪律及 ADR 影响；已实施，见 [ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md) 与文档末尾的实施记录。

- [Server 级 Memory 合并前修复方案](plans/2026-10-26-server-scoped-memory-pre-merge-remediation.md)：保持 Server-owned `MemoryRuntimeController`，把 memory 增量接到 schema 59，退役旧 preferences/learning/reflection 链路，并修复 disabled/degraded 召回、degraded 管理面与两小时沉淀兜底。
- [Provider 归属与内置记忆引擎](plans/2026-10-26-provider-ownership-and-bundled-memory-engine.md)：Provider 卡片只来自激活配置，completion/本机发现/公开目录不再生成卡片，删除 Provider 在激活成功后清理凭据；TDAI 记忆引擎作为 `memory` artifact 随发布包分发到 `<releaseRoot>/memory/tdai`，打包前断言 FTS5，UI 区分「引擎缺失」与「FTS5 不可用」。

- [任务状态简化设计](plans/2026-10-22-task-state-simple-design.md)：统一六个状态、转换规则、队列规则及跨模块一致性的产品目标；[技术落地方案](plans/2026-10-22-task-state-implementation-plan.md)细化源码入口、唯一事务提交、操作收尾、恢复迁移与跨端联动验收。源码实施与评审修复已验证，安装/发布门槛尚未关闭；详见[修复验收记录](plans/2026-10-22-task-state-review-fixes.md)。

- [任务验收、公开交付与受管服务](tech-debt/task-acceptance-and-local-service-findings.md)：接受/重试、稳定公开目录、完整代码发布及服务生命周期已完成源码实施与原生案例验证；[实施与验收记录](plans/2026-10-21-task-acceptance-and-managed-services.md)。安装与平台门槛单独记录。

- [MetaWork v0.1.19 发布计划](plans/2026-10-20-v0.1.19-release.md)：发布当前源码到 macOS arm64/x64、Linux x64 和 Apple Silicon Desktop；Windows 保持不发布。

- [执行配置误阻塞与对话状态展示修复](plans/2026-10-19-execution-configuration-and-notice.md)：修复配置排序导致的内容校验失败，将阻塞原因、子任务影响和恢复说明分层展示；源码验收完成，尚未安装发布。
- [上游输入失败后的恢复修复](plans/2026-10-17-blocked-upstream-recovery-fix.md)：保留完成阶段、显式恢复、重规划引用校验及本地 DMG 验收。
- [Desktop 退出与升级恢复修复](plans/2026-10-17-desktop-exit-recovery-fix.md)：旧进程卡住清理、重连及本地 DMG 验收。

- [富文档预览](plans/2026-10-15-rich-document-preview.md)：HTML、Word、PPT、Excel 和 PDF 的本地预览、附件入口及 Web/Desktop 验收。
- [对话表格与图表](plans/2026-10-16-conversation-tables-and-charts.md)：完整 Markdown 表格、离线交互图表、分析师输出约定与浏览器/桌面验收。
- [任务执行结果、验收与用户状态收敛](plans/2026-10-16-task-execution-user-state-convergence-plan.md)：安全未认证结果的用户决策闭环，以及四态用户状态投影。

- [历史会话空白修复](plans/2026-10-10-history-viewport-restore-fix.md)：修复 Desktop 重启后长报告滚动位置恢复导致的空白，历史内容无需重建。

- [官方账号服务运行与验收](current/official-account-operations.md)：huoshan 部署、管理入口、凭证停用、隐私与验收证据。

- [Pi 随应用维护与可选执行工具接入方案](plans/2026-10-09-managed-pi-and-optional-tools-design.md)：v0.1.14 arm64 DMG 与自动验收完成并已发布；Pi 随 MetaWork 维护，Codex 支持自动发现与路径配置，其缺失不阻断应用更新。

- [PDF 处理与执行卡住修复方案](plans/2026-10-06-pdf-processing-and-executor-stall-repair.md)：已完成原生 macOS arm64 实施与验收；补齐 DeepSeek Flash 视觉输入、系统 Pi 的 PDF 能力接入、持续无活动检测与真实进度展示，不限制正常长任务总时长。

- [智能体基础操作与职责分工](plans/2026-10-06-agent-baseline-permissions-design.md)：本地代码、原生与 Electron 验收完成，Docker 实跑待验收；取消研究/工程权限二选一，基础操作默认可用，职责负责分工，敏感操作沿用系统授权。

- [设置激活去除 Planner 依赖](plans/2026-10-05-settings-activation-without-planner.md)：保存不触发 LLM，内部 AI 使用独立服务。

- [自然语言能力优先的任务路由](plans/2026-10-05-description-first-routing.md)：取消泛化标签和关键词打分，保留执行条件校验。

- [内部 LLM 服务](current/internal-llm-service.md)：官方固定业务接口、AI 改写与画像提炼，以及旧研发配置停用边界。

- [Repository Agent Guide](../AGENTS.md): fastest onboarding path, current
  contract versions, module ownership, runtime invariants, entry points, and
  validation rules.
- [Technical Overview](current/technical-overview.md): the previous long-form README, preserved as the current deep architecture and runtime reference.
- [中文技术总览](current/technical-overview.zh-CN.md): the previous long-form Chinese README, preserved as the Chinese deep architecture and runtime reference.
- [Phase 5 Runtime Security And AgentClass Operations](current/phase-5-runtime-security.md): In-place Executor 进程、只读 scratch、Docker 兼容尝试、镜像 profile 和运行时权限操作。
- [Account Runtime And Gateway Operations](current/account-runtime-and-gateway-operations.md): unified Server lifecycle, account data paths, Gateway replay, restart/recovery diagnostics, and the future App transport contract.
- [Query Usage And Billing Operations](current/query-billing-operations.md): ADR-0042 delivery status, `observe -> shadow -> export` stage gates, per-resource capability matrix, price/payer operations, external consumption protocol and rollback/restore rules.
- [Task Lifecycle State Contracts](current/task-lifecycle-state-contracts.md): canonical Task/Subtask/Attempt/Kernel-application/WorkUnit/slot state ownership, Task transition table, durable Replan Job idempotency rules, uncertain-application postconditions, and the unified TaskView projection priority.
- [Repository README](../README.md): public project overview, install path, repository structure, and high-level architecture.
- [CONTEXT](../CONTEXT.md): current PlanningAgent, ControlKernel, decision-ledger, and work-unit vocabulary.

## Releases

- [MetaWork v0.1.19 Release](https://github.com/IFOSR/metawork/releases/tag/v0.1.19): Apple Silicon Desktop DMG and signed macOS/Linux Runtime/Planner archives.
- [AnyFusion v1.2.0 Preview](releases/v1.2.0-preview.0.md): public preview highlights, architecture summary, deployment status, and known limitations.
- [MetaWork v1.2.0 Preview 6](releases/v1.2.0-preview.6.md): historical preview release matrix and build notes.
- [MetaWork v0.1.7 Internal Release](releases/v0.1.7.md): latest macOS arm64 internal release with host CLI discovery and compact readiness notices; Apple signing/notarization remain pending.
- [MetaWork v0.1.4 Release](releases/v0.1.4.md): historical stable release with redesigned settings, description-first routing, independent settings AI, and corrected GitHub installation downloads.
- [MetaWork v0.1.3 Release](releases/v0.1.3.md): previous stable release with multi-client observation features.
- [Changelog](../CHANGELOG.md): public release history.

## Architecture Decisions

Use the [ADR authority index](adr/README.md) before opening individual decisions. It records the required reading order, current topic owner and archive policy. ADRs under [archive/adr/](archive/adr/) are historical and must not guide new implementation.

Key recent ADRs:

- [ADR-0011: Single Active Task Admission Gate](adr/0011-single-active-task-admission-gate.md)
- [ADR-0015: Planner-Owned Semantics And Tool-Mediated Context](adr/0015-planner-owned-semantics-and-tool-mediated-context.md)
- [ADR-0017: Kernel Executor Status Projection](adr/0017-kernel-executor-status-projection.md)
- [ADR-0018: Supported Routing Contracts And Unified Executor Definitions](adr/0018-supported-routing-contracts-and-unified-executor-definitions.md)
- [ADR-0020: Core Module Ownership And Dependency Direction](adr/0020-core-module-ownership-and-dependency-direction.md): normative module and dependency guide for the active convergence roadmap.
- [ADR-0022: Unified Kernel Control Plane And Decision Ledger](adr/0022-unified-kernel-control-plane-and-decision-ledger.md): current event, snapshot, decision, ledger, Subtask and synchronous-loop contract delivered by Phase 3.
- [ADR-0023: Durable Kernel Workflow, Recovery And Availability](adr/0023-durable-kernel-workflow-recovery-and-availability.md): Phase 4 durable inbox/application/outbox, recovery, structured failure, retry/fallback, availability, continuation and graph revision authority.
- [ADR-0024: Resource Partition, Sandbox And Runtime Elevation](adr/0024-resource-partition-sandbox-and-runtime-elevation.md): Phase 5 resource identities, Docker attempts, persistent workspaces, leases and structured permission elevation.
- [ADR-0025: Single-Task Concurrency And Git Publication](adr/0025-single-task-concurrency-and-git-publication.md): Phase 6 runnable frontier, batch dispatch, asynchronous attempts, Git-backed workspaces and publication.
- [ADR-0026: Phase 6 Single-Task Reliability Closure](adr/0026-phase-6-single-task-reliability-closure.md): final Phase 6 scope, reliable Task termination/recovery closure and deferral of multi-Task scheduling.
- [ADR-0031: Account Runtime And Unified Client Gateway](adr/0031-account-runtime-and-unified-client-gateway.md): delivered account-scoped Runtime ownership, conversation isolation, one Gateway command/event plane, and TUI/Web/Feishu convergence.
- [ADR-0032: Result-First Delivery And Completion Certification](adr/0032-result-first-delivery-and-completion-certification.md): Completion Protocol v4, immutable Result Objects, authorized ResultReferences, chunked delivery, and safe partial-result recovery.
- [ADR-0033: Hot Configuration Activation And Auto Model Routing](adr/0033-hot-configuration-activation-and-auto-model-routing.md): AccountRuntime activation gate, concrete Planner/Executor Auto routing, safe completion, and read-only Work Graph presentation.
- [ADR-0034: Independent Server And Client Process Lifecycle](adr/0034-independent-server-and-client-process-lifecycle.md): persistent workspace-neutral Server, independent TUI/Web Clients, endpoint discovery, Workspace admission, draining, and Server-owned Feishu connectivity.
- [ADR-0053: Planner Graph, Durable Coordinator And Executor Authority](adr/0053-planner-graph-coordinator-and-executor-authority.md): Planner decomposition, durable graph coordination, Executor/Harness capability ownership, and the removal of Kernel as a security layer.

[ADR-0021: Work Graph v4 And Subtask Execution Contract](adr/0021-work-graph-v4-subtask-execution-contract.md)
is the foundational dependency/handoff/completion contract. ADR-0025/0026
evolved the active graph to v5 for concurrent dispatch and publication without
replacing those semantics.

## Local Implementation Pending Validation

- [长期记忆接入 TDAI](plans/2026-10-22-memory-system-tdai-integration-design.md)：记忆引擎接入、沉淀调度、证据投递与设置页管理面已完成源码实施与本地端到端验证（真实引擎回路 + 用户旅程用例）；等待真实账号的体感验收。

- [轨迹页执行计划内嵌 DAG](plans/2026-10-03-work-graph-inline-dag.md)：卡片内展示真实依赖箭头、并行分支与汇合，节点选择联动详情，支持移动端滚动；本地实现并验证，未部署。
- [TUI Workspace task dashboard and switching](plans/2026-10-03-tui-workspace-task-dashboard.md): workspace task overview, task-to-Turn navigation and independent drafts; local only pending user validation.

## Completed Roadmap

- [Web stop live-state fix](plans/2026-09-21-web-stop-live-state-fix.md): cancellation cleanup publishes a terminal Turn trace; Web preserves terminal state against late answers and progress so the Composer returns to Send without reloading.
- [Web session workspace redesign](plans/2026-08-17-web-session-workspace-redesign.md): persistent session rail, safe single-live-session activation, detailed Conversation narrative, dense Trajectory view, and sticky composer.
- [Planner progress streaming](plans/2026-08-17-planner-progress-streaming.md): streams safe Planner lifecycle and tool progress into the existing Web interaction trace without exposing hidden reasoning or raw model/tool content.
- [Web interaction trace and Planner socket reliability](plans/2026-08-17-web-interaction-trace-and-planner-socket-reliability-design.md): completed shared composition locking, Planner Host socket ownership protection, preserved transport uncertainty, and the streaming redacted Web execution trace.
- [AnyFusion Pi Planner and native TUI migration](plans/2026-07-31-pi-planner-tui-migration.md): completed unified interactive/RPC Planner runtime, fixed AnyFusion-managed models, read-only Task dashboard, native command completion, and strict Planner/Kernel/Executor process separation.
- [Planner、Kernel 与并发调度收敛路线图](plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md): completed convergence from capability-aware work graphs and executor scope through the Kernel control plane, resource partitions, single-Task DAG concurrency, Git publication and reliable asynchronous cancellation/recovery.
- [Phase 6 final reliability closure](archive/plans/2026-07-28-phase-6-single-task-reliability-closure.md): SQLite v27 cancellation/replan facts, durable Task/Subtask cleanup, explicit partial acceptance and the strict completion gate.
- [Executor error recovery refresh](archive/plans/2026-07-30-executor-error-recovery-refresh.md): completed Kernel v5 / SQLite v28 event-driven `error -> healthy` recovery, same-thread Planner revision, and deferred availability proposal lifecycle.

## Completed Delivery

- [TUI review fixes](plans/2026-09-20-tui-review-fixes.md): review follow-up for
  socket query parsing, completion ordering, navigation, Task/Attempt projection,
  history paging, authoritative permissions and client entry dependency isolation.

- [Web workspace creation and login](plans/2026-09-16-web-workspace-creation-and-login.md): delivered the cookie-only Web workspace browser and one-time launch directory hint. Its original Admin password gate is superseded: the local transport Cookie is now created automatically and official account login owns the user identity and entitlement boundary. The workspace path and launch-context contracts remain governed by [ADR-0039](adr/0039-web-workspace-creation-and-login.md).
- [Executor idle timeout and retry presentation](plans/2026-09-10-executor-idle-timeout-and-retry-presentation.md): delivered an idle-only Executor watchdog with no overall attempt-duration limit, operation-aware timer pausing (superseded by the 2026-10-06 PDF/stall plan’s continuous observation), and Web continuity across Kernel-authorized retry.
- [Web Turn-Task presentation isolation design](plans/2026-09-10-web-turn-task-presentation-isolation-design.md): defines `Conversation -> Turn -> Task -> Subtask -> Attempt` presentation ownership while preserving complete Conversation history.
- [Web Turn-Task presentation isolation implementation](plans/2026-09-10-web-turn-task-presentation-isolation.md): delivered monotonic Turn-to-Task binding, exact historical trajectory selection, mixed-history filtering, and current Conversation record refresh.
- [Web Workspace switch reliability](plans/2026-09-10-web-workspace-switch-reliability.md): delivered navigation-only serialization, request generation guards, and stable message-to-Conversation targeting without reducing execution concurrency.
- [Pi 图片执行方案切换设计](plans/2026-09-01-pi-image-execution-strategy-switch-design.md): delivered the composite `pi-agent` Executor, standard Pi CLI for ordinary work, MetaWork Image API Runner for image generation/editing, native and Docker compatibility paths, and removal of the vendored Planner image fallback.
- [Planner、MetaWork 与 Executor 上下文连续性设计](plans/2026-09-02-planner-metawork-executor-context-bridge-design.md): delivered Planner-owned semantic continuity, bounded MetaWork Context Bridge facts, `artifact` Work Graph references, deterministic ownership/status/hash validation, attempt-local Artifact materialization, and image continuation support.
- [统一 Executor 能力画像与路由投影设计](plans/2026-08-31-unified-executor-capability-profile-design.md): delivered one revision-scoped profile per Executor, profile-derived Chinese Skill-style manuals and Routing Catalog qualification, model/user capability evidence, user-priority dispositions, source-preserved interpretation fallback, image-model qualification, production Planner direct-reply rejection, and capability-profile Web preview/diff.
- [Planner Executor capability manuals](plans/2026-08-30-planner-executor-capability-manual-design.md): delivered per-Executor Skill-style manuals derived from effective Models, semantic user-guidance merge with user precedence, bounded Planner projection, revision-pinned runtime artifacts, Web guidance editing, and production semantic `direct_reply` rejection.
- [Planner direct Web access design](plans/2026-08-30-planner-direct-web-access-design.md): delivered bounded read-only `web_fetch`/`web_search` in semantic Planner turns, fixed-IP SSRF protection, whole-operation deadlines, and mandatory Executor routing for side effects or schedulable work. The [implementation plan](plans/2026-08-30-planner-direct-web-access-implementation-plan.md) records TDD, build, live Web, and independent review evidence.
- [Workspace-scoped Conversation organization design](plans/2026-08-27-workspace-scoped-conversation-organization-design.md): delivered the Account Workspace Catalog, immutable Conversation v3 bindings, Gateway v2 Workspace Directory/activity projection, connection-scoped query pages, stream-scoped replay cursors, shared Web/TUI/Feishu navigation, bounded attach-only detail replay, migration/recovery/security gates, and real native independent Server/TUI/Web lifecycle acceptance. The [implementation plan](plans/2026-08-27-workspace-scoped-conversation-organization-implementation-plan.md) records the implementation sequence and final validation evidence.
- [Client default Workspace and visibility](plans/2026-08-27-client-default-workspace-design.md): delivered completion-confirmed, initialize-if-unset Client defaults for new TUI/Web Conversations, durable Workspace restore for attached Conversations, Server-confirmed Workspace projection across Clients, secure path-free Web bootstrap, authenticated Principal admission, Feishu confirmation, and real multi-client Gateway lifecycle validation. The [implementation plan](plans/2026-08-27-client-default-workspace-implementation-plan.md) records the TDD sequence and final validation evidence.
- [Account Runtime and unified Gateway implementation plan](plans/2026-08-18-account-runtime-unified-gateway-implementation-plan.md): delivered account-wide Runtime/Kernel ownership, account-isolated install/update authority, durable Conversations, versioned Gateway replay, startup recovery, and Web/Feishu/TUI/Unix/script cutover. The [approved design](plans/2026-08-18-account-runtime-unified-gateway-design.md) records the implemented topology and migration gates.
- [Completion Protocol result-first delivery](plans/2026-08-20-completion-protocol-result-first-design.md): delivered Completion Protocol v4, immutable Result Objects, authorized ResultReferences, chunked replay, Kernel uncertified-result recovery, historical result upgrades, and complete safe Harness-result delivery. Real Web/API E2E and the full release validation gate passed.
- [Execution reliability and live progress](plans/2026-08-24-execution-reliability-and-live-progress.md): delivered dependency readiness/materialization recovery, Kernel-authorized resume, multi-turn result retention, durable Executor progress replay, Web detail streaming, and passive native/Feishu progress projection.
- [Web routing identity and workspace presentation](plans/2026-08-25-web-routing-identity-and-workspace-presentation.md): delivered revision-pinned public Provider/Model/Executor/Harness names, canonical Subtask cards, user-readable Attempt projection, a Conversation-only Composer, and system/light/dark themes. The [implementation plan](plans/2026-08-25-web-routing-identity-and-workspace-presentation-implementation-plan.md) records TDD and native Chrome acceptance evidence.
- [Pi TUI system command and AI task separation design](plans/2026-08-28-pi-tui-system-command-separation-design.md): delivered the existing `pi-tui`-preserving separation of compact system commands from real AI turns, command-specific waiting, replay-safe reducer/view projections, terminal interaction fixes, and the follow-up correction that keeps background Task/Executor execution visible after a command returns. The [implementation plan](plans/2026-08-28-pi-tui-system-command-separation-implementation-plan.md) records the completed TDD sequence and real Server/TUI/Web acceptance evidence.
- [附件资源贯穿 Planner、MetaWork 与 Executor 的设计](plans/2026-09-17-attachment-document-ingestion-and-paste-design.md): delivered the opaque attachment contract in which Planner understands intent and selects attachment references, MetaWork stores/validates/materializes originals, and Executor processes attempt-local inputs. Includes unified Web click/drop/paste upload. The 2026-09-18 revision removed the MetaWork-provided document parser: the routed Executor's base model and its own tools own parsing.
- [附件资源执行实施计划](plans/2026-09-17-attachment-resource-execution-implementation-plan.md): delivered attachment storage, Planner metadata projection, Kernel eligibility, attempt-local materialization, document-processing routing, Web migration, and local validation evidence. The standalone document-reader bundle was reversed on 2026-09-18. Docker image validation remains network-blocked.

## Active Delivery

- [一期账号授权与官方内置 AI 最终方案](plans/2026-10-09-account-license-and-managed-internal-ai-design.md)：实施中，官方服务已部署；真实模型联调待配置。Web/Desktop 登录归属本机 Server，TUI/飞书共享状态；单当前官方账号、无硬件绑定或短租约，活动任务每日后台核验，内置模型配置与密钥仅由官方维护。

- [ADR-0047: 官方账号授权与内置 AI](adr/0047-account-license-and-official-ai.md)：一期实现边界、授权核验和官方服务职责。

- [ADR-0048: 官方账号支付结算与退款通道](adr/0048-official-account-payment-settlement.md)：回调唯一授权、attempt 历史幂等结算、整数分金额、append-only 退款恢复、仅管理端退款与支付 incident 台账；本地实施完成，部署验收待办。[方案](plans/2026-10-14-official-account-payment-integration.md)。

- [Desktop 接入已有 Web Runtime](plans/2026-10-08-desktop-existing-runtime-adoption.md)：同版本复用与工具补齐、旧版本原地升级、数据保留及联合激活回滚验证。

- [v0.1.5 Web 与 Desktop 联合发布](plans/2026-10-07-v0.1.5-release.md)：准备中；统一版本、完整产物发布校验及中英文安装入口。正式签名与线上发布尚未完成。

- [MetaWork Desktop macOS 首版方案](plans/2026-10-05-metawork-desktop-design-review.md)：已批准、实施中。Electron 壳与正式 Web 产物已通过本地 smoke；签名依赖包、干净机器与联合更新发布验收尚未完成，详见[实施记录](plans/2026-10-05-metawork-desktop-implementation.md)。

- [前端观察与多端统一控制](plans/2026-10-02-frontend-observation-implementation.md)：按 ADR-0043 实施有界读模型、快速切换、跨端同权与独立通知路由；代码仅在本地，尚未完成全部验收。

- [配置生命周期、执行可观测性与准入可靠性方案](plans/2026-10-01-execution-observability-and-configuration-reliability-design.md)：待 Review。统一记录启用态配置校验、画像草稿与 revision 激活边界、Release Workspace 授权、完整 Trace 分页回放、Timeline 公共路由身份、Planner/Kernel 阶段展示和模型价格准入方案；当前尚未实施。
- [统一智能体与模型路由、决策模型配置及执行错误可观测性设计](plans/2026-10-10-unified-routing-decision-model-and-execution-errors-design.md)：已实施，v0.1.14 已发布。统一定义 Planner/DAG、AgentClass 与 Model 的联合路由、Provider 化决策模型设置、Workspace 自包含检查、附件/截图消息展示，以及按阶段和稳定错误码呈现执行失败。
- [Navigation performance architecture remediation](plans/2026-09-26-navigation-performance-architecture-remediation.md):
  indexed Workspace directory, Conversation history paging, physical enrichment
  batching, request convergence, segmented snapshot/journal maintenance and
  indexed command admission. Source schema 46 adds the durable Retry Wake facts
  and latest Task-creation ordering key;
  schema 44 remains canonically installed until the next native upgrade. Real Web/TUI
  navigation/reconnect and process-level recovery checks are recorded.
  Final acceptance remains open, including the provisional creation budget
  and production background-work/crash gates; fixture results are not rollout proof.
- [Retry Wake state-machine remediation](plans/2026-09-27-retry-wake-state-machine-remediation.md):
  source schema 45 durable timeout continuation (carried by current schema 46),
  atomic `wait_for_retry`
  postconditions, account-scoped Timer delivery, exact wake identity, and
  explicit stale/recovery convergence. Canonical installation remains schema 44
  until the native upgrade gate and live restart/TUI/Web acceptance close.
- [Task lifecycle state convergence](plans/2026-09-25-task-lifecycle-state-convergence-implementation-plan.md): core structure implemented, closure acceptance not completed. Delivered canonical Task/Subtask/Attempt lifecycle ownership with the single Task/Work Graph transition port, the durable `schedule_replan` Job plus account-scoped Planner Worker, per-family uncertain-application postconditions, residue-driven Conversation slot release, and the read-only TaskView projection consumed by TUI/Web/Feishu. Two 2026-09-25 review rounds plus the 2026-09-26 correction fixed real defects in the Planner-failure control chain, the startup/periodic recovery entry, the `block_work`/`resume_task`/deferral postconditions, the duplicated residue check, Planner-turn idempotency and claim fencing, plan-activation and dispatch authorization identity, the activity-card projection, the Subtask lifecycle owner wording, and missing-target handling for `block_work`; see the plan §13, which is a defect list rather than a closure claim. Real Server-restart, TUI-reconnect, Web-attach and live Planner-fault acceptance remain unexecuted. Contracts: [Task lifecycle state contracts](current/task-lifecycle-state-contracts.md).
- [Incomplete response resume repair](plans/2026-09-24-incomplete-response-resume-fix.md): bounded explicit recovery for incomplete model streams, authoritative control-command results, newest-result projection, and live research-task validation.
- [统一 Gateway 完整 Pi TUI 详细设计](plans/2026-09-19-unified-gateway-full-pi-tui-design.md)：已实施并由 [ADR-0041](../adr/0041-single-tui-convergence-and-gateway-read-only-queries.md) 治理。唯一 MetaWork TUI（Gateway-only Client）交付多 Turn 展示模型、Pi 编辑器/主题/组件、Task Dashboard、只读 `complete_command`/`get_task_view`；简版客户端、vendored 本地交互 Agent TUI 与 `src/tui/` Ink 面及其依赖/开关已删除；Server Planner RPC 与 Web/Feishu 行为保留。macOS PTY 三尺寸终端验收与 `smoke:gateway`/`smoke:clients` 通过；Docker 因镜像仓库不可达未执行，真实 Planner/飞书依赖外部环境未执行（见计划 §18.3）。
- [执行助手空闲态管理设计](plans/2026-09-19-executor-idle-management-design.md) 与 [实施计划](plans/2026-09-19-executor-idle-management-implementation-plan.md)：Web/Server 的 Pi/Codex 助手空闲态增删改启停及热生效已实现，排队、暂停、阻塞任务均阻止写入；本地回归、浏览器和配置消费者集成测试已执行。CLI 由用户明确延期，真实模型和 Docker 发布验收仍待执行，详见计划内交付记录。
- [Planner 检索职责归位：检索下沉执行器，Planner 只做理解与拆解](plans/2026-09-12-planner-search-ownership-handoff.md): 提案待定稿。Planner 侧移除 `web_search`（并评估移除 `web_fetch`）并重写提示词/技能，MetaWork 侧把“决策耗尽”从硬失败改为兜底委派到 `current-web-research`（`pi-research`），消除 `Planner unavailable` 整轮失败。
- [飞书任务生命周期与交付可靠性闭环](plans/2026-09-06-feishu-task-lifecycle-and-delivery-reliability-closure.md): records the confirmed residual failures after the prior reliability work and the Feishu-only system closure for cancellation convergence, explicit abandon-and-create, message-scoped screenshot continuity, throttled activity cards, and cloud-document/artifact delivery. Web behavior is explicitly preserved.
- [Independent Server/Client and TUI experience design](plans/2026-08-26-independent-server-client-and-tui-experience-design.md): implemented process-lifecycle cut for a persistent workspace-neutral Server, independently launched TUI/Web clients, Server-managed Feishu connectivity, Conversation-scoped `/workspace <path>`, a redesigned native TUI, and strict preservation of the current Web experience through a Server projection superset.
- [Independent Server/Client and TUI implementation plan](plans/2026-08-26-independent-server-client-and-tui-experience-implementation-plan.md): implemented ADR-first, TDD-sized execution covering the hard CLI cutover, Conversation Workspace admission, Server composition extraction, deterministic TUI replay projection, Web compatibility gates, lifecycle smokes, security gates, and documentation.
- [MetaWork 配置热激活、Auto 路由与 DAG 可视化设计](plans/2026-08-23-metawork-hot-activation-auto-routing-and-plan-visualization-design.md): the original broad design is amended by the Provider-first settings plan; current behavior is documented in the revised Provider catalog, Planner fixed-only, and Codex/Pi routing plan.
- [Provider Catalog And Planner/Executor Routing Design](plans/2026-08-23-provider-catalog-planner-fixed-executor-auto-routing-design.md): current approved desktop settings contract and deletion/activation semantics.
- [Web Workspace、文档预览、执行透明化与输入法交互实施方案](plans/2026-08-24-web-workspace-artifact-preview-execution-transparency-and-ime-design.md): proposed desktop Web improvements for startup-directory artifacts, right-side document preview, streamed Planner-to-Executor visibility, and IME-safe Enter behavior.
- [Multi-provider and model configuration](plans/2026-08-16-multi-provider-model-configuration.md): wires the SecretStore and runtime binding into production, renders multi-provider agent configs per activated revision, and opens Provider/Model management in the settings UI while keeping Harness closed.
- [Revised MetaWork Server upgrade implementation plan](plans/2026-08-11-metawork-server-upgrade-implementation-plan.md): code closure for signed release trust, immutable revisions, schema 30-to-31 migration, Planner v8/Work Graph v7, generation-scoped bindings, Harness drivers and transactional rollback; native online daemon and release-infrastructure gates remain open.
- [Conditionally approved MetaWork Server upgrade design](plans/2026-08-07-metawork-server-upgrade-technical-design.md): one-command native Server installation, `~/.anyfusion` release/data layout, nested AnyFusion-Pi Planner, generation-scoped revision authority, Provider/Model health, signed transactional updates, isolated AgentClass runtimes, migration and acceptance criteria.
- [Native Planner installation](plans/2026-08-07-native-planner-installation.md): native macOS setup for the isolated nested `planner/AnyFusion-Pi` Planner, current-directory read-only inspection, AnyFusion-only configuration, and preservation of existing Codex/Pi installations.
- [Node 22 single runtime image migration](plans/2026-08-05-node-22-single-runtime-image-migration.md): unifies MetaClaw and AnyFusion-Pi on one Node 22.19+ image and executable while preserving separate processes and dependency trees.
- [Active permission review](plans/2026-08-04-active-permission-review.md): projects current-session durable permission requests to a transient Pi native Selector while preserving Kernel authorization and non-interactive natural-language resolution.
- [Command surface and task selection cleanup](plans/2026-08-04-command-surface-and-task-selection-cleanup.md): first-batch removal of non-functional command surfaces, richer Executor/Profile facts, and title-first Task completion in AnyFusion-Pi.
- [Pi Executor status and result projection fix](plans/2026-08-04-pi-executor-status-and-result-projection.md): adds a native animated Executor status block and passively persists each integrated Subtask publication into the Pi conversation without triggering a Planner turn or moving Kernel/Execution authority.
- [Worktree Executor backend migration](plans/2026-08-06-worktree-executor-backend-migration.md): keeps the Runtime containerized where needed while moving trusted Executor attempts to per-Subtask Git worktrees and native Runtime processes.

## Frontend Observation Upgrade

- [前端观察架构全盘升级方案](plans/2026-10-02-frontend-observation-architecture-upgrade-design.md)：Web/TUI/Feishu 同账户同权查看与控制、任意端发送/停止/审批、持久仲裁、独立通知路由，以及有界历史、实体仓库和正文虚拟化。[Accepted ADR-0043](adr/0043-explicit-conversation-observation-and-client-read-models.md) 替代 ADR-0036 的来源端独占规则。已完成本地源码与隔离安装验证，运行证据与剩余验收门见[实施记录](plans/2026-10-02-frontend-observation-implementation.md)；用户验收前不推送实施变更。

## Implementation Plans

- [Kernel 兼容性中继与可选服务规格优化方案](plans/2026-10-28-transparent-execution-and-optional-service-specification.md)：2026-10-28 已实施 P0/P1；按 ADR-0053 补齐通用后续执行、可选服务文件、目标项目定位、`terminal_disposition` 执行事实与对话/轨迹状态一致性。完成记录、验证与未关闭项见文档末尾。

- [任务执行可靠性统一方案](plans/2026-10-15-task-execution-reliability-unified-plan.md)：2026-10-15 已实施核心代码并逐阶段 review；统一四态、局部等待/失败与独立恢复。主机验收通过，Docker/真实飞书/正式安装平台发布门未关闭，状态仍为实施中。

- [任务执行可靠性技术方案](plans/2026-10-15-task-execution-reliability-technical-design.md)：记录运行绑定核对、schema 49 持久交付、元数据修复约束与恢复防重；§13 保存逐阶段验证、最终根 3616 项通过、Pi 全仓 check 和隔离安装 Electron 验收，以及未验收平台边界。

- [阻塞任务恢复操作入口](plans/2026-10-14-blocked-task-interaction-fix.md)：早期交互修复交付记录；后续恢复验收及剩余工作统一见上方方案，保留原有执行清理和队列约束。

- [当前 Provider 协议核对与隔离测试](plans/2026-10-13-provider-protocol-audit.md)：已核对 7 个 Provider，记录 9 次 CLI 测试。DeepSeek、GLM Flash 与两个本地连接可保留协议；Claude 原生协议候选通过但生产激活需要后端支持；另有 GPT 服务过载/超时、FlashX 订阅权限与 Mercury 专用接口问题。生产配置尚未更改。

- [同一会话历史信息跨任务复用修复方案](plans/2026-10-13-shared-interaction-evidence-fix.md)：源码修复及本地验证完成，本机 Desktop/Server 已更新。schema 48 使用任务范围证据主键，统一历史引用检查并修复恢复时缺失的关联；已通过旧库升级、回滚、执行前错误分期及事故数据库隔离副本验证，安装后三轮测试确认历史引用成功，但无工具执行却显示完成的问题仍导致文件交付失败。

- [PDF 下载与能力手册修复试用 DMG](plans/2026-10-10-report-manual-trial-dmg.md)：macOS arm64 内部包 `0.1.9-internal-local20261010b`；用户本地试用，不发布 GitHub。

- [能力手册长度导致激活失败修复](plans/2026-10-10-executor-manual-activation-fix.md)：移除生成手册及 Planner 手册投影的固定字节长度阻断，保留完整内容。

- [报告 Markdown / PDF 下载](plans/2026-10-10-report-md-pdf-download.md)：报告预览提供原文和本地生成的 PDF 两种下载格式，支持中文与分页；Web/Desktop 共用已有产物下载授权。

- [Span 路由增强设计](plans/2026-09-27-span-routing-design.md)、[实施计划](plans/2026-09-27-span-routing-implementation-plan.md)、[设计收尾记录](plans/2026-09-27-span-design-closure.md)与[真实 API 验收](plans/2026-09-27-span-live-acceptance.md)：代码、本地和真实接口验收已完成，包含无客户端恢复、固定 revision、取消/并发边界和双向凭据隔离。真实调用发现并修复字符串 state 协议问题；评分、默认超时回退、单候选跳过和持久重放通过。精确 Dockerfile 镜像构建仍受 Docker Hub 网络阻断。

- [MetaCoin usage and Query billing implementation](plans/2026-09-21-metacoin-query-billing-implementation-plan.md): implementation completed on 2026-09-22 without a commit. The 11-task plan covers single-user multi-task reliability, per-Query usage/stage costs, assessed MetaCoin bills, Task rollups, three-client projections, and idempotent external consumption reporting. Queries need not have Tasks; assessed charges and externally confirmed deductions are separate. Wallets, subscriptions/payment collection, recharge and refunds belong to an independent external system; Provider restrictions, a mandatory model proxy, local balance enforcement and shared-runtime multi-tenancy are excluded.

## Future Roadmap

- [MetaWork 垂类化架构方案](plans/2026-10-12-metawork-vertical-domain-package-design.md)：待 Review，尚未实施。区分 Core、共享适配与产品组件，以单仓静态组合接入首个行业 Domain Package；保留现有 Executor 执行主链，不新增行业调度器或通用插件平台。

- [Multi-tenant service and Query metering assessment](plans/2026-09-21-multi-tenant-and-query-metering-assessment.md): earlier code-grounded assessment of single-account deployment, queue wake-up/limit gaps and broader tenant isolation/metering proposals. Retained as evidence and deferred roadmap context; the finalized MetaCoin plan above governs this release, not the assessment's broader recommendations.
- [Earlier multi-top-level-Task scheduling proposal](plans/future-multi-task-scheduling-roadmap.md): historical planning context. [ADR-0037](adr/0037-multi-conversation-task-parallelism.md) now defines multi-Conversation concurrency and supersedes ADR-0011's account-wide single-active-Task restriction; see the assessment above for remaining production scheduling gaps.

## Historical Plans

Files in [plans/](plans/) contain active plans explicitly linked above. Superseded and completed plans are moved to [archive/plans/](archive/plans/); treat archived plans as historical context unless they are referenced by the current README, `CONTEXT.md`, or an ADR.

The completed [Phase 1 work-graph semantics convergence plan](archive/plans/2026-07-16-phase-1-work-graph-semantics-convergence.md) records the v3 contract, migration, runtime cutover, and validation evidence.

The completed [Phase 2 overall action plan](archive/plans/2026-07-17-phase-2-executor-scope-and-dependency-handoff.md) and [detailed implementation plan](archive/plans/2026-07-17-phase-2-executor-scope-and-handoff-detailed-implementation-plan.md) record the Work Graph v4, execution-scope, evidence, completion, handoff, attempt, migration, and validation contracts.

The completed [Phase 2 attempt-terminal and Work Graph regression fix plan](archive/plans/2026-07-20-phase-2-attempt-terminal-and-work-graph-regression-fix-plan.md) records the pre-Phase-3 hardening of blocked/stale terminal ownership, attempt-safe release, restored Phase 1 topology rules, and behavior-test coverage.

The completed [Phase 3 overall action plan](archive/plans/2026-07-20-phase-3-kernel-control-plane-convergence.md) and [detailed implementation plan](archive/plans/2026-07-20-phase-3-kernel-control-plane-detailed-implementation-plan.md) record the unified ControlKernel, decision ledger, synchronous control loop, capacity handling, outcome landing, response-only correction, and validation evidence.

The completed [Phase 5 implementation plan](archive/plans/2026-07-22-phase-5-resource-partition-sandbox-elevation-detailed-implementation-plan.md) records resource identities, persistent workspaces, leases, Docker attempt sandboxes, runtime elevation, Kernel v3 recovery and validation evidence.

The completed [Phase 6 concurrency and Git integration plan](archive/plans/2026-07-27-phase-6a-single-task-concurrency-and-git-integration.md) and [Phase 6 reliability closure plan](archive/plans/2026-07-28-phase-6-single-task-reliability-closure.md) record the single-Task asynchronous frontier, attempt isolation, Git publication, durable cancellation, generation replan and strict completion gate.

The completed [Executor probe diagnostics and Docker shell fix plan](archive/plans/2026-07-29-executor-probe-diagnostics-and-docker-shell-fix.md) records Docker socket access, durable probe diagnostics and Planner-visible troubleshooting evidence.

The completed [Planner native Codex session integration plan](archive/plans/2026-07-29-planner-native-codex-session-integration.md) records session-to-thread binding, native resume, Planner-only prompts and the two-turn memory smoke.

The failed [AnyFusion Codex native TUI migration](archive/plans/2026-07-30-codex-native-tui-migration.md) records the abandoned downstream Codex TUI route. Its Planner/Kernel/Executor boundaries remain historical design input, but its Rust build and release cost made the implementation route unacceptable; the Pi migration plan is now authoritative for replacement work.

The [2026-06-30 temporary issue handoff](archive/ISSUES-2026-06-30-temp-handover.md)
is archived because several entries reference modules removed by later cleanup.
It is historical review context, not an active issue tracker or architecture map.

## Operational Notes

- [Optional container compatibility validation](current/technical-overview.md#optional-container-compatibility-validation): the checked-in runtime can still build MetaClaw and the vendored AnyFusion-Pi Planner into one Node 22.19+ image for Linux compatibility checks; native macOS installation does not require Docker.
- The failed AnyFusion-Codex Planner wiring has been removed from active source, Docker templates, and smoke scripts. The archived migration plan and Git history remain the rollback/audit record; the original Ink source, tests, and dependencies remain a standby module and must not be deleted.
- [Tech Debt](tech-debt/): [Pi Planner behavior parity and PlanningAgentPlan v7](tech-debt/planner-pi-migration-parity-debt.md) closed on 2026-08-04 after Linux Docker acceptance and final user verification. The post-Phase-6 first-release cleanup handoff is tracked in [redundancy and compatibility cleanup](tech-debt/post-phase6-first-release-redundancy-cleanup.md). Active command/TUI work is tracked in the [UX backlog](tech-debt/task-command-and-tui-ux-backlog.md), with visible command placeholders listed in [pending command implementations](tech-debt/pending-command-implementations.md). The closed [natural-language inference inventory](archive/tech-debt/nl-keyword-semantic-inference-debt.md) is retained as historical input to the completed P0 cleanup. The closed [Kernel decision authority record](archive/tech-debt/kernel-decision-authority-scattered-in-runtime-debt.md) documents how Phase 3–5 converged every strategic decision onto `ControlKernel`. The closed [LangGraph durable workflow evaluation](archive/tech-debt/langgraph-durable-workflow-adoption-candidates.md) records why Phase 4 retained the smaller self-owned workflow. Closed capability and workspace-partition records also remain under [archive/tech-debt/](archive/tech-debt/).

## For Agents

Read `AGENTS.md`, then `CONTEXT.md`, then this map. Open
`current/technical-overview.md` for deep runtime/deployment context and select
only the applicable accepted ADRs. Avoid loading every dated plan by default.

Desktop implementation: [isolated branch progress](plans/2026-10-05-metawork-desktop-implementation.md).

- [v0.1.6 internal Desktop release](plans/2026-10-08-v0.1.6-release.md) — 2026-10-08 release and artifact acceptance.

- [v0.1.7 Desktop release](plans/2026-10-08-v0.1.7-release.md) — published latest on 2026-10-08; CLI discovery, readiness UI and artifact acceptance.
- [Desktop update recovery loop](plans/2026-10-08-desktop-update-recovery-loop.md) — lock-release ordering and repair-only source correction validated and included in v0.1.8.

- [Provider 协议选择与 GPT Responses 切换（2026-10-13）](plans/2026-10-13-provider-protocol-selection.md)
- [会话-任务-交付模型故障复盘与改造方案（2026-10-22，待评审）](plans/2026-10-22-conversation-task-delivery-and-service-ownership-review.md) — 平台级空转与日志失明（A）、启动服务四层闸门与永久死锁（B）、"每轮新工单/新目录/新服务/新经验"的作用域错位，以及"会话即目录 + 验收可执行"的目标模型与分期计划。
