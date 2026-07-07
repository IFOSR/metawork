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
- 位置：[src/session/kernel-decision-applier.ts](../../src/session/kernel-decision-applier.ts)
- 现状：resume/fork 时把计划 `action` 强制改写成 `plan_work_graph` 并绑定 `taskId`，使 coordinator 走执行分支。这导致持久化的决策 `action` 与真实来源（可能是 task_control）不一致；只有靠 fallback work graph 才能补出可执行的子任务。
- 目标：resume/fork 由 planner/kernel 显式产出带 `workGraph` 的执行计划，不再在应用层临时改写 `action`。**下一步。**

### 5. `TaskResumePlanner.planLegacyOrNaturalLanguageResume` 仍依赖旧 LLM 路由匹配
- 位置：[src/task/task-resume-planner.ts](../../src/task/task-resume-planner.ts)（`planLegacyOrNaturalLanguageResume` → `TaskSemanticService.resolveLegacyResumeIntent`）
- 现状：`last_task_continuation` 由关键词触发（`isContinuePreviousTaskInstruction`），planner 看不到
  `sessionStateRepo` 的 `lastFocusedTaskId`/`lastCompletedTaskId` 指针，无法在 `plan.task.taskId` 指明
  targetTask。当 sessionStateRepo 指针缺失时，`planLegacyOrNaturalLanguageResume` 退回调用旧的
  `llmBridge.resolveRoute`/`resolveIntent`（经 `resolveLegacyResumeIntent`）做兜底语义匹配找 targetTask。
  第三步已删掉该分支里手搓 `IntentDecisionV2` 的代码（改用传入的 plan），但**旧 LLM 路由调用本身仍在**。
- 目标：让 planner 在 `last_task_continuation` 场景直接产出 targetTask（需把 sessionStateRepo 指针喂进
  `PlanningContext`），或由 kernel 显式解析指针，从而删除 `resolveLegacyResumeIntent`/
  `hasLegacyResumeResolver` 及 `llmBridge.resolveRoute`/`resolveIntent` 的 resume 兜底依赖。

## 移除顺序建议

1. ~~先落地真实 planner adapter（解决 #1、#2）~~ —— ✅ 已完成。
2. ~~迁移 `TaskResumePlanner` 到 `PlanningAgentPlan`（解决 #3）~~ —— ✅ 已完成。附带清理 ghost 文件
   `SessionIntentApplicationService`；新增 #5 记录遗留的旧 LLM 路由兜底。
3. 解决 #4（`bindPlanToTask`）——让 resume/fork 由 planner/kernel 显式产出 workGraph。
4. 解决 #5——把 sessionStateRepo 指针喂给 planner，删除 `resolveLegacyResumeIntent` 旧路由依赖。
5. 删除 `ExecutorProfile`、`IntentOrchestrator`、`IntentDecisionV2` 及相关映射（届时新主路径已完全不消费）。

相关背景见 [docs/adr/0014-planning-agent-policy-kernel-boundary.md](../adr/0014-planning-agent-policy-kernel-boundary.md) 的 Future Work 一节。
