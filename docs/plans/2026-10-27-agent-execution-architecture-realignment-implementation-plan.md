# MetaWork Agent 执行架构重构技术实施方案

- 日期：2026-10-27
- 状态：**已实施（§4–§7 全部落地，含 14 项评审缺陷修复）；P3 为方案明确的可选后续事项，未进入**
- 完成日期：2026-10-27（代码与聚焦测试）；引擎/Web 构建通过，真实环境用户验收与 native Server 单实例检查仍待执行
- 依据：[Agent 执行架构重构方案](2026-10-27-agent-execution-architecture-realignment-plan.md)
- 实施目标：在不改变 `Planner → Work Graph → Kernel → Executor/Harness → MetaWork 汇总/验证/输出` 主架构的前提下，消除 Runtime 对 Harness 内部执行的重复控制，让失败反馈、服务恢复和普通 Workspace 操作回到用户目标闭环。
- 适用范围：Pi/Codex 当前 Executor 路径、Planner Work Graph 授权、Kernel dispatch、Attempt runner、Managed Local Service、结果验证和用户交付。
- 暂不实施：DeepSeek Harness ACP/SDK 新 Adapter、第二套 Agent loop、第二个 Kernel、新的 Task/Attempt/Step 持久化状态机。

## 1. 固定架构和实施原则

实施后的唯一主链路如下：

```text
用户需求
  → Planner 理解需求并生成 Work Graph
  → Kernel 审核/授权 Work Graph
  → Runtime 按 Graph 调度已授权 Subtask
  → Executor Adapter 启动 Pi/Codex Harness
  → Harness 在自己的内部闭环中完成 turn、tool call、修复、重试和验证
  → Runtime 接收候选结果并验证 Workspace、服务和验收条件
  → MetaWork 汇总 Graph 结果并直接输出
```

必须保持以下边界：

1. Graph 是 Planner 生成的数据，不增加 Graph 服务或 Graph 调度器。
2. Kernel 仍是 Graph 的权威审核和授权方；它审核任务边界、依赖、能力、Workspace、资源和执行绑定。
3. Executor/Harness 是子任务内部执行过程的唯一拥有者。MetaWork 不逐工具调用、逐模型 turn 或逐修复步骤插入控制。
4. Runtime 可以在 Harness 返回候选结果后做独立验证；验证失败只能形成一次新的授权 continuation/recovery 输入，不能修改正在运行的 Harness。
5. 普通 Workspace 读写和用户明确要求的本地运行不增加交互确认。
6. 不增加与 Pi Agent Loop、AgentHarness、Provider retry、Session persistence 重复的 MetaWork Agent 状态机。
7. 安全、路径、凭据、进程和资源租约继续作为后台硬约束存在，但不把正常开发操作呈现为用户审批流程。

## 2. 当前代码基线与改造边界

### 2.1 已有可复用能力

以下代码已经具备目标架构所需的基础能力，实施时优先扩展而不是重写：

| 现有能力 | 代码入口 | 实施策略 |
| --- | --- | --- |
| Planner 生成 Work Graph | `src/planning/`、`src/session/conversation-session.ts` | 保持 proposal/schema/Graph 语义，只调整执行边界说明 |
| Kernel 审核和授权 Graph | `src/kernel/control-kernel.ts`、`src/kernel/kernel-workflow.ts` | 保留 dispatch、binding、lease 和 recovery 决策；增加服务反馈的已有 continuation 入口 |
| Executor 统一入口 | `src/execution/execution-runtime.ts`、`src/executor/adapter.ts` | 保持 `ExecutorAdapter.execute()`，不复制 Agent Loop |
| Pi Harness | `src/executor/pi-cli-driver.ts`、`planner/AnyFusion-Pi/packages/agent/src/agent-loop.ts` | 保持 Pi 内部 tool/turn/retry 逻辑，Runtime 只收集结构化事件和最终结果 |
| Codex Harness | `src/executor/codex-cli-driver.ts` | 保持现有 CLI 适配，只统一失败和诊断映射 |
| Attempt 上下文 | `src/execution/subtask-execution-context.ts` | 作为当前 Subtask 的授权输入，补充服务反馈和恢复数据的 bounded packet |
| Attempt 运行 | `src/execution/subtask-attempt-runner.ts` | 保持单次 Harness 调用；使用已有 `recoveryMode: 'recovery_packet'` 继续失败后的新 Attempt |
| Task/Subtask 结果 | `src/core/types.ts`、`src/execution/completion-protocol.ts` | 保持 Completion Protocol v4 和 Result Object，增加诊断引用，不创建新终态 |
| 服务生命周期 | `src/execution/managed-local-service.ts`、`src/storage/managed-local-service-repo.ts` | 修正当前规格优先、Workspace 查询和自动重启语义 |
| Task 收尾 | `src/execution/kernel-execution-runtime.ts` | 将服务验证接入现有 Kernel 收尾和 recovery，不新增平行任务状态机 |

### 2.2 不在本轮重构中改动的内容

- Work Graph 的 schema、依赖类型、`fileOutputs` 基本语义。
- Planner 与 Kernel 的所有权方向。
- Executor 的 Provider、Model、Harness binding 和配置 revision 规则。
- 现有 ResourceLease、Workspace containment、凭据注入和进程清理硬约束。
- Completion Protocol 的 marker/schema 版本。
- Memory、Desktop、DMG、安装器和发布包结构。
- 外部 DeepSeek Harness 的源码和运行时。

## 3. 目标运行流程

### 3.1 Planner 到 Kernel

Planner 收到用户需求后只做一次语义规划：

1. 解析用户目标、Workspace 意图、目标路径、交付类型和验收条件。
2. 生成一个 Work Graph；简单请求可以只有一个 Subtask。
3. 每个 Subtask 声明 `goal`、`requiredCapabilities`、`executorBindings`、`acceptance` 和 `fileOutputs`。
4. 通过现有 `submit_planning_proposal` 提交 Graph。
5. Planner 读取 Kernel 返回的结构化结果；Graph 被拒绝时修正 Graph，不能自行执行 Workspace 或修改 Task 状态。

Kernel 对 Graph 做一次边界审核：

```text
Graph schema/依赖
→ AgentClass/Model/Harness binding
→ Workspace 所属、targetPaths 和 accessMode
→ ResourceLease 和并发条件
→ 配置 revision/binding fingerprint
→ 生成 dispatch item
```

Kernel 不审核 Harness 的每一个 shell、文件工具调用或模型回答，不生成每个内部修复步骤的审批请求。

### 3.2 Kernel 到 Executor

Runtime 从 Kernel dispatch item 构造现有 `ExecutorInput`。不新建第二套持久化 Contract 表；概念上的 Run Contract 由以下已授权字段组成：

```ts
type RunContractProjection = {
  taskId: string;
  generationId: string;
  subtaskId: string;
  attemptId: string;
  workUnitId: string;
  workspaceId: string;
  workspacePath: string;
  targetPaths: string[];
  accessMode: 'read' | 'execute' | 'write';
  subtaskGoal: string;
  acceptance: readonly WorkGraphAcceptanceCriterion[];
  fileOutputs: readonly string[];
  serviceIntent?: {
    requested: boolean;
    serviceId?: string;
    specificationRevision?: string;
  };
  configurationRevision: string;
  bindingFingerprint: string;
};
```

该投影从 `ExecutorInput.context`、`executionBinding` 和当前 `Subtask` 派生，只作为日志、诊断和测试的统一视图，不成为新的调度权威。

### 3.3 Executor/Harness 内部执行

Pi/Codex 自己负责：

- 模型调用和上下文转换；
- 工具参数校验和工具执行；
- 工具错误写回模型上下文；
- 多轮 turn；
- follow-up/steering；
- Provider 短暂错误的退避重试；
- 代码修改、测试、命令执行和最终文本。

MetaWork 只订阅已有的 `onProgress`、`onRawOutput`、`onUsage` 和最终 `ExecutorResult`。这些事件用于展示和诊断，不用于逐步接管 Harness。

执行失败的归属必须保持以下顺序：

- 工具、命令、测试和代码修复失败留在 Harness 上下文中，由 Harness 读取错误并
  继续执行；
- Provider 429/5xx、网络断开、流中断和上下文溢出沿用 Harness 自己的退避、压缩和
  重试机制；
- 只有 Harness 已经结束当前闭环后的最终失败，才形成 `ExecutorResult` 返回 Runtime；
- Runtime/Kernel 不把一次工具失败或一次验收失败直接转换为用户任务失败。

### 3.4 Runtime 验证和 Graph 收尾

Executor 返回后按以下顺序处理：

1. 解析 Harness 结果和 Completion Protocol。
2. 持久化 Attempt receipt、Result Object、Workspace change record 和诊断。
3. 如果是普通结果，直接进入现有 Graph/Subtask 收尾。
4. 如果用户要求启动服务，按当前服务规格执行服务协调和健康检查。
5. 服务健康、文件变更、`fileOutputs`、handoff 和 acceptance 全部满足后，Kernel 完成 Graph 收敛。
6. 所有 Subtask 结果汇总后，MetaWork 向用户直接输出结果。

服务验证失败时：

```text
当前 Attempt 已经结束
→ Runtime 记录服务诊断
→ Kernel 基于原 Graph 授权 continuation
→ 新 Attempt 以 recovery packet 把诊断传给同一个 Executor/Harness
→ Harness 自己读取错误并修改代码/规格
→ Runtime 再次启动和验证服务
```

这不是干预原 Harness 的内部过程，而是一次新的 Graph continuation；用户不需要点击“显式重启”。

验收失败的处理顺序固定为：

```text
Runtime 发现验收条件未满足
→ 判断是硬约束、可修复反馈还是不可确认事实
→ 可修复反馈：生成有界 Mentor feedback/recovery packet
→ Kernel 基于原 Graph 授权 continuation
→ Executor/Harness 读取反馈并自行修复、测试和验证
→ Runtime 重新验收
→ 只有不可确认或预算耗尽才进入用户决策
```

不得因为服务未启动、健康检查失败、测试失败或结果与 acceptance 不一致，就
直接结束用户任务；这些事实默认进入 continuation。Workspace 越界、未授权资源、
外部副作用不确定、凭据缺失和自动修复预算耗尽仍然是 Kernel/用户决策边界。

## 4. P0：服务生命周期和失败反馈闭环

P0 先解决已经确认的 BS 服务问题，避免先扩大架构范围。

### 4.1 服务查找必须带 Workspace

修改：

- `src/execution/managed-local-service.ts`
- `src/storage/managed-local-service-repo.ts`
- `src/task/local-service.ts`
- `src/execution/kernel-execution-runtime.ts`

规则：

1. 所有 Runtime 启动路径优先使用 `(accountId, workspaceId, serviceId)` 查询。
2. `find(serviceId)` 只保留给兼容旧调用；如果多个 Workspace 存在同名服务，必须拒绝无 Workspace 的操作并要求调用方补齐 Workspace。
3. `startNow(spec)` 不用全局裸 `find(serviceId)` 判断当前服务，而使用当前规格解析出的 Workspace 记录。
4. 服务日志、进程 token、processId 和 revision 只属于这条复合身份。

### 4.2 当前任务优先于历史 failed 状态

重写 `startRequestedPublishedService(taskId)` 的决策：

```text
task.startServiceAfterPublish = false
  → 不启动服务

true
  → 读取当前 task/retry task 的已发布目录和当前 manifest
  → 解析当前 workspaceId/serviceId/specificationRevision
  → 查询当前 Workspace 的历史记录
  → 旧记录 failed/stopped 且规格相同：调用 start/reconcile
  → 旧记录存在但规格不同：只有已有 Kernel service update 授权才替换规格
  → 当前规格不存在：返回明确 service specification error
```

删除当前逻辑中“发现旧记录且当前任务不是 retry 就只执行 `status()`”的分支。`status()` 只用于观察，不能代替当前任务的启动。

### 4.3 服务状态和诊断

扩展 `LocalServiceView` 的可选诊断字段，不改变现有状态集合：

```ts
interface LocalServiceDiagnostics {
  workspaceId: string | null;
  specificationRevision: string;
  processId: number | null;
  exitObserved: boolean;
  logTail: string | null;
  healthStatus: number | null;
  retryable: boolean;
}
```

`ManagedLocalServices.check()` 在进程退出、端口占用、健康检查超时和 HTTP 非 2xx 时保留可读原因。日志必须经过现有 `publicText` 和环境引用脱敏；日志只作为 Harness recovery packet 的有界输入。

### 4.4 服务恢复使用现有 continuation/recovery

不新增 `service_repair_attempt` 或 `service_retry_state` 表。复用：

- `KernelAttemptKind = 'continuation'`；
- `recoveryMode = 'recovery_packet'`；
- `boundedRecoveryPacket()`；
- `KernelEvent` 的 recovery/dispatch 机制；
- 现有 `attemptRuntimeRepo` 和 Attempt receipt。

服务诊断 packet 最多包含：

```json
{
  "failure": {
    "kind": "service",
    "code": "service_start_failed|service_health_timeout|port_in_use",
    "summary": "服务进程退出，退出码 1"
  },
  "service": {
    "serviceId": "web-char-echo",
    "workspaceId": "workspace-id",
    "specificationRevision": "sha256:...",
    "command": "node",
    "args": ["server.mjs"],
    "healthUrl": "http://127.0.0.1:8811/health",
    "logTail": "..."
  },
  "knownProgress": ["代码文件已写入", "服务启动未通过"],
  "unknownItems": ["当前代码是否已经修复服务退出原因"]
}
```

不把 secret、完整环境变量或无限日志放进 packet。

自动 continuation 的上限采用现有 Attempt/recovery 预算；达到上限后才进入 `awaiting_decision` 或 `failed`，并向用户展示真实错误和已尝试修复。

## 5. P1：Executor 结果与 Task 收敛

### 5.1 不改 Harness 内部，不提前结束用户目标

当前 `SubtaskAttemptRunner.run()` 仍然只负责一次 Executor Adapter 调用。P1 不把 Pi 的 turn 循环搬入 MetaWork，只调整 Attempt 完成后的结果路由：

- `completed`：进入现有验收和服务验证；
- `contract_failed`：沿用现有 completion correction；
- `executor_failed`：根据 `KernelFailure.kind/code` 选择基础设施 retry、continuation 或真实阻断；
- `uncertain`：保留现有 uncertainty/recovery，不盲目重放外部副作用。

### 5.2 失败类型映射

统一在 `src/execution/failure-reasons.ts` 和 Runtime 入口完成分类：

| 错误 | 处理 | 用户是否立即介入 |
| --- | --- | --- |
| Pi tool 返回错误但 Agent 仍在运行 | 由 Pi 自己继续 | 否 |
| Provider 429/5xx/网络短断 | Pi/Driver 自动重试 | 否 |
| Executor 进程退出且无外部副作用 | Kernel continuation/recovery | 否 |
| 服务启动/健康检查失败 | 服务反馈 continuation | 否 |
| Completion marker 缺失 | 现有 contract correction | 否 |
| Workspace 路径/覆盖范围不明确 | clarification | 是，一次明确问题 |
| 外部副作用状态不确定 | Kernel recovery | 只有无法观察时介入 |
| 自动修复预算耗尽 | awaiting_decision/failed | 是，给出真实诊断 |

### 5.3 用户重复提出同一目标

在 `src/session/conversation-session.ts` 和 `src/execution/kernel-execution-runtime.ts` 收敛入口：

1. 先读取当前 Conversation 的 Workspace 和最近一次失败 Attempt。
2. 如果用户明确提出继续、修复、重新运行或修改同一目标，自动建立新的 continuation Task/Attempt。
3. 复制 Graph 的目标、依赖和验收条件，附加最近失败的 bounded recovery packet。
4. 不要求用户输入内部 Task ID，也不要求先点击“接受并交付”。
5. 如果用户提出了新的、不相容目标，按现有单活动任务规则处理，并只在确实冲突时询问。

## 6. P2：Workspace、变更和交付语义

P2 不重新设计当前 In-place Workspace 方案，只修正用户可见的交付门槛：

1. Planner 明确 `modify_existing`、`continue_existing_edit`、`create_in_target` 和 `run_in_target` 的目标路径。
2. Kernel 审核路径和 ResourceLease；成功后 Executor 直接工作在当前 Workspace。
3. `workspace-change-recorder` 只记录观察事实，不产生“等待接受”的业务状态。
4. `fileOutputs: []` 表示不需要下载文件；它不表示代码不能修改，也不要求用户确认。
5. 已明确要求的源文件修改直接视为用户授权范围内的 Workspace 结果。
6. 只有用户要求精确历史版本、跨 Task handoff 或下载时才生成固定 ArtifactVersion。
7. 最终结果至少包含：完成摘要、变更文件、验证命令/结果、服务 URL/健康状态和 Harness 原始诊断摘要。

需要检查并收缩的入口：

- `src/execution/workspace-publication-worker.ts` 中普通 In-place 任务的 acceptance gate；
- `src/session/conversation-session.ts` 对 `accept_task_result` 的默认触发条件；
- `src/task/task-view.ts` 中把普通完成投影成 `awaiting_acceptance` 的分支；
- `web/src/components/TaskResultActions.tsx` 中普通编辑显示接受按钮的条件。

不删除真正用于不确定结果、部分结果或外部副作用的 acceptance/recovery 能力。

## 7. 具体源码实施顺序

### 第一步：回归测试先行

新增或扩展：

- `tests/execution/kernel-execution-runtime-recovery.test.ts`
- `tests/execution/managed-local-service.test.ts`
- `tests/storage/managed-local-service-repo.test.ts`
- `tests/execution/subtask-attempt-runner.test.ts`
- `tests/web/blocked-task-interaction.test.ts`
- `tests/web/conversation-turn-failure.test.ts`

先写失败测试：

1. 旧 Workspace 服务记录为 `failed`，新 Task 使用同一 `serviceId` 能启动当前规格。
2. 同一 `serviceId` 在两个 Workspace 中存在时，无 Workspace 查询不会误操作。
3. 服务进程退出时，Runtime 能保留日志尾部、退出事实和当前 revision。
4. 服务启动失败后，系统会发起 continuation，而不是只把 Task 置为 failed。
5. continuation 收到 recovery packet 后，Executor 能在当前 Workspace 继续修复。
6. 普通 Workspace 修改不进入 `awaiting_acceptance`。
7. 用户再次提出“修复并运行”时，不需要 Task ID 或按钮操作。

### 第二步：ManagedLocalService 最小修复

先只改服务查询、启动和诊断，不改 Planner/Graph schema：

- 增加 workspace-scoped lookup helper；
- 修改 `startNow` 的历史记录判断；
- 修改 `startRequestedPublishedService` 的旧 failed 分支；
- 增加 bounded log/exit diagnostics；
- 保持现有 `applyAuthorizedOperation` 的 idempotency 和 decision effect；
- 不改变用户已有 service record 和数据库主键。

### 第三步：接入服务反馈 continuation

在 `kernel-execution-runtime.ts` 中增加单一收口方法：

```ts
private async handleServiceVerificationFailure(input: {
  taskId: string;
  subtaskId: string;
  serviceId: string;
  view: LocalServiceView;
  sourceAttemptId: string;
}): Promise<void>
```

该方法只负责：

1. 写入 Task/Execution trace 和 operation result；
2. 读取有界服务诊断；
3. 构造现有 recovery packet；
4. 通过 Kernel workflow 提交 continuation dispatch；
5. 让现有 scheduler 重新执行 Graph 中同一 Subtask。

它不得直接改写 Harness 上下文、调用模型或执行第二套 tool loop。

### 第四步：收缩普通结果交付门槛

逐个检查 TaskView、Conversation read model、Web 结果卡片和 TUI projection：

- 只有明确的 uncertified/partial/external-uncertain 结果显示用户决策动作；
- 已完成的 in-place edit、普通运行结果和成功服务直接显示完成结果；
- “继续未完成任务”只作为异常恢复入口，普通用户输入自动触发 continuation；
- 错误卡片展示真实错误源，不显示“查看下方错误详情”这种没有详情入口的文案。

### 第五步：更新架构文档

代码和聚焦测试通过后再更新：

- 适用 ADR（优先检查 ADR-0021、ADR-0022、ADR-0023、ADR-0024、ADR-0032、ADR-0050）；
- `CONTEXT.md` 的执行可靠性和服务生命周期段落；
- `docs/current/technical-overview.md`；
- `docs/README.md` 当前计划索引。

## 8. 数据库和兼容策略

本次不新增 Task、Graph、Attempt 或 Agent turn 表。已有表继续作为事实来源：

- `tasks`：Task 和 Graph 生命周期；
- `subtasks`：Graph 节点和 acceptance；
- `kernel_dispatch_items`：Kernel 授权后的执行单元；
- `executor_attempt_receipts`：Harness Attempt 结果和诊断；
- `task_events` / `execution traces`：进度和收尾事实；
- `managed_local_services`：当前服务规格、进程和状态；
- `managed_local_service_effects`：服务操作幂等效果；
- `resource_leases` / `resource_waits`：Workspace 资源互斥。

只在以下情况需要 schema 迁移：

1. 现有 `executor_attempt_receipts` 无法保存服务诊断引用；优先使用已有 diagnostics JSON，只有字段不存在才增加 nullable 字段。
2. 现有 Task operation result 无法区分“服务反馈等待 continuation”和“最终服务失败”；优先增加 reason code，不新增状态。
3. Local Service view 的诊断仅用于运行时和事件时，保存在 JSON payload，不单独建立诊断表。

历史数据规则：

- 旧 `failed` service record 不删除；首次按当前 Workspace 查询时只作为历史事实。
- 旧 Task/Attempt 不重写为成功。
- 新 continuation 保留 `sourceAttemptId` 和 recovery packet 引用。
- Server 重启恢复时先观察已有进程，再按当前授权服务规格决定是否启动；不盲目重复启动。

## 9. 验收矩阵

### 9.1 Harness 闭环

| 场景 | 预期 |
| --- | --- |
| Pi 工具命令失败一次后可修复 | 错误作为工具结果返回 Pi，Pi 自己继续，不产生 MetaWork 用户确认 |
| Provider 429/5xx | 使用 Pi/Driver 现有退避，不创建重复 Task |
| Executor 正常多轮修改文件 | MetaWork 只展示进度和最终结果，不插入中间审批 |
| Executor 返回最终结果 | Runtime 继续做文件和 acceptance 验证 |

### 9.2 服务闭环

| 场景 | 预期 |
| --- | --- |
| 旧记录 `failed`，新任务同规格启动 | 当前服务真正启动并健康 |
| 旧记录 `stopped`，用户明确要求启动 | 自动启动 |
| 旧记录规格不同 | 无 update 授权时拒绝并说明规格冲突；有授权时替换并启动 |
| 服务进程退出 | 保留退出原因和日志尾部，自动 continuation |
| 健康检查 503 | 反馈给 Harness 修复，不能伪装成成功 |
| 端口占用 | 返回真实占用错误；可修复时 continuation，耗尽预算后明确交付失败原因 |
| Server 重启后服务记录存在 | 先观察 token/process，再决定是否恢复，不重复启动不属于当前规格的进程 |

### 9.3 Workspace 和交付

| 场景 | 预期 |
| --- | --- |
| 新建 `hello.py` | 直接写入当前 Workspace 并返回路径/内容 |
| 修改为 `See you later` | 直接修改原文件并返回验证结果 |
| 运行已有程序 | 直接返回 stdout、stderr、退出码 |
| 普通编辑完成 | 不显示“接受并交付” |
| 用户明确要求删除/覆盖 | 直接执行；仅在目标不明确时追问 |
| `fileOutputs: []` 的代码任务 | 允许修改 Workspace，不生成额外报告文件 |
| 声明了 fileOutputs 但文件缺失 | 只阻止该文件交付认证，保留已完成代码和真实错误 |

### 9.4 Graph 和 Kernel

| 场景 | 预期 |
| --- | --- |
| Planner 提交合法 Graph | Kernel 审核并 dispatch |
| Planner Graph 被拒绝 | Planner 读取 issues 后在同一 turn 修正并重提 |
| Subtask 依赖未完成 | 由 Graph/Kernel 阻塞，不由 Executor 自行越权执行 |
| ResourceLease 冲突 | 等待资源，不启动 Executor |
| Harness 内部工具调用 | Kernel 不逐调用审核 |
| Graph 完成 | MetaWork 汇总所有 Subtask 结果并直接输出 |

## 10. 分阶段退出条件

### P0 退出条件

- 旧 failed 服务记录不阻断新任务。
- 服务启动失败提供真实诊断。
- 同一 Graph 可以自动生成 continuation 并再次交给同一 Executor 类别。
- BS 服务案例能够生成、启动、健康检查和输出结果。

### P1 退出条件

- Executor 内部多轮执行不被 MetaWork 中断。
- 可修复错误不会提前结束用户目标。
- 用户再次提出修复/运行要求时不需要内部 ID 或按钮。
- 只有真实歧义、外部副作用不确定或预算耗尽才进入用户决策。

### P2 退出条件

- 普通 Workspace 修改直接完成。
- 变更观察、fileOutputs 和最终交付语义一致。
- Web、TUI、CLI 的状态和动作一致。
- 不再出现“已完成却排队”“错误详情不存在”“接受后仍未执行”等状态矛盾。

### 发布前退出条件

- `npm run lint`
- `npm run build`
- `npm run build:web`
- Executor、ManagedLocalService、Kernel recovery、TaskView 和 Web 聚焦测试
- native Server 单实例启动/停止检查
- Hello World、See you later、BS 服务生成/启动/失败修复/再次启动完整验收

完成这些退出条件后，才构建新的 Server/DMG 并进行用户安装测试。

## 11. 明确不做的事情

- 不把 Graph 拆成独立服务或独立调度器。
- 不把 Pi Agent Loop 搬到 MetaWork。
- 不让 Kernel 逐工具、逐模型 turn 审核 Executor。
- 不为服务恢复增加一套独立状态机。
- 不因为大道至简而删除 Graph 审核、ResourceLease、Workspace containment 或最终验证。
- 不在本阶段接入 DeepSeek Harness ACP，除非 Pi/Codex 路径稳定后确有协议需求。

本方案完成的是现有主架构内部的执行闭环收敛：Planner 仍生成 Graph，Kernel 仍审核 Graph，Executor 仍执行 Subtask，MetaWork 仍负责汇总和验证；变化集中在“不打断成熟 Harness”和“失败后自动把诊断送回下一次授权执行”这两个连接点。

## 实施记录（2026-10-27，第一步至第三步部分）

（历史批次记录，当前状态见第四、五批与文档头。）当时状态：**已实施 §4.1、§4.2、§4.3；§4.4 自动修复 continuation 待实施**。

本次文档修订同时固化以下执行原则：Executor/Harness 拥有内部 turn、工具错误、
修复、Provider 重试和验证闭环；MetaWork 只接收最终 Attempt 事实并执行独立验收；
可修复验收失败必须通过 Kernel continuation/recovery packet 返回 Executor；用户只
处理歧义、不可确认外部副作用或自动修复预算耗尽。后续代码实施、测试和发布验收均
以这些边界为强制约束。

已完成：

| 方案条目 | 代码 | 说明 |
| --- | --- | --- |
| §4.1 服务查找带 Workspace | `src/execution/managed-local-service.ts`、`src/execution/kernel-execution-runtime.ts` | 新增 `findForWorkspace()`；Runtime 启动、Kernel 服务快照、服务操作应用都按 `(account, workspace, service)` 解析；无 Workspace 的裸查询仍拒绝推测归属 |
| §4.1 规格 revision 语义 | `src/core/local-service-revision.ts`、`src/storage/managed-local-service-repo.ts` | revision 只 hash 启动契约；同 revision 时记录移交 `task_id` 与规格快照，不同 revision 仍需显式 `update` 授权 |
| §4.2 当前任务优先于历史 failed | `src/execution/kernel-execution-runtime.ts` | `startRequestedPublishedService()` 删除 `status()` 退化分支；存活进程只观察，已退出进程启动；Kernel 允许同 Workspace + 同 revision 的登记移交 |
| §4.2 In-place manifest 继承 | `src/execution/managed-local-service.ts` | 仅当本 Workspace 已登记相同启动契约时采纳上一个 Task 的 manifest；否则仍按“服务规格不属于当前任务”拒绝 |
| §4.3 服务诊断 | `src/task/local-service.ts`、`src/execution/managed-local-service.ts` | 新增 `LocalServiceObservation`/`LocalServiceDiagnostics`；`observe()` 返回退出事实、健康状态、有界脱敏日志尾部、revision、可修复标记；公开视图不含进程标识 |
| §4.4 失败收口接缝 | `src/execution/kernel-execution-runtime.ts` | 新增 `handleServiceVerificationFailure()`：写验证 trace、记录有界修复输入、发出真实诊断的用户可见原因，再收敛必需工作 |
| Run Contract 投影 | `src/execution/run-contract.ts`、`src/execution/execution-runtime.ts` | 每次 Attempt 记录 `diagnostics.runContract`；不含 prompt 文本，不是调度权威 |

测试（先行/回归）：

- `tests/execution/run-contract.test.ts`（新增）：投影字段、默认访问模式、诊断有界且不含目标文本。
- `tests/kernel/managed-service-handover.test.ts`（新增）：同 Workspace 同 revision 移交授权、跨 Workspace 拒绝、不同 revision 拒绝、缺少 Workspace/revision 事实仍按归属拒绝。
- `tests/execution/managed-local-service.test.ts`（扩展）：旧 failed 记录可重启、同 serviceId 跨 Workspace 隔离、退出诊断与日志尾部、公开视图不泄露 `processId`、跨 Task manifest 移交与外来 manifest 拒绝。
- `tests/kernel/control-kernel.test.ts` 的既有归属拒绝用例保持通过（缺少 Workspace/revision 事实时不触发移交）。

未完成（按方案顺序）：

1. **§4.4 服务反馈 continuation**：未新增 `service_verification_failed` Kernel 事件与
   continuation dispatch。实施时需同时解决：completed Subtask 的重新打开语义、
   第二次 publication 的幂等性、修复预算来源。`handleServiceVerificationFailure()`
   是唯一接入点，当前行为是“带真实诊断的确定性失败”。
2. **§5 P1**：`failure-reasons.ts` 的分类表映射、Attempt 多轮 turn 语义、用户重复
   目标的自动 continuation。
3. **§6 P2**：Web/TUI/CLI 交付门槛一致性复核（In-place 路径已不进入 acceptance gate）。
4. **发布前退出条件**：`npm run build`、`npm run build:web`、native Server
   单实例检查与完整用户验收未在本轮执行；仓库工作区中已存在与本方案无关的
   Planner/e2e 失败（本方案改动前后失败集合一致）。

## 实施记录（2026-10-27，服务修复 continuation 闭环）

状态更新为：**§4.1–§4.4 已实施，包括服务反馈 continuation**。以下逐项对应本轮 8 项统一修复。

| # | 问题 | 实施结果 | 代码 |
| --- | --- | --- | --- |
| 1 | 服务失败被错误收敛为最终失败 | 失败先记录 `repair_pending`（不是 `definite_failure`），只有修复预算耗尽或没有可交付的 Executor 目标时才记录确定性失败 | `kernel-execution-runtime.requestServiceRepair/handleServiceVerificationFailure` |
| 2 | 诊断没有进入 Kernel continuation | 诊断进入 `dispatch_requested` 的 `recovery.attemptPayload`（`metawork:service-repair:v1`），Kernel 授权后生成新的 continuation dispatch；runner 把 payload 投影为 recovery packet 并渲染到 prompt | `kernel-execution-runtime.serviceRepairEvent`、`subtask-attempt-runner.boundedRecoveryPacket`、`executor/prompt-builder` |
| 3 | 服务反馈缺少来源 Attempt | `serviceRepairTarget()` 从本 Generation 的最新 completed receipt 解析 `subtaskId`、`sourceAttemptId`、`authorizedBinding`、`bindingFingerprint`，并携带 specification revision 与轮次 | 同上 |
| 4 | 恢复候选排除了已完成 Subtask | 已完成节点通过受控重开 + 显式 recovery dispatch 获得恢复入口，不再依赖 `resumeRecoveryCandidates()` 的 `awaiting_decision/blocked` 前提 | `reopenSubtaskForServiceRepair`、`decideDispatch` recovery 分支 |
| 5 | Subtask 生命周期无法受控重开 | `SUBTASK_TRANSITIONS.completed = ['awaiting_completion']`（唯一出向转换，新增 `isSubtaskReopen()`）；runner 的 continuation 前提 `awaiting_decision` 因此可满足 | `task/task-lifecycle.ts` |
| 6 | Task 状态模型把可修复失败当成最终失败 | `TaskOperationOutcome` 增加 `repair_pending`（schema 60 迁移）；服务必需工作保持 `running`，`activeOperation.phase = 'retrying'`，Task 保持 running 且展示真实错误 | `task-operation-result-repo`、`task-state-facts`、`migrations` |
| 7 | 幂等键过粗 | 操作键 `service:start:<serviceId>:<revision>:<sourceAttemptId>:<ordinal>`；trace `eventKey` 与 dispatch `event id` 同样包含 service/revision/attempt/round | `serviceOperationKey`、`serviceRepairEvent` |
| 8 | Task 失败后阻断自身恢复 | Task 在修复预算内不再进入终态，`startRequestedPublishedService()` 的终态 fence 不再误伤本轮；服务修复轮次结束后同一调用内重新验证 | `startRequestedPublishedService` 循环 |

补充说明：

- `ExecutorAttemptReceiptRepo.listByTask()` 是最新在前的顺序，`serviceRepairTarget()`
  取第一个匹配项，因此来源 Attempt 始终是产出当前代码（或最近一轮修复）的那一次。
- 剩余工作重试（`resumeRemainingWork`）没有执行 workflow：它记录 `repair_pending` 与
  受控重开，并在结束时用一次正常 drive 把待派发的 continuation 交给带 workflow 的
  服务验证循环，避免修复请求停在日志层。
- 修复轮次若改动了启动契约，Runtime 先经 `managed_service_requested(update)` 的
  Kernel 授权停服并绑定新 revision，再启动；未授权的规格变更仍然拒绝。

Kernel 侧授权（新增，仍然只做边界审核）：`dispatch_requested` 的 recovery 分支在
payload 为 `metawork:service-repair:v1` 时要求 `attemptKind = 'continuation'`、
存在 `sourceAttemptId`、`repairOrdinal` 等于 `serviceRepairAttemptsBySubtask` 的
持久计数、轮次小于 3、payload 身份字段完整且日志尾部有界；否则 `block_work`
并给出真实原因（预算耗尽时明确写出已尝试轮次）。

测试（新增/扩展）：

- `tests/execution/service-repair-continuation.test.ts`：`repair_pending` 记录与
  操作键、来源 Attempt 解析、Kernel dispatch 事件与 payload、预算耗尽后的确定性
  失败、无 completed receipt 时拒绝修复、Kernel 只授权下一轮/拒绝越界与过期、
  验证循环的轮次与终止；prompt 侧断言服务诊断真正进入模型上下文。
- `tests/task/task-state-regressions.test.ts`：`repair_pending` → Task running +
  phase `retrying` + 无 pending action；`definite_failure` → failed；按最新服务
  操作（而非固定 key）判定。
- `tests/task/task-lifecycle.test.ts`：completed 仅允许修复重开。
- `tests/storage/migrations.test.ts`：59→60 保留历史操作结论并接受 `repair_pending`。
- `tests/executor/prompt-builder-context-layering.test.ts`：服务诊断在 prompt 中。
- `tests/execution/managed-local-service.test.ts`、`tests/kernel/managed-service-handover.test.ts`：上一轮的服务身份/移交回归。

Schema 变更：`CURRENT_SCHEMA_VERSION` 59 → 60，重建 `task_operation_results`
的 outcome CHECK；`docker/shell.ps1` 的数据卷版本同步为 v60。

仍然未完成（不属于本轮 8 项）：`tests/kernel/control-kernel.test.ts` 中 14 个用例在
本轮改动之前即已失败（本次改动前后失败集合一致）；`npm run build` / `build:web` /
native Server 单实例检查与完整用户验收未执行。

## 实施记录（2026-10-27，第三批：P1 状态收敛与 P2 交付语义）

状态更新为：**§4、§5、§6 已实施**。以下按实施方案条目记录。

### §5.1 Attempt 与 Harness 循环

- 一个 Attempt 内的模型/工具循环完全属于 Harness：Runtime 的 `SubtaskAttemptRunner.run()`
  只做一次 Adapter 调用，不插入 turn、工具或修复控制。本轮核对未发现人为 turn 上限；
  `Pi`/`Codex` 的工具失败、follow-up 与 Provider 退避保持原状。
- 服务失败的修复走新的授权 Attempt（continuation），不在原 Attempt 内重放（见上一批记录）。

### §5.2 失败分类（实现映射）

| 场景 | Runtime 行为 | 用户是否介入 |
| --- | --- | --- |
| Pi 工具失败 | 由 Pi 自己继续（toolResult isError） | 否 |
| Provider 429/5xx/网络短断 | Pi/Driver 既有退避 | 否 |
| 完成 marker 缺失 | 既有 `contract_correction` | 否 |
| 服务未达健康 | `repair_pending` + 授权 repair continuation | 否 |
| 服务端口占用/规格冲突 | 真实原因写入可见输出、事实与 trace | 是（可操作的一条信息） |
| Workspace/覆盖范围不明确 | 既有 clarification | 是 |
| 外部副作用不确定 | 既有 Kernel recovery | 仅无法观察时 |
| 自动修复预算耗尽 | `definite_failure` + 真实错误与已尝试轮数 | 是 |

### §5.3 用户重复提出同一目标

新增两处**确定性**诊断传递，使下一轮从真实错误开始：

1. **Planner 权威事实**（`src/planning/planner-mcp-server.ts`）：
   - `get_task_context` 增加 `task.failure`：Task 结论 `reason`（code+message）、最近 4 条非
     success 的归一化操作结果、最近一次失败 Attempt 的 `failureCode`/`failureSummary`；
   - `search_tasks` 每条带 `reason`；
   - 工具描述与 Planner system prompt（`planner/AnyFusion-Pi/.../planner-system-prompt.ts`）
     明确要求：用户再次要求同一目标时先读该 Task 的 failure 事实，把真实原因写进新 Work
     Graph 的子任务目标与验收条件；终态 Task 是历史，当前请求自然取代它，不要求用户提供
     task id、也不要求先清理旧 Task。
2. **Executor 上下文**（`src/execution/subtask-execution-context.ts` + `src/executor/prompt-builder.ts`）：
   同一 Conversation 且同一 Workspace 中最近一个 `failed` Task 的诊断作为
   `previousRound` 投影进入 Attempt 上下文与 prompt（goal / 结论 / code / 非 success 操作
   结果，均有界）；prompt 要求确认当前状态不再复现该失败、不要重复同一条失败命令。
3. **自然取代**：终态 Task 不再占用执行名额（`reconcileConversationAdmission` 在每轮规划前
   释放 failed/succeeded/cancelled 的 slot），新请求按普通准入继续；旧 Task 保持其结论与
   历史，不被改写。Web 失败任务卡片明确提示"直接用下方说明要继续或修复什么"，把
   `/task retry` 降为次要的显式恢复动作（不再高亮为主操作）。

### §6 P2 Workspace、变更与交付

- `projectPublicDelivery()` 不再把 `pendingDecision` 当成交付状态：工作区文件状态只反映文件
  事实（`published`/`not_published`），结果验收决策属于 Task 级动作。普通 In-place 编辑不再
  出现"等待用户接受"的文件状态。
- 复核四个入口：`workspace-publication-worker` 的 acceptance gate 仅对
  `!inPlace && policy === 'await_acceptance'` 生效；`conversation-session` 的
  `accept_task_result` 只有用户显式命令触发；`task-view` 只在存在未认证结果/部分结果时投影
  `accept_result`；`TaskResultActions.tsx` 只展示交付事实。
- `fileOutputs: []` 的代码任务继续允许修改 Workspace，prompt 明确"不生成额外报告文件"；
  ArtifactVersion 只用于下载、跨任务 handoff 与稳定字节输入。

测试（新增/扩展）：

- `tests/planning/planner-mcp-server.test.ts`：失败 Task 的 `failure` 事实（结论 reason、非
  success 操作结果）与 `search_tasks` 的 reason 投影。
- `tests/execution/subtask-execution-context.test.ts`：`previousRound` 的传递与
  Conversation/Workspace 隔离。
- `tests/executor/prompt-builder-context-layering.test.ts`：失败轮次段落的渲染与缺省。
- `tests/execution/terminal-task-supersede.test.ts`：failed Task 释放 slot、运行中 Task 保持
  slot、历史 Task 不被改写。
- `tests/delivery/public-delivery-view.test.ts`、`tests/task/task-view.test.ts`、
  `tests/web/blocked-task-interaction.test.ts`：工作区文件状态不再伪装成验收、普通完成不产生
  用户决策、失败卡片提示自然续做。

未完成（明确记录）：

- `retry_task_attempt` / `retry_remaining_work` 仍是可用的显式恢复命令（已降级为次要动作），
  未删除其 Kernel/Runtime 入口。
- P3（DeepSeek Harness ACP Adapter）未进入。
- 仓库既有 55 个失败用例（kernel/e2e/session 等）在本轮前后失败集合一致；`npm run build`
  与 `build:web`、native Server 单实例与完整用户验收未在本轮执行。

## 实施记录（2026-10-27，第四批：评审缺陷修复）

状态更新为：**§4–§6 已实施，并通过一轮严格评审修复**。以下逐项对应评审提出的缺陷。

| # | 缺陷 | 修复 | 代码 |
| --- | --- | --- | --- |
| 1 | 服务修复在 Kernel 授权前重开 Subtask，被拒绝/异常后留下不可达状态 | 仅在提交前后短暂重开；任何未授权的结局（拒绝、过期、异常、batch 不含本 Subtask）都回滚到 `done` | `kernel-execution-runtime.requestServiceRepair/rollbackRefusedServiceRepair` |
| 2 | 无 workflow 的服务修复路径卡死（已改为 awaiting_decision，`serviceRepairTarget` 只认 done） | 无 workflow 时**不**重开：只写 `repair_pending`，Subtask 保持 `done`，下一次 drive 仍能找到修复目标 | 同上 |
| 3 | 忽略 Kernel 拒绝结果，仍返回 true 并重复健康检查 | 读取 `workflow.submit()` 的 decision，只有针对本 Subtask 的 `dispatch_batch` 才算授权；否则返回 false 并记录确定性失败 | 同上 |
| 4 | 服务修复不校验 Executor binding 仍属于该 Subtask | Kernel recovery 分支新增 `subtask.executorBindings` 成员校验（指纹自洽不再足够） | `control-kernel.decideDispatch` |
| 5 | 服务修复可能反馈给错误的 Subtask | 目标必须证明自己产出了服务：`fileOutputs` 声明或用观测 delta 写入 `.metawork-service.json`；多个已完成 Subtask 且无证据时拒绝（返回 null） | `kernel-execution-runtime.serviceRepairTarget/attemptProducedService` |
| 6 | `previousRound` 的 retry 关系写反 | 改为 `currentTask.retryOfTaskId` 存在即不注入（retry Task 自带续做事实） | `subtask-execution-context.resolvePreviousRound` |
| 7 | `previousRound` 污染同一 Conversation/Workspace 的无关任务 | 仅注入“紧邻的上一轮”：该 failed Task 之后不得存在任何其他 Task（`NOT EXISTS` 子查询） | 同上 |
| 8 | Planner 状态筛选仍用旧枚举 | 改为六态 `queued/running/needs_action/succeeded/failed/cancelled`；未知状态显式返回 `invalidStatuses` + `allowedStatuses` 而不是悄悄放宽查询 | `planner-mcp-server.TASK_STATUSES/searchTasks` |
| 9 | 普通 Task 也被投影成 failure | `reason.code === 'none'` 视为“没有原因”，不再产出 `reason`/`failure` | `planner-mcp-server.taskStateReason` |
| 10 | 把 `uncertified_result` 当成失败 Attempt | 失败尝试只取 `executor_failed`/`heartbeat_lost`/`contract_blocked` | `planner-mcp-server.taskFailureDiagnosis` |
| 11 | 失败诊断遗漏 `contract_blocked` | 同上，已纳入并给出真实 failureCode/summary | 同上 |
| 12 | 失败诊断查询没有 account 隔离 | `searchTasks`/`getTaskContext`/操作结果/Attempt 查询全部带 `account_id` 约束（fixture 对齐到同一账户边界） | 同上 |
| 13 | 服务修复预算按 dispatch 行数计算（含取消/未启动） | 预算只统计真正消耗轮次的 dispatch：`cancelled` 不计数，in-flight 与 settled 计数；Runtime 与 Kernel 共用同一规则 | `serviceRepairRoundCounts`、`serviceRepairAttempts` |

测试（新增/扩展）：

- `tests/execution/service-repair-continuation.test.ts`：无 workflow 不重开、拒绝/异常/非本 Subtask batch 的回滚与确定性失败记录、Kernel 拒绝原因进入可见输出与 Task 原因、预算只计有效轮次（取消不计、in-flight 计）、修复目标的服务归属证据与多 Subtask 歧义拒绝。
- `tests/execution/subtask-execution-context.test.ts`：retry Task 不注入、无关新任务不注入、紧邻上一轮注入。
- `tests/planning/planner-mcp-server.test.ts`：旧状态枚举被显式拒绝、健康 Task 不投影失败、account 隔离、`uncertified_result` 忽略与 `contract_blocked` 纳入。
- `tests/kernel/managed-service-handover.test.ts`：binding 不再是 Subtask 授权项时 Kernel 拒绝。

验证：`npx tsc --noEmit` 与 Web typecheck 通过；`tests/execution|storage|task|planning|delivery|web|memory` 共 194 文件 / 1416 用例通过。

## 实施记录（2026-10-27，第五批：内部恢复与验收矩阵收尾）

状态更新为：**§4–§7 已实施；`retry_remaining_work` 已内部化；验收矩阵新增覆盖；构建门槛通过。**

### 1. `retry_remaining_work` 变为内部恢复协议

新增 `attemptAutomaticRemainingWork(taskId)`：服务修复预算耗尽、Kernel 拒绝修复轮次，或文件交付
失败后，若已完成工作可安全复用，Runtime 自动创建续做任务（只补交付与服务启动），不再要求用户
执行 `/task retry`。

边界（全部有回归测试）：

- 只在 Task 已进入 `failed` 结论后触发；
- 本身是续做任务（`retryOfTaskId` 非空）时不再产生下一轮，避免自动链式重试；
- 已存在续做任务时复用而不重复创建；
- Kernel 拒绝安全复用时保留真实失败结论，不制造"正在恢复"的假象。

Web 失败卡片仍保留 `/task retry` 作为次要显式入口（自动路径被拒绝或历史任务时使用），
TUI 只在 `resultDecision.actions` 含 `accept_result`/`retry_attempt` 时展示对应命令，
CLI 的 next-step 文案指向"直接输入新的要求"——三者语义一致。

### 2. 验收矩阵（§9）新增覆盖与一处真实缺陷修复

- 新增 `tests/execution/managed-local-service.test.ts` 的 §9.2 用例：
  - 旧记录 `stopped` + 显式启动 → 真正启动并通过健康检查；
  - 规格变更必须先经授权 `update` 绑定新 revision，再按新端口启动；
  - 健康检查持续 503 永不伪装成成功，且真实 503 作为修复输入保留。
- 缺陷修复：`ManagedLocalServices` 的观测事实按 **specification revision** 归属；进程退出后的
  再次观测不再清空同一契约最近一次真实 HTTP 响应（503/200），超时判定也只新增"超时"结论，
  这样修复轮次拿到的是真实健康状态而不是 `null`。

### 3. 连带修复

- 续做任务的 `remaining.startService` 改为读取"最新服务操作结论"，与 §4.3 的按轮次操作键一致；
  之前按固定键 `service:start` 判断会让已成功的服务被再次启动（幂等观察，但语义错误）。

### 4. 发布门槛

- `npm run build`（tsup + 内置 `build:web`）通过；`npx tsc --noEmit` 与 Web typecheck 通过。
- 聚焦套件（execution/storage/task/planning/delivery/web/memory）全绿。
- 仍未执行（需要真实环境/外部依赖）：native Server 单实例启动/停止检查（本机无安装配置根）、
  真实 Provider 的 Hello World / See you later / BS 服务端到端用户验收、P3（DeepSeek Harness
  ACP Adapter，方案明确为后续可选事项）。
