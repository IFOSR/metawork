# MetaClaw Planning Agent And Policy Kernel Routing

This root document is the readable routing overview for the current codebase. Older policy-first and planner-first routing plans remain in `docs/`, but the active natural-language path is now:

```text
User natural-language input
  -> Planner Work Unit implements PlanningAgent
  -> PlanningAgentPlan
  -> PolicyKernel
  -> KernelDecision
  -> MetaClaw Runtime
  -> Executor Work Unit / Conversation / Task Control / Delivery
```

For canonical terminology, see [`CONTEXT.md`](CONTEXT.md). For the current architectural decision, see [`docs/adr/0014-planning-agent-policy-kernel-boundary.md`](docs/adr/0014-planning-agent-policy-kernel-boundary.md). This file summarizes the implemented path without changing historical ADR or plan files.

## Current Data Flow

```text
User input
  -> MetaclawSession
  -> explicit memory/preference fast path when applicable
  -> PlanningContextBuilder
  -> PlanningAgent
       -> first adapter reuses IntentOrchestrator/SemanticIntentRouter internally
  -> PlanningAgentPlan
  -> PolicyKernel
       -> validate schema, task state, confidence, conflicts, executor availability
  -> KernelDecision
  -> KernelDecisionApplier
       -> record planning_decisions audit row
       -> answer directly, ask clarification, apply task control, or prepare durable work
  -> TaskRuntimeService creates or binds a Task when durable work is authorized
  -> SchedulerEngine starts dispatch when the Task is runnable
  -> SessionExecutionCoordinator prepares execution context
  -> WorkGraphRuntimeService applies the kernel-approved Work Graph as Subtask records
  -> find ready Subtask whose dependencies are done
  -> WorkUnitClaimService claims an idle executor WorkUnit
  -> ExecutionRuntime receives SubtaskExecutionSpec
  -> executor adapter runs the claimed Subtask
  -> task events, work unit events, artifacts, verification, delivery
```

The important boundary is that planner understanding, kernel authorization, and runtime side effects are separate:

- `PlanningAgent` owns semantic understanding, target/task intent, clarification needs, executor candidates, and work graph proposals.
- `PolicyKernel` owns deterministic authorization: mode validation, task status checks, single-active-task conflicts, blocked/recovery constraints, executor availability, rewrite/reject/clarify decisions.
- Runtime services own side effects: task creation or binding, task-control presentation, subtask persistence, work-unit claim, execution, verification, delivery, and audit persistence.
- `Subtask` is the work graph node.
- `WorkUnit` is a concrete runtime resource, not a planned unit of work.
- `AgentClass` is the reusable configuration for a planner or executor type.
- `WorkUnitClaimService` chooses idle work units, manages heartbeat/lease state, and records work-unit events.
- `ExecutionRuntime` runs a claimed subtask via `SubtaskExecutionSpec`; it does not receive `ExecutionPolicy`, `primaryExecutor`, `candidateExecutors`, or `fallbackChain`.

## What Is No Longer The Main Path

The following code remains as reusable semantic logic, compatibility, or migration reference, not as the primary natural-language dispatch layer:

- `src/core/intent-orchestrator.ts` when called directly from session code
- `src/session/session-intent-application-service.ts`
- `src/core/executor-router.ts`
- `src/core/executor-routing-coordinator.ts`
- `src/routing/execution-policy-planner.ts`
- `ExecutionPolicy` and `fallbackChain` as runtime inputs

Do not add new primary dispatch behavior there. Reusable semantic understanding should live behind `PlanningAgent`; deterministic authorization should live in `PolicyKernel`; runtime state changes should live in runtime/application services.

## Current Constraints

- One top-level natural-language durable task is admitted at a time.
- Slash-command and deterministic execution paths still use the existing task-admission gate.
- Subtasks inside the active task are dispatched serially by dependency readiness.
- The first work-unit pool is fixed: default seeding creates `planner-1` and `executor-1`.
- Registering an executor `AgentClass` creates a default idle executor work unit.
- Heartbeat sweep is synchronous before dispatch and claim attempts, not a background timer.
- If no available/idle executor work unit can claim a ready subtask, the task is blocked with a recovery hint.
- Automatic retry, preemption, conflict-task parking, elastic work-unit spawn, and parallel subtasks are deferred.

## Tests To Update First

When changing dispatch behavior, update or run these focused tests before broad suite work:

```bash
npm test -- tests/session/metaclaw-session-architecture-boundary.test.ts
npm test -- tests/core/execution-planning-boundary.test.ts
npm test -- tests/kernel/policy-kernel.test.ts
npm test -- tests/planning/planning-agent-plan-validator.test.ts
npm test -- tests/execution/work-graph-runtime-service.test.ts
npm test -- tests/session/planner-work-unit-bugfix.test.ts
npm test -- tests/planner/planner-routing-skill.test.ts
npm test -- tests/execution/work-unit-claim-service.test.ts
npm test -- tests/storage/planning-decision-repo.test.ts
```
