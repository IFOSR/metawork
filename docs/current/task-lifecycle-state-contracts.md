# Task Lifecycle State Contracts

Status: current. Authority: [ADR-0049](../adr/0049-six-state-task-conclusion.md)
(Task conclusion), [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md),
[ADR-0022](../adr/0022-unified-kernel-control-plane-and-decision-ledger.md),
[ADR-0023](../adr/0023-durable-kernel-workflow-recovery-and-availability.md),
[ADR-0037](../adr/0037-multi-conversation-task-parallelism.md).

This document is the canonical ownership matrix and transition table for Task,
Subtask, Attempt, Kernel application, WorkUnit/lease and Conversation slot
state. The executable form lives in
[`src/task/task-state.ts`](../../src/task/task-state.ts) (six states, the one
transition table and `evaluateTaskState()`),
[`src/task/task-state-authority.ts`](../../src/task/task-state-authority.ts)
(facts → conclusion → the one write entry),
[`src/task/task-lifecycle-transition-port.ts`](../../src/task/task-lifecycle-transition-port.ts)
(durable write entry) and [`src/task/task-view.ts`](../../src/task/task-view.ts)
(read projection).

## 1. Ownership matrix

Only the first two rows are business lifecycle state machines. The rest are
operational facts or resource protocols and must never be presented as peer
Task statuses.

| Domain | Canonical owner | Contract |
| --- | --- | --- |
| Task conclusion | Task Domain; decided by `evaluateTaskState()`, applied only through `TaskLifecyclePort.applyTaskChange()` | `queued`, `running`, `needs_action`, `succeeded`, `failed`, `cancelled` |
| Subtask node lifecycle | Task Domain | `pending`, `executing`, `awaiting_completion`, `completed`, `blocked`, `cancelled` |
| Attempt | Execution Runtime | lifecycle `authorized -> launched -> running -> settling -> settled`, plus immutable outcome `succeeded`, `failed`, `heartbeat_lost`, `cancelled`, `unknown` |
| Kernel application | KernelWorkflow / AccountRuntime | `pending`, `applying`, `applied`, `uncertain`, `failed`; internal recovery state only |
| WorkUnit / lease | Execution Runtime and Resource Model | claim, lease expiry, release; `heartbeat_lost` is a normalized Attempt/lease fact |
| Conversation admission | Account scheduler | durable slot claim `free`, `occupied`, `releasing`, `recovery_blocked`; blockers are derived from residue |
| Operation phase | Task detail, not a lifecycle | `executing`, `publishing`, `delivering`, `starting_service`, `retrying`, `stopping`, `verifying` |

Raw persisted columns map to the canonical vocabulary through explicit functions
only:

| Raw fact | Canonical mapping |
| --- | --- |
| `tasks.status` | already canonical (six values, database `CHECK`) |
| `tasks.state_detail_json` | normalized and bounded by `normalizeTaskStateDetail()` |
| `subtasks.status` / `KernelSubtaskStatus` | `toSubtaskLifecycleState()` |
| `kernel_dispatch_items.status` | `toAttemptLifecycleState()` |
| `executor_attempt_receipts.terminal_state` + `failure` | `toAttemptOutcome()` |
| `task_operation_results.outcome` | `success` / `definite_failure` / `unknown` evidence for required work |
| `kernel_decision_applications.status` | not projected to users; only read by recovery |
| `work_units.state`, `resource_leases` | never projected to users |

## 2. Task transition table

Owned by the Task Domain. `isTaskStatusTransitionAllowed(from, to)` rejects
everything not listed; a self-transition is always allowed so an idempotent
reason/cleanup update is safe.

| From | Allowed to |
| --- | --- |
| `queued` | `running`, `needs_action`, `failed`, `cancelled` |
| `running` | `queued`, `needs_action`, `succeeded`, `failed`, `cancelled` |
| `needs_action` | `queued`, `cancelled` |
| `succeeded`, `failed`, `cancelled` | none (terminal) |

`running -> queued` is the "only waiting for capacity or a resource" edge: the
previous operation stopped safely and the Task re-enters scheduling. A terminal
Task never revives; an explicit retry creates a related Task with
`retry_of_task_id` and keeps the original conclusion.

Persisted lifecycle fields and their invariants:

| Field | Invariant |
| --- | --- |
| `status` | one of the six values |
| `state_version` | positive, monotonic; every status/reason/phase/pending-action/cleanup change increments it |
| `state_detail_json` | bounded `TaskStateDetail`: primary reason, unresolved reasons, phase, pending actions, required work, cleanup, next wake |
| `completed_at` | stamped on the first terminal transition; never reset |
| `archived_at` | independent attribute; never changes the conclusion |
| `retry_of_task_id` | follow-up linkage; the original row is untouched |

## 2b. Transition and write ownership

The Task Domain owns the conclusion per ADR-0020 and ADR-0049:

- `createTaskLifecyclePort({ store, transaction }).applyTaskChange()` is the only
  writer of `tasks.status`, `state_version`, `state_detail_json` and
  `completed_at`.
- `createSubtaskLifecyclePort()` owns Subtask node transitions.
- `TaskStateAuthority.reconcile()` reads durable facts, calls
  `evaluateTaskState()` and applies exactly one real state change. It never
  synthesizes intermediate transitions or resumes a user pause from passive facts.
- `TaskRepo.update()` accepts metadata only; lifecycle fields are excluded at the
  type level.

In one database transaction `applyTaskChange()`:

1. resolves the operation key (`UNIQUE(task_id, operation_key)`): the same key
   with the same payload is a replay, a different payload is rejected;
2. validates the Decision identity, the expected `state_version`, the active
   graph revision and the cancellation fence;
3. applies the narrowly scoped local facts the command names;
4. conditionally writes the Task state and appends `task_state_changes`;
5. appends the durable projection notification (`task_state_projection_outbox`).

The Kernel application record is marked applied in the same transaction through
the workflow's atomic application seam. External process, Git and filesystem
effects are committed separately and followed by a bounded convergence
reconcile.

Actors: `kernel-execution-runtime`, `task-cancellation-coordinator`,
`work-graph-runtime-service`, `workspace-publication-worker`,
`subtask-attempt-runner`, `session-kernel-runtime`,
`account-startup-recovery`, `task-domain`.

### The one summary rule

`evaluateTaskState(facts)` is pure and ordered:

```text
1. terminal conclusion                  -> keep it, only record cleanup/audit
2. committed cancellation fence         -> cancelled
3. active operation / bounded retry /
   held slot with runnable work         -> running
4. required work definitively failed    -> failed (other results preserved)
5. a user action is required and
   nothing can advance automatically    -> needs_action
6. every required work item completed   -> succeeded
7. runnable work only lacks capacity    -> queued
8. nothing holds                        -> explicit anomaly
                                          (needs_action if uncertain, else failed)
```

`needs_action` never jumps straight to `running`: the Task re-enters the queue and
only an admitted dispatch makes it executing.

### Completion requirements

`work_graph_revisions.completion_requirements_json` persists the requirement
snapshot authorized with that revision: execution evidence per node, required
file delivery, safety-report delivery and a required local service. Evidence is
durable — certified or explicitly accepted results, publication and delivery
checkpoints, service health plus manager handover. A Subtask label is never
completion evidence, and a re-plan writes a new snapshot.

## 3. Causal chain

```text
Executor / lease observation
  -> AttemptSettled(outcome)
  -> atomic receipt + Subtask fact + dispatch closure + Kernel inbox event
  -> ControlKernel decision
  -> Runtime applies one durable action
  -> normalized observation or durable follow-up job
  -> Task conclusion (TaskStateAuthority over durable facts)
  -> residue convergence
  -> Conversation slot release or successor promotion
```

Heartbeat loss follows:

```text
lease expired
  -> Attempt outcome = heartbeat_lost
  -> Subtask = awaiting_completion
  -> Kernel chooses retry, fallback, replan or block
  -> the authority derives running / needs_action / failed from those facts
```

No step may set a Task status by itself, and no step may release the Conversation
slot based only on a WorkUnit heartbeat event.

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
  `planner_claim_token`. Proposal submission, completion of a recovered
  proposal, retryable claim release and claim failure all re-check that token;
  proposal submission and completion write under a transaction. Two workers may
  both re-claim after a lease expiry, but only the current claim holder can
  change the Job, so a stale Worker cannot clear or fail a newer claim. A
  lease-expired re-claim may still repeat the model call, but only one result can
  land durably.
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
| `resume_task` | Every named Subtask is present and no longer `blocked`, and each has a causally descended dispatch item in the same generation. Recovery resumes use `recovery.subtaskId` and also match attempt kind, source attempt, binding fingerprint and configuration revision. A downstream `dispatch_batch` carries its own Decision id, so the inspector follows the dispatch Decision's causation back to the resume Decision. The apply is replay-idempotent and must never short-circuit before emitting its observation |
| `wait_for_retry` | Task is `blocked`, the exact `kernel_retry` dependency is waiting, and the Decision-derived Retry Wake is `armed` or has advanced to `fired`. The periodic/startup Worker owns Timer delivery; the Decision application never emits a Timer directly |
| `wait_for_partition` | The Task block is durable; the periodic capacity/partition recheck owns the wake |
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
slot is released only when the Task is terminal, or `needs_action`, and the reader
reports no blocking `dispatch`, `publication`, `execution_backend`, `work_unit`,
`resource_lease`, `generation_replan`, `retry_wake`, `kernel_application` or `attempt_receipt`
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

## 6. TaskView projection

`projectTaskView()` does **not** derive the Task conclusion. It reads the
committed `TaskStateSnapshot` from `tasks.status`, `tasks.state_version` and
`tasks.state_detail_json` and only assembles operational detail next to it:
active Attempt, Subtask node states, current Replan Job, recovery fact, blocking
residue, result and timestamps.

```text
state.status         queued | running | needs_action | succeeded | failed | cancelled
state.stateVersion   the version every surface compares
state.reason         stable code + bounded message + evidence refs
state.phase          executing | publishing | delivering | starting_service | retrying | stopping | verifying
state.pendingActions exact user actions (accept_result, retry_attempt, provide_input, resolve_recovery, start_service)
state.cleanup        none | pending | blocked, with the objects being cleaned
state.nextWakeAt     the next bounded wake, when one exists
```

`nextAuthorizedAction` maps the committed state to the one next step a surface may
offer; a surface must never re-derive a status from logs, dispatch rows, receipts
or a raw column. There is no raw fallback and no second lifecycle vocabulary.

The Gateway wire form is `GatewayTaskViewSnapshot.state` (query version
`task_view_v2`) in [`src/gateway/task-view.ts`](../../src/gateway/task-view.ts);
the vendored AnyFusion-Pi protocol adapter mirrors the same shape and rejects an
older query version instead of guessing.

## 7. Verification

Focused tests:

- `tests/task/task-lifecycle.test.ts` — the six states, the one transition table, `evaluateTaskState()` order, Subtask/Attempt contracts and bounded detail.
- `tests/task/task-lifecycle-transition-port.test.ts` — idempotency, CAS, cancel fence, graph mismatch, completion timestamp and the narrow-fact transaction boundary.
- `tests/task/task-view.test.ts` — the projection reads the committed snapshot and never re-derives a status.
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

## Navigation Read Models (2026-09-26)

Navigation read models consume canonical lifecycle/activity projections; they
do not own a Task, Subtask, Attempt, retry or Replan Job state machine.
The Workspace directory materializes account/Conversation-scoped activity and
uses durable invalidation plus a resumable rebuild. Conversation history and
Gateway snapshots are presentation records, never scheduling or slot-release
evidence. See ADR-0035's navigation amendment and the active September 26 plan.

The 2026-10-22 review fixes and their recovery/upgrade validation are recorded in
[the fix record](../plans/2026-10-22-task-state-review-fixes.md).
