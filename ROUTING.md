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
  -> PlanningAgent (CodexPlanningAgent prompts LlmBridge and returns a structured plan)
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

## Removed Legacy Routing Layer

The old routing/intent subsystem that predated this path has been **fully removed** (the `docs/tech-debt/legacy-compat-layers.md` list is now closed). None of the following exist anymore:

- `src/core/intent-orchestrator.ts`, `src/core/semantic-intent-router.ts`, `src/core/executor-router.ts`
- `src/core/execution-planning-service.ts`, `src/routing/execution-policy-planner.ts`
- the `src/planner/` skill subtree (`planner-runtime-service`, `intent-recognition-skill`, `planner-routing-skill`)
- `IntentOrchestrator` / `IntentDecisionV2` / `ExecutorProfile` / `ExecutorRouter`, and `ExecutionPolicy` / `fallbackChain` as runtime inputs

Do not reintroduce a parallel dispatch layer. Reusable semantic understanding lives behind `PlanningAgent`; deterministic authorization lives in `PolicyKernel`; runtime state changes live in runtime/application services.

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
npm test -- tests/kernel/policy-kernel.test.ts
npm test -- tests/planning/planning-agent-plan-validator.test.ts
npm test -- tests/execution/work-graph-runtime-service.test.ts
npm test -- tests/session/planner-work-unit-bugfix.test.ts
npm test -- tests/execution/work-unit-claim-service.test.ts
npm test -- tests/storage/planning-decision-repo.test.ts
```
