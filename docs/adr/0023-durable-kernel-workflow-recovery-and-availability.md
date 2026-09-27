# ADR-0023: Durable Kernel Workflow, Recovery And Availability

- **Status**: Accepted
- **Date**: 2026-07-21
- **Scope**: Phase 4 durable workflow, application recovery, structured failure, retry/fallback, availability, continuation, replan revisions, outbox and manual recovery
- **Amends**: ADR-0017, ADR-0018, ADR-0021, ADR-0022
- **Governed by**: ADR-0020

## Context

ADR-0022 established a ledger-first synchronous loop but intentionally failed closed after a crash between Decision issuance and apply. It also deferred structured failure, retry/fallback, continuation, automatic replan and reliable external effects. Implementing these independently in Session, timers, adapters or a workflow framework would recreate competing strategic interpreters.

## Decision

MetaClaw introduces one durable application seam:

```ts
interface KernelWorkflow {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
  recover(): Promise<KernelRecoveryReport>;
}
```

`submit` durably enqueues before synchronously draining. `recover` reconciles applications, orphan attempts and due events before external input opens. The pure `ControlKernel.decide(event, snapshot)` Interface remains the only strategic authority.

SQLite v24 separates immutable authorization (`kernel_decisions`) from inbox lifecycle (`kernel_events`), application lifecycle (`kernel_decision_applications`), external effects (`kernel_effect_outbox`), attempt continuation metadata (`executor_attempt_runtime`) and work graph generations (`work_graph_revisions`). Issuance, application creation and source-event advancement are atomic. Runtime apply is idempotent by Decision ID and checks durable postconditions before mutating state.

Kernel contracts hard-upgrade to v2 and carry structured, bounded `KernelFailure` facts. Completion Protocol hard-upgrades to v2 and Work Graph/Planning to v5. Capacity remains separate from execution failure and never affects health history. Runtime and workflow engines may not perform hidden semantic retry.

Retry policy is deterministic: the preferred AgentClass gets at most one delayed continuation after a recoverable infrastructure failure; each fallback gets one attempt. Task/domain failure skips same-class retry. Exhaustion may authorize one automatic replan per user generation. Contract correction remains an isolated one-shot path.

AgentClass “circuit breaking” is a pure derived availability rule, not a new persisted state machine. Kernel interprets the bounded recent structured projection and explicit event time. Class-level permanent faults are skipped; three attributable transient failures in ten minutes cause a five-minute cooldown; the next eligible serial dispatch is the probe. Capacity and task-domain outcomes are excluded.

Recovery safety is canonical Routing Capability metadata: `read_only`, `workspace_reconcilable`, or `external_non_idempotent`. Native continuation is preferred, otherwise Runtime supplies a bounded recovery packet and workspace delta. Unknown non-idempotent external effects fail closed unless a stable provider idempotency key exists.

Replan creates a new graph revision within the same generation. Completed facts remain immutable task evidence, unfinished old nodes are cancelled, dependencies stay revision-local, and only the new revision provides the frontier. User plans and explicit recovery create generations; automatic revisions do not reset the one-replan quota.

External effects use an outbox. Unknown delivery without provider idempotency becomes `uncertain` and requires a Kernel-authorized Task recovery command; it is never blindly resent.

### Phase 5 amendment (2026-07-22)

Kernel contract v3 extends the same durable workflow with `permission_requested`, `permission_resolution_received`, `partition_conflict_observed` and `sandbox_lost`. Permission grants/denials/escalations, partition waits and workspace-attempt recovery are Decision actions, not Runtime policy. Runtime persists and checkpoints before pausing or destroying an attempt; duplicate request/event/apply identities reuse the prior Decision, grant, lease or outbox effect. Startup reconciles Docker labels with SQLite before accepting input and converts missing or leftover sandboxes into normalized events. ADR-0024 owns the detailed resource, workspace and elevation contracts.

### Executor error recovery amendment (2026-07-30)

Kernel wire/ledger contract v5 closes the availability-replan lifecycle. Planning and recovery refresh start concurrently; plan admission waits for refresh completion. If an Executor used by the proposal recovers, Planner may revise the proposal once in the same native Codex thread. A second availability change does not start an unbounded repair loop.

An existing Task whose replan has no usable eligible Executor is not rejected as if it were a new request. Kernel authorizes `defer_task_plan_for_availability`: the Task becomes `blocked` with a `kernel_availability` dependency, the generation replan request becomes `waiting_for_availability`, and the exact Planner proposal plus natural-language explanation are persisted. Initial requests in the same condition produce a Planner direct reply and do not create a Task.

Successful recovery emits a durable `executor_recovered` fact. Kernel revalidates the current Task, generation/revision, deferred proposal and current Executor projection. A stale, cancelled, or still-exhausted proposal is a `no_op`; an executable proposal authorizes `activate_deferred_task_plan`. Runtime activates that graph revision, resolves the replan request, removes the availability blocker and moves the Task to `ready`, without immediately dispatching or inserting a recovery notification into the conversation.

Recovery refresh is event-driven at session startup, each planning cycle, Task recovery/resume, Executor configuration changes and `/executor refresh [name|all]`. It never runs as a periodic background health loop.

### Reliability and explicit resume amendment (2026-08-24)

Dependency publication readiness is projected as a bounded Runtime fact rather
than inferred from an empty frontier. Pending publication produces a Kernel
`no_op` wait; missing handoff, Result Object, dependency workspace state or
identity alignment produces a structured materialization failure. Runtime never
allows a downstream Executor to read an upstream sandbox directly.

Explicit resume is a versioned `task_resume_requested` event. `ControlKernel`
validates the current Task, generation, Subtask statuses and blocker category,
then either returns `resume_task`, a dispatchable recovery action, or a
structured `no_op`/`block_work`. Runtime applies Task/Subtask restoration only
after that Decision. Unknown, manual, material and contract blockers are not
implicitly cleared.

Generic Provider connection failures such as `Connection error.`, `fetch
failed`, socket disconnects and connection resets normalize to retryable
`network` failures. Explicit Resume has one bounded compatibility rule for
receipts written before that normalization was complete: Runtime may inspect
only the latest immutable receipt's bounded safe `KernelFailure` summary and
re-run the current Adapter normalization. If and only if a persisted `unknown`
failure now unambiguously normalizes to `network`, Runtime submits
`task_resume_requested` with blocker category `retry`. The receipt and Decision
ledger remain immutable, the rule does not apply to permission, material,
contract or external-effect failures, and `ControlKernel` still decides whether
to authorize `resume_task`. Generic unknown failures remain fail-closed.

The released recovery implementation also contains one narrow legacy repair
rule. Older account startup bindings could throw
`Conversation execution callback is unavailable: onDecisionApplying` before an
`authorize_task_plan` application entered its state-changing branch. Startup
recovery and explicit Resume may convert only that exact uncertainty into a
deterministic `recovery_resolution_requested(retry)` event when the application
is a replan for the next graph revision, the generation identity matches, and
the corresponding generation replan request remains `submitted`.
`ControlKernel` must still authorize `resolve_recovery`; the original Decision
ID is replayed idempotently. This rule does not permit generic automatic replay
of uncertain applications or external effects.

### Explicit incomplete-response recovery amendment (2026-09-24)

The exact `Stream ended without finish_reason` adapter error uses the stable
`model_response_incomplete` code with conservative unknown-kind automatic recovery.
On explicit Resume only, Runtime can normalize the latest immutable failure
summary to the existing `retry` blocker category, including older unknown receipts.
This does not assert a network cause or certify any partial output. Material,
contract, orphan and external-effect blockers take precedence. Kernel retains
authorization and rejects retry of externally non-idempotent work; blocked nodes
contribute to the snapshot safety classification even when the runnable frontier
is empty. Receipts and prior decisions remain immutable.

Control-command acknowledgement reports authorization, not process start. Gateway
must retain a denied-resume explanation as the command result even if a previous
uncertified partial result is delivered in the same turn.

## LangGraph Boundary

LangGraph may replace only the durable workflow cursor/replay implementation after the MetaClaw contracts and fault tests freeze. The evaluation uses Functional API tasks and an independent SQLite checkpointer. Checkpoints are disposable implementation state: loss or corruption must be recoverable from the main database. LangGraph never owns Kernel policy, retry semantics, Work Graph topology, ledger authority, domain types or model/agent abstraction.

Adoption requires the full crash matrix, no domain-framework coupling, at least 30% net removal of cursor/replay implementation, checkpoint-loss recovery, and exactly one production workflow path. Failure of any gate requires deleting the spike and dependency.

### Planning v7 and schema v30 recovery amendment (2026-08-03)

SQLite schema v30 is the current baseline. The only supported upgrade is one
transactional 29→30 migration. It rebuilds active Subtasks with
`delivery_kind`, deterministically maps old output kinds, and upgrades every
still-recoverable v6 Planning/Work Graph payload in pending Kernel events,
unapplied decisions/applications, active dispatch, and unresolved deferred
replans. Terminal Kernel ledger entries remain immutable historical facts and
cannot re-enter current validation or execution. Any ambiguous recoverable
payload rolls back the whole migration and refuses startup; runtime has no v6
fallback reader.

The Phase 4 gated evaluation closed on 2026-07-21 without adoption. The replaceable drain/apply loop was materially smaller than the required MetaClaw inbox/application/outbox recovery layer, while Functional API integration would add a second SQLite cursor and replay glue. It could not produce the required 30% net removal. `DurableKernelWorkflow` is therefore the sole production workflow implementation and no LangGraph dependency or compatibility path is retained.

## Ownership And Dependencies

- Kernel owns pure decisions and may depend only on pure domain/routing/work-graph facts.
- Workflow is a deep Application module owning durable sequencing, recovery and handler orchestration, not policy.
- Runtime owns idempotent effects, attempt execution and normalized observations.
- Storage implements transactional repositories; tables do not define policy.
- Session, Gateway and commands only submit events, call startup recovery and project results.

## Consequences

Crashes no longer create an uninspectable ledger/apply gap, and repeated submission resumes the same application instead of duplicating authorization. Retry, fallback, replan, availability, permission, partition waiting and sandbox recovery are auditable Kernel actions. The hard schema cuts require coordinated migration and replacement of every manual issue/apply path. Phase 5 remains serial; multi-Task and concurrent-frontier scheduling remain Phase 6.

### Durable Replan Job and uncertain-application convergence amendment (2026-09-25)

The 2026-09-25 production failure was not a lost Kernel outcome. Two
`heartbeat_lost` attempts were durably landed, the `execution_outcome` events
were processed, and the chain stopped only because `request_replan` was applied
through the startup system binding, which required the originating foreground
Conversation Planner. The application became `uncertain` and the Task stayed
`running` with an occupied Conversation slot indefinitely.

The durable workflow therefore changes as follows.

**Durable Replan Job.** A new Kernel action `schedule_replan` replaces
`request_replan` at the generation-quiescence seam. Its only postcondition is
that the Replan Job (`generation_replan_requests`) is durably schedulable under
the Decision-derived quiescence token `quiescence_<decisionId>`, recorded as
`status = 'planning'` with no Planner claim yet. The Decision application is
`applied` immediately; the Runtime never performs a Planner call, so no Runtime
action requires a live TUI, Web connection, ConversationSession callback or user
input channel merely to record a durable intent. `request_replan` remains in the
ledger vocabulary for historical replay and is applied with the same durable
semantics.

**Planner Worker.** An account-scoped `GenerationReplanWorker` is the only
consumer of a scheduled Job. It claims the Job with a bounded Planner lease,
performs one Planner turn, inserts the `plan_proposed` event together with the
`submitted` transition, and drains the normal Kernel ingress. The claim is a
single conditional `UPDATE` and the Job id is deterministic, so a duplicate
recovery pass or a concurrent session/account pass cannot produce a second
Planner turn or a second graph revision.

**Bounded Planner unavailability.** A retryable transport or process failure
releases the claim with backoff; the Job keeps its identity. Past the absolute
retry budget the Job fails closed as `planner_unavailable`, which the Kernel
projects into an explicit `block_work` instead of leaving the Task `running`.
Planner semantic rejection remains a normalized Planner failure fact.

**Uncertain application convergence.** Every action family declares an explicit
postcondition. Startup and periodic recovery inspect it, mark the application
`applied` when present, retry the same Decision when the action is retry-safe,
and otherwise let the ControlKernel authorize a bounded retry or explicit
blocking:

```text
uncertain application -> applied -> retry_pending -> recovery_required/blocked
```

The replan postcondition is implemented as
`isSatisfiedReplanScheduling()` / `isRetrySafeUncertainReplanScheduling()` in
`src/execution/kernel-application-recovery.ts`. An uncertain application may
never remain permanently paired with `Task = running` and `Slot = occupied`.

## Amendment: Persisted External Routing Observations (2026-09-27)

A `plan_proposed` event may carry an optional, bounded `spanRouting` observation
produced by the Server-side Span advisor before the event was enqueued.

- The observation is part of the event body, so the existing `kernel_events`
  JSON and decision-ledger JSON persist, replay, and recover it without a new
  table or a second write authority.
- Recovery of a stored event and application retry reuse its observation and
  never invoke the external advisor. A recovery decision requiring a *new*
  replan uses the existing Planner and Span preparation paths with the pinned
  revision, through a temporary validation-only host without a connected
  client. A durable replan event skips both services.
- Explicit user cancellation cancels the generation request. Shutdown during
  external replan preparation raises `KernelApplicationInterruptedError` and
  leaves the application `applying` for restart recovery. It does not record
  user cancellation or an uncertain external execution effect. Merge-replan
  publication counters change only after preparation succeeds.
- `ControlKernel` treats the observation as untrusted input: it re-derives the
  eligible candidate set and ignores the scores unless event id, configuration
  revision, generation, graph revision, proposal fingerprint, Subtask, and
  candidate identity all still match. A mismatch degrades only that Subtask to
  the deterministic resolver.
- The window between an external request succeeding and the event being durably
  stored is explicitly not exactly-once. A crash there may repeat the request;
  this is accepted rather than introducing a background request state machine.
- Observations carry only internal refs, validated probabilities, a resolved
  model version, bounded usage, and a finite failure reason. Credentials, raw
  requests, and raw provider payloads are never persisted.
