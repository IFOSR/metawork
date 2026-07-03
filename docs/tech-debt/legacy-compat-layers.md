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

### 3. `intentDecisionFromPlan`（PlanningAgentPlan → IntentDecisionV2 回转）
- 位置：[src/session/kernel-decision-applier.ts](../../src/session/kernel-decision-applier.ts)
- 现状：把新的 `PlanningAgentPlan` 又转回旧的 `IntentDecisionV2`，只为调用尚未迁移的 `TaskResumePlanner.planReferencedTask`。转换是有损的（`hints` 硬编码为 `[]`，`response`/`workGraph` 丢弃），因此 resume 决策看到的是计划的降采样视图。
- 目标：`TaskResumePlanner` 直接接受 `PlanningAgentPlan`（或专门的 resume 上下文），删除回转。

### 4. `bindPlanToTask`（把 task_control 计划强改成 plan_work_graph）
- 位置：[src/session/kernel-decision-applier.ts](../../src/session/kernel-decision-applier.ts)
- 现状：resume/fork 时把计划 `action` 强制改写成 `plan_work_graph` 并绑定 `taskId`，使 coordinator 走执行分支。这导致持久化的决策 `action` 与真实来源（可能是 task_control）不一致；只有靠 fallback work graph 才能补出可执行的子任务。
- 目标：resume/fork 由 planner/kernel 显式产出带 `workGraph` 的执行计划，不再在应用层临时改写 `action`。

## 移除顺序建议

1. ~~先落地真实 planner adapter（解决 #1、#2）~~ —— ✅ 已完成。
2. 迁移 `TaskResumePlanner` 到 `PlanningAgentPlan`（解决 #3、#4）。**下一步。**
3. 删除 `ExecutorProfile`、`IntentOrchestrator`、`IntentDecisionV2` 及相关映射。

相关背景见 [docs/adr/0014-planning-agent-policy-kernel-boundary.md](../adr/0014-planning-agent-policy-kernel-boundary.md) 的 Future Work 一节。
