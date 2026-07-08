# 遗留兼容层清单（有损桥接已全部移除）

> 状态：**#1~#5 兼容 shim 全部已移除**。这些曾是 ADR-0014（`PlanningAgent → PolicyKernel → Runtime` 回正）为了控制改动面而保留的旧体系（`IntentOrchestrator` / `IntentDecisionV2` / `ExecutorProfile`）适配层——"往回转成旧结构"的有损桥接。它们已在数轮重构中逐个拆除，`src/` 内不再有 `TODO(adr-0014-compat)` 标记。
>
> 仅剩「移除顺序」第 5 步：删除 `ExecutorProfile` / `IntentOrchestrator` / `IntentDecisionV2` 等**类型与死代码**（不是有损桥接，而是新主路径已不消费的残留符号），涉及面广，单独评估。

## 为什么先保留

把 `PlanningAgent` 直接接真实 Codex CLI planner、把 `TaskResumePlanner` 迁到 `PlanningAgentPlan`、把 executor 画像统一到 `AgentClass`，改动面都很大且互相牵连。本轮只回正"理解 → 授权 → 执行"的职责边界，兼容层作为过渡，下一步再逐个拆除。

## 兼容层清单

### 1. `SemanticPlanningAgent` 内部复用 `IntentOrchestrator` — ✅ 已移除（第一步）
- 状态：**已移除**。原 `src/planning/semantic-planning-agent.ts` 已删除，由真实的
  [src/planning/codex-planning-agent.ts](../../src/planning/codex-planning-agent.ts)（`CodexPlanningAgent`）取代：
  直接调 Codex CLI 产出 `PlanningAgentPlan`（含多子任务 DAG 工作图），自带 schema+依赖图校验与一次修复重试，
  失败时保守降级为 `direct_reply`。输出计划标记改为 `source: 'codex-planner'`。
- 遗留：`IntentOrchestrator` 类目前仅剩测试/ghost 引用，`IntentDecisionV2` 类型仍被 #3/#4 消费，
  待第二步随 `TaskResumePlanner` 迁移一并删除。

### 2. `agentClassToLegacyProfile`（AgentClass → ExecutorProfile 手工降级）— ✅ 已移除（第一步）
- 状态：**已移除**。随 `semantic-planning-agent.ts` 一并删除。`CodexPlanningAgent` 直接消费
  `AgentClass`（在 prompt 中透传 `skills`/`mcpServers`/`harness`/`model` 等原先被丢弃的字段），
  不再降级成 `ExecutorProfile`。`ExecutorProfile` 类型本身仍被 `executor-router` 等旧模块使用，留待后续。

### 3. `intentDecisionFromPlan`（PlanningAgentPlan → IntentDecisionV2 回转）— ✅ 已移除（第三步）
- 状态：**已移除**。`TaskResumePlanner` 的全部四个 resume 方法
  （`planReferencedTask`/`planLastTaskContinuation`/`planNaturalLanguageResume`/`planBlockedRecovery`）
  现在直接消费 `PlanningAgentPlan`——planner 产出的 plan 一路传到底，不再手搓任何 `IntentDecisionV2`。
  `intentDecisionFromPlan` shim 与其 `IntentDecisionV2` import 已从 `kernel-decision-applier.ts` 删除。
  `planReferencedTask` 内部对 `task.binding`/`task.taskId`/`task.control` 的读取 1:1 改为读 `plan.task.*`，
  无信息丢失（`hints`/`response`/`workGraph` 不再被降采样丢弃）。
- 附带清理：删除了 ADR-0014 后零引用的 ghost 文件 `src/session/session-intent-application-service.ts`
  （旧 `IntentDecisionV2` 主路径，功能已被 `KernelDecisionApplier` 完整覆盖）。

### 4. `bindPlanToTask`（resume/fork 时把 `action` 伪装成 plan_work_graph）— ✅ 已移除
- 状态：**已移除**。`bindPlanToTask` 改名为 `bindPlanToReferencedTask`，只固定任务引用
  （`taskId` + `binding='reference'`），**不再改写 `action`**；[session-execution-coordinator.ts](../../src/session/session-execution-coordinator.ts)
  里那道 `action !== 'plan_work_graph'` 的 guard 一并删除。
- 纠正一处此前的错误描述：**不存在"审计失真"。** `recordPlanningDecision` 在 `apply()` 顶部就用**原始**
  plan+decision 落库，`bindPlanToTask` 改写出的副本只挂在临时的 `QueuedExecutionRequest.planningPlan` 上、
  **从不持久化**。持久化的 `plan.action`=`task_control`、`decision.runtimeAction`=`task_control`，始终如实。
- `bindPlanToTask` 的**唯一**真实作用，是把 resume/fork 的 `action` 伪装成 `plan_work_graph`，好绕过 coordinator
  那道 guard。而该 guard 本身是**死防御**：只有 `createAndPrepareTask`（原生 `plan_work_graph`）和这 3 个改写站点
  才会给请求带 `planningPlan`；定时/调度自动恢复路径不带 plan（`&&` 短路），所以 guard 的 "no executor dispatch"
  分支根本不可达。凡进入调度的请求都意在执行（create/resume/fork/unblock），因此改为诚实信号 + 删 guard。
- 执行侧行为不变：[work-graph-runtime-service.ts](../../src/execution/work-graph-runtime-service.ts) 的 `apply()`
  先查 `subtaskRepo.listByTask(taskId)`——已有子任务走 `recoverExisting()` 复用历史工作图（resume parked /
  recover blocked / execute_existing），fork 的全新 taskId 无历史子任务仍走 `fallbackWorkGraph`。
- **不在本项范围**：fork 目前是"完成后续作"（NL 语义触发、带旧 resources + 旧任务作上下文、不拷工作图、落
  fallback；MetaClaw 无 per-task 工作区实体）。"显式克隆 fork"（用户显式 command 触发 + 克隆工作区 + 原封拷
  工作图）是一个**独立新特性**，不属于兼容层移除，另开计划评估，详见下方备注。

### 5. `TaskResumePlanner` 的 resume 目标选择（旧 LLM 路由 + session 指针猜测）— ✅ 已移除（第四步）
- 状态：**已移除**。恢复哪个任务的判断已上移到 `PlanningAgent`：planner 读 `PlanningContext.recentTasks`
  （已扩展 `lastInterruptionReason`/`nextStep`/`blockedReason` 投影）+ `currentFocus`，选定 taskId 后产出
  `binding='reference'` + `taskId` + `control='resume_task'|'recover_blocked'`，选不定则返回 `clarification`。
  [PolicyKernel](../../src/kernel/policy-kernel.ts) 强制 `resume_task`/`recover_blocked` 必须带明确 taskId，
  否则改判 clarify；runtime 不再兜底猜任务。
- 已删除：`TaskResumePlanner.planLastTaskContinuation`/`planNaturalLanguageResume`/
  `planLegacyOrNaturalLanguageResume`/`findMostRecentUnfinishedTask`；`TaskSemanticService.decideResumeTarget`/
  `resolveLegacyResumeIntent`/`hasTaskResumeResolver`/`hasLegacyResumeResolver` 及对应 `llmBridge` 依赖；
  `last_task_continuation` control（含 `IntentTaskControl`/`SemanticTaskControl` 枚举与 rule-hints 关键词注入）；
  list-picking 的 `reconcileBlockedTasksFromInput`（改为对已知任务的 `evaluateBlockedTask`）。
- 保留：`planReferencedTask`（对已知 referencedTask 按 status 做确定性恢复）与 `evaluateBlockedTask` 的
  补充材料提取能力（现只对 planner 已选定的任务执行）。

## 移除顺序建议

1. ~~先落地真实 planner adapter（解决 #1、#2）~~ —— ✅ 已完成。
2. ~~迁移 `TaskResumePlanner` 到 `PlanningAgentPlan`（解决 #3）~~ —— ✅ 已完成。附带清理 ghost 文件
   `SessionIntentApplicationService`；新增 #5 记录遗留的旧 LLM 路由兜底。
3. ~~解决 #5——把 resume 目标选择上移到 planner，删除 `resolveLegacyResumeIntent`/`decideResumeTarget`
   旧路由依赖与 `last_task_continuation` control~~ —— ✅ 已完成。
4. ~~解决 #4（`bindPlanToTask`）——停止在应用层改写 `action`，改为诚实信号并删除那道死防御 guard~~ —— ✅ 已完成。
5. ~~删除 `ExecutorProfile`、`IntentOrchestrator`、`IntentDecisionV2` 及相关映射~~ —— ✅ 已完成。

## ✅ 本清单已关闭

`#1~#5` 全部完成。第 5 步的"证死再删"扫描发现旧类型并非纯死代码——新主路径仍在复用其中的小型字符串联合类型别名，`llm-bridge` 仍用到少量工具函数，且一个 `/executor route` 预览命令还在养活旧 `PlannerRoutingSkill`。据此完成了以下收尾（见对应提交）：

- **删除**整棵旧路由/意图子系统：`src/core/{intent-orchestrator,semantic-intent-router,executor-router,execution-planning-service}.ts`、`src/routing/execution-policy-planner.ts`、`src/planner/*`（`planner-runtime-service`/`intent-recognition-skill`/`planner-routing-skill`）、`src/storage/executor-route-event-repo.ts`，以及对应的测试套件。
- **迁移**仍被主路径消费的类型到活代码家：`Intent*` 字符串联合别名 → `src/planning/planning-types.ts`；`ExecutionResult` → `src/execution/execution-runtime.ts`。
- **精简**活文件中的死链：`llm-bridge` 的 `resolveIntentDecision` 链、`session-persistence-service` 的 route-event 写入、`QueuedExecutionRequest` 的 `intentDecision`/`semanticExecutorDecision` 字段、`TaskAdmissionGate.evaluateIntent`、`/executor route` 预览子命令（该命令预览的是已退役的旧路由，已随子系统删除）。

`src/` 内不再有 `TODO(adr-0014-compat)` 标记，`src/routing`、`src/planner` 目录已消失。

> 与本清单无关的后续想法：**"显式克隆 fork"**（command 触发 + 克隆工作区 + 原封拷工作图）是独立产品特性，不是兼容层，另行立项。

相关背景见 [docs/adr/0014-planning-agent-policy-kernel-boundary.md](../adr/0014-planning-agent-policy-kernel-boundary.md) 的 Future Work 一节。
