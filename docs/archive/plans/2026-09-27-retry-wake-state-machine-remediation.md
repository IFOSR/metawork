# Retry Wake State Machine Remediation Implementation Plan

> Status: Active Delivery. Source implementation is in place through the
> durable wake, exact Timer identity, atomic wait postcondition, recovery
> projection and account-scoped Worker stages. Final closure is intentionally
> pending real Server restart, TUI/Web reconnect, and live timeout-to-retry
> acceptance against the canonical installation.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make timeout recovery converge deterministically from Attempt settlement through Task blocking, retry wake, continuation dispatch, billing finality, and slot release without allowing a Timer event to race ahead of its durable authorization.

**Architecture:** Keep Task and Subtask lifecycle ownership in the Task Domain, strategic retry policy in ControlKernel, Kernel application sequencing in DurableKernelWorkflow, and side effects in Execution Runtime. Do not add a second user-facing Task lifecycle; add one Kernel-owned durable Retry Wake continuation fact whose lifecycle is `armed -> fired -> consumed`, with explicit `superseded` and `recovery_required` outcomes. A Timer event may be emitted only after the Retry Wake and its Task blocker are durable.

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite/better-sqlite3, ControlKernel v5, DurableKernelWorkflow, Task lifecycle transition ports, Execution Runtime, Vitest.

---

## 1. Confirmed Production Failure

The affected Task `task_plan_event_proposal_bd38a1111e6552c937ae875931df6b4465d49b9f61a9655f8ceb03d40eab2b26` demonstrates the race:

```text
00:54:04.872Z  primary Attempt settled with executor idle timeout
00:54:04.872Z  Kernel decided wait_for_retry
00:54:34.872Z  timer_tick was evaluated with Task = created and wakeAuthorized = false
00:54:34.872Z  Kernel persisted no_op: timer wake is stale or no longer authorized
00:58:39.885Z  wait_for_retry application finally blocked the Task
```

The resulting durable facts were contradictory:

```text
Task = blocked
Subtask = awaiting_decision
kernel_retry dependency = waiting
Timer decision = no_op
continuation dispatch = absent
```

The root cause is not provider routing. `wait_for_retry` conditionally writes the Task blocker, while the Runtime creates a future Timer event from inside the same application path. The event can be processed using a stale pre-application snapshot. A `no_op` is then treated as a valid terminal decision even though the retry intent was never consumed.

## 2. Invariants

The following invariants are mandatory:

1. A retry wake cannot be emitted before the Task blocker and Retry Wake are durable.
2. A continuation Attempt cannot launch before its dispatch item, Task transition, and Subtask transition are durable.
3. A Timer event must carry the exact Retry Wake identity, source Decision, source Attempt, generation, configuration revision, and binding fingerprint.
4. A stale wake must converge to `consumed`, `superseded`, or `recovery_required`; it must not leave a waiting retry blocker with no valid wake.
5. `retrying` is a read-only TaskView phase derived from a valid Retry Wake, never a persisted Task status.
6. Retry application and wake emission must be idempotent across duplicate events, process restart, and uncertain Kernel applications.
7. Billing remains pending until the whole Query/Task execution chain settles; retry scheduling alone never finalizes a bill.
8. Conversation slot release continues to use the shared residue reader and never treats a stale Timer as proof of completion.

## 3. Ownership And State Model

| Fact | Owner | Allowed states |
| --- | --- | --- |
| Task lifecycle | Task Domain, via Kernel-authorized transitions | Existing canonical Task states |
| Subtask lifecycle | Task Domain | Existing canonical Subtask states |
| Retry policy | ControlKernel | `wait_for_retry`, fallback, replan, block |
| Retry Wake continuation | Kernel/Application Shell persistence seam | `armed`, `fired`, `consumed`, `superseded`, `recovery_required` |
| Timer delivery | Account Runtime / Kernel coordinator | Durable event enqueue and idempotent wake delivery |
| Attempt launch/settlement | Execution Runtime | Existing Attempt lifecycle |
| User-facing phase | TaskView/Web/TUI projection | Existing `retrying`, `executing`, `blocked`, `recovery_required`, etc. |

Retry Wake is not a second Task state machine. It is a durable continuation/outbox fact owned by the Kernel workflow boundary.

## 4. Authoritative Retry Chain

### 4.1 Timeout to armed retry

```text
Attempt terminal timeout
  -> receipt + dispatch closure + execution_outcome
  -> ControlKernel decides wait_for_retry
  -> Runtime atomically:
       Task blocker kernel_retry
       Task blocked
       Subtask awaiting_decision
       Retry Wake armed
       Decision observation
  -> commit
```

`wait_for_retry` must reject or enter `recovery_required` if its expected Task, Subtask, Attempt, generation, or binding facts are not present. It must never silently skip the Task transition and still schedule a retry.

### 4.2 Armed retry to Timer

```text
RetryWakeWorker claims due armed Wake
  -> in one transaction:
       verify exact Task blocker and identity
       mark Wake fired
       enqueue timer_tick with availableAt = now
  -> commit
```

The worker must not create an in-memory `setTimeout` as the source of truth. A periodic bounded scan and startup recovery may both invoke the same conditional claim operation.

### 4.3 Timer to continuation dispatch

```text
timer_tick
  -> fresh Kernel snapshot
  -> ControlKernel validates exact Retry Wake
  -> dispatch_batch continuation
  -> Runtime atomically:
       clear matching kernel_retry blocker
       Task blocked -> executing
       persist continuation dispatch item
       close Retry Wake as consumed
  -> Attempt Supervisor launches only after commit
```

If the wake is no longer needed, it becomes `superseded`. If facts contradict and no safe owner can decide, Kernel emits `recovery_required_observed` and blocks explicitly.

## 5. Durable Contract

Add a schema-45 Retry Wake table keyed by `wake_id` and unique `source_decision_id`. The minimum durable identity is:

```text
wake_id
task_id
subtask_id
generation_id
source_decision_id
source_attempt_id
configuration_revision
binding_fingerprint
authorized_binding_json
resume_at
status
timer_event_id
consumed_decision_id
created_at
updated_at
```

Required indexes:

- `(status, resume_at)` for due wakes;
- `(task_id, generation_id, status)` for Task recovery;
- `(source_decision_id)` for application postconditions;
- `(timer_event_id)` for idempotent Timer replay.

The 44-to-45 migration must be transactional and preserve all existing facts. Existing `wait_for_retry` Decisions are not silently rewritten; startup recovery derives missing Retry Wake rows from their durable Decision action and current Task/Attempt facts.

## 6. Kernel Application And Event Ordering

The Runtime must return an applied effect whose durable postcondition is visible before any follow-up event can be claimed. The implementation may use either:

1. a transaction in `KernelWorkflowStore` that marks the application applied and inserts the follow-up event; or
2. a Retry Wake outbox transaction, followed by a worker that emits the Timer only after the parent application is `applied`.

The selected implementation must satisfy:

```text
parent Decision application != applied
  => follow-up Timer cannot be processed
```

`wait_for_retry` postcondition becomes:

```text
Task is blocked
AND exact kernel_retry dependency is waiting
AND exact Retry Wake is armed or fired
```

A partial result is `uncertain` or `retry_safe`, never `applied`.

## 7. Stale Wake Convergence

`decideTimer()` must stop returning an undifferentiated `no_op` for retry wakes. It must classify:

| Condition | Durable result |
| --- | --- |
| Task terminal/cancelled | Mark Wake superseded; no Task mutation |
| Different continuation already owns the Task | Mark Wake superseded |
| Exact blocker and identity match | Authorize continuation dispatch |
| Wake fired but blocker missing due an invariant violation | Emit recovery-required fact |
| Revision/binding/generation mismatch | Supersede only if a newer authorized chain exists; otherwise recovery-required |
| Duplicate Timer event | Reuse existing decision/application identity; never create a second Attempt |

## 8. Existing Stuck Task Recovery

Startup and periodic recovery must detect:

```text
Task blocked
AND kernel_retry dependency waiting
AND no armed/fired Retry Wake
```

Recovery must locate the exact `wait_for_retry` Decision by Task, generation and source Attempt:

- recreate the missing Wake if the Decision postcondition is retry-safe;
- emit an immediate Timer if `resume_at` is already past;
- otherwise emit `recovery_required_observed` with a concrete diagnosis;
- never edit Task rows directly outside the Task lifecycle port.

The current production Task must be recovered through this path, not by manual SQLite mutation.

## 9. Projection And Billing

TaskView derives `retrying` only from a non-superseded Retry Wake. If the Wake is consumed, missing, or contradictory, the projection must show `recovery_required` or `blocked` with diagnosis instead of claiming that retry will happen automatically.

Billing remains governed by the existing billing owner:

- the timed-out Attempt remains measured;
- the retry Attempt receives its own usage facts;
- final bill status is determined only after Task/Query settlement;
- a waiting Retry Wake is residue, not bill finality.

## 10. Implementation Tasks

### Task 1: Document and freeze the contract

**Files:**

- Create: this plan
- Modify: `docs/current/task-lifecycle-state-contracts.md`
- Modify: `CONTEXT.md`
- Modify: `docs/README.md`

Add Retry Wake ownership, the authoritative chain, postconditions, and recovery diagnosis. Keep the plan Active Delivery until live acceptance closes.

### Task 2: Add failing state-machine and repository tests

**Files:**

- Create: `src/storage/retry-wake-repo.ts`
- Create: `tests/storage/retry-wake-repo.test.ts`
- Modify: `tests/kernel/control-kernel.test.ts`
- Modify: `tests/execution/kernel-execution-runtime-recovery.test.ts`

First reproduce:

- Timer evaluation before `wait_for_retry` application;
- duplicate due-wake claims;
- missing blocker with an existing retry Decision;
- stale generation/revision;
- process restart between armed and fired.

### Task 3: Add schema-45 Retry Wake persistence

**Files:**

- Modify: `src/storage/migrations.ts`
- Modify: `tests/storage/migrations.test.ts`
- Modify: Docker schema workflow tests and volume declarations where required.

Implement transactional migration, indexes, and repository operations:

```text
arm
claimDue
markFired
markConsumed
markSuperseded
markRecoveryRequired
findByDecision
findBlockingByTask
```

All operations must use conditional updates and be replay-safe.

### Task 4: Make `wait_for_retry` atomic

**Files:**

- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/execution/kernel-application-recovery.ts`
- Modify: `src/storage/kernel-workflow-repo.ts`
- Test: execution and recovery suites.

Remove the conditional “only block if Task is running” behavior. Persist the blocker and Retry Wake before exposing a Timer. Update the application inspector to require all three postconditions.

### Task 5: Implement durable Retry Wake delivery

**Files:**

- Create: `src/account/retry-wake-worker.ts`
- Modify: `src/account/account-startup-recovery-service.ts`
- Modify: `src/account/account-runtime-composition.ts`
- Modify: `src/server/server-composition.ts`
- Test: worker restart, duplicate claim, delayed application, and Timer ordering.

Replace in-memory retry scheduling with a bounded worker using the durable repository. Startup and periodic recovery share the same convergence entry.

### Task 6: Bind Timer decisions to exact wakes

**Files:**

- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/kernel/kernel-workflow.ts`
- Test: stale wake, duplicate Timer, revision change, and cancellation.

Extend Timer payload and snapshot facts with Wake identity. Classify superseded and recovery-required outcomes instead of silently returning `no_op`.

### Task 7: Make continuation dispatch consume the Wake atomically

**Files:**

- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/execution/attempt-supervisor.ts`
- Modify: `src/task/task-view.ts`
- Test: dispatch-before-launch, blocked-to-executing transition, and crash recovery.

Ensure no continuation Attempt can launch without a durable dispatch and matching Task/Subtask transition.

### Task 8: Recover existing production residue

**Files:**

- Modify: `src/account/account-startup-recovery-service.ts`
- Test: a blocked Task with a missing Wake converges to retry or explicit recovery.

Run the recovery path against a copied production database first. Only after the copied database passes should the canonical Server be restarted and the live Task checked.

### Task 9: Update projections and operational diagnostics

**Files:**

- Modify: `src/task/task-view.ts`
- Modify: `src/management/execution-projector.ts`
- Modify: TUI Task dashboard and Web task projection if necessary.
- Test: no false `retrying`, explicit stale-wake diagnosis, billing residue remains accurate.

### Task 10: Verification and rollout

Required:

- `npx tsc --noEmit`
- schema migration and Docker contract tests
- focused Retry Wake, Kernel, Runtime, recovery and TaskView tests
- full test suite with baseline comparison
- canonical build and schema-45 installation
- real timeout -> retry success/failure acceptance
- Server restart at armed/fired/dispatch stages
- TUI/Web state and billing convergence

No completion claim is allowed while the retry chain, existing stuck Task, or live restart gate remains unverified.

## 11. Rollout And Status

Status: Active Delivery. Plan date: 2026-09-27. Completion date and closing commit: pending.

Delivered in source:

- schema 45 Retry Wake persistence and conditional lifecycle operations;
- transactional Task blocker plus Wake arming;
- account-scoped due/fired Worker with deterministic Timer replay;
- exact Timer identity validation and stale-wake convergence;
- continuation dispatch ordering, residue protection and TaskView recovery projection;
- startup/periodic missing-Wake reconstruction and explicit recovery diagnosis;
- focused repository, Kernel, Runtime, migration, projection and durable retry tests.

Still open:

- process-level restart acceptance at `armed`, `fired` and dispatch stages;
- native TUI reconnect and Web attach/refresh acceptance;
- real timeout-to-retry success and retry-failure/terminal convergence;
- canonical schema-45 installation and production residue verification.

Implementation order:

```text
contract/docs
  -> failing tests
  -> schema/repository
  -> atomic wait_for_retry
  -> durable wake worker
  -> exact Timer identity
  -> continuation dispatch
  -> residue recovery
  -> live acceptance
```

The current canonical Server remains the only production deployment. No direct database repair, parallel retry scheduler, or UI-only workaround is permitted.

## 12. Source Validation Checkpoint (2026-09-27)

The source implementation was validated together with the Span-routing merge
and the live terminal-state correction. This is not a canonical-installation
or live timeout acceptance claim.

- `npx tsc --noEmit` passed.
- `npm run build` passed, including the Web build.
- Retry Wake, Kernel, Runtime, account recovery, Span routing, and session
  integration focused tests passed: 92 tests.
- Gateway, Web management, trace stream, and execution projector tests passed:
  109 tests.
- The Web terminal regression starts with a running Turn, switches the durable
  execution timeline to `done`, and verifies that the live projection becomes
  `completed` without a refresh.
- Remaining plan gates are unchanged: process restart at armed/fired/dispatch,
  canonical schema-45 installation, real timeout-to-retry acceptance, and
  native Web/TUI reconnect validation.
