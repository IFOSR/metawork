# Task Lifecycle State Contracts

Status: current. Authority: [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md),
[ADR-0022](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md),
[ADR-0023](../adr/0023-durable-kernel-workflow-recovery-and-availability.md),
[ADR-0037](../adr/0037-multi-conversation-task-parallelism.md), and the
[2026-09-25 Task lifecycle state convergence plan](../plans/2026-09-25-task-lifecycle-state-convergence-implementation-plan.md).

This document is the canonical ownership matrix and transition table for Task,
Subtask, Attempt, Kernel application, WorkUnit/lease and Conversation slot
state. The executable form lives in
[`src/task/task-lifecycle.ts`](../../src/task/task-lifecycle.ts) (pure mapping
and transition guards) and [`src/task/task-view.ts`](../../src/task/task-view.ts)
(read projection).

## 1. Ownership matrix

Only the first two rows are business lifecycle state machines. The rest are
operational facts or resource protocols and must never be presented as peer
Task statuses.

| Domain | Canonical owner | Contract |
| --- | --- | --- |
| Task lifecycle | Task Domain, applied only from Kernel-authorized actions | `queued`, `executing`, `coordinating`, `waiting_for_user`, `blocked`, `completed`, `failed`, `cancelled` |
| Subtask node lifecycle | Work Graph / Task Domain | `pending`, `executing`, `awaiting_completion`, `completed`, `blocked`, `cancelled` |
| Attempt | Execution Runtime | lifecycle `authorized -> launched -> running -> settling -> settled`, plus immutable outcome `succeeded`, `failed`, `heartbeat_lost`, `cancelled`, `unknown` |
| Kernel application | KernelWorkflow / AccountRuntime | `pending`, `applying`, `applied`, `uncertain`, `failed`; internal recovery state only |
| WorkUnit / lease | Execution Runtime and Resource Model | claim, lease expiry, release; `heartbeat_lost` is a normalized Attempt/lease fact |
| Conversation admission | Account scheduler | durable slot claim `free`, `held`, `release_pending`; richer blockers are derived from residue |
| User-facing view | Read-only projection layer | `queued`, `executing`, `retrying`, `waiting_for_plan`, `waiting_for_user`, `publishing`, `recovery_required`, `blocked`, `completed`, `failed`, `cancelled` |

Raw persisted columns map to the canonical vocabulary through explicit functions
only:

| Raw fact | Canonical mapping |
| --- | --- |
| `tasks.status` | `toTaskLifecycleState()` |
| `subtasks.status` / `KernelSubtaskStatus` | `toSubtaskLifecycleState()` |
| `kernel_dispatch_items.status` | `toAttemptLifecycleState()` |
| `executor_attempt_receipts.terminal_state` + `failure` | `toAttemptOutcome()` |
| `kernel_decision_applications.status` | not projected to users; only read by recovery |
| `work_units.state`, `resource_leases` | never projected to users |

## 2. Task transition table

Owned by the Task Domain. `isTaskTransitionAllowed(from, to)` rejects everything
not listed; a self-transition is always allowed so idempotent replay is safe.

| From | Allowed to |
| --- | --- |
| `queued` | `executing`, `coordinating`, `waiting_for_user`, `blocked`, `failed`, `cancelled` |
| `executing` | `coordinating`, `waiting_for_user`, `blocked`, `completed`, `failed`, `cancelled` |
| `coordinating` | `executing`, `waiting_for_user`, `blocked`, `completed`, `failed`, `cancelled` |
| `waiting_for_user` | `executing`, `coordinating`, `blocked`, `completed`, `failed`, `cancelled` |
| `blocked` | `executing`, `coordinating`, `waiting_for_user`, `completed`, `failed`, `cancelled` |
| `completed`, `failed`, `cancelled` | none (terminal) |

## 3. Causal chain

```text
Executor / lease observation
  -> AttemptSettled(outcome)
  -> atomic receipt + Subtask fact + dispatch closure + Kernel inbox event
  -> ControlKernel decision
  -> Runtime applies one durable action
  -> normalized observation or durable follow-up job
  -> Task/Subtask lifecycle projection
  -> residue convergence
  -> Conversation slot release or successor promotion
```

Heartbeat loss follows:

```text
lease expired
  -> Attempt outcome = heartbeat_lost
  -> Subtask = awaiting_completion
  -> Task = coordinating
  -> Kernel chooses retry, fallback, replan or block
```

No step may set `Task = blocked` or release the Conversation slot based only on a
WorkUnit heartbeat event.

## 4. Durable Replan Job

`request_replan` no longer invokes a foreground Conversation Planner callback.
The Kernel authorizes `schedule_replan`, whose only postcondition is that the
Replan Job is durably schedulable under the Decision-derived quiescence token:

```text
schedule_replan
  -> generation_replan_requests.status = 'planning', quiescence_token = quiescence_<decisionId>
  -> Decision application = applied (no Planner call in the application)
  -> GenerationReplanWorker claims the Job with a bounded Planner lease
  -> Planner emits plan_proposed through the normal Kernel ingress
```

Idempotency rules:

- The Job id is deterministic (`generation_replan_<task>_<generation>_<revision>`)
  and unique per `(task_id, generation_id, source_revision)`.
- The claim is a single conditional `UPDATE`; a duplicate recovery pass cannot
  start a second Planner turn.
- The proposal event is inserted together with the `submitted` transition, so a
  crash after the Planner turn cannot lose or duplicate the turn.
- A retryable Planner failure releases the claim with backoff; the absolute retry
  budget fails the Job closed as `planner_unavailable`, which the Kernel turns
  into an explicit `block_work` instead of leaving the Task `running`.

## 5. Uncertain application recovery

Every Kernel action declares its postcondition.

| Action family | Postcondition |
| --- | --- |
| Dispatch | Expected dispatch item exists with the same Decision ID and binding |
| Replan (`schedule_replan`, legacy `request_replan`) | Expected Replan Job carries `quiescence_<decisionId>` and is `planning`/`submitted`/`waiting_for_availability`/`resolved`/`failed` |
| Block / complete | Task/Subtask transition and required effects are durable |
| Slot release | Slot owner and reservation epoch no longer belong to the Task |
| External delivery | Existing outbox/provider receipt rules remain authoritative |

The invariant is:

```text
uncertain application -> applied | retry_pending | recovery_required/blocked
```

It must never remain permanently paired with `Task = running` and
`Slot = occupied`.

## 6. TaskView projection priority

`projectTaskView()` evaluates durable facts in this order:

```text
active authorized Attempt exists    -> executing
retry wake exists                   -> retrying
active Replan Job exists            -> waiting_for_plan (blocked if the Task is already blocked)
uncertain Kernel application exists -> recovery_required
publication residue exists          -> publishing
terminal Task lifecycle             -> completed / failed / cancelled
pending user decision               -> waiting_for_user
remaining residue                   -> blocked
otherwise                           -> queued
```

A `running` Task with no active Attempt is never projected as `executing`.
Presentation surfaces must render `TaskView.phase`, never `tasks.status`,
`dispatch.status`, `work_units.state` or `kernel_decision_applications.status`.

The Gateway wire form is `GatewayTaskViewSnapshot.lifecycle` in
[`src/gateway/task-view.ts`](../../src/gateway/task-view.ts); the vendored
AnyFusion-Pi mirror treats it as an optional additive extension.

## 7. Verification

Focused tests:

- `tests/task/task-lifecycle.test.ts` — canonical mapping and transition guards.
- `tests/task/task-view.test.ts` — projection priority and residue.
- `tests/account/generation-replan-worker.test.ts` — durable Replan Job claim,
  idempotency, bounded retry and fail-closed budget.
- `tests/execution/kernel-application-recovery.test.ts` — replan postcondition
  inspection.
- `tests/account/account-startup-recovery-service.test.ts` — the
  2026-09-25 heartbeat-loss -> replan -> uncertain chain converges during
  startup without a foreground Planner.
