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
- Status: **core structure implemented, closure acceptance not completed.**
  Phases 0-5 are implemented and reviewed; the 2026-09-25 review found real
  control-chain, postcondition, residue and projection defects that are listed
  in §13 and were fixed in the follow-up revision. The plan is not archived as a
  completed delivery until the fault-injection and real-client acceptance in §14
  are executed.
- Review scope: `55184d8..dc1c533`, reviewed without modifying code, the
  production database or running services.
- Production database: unchanged (no schema migration was needed; the durable
  Replan Job reuses `generation_replan_requests`).
- Runtime services: changed. `schedule_replan` replaces the foreground
  `request_replan` callback application, the account periodic review drives
  `GenerationReplanWorker`, every strategic Task/Subtask status write goes
  through the transition port, and Conversation slot release is residue-driven.

### Delivered

**Phase 0 — contract freeze and characterization**

- Canonical ownership matrix, Task and Subtask transition tables, causal chain,
  replan idempotency rules, per-family uncertain-application postconditions and
  the TaskView priority recorded in
  [`docs/current/task-lifecycle-state-contracts.md`](../current/task-lifecycle-state-contracts.md).
- Executable contracts: [`src/task/task-lifecycle.ts`](../../src/task/task-lifecycle.ts),
  [`src/task/task-view.ts`](../../src/task/task-view.ts).
- ADR amendments: ADR-0020 (status-contract seam and transition port), ADR-0022
  (attempt settlement / `awaiting_completion`), ADR-0023 (durable Replan Job and
  uncertain-application convergence), ADR-0037 (residue-based slot release /
  TaskView).
- Characterization fixture `schedules a durable Replan Job at generation
  quiescence without a foreground Planner` reproduces the 2026-09-25 chain and
  fails on the pre-change implementation because that decision was applied
  through the foreground system binding and left the application `uncertain`.

**Phase 1 — canonical contracts and read projection**

- `projectTaskView()` is a pure read projection over durable facts. A persisted
  `running` Task with no active authorized Attempt is never projected as
  `executing`; `deriveTaskLifecycleState()` reports `coordinating`.
- Gateway `GatewayTaskViewSnapshot.lifecycle` exposes the projection additively.
- Surfaces consume it: the vendored MetaWork TUI dashboard renders
  `taskPhase ?? taskStatus` from the normalized `lifecycle.phase`, its mirror
  protocol treats `lifecycle` as an optional extension, and the
  Feishu/Web `ConversationActivityProjector` derives its card state from the same
  canonical lifecycle instead of raw `task.status`. Web does not consume
  `task_view_snapshot` at all.

**Phase 2 — durable Replan Job**

- `ControlKernel` emits `schedule_replan` with the deterministic `replanJobId` at
  both quiescence seams. The Runtime application only durably schedules the Job
  and is `applied` immediately; no Planner callback is invoked.
- `GenerationReplanRequestRepo` gains `scheduleForPlanner`, `isScheduledForPlanner`,
  `claimForPlanner`, `listPlannerClaimable`, `releasePlannerClaim`, `listByTask`
  and `findLatestOpen`.
- `GenerationReplanWorker` (account-scoped) is the only consumer, driven by
  `AccountStartupRecoveryService.recoverPeriodic` from the Server task-pool
  timer, so a replan converges with no attached client.
- Planner unavailability is bounded: backoff, then fail-closed
  `planner_unavailable`, which the Kernel projects into an explicit `block_work`.

**Phase 3 — convergent uncertain applications and slot release**

- `inspectApplicationPostcondition()` / `inspectApplicationAgainstSources()`
  declare a postcondition for every managed action family: `dispatch`,
  `replan`, `task_transition`, `plan_activation` and observation-only actions.
  Cancellation, external effects and the merge path keep their dedicated
  reconcilers.
- Startup and periodic recovery resolve `applied` / bounded `retry_safe`
  (`applyAttempts < 3`) / `recovery_required`; an unresolved control operation is
  never silently repaired with SQL.
- `hasReleasableResidue()` extends the residue reader to backend executions,
  uncertain Kernel applications and outstanding Replan Jobs;
  `convergeConversationSlots()` releases a terminal or blocked Task's slot only
  when residue is clear and promotes the next same-Conversation Task exactly
  once.
- `/task recovery <taskId>` prints the declared `family/verdict` diagnosis from
  the same inspector the sweep acts on.

**Phase 4 — lifecycle transition ownership**

- `src/task/task-lifecycle-transition-port.ts` is the single owner of strategic
  Task and Subtask writes, with a validation guard, an actor/reason audit trail,
  idempotent replay of cancellation and blocking, and rejection of any
  transition out of a terminal lifecycle.
- Every Runtime caller is migrated: `KernelExecutionRuntime`,
  `TaskCancellationCoordinator`, `WorkGraphRuntimeService`,
  `WorkspacePublicationWorker`, `SubtaskAttemptRunner`, `SessionKernelRuntime`
  and `AccountStartupRecoveryService`. `TaskRuntimeService` is no longer written
  directly by Runtime code; user `/task` commands remain Task Domain operations
  through `TaskEngine`.
- The canonical Subtask transition table and the fact-aware canonical Task
  lifecycle are part of the same contract module.

**Phase 5 — cleanup, documentation and operational closure**

- Removed the dead foreground replan callback: the `requestReplan` entry was
  deleted from `KernelExecutionRuntimeCallbacks`, the account system binding,
  `ConversationSession`, `MetaclawSession` and the test bindings, along with the
  now-unreachable `requestKernelReplan` methods. The merge-replan path keeps its
  own callback.
- Removed the duplicate status interpretation in the Feishu/Web activity card
  and the TUI dashboard.
- Updated `CONTEXT.md` (Task State, Task View, Task Lifecycle Transition Port,
  Attempt Settlement, Generation Replan Request), the current technical
  overview, the ADR authority index and the contract document.

### Validation

- `npx tsc --noEmit` clean.
- Full suite after the review corrections: 2642 tests, 2628 passed, 3
  pre-existing failures (`tests/billing/bill-finality.test.ts`,
  `tests/configuration/configuration-module-boundary.test.ts`,
  `tests/docker/shell-schema-isolation.test.ts`) and 6 pre-existing
  configuration-dependent `tests/session/*` files. All nine fail identically on
  the pre-change revision in this environment and are unrelated to this work.
- New focused coverage: `tests/task/task-lifecycle.test.ts`,
  `tests/task/task-view.test.ts`,
  `tests/task/task-lifecycle-transition-port.test.ts`,
  `tests/account/generation-replan-worker.test.ts`,
  `tests/execution/kernel-application-recovery.test.ts`.
- New integration coverage in
  `tests/account/account-startup-recovery-service.test.ts`: durable Replan Job
  scheduling without a foreground Planner; uncertain replan and `complete_task`
  postcondition convergence; bounded retry for an uncertain `dispatch_batch`;
  blocked Task slot release with exactly-once successor promotion.
- Updated contract tests: `tests/session/planning-kernel-path.test.ts`
  (durable scheduling then worker-driven replan),
  `tests/workspace/conversation-activity-projector.test.ts` (a running Task with
  no active Attempt is never `executing`).
- Docker: `Dockerfile.test` runs `npm test`, so every scenario above is part of
  the supported container gate. `npm run smoke:metawork` remains the live native
  Planner-to-Executor gate.
- Not executed in this environment: a live native Server restart / TUI reconnect
  / Web attach acceptance pass, and a live Planner-unavailable fault injection.
  Both require external Planner/Web/provider processes; the equivalent durable
  paths are covered by the SQLite-backed account-runtime integration tests
  above. Recorded as an explicit residual validation gap rather than a claim.

### Review corrections (2026-09-25)

Review scope `55184d8..dc1c533`. Corrections: `528755b`
(`fix: close the task lifecycle convergence gaps found in review`), `ddcc5b6`
(`docs: correct the convergence status and contracts after review`) and
`1a9e1b8` (`fix: drain a retried uncertain application in the same recovery
pass`).


A follow-up review of Phases 0-3 found that several completion claims exceeded
the implementation. Each finding below is fixed, with the fix named and covered
by a focused test.

| # | Finding | Fix |
| --- | --- | --- |
| 1 | A failed Replan Job did not wake the Kernel, so the Task stayed `running` forever | Recovery emits a deterministic `recovery_required_observed` event; `ControlKernel.decideRecoveryRequired()` authorizes `block_work` with a `recovery_required: …` blocker. `AccountStartupRecoveryService.convergeRecoveryRequired()` drives it from both entry points. |
| 2 | `convergeUncertainApplications` / `convergeConversationSlots` ran only at startup | Both are reached through one shared `convergeRecovery()` entry used by `recover()` and `recoverPeriodic()`, selected from durable pending facts rather than a blocked-only Task scan. A budget-exhausted application now produces the recovery fact above instead of staying silently `uncertain`. |
| 3 | `block_work` postcondition used `Task || Subtask`, so a half-applied decision read as success; `resume_task` was mis-classified and its replay short-circuited | `block_work` now requires the whole operation (Task blocked **and** the named Subtask resolved). `resume_task` keeps its own inspector and its apply no longer returns early for a `running` Task, so a replay completes the missing dispatch observation. |
| 4 | A second residue definition (`hasReleasableResidue`) disagreed with `TaskResidueReader` | The local check is deleted; every release path calls `TaskResidueReader.blockingReasons()` with an explicit generation and an explicit excluded Decision id. |
| 5 | Job idempotency did not make the Planner turn idempotent | The proposal event id is derived from the Job (`generationReplanProposalEventId()`) and the proposal is persisted in the Kernel inbox **before** the `submitted` transition, so the worker distinguishes "not yet planned / proposal persisted / claim with unknown submission" and never re-plans a persisted proposal. |
| 6 | The activity card hardcoded "no Replan Job" and TaskView fell back to a false `waiting_for_plan`; Gateway `completionResidue` was fixed to `[]` | The activity card receives `openReplanJobTaskIds` and `pendingRetryWakeTaskIds` and consumes `deriveTaskLifecycleState()`. TaskView reports `recovery_required` with `recoveryDiagnosis` when no driver exists. `listCompletionResidue()` reads the same residue reader as the release paths. |
| 7 | Contract and port comments said Work Graph owns the Subtask lifecycle; the composed port's two `listTransitions()` overwrote each other | ADR-0020 assigns Task and Subtask lifecycle to the **Task Domain**; the wording is unified and the composed port merges the observation streams. The record is documented as an in-process observation seam, not a durable audit. |
| 8 | Re-queuing an uncertain application did not drain it, so the retried Decision was never re-applied | `convergeRecovery()` drains every Task it re-queued in the same pass and tolerates a Task without a resolvable origin. Covered by `retries a safe uncertain application in the same pass it re-queues it`. |
| 9 | No test covered the residue categories the duplicated check missed | `tests/execution/task-residue-reader.test.ts` covers `pending`/`applying`/`uncertain` applications, a terminal dispatch item without a receipt, identity-scoped Decision exclusion and a claimed WorkUnit with an outstanding Replan Job. |

### Closing revision

`11660a1` `feat: converge uncertain applications and centralize lifecycle
transitions` delivered Phases 3-5 and `939aded` recorded that closure. The review
corrections in §13 and the §14 work are the current head of
`feat/task-lifecycle-state-convergence`.

### Remaining before the plan can be marked complete

1. Fault injection at the durable seams the review exercised manually: a Planner
   failure via the real periodic entry point (covered), a crash between the
   Planner turn and the proposal persist (covered), and a crash between the
   `recovery_required_observed` event and the Task block (covered by the
   `task_transition` postcondition retry).
2. Real client acceptance that this environment cannot run: live native Server
   restart, TUI reconnect, Web attach and a live Planner-unavailable fault with a
   running Server. Until those are executed the plan stays in Active Delivery.
