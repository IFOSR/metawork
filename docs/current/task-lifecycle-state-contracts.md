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
| Subtask node lifecycle | Task Domain | `pending`, `executing`, `awaiting_completion`, `completed`, `blocked`, `cancelled` |
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

## 2b. Transition ownership

Strategic Task and Subtask writes have exactly one owner, the Task Domain per
ADR-0020:

- `createTaskLifecyclePort()` owns Task status transitions.
- `createSubtaskLifecyclePort()` owns Subtask node transitions.

Work Graph owns proposal topology, node identity, DAG derivation and the
runnable frontier; it explicitly does **not** own Subtask run state. A Work Graph
consumer therefore calls the Subtask port for the node transition a Kernel
Decision requires.

Every call records `kind`, `id`, `from`, `to`, `actor`, `reason` and `at`, so a
contradictory status can be attributed to the layer that asked for it. The record
is an **in-process** observation seam, not a durable audit: the durable evidence
of a status change remains the Kernel Decision, the attempt receipt and the
Task/Subtask row the transition produced. The guards
reject a transition that is invalid in the canonical model — most importantly
any transition out of a terminal Task or Subtask lifecycle. Replayed
transitions with the same target are idempotent (`cancelTask` on a terminal
Task and `blockTask` on a blocked Task are no-ops, not errors), so a Kernel
application replay can never fail because of its own earlier attempt.

Actors: `kernel-execution-runtime`, `task-cancellation-coordinator`,
`work-graph-runtime-service`, `workspace-publication-worker`,
`subtask-attempt-runner`, `session-kernel-runtime`,
`account-startup-recovery`, `task-domain`.

User-driven `/task pause` and `/task block` remain Task Domain operations
through `TaskEngine`, which owns the persisted transition table.

### Fact-aware canonical lifecycle

`deriveTaskLifecycleState()` refines the persisted mapping with durable facts,
so the canonical state never overstates activity:

```text
terminal persisted state            -> completed / failed / cancelled
pending user decision               -> waiting_for_user
persisted blocked                   -> blocked
active authorized Attempt           -> executing
outstanding Replan Job or retry wake-> coordinating
persisted created/ready             -> queued
persisted running, no Attempt       -> coordinating
```

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
- The Planner turn has a durable identity. The proposal event id is derived from
  the Job's trigger Decision (`generationReplanProposalEventId()`), so a worker
  pass distinguishes three states — no proposal yet (plan), a persisted proposal
  (reuse it, never re-plan) and a held claim with no proposal (retry after the
  lease expires).
- The claim is **fenced**. `claimForPlanner()` records a
  `planner_claim_token`, and `submitPlannerProposal()` /
  `completePlannerTurn()` write the proposal and the `submitted` transition in
  one transaction that re-checks the token. Two workers may both re-claim after
  a lease expiry, but only the current claim holder can land a proposal, so the
  Planner turn is at-most-once in effect even though a lease-expired re-claim may
  repeat the model call.
- The Job is pinned to the configuration revision that authorized its
  generation. If the current Planner revision differs, the Worker fails the Job
  closed with `configuration_revision_changed` instead of carrying a proposal
  from one revision into another.
- A retryable Planner failure releases the claim with backoff; the absolute retry
  budget fails the Job closed as `planner_unavailable`, and recovery emits the
  `recovery_required_observed` fact above so the Kernel blocks the Task instead
  of leaving it `running`.

## 5. Uncertain application recovery

Every Kernel action declares its postcondition. Startup and periodic recovery
inspect each managed application once and resolve it to one of four verdicts:

| Verdict | Meaning | Recovery action |
| --- | --- | --- |
| `applied` | Postcondition is durably present | Mark `applied` |
| `retry_safe` | Postcondition absent, re-apply cannot duplicate an effect | Re-queue the same Decision, bounded by `applyAttempts < 3` |
| `unresolved` | Outcome unknowable or contradictory | Stay `uncertain` and surface as `recovery_required` |
| `not_managed` | A dedicated reconciler owns the family | Leave untouched |

`markApplied` inserts a Decision's observation event **in the same transaction**
as the `applied` transition. An `uncertain` application therefore proves the
observation was never emitted, which makes "did the observation land" useless as
a postcondition. Every postcondition below is either a durable state write of the
apply or a *downstream* effect that only this Decision could have caused.

| Action family | Postcondition |
| --- | --- |
| `dispatch_batch` | Every authorized item landed with its full identity: the same Decision, attempt id, Subtask, attempt kind, binding fingerprint and configuration revision (partial → `unresolved`) |
| `schedule_replan`, legacy `request_replan` | Replan Job carries `quiescence_<decisionId>` and is `planning`/`submitted`/`waiting_for_availability`/`resolved`/`failed` |
| `queue_generation_replan` | The Replan Job named by `requestId` is durable **and** the Task is no longer executing. While the Task still runs, only the Decision's observation re-evaluates quiescence, so re-emit it (`retry_safe`) |
| `authorize_task_plan`, `activate_deferred_task_plan` | The named graph revision is durable **and** `authorizedDecisionId` is null or this Decision. A revision written by another Decision is `unresolved`, not success. An initial revision whose Task id is deterministic is safe to retry; a replan revision is not |
| `complete_task`, `accept_partial_result` | Task is `done`/`archived` |
| `block_work` | The **whole** operation: Task is `blocked` **and** the named Subtask (unless `preserveSubtaskState`) is `blocked`/`done`/`cancelled`. The Runtime writes the Subtask blocker before the Task block, so a half-applied decision must not read as success. A named Subtask that does not exist is `unresolved` |
| `park_for_replan` | Task is `parked` (or already terminal) |
| `defer_task_plan_for_availability` | The Replan Job is `waiting_for_availability` **and** the Task is `blocked`. The deferral is persisted before the block, so a persisted deferral with a running Task must be re-applied (`retry_safe`) |
| `wait_for_capacity` | The Task block is durable; the periodic capacity recheck owns the wake |
| `resume_task` | No named Subtask is still `blocked` **and** a dispatch item for that Subtask in the same generation is durable. The downstream `dispatch_batch` carries its own Decision id, so requiring equality with the resume Decision would never succeed. The apply is replay-idempotent and must never short-circuit before emitting its observation |
| `wait_for_retry`, `wait_for_partition` | `retry_safe` only. The apply blocks the Task and emits the wake observation that is the real continuation trigger, so it must be re-emitted rather than assumed |
| `no_op`, `probe_capacity` | No durable state write; `applied` |
| `cancel_task`, `cancel_subtasks` | `reconcileUncertainCancellations` (dedicated) |
| `request_merge_replan` | Bounded merge/system-binding recovery events (dedicated) |
| Capability grants/denials/escalations, `deliver_direct_reply`, `recover_workspace_attempt` | External effect or resource protocol; outbox/manual recovery owns it |

### Recovery-required sources

An application that can no longer converge is not left as a silent `uncertain`.
Recovery emits a deterministic `recovery_required_observed` Kernel event and
`ControlKernel.decideRecoveryRequired()` authorizes `block_work` with a
`recovery_required: <reason>` blocker, so the Task leaves `running` and TaskView
reports `recovery_required` with an explicit entry point.

Two independent sources produce that fact:

1. A Replan Job that failed closed **for the currently active graph revision**.
   A stale failure from an older revision must not block a Task whose newer
   revision already succeeded.
2. An uncertain application that can no longer converge: its declared
   postcondition is `unresolved`, or its bounded re-application budget
   (`applyAttempts < 3`) is exhausted. `unresolved` never increments
   `applyAttempts`, so an attempt-count-only rule would leave it uncertain
   forever.

Neither source requires an active graph revision, because an initial
`authorize_task_plan` can fail before any revision exists; the event carries the
recovery item's own configuration revision in that case. Re-queuing a
`retry_safe` application is not convergence on its own: the recovery pass drains
the Task in the same pass so the Decision is re-applied and its next verdict is
observed.

### Slot release

Slot release is not a Kernel application. It converges as a residue question,
answered only by `TaskResidueReader.blockingReasons()` — the single reader shared
by completion, cancellation, startup recovery, periodic recovery and TaskView. A
slot is released only when the Task is terminal, or blocked, and the reader
reports no blocking `dispatch`, `publication`, `execution_backend`, `work_unit`,
`resource_lease`, `generation_replan`, `kernel_application` or `attempt_receipt`
residue. `generation_replan` covers `pending_quiescence`, `planning`, `submitted`
**and `waiting_for_availability`**, because a deferred proposal is unfinished
work. `kernel_application` covers `pending`, `applying` and `uncertain`. A path
that must discount its own in-flight Decision passes that Decision id explicitly
instead of ignoring the whole category.

The invariant is:

```text
uncertain application -> applied | retry_pending | recovery_required/blocked
```

It must never remain permanently paired with `Task = running` and
`Slot = occupied`.

### Operational diagnosis

`/task recovery <taskId>` lists each application with its declared
`family/verdict` and reason, and the Gateway `TaskView` exposes the first
uncertain application as `currentRecovery` with
`phase = 'recovery_required'`. Both read the same inspector the recovery sweep
acts on (`inspectApplicationAgainstSources`).

## 6. TaskView projection priority

`projectTaskView()` evaluates durable facts in this order:

```text
active authorized Attempt exists    -> executing
retry wake exists                   -> retrying
active Replan Job exists            -> waiting_for_plan (blocked if the Task is already blocked)
uncertain Kernel application exists -> recovery_required (uncertain_application)
publication residue exists          -> publishing
terminal Task lifecycle             -> completed / failed / cancelled
pending user decision               -> waiting_for_user
Task lifecycle blocked              -> blocked
Task lifecycle queued               -> queued
otherwise (coordinating, no driver) -> recovery_required (no_authorized_driver)
```

A `running` Task with no active Attempt is never projected as `executing`, and
`waiting_for_plan` is only reported when a durable Replan Job actually exists. A
Task with no active Attempt, no retry wake, no Replan Job and no publication has
no authorized driver, so it is projected as `recovery_required` with
`recoveryDiagnosis = 'no_authorized_driver'` and
`nextAuthorizedAction = 'explicit_resume_required'`; when the cause is an
uncertain application the diagnosis is `uncertain_application` and the action is
`resolve_uncertain_application`.

Presentation surfaces must render `TaskView.phase`, never `tasks.status`,
`dispatch.status`, `work_units.state` or `kernel_decision_applications.status`.
The Feishu/Web activity card consumes the same facts (`openReplanJobTaskIds`,
`pendingRetryWakeTaskIds`, `activeAttemptTaskIds`) and the same
`deriveTaskLifecycleState()`, so it cannot disagree with TaskView about whether a
Conversation is idle.

The Gateway wire form is `GatewayTaskViewSnapshot.lifecycle` in
[`src/gateway/task-view.ts`](../../src/gateway/task-view.ts); the vendored
AnyFusion-Pi mirror treats it as an optional additive extension.

## 7. Verification

Focused tests:

- `tests/task/task-lifecycle.test.ts` — canonical mapping, Subtask table and transition guards.
- `tests/task/task-view.test.ts` — projection priority, fact-aware lifecycle and residue.
- `tests/task/task-lifecycle-transition-port.test.ts` — single-owner audit trail,
  rejected cross-layer and terminal transitions, idempotent replay, Subtask/Task
  port separation.
- `tests/account/generation-replan-worker.test.ts` — durable Replan Job claim,
  idempotency, bounded retry and fail-closed budget.
- `tests/execution/kernel-application-recovery.test.ts` — postcondition
  inspection for every managed family.
- `tests/account/account-startup-recovery-service.test.ts` — the
  2026-09-25 heartbeat-loss -> replan -> uncertain chain converges during
  startup without a foreground Planner; a blocked Task releases its slot and
  promotes the next same-Conversation Task exactly once; an uncertain
  `complete_task` converges by postcondition; an uncertain `dispatch_batch`
  retries within its budget.
- `tests/workspace/conversation-activity-projector.test.ts` — the Feishu/Web
  activity card never reports a running Task without an active Attempt as
  executing.

The whole suite runs in the Docker test image (`Dockerfile.test` -> `npm test`),
so the SQLite-backed recovery and promotion scenarios above are the supported
container coverage. `npm run smoke:metawork` remains the live native
Planner-to-Executor gate; a live `planner_unavailable` scenario is not
reproducible there without an external Planner fault, so it is covered by the
account-runtime integration tests instead.
