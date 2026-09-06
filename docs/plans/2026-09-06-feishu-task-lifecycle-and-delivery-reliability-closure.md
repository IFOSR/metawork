# Feishu Task Lifecycle And Delivery Reliability Closure

- **Status**: Delivered 2026-09-06 (Phases B/C/D closure; see §10 below). Validation:
  211 test files — 210 green (execution, storage, kernel, gateway, integrations,
  management, web, planning, session), lint clean; the single remaining failure is
  the pre-existing scripted-session safe-uncertified case from the in-progress
  result-first redesign (identical signature before this closure work began).
- **Plan date**: 2026-09-06
- **Scope**: Feishu-only task lifecycle, cancellation recovery, new-task admission, image attachment continuity, progress-card delivery, and artifact/cloud-document delivery
- **Web scope**: No Web behavior change. Web remains the regression baseline and must continue to use the existing Gateway trace and delivery projection.
- **Current state**: Investigation complete; implementation not started

## 1. Executive Summary

The recent failures are not one independent Feishu bug. They expose an
incomplete closure between five existing subsystems:

```text
Feishu ingress
  -> Conversation command admission
  -> Planner clarification/proposal
  -> Kernel decision/application
  -> Task slot and scheduler state
  -> Executor/result/artifact delivery
  -> Feishu card, message, image and cloud-document presentation
```

Several previous plans correctly implemented individual pieces, including
durable Kernel applications, explicit resume, result-first delivery, passive
Feishu progress projection, and attachment resolution in the generic Gateway.
The current failure shows that the cross-boundary invariants are not yet
enforced in production:

- a cancellation decision can remain `uncertain` while the Task slot and
  schedule entry still claim the old Task is active;
- a same-topic request is clarified as a conflict before a new Task is
  authorized, even when the user intends to abandon the old Task;
- Feishu card update failures are not governed by one stable adapter state
  machine and the observed request/API contract is inconsistent with the
  current test contract;
- a Feishu image can be downloaded as a pending path without becoming a
  message-scoped Planner attachment;
- a safe result can reach the Feishu card without the artifact/cloud-document
  delivery path reaching a terminal, auditable outcome.

The solution is therefore a reliability-closure project, not a collection of
local fallbacks. The implementation must make each boundary durable,
idempotent, observable, and testable.

## 2. Confirmed Runtime Findings

The following facts were confirmed from the active account database and
runtime audit for the current service instance.

### 2.1 Old Task was not actually cleared

The old Task titled **评估量化策略效果与适用市场** remains:

```text
tasks.status                    = blocked
conversation_task_slots.state   = occupied
active_task_id                  = old Task
task_schedule_entries.state     = running
```

`/task clear all` was received on **2026-09-06 14:57:15** and reached Kernel.
Kernel authorized `cancel_task` with the reason
`durable Task cancellation fence authorized`.

The application failed at the durable dispatch-item layer:

```text
UNIQUE constraint failed:
kernel_dispatch_items.task_id,
kernel_dispatch_items.generation_id,
kernel_dispatch_items.subtask_id
```

The application was recorded as `uncertain`, so the cancellation transaction
did not complete and no reliable postcondition was published to release the
Task slot, schedule entry, or active Task pointer.

### 2.2 The new request did not create a new Task

The request at **2026-09-06 14:58:26** was accepted by Planner, but its result
was `clarification_requested`. It produced no new Task ID, no
`authorize_task_plan`, and no new dispatch item.

The system therefore did not fail after scheduling. It stopped before Task
creation:

```text
old blocked Task remains
  -> new request is classified as same-topic conflict
  -> Planner asks whether to resume or abandon/create
  -> no authorization is emitted
  -> no scheduler dispatch is possible
```

### 2.3 The screenshot is not proven to have reached Planner

The Planner input for that turn contains the report URL and text question,
but no image bytes, attachment reference, downloaded image path, or image
context record.

The current Feishu event normalizer creates `attachments: []` by default.
The separate resource handler downloads image/file messages and appends paths
to a chat-level pending list for a later text message. This does not guarantee
that the image is bound to the exact message, turn, Conversation, or Planner
input that follows.

The highest-confidence conclusion is that the screenshot was not consumed by
the Planner task chain. The current audit does not distinguish whether it was
dropped during event normalization, resource download correlation, or command
construction; that distinction must be added before implementation is
considered complete.

### 2.4 Feishu card update contract is not closed

The observed Feishu error is repeated:

```text
230001 Your request contains an invalid request parameter, ext=invalid msg_type
```

The current `updateMarkdownCard` implementation sends a PUT body containing
the card `content` but no `msg_type`, while the existing unit test explicitly
asserts that `msg_type` is absent. The production error indicates that the
actual API request contract, endpoint, or request path is not aligned with
that assumption.

This must be verified with the exact request method, URL, headers, body, and
response before changing the adapter. The plan must not blindly add or remove
`msg_type` based only on the error text.

### 2.5 Result and cloud-document delivery are separate outcomes

The news task produced user-visible content in a Feishu information card, but
the expected Feishu cloud-document presentation was not observed. This means
at least one of the following boundaries is not closed:

- task artifact registration;
- final-result-to-artifact association;
- Feishu artifact delivery invocation;
- cloud-space upload/import polling;
- document link publication;
- fallback file delivery;
- delivery completion audit.

The result card must not be treated as proof that cloud-document delivery
completed.

## 3. Why Previous Fixes Did Not Fully Solve It

The previous work was directionally correct but was validated mostly at
feature or module level. The remaining gap is cross-module state convergence.

### 3.1 Durable application support is not the same as cancellation convergence

The runtime already has an `uncertain` application state and startup recovery
concept. That protects against blindly repeating arbitrary effects, but it
does not yet guarantee that a cancellation whose safe postconditions are
partially known will converge to one of:

```text
cancelled and released
or
explicitly unresolved and admission-blocking
```

The unique-constraint failure shows that the cancellation path can still
attempt an insert into a structure whose identity already exists. The
operation is not fully idempotent at the dispatch-item repository boundary.

### 3.2 Conflict clarification has no complete “abandon then create” transaction

The Planner correctly avoids silently resuming, clearing, or repurposing an
existing Task. However, the current conflict path only asks the user to choose
between old-task recovery and new-task creation. It does not provide a durable
current-turn control resolution that:

1. authorizes abandonment of the exact old Task;
2. waits for cancellation postconditions;
3. creates the new Task only after the Conversation slot is free;
4. reports the exact state if cancellation remains uncertain.

The safety rule is present; the user-intent completion path is missing.

### 3.3 Feishu progress governance is split across multiple layers

The activity tracker, session port, integration adapter, and final-reply path
each contain part of the notification policy. A local test can prove that
ordinary progress is throttled, while production can still produce repeated
failure notices if card slots, delivery listeners, request lifetimes, or
fallback paths do not share one state machine.

The intended Feishu compromise remains:

- ordinary progress is coalesced into one activity card;
- card updates are throttled;
- blockers, recovery, completion, and artifact outcomes are immediate;
- a broken update path does not create a notification flood;
- the user still receives a liveness signal while the Task is active.

This policy must be owned by one Feishu delivery state machine.

### 3.4 Attachment support exists in the generic Gateway but is incomplete at Feishu ingress

The Gateway has a Planner image resolver for explicit attachment references.
The Feishu adapter currently routes normal text with an empty attachment list,
while resource messages use a separate pending-path mechanism. These are two
attachment models that are not joined by a durable message-level identity.

Consequently, “the file was downloaded” does not imply “the Planner received
the file as input”.

### 3.5 Result-first delivery does not imply cloud-document delivery

Result-first semantics correctly allow safe text to reach the user even when
completion metadata is incomplete. Feishu cloud-document publication is a
separate external delivery effect. It requires its own idempotency key,
outcome state, retry/recovery rules, and user-visible completion status.

## 4. Target Invariants

The implementation must establish these invariants before accepting the
behavior as fixed.

### 4.1 Task lifecycle invariants

- A Task cannot remain `blocked` while its Conversation slot is occupied and
  its schedule entry is `running` without an explicit recoverable reason.
- A cancellation is complete only after Task status, active Task pointer,
  Conversation slot, schedule entry, dispatch items, leases, and attempts have
  converged to compatible terminal states.
- `uncertain` is not a hidden retry queue. It is a durable recovery state with
  a deterministic reconciliation path and user-visible diagnostic.
- Replaying the same cancellation identity never inserts a duplicate dispatch
  item or creates a second cancellation effect.
- New same-Conversation work is admitted only after the old Task is released,
  or is explicitly held with a reason that names the unresolved cancellation.

### 4.2 New-task intent invariants

- The user can explicitly choose **abandon old Task and create new Task**.
- The choice applies only to the identified old Task and current Conversation.
- The new Task is not created before cancellation authorization and required
  postconditions are durable.
- If cancellation is uncertain, the system returns a clear “new Task held”
  result instead of silently reusing the old Task or pretending to schedule.
- A clarification response is not reported as task creation or execution.

### 4.3 Feishu progress invariants

- Web behavior is unchanged.
- One active Feishu Task/run has at most one ordinary activity card per
  `conversationId + taskId + generationId` delivery scope.
- Card repaint is throttled to a bounded interval, currently five seconds by
  default, with no user chat message for ordinary progress.
- A card-update failure produces at most one diagnostic per delivery scope and
  moves the scope into a durable-in-memory `create_only` degradation mode.
- Degraded mode may create a replacement card only under a cooldown; it must
  never create one message per progress event.
- Blocked, recovery, terminal, and artifact milestones are delivered
  immediately as appropriate, but duplicate event keys are suppressed.
- The final response explicitly states whether a cloud document, file fallback,
  or no artifact delivery was completed.

### 4.4 Attachment invariants

- Every Feishu image/file is bound to a message ID and Conversation route,
  not only to a chat ID.
- A message containing text and an image carries both in one Gateway command.
- An image-only message is retained as a pending attachment with a bounded
  TTL and is associated with the next compatible text message only when the
  correlation rule matches.
- The final `GatewayCommand` contains attachment references that the Gateway
  attachment store can resolve.
- Planner receives image bytes through the existing bounded image bridge, or a
  deterministic user-visible error if resolution fails.
- No attachment is silently discarded.

### 4.5 Artifact delivery invariants

- Business result delivery and Feishu cloud-document publication are separate
  durable effects.
- Each artifact has an idempotency key based on Task, artifact identity and
  delivery target.
- Upload, import polling, link sharing, and fallback file delivery each have
  bounded states and audit records.
- A cloud-document failure cannot hide a safe business result.
- A successful card response cannot claim cloud-document completion unless the
  document/link effect has reached a terminal success state.

## 5. Systematic Solution

### 5.1 Introduce a Feishu delivery state machine

Create one Feishu-only delivery coordinator around activity cards, milestone
messages, final result delivery, and artifact delivery. It should consume the
existing passive Gateway trace and never create a Planner turn.

The coordinator owns:

```text
idle
  -> card_created
  -> card_update_throttled
  -> card_update_failed
  -> create_only_degraded
  -> terminal_painted
  -> archived
```

Required behavior:

1. Key the activity card by `conversationId + taskId + generationId`, not by
   an unstable request-only lifetime.
2. Serialize send/update operations per card key.
3. Suppress duplicate event keys and duplicate failure notices.
4. Use one update cooldown and one replacement-card cooldown.
5. Treat terminal and blocker milestones as immediate, while normal progress
   only updates the card.
6. Preserve the last known activity snapshot so a replacement card shows
   current state instead of starting from an empty card.
7. Emit a delivery audit record for created, updated, degraded, replaced,
   terminal, and failed outcomes.

This is the Feishu-specific implementation of the agreed compromise: no
notification flood, but no silent long-running Task.

### 5.2 Close the Feishu card API contract

Before changing behavior, capture and test the exact request contract for
interactive-card update:

- HTTP method;
- endpoint;
- path parameters;
- required headers;
- JSON body;
- whether `msg_type` is required, forbidden, or endpoint-specific;
- response code and body;
- behavior for an expired/deleted message;
- behavior for thread versus chat message IDs.

Then replace the current assumption-based test with a contract test that
matches the verified Feishu API. The adapter should expose a typed operation
such as `updateInteractiveCard`, rather than letting generic markdown-card
construction determine the update payload.

The adapter must distinguish:

```text
invalid request contract
message not found/expired
permission failure
rate limit/transient network failure
unknown provider failure
```

Only message-not-found and contract-incompatible responses should enter
create-only degradation immediately. Transient failures may retry once within
the adapter's bounded operation policy, but must still respect the card
cooldown and never flood the user.

### 5.3 Make cancellation application idempotent and convergent

The cancellation path must be redesigned around postconditions, not around
blind inserts.

Implementation sequence:

1. Define a stable cancellation operation identity from Task, generation,
   cancellation decision, and target scope.
2. Make every dispatch-item cancellation/upsert operation conflict-safe:
   existing rows are reconciled against the same operation identity instead of
   inserted again.
3. Apply cancellation, dispatch cleanup, lease release, schedule closure,
   Conversation slot release, and active Task pointer clearing in one
   transaction where possible.
4. If an external process prevents one phase from completing, persist the
   exact phase and required postcondition instead of returning a generic
   `uncertain`.
5. Add startup and pre-admission reconciliation that evaluates the durable
   postconditions:
   - if all cancellation effects already exist, mark the application applied;
   - if safe effects are missing, replay the same cancellation identity;
   - if state is contradictory, keep admission closed and emit an actionable
     diagnostic.
6. Reconcile old `blocked + occupied + running schedule` combinations before
   Planner conflict classification.
7. Expose `/task clear all` result semantics as:
   `cleared`, `already cleared`, `recovery in progress`, or `clear blocked`.

No database cleanup shortcut should be used as the normal fix. Manual
administrative repair may be provided separately, but the runtime must be able
to converge future cancellations without direct SQL intervention.

### 5.4 Add explicit abandon-and-create control semantics

The Planner and Kernel need a first-class current-turn resolution rather than a
free-form clarification that has no executable follow-up.

Recommended contract:

```text
task_conflict_resolution:
  action: abandon_old_and_create_new
  oldTaskId: exact durable Task identity
  newPlan: current accepted work proposal
  idempotencyKey: current turn identity
```

The Kernel authorizes the old-task cancellation first. Runtime then emits a
durable release fact. Only after the release fact is applied does the same
workflow authorize and create the new Task. If the old cancellation is
uncertain, the new plan remains held and the user receives the unresolved
phase.

The semantic rule remains fail-closed: no implicit cancellation based only on
topic similarity. Explicit user intent and exact Task identity are required.

### 5.5 Replace chat-level pending resources with message-scoped attachment flow

Feishu resource processing should become:

```text
resource event
  -> validate message/thread/chat identity
  -> download to attachment store
  -> persist attachment metadata
  -> bind to current text event or bounded pending attachment record
  -> submit Gateway command with attachment reference
  -> resolve attachment into Planner image/context input
```

Required rules:

1. Support text-plus-image messages as one command.
2. For image-only messages, send an immediate Feishu acknowledgement that the
   image is waiting for a text instruction.
3. Correlate pending images by Conversation/channel/thread and a short TTL,
   not by chat ID alone.
4. Preserve message ID, file key, local path, MIME type, byte size and hash.
5. Delete or expire unclaimed pending attachments deterministically.
6. If download, persistence, or Planner resolution fails, report the exact
   stage to Feishu.
7. Add audit fields proving whether the image reached the Planner turn.

The generic Gateway attachment contract remains authoritative. Feishu should
adapt into that contract instead of appending a path to natural-language text.

### 5.6 Make artifact/cloud-document delivery a durable fan-out

When a Task produces artifacts, the result pipeline should fan out into
independent delivery effects:

```text
safe result available
  -> Feishu final text/card delivery
  -> artifact delivery coordinator
       -> cloud upload
       -> optional document import
       -> link/share publication
       -> file-message fallback if needed
```

Each effect must be independently idempotent and auditable. The final Feishu
reply should include one of:

```text
云文档已生成：<link>
文件已发送：<file>
正文已返回，云文档生成失败：<bounded reason>
正文已返回，无可发布文件
```

Cloud-document conversion is best-effort only when the raw file remains
deliverable, but it cannot be silently omitted. Import polling must have a
bounded deadline, and fallback behavior must be explicit.

### 5.7 Add cross-boundary reconciliation and diagnostics

Add a bounded runtime consistency projection evaluated:

- during startup recovery;
- before admitting a new same-Conversation Task;
- after cancellation application;
- after final result/artifact delivery;
- when Feishu reconnects or requests history.

The projection should compare:

```text
Task status
Conversation slot
active_task_id
schedule entry
Kernel application
dispatch items
attempts/leases
artifact records
delivery effects
```

Contradictions must become structured diagnostics with a stable code and
repair phase. They must not be collapsed into “task is running”.

## 6. Implementation Sequence

### Phase A: Contract and regression characterization

- Capture the real Feishu card-update request/response contract.
- Add a runtime-state fixture reproducing `blocked + occupied + running +
  uncertain cancellation`.
- Add a fixture for text-plus-image and image-only Feishu events.
- Add a fixture where a safe result exists but cloud-document delivery fails.
- Confirm existing Web tests remain unchanged and passing.

### Phase B: Kernel/task lifecycle closure

- Implement cancellation operation identity and conflict-safe dispatch-item
  reconciliation.
- Implement startup/pre-admission state reconciliation.
- Implement explicit abandon-and-create semantics.
- Add focused Kernel, Runtime, storage, and Conversation-slot tests.

### Phase C: Feishu input and progress closure

- Implement message-scoped attachment persistence and Gateway references.
- Implement the Feishu delivery state machine.
- Close the verified interactive-card API contract.
- Add tests for throttling, duplicate failure suppression, degraded mode,
  replacement cards, terminal repaint, reconnect, and image continuity.

### Phase D: Result/artifact delivery closure

- Add durable Feishu artifact delivery effects and idempotency.
- Wire cloud-document success/failure/fallback into the final reply.
- Add result-plus-artifact replay and restart recovery tests.

### Phase E: End-to-end acceptance

- Clear an actually blocked Task, verify all durable state is released, then
  submit a new Task in the same Feishu Conversation.
- Submit a new Task with a screenshot and verify the Planner receives the
  image attachment.
- Run a long task with frequent progress and verify one activity card rather
  than a message flood.
- Force card-update rejection and verify bounded degradation without repeated
  warnings.
- Produce a Markdown artifact and verify either a cloud-document link or an
  explicit file fallback.
- Restart during cancellation, card delivery, and cloud-document import, then
  verify deterministic recovery.

## 7. Test And Acceptance Matrix

| Area | Required proof |
| --- | --- |
| Cancellation | Same cancellation replay does not violate unique constraints or duplicate effects |
| State convergence | `blocked`, slot, active pointer, schedule, dispatch and leases converge to terminal-compatible states |
| New Task | Explicit abandon-and-create creates exactly one new Task only after old-task release |
| Uncertain application | Recovery distinguishes already-applied, replayable, and contradictory state |
| Card update | Verified Feishu payload contract passes integration-style adapter tests |
| Notification governance | Ordinary progress is coalesced; failure notices and replacement cards are bounded |
| Screenshot | Image reaches Gateway attachment store and Planner image input with auditable identity |
| Cloud document | Upload/import/link/fallback has a terminal audit outcome |
| Web regression | Existing Web trace, card, result, and attachment behavior remains unchanged |
| Restart recovery | Cancellation and delivery recover without duplicate Task, message, or artifact effects |

## 8. Non-Goals And Safety Boundaries

- Do not loosen the single-Conversation Task admission rule.
- Do not make topic similarity authorize cancellation or Task replacement.
- Do not let Feishu adapters mutate Task, Kernel, or storage state directly.
- Do not expose raw Planner prompts, hidden reasoning, raw Executor logs, or
  credentials in Feishu.
- Do not silently treat an information card as proof of artifact delivery.
- Do not change the Web product behavior as part of the Feishu notification
  compromise.
- Do not repair the current database by deleting rows as a substitute for
  runtime convergence.

## 9. Completion Criteria

This plan is complete only when:

1. The current `cancel_task` unique-constraint failure has a focused regression
   test and the production cancellation path converges idempotently.
2. `/task clear all` reports the actual durable outcome and releases all
   admission state before a same-Conversation new Task is scheduled.
3. Explicit abandon-and-create is represented as a durable control operation.
4. Feishu screenshots become Gateway attachments and are provably visible to
   Planner input.
5. Feishu card updates follow the verified API contract and degrade without
   notification flooding.
6. Feishu final delivery reports cloud-document success, file fallback, or
   bounded failure explicitly.
7. Restart/replay tests cover cancellation, attachment, card, result, and
   artifact delivery uncertainty.
8. Web regression tests remain green and no Web-specific behavior is changed.


## 10. Delivery Record (2026-09-06)

Root cause for §2.1 confirmed and fixed at the storage boundary:
`requestCancellation` moved `uncertain` rows back INTO the partial unique index
`idx_kernel_dispatch_one_active_subtask` while a newer active attempt for the
same (task, generation, subtask) already held the slot — the UPDATE itself
violated the index, rolled back the whole cancellation transaction, and left
the Task blocked with its Conversation slot occupied and the application
uncertain forever. Fix: conflict-safe reconciliation in
`KernelDispatchItemRepo` (superseded rows terminalize; fenced inserts persist
as cancelled; live-sibling collisions fail with an actionable typed error),
idempotent `cancel_task` replay in `TaskCancellationCoordinator`, uncertain
application reconciliation (`cancellation-reconciliation.ts` +
`KernelExecutionRuntime.reconcileCancellationApplications` /
`reconcileConversationAdmission`, startup + pre-planning wiring), and
`/task clear` durable per-task outcomes.

Delivered behavior per finding:

- §2.1 cancellation: storage conflict-safety + idempotent replay + startup /
  pre-admission reconciliation + durable clear outcomes.
- §2.2 new-task intent: `abandon_task` task control (schema, validator, Kernel
  authorization restricted to the exact old Task of the current Conversation,
  runtime cancel→converge→report, planner SKILL.md guidance). Topic similarity
  still authorizes nothing.
- §2.3 screenshots: message-scoped pending attachments (route = chat + thread,
  bounded TTL + per-route bound, deterministic expiry, immediate image ack),
  rich-text text+image in one command, bytes persisted into the Gateway
  attachment store under the bound Conversation, resolvable `attachmentId`
  references, and a durable `gateway_attachment_resolved` journal event
  proving whether images reached the Planner turn.
- §2.4 card update contract: `updateMarkdownCard` now sends the documented
  edit-message payload (`msg_type: 'interactive'` + content) with failure
  classification (contract / not_found / permission / transient) and a single
  bounded transient retry; one Feishu card delivery state machine
  (`feishu-card-delivery-machine.ts`, §5.1 states) owns throttling, serialized
  operations, bounded create-only degradation, replacement cooldown, terminal
  paints, and per-outcome audit, keyed by stable conversation+task scope at
  the bridge level.
- §2.5 result vs cloud document: artifact delivery completes BEFORE the final
  reply, which then states the terminal outcome explicitly (云文档已生成 /
  文件已发送 / 正文已返回，云文档生成失败 / 产物投递失败或跳过)； a durable
  artifact-delivery ledger (JSONL beside the audit log) makes every effect
  idempotent per chat+thread+artifact across restarts.

Validation mapping (§7): cancellation replay & convergence
(kernel-dispatch-item-repo, task-cancellation-coordinator,
cancellation-reconciliation), new task (control-kernel +
session-kernel-runtime), uncertain application distinction
(cancellation-reconciliation), card update contract (feishu-app contract
tests), notification governance (feishu-card-delivery-machine + updated
integration tests), screenshot visibility (feishu-pending-attachments +
feishu-app + feishu-conversation-routing + conversation-gateway-runtime),
cloud document outcome (feishu-app terminal-outcome tests), Web regression
(management/web suites unchanged and green), restart-safe idempotency
(ledger replay test).

## 11. Review Round 2 (2026-09-06) — gaps closed

A code review found the first closure pass incomplete. The following were
fixed with focused tests (see findings.md "Review round 2"):

1. Card update contract: interactive-card updates are **PATCH**
   /im/v1/messages/{id} with `content` only — not PUT+msg_type. The stale
   msg_type contract test was replaced.
2. The submitGatewayMessage reply-object final path now carries
   deliveryKind:'final' + artifact ledger, so registered artifacts and
   long-body cloud docs actually run.
3. Late final_answer/terminal_error verify the event turnId against the live
   attachment's activeTurnId before painting/clearing — a retired turn cannot
   end or pollute the new Task.
4. The Conversation slot is released only after the async drain confirms
   dispatch/lease/backend convergence (releaseAdmission), never inside the
   apply fence.
5. abandon_task is now the full abandon-and-create control: the planner emits
   a `plan_work_graph` with `conflictResolution: { oldTaskId }`; the Kernel
   validates and passes it through; the Runtime abandons the old Task first
   and creates/queues the new Task only after cancellation is durable (held
   with a named phase otherwise).
6. First-message attachments survive Conversation creation; save failures
   surface via onAttachmentFailed.
7. Slash commands no longer consume pending attachments.
8. The artifact ledger is a durable state machine (pending reservation →
   terminal settle; in-flight/write-failed distinctions; no swallowed write
   failures; long-body conversion included).
9. The card scope key is immutable per turn (conversation+request, no
   requestId→taskId switch) and degraded mode never suppresses the terminal
   receipt.
10. Pending attachments are sender-scoped, durable across restart, and delete
    downloaded files on expiry/limit eviction.

Validation: lint clean; 174 files / 1101 tests green (execution, executor,
storage, kernel, gateway, integrations, management, web, planning, acceptance
incl. regenerated cross-repository contract hash); session+e2e 42 files green
with the single pre-existing scripted-session result-first failure unchanged.

## 12. Review Round 3 (2026-09-06) — remaining production defects closed

A second review found further production-relevant gaps; all fixed with tests
(see findings.md "Review round 3"):

- abandon-and-create now also holds the new Task on recovery_in_progress; it
  is never created before the old Task is fully released.
- Pending-image claim keeps the downloaded file (only expiry/limit eviction
  deletes it), so routing can still read the bytes into the attachment store.
- Startup recover() releases slots for every cancelled Task, and uncertain
  cancellation reconciliation runs before the recover sweep.
- Pre-admission terminal release uses releaseAdmission() (re-checks residue).
- Long-body cloud-doc idempotency key includes a body content hash.
- Pending JSONL uses explicit tombstones (two-pass load).
- Ledger settle() failures are surfaced; stale pending reservations are
  re-takable.
- Cloud-doc import success settles before the best-effort link card, so a
  card-send failure cannot rewrite it to failed.
- No separate doc-link/notice card; the final reply status line is the single
  notification and can no longer block the business result.
- Live card scope is bound to the immutable turn; terminal turn matching is
  strict (missing turnId on a late terminal is stale).
- Attachment failures are durably audited with chat/thread attribution.

Validation: lint clean; 180 files / 1112 tests green (execution, executor,
storage, kernel, gateway, integrations, management, web, planning, acceptance,
e2e); tests/session 37 files green with the single pre-existing
scripted-session result-first failure unchanged.
