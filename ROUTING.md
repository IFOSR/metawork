# MetaClaw Planner And Work Unit Dispatch

This root document is the readable routing overview for the current codebase. Older policy-first routing plans and ADRs remain in `docs/`, but the active durable execution path is now planner-first after session intake.

For canonical terminology, see [`CONTEXT.md`](CONTEXT.md). For the current architectural decision, see [`docs/adr/0013-planner-first-work-unit-dispatch.md`](docs/adr/0013-planner-first-work-unit-dispatch.md). This file summarizes the implemented path without changing those ADR or plan files.

## Current Data Flow

```text
User input
  -> MetaclawSession
  -> IntentOrchestrator / SessionIntentApplicationService session intake
  -> TaskRuntimeService creates or binds a Task
  -> SchedulerEngine starts dispatch when the Task is runnable
  -> SessionExecutionCoordinator prepares execution context
  -> PlannerRuntimeService
       -> IntentRecognitionSkill
       -> PlannerRoutingSkill when work should be planned
  -> Work Graph persisted as Subtask records
  -> find ready Subtask whose dependencies are done
  -> WorkUnitClaimService claims an idle executor WorkUnit
  -> ExecutionRuntime receives SubtaskExecutionSpec
  -> executor adapter runs the claimed Subtask
  -> task events, work unit events, artifacts, verification, delivery
```

The important boundary is that session intake still owns raw user-input classification, the planner owns durable execution dispatch, and the platform owns resource arbitration:

- `IntentOrchestrator` and `SessionIntentApplicationService` decide whether raw input is direct reply, task control, clarification, existing-task reference, or a new durable task.
- The planner may guard a queued/resumed dispatch with `direct_reply`, `clarification`, `task_control`, or `no_action`, but normal direct replies and task-control requests are consumed before durable execution dispatch.
- Only `plan_work_graph` creates or resumes executable subtasks.
- `Subtask` is the work graph node.
- `WorkUnit` is a concrete runtime resource, not a planned unit of work.
- `AgentClass` is the reusable configuration for a planner or executor type.
- `WorkUnitClaimService` chooses idle work units, manages heartbeat/lease state, and records work-unit events.
- `ExecutionRuntime` runs a claimed subtask via `SubtaskExecutionSpec`; it does not receive `ExecutionPolicy`, `primaryExecutor`, `candidateExecutors`, or `fallbackChain`.

## What Is No Longer The Main Path

The following code remains as compatibility or migration reference, not as the primary durable-task dispatch layer:

- `src/core/executor-router.ts`
- `src/core/executor-routing-coordinator.ts`
- `src/routing/execution-policy-planner.ts`
- `ExecutionPolicy` and `fallbackChain` as runtime inputs

Do not add new primary dispatch behavior there. Reusable logic should move into planner skills or work-unit services.

## Current Constraints

- One top-level task is admitted at a time.
- Subtasks inside the active task are dispatched serially by dependency readiness.
- The first work-unit pool is fixed: default seeding creates `planner-1` and `executor-1`.
- Registering an executor `AgentClass` creates a default idle executor work unit.
- Heartbeat sweep is synchronous before dispatch and claim attempts, not a background timer.
- If no available/idle executor work unit can claim a ready subtask, the task is blocked with a recovery hint.
- Automatic fallback is deferred to planner recovery/replanning rather than performed by the platform dispatcher.

## Tests To Update First

When changing dispatch behavior, update or run these focused tests before broad suite work:

```bash
npm test -- tests/session/planner-work-unit-bugfix.test.ts
npm test -- tests/planner/planner-routing-skill.test.ts
npm test -- tests/execution/work-unit-claim-service.test.ts
npm test -- tests/storage/subtask-repo.test.ts
npm test -- tests/core/executor-admin-and-routing-services.test.ts
```
