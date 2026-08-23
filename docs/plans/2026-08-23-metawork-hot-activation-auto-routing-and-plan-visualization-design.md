# MetaWork Configuration And Intelligent Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不重启 MetaWork 的前提下安全激活 Provider/Model 配置，并以 Planner/Executor Auto 路由、DAG 可视化和最少用户输入完成端到端的高性价比任务执行。

**Architecture:** 保留 immutable configuration revision 和 Work Graph generation 级 revision pinning。新增 AccountRuntime 级配置激活协调器、运行时配置句柄和 activation gate；Planner 在 semantic turn 启动前解析具体模型，Executor 由 ControlKernel 在授权边界内解析具体 binding。DAG 和路由信息只作为由已校验 Work Graph、Kernel decision、Dispatch、Attempt、Verification 和 Publication facts 生成的 presentation projection，不取得调度或执行权。

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite/better-sqlite3, AnyFusion-Pi Planner RPC, ControlKernel, AccountRuntime, Web React/TypeScript, existing SecretStore and revisioned generated runtime.

---

**Status:** Proposed

**Plan date:** 2026-08-23

**Completion date:** Not implemented

**Scope:** 本文只沉淀设计和实施计划。本轮不修改实现、不提交 Git、不推送 GitHub。

## 1. Context And Constraints

当前配置架构已经具备 immutable revision、active pointer 和 Work Graph generation 级 `configurationRevision`。这些契约必须继续保留：

- 已经创建的 Task、Work Graph、Subtask、attempt、retry、fallback、recovery 和 receipt 继续使用原 revision。
- 运行中的 Planner turn 和 Executor attempt 不得在进程中途切换 Provider 或 Model。
- Planner 只负责语义理解和提出结构化 proposal。
- ControlKernel 是授权、调度、fallback、recovery 和 concrete binding 选择的唯一策略拥有者。
- Executor Runtime 只执行 Kernel 授权的完整 binding，不得自行选择模型。
- Planner Host bridge、Web 和 TUI 只能展示或提交命令，不能直接修改 Kernel、Storage 或 Executor。
- `MetaClaw`、`metaclaw` 等内部/runtime 名称不在本计划中重命名；用户界面继续使用当前产品名。

当前阻碍热激活的主要实现事实：

- [`src/index.ts`](../../src/index.ts) 在启动时创建固定的 `stagedConfiguration`。
- Planner Supervisor 在启动时绑定 revision、Provider、Model 和 binding fingerprint。
- [`src/account/account-execution-services.ts`](../../src/account/account-execution-services.ts) 缓存 Runtime Configuration。
- [`src/account/account-planner-services.ts`](../../src/account/account-planner-services.ts) 启动时验证固定 Planner binding。
- [`src/management/server.ts`](../../src/management/server.ts) 使用启动时传入的 `runningRevisionId`，把新 active revision 解释为必须重启。
- [`web/src/components/SettingsPanel.tsx`](../../web/src/components/SettingsPanel.tsx) 固定显示“重启生效”并没有运行时 busy gate。
- [`src/configuration/staged-legacy-configuration.ts`](../../src/configuration/staged-legacy-configuration.ts) 目前仍要求 Planner 使用 fixed model。

## 2. Product Semantics

### 2.1 Hot-activatable configuration

第一阶段允许热激活：

- Provider `baseUrl`
- Provider SecretStore reference
- Model ID 和 Model metadata
- Planner/Executor 的 `fixed` 或 `auto` 策略
- Auto 候选范围、成本/质量/延迟目标
- AgentClass 的模型路由策略

以下变更仍需要重启：

- Node 应用版本和 release artifact
- SQLite schema
- Harness command、driver、Docker image 或 A2A transport 类型
- Permission Profile 规则语义
- Planner RPC 协议和运行时目录协议
- 其他不能在当前进程内安全替换的 process-level artifact

配置 diff 必须由 `ConfigurationDiffClassifier` 分类为 `hot` 或 `restart_required`，不能再通过 revision ID 是否变化统一判断。

### 2.2 Busy activation rule

配置激活按 AccountRuntime 作用域执行。以下情况禁止激活：

- Planner semantic turn 正在运行
- 顶层 Task 正在执行
- Dispatch Item 处于 `pending_launch`、`launching`、`running`、`cancelling` 或 `uncertain`
- Executor child process 尚未退出
- WorkUnit claim 或 resource lease 尚未释放
- verification、publication、merge repair 或 recovery 尚未完成
- 另一个配置激活事务正在执行

仅有 Web/TUI 客户端在线、Task 处于 `ready`/`parked`/`blocked`、或历史任务已完成时，不应阻止激活。

前端按钮置灰只是展示逻辑；后端必须在激活事务内再次判断 gate。

### 2.3 Auto semantics

Auto 是模型选择策略，不是可执行模型。执行前必须解析为具体：

- Provider
- Model
- AgentClass
- Harness
- Permission Profile
- Configuration revision
- Binding fingerprint

不能把 `modelRef: "auto"` 写入 `AuthorizedExecutorBinding`、attempt identity 或 receipt。

## 3. Runtime Architecture

### 3.1 ConfigurationActivationGate

新增 AccountRuntime 级 gate，提供：

- `getStatus()`：返回 `idle`、`busy` 或 `activating`
- `assertCanActivate()`：返回结构化阻塞原因或通过
- `activeTaskId`
- `plannerTurnCount`
- `activeAttemptCount`
- `activeLeaseCount`
- `publicationPending`
- `recoveryInProgress`
- `hotActivationSupported`

Gate 查询同时读取内存运行态和 SQLite durable facts，避免只依赖 UI 状态。

### 3.2 ConfigurationRuntimeCoordinator

新增配置运行时协调器，负责：

- 保存当前 active snapshot、Planner view、Kernel view 和 Runtime view
- 管理 activation mutex
- 执行 diff classification
- 读取指定 revision 的 configuration snapshot
- 刷新 Planner Supervisor 的下一轮绑定
- 刷新 ExecutorRegistry 的 active configuration resolver
- 对外发布 `configuration_runtime_state` 和 `configuration_activated` 事件

不重建整个 AccountRuntime，不创建第二个 Kernel 或 Scheduler。

### 3.3 Atomic activation transaction

激活顺序必须是：

1. Draft 校验、编译和 probe。
2. 获取 activation mutex。
3. 重新读取 active revision，检查 optimistic concurrency。
4. 重新执行 ConfigurationActivationGate。
5. 校验 diff 是否允许热激活。
6. 生成新的 revision-scoped runtime files。
7. 对新 runtime 和 credential binding 执行 probe。
8. 写入 activation journal 的 prepared 状态。
9. 原子切换 active pointer。
10. 原子更新 ConfigurationRuntimeCoordinator 的 live handle。
11. 更新 Planner/Executor runtime resolvers。
12. 写入 committed 状态并广播激活事件。

当前 `ConfigurationService` 先切 pointer 再 render 的顺序需要调整，避免 pointer、generated runtime 和内存配置出现混合版本。

### 3.4 Planner hot switch

激活前必须确认没有 Planner turn。激活成功后：

- Conversation 和 persisted Planner session identity 保持不变。
- 历史 session 内容不重写。
- 下一次 semantic turn 读取新 active revision。
- 旧 Planner process 如仍持有旧 binding，则安全停止。
- 新 turn 重新启动并校验 Provider、Model 和 binding fingerprint。
- binding 不一致时 fail closed，不发送用户 prompt。

### 3.5 Executor hot switch

激活成功后：

- ExecutorRegistry 的 active configuration resolver 指向新 revision。
- 新 attempt 使用新 Provider、Model 和 SecretStore reference。
- 已启动的 child process 不修改 HOME、CODEX_HOME、PI 目录或模型配置。
- 已有 generation 的 authorized binding 不受影响。

## 4. API And Web Contract

### 4.1 Configuration status API

`GET /api/config` 增加：

- `activeRevisionId`
- `runtimeRevisionId`
- `activationStatus`
- `activationAllowed`
- `blockingReasons`
- `activeTaskId`
- `activeAttemptCount`
- `plannerTurnActive`
- `hotActivationSupported`
- `restartRequired`
- `checkedAt`

`GET /api/config/activation-status` 可作为高频刷新和 WebSocket 断线恢复的专用接口。

### 4.2 Activate API

`POST /api/config/activate`：

- 空闲且 diff 为 hot-safe 时返回成功，并标记无需重启。
- runtime busy 时返回 HTTP 409 和 `runtime_busy` 或更具体的阻塞码。
- active revision 变化时返回 `revision_conflict`。
- process-level diff 时返回 `restart_required` 和具体字段。
- 所有响应都返回当前 active/runtime revision，避免 Web 页面继续使用旧状态。

### 4.3 Settings UI

修改 [`web/src/components/SettingsPanel.tsx`](../../web/src/components/SettingsPanel.tsx)：

- 空闲时激活按钮可用。
- Planner turn 或后台执行时激活按钮置灰。
- 显示当前阻塞原因、Task ID、attempt 数量和等待阶段。
- 移除固定的“激活（重启生效）”文案。
- 热激活成功后显示“已生效，新任务/下一轮 Planner 使用新配置”。
- 只有 process-level diff 才显示重启提示。
- 多个客户端通过 WebSocket 同步 activation status。

Secret 输入只在真正缺少 credential 时显示。Draft 阶段不要提前把新 API key 写入 SecretStore；应在 gate 通过并进入激活事务后提交。

## 5. Auto Model Routing

### 5.1 Model policy

统一 Planner 和 Executor 的 `ModelPolicy`：

- `fixed`
- `auto`
- `allowedModelRefs`
- `defaultModelRef`
- `fallback.order`
- `objective.priority`: `balanced`、`quality`、`cost`、`latency`
- `maxCostPerTurn`
- `maxLatencyMs`
- `minimumQualityTier`

候选模型必须来自当前配置 revision，不能扫描未授权 Provider 或任意本机配置。

### 5.2 Model metadata

Model projection 需要支持：

- `text`
- `vision`
- `reasoning`
- `coding`
- `tools`
- `structured-output`
- `long-context`
- context window
- input/output cost
- latency class
- quality tier
- Harness compatibility
- Provider/Model health projection

能力无法安全确认时默认为不支持，而不是乐观标记。

### 5.3 Resolver contract

新增纯函数 `AutoModelResolver`，输入：

- configuration revision
- AgentClass policy
- task/subtask requirements
- model metadata
- provider/model health
- runtime capacity
- objective

输出：

- concrete model binding
- ordered fallback candidates
- rejected candidates and reasons
- score breakdown
- estimated cost and latency
- policy version

评分目标是最低“任务完成综合成本”，不是单次调用价格。需要考虑当前调用、失败重试、fallback、返工和验证成本。

### 5.4 Planner Auto

Planner 在 RPC prompt 发送前，根据 `PlannerInputProfile` 选择具体模型。画像只使用非语义事实：

- 文本长度
- 图片数量、MIME 和大小
- 附件存在性
- 是否 continuation
- 是否要求 structured proposal
- 当前 runtime 和 Provider health

有图片时必须过滤到 vision-capable 模型；长文本必须满足 context window；Planner 必须支持 structured output。

不得重新引入关键词语义路由，也不得让 Planner 先用一个模型理解后再启动第二个模型。后续若需要 escalation，应单独新增 ADR 和持久化 turn identity。

### 5.5 Executor Auto

Planner 提供 Subtask 的：

- goal
- required capabilities
- risk level
- context requirements
- AgentClass 候选

Kernel 过滤不兼容 AgentClass、Harness、Permission Profile、Model capability、context window、health 和启动条件，然后解析 concrete binding。

fallback 只能由 ControlKernel 决定，Executor Runtime 不得私自切换。

## 6. Work Graph And Routing Presentation

### 6.1 Source of truth

新增 `WorkGraphPresentationProjector`，输入：

- 已校验的 PlanningAgentPlan
- persisted Work Graph
- Kernel decisions
- Dispatch Items
- Attempt facts
- Verification facts
- Publication facts

输出前端专用 DAG projection。前端不能解析 Planner 自然语言，也不能自行推断依赖关系。

### 6.2 User-visible DAG

每个 Subtask 节点展示：

- 标题和目标
- 依赖节点
- required capabilities
- 当前状态
- AgentClass
- Harness
- Auto/fixed policy
- 最终 Provider/Model
- 预计成本和延迟
- 验收标准摘要

图中要明确标出：

- 并行阶段
- 等待依赖
- capability handoff
- 产物传递
- 当前 runnable frontier
- fallback 或重试路径

移动端切换为按阶段排列的结构化节点列表，不能退化成文字平铺。

### 6.3 Presentation boundary

DAG 展示层不能：

- 修改 Work Graph
- 调度或取消 Executor
- 修改 binding
- 触发 retry/fallback
- 绕过 Kernel
- 直接操作数据库

普通任务默认展示后自动执行。高风险权限仍由现有 Permission Profile 流程处理。

## 7. Minimal Configuration And Auto-completion

### 7.1 Three-level configuration model

设置页拆成三层：

- Provider catalog：Provider、Base URL、credential、health。
- Model catalog：Model ID、能力、成本、context、延迟。
- AgentClass routing：Planner、Codex CLI、Pi Agent 选择 `Auto` 或现有 Model。

Planner 和 Executor 不再分别重复填写 Provider、Base URL 和 API key。

### 7.2 Completion priority

配置补全优先使用：

1. 当前 immutable configuration revision。
2. 本机 Codex/Pi/Code CLI/Kimi 配置。
3. 本机环境变量和 credential 文件。
4. SecretStore 中已存在的 credential。
5. Provider preset。
6. Provider model catalog。
7. 保守的 Model ID 能力推断。
8. 最后才要求用户输入。

自动发现的 credential 仍必须通过现有本机 Agent credential import 和 SecretStore 边界，不能扫描任意文件。

### 7.3 User input policy

默认：

- Planner 为 Auto。
- Executor 为 Auto。
- 已发现的本机 Agent 自动连接。
- 已有 API key 显示“本机凭据可用”。
- 不显示重复 API key 输入框。
- 不要求用户手动填写 capabilities、成本、延迟或 context window。
- 高级字段默认折叠。

自定义 Provider 最少只要求：

- Base URL
- Model ID
- API key，仅在没有已发现 credential 时要求填写

字段状态区分：

- `已自动发现`
- `已从 Provider 补全`
- `已从本机 Agent 导入`
- `需要确认`
- `缺失`

不能可靠推断的能力默认为不支持，并以“需要确认”提示，而不是让用户填写整套 metadata。

## 8. Observability And Audit

InteractionTrace 增加结构化 `routing` 阶段：

- Planner Auto 候选和最终选择
- Executor Auto 候选和最终选择
- rejected candidate reason
- capability match
- health facts
- estimated/actual cost
- estimated/actual latency
- fallback history
- selection policy version

不展示 API key、原始 prompt、原始 stdout/stderr 或隐藏思维链。

## 9. Implementation Tasks

### Task 1: Freeze contracts and classify configuration changes

**Files:**

- Modify: `src/configuration/types.ts`
- Modify: `src/configuration/schema.ts`
- Modify: `src/configuration/projections.ts`
- Modify: `src/configuration/configuration-diff.ts`
- Create: `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`

**Tests:**

- `tests/configuration/schema.test.ts`
- `tests/configuration/projections.test.ts`
- New configuration diff and policy tests

**Steps:**

1. Define hot-safe and restart-required configuration categories.
2. Extend Model metadata and Auto objective fields.
3. Define concrete binding resolution and audit contracts.
4. Add schema tests for Planner and Executor Auto.
5. Record the ownership and dependency decision in ADR-0033.

### Task 2: Implement activation gate and runtime coordinator

**Files:**

- Create: `src/configuration/configuration-activation-gate.ts`
- Create: `src/configuration/configuration-runtime-coordinator.ts`
- Modify: `src/account/account-runtime.ts`
- Modify: `src/account/account-runtime-ports.ts`
- Modify: `src/configuration/configuration-service.ts`
- Modify: `src/configuration/file-configuration-repository.ts`
- Modify: `src/index.ts`

**Tests:**

- New activation gate unit tests
- New activation transaction tests
- `tests/configuration/configuration-service.test.ts`
- AccountRuntime busy and idle tests

**Steps:**

1. Add durable and in-memory runtime status readers.
2. Add activation mutex and optimistic revision check.
3. Prepare and probe generated runtime before pointer switch.
4. Atomically update live runtime configuration handles.
5. Add crash/recovery tests for prepared and committed journals.

### Task 3: Make Planner and Executor consumers revision-aware

**Files:**

- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/account/account-planner-services.ts`
- Modify: `src/account/account-execution-services.ts`
- Modify: `src/execution/execution-runtime.ts`
- Modify: `src/configuration/production-runtime-bindings.ts`

**Tests:**

- `tests/planning/planner-process-supervisor.test.ts`
- Executor binding revision tests
- New hot-switch tests for next Planner turn and next attempt

**Steps:**

1. Add idle-only Planner binding refresh.
2. Resolve Planner runtime home by the exact next-turn revision.
3. Resolve Executor runtime configuration dynamically for new attempts.
4. Keep existing attempts pinned to their original revision.
5. Verify no running child process receives a rewritten configuration.

### Task 4: Add management API and Web activation state

**Files:**

- Modify: `src/management/server.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/styles.css`

**Tests:**

- `tests/web/config-edit.test.ts`
- New busy-button and API-409 tests
- WebSocket activation status tests

**Steps:**

1. Add activation status projection.
2. Return structured busy and restart-required responses.
3. Disable activation only when the AccountRuntime gate is busy.
4. Remove unconditional restart messaging.
5. Add hot activation success and blocking reason presentation.

### Task 5: Implement AutoModelResolver

**Files:**

- Create: `src/routing/auto-model-resolver.ts`
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/configuration/projections.ts`
- Modify: `src/core/authorized-executor-binding.ts`

**Tests:**

- New pure resolver tests
- `tests/kernel/control-kernel.test.ts`
- Deterministic replay tests
- Property tests for candidate filtering and tie-breaking

**Steps:**

1. Implement hard capability and permission filters.
2. Implement deterministic quality/cost/latency scoring.
3. Produce concrete binding and rejected-candidate audit.
4. Route Executor Auto through Kernel only.
5. Preserve fixed mode behavior and existing fallback authority.

### Task 6: Implement Planner Auto input profile

**Files:**

- Create: `src/planning/planner-input-profile.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/account/account-planner-services.ts`
- Modify: `src/configuration/staged-legacy-configuration.ts`

**Tests:**

- Planner Auto text, image, attachment and long-context tests
- Planner binding mismatch tests
- Multi-turn revision switch tests

**Steps:**

1. Remove the staged Planner fixed-model restriction.
2. Build structural input profile before RPC.
3. Select a concrete Planner binding before prompt submission.
4. Require vision-capable models for image input.
5. Ensure fixed mode remains authoritative.

### Task 7: Add DAG and routing projections

**Files:**

- Create: `src/management/work-graph-presentation-projector.ts`
- Modify: `src/management/interaction-trace.ts`
- Modify: `src/management/web-conversation-projector.ts`
- Modify: `web/src/api/types.ts`
- Create: `web/src/components/WorkGraphPanel.tsx`
- Create: `web/src/components/RoutingDecisionCard.tsx`

**Tests:**

- New Work Graph projection tests
- DAG dependency and parallel-group tests
- Routing explanation redaction tests
- Responsive Web component tests

**Steps:**

1. Project validated Work Graph nodes and edges.
2. Project dispatch, binding, cost and rejection facts.
3. Add live node status updates from existing trace events.
4. Render desktop graph and mobile structured list.
5. Verify presentation cannot issue Kernel or Executor commands.

### Task 8: Reduce configuration input and add discovery completion

**Files:**

- Modify: `src/configuration/local-agent-credentials.ts`
- Modify: `src/configuration/legacy-configuration-reader.ts`
- Create: `src/configuration/configuration-completion-service.ts`
- Modify: `src/configuration/configuration-validator.ts`
- Modify: `web/src/components/AgentClassConfig.tsx`
- Modify: `web/src/components/SettingsPanel.tsx`

**Tests:**

- `tests/configuration/local-agent-credentials.test.ts`
- New configuration completion tests
- `tests/web/provider-secret-state.test.ts`
- Missing-vs-confirmation UI tests

**Steps:**

1. Reuse existing local Agent credential discovery.
2. Build one Provider catalog and one Model catalog.
3. Infer safe defaults from preset, Provider metadata and existing config.
4. Show only unresolved required fields.
5. Ensure new API keys are not persisted before successful activation.

### Task 9: Run end-to-end acceptance

**Files:**

- Create or extend: `tests/e2e/`
- Modify: `scripts/` smoke entry points as required
- Modify: `docs/current/technical-overview.md`
- Modify: `CONTEXT.md` if runtime invariants change

**Scenarios:**

1. Idle hot activation without process restart.
2. Busy activation disabled in Web and rejected by direct API.
3. Existing generation remains on old revision.
4. New Planner turn uses new Provider/Model.
5. New Executor attempt uses new Provider/Model.
6. Planner image task selects vision-capable Model.
7. Planner Kimi and Executor Code CLI remain independent.
8. Local credentials avoid repeated API key entry.
9. Auto selects different models for cheap text, image, long-context and coding tasks.
10. DAG displays dependencies, parallelism, dispatch logic and live execution status.
11. Crash during activation recovers one complete revision.
12. Fixed mode is never overridden by Auto.

## 10. Acceptance Checklist

- 空闲时配置可以激活，MetaWork 主进程不重启。
- 有 Planner turn、Executor attempt、publication 或 recovery 时激活按钮置灰。
- 绕过 Web 直接调用激活 API 仍然被后端阻止。
- 现有 Task 和 generation 不会被新配置偷偷修改。
- 新 Planner turn 和新 Executor attempt 使用新 revision。
- Planner Auto 可以在图片输入前选择 vision-capable Model。
- Executor Auto 只在授权候选集合中选择 concrete binding。
- fixed 模式不受 Auto 覆盖。
- DAG 显示 Subtask、依赖、并行层、能力和分派逻辑。
- DAG 状态能随 execution、verification、publication 更新。
- Provider 只需配置一次，Planner 和 Executor 复用 Provider catalog。
- 本机已有 credential 时不要求重复输入 API key。
- 自定义 Provider 最少只需 Base URL、Model ID 和必要时的 API key。
- 配置页默认使用 Auto，高级字段默认折叠。
- 自动发现失败时只提示真正缺失的字段。
- 所有路由选择都可解释、可审计、可回放。
- 不展示 credential、原始 prompt、stdout/stderr 或隐藏思维链。

## 11. Documentation Closure

实施完成后需要补充：

- `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`
- `CONTEXT.md` 中的 hot activation、Auto binding 和 DAG presentation invariant
- `docs/current/technical-overview.md` 中的配置生命周期、路由和 Web projection
- `docs/README.md` 中的计划状态

完成时将本计划的 `Status`、完成日期、已交付行为、验证命令和 closing commit 补齐。当前仅保存设计，不标记完成。
