# Planning Agent And Policy Kernel Boundary

## Status

Accepted.

## Context

MetaClaw accepts the 2026-07-01 planning-agent/policy-kernel model:

```text
User natural-language input
  -> Planner Work Unit implements PlanningAgent
  -> PlanningAgentPlan
  -> PolicyKernel
  -> KernelDecision
  -> MetaClaw Runtime
```

This replaces the previous planner-first execution-dispatch framing, where session intake, task recovery, subtask persistence, and dispatch policy were spread across `IntentOrchestrator`, session services, planner runtime, and execution coordination. That shape made the planner responsible for both understanding and stateful dispatch, while the intended MetaClaw kernel layer had no clear implementation boundary.

## Decision

`Planner Work Unit` is the runtime instance; `PlanningAgent` is the interface it exposes. The planning agent understands user intent, target task/session, clarification needs, executor candidates, and optional work graph proposals.

`PolicyKernel` is the deterministic authorization layer. It validates or rewrites a `PlanningAgentPlan` against a runtime snapshot, including schema shape, confidence, task state, single-active-task conflict, blocked/recovery constraints, and executor availability.

`Runtime` applies a `KernelDecision`. Runtime services create or bind tasks, persist kernel-approved subtasks, claim executor work units, call execution runtimes, present task-control results, deliver direct replies, and write audit rows.

The current implementation is interface-first rather than a real Codex CLI planning adapter. Existing semantic routing logic may be reused only inside the `PlanningAgent` implementation; session code must not keep a fallback path that bypasses the kernel. The kernel returns a decision instead of writing storage directly.

Explicit memory/preference capture fast paths remain outside this policy kernel in v1. This avoids expanding the memory policy while this change is only trying to restore the task planning and dispatch boundary.

## Consequences

The natural-language path has one policy seam: `PlanningAgent -> PolicyKernel -> KernelDecisionApplier`. This makes it easier to test whether task creation, task control, direct reply, clarification, and work graph execution all pass through the same authorization point.

Planner output is a proposal, not an executable command. Work graphs become durable `Subtask` records only after the kernel accepts or rewrites the plan.

The first version preserves current product behavior: one active top-level task, serial subtasks, fixed planner/executor work-unit pool, and synchronous heartbeat sweep before dispatch or claim attempts.

## Future Work

- ~~Replace the internal semantic adapter with a real Codex CLI planner adapter.~~ Done: `CodexPlanningAgent` emits `PlanningAgentPlan` (with multi-subtask DAG work graphs) directly from Codex CLI; the `IntentOrchestrator` semantic adapter is no longer on the planning path.
- Fold memory/preference policy into a kernel-compatible decision path.
- Add error-type-driven automatic retry and recovery.
- Add urgent preemption and conflict-task parking.
- Add elastic work-unit spawn and capacity management.
- Add parallel subtask dispatch with real worktree lease enforcement.

All lossy legacy-compat shims tracked in
[docs/tech-debt/legacy-compat-layers.md](../tech-debt/legacy-compat-layers.md) have been
removed, and no `TODO(adr-0014-compat)` marker remains in source. The planner adapter (#1/#2),
its `AgentClass → ExecutorProfile` down-cast, the `intentDecisionFromPlan` round-trip (#3),
the runtime resume-target selection (#5), and the `bindPlanToTask` action-relabel (#4) are all
gone: resume/fork plans now keep their truthful `action` (e.g. `task_control`) instead of being
disguised as `plan_work_graph` to slip past a vestigial coordinator guard, which was deleted.
The final cleanup also removed the entire legacy routing/intent subsystem — `ExecutorProfile`,
`IntentOrchestrator`, `IntentDecisionV2`, `SemanticIntentRouter`, `ExecutorRouter`,
`ExecutionPlanningService`, the `ExecutionPolicyPlanner`, and the `src/planner/` skill subtree —
relocating the few still-consumed types (`Intent*` unions to `planning-types`, `ExecutionResult`
to `execution-runtime`) onto the live path. The `legacy-compat-layers.md` tech-debt list is now
closed.
