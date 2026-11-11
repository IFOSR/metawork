# Task Execution And Feishu Delivery Reliability Implementation Plan

> **For implementation:** This document is a reviewable architecture and implementation plan. Do not start implementation until the user approves the design and the required ADR amendments.

**Goal:** Establish one task-scoped execution, event projection, result delivery, and recovery model so Feishu, Web, TUI, Kernel, Executor, and cloud-document delivery cannot disagree about which Task is running, what completed, where its artifacts are, or whether recovery should continue.

**Architecture:** Keep the existing `Planner -> ControlKernel -> Runtime -> normalized facts` control axis. Add an immutable Task/Turn execution context, task-scoped event correlation, a single result/artifact delivery plan, and an explicit bounded recovery state machine. Feishu becomes a passive projection adapter with a provider-capability state machine; it never infers Task identity from the latest Conversation activity and never reports a fallback send as an in-place update.

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite durable workflow, Gateway event journal/replay, Feishu Open API adapter, Vitest, native and Docker smoke paths.

---

**Implementation Status (2026-09-06):** Core incident path delivered. Feishu
card update contract, degraded create-only notification behavior, Task-scoped
live projection isolation, live artifact propagation, Workspace continuation
context propagation, bounded Workspace-context failure classification, and
background trace request correlation are implemented and covered by focused
tests. Web presentation behavior remains unchanged and has regression coverage.
The durable cross-restart delivery outbox and orthogonal public scheduling
status projection remain follow-up hardening items, not prerequisites for the
reported Feishu incident path.

## 1. Review Boundary

This plan addresses the following related failures as one reliability problem:

- Feishu activity-card updates repeatedly fail with `230001 invalid msg_type`.
- A new Task reuses the previous Task's activity card state and displays stale subtasks.
- Background trace events have insufficient request/task correlation and bypass current-request filtering.
- A completed Task has published Markdown artifacts, but the live Feishu final path does not deliver them as cloud documents.
- A new Task is actually dispatched, but the user sees the previous Task and cannot distinguish dispatch, execution, timeout, recovery, and delivery states.
- A continuation loses its Workspace path before the Executor starts.
- A preflight/context failure is treated as retryable infrastructure failure and creates an unbounded continuation loop.
- `blocked`, active retry scheduling, occupied Conversation slots, and terminal failure are represented in a way that is difficult to interpret.

This is not a proposal to add a second scheduler, a Feishu-specific retry policy, or another Task state machine in the Gateway. The existing ADR-0020 ownership direction remains authoritative.

The notification-budget portion of this plan is **Feishu-only**. The Web
surface is currently healthy and must retain its existing live trace, replay,
refresh, and rendering behavior. Shared changes to durable Task identity,
execution facts, result references, and event correlation are contract
hardening; they must be additive and must not alter Web presentation policy.

## 2. Design Principles

### 2.1 One authority per fact

- Planner owns semantic proposals.
- Work Graph owns graph structure and identity derivation.
- ControlKernel owns admission, dispatch, retry, fallback, block, replan, and recovery decisions.
- Execution Runtime owns side effects, context materialization, attempt lifecycle, and normalized facts.
- Result/Delivery owns immutable result references and external delivery effects.
- Gateway and Feishu only project durable facts and submit explicit commands.

No client surface may infer a Task from “the latest event”, mutable Conversation focus, or a shared in-memory tracker.

### 2.2 Task identity is not Conversation identity

Conversation is the user interaction container. Task is the durable execution unit. A single Conversation may produce sequential or queued Tasks, and one Task may continue after the originating command handler has returned.

Every execution and detailed projection must carry, or resolve from a durable immutable owner tuple:

```text
accountId
conversationId
workspaceId
turnId
requestId
taskId
generationId
graphRevision
subtaskId
attemptId
```

Fields that are not applicable remain explicitly `null`; they must not be silently replaced with the previous turn's values.

### 2.3 Optional fields must not hide required invariants

`workspacePath` is currently optional in a continuation request, which allowed a resolver to compute the correct path and then have the attempt call use the original request. The target contract must make the execution context explicit:

- A Kernel-authorized dispatch has a resolvable `workspaceId`.
- Runtime resolves the authorized Workspace binding before launching an attempt.
- Executor input receives a validated `ExecutionWorkspace`.
- There is no fallback from a missing task Workspace to the account `workspace-store`.
- A missing or invalid Workspace produces a structured preflight fact before process execution.

### 2.4 Delivery is a durable side effect, not a best-effort callback

Final text, Result Objects, local artifacts, Feishu file uploads, cloud-document imports, preview links, and progress-card updates have different reliability and idempotency properties. They must be represented separately and reconciled through one delivery plan. A final answer being visible does not imply that an artifact was delivered; an artifact failure must not erase a safe final answer.

### 2.5 Retry must have a proof of progress and a stop condition

Only failures explicitly classified as retryable may create a continuation timer. Every retry must have:

- a deterministic retry group;
- a persisted attempt ordinal;
- a bounded maximum;
- a next wake time;
- a reason and classification;
- an idempotent dispatch key;
- a terminal behavior when the budget is exhausted.

Preflight contract errors, missing identity, missing Workspace, and invalid dispatch payloads must not create an Executor attempt followed by an infinite infrastructure retry.

## 3. Target Runtime Model

### 3.1 Immutable `TaskExecutionContext`

Introduce a Runtime-owned value object, conceptually:

```text
TaskExecutionContext {
  accountId
  conversationId
  workspaceId
  workspaceBindingRevision
  turnId
  requestId
  taskId
  generationId
  graphRevision
  subtaskId
  attemptId
  attemptKind
  authorizedBinding
  bindingFingerprint
}
```

The exact TypeScript name may differ, but the boundary must be explicit and shared by:

- Kernel dispatch items;
- queued execution requests;
- attempt supervisor contexts;
- execution-progress events;
- Gateway trace projections;
- result/artifact delivery plans;
- recovery continuation records.

The context is created from durable Task/Conversation facts and Kernel authorization. It is not copied from an in-memory `currentSessionId` or the last callback that happened to be active.

### 3.2 Workspace preflight before attempt launch

Before an attempt is claimed as running or a child process is launched:

1. Resolve `workspaceId` to the current authorized binding.
2. Verify that the binding revision is compatible with the Task generation.
3. Verify canonical path availability and containment rules.
4. Materialize the attempt worktree and private runtime home separately.
5. Persist a bounded preflight result.
6. Only then claim the WorkUnit and launch the Executor.

The preflight result must distinguish:

| Class | Example | Kernel behavior |
| --- | --- | --- |
| `workspace_transient_unavailable` | Workspace temporarily unavailable | bounded retry if budget remains |
| `workspace_binding_missing` | Task points to a deleted/unknown Workspace | block for explicit repair/resume |
| `workspace_path_invalid` | Path fails containment or canonicalization | fail closed; no retry |
| `dispatch_context_invalid` | Missing task/generation/subtask identity | terminal infrastructure defect; alert, no timer loop |
| `executor_process_start_failed` | Valid context, process cannot start | existing structured retry/fallback policy |

The `workspace-store` path remains a storage location, never an execution fallback. The Executor port should receive a non-optional validated workspace object rather than a nullable string.

### 3.3 Normalized attempt outcomes

Every dispatch item must end in one of these durable paths:

- normal `ExecutionOutcome` with a terminal receipt;
- normalized `preflight_failure` fact with no child process;
- normalized process-start failure with a bounded receipt/fact;
- cancellation/stale outcome;
- startup reconciliation fact after a crash.

The `AttemptSupervisor` must not mark an attempt uncertain and then submit a generic failure event when Runtime can identify a deterministic preflight defect. “Uncertain” is reserved for genuinely ambiguous external state, not local validation failures.

## 4. Target Event and Projection Model

### 4.1 Correlation contract

Extend the internal/public-safe event contract so every detailed Task event has explicit correlation:

```text
eventId
sequence
conversationId
requestId
turnId
taskId
generationId
subtaskId
attemptId
kind
payload
```

`requestId` remains the command correlation. `turnId` identifies the semantic turn. `taskId` identifies the durable work. A background trace may have no active request handler, but it must still retain `turnId` and `taskId`.

The current `trace_delta` publication using `requestId = null` must be replaced by publication from the trace's immutable turn/task identity. The Feishu filter must not rely on `requestId` being active in an in-memory Set.

### 4.2 Projection selection rules

Every surface selects a projection by explicit scope:

- active turn: `(conversationId, turnId)`;
- active Task: `(conversationId, taskId)`;
- historical replay: Conversation journal plus requested turn/task filter;
- Workspace directory: bounded summary only.

No projection may use “last activity for this Conversation” as its Task identity.

### 4.3 One passive activity reducer

Keep `task-activity-tracker` pure, but make it a reducer over a declared `TaskActivityKey`:

```text
TaskActivityKey = {
  conversationId,
  turnId,
  taskId,
}
```

The reducer must reject or ignore events outside its key. On a new Task or terminal event, the owning presentation session is closed and cannot accept later events. A new Task creates a new reducer state even when the Feishu connection and Conversation are unchanged.

The current `liveAttachments` map should become a map of connection plus active turn/task projection, not a single long-lived tracker per connection.

### 4.4 Remove duplicate Feishu consumption paths

There are currently two materially different paths:

- `waitForTerminal()` for the current request;
- `ensureLiveAttachment()` for persistent/background activity.

They must share one `FeishuTaskProjection`/`FeishuDeliveryCoordinator` that:

1. consumes ordered Gateway events;
2. filters by explicit turn/task key;
3. updates the pure activity reducer;
4. emits progress, terminal, result, and artifact delivery intents;
5. deduplicates by `eventId` and projection version.

The current request path may await the coordinator's terminal promise, while persistent attachment mode may only subscribe to the same coordinator. It must not independently reconstruct Task identity or artifact lists.

This coordinator is a Feishu adapter concern. Web continues to consume its
existing Gateway projections and reducer. It should only receive additive
correlation fields and retain a regression test proving that its current
rendering and replay behavior are unchanged.

## 5. Feishu Card Delivery Architecture

### 5.1 Separate operation outcomes

The Feishu client adapter must return a typed provider result that distinguishes:

```text
in_place_update_succeeded
new_message_created
update_rejected
send_rejected
provider_transient_failure
provider_permanent_failure
```

The public `ok: boolean` shape is insufficient because a fallback create can succeed while the in-place update has failed.

Audit records must include:

- operation;
- card key;
- task/turn correlation;
- provider code/message;
- message ID if created;
- whether the final user-visible state is degraded;
- retryability and next action.

`ok=true` must never mean “some call did not throw”; it must identify which operation succeeded.

### 5.2 Card capability state machine

For each Feishu target/card key:

```text
uninitialized
  -> created
  -> updating
  -> updated
  -> degraded_create_only
  -> terminal
```

When the provider returns a deterministic contract error such as `invalid msg_type`:

1. Record the provider capability failure once per card/client capability epoch.
2. Stop retrying the known-invalid update shape.
3. Enter `degraded_create_only` or a provider-correct update mode.
4. Coalesce progress updates and respect a bounded fallback interval.
5. Continue to deliver the latest state without claiming in-place update success.

If the chosen API contract supports a corrected update shape, the adapter must encode that shape in one provider-specific method and lock it with a contract test. Callers must not assemble Feishu message update bodies.

### 5.3 Ordered, coalesced updates

Per card key, only one update may be in flight. Each update carries a monotonically increasing projection version/content hash. Older responses must not overwrite newer card state. Duplicate content is suppressed. Terminal receipts supersede pending progress updates.

The result is not “retry every repaint”; it is “one current card projection with controlled degradation”.

### 5.4 Progress and terminal separation

Progress cards and final result delivery should be separate conceptual slots:

- `progress-card:{conversationId}:{taskId}`;
- `final-result:{conversationId}:{turnId}`.

The progress card may be updated or replaced. The final result is delivered exactly once per terminal delivery plan and is not dependent on progress-card update support.

### 5.5 Feishu-only notification budget: silent activity with bounded liveness

Only Feishu delivery needs this policy because every newly sent Feishu message
is a user notification. The Web surface does not use this budget and must not
be throttled, converted to milestone-only updates, or moved to the Feishu
fallback behavior.

Feishu should not turn every Executor event into a new message, but it also
must not leave the user without any indication that a long-running Task is
alive.

Use three notification tiers:

| Tier | Trigger | User-visible action | Default policy |
| --- | --- | --- | --- |
| `silent_state` | ordinary step progress, tool start/completion, heartbeat, repeated status | update the existing progress card only | never create a new chat message |
| `milestone` | Task accepted, Executor actually started, Subtask changed, result observed, publication completed, recovery started, artifact delivery state changed | one short chat message or one card update | deduplicated by milestone key |
| `terminal` | completed, failed, permanently blocked, cancelled, delivery exhausted | final result/receipt message | always deliver once |

The notification policy should be implemented above the Feishu API adapter as a
pure `FeishuNotificationPolicy`. The adapter only executes the selected
operation; it does not decide whether a progress event is important enough to
notify the user. This policy must not be shared with Web.

#### Silence budget

Each active Task has a notification lease with:

```text
lastUserNotificationAt
lastProgressCardProjectionAt
lastActivityAt
lastMilestoneKey
```

The policy uses two independent timers:

- `progressCardInterval`: how often the current state may be projected;
- `maxUserSilence`: the maximum time an active Task may go without a user-visible liveness signal.

The recommended initial defaults are:

```text
progressCardInterval = 30 seconds
maxUserSilence = 5 minutes
milestoneSuppressionWindow = 2 minutes
```

These are Feishu delivery-policy defaults, not Feishu API constants. They
should be exposed as Feishu/account delivery settings only after the behavior
is validated. They must not become global Gateway or Web refresh settings.

The policy behaves as follows:

1. Ordinary activity only refreshes the in-memory/durable projection and
   coalesces the latest card content.
2. A card update is attempted at most once per `progressCardInterval`; duplicate
   content is discarded.
3. A milestone can bypass the normal interval only when it is not a duplicate
   and is outside its suppression window.
4. If the Task remains active and no milestone has been sent for
   `maxUserSilence`, emit one bounded liveness notice such as:

   ```text
   ⏱ 任务仍在执行：已完成 146 步，最近活动在 18 秒前。当前阶段：检索并整理隔夜重要新闻。
   ```

5. A liveness notice starts a new silence window. Continuous heartbeats do not
   generate continuous messages.
6. A terminal event always supersedes a pending liveness notice and delivers the
   final receipt/result.

#### When in-place card updates are unavailable

If Feishu rejects card updates with a deterministic contract error, the system
must not replace every silent card update with a new notification. It enters
`degraded_create_only` mode and changes the policy:

- suppress ordinary `silent_state` new messages;
- send at most one “任务仍在执行” liveness message per `maxUserSilence`;
- send milestone messages only for high-value state changes;
- send terminal result exactly once;
- include the latest compact state in each liveness/milestone message so the
  user does not need to find the previous card;
- record that the progress card is degraded, so operators can distinguish
  “no message because progress is coalesced” from “delivery is broken”.

This creates a deliberate Feishu-only fallback hierarchy:

```text
in-place card update
    -> if unsupported: bounded liveness/milestone messages
    -> terminal result always delivered
    -> if terminal delivery fails: durable delivery retry/outbox
```

The fallback interval must be enforced per `(conversationId, taskId)`, not
globally and not only per Feishu connection. A new Task therefore gets its own
notification budget, while an old Task cannot consume the new Task's silence
window.

#### Notification content rules

Progress notifications must be short and state-oriented:

- current Task title or short label;
- lifecycle state;
- current Subtask/phase;
- latest activity age;
- bounded step count or progress summary;
- recovery/delivery warning when applicable.

They must not include raw Executor output, repeated tool traces, hidden
reasoning, or the full report body. The full result belongs to the terminal
delivery path. These rules apply to Feishu notifications only; Web retains its
existing detailed trace and result presentation.

## 6. Result, Artifact, and Cloud-Document Delivery

### 6.1 Build one `ResultDeliveryPlan`

At terminal Task/Result projection time, build a plan from durable facts:

```text
ResultDeliveryPlan {
  accountId
  conversationId
  turnId
  taskId
  resultReferences
  artifactReferences
  textResultReference
  target: Feishu chat/thread
  deliveryPreferences
  certification/completeness
}
```

The plan must be identical whether the terminal event was received by `waitForTerminal()`, a persistent live attachment, replay after reconnect, or startup recovery.

### 6.2 Artifact delivery is independent but linked

The final text can be delivered while cloud-document import is pending or failed. The user-facing final delivery should explicitly distinguish:

- result delivered;
- artifact available locally;
- Feishu cloud document delivered;
- cloud-document delivery pending/failed.

A missing cloud document must never be silently represented as a successful final result.

### 6.3 Durable external delivery record

Add a durable delivery effect/outbox record keyed by:

```text
accountId + target + taskId + artifactId + contentHash + deliveryMode
```

States:

```text
pending -> running -> delivered
                    -> failed_retryable
                    -> failed_permanent
                    -> uncertain
```

The import operation must use artifact identity/content hash for idempotency. Replay, reconnect, process restart, and duplicate final events must reuse the existing record instead of importing the same document repeatedly.

### 6.4 Unified artifact sourcing

The coordinator must obtain artifacts from the authoritative Task artifact repository or Result Object references. It must not infer artifacts from the activity tracker. The live `final_answer` path must use exactly the same `taskArtifactsFor(taskId)`/ResultReference projection as the ordinary terminal path, then pass the resulting plan to `deliverRegisteredArtifactsToFeishu()`.

### 6.5 Delivery failure visibility

Delivery failures should emit a structured `delivery_status` event and a bounded Feishu notice. A failed cloud-doc import may expose a retry action, but retrying delivery must not re-run the Executor or reopen the Task unless explicitly authorized by a separate command.

## 7. Recovery and Retry Convergence

### 7.1 Separate lifecycle status from scheduling status

The current combination of `tasks.status = blocked`, a running schedule entry, and an occupied slot is technically explainable but operationally ambiguous. Introduce orthogonal projections:

```text
Task lifecycle: running | blocked | parked | done | failed | cancelled
Scheduling state: idle | queued | dispatching | retry_wait | recovering | terminal
Blocker: none | kernel_retry | workspace | capacity | permission | material | contract | external_effect | manual
```

The public status projection must show both when relevant, for example:

```text
已阻塞 · 等待恢复（第 1/1 次重试，预计 09:12）
```

or:

```text
已阻塞 · Workspace 不可用，需要修复后手动恢复
```

### 7.2 Retry policy is durable and bounded

Each retry chain records:

- `retryGroupId`;
- source attempt;
- failure classification;
- eligible AgentClass/binding;
- retry count and max count;
- backoff schedule;
- policy/configuration revision;
- terminal reason when exhausted.

A due timer must be unique by retry group and source decision. A timer tick that finds a non-retryable or already-settled chain becomes an idempotent `no_op` and cannot create another timer.

The preferred-binding retry rule remains bounded. The important change is that a failed preflight/context validation cannot enter that rule unless its normalized failure explicitly says the dependency is transient and retryable.

### 7.3 Preflight failures never become generic uncertain attempts

For the specific current failure:

```text
resolve workspace
-> missing/invalid
-> persist preflight_failure
-> Kernel decides block/manual or bounded transient retry
-> no Executor process
-> no generic uncertain receipt
-> no infinite continuation
```

The local variable/original request mismatch is fixed as part of removing nullable `workspacePath` from the attempt boundary, not as a one-line variable substitution.

### 7.4 Timeout semantics and diagnostics

The Executor adapter should distinguish:

- no process output;
- stdout/stderr output but no structured progress;
- provider/model wait;
- child process heartbeat;
- process exit;
- local watchdog termination.

The normalized timeout fact should contain bounded diagnostics:

```text
terminationSource
startedAt
lastOutputAt
lastHeartbeatAt
stdoutBytes
stderrBytes
lastProgressKind
provider/model/executor identity
```

The user-facing projection should say “Executor 空闲超时，已停止当前尝试，正在按策略恢复” only while recovery is actually scheduled. If the retry budget is exhausted, it must say that explicitly rather than showing an indefinitely active card.

## 8. Observability and Operator Diagnostics

Add one correlation view spanning:

```text
user command
-> Planner turn
-> accepted proposal
-> Task/generation/revision
-> Kernel decision
-> dispatch item
-> attempt/preflight
-> Executor process
-> receipt/result/artifact
-> publication
-> Gateway event
-> Feishu operation/cloud document
```

Every stage should be queryable by `taskId`, with `turnId` and `requestId` as secondary keys.

Required counters and alerts:

- card update contract failures by provider code;
- card degraded-create-only mode;
- duplicate/stale projection events ignored;
- events missing Task/turn correlation;
- preflight failures by category;
- retry chains created/exhausted;
- timers created per retry group;
- tasks with `blocked + retry_wait` beyond a threshold;
- artifact delivery pending/failed/uncertain;
- cloud-document imports deduplicated/succeeded/failed;
- Executor idle timeout with termination diagnostics.

Add an operator-facing Task diagnostic that shows lifecycle state, scheduling state, blocker, latest authoritative event, retry group, and delivery statuses. This prevents “没有调度” from being inferred from a stale card.

## 9. Implementation Sequence

This sequence is deliberately contract-first. Each phase must land focused tests before broad integration work.

### Phase 0: Freeze and record contracts

**Scope**

- Confirm the current schema/protocol baselines and affected ADRs.
- Add a design ADR amendment for Task/Turn correlation and delivery/recovery ownership.
- Define the `TaskExecutionContext`, preflight result, retry record, delivery plan, and Feishu provider result contracts.

**Exit gate**

- No new code depends on the current nullable `workspacePath` as an implicit execution contract.
- The review-approved state model and migration strategy are documented.

### Phase 1: Execution context and Workspace preflight

**Scope**

- Add durable owner/context fields to dispatch and continuation materialization where absent.
- Resolve Workspace from immutable `workspaceId` and binding revision.
- Move Workspace validation before Executor process launch.
- Remove the `workspace-store` execution fallback.
- Normalize preflight failures.
- Ensure all launch paths, including startup recovery and timer continuation, use the same context builder.

**Tests**

- Resolver result reaches the actual Executor input.
- Missing Workspace produces no child process and no uncertain attempt.
- Invalid context produces a terminal/blocked decision rather than a timer.
- Valid continuation after timeout uses the same authorized Workspace.
- Native and Docker backend paths receive separate worktree/runtime-home paths.

### Phase 2: Bounded Kernel recovery state machine

**Scope**

- Persist retry-group identity, count, max, due time, and terminal reason.
- Separate retry-wait scheduling from generic blocked presentation.
- Make timer creation idempotent.
- Classify preflight, process-start, timeout, network, contract, and task-domain failures explicitly.
- Add convergence tests for repeated continuation failures and restart recovery.

**Tests**

- One preferred retry only where policy allows.
- No retry for missing/invalid Workspace context.
- Retry exhaustion reaches a stable terminal/block state.
- Duplicate timer ticks do not create duplicate dispatch.
- Startup recovery does not revive settled retry chains.

### Phase 3: Gateway event correlation and projection isolation

**Scope**

- Carry `turnId/taskId` through trace publication.
- Remove request-activity membership as the primary event filter.
- Key activity reducers by Conversation/Turn/Task.
- Close reducers at terminal events.
- Make replay and live delivery use the same task-scoped projection reducer.

**Tests**

- Two sequential Tasks in one Conversation never share `currentSubtask`, `currentStep`, `recentSteps`, or step count.
- Background trace with no active request still routes to the correct Task.
- Foreign Task events are ignored by an active Feishu projection.
- Reconnect/replay rebuilds the correct Task projection without stale state.
- Origin-scoped delivery remains compatible with ADR-0036.

### Phase 4: Unified result and artifact delivery

**Scope**

- Consolidate current-request and persistent-attachment terminal handling.
- Build one `ResultDeliveryPlan` from durable result/artifact facts.
- Add durable delivery-effect/outbox records.
- Make cloud-document import idempotent by artifact identity/content hash.
- Emit explicit delivery status and preserve safe text results when artifact delivery fails.

**Tests**

- A completed Markdown artifact is delivered as a Feishu cloud document from both live and replay paths.
- Duplicate final events do not create duplicate cloud documents.
- Cloud-document failure does not rerun the Executor.
- Partial/uncertified result remains deliverable with explicit status.
- Restart resumes pending artifact delivery.

### Phase 5: Feishu adapter and card state machine

**Scope**

- Correct and isolate the provider-specific update request contract.
- Add a regression test for the exact `invalid msg_type` request shape.
- Replace boolean delivery results with operation-specific outcomes.
- Add one-time capability degradation and ordered/coalesced card updates.
- Separate progress-card lifecycle from final-result delivery.
- Add the pure Feishu notification policy with silent-state, milestone,
  terminal, and max-silence behavior.
- Keep Web rendering, refresh, replay, and live trace behavior unchanged;
  add a regression gate rather than applying Feishu notification budgets to Web.

**Tests**

- A deterministic invalid-update response does not repeat on every repaint.
- Fallback creation is recorded as fallback creation, not update success.
- Older in-flight update responses cannot overwrite newer state.
- Terminal receipt is delivered even when progress-card update is unsupported.
- Audit records identify provider code, Task, turn, card key, and actual operation.
- Ordinary Executor progress does not create new Feishu messages.
- High-value milestones bypass the ordinary progress interval only once.
- A long-running silent Task receives one bounded liveness notice within the
  configured `maxUserSilence` window.
- Continuous heartbeats do not create notification floods.
- The liveness budget is isolated per Task and resets for a new Task.

### Phase 6: End-to-end reliability gates

**Scenarios**

1. News Task completes, produces `隔夜要闻简报_2026-09-06.md`, and Feishu receives both final text and one cloud-document link.
2. A subsequent quant Task in the same Conversation displays only quant Task activity.
3. The quant Task is visibly dispatched, then either completes or shows an authoritative timeout/recovery state.
4. A continuation uses the same Workspace and does not fall back to `workspace-store`.
5. An induced invalid Feishu card-update contract error produces bounded degradation, no error flood, and correct final delivery.
6. An induced missing Workspace produces a stable blocker and no one-minute retry loop.
7. Process restart during pending retry and pending cloud-document import converges idempotently.
8. Two different Conversations retain isolated Task traces and can execute concurrently under ADR-0037.
9. A long-running Task with frequent internal progress produces no more than the
   configured milestone/liveness notifications while still sending a bounded
   “仍在执行” signal during extended silence.
10. Existing Web live trace, refresh, replay, and terminal rendering tests
    remain unchanged and pass without applying Feishu notification throttling.

## 10. Migration and Compatibility

This should be a hard contract migration within the current release line, not a permanent dual path.

Required migration work:

- Add a schema revision for retry groups, delivery effects, and any new context/correlation fields.
- Backfill active recoverable dispatch items from durable Task/Conversation/Workspace ownership.
- Mark ambiguous recoverable items as manual recovery required; do not guess the Workspace or Task.
- Convert existing pending artifact deliveries into idempotent delivery records.
- Preserve terminal Kernel ledger and receipt history as immutable audit facts.
- Treat old in-memory Feishu card slots as disposable; on restart, rebuild from durable terminal/progress facts.
- Remove or hard-disable the old “nullable Workspace path plus fallback root” path after migration.

No migration should silently re-run an Executor. A migration that cannot prove identity or Workspace ownership must fail closed with an operator-readable diagnostic.

## 11. ADR and Documentation Changes

After review, update or amend:

- ADR-0023 for preflight failure classification, bounded retry groups, and recovery convergence.
- ADR-0031/ADR-0036 for the explicit Task/Turn correlation contract and passive projection rules.
- ADR-0032 for result/artifact delivery plans and durable external delivery effects.
- ADR-0037 for the immutable Task execution owner tuple and Conversation slot/recovery semantics.
- `CONTEXT.md` for the new execution-context and delivery invariants.
- `docs/current/technical-overview.md` and the Feishu operations section for delivery status, card degradation, and diagnostics.

The implementation plan should be split into focused commits by contract boundary, not by individual observed symptom.

## 12. Rejected Approaches

### Patch only the Feishu request body

This would stop one API error but leave stale Task state, missing artifact delivery, and false audit success intact.

### Reset the tracker whenever a new message arrives

This still allows background events from an older Task to repopulate the tracker and does not solve missing event correlation.

### Add `artifacts` only to the live `final_answer` branch

This would duplicate delivery logic and leave replay/restart/idempotency behavior inconsistent.

### Pass the resolved Workspace path through one extra argument

That fixes the observed line but leaves nullable context, fallback execution roots, and other launch/recovery paths vulnerable to the same class of defect.

### Increase the retry limit or backoff

This makes a deterministic preflight defect noisier and delays convergence. Retryability must be classified before a timer is created.

### Let Feishu decide whether a Task is still active

Feishu is a projection adapter. It cannot be the authority for Task lifecycle, retry, or completion.

## 13. Review Questions

The following decisions should be confirmed before implementation:

1. Approve the orthogonal `lifecycle status + scheduling state + blocker` projection, rather than continuing to overload `blocked`.
2. Approve a hard requirement that every Executor attempt receives a validated `ExecutionWorkspace`; no nullable `workspacePath` fallback remains.
3. Approve durable delivery-effect records for Feishu cloud-document imports and card/final delivery deduplication.
4. Approve consolidating `waitForTerminal()` and `ensureLiveAttachment()` behind one Task-scoped Feishu projection coordinator.
5. Approve the policy that deterministic provider contract errors disable the invalid card-update mode for the current capability epoch instead of retrying every repaint.
6. Approve the Feishu-only notification budget defaults: 30-second card projection interval, 5-minute maximum user silence, and 2-minute milestone suppression window, subject to later Feishu/account delivery configuration. Web is explicitly excluded.
7. Confirm the desired retry budget for Executor idle timeout and transient Workspace unavailability. The design requires a finite value; the exact value should be configuration/policy, not hard-coded in Feishu.
8. Confirm whether cloud-document delivery failure should expose a user action such as “重试交付”, or only be retried by the durable delivery worker.
9. Confirm whether the first implementation should add a management/doctor view for correlation diagnostics, or whether structured logs and Task detail are sufficient for the initial release.

## 14. Acceptance Definition

The work is complete only when the following are all true:

- A Task's progress card never displays another Task's subtask or step.
- A background trace without an active request still has enough identity to reach the correct Task projection.
- A completed artifact reaches the same Feishu cloud-document delivery path regardless of whether completion was observed live, through replay, or after restart.
- Feishu card update failure is bounded, accurately audited, and cannot flood logs or duplicate progress cards.
- A valid Workspace continuation launches against the authorized Workspace.
- An invalid/missing Workspace never launches against `workspace-store`.
- Every retry chain converges to success, bounded retry exhaustion, or an explicit manual blocker.
- User-visible status distinguishes “queued”, “running”, “waiting for retry”, “blocked”, “failed”, “artifact delivery pending”, and “artifact delivery failed”.
- The end-to-end tests cover the exact sequence reported by the user: completed news Task, new quant Task, stale-card isolation, timeout/recovery, and cloud-document delivery.
