# 遗留兼容层清单（亟待在下一步移除）

> 状态：**高优先级技术债**。这些是 ADR-0014（`PlanningAgent → PolicyKernel → Runtime` 回正）为了控制改动面而保留的旧体系（`IntentOrchestrator` / `IntentDecisionV2` / `ExecutorProfile`）适配层。它们让新主路径能在不重写 `TaskResumePlanner`、`IntentOrchestrator` 的前提下先跑通，但都属于"往回转成旧结构"的有损桥接，应在下一轮统一移除。
>
> 每一处源码都用 `TODO(adr-0014-compat)` 标注，可全局搜索定位。

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

### 4. `bindPlanToTask`（把 task_control 计划强改成 plan_work_graph）
- 位置：[src/session/kernel-decision-applier.ts](../../src/session/kernel-decision-applier.ts)（`bindPlanToTask`，标注 `TODO(adr-0014-compat)`）
- 现状：resume/fork/unblock 时把计划 `action` 强制改写成 `plan_work_graph` 并绑定 `taskId`，使 coordinator 走执行分支。
- 澄清（残留比这条标题暗示的窄）：执行侧的 workGraph 复用其实是健康的。
  [work-graph-runtime-service.ts](../../src/execution/work-graph-runtime-service.ts) 的 `apply()` 先查
  `subtaskRepo.listByTask(taskId)`：**已有子任务就走 `recoverExisting()` 复用任务自己的历史工作图**
  （把未完成子任务翻回 `ready`，terminal 的不复活，并用 kernel 最新路由覆盖过期路由），根本不碰 `fallbackWorkGraph`。
  因此 **resume parked / recover blocked 都在复用历史 workGraph，不走兜底。**
- 真正的两处残留：
  1. **审计失真（所有 task_control 都中招）**：`bindPlanToTask` 无条件把 `action` 改成 `plan_work_graph`，
     即便执行侧走的是复用历史图的 `recoverExisting`，持久化的 `decision.action` 仍谎报成"新工作图"、丢失
     task_control 出身——账实不符，与是否复用历史图无关。
  2. **fork 跟进任务缺真实规划**：`fork_follow_up` 会 `createTask` 一个全新 taskId，新任务没有历史子任务
     （`existing.length === 0`）→ 落到 `fallbackWorkGraph` 的通用单子任务。这里**不能借源任务的历史图**
     （跟进是新目标，旧图不适配），本应由 planner 为新目标现产一张 `workGraph`。这才是唯一真正"缺图靠兜底"的场景。
- 目标：resume/fork 由 planner/kernel 显式产出带 `workGraph`（或原生 task_control）的执行计划，不再在应用层临时
  改写 `action`；fork 跟进由 planner 为新目标现产工作图，取代通用 fallback。**下一步。**

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
4. 解决 #4（`bindPlanToTask`）——停止在应用层改写 `action`（修审计失真）；fork 跟进由 planner 为新目标现产 workGraph，取代通用 fallback。（resume 复用历史图已健康，无需改。）
5. 删除 `ExecutorProfile`、`IntentOrchestrator`、`IntentDecisionV2` 及相关映射（届时新主路径已完全不消费）。

相关背景见 [docs/adr/0014-planning-agent-policy-kernel-boundary.md](../adr/0014-planning-agent-policy-kernel-boundary.md) 的 Future Work 一节。
