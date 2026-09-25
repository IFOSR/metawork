# Task Lifecycle State Convergence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 收敛 MetaWork 的 Task、Subtask、Attempt、Kernel application、WorkUnit 和 Conversation slot 状态边界，确保后台执行、重试、重规划、阻塞、完成和资源释放最终形成一条可验证、可恢复、可投影的生命周期。

**Architecture:** 保留 `Planner -> ControlKernel -> Runtime -> Executor -> normalized facts` 主轴。Task/Work Graph 负责唯一的业务生命周期，Attempt、Lease、Kernel application 和 Slot 只保留技术事实与资源协议；`request_replan` 改为 durable Replan Job，不再依赖前台 Conversation Planner 回调。TUI、Web 和 Feishu 只消费统一的派生 `TaskView`，不直接解释底层状态。

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite/better-sqlite3, DurableKernelWorkflow, ControlKernel v5, Work Graph v7, Completion Protocol v4, native Planner RPC, Gateway/TUI/Web projections.

---

## 1. Problem And Scope

### 1.1 Confirmed production failure

The failure investigated on 2026-09-25 was not a lost Kernel outcome. The two `heartbeat_lost` attempts were durably landed and their `execution_outcome` events were processed. The chain stopped when `request_replan` was applied through the startup system binding:

```text
Attempt settled
-> Subtask awaiting_decision
-> dispatch terminal
-> Kernel queue_generation_replan
-> Kernel request_replan
-> system binding requires Conversation Planner
-> application uncertain
-> replan request failed
-> Task running and Conversation slot occupied indefinitely
```

The design must eliminate this dependency on an attached foreground Conversation.

### 1.2 In scope

- Define one owner for every persisted state or fact.
- Separate business lifecycle, attempt outcome, control transaction and resource claims.
- Replace synchronous foreground `request_replan` application with a durable Replan Job.
- Make every `uncertain` Kernel application converge through postcondition checks, idempotent retry or explicit recovery blocking.
- Add a user-facing Task phase projection that never equates `running` with all non-terminal work.
- Preserve immutable historical receipts, decisions and raw attempt facts.
- Migrate existing behavior incrementally without manual SQLite repairs.

### 1.3 Out of scope

- Replacing the ControlKernel, DurableKernelWorkflow or AccountRuntime.
- Introducing a second scheduler or semantic router.
- Changing Executor model routing, billing semantics or result certification.
- Treating every heartbeat loss as `blocked`.
- Making TUI, Web or Dashboard responsible for reconciliation.

## 2. Target State Model

Only the first two rows below are business lifecycle state machines. The remaining rows are operational facts or protocols and must not be presented as peer Task statuses.

| Domain | Canonical owner | Target contract |
| --- | --- | --- |
| Task lifecycle | Task Domain, applied only from Kernel-authorized actions | `queued`, `executing`, `coordinating`, `waiting_for_user`, `blocked`, `completed`, `failed`, `cancelled` |
| Subtask node lifecycle | Work Graph/Task Domain | `pending`, `executing`, `awaiting_completion`, `completed`, `blocked`, `cancelled` |
| Attempt | Execution Runtime | lifecycle `authorized -> launched -> running -> settling -> settled`, plus immutable outcome `succeeded`, `failed`, `heartbeat_lost`, `cancelled`, or `unknown` |
| Kernel application | KernelWorkflow/AccountRuntime | `pending`, `applying`, `applied`, `uncertain`, `failed`; internal recovery state only |
| WorkUnit/lease | Execution Runtime and Resource Model | claim, lease expiry, release; `heartbeat_lost` is a normalized Attempt/lease fact |
| Conversation admission | Account scheduler | durable slot claim with `free`, `held`, and bounded `release_pending`; richer blockers are derived from residue |
| User-facing view | Read-only projection layer | `queued`, `executing`, `retrying`, `waiting_for_plan`, `waiting_for_user`, `publishing`, `recovery_required`, `blocked`, `completed`, `failed`, `cancelled` |

The physical schema may retain historical columns during migration, but new production decisions must use the canonical contracts and explicit mapping functions owned by the corresponding domain.

## 3. Ownership Rules

### 3.1 Task and Subtask

- Task Domain owns lifecycle invariants and valid transitions.
- Work Graph owns node identity, dependency topology, runnable-frontier derivation and handoff rules.
- Runtime applies Kernel decisions through Task/Work Graph ports; it does not choose the next strategic action.
- Planner proposes plans only and never writes Task/Subtask status.

### 3.2 Attempt and resources

- Execution Runtime owns attempt creation, launch, settlement, receipt landing and normalized execution facts.
- WorkUnit and resource leases are disposable execution capacity, not user-facing task state.
- `terminal` is replaced in public vocabulary by “attempt settled”; success comes from the immutable outcome and later publication/certification.

### 3.3 Kernel workflow and recovery

- KernelWorkflow owns Decision application lifecycle and recovery cursor.
- ControlKernel owns retry, fallback, replan, block, completion and cancellation policy.
- Runtime actions must expose durable postconditions or an idempotency key.
- No Runtime action may require a live TUI, Web connection, ConversationSession callback or user input channel merely to record a durable intent.

### 3.4 Conversation slot

- Account scheduler owns the slot claim and promotion race.
- Slot release is allowed only after the Task is in a releasable state and the residue reader confirms no active or uncertain dispatch, publication, backend, lease, WorkUnit or control operation remains.
- A slot is not a substitute for Task status and is not directly changed by presentation surfaces.

## 4. Formal Lifecycle

The authoritative chain is:

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

No step may directly set `Task = blocked` or release the slot based only on a WorkUnit heartbeat event.

## 5. Durable Replan Design

### 5.1 Replace synchronous callback application

Replace the current `request_replan -> ConversationSession.requestReplan()` path with a Kernel-authorized durable action:

```text
schedule_replan
  -> insert-or-replay Replan Job
  -> mark Decision application applied once the Job postcondition is durable
  -> Task phase = waiting_for_plan/coordinating
  -> Planner Worker consumes the Job
  -> Planner emits plan_proposed through the normal Kernel ingress
```

The Replan Job must carry immutable `taskId`, `conversationId`, `plannerSessionId`, `generationId`, `sourceRevision`, `triggerDecisionId`, configuration revision, idempotency key, bounded evidence references and retry metadata.

### 5.2 Planner unavailable behavior

- Temporary Planner transport/process failure leaves the Replan Job pending with a bounded retry schedule.
- Planner semantic rejection produces a normalized Planner failure fact.
- Retry exhaustion or permanent Planner unavailability produces a Kernel-authorized `block_work` with an explicit `planner_unavailable` or `replan_required` blocker.
- A blocked Task with no residue releases its Conversation slot.
- No foreground client is required for any of these transitions.

### 5.3 Replan idempotency

The same Decision ID and Replan Job ID must never create duplicate Planner turns or duplicate graph revisions. A submitted proposal is accepted only through the existing proposal identity and Kernel validation path.

## 6. Uncertain Application Recovery

Every Kernel action must declare its postcondition:

| Action family | Recovery postcondition |
| --- | --- |
| Dispatch | Expected dispatch item exists with the same Decision ID and binding |
| Replan | Expected Replan Job exists with the same idempotency key |
| Block/complete | Task/Subtask transition and required effects are durable |
| Slot release | Slot owner and reservation epoch no longer belong to the Task |
| External delivery | Existing outbox/provider receipt rules remain authoritative |

Startup and periodic recovery must:

1. Inspect the action-specific postcondition.
2. Mark the application `applied` when the postcondition is present.
3. Retry the same Decision when the postcondition is absent and retry is safe.
4. Emit a normalized recovery fact when the outcome remains unknowable.
5. Let ControlKernel authorize either another bounded retry or explicit blocking.

The invariant is:

```text
uncertain application
  -> applied
  -> retry_pending
  -> recovery_required/blocked
```

It must never remain permanently paired with `Task = running` and `Slot = occupied`.

## 7. Unified TaskView

Create one read-only projection contract for TUI, Web, Feishu and command output. It must include:

- canonical lifecycle state;
- user-facing phase;
- whether an Attempt is actively running;
- current Attempt kind and ordinal;
- retry/replan/recovery reason;
- safe partial result and certification state;
- blocking residue categories;
- next authorized action;
- timestamps for last progress, attempt settlement and next wake;
- final result or explicit terminal explanation.

Projection rules:

```text
active Attempt exists                 -> executing
retry wake exists                     -> retrying
pending Replan Job exists             -> waiting_for_plan
uncertain application exists          -> recovery_required
no active work and user action needed -> waiting_for_user/blocked
all certification/publication clear   -> completed
```

Raw `Task.status`, `dispatch.status`, `WorkUnit.state` and `KernelApplicationStatus` must not be rendered directly as user-facing prose.

## 8. Implementation Phases

### Phase 0: Contract freeze and characterization

**Deliverables**

- State ownership matrix and transition table.
- Production fixture reproducing the 2026-09-25 heartbeat-loss -> replan -> uncertain chain.
- Invariants for Task/Attempt/Slot convergence.
- ADR amendment covering the new state model and durable replan boundary.

**Exit gate**

- The fixture fails on the current implementation for the right reason.
- No implementation change is made before the failing characterization exists.

### Phase 1: Canonical contracts and read projection

**Deliverables**

- Domain-owned lifecycle types and explicit Kernel snapshot mappings.
- Remove duplicated status unions from public cross-module contracts where possible.
- Implement `TaskView` as a read-only projection without changing recovery behavior.
- TUI/Web/Feishu/dashboard consume the projection.

**Exit gate**

- Existing raw facts remain unchanged.
- A task with no active Attempt cannot display as actively executing.
- Historical Task/Attempt views remain replayable.

### Phase 2: Durable Replan Job

**Deliverables**

- Replan Job repository/port and idempotency contract.
- Kernel action that durably schedules the Job.
- Account-scoped Planner Worker that can run without a foreground client.
- Normalized Planner availability, transport uncertainty and semantic failure facts.

**Exit gate**

- Replan application succeeds when TUI/Web is disconnected.
- Server restart resumes a pending Replan Job.
- Duplicate recovery does not create duplicate Planner turns or graph revisions.

### Phase 3: Convergent uncertain applications

**Deliverables**

- Action-specific postcondition inspectors.
- Startup recovery and explicit recovery command integration.
- Bounded retry and explicit `recovery_required`/`blocked` path.
- Task/Slot release only after residue convergence.

**Exit gate**

- No synthetic SQL cleanup is needed.
- Every seeded uncertain application reaches `applied`, safe retry or explicit blocked recovery.
- An unresolved control operation is visible in TaskView and diagnostics.

### Phase 4: Lifecycle transition ownership

**Deliverables**

- Central Task/Work Graph transition port.
- Runtime callers stop directly writing strategic Task/Subtask states.
- Attempt settlement, Kernel Decision application and Task projection are tested as one causal chain.
- Legacy `awaiting_decision`, `terminal` and direct status writes are retained only for migration/audit where necessary.

**Exit gate**

- All valid transitions have one owner.
- Invalid cross-layer transitions are rejected by focused tests.
- Heartbeat loss, cancellation, retry, fallback, replan and completion all converge.

### Phase 5: Cleanup and documentation closure

**Deliverables**

- Remove obsolete foreground replan callback path.
- Remove or quarantine duplicate status contracts and direct Repository writes.
- Update `CONTEXT.md`, technical overview, ADR authority index and operational diagnostics.
- Add native and Docker smoke coverage where supported.

**Exit gate**

- `npm run lint`, focused state/recovery tests and required SQLite/Docker tests pass.
- Real Server restart, TUI reconnect, Web attach, Planner unavailable and queued-task promotion scenarios pass.
- The plan records completion date, validation and closing commit before being archived.

## 9. Required Tests

- Attempt heartbeat loss lands receipt, closes dispatch, emits one Kernel event and releases the WorkUnit.
- First heartbeat loss retries exactly once when policy allows.
- Exhausted retry schedules exactly one Replan Job.
- Replan application succeeds without an attached Conversation.
- Planner process crash resumes the same Replan Job idempotently.
- Replan semantic failure becomes explicit blocked recovery, not permanent `running`.
- Uncertain dispatch/replan/block/complete applications converge by postcondition.
- TaskView distinguishes active execution from retry, replan, recovery and blocked states.
- Slot remains held during active/uncertain residue and releases after convergence.
- A released slot promotes the next same-Conversation Task exactly once.
- TUI, Web and Feishu projections agree for the same durable Task facts.
- Historical receipts and decisions remain immutable.

## 10. Prohibited Shortcuts

- Do not map every `heartbeat_lost` directly to `blocked`.
- Do not repair state by manually updating SQLite.
- Do not make Dashboard/TUI/Web responsible for reconciliation.
- Do not invoke Planner through a foreground Conversation callback from startup recovery.
- Do not introduce a second retry/fallback/replan policy outside ControlKernel.
- Do not mark `Task = completed` from an Attempt receipt alone.
- Do not release a Conversation slot while active or uncertain residue remains.

## 11. Documentation And Governance

Before implementation begins, amend the applicable current ADRs rather than silently overriding them:

- ADR-0020 for the refined module ownership and status-contract seams.
- ADR-0022 for Attempt settlement and Subtask waiting semantics.
- ADR-0023 for durable Replan Job and uncertain application recovery.
- ADR-0037 for Conversation slot release and TaskView interaction with scheduling.

Update `CONTEXT.md` and the current technical overview only after the contract is accepted and the first implementation phase is complete. This plan remains the working implementation authority until the amended ADRs and delivered validation supersede it.

## 12. Current Status

- Plan date: 2026-09-25
- Status: Phases 0-3 implemented on `feat/task-lifecycle-state-convergence`;
  Phases 4-5 remain. Not archived.
- Production database: unchanged by this work stream (no schema migration was
  needed; the durable Replan Job reuses `generation_replan_requests`).
- Runtime services: changed. `schedule_replan` replaces the foreground
  `request_replan` callback application, and the account periodic review now
  drives `GenerationReplanWorker`.

### Delivered (2026-09-25)

**Phase 0 — contract freeze and characterization**

- Canonical ownership matrix, Task transition table, causal chain, replan
  idempotency rules, uncertain-application postconditions and TaskView priority
  recorded in [`docs/current/task-lifecycle-state-contracts.md`](../current/task-lifecycle-state-contracts.md).
- Executable contracts: [`src/task/task-lifecycle.ts`](../../src/task/task-lifecycle.ts),
  [`src/task/task-view.ts`](../../src/task/task-view.ts).
- ADR amendments: ADR-0020 (status-contract seam), ADR-0022 (attempt
  settlement / `awaiting_completion`), ADR-0023 (durable Replan Job and
  uncertain-application convergence), ADR-0037 (slot release / TaskView).
- Characterization fixture `schedules a durable Replan Job at generation
  quiescence without a foreground Planner` in
  [`tests/account/account-startup-recovery-service.test.ts`](../../tests/account/account-startup-recovery-service.test.ts)
  reproduces the 2026-09-25 chain and fails on the pre-change implementation
  because that decision was applied through the foreground system binding and
  left the application `uncertain`.

**Phase 1 — canonical contracts and read projection**

- `projectTaskView()` is a pure read projection over durable facts. A `running`
  Task with no active Attempt is never projected as `executing`.
- Gateway `GatewayTaskViewSnapshot.lifecycle` exposes the projection additively
  (`phase`, `activeAttempt`, `blockingResidue`, `nextAuthorizedAction`,
  `explanation`, timestamps). The vendored AnyFusion-Pi mirror accepts it as an
  optional extension; Web does not consume `task_view_snapshot`.
- Remaining for the Phase 1 exit gate: TUI/Feishu render `lifecycle.phase`
  instead of raw status strings.

**Phase 2 — durable Replan Job**

- `ControlKernel` emits `schedule_replan` with the deterministic `replanJobId` at
  both quiescence seams. The Runtime application only durably schedules the Job
  and is `applied` immediately; no Planner callback is invoked.
- `GenerationReplanRequestRepo` gains `scheduleForPlanner`, `isScheduledForPlanner`,
  `claimForPlanner`, `listPlannerClaimable`, `releasePlannerClaim`, `listByTask`
  and `findLatestOpen`.
- `GenerationReplanWorker` (account-scoped) is the only consumer. It is driven
  by `AccountStartupRecoveryService.recoverPeriodic`, which the Server task-pool
  timer already calls, so a replan converges with no attached client.
- Planner unavailability is bounded: backoff, then fail-closed
  `planner_unavailable`, which the Kernel projects into an explicit `block_work`.

**Phase 3 (replan action family) — convergent uncertain applications**

- `isSatisfiedReplanScheduling()` / `isRetrySafeUncertainReplanScheduling()`
  inspect the durable Job postcondition during `recover()`. Satisfied
  applications become `applied`; a Job still `pending_quiescence` is retried with
  the same Decision; nothing stays `uncertain` while the Task remains `running`.

### Validation

- `npx tsc --noEmit` clean.
- Full suite: 2611 tests, 2597 passed, 3 pre-existing failures
  (`tests/billing/bill-finality.test.ts`,
  `tests/configuration/configuration-module-boundary.test.ts`,
  `tests/docker/shell-schema-isolation.test.ts`) and 6 pre-existing
  configuration-dependent `tests/session/*` files. All nine fail identically on
  the pre-change revision in this environment.
- Focused new coverage: `tests/task/task-lifecycle.test.ts`,
  `tests/task/task-view.test.ts`, `tests/account/generation-replan-worker.test.ts`,
  `tests/execution/kernel-application-recovery.test.ts`.
- Updated contract test: `tests/session/planning-kernel-path.test.ts`
  "routes exhausted task failure through one Kernel-authorized replan revision"
  now asserts the durable scheduling postcondition and then drives the worker.

### Remaining (Phases 3-5)

- Phase 3 for the remaining action families (dispatch, block/complete, slot
  release) and the explicit recovery command surface.
- Phase 4: a central Task/Work Graph transition port so Runtime callers stop
  writing strategic Task/Subtask states directly; today only the mapping and
  guard functions exist.
- Phase 5: remove the now-dead `requestReplan` execution callback from
  `ConversationSession`/`MetaclawSession` and the binder, remove Ink-era
  duplicates, and add Docker/native smoke coverage for Planner-unavailable and
  queued-Task promotion.
- Task phase 4 also owns turning `Task = running` plus an outstanding durable
  Replan Job into the canonical `coordinating` Task lifecycle state.
