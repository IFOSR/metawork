# Planning Agent And Policy Kernel Boundary

## Status

Historical; fully absorbed by ADR-0015, ADR-0020 and ADR-0022.

The `PlanningAgent -> Control Kernel -> Runtime` chain remains current, but its semantic boundary is now governed by ADR-0015, its module ownership by ADR-0020, and its unified decision interface by ADR-0022. Everything below is historical context: ADR-0022 replaced `PolicyKernel` with `ControlKernel` and its single `decide(event, snapshot)` seam, which now also owns dispatch, capacity, execution failure recovery, retry/fallback/replan, permission and partition decisions. Read `PolicyKernel` in this document as the historical name of that seam.

Alignment note (2026-07-27): the `authorizeDirectReply` shortcut described below no longer exists. Phase 3 routed direct reply through the unified seam as `deliver_direct_reply`, and Phase 3–5 closed the Future Work items marked below.

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

Temporary implementation exception: a `direct_reply` plan is read-only, so the current Session may call `PolicyKernel.authorizeDirectReply(plan)` and still record the resulting `KernelDecision`. ADR-0020 supersedes this as the target Interface. Roadmap Phase 3 must express direct reply through the unified `decide(event, snapshot)` seam or explicitly keep it outside Kernel ownership; it must not retain a second public Kernel entry as a permanent shortcut. No state-changing action may use the temporary path.

Explicit memory/preference capture fast paths remain outside this policy kernel in v1. This avoids expanding the memory policy while this change is only trying to restore the task planning and dispatch boundary.

## Consequences

The natural-language path has one logical policy seam: `PlanningAgent -> PolicyKernel -> Runtime decision application`. This makes it possible to test task creation, task control, direct reply, clarification and work graph execution at one authorization boundary. The current `authorizeDirectReply` method is a migration exception described above, not a second target seam.

Planner output is a proposal, not an executable command. Work graphs become durable `Subtask` records only after the kernel accepts or rewrites the plan.

The current product behavior remains one active top-level Task and serial Subtasks. Executor WorkUnits are created/probed on demand, and Runtime performs heartbeat sweep before relevant dispatch or claim attempts.

## Future Work

- ~~Replace the internal semantic adapter with a real Codex CLI planner adapter.~~ Done: `CodexPlanningAgent` emits `PlanningAgentPlan` (with multi-subtask DAG work graphs) directly from Codex CLI; the `IntentOrchestrator` semantic adapter is no longer on the planning path.
- Fold memory/preference policy into a kernel-compatible decision path.
- ~~Add error-type-driven automatic retry and recovery.~~ Done in Phase 4 (ADR-0023): structured `KernelFailure` taxonomy, durable backoff, continuation, ordered fallback and derived availability.
- ~~Add urgent preemption and conflict-task parking.~~ Superseded: preemption and multi-Task queueing were deliberately removed by ADR-0022 and are redesigned in roadmap Phase 6.
- Add elastic work-unit spawn and capacity management.
- Add parallel subtask dispatch with real worktree lease enforcement. Phase 5 (ADR-0024) delivered partitions, persistent workspaces and durable leases; concurrent dispatch itself remains Phase 6.

All lossy legacy-compat shims tracked in
[docs/archive/tech-debt/legacy-compat-layers.md](../archive/tech-debt/legacy-compat-layers.md) have been
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
