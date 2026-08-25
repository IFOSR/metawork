# Execution Reliability And Live Progress Projection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make dependent Subtasks complete reliably, make explicit resume requests actually dispatch work, preserve multi-turn Conversation history, and present safe Executor execution progress as a durable real-time information stream.

**Architecture:** Preserve the `Planner proposes -> ControlKernel decides -> Runtime applies -> Executor reports facts` control axis. Dependency handoff and resume behavior remain Kernel/Execution concerns; presentation consumes only safe `InteractionTrace`, execution projections, and durable result facts. The primary user experience is an inline live execution card in the main conversation, with a clickable per-Subtask detail drawer; the same trace is projected into the trajectory view and adapted for native Planner/TUI and Feishu.

**Tech Stack:** Node 22.19+, TypeScript ESM, SQLite/better-sqlite3, Vitest, Gateway JSONL/event journal, Web React/TSX, vendored AnyFusion-Pi Planner Host Protocol v2.

---

## 1. Current State And Findings

### 1.1 Dependency execution

The current frontier requires a dependency Subtask to be `done` and its handoff to exist before the downstream Subtask becomes runnable. When the frontier is empty, `ControlKernel` can emit `block_work` with `no runnable Subtask while work remains`. A downstream attempt can also fail from missing handoff, missing dependency workspace state, or result-reference access errors. These facts are currently at risk of being normalized as generic `unknown`/`attempt_exception`, which turns a dependency-read problem into a misleading user-visible block.

The fix must not grant a downstream Executor arbitrary access to an upstream sandbox. The only supported input boundary remains:

- integrated Git dependency state;
- publication-created immutable Result Objects;
- edge-scoped Result References;
- attempt-scoped read-only evidence/result capabilities.

### 1.2 Explicit resume

The Session resume path currently prepares a normal execution request and starts the Runtime. The Runtime may unblock the Task while the target Subtask remains `blocked` or `awaiting_decision`. The pure frontier only accepts `ready` Subtasks, so the user can see `resume after capacity block` guidance while no dispatch is authorized.

Resume must become a durable Kernel event and must restore Task/Subtask state only through the corresponding Kernel decision application. It must not be a direct Session-side state mutation.

### 1.3 Conversation history

`FileEventJournal.latestResultEvents()` keeps only the newest `resultId` during replay and compaction. This explains why later results can hide earlier results in one Conversation. Conversation transcript history and result delivery streams need separate retention behavior.

### 1.4 Executor live progress

The feature is partially implemented and already has the correct basic direction:

- `ExecutorAdapter` and Pi/Codex drivers emit normalized progress events.
- `KernelExecutionRuntime` converts safe progress into `executor_progress` and heartbeat `InteractionTrace` events.
- Web has `LiveExecutionPanel` cards grouped by Subtask.
- Web cards open `ExecutionDetailDrawer`, which filters events by `subtaskId`, appends live events, and auto-scrolls.
- Web also has `ExecutionNarrative`, `ExecutionTimeline`, trajectory filters, and a Work Graph projection.
- Existing tests cover inline streaming, clickable Subtask details, trace filtering, progress history, and responsive presentation.

The remaining product gaps are:

- the main live stream is strongest in Web and is not consistently projected to the default native Planner/TUI or Feishu;
- the detail stream is tied to the current turn trace and is not yet a durable, replayable per-Subtask stream across reconnects and multi-turn history;
- the progress stream and the persisted verifier evidence path need an explicit separation so user-visible facts are safe, bounded, and not mistaken for raw process logs;
- historical event compaction can remove the events needed to rebuild older execution details;
- heartbeat and progress events do not yet expose a stable public cursor contract for all client surfaces.

## 2. User-Facing Design

### 2.1 Primary presentation

Use both presentation forms, with different responsibilities:

1. **Inline main conversation information stream**
   - While a Task is running, show one compact `LIVE EXECUTION` panel in the active Conversation turn.
   - Show one card per active/running Subtask.
   - Each card shows Subtask title, status, Executor, Harness, Provider, Model, current safe step, elapsed time, and a live indicator.
   - When the Task settles, retain the card as an `EXECUTION SUMMARY` rather than removing it.
   - This is the default surface because the user should not need to navigate away from the conversation to know whether work is progressing.

2. **Clickable Subtask detail stream**
   - Clicking a card opens a right-side `Executor Detail` drawer.
   - The drawer shows the ordered safe event stream for exactly one Subtask/attempt chain.
   - It includes dispatch, process start, tool/skill activity, progress summaries, heartbeat, verification, publication, blocked, and failure milestones.
   - It must never show raw prompt, hidden reasoning, credentials, raw stdout/stderr, or unrestricted tool arguments.
   - The drawer supports live append, auto-scroll, reconnect replay, and a bounded history indicator.

3. **Trajectory and Work Graph views**
   - The trajectory view remains the audit-oriented view with phase filters, actor filters, status filters, and event details.
   - The Work Graph remains topology-oriented and shows dependency/handoff readiness.
   - These views must link to the same Subtask detail stream instead of maintaining a second event model.

### 2.2 Native Planner/TUI and Feishu

- Native Planner/TUI receives safe execution milestones through the existing Host/Gateway event plane and shows a compact streaming progress block in the conversation.
- Detailed per-Subtask inspection is exposed through an explicit command or selectable result view, not through direct Planner storage access.
- Feishu receives throttled progress cards/messages grouped by Task and Subtask. Frequent Executor events are coalesced; terminal events and blockers are sent immediately.
- Planner custom messages remain passive facts. Executor progress arrival must not trigger a new semantic Planner turn.

### 2.3 Event semantics

Every public progress event must contain stable identity and ordering:

- `accountId`, `conversationId`, `turnId`;
- `taskId`, `generationId`, `subtaskId`, `attemptId`;
- `eventId`, `eventKey`, `sequence`, `occurredAt`;
- `phase`, `actor`, `kind`, `status`;
- bounded safe `title`, `summary`, and `details`;
- `traceStatus` for the aggregate current execution state.

The public stream is a projection of durable Runtime facts. It is not a raw process-log tunnel and is not a second execution authority.

## 3. Implementation Tasks

### Task 1: Add regression tests for dependency readiness and false blocking

**Files:**
- Modify: `tests/kernel/control-kernel.test.ts`
- Modify: `tests/execution/kernel-execution-runtime-recovery.test.ts`
- Modify: `tests/execution/work-graph-runtime-service.test.ts`
- Modify: `tests/execution/subtask-execution-context.test.ts`
- Create if needed: `tests/execution/dependency-handoff-recovery.test.ts`

**Steps:**

1. Add a failing Kernel test where an upstream Subtask is not yet integrated and the downstream frontier is empty. Assert that the decision is wait/no-op with a dependency-publication reason, not ordinary `block_work`.
2. Add a failing test where a publication is integrated but the Result Reference is unavailable. Assert that Runtime emits a structured dependency materialization fact.
3. Add a failing test where the Result Reference identity is wrong. Assert fail-closed behavior with a non-retryable diagnostic.
4. Add an end-to-end focused graph test where an upstream report publishes an immutable result and a downstream HTML Subtask reads it through the authorized handoff capability.
5. Run the focused tests and confirm they fail for the current implementation.

**Validation:**

```text
npm test -- tests/kernel/control-kernel.test.ts tests/execution/kernel-execution-runtime-recovery.test.ts tests/execution/work-graph-runtime-service.test.ts tests/execution/subtask-execution-context.test.ts
```

### Task 2: Model dependency readiness as explicit Runtime facts

**Files:**
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/work-graph/frontier.ts`
- Modify: `src/storage/subtask-handoff-repo.ts`
- Modify: `src/storage/workspace-publication-repo.ts`
- Modify: `src/execution/workspace-publication-worker.ts`
- Test: `tests/kernel/control-kernel.test.ts`
- Test: `tests/execution/dependency-handoff-recovery.test.ts`

**Steps:**

1. Add a bounded dependency readiness projection to the dispatch snapshot. It must distinguish pending publication, missing handoff, missing workspace state, missing result object, and identity mismatch.
2. Keep `deriveRunnableFrontier` pure. It should continue to derive only structural readiness from graph/runtime facts; the Runtime snapshot adapter supplies publication/handoff facts.
3. Change dispatch decision logic so a graph with pending dependency publication waits without converting the Task to ordinary manual blocked.
4. Keep `block_work` for genuinely terminal or invalid dependency states, but include the source and target Subtask identities in the reason and dependency metadata.
5. Ensure publication integration creates Result Object, Result Reference, handoff, Subtask `done`, and workspace state atomically.
6. Emit a follow-up `dispatch_requested` after successful publication so the newly released downstream frontier is evaluated immediately.
7. Add focused tests for pending, integrated, missing, and identity-mismatched dependency states.

**Validation:**

```text
npm test -- tests/kernel/control-kernel.test.ts tests/execution/dependency-handoff-recovery.test.ts tests/execution/work-graph-runtime-service.test.ts
```

### Task 3: Normalize dependency materialization failures

**Files:**
- Modify: `src/execution/subtask-attempt-runner.ts`
- Modify: `src/execution/subtask-execution-context.ts`
- Modify: `src/execution/execution-result-reference-port.ts`
- Modify: `src/storage/result-object-repo.ts`
- Modify: `src/executor/error-utils.ts`
- Modify: `src/kernel/control-kernel.ts`
- Test: `tests/execution/subtask-attempt-runner.test.ts`
- Test: `tests/execution/subtask-execution-context.test.ts`

**Steps:**

1. Define stable normalized failure codes for dependency publication pending, handoff materialization failure, missing Result Object, unauthorized Result Reference, identity mismatch, and missing dependency workspace state.
2. Map transient filesystem/control-plane failures to retryable infrastructure facts.
3. Map authorization and identity failures to fail-closed contract facts; never retry indefinitely.
4. Preserve the dependency source/target IDs and Result Reference ID in bounded diagnostics.
5. Keep raw error text out of the public trace while retaining a redacted durable audit summary.
6. Add tests proving that dependency-read failure does not become a generic `unknown` block.

**Validation:**

```text
npm test -- tests/execution/subtask-attempt-runner.test.ts tests/execution/subtask-execution-context.test.ts tests/execution/execution-progress-and-workspace-services.test.ts
```

### Task 4: Implement Kernel-authorized explicit Task resume

**Files:**
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/kernel/kernel-workflow.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/session/session-task-execution-application-service.ts`
- Modify: `src/session/metaclaw-session.ts` compatibility bridge only if required
- Modify: `src/core/types.ts` dependency/recovery vocabulary if required
- Test: `tests/kernel/control-kernel.test.ts`
- Test: `tests/session/task-boundary-round3-acceptance.test.ts`
- Test: `tests/session/blocked-task-user-journey.test.ts`
- Test: `tests/session/kernel-capacity-control-loop.test.ts`

**Steps:**

1. Add a versioned `task_resume_requested` Kernel event with explicit Task ID, source input, blocker category, and idempotency identity.
2. Add the minimum decision/action contract needed to authorize resume, capacity probing, exact workspace recovery, or a structured no-op/block.
3. Make Kernel validate the current Task, active generation/revision, Subtask statuses, dependency readiness, and blocker type before authorizing anything.
4. Apply Task and Subtask state restoration only in Runtime decision application. Do not unblock a Task before Kernel authorization.
5. Restore `blocked -> ready` only for a Subtask whose blocker is explicitly recoverable. Do not clear manual/material/contract blockers implicitly.
6. Route capacity resume through a fresh capacity probe rather than a synthetic timer timestamp.
7. Make duplicate resume events reuse the existing decision/application and never create duplicate attempts.
8. Change Session guidance so “resume requested” is not presented as “execution started” until `dispatch_batch` is applied.

**Validation:**

```text
npm test -- tests/kernel/control-kernel.test.ts tests/session/task-boundary-round3-acceptance.test.ts tests/session/blocked-task-user-journey.test.ts tests/session/kernel-capacity-control-loop.test.ts
```

### Task 5: Separate Conversation transcript retention from result-stream retention

**Files:**
- Modify: `src/gateway/file-event-journal.ts`
- Modify: `src/gateway/client-events.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/gateway/scripted-gateway-session.ts`
- Modify: `src/gateway/feishu-gateway-session-port.ts`
- Modify: `src/session/conversation-session.ts`
- Test: `tests/gateway/file-event-journal.test.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/gateway/scripted-gateway-session.test.ts`

**Steps:**

1. Replace latest-result-only compaction with a bounded transcript snapshot plus result metadata for every retained result ID.
2. Consolidate retained `conversation_snapshot` events during compaction so old turns remain replayable without retaining an unbounded event list.
3. Preserve all result completion metadata within the retention window; do not let a later result remove earlier result identities.
4. Keep full chunks for the active result stream. For older results, use the durable result source or a bounded replay representation rather than silently dropping history.
5. Ensure stale-cursor replay returns the consolidated conversation snapshot, task projection, all retained result summaries, and later deltas.
6. Add multi-turn replay tests with at least two execution results and more than the event retention threshold.
7. Verify result streams remain isolated by `conversationId` and `resultId`.

**Validation:**

```text
npm test -- tests/gateway/file-event-journal.test.ts tests/gateway/conversation-gateway-runtime.test.ts tests/management/web-gateway-session-runtime.test.ts tests/gateway/scripted-gateway-session.test.ts
```

### Task 6: Make Executor progress a durable, replayable public projection

**Files:**
- Modify: `src/execution/execution-trace.ts`
- Modify: `src/execution/executor-attempt-runtime-repo.ts` if the current bounded progress history needs a durable cursor/event extension
- Modify: `src/management/interaction-trace.ts`
- Modify: `src/management/execution-projector.ts`
- Modify: `src/management/web-session-types.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/gateway/client-events.ts`
- Test: `tests/execution/execution-progress-and-workspace-services.test.ts`
- Test: `tests/management/execution-projector.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`

**Steps:**

1. Define a public progress event contract with Task/Subtask/attempt identity, monotonic sequence, event key, bounded summary, and source actor.
2. Keep the current redaction and truncation boundary. Never expose raw process output, prompt, hidden reasoning, credentials, or unrestricted tool arguments.
3. Separate public progress projection from verifier evidence persistence. A progress event may be shown to the user without becoming acceptance evidence.
4. Persist enough progress history to rebuild a selected Subtask detail stream after reconnect and after the current turn finishes.
5. Add a cursor/replay rule so reconnect does not duplicate or reorder progress events.
6. Preserve terminal milestone events even when ordinary progress is compacted.
7. Make heartbeat events visibly distinct from actual Executor activity so the UI does not imply progress when the process is only alive.

**Validation:**

```text
npm test -- tests/execution/execution-progress-and-workspace-services.test.ts tests/management/execution-projector.test.ts tests/management/web-gateway-session-runtime.test.ts tests/gateway/conversation-gateway-runtime.test.ts
```

### Task 7: Complete the Web inline stream and Subtask detail UX

**Files:**
- Modify: `web/src/components/ConversationView.tsx`
- Modify: `web/src/components/LiveExecutionPanel.tsx`
- Modify: `web/src/components/ExecutionDetailDrawer.tsx`
- Modify: `web/src/components/ExecutionNarrative.tsx`
- Modify: `web/src/components/TrajectoryView.tsx`
- Modify: `web/src/components/WorkGraphPanel.tsx`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/workspace-shell.test.ts`
- Test: `tests/web/conversation-view.test.ts`
- Test: `tests/web/interaction-trace.test.ts`
- Test: `tests/web/trajectory-view.test.ts`
- Test: add a reconnect/order/detail-stream regression test under `tests/web/`

**Steps:**

1. Keep the existing inline `LIVE EXECUTION` cards as the primary Conversation presentation.
2. Ensure the cards represent all active Subtasks, not just the latest trace event or latest attempt.
3. Ensure a card remains visible as an execution summary after completion, blocking, or failure.
4. Make the detail drawer consume the durable/replayable Subtask stream, not only the current in-memory turn trace.
5. Show a clear distinction between Executor activity, Runtime heartbeat, waiting for dependency, capacity wait, and blocked state.
6. Preserve event order by sequence and deduplicate by event ID/event key.
7. When switching Conversation or Task, clear the selected Subtask detail and prevent old events from appearing in the new session.
8. Keep mobile behavior usable: inline cards collapse to a vertical list; detail view occupies the full-width drawer.

**Validation:**

```text
npm test -- tests/web/workspace-shell.test.ts tests/web/conversation-view.test.ts tests/web/interaction-trace.test.ts tests/web/trajectory-view.test.ts
```

### Task 8: Project safe progress to native Planner/TUI and Feishu

**Files:**
- Modify: `src/tui-bridge/planner-host-protocol.ts`
- Modify: `src/tui-bridge/planner-host-bridge.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/gateway/client-events.ts`
- Modify: `src/gateway/feishu-gateway-session-port.ts`
- Modify: `src/integrations/feishu-app.ts`
- Modify: vendored Planner UI only where the existing Host Protocol adapter requires it
- Test: `tests/tui-bridge/planner-host-bridge.test.ts`
- Test: `tests/gateway/feishu-gateway-session-port.test.ts`
- Test: `tests/integrations/feishu-app.test.ts`

**Steps:**

1. Add a backward-compatible safe execution-progress notification or reuse the existing trace event plane if it can carry the required Subtask identity and sequence.
2. Keep Planner custom messages passive and set `triggerTurn: false`.
3. Show a compact current Subtask activity line in native Planner/TUI; keep full details available through an explicit detail command/projection.
4. Coalesce high-frequency Feishu progress events by Task/Subtask and flush them on a short bounded interval.
5. Send dispatch, blocker, failure, publication, and completion milestones immediately.
6. Deduplicate by event key and restore unshown terminal milestones after reconnect.
7. Do not expose raw Executor output or create a second Planner/runtime control path.

**Validation:**

```text
npm test -- tests/tui-bridge/planner-host-bridge.test.ts tests/gateway/feishu-gateway-session-port.test.ts tests/integrations/feishu-app.test.ts
```

### Task 9: Add end-to-end smoke coverage

**Files:**
- Modify: `tests/scripts/smoke-metaclaw-real-task.test.ts`
- Modify: `tests/e2e/web-image-planner-flow.test.ts`
- Modify: `tests/e2e/artifact-preview-and-ime.test.ts`
- Modify: smoke scenario fixtures under `examples/` or `scripts/` only if needed
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: applicable ADRs and `CONTEXT.md`

**Steps:**

1. Add a native smoke scenario with an upstream research Subtask and downstream HTML report Subtask.
2. Assert the downstream receives only the authorized handoff and produces the HTML artifact.
3. Add a blocked-task resume scenario that verifies a real Executor attempt starts after explicit resume.
4. Add a two-turn same-Conversation scenario that verifies both historical results survive reconnect/replay.
5. Add a live-progress assertion that observes at least one Executor progress event, one heartbeat or waiting fact, and one terminal publication event.
6. Run the native smoke and the explicit artifact scenario.
7. Do not require Docker validation for this delivery. The production path is
   native; container validation is an optional compatibility exercise outside
   this plan's acceptance gate.

**Validation:**

```text
npm run smoke:metaclaw
npm run smoke:metaclaw -- --scenario artifact
```

## 4. Documentation And ADR Updates

The implementation must update the following only after behavior and tests are complete:

- `CONTEXT.md`: dependency publication readiness, explicit resume ownership, public Executor trace boundary, and Conversation/result retention invariant.
- `docs/current/technical-overview.md`: the two-level live progress presentation and replay behavior.
- `docs/current/technical-overview.zh-CN.md`: Chinese user-facing execution stream description.
- ADR-0023: dependency waiting/materialization facts and explicit resume event if the Kernel wire contract changes.
- ADR-0025: downstream publication readiness remains the completion boundary.
- ADR-0031: Conversation transcript and execution trace/result replay projection.
- A new ADR is required only if the change introduces a new durable authority or changes the Gateway protocol incompatibly. Prefer an additive protocol version or backward-compatible event when possible.

The plan document should be updated on completion with:

- implementation date;
- delivered behavior;
- focused and integration validation;
- closing commit;
- known residual risks.

## 5. Acceptance Criteria

- A downstream HTML/report Subtask can consume an upstream integrated report through the authorized handoff path without reading the upstream sandbox directly.
- Pending dependency publication waits instead of producing a false ordinary block.
- Dependency access failures have structured, bounded, actionable diagnostics and do not become generic `unknown`.
- Explicit Resume causes a real Kernel-authorized dispatch or clearly reports why dispatch is not possible.
- Task and Subtask states cannot diverge into `running Task + no ready Subtask` solely because of Resume.
- Multiple execution results remain visible in one Conversation after reconnect and event compaction.
- Web shows live per-Subtask cards in the main Conversation and a clickable detail stream.
- The detail stream is ordered, deduplicated, replayable, and isolated by Conversation/Task/Subtask/attempt.
- Native Planner/TUI and Feishu receive safe, throttled execution milestones without triggering new Planner turns.
- No public surface exposes raw prompt, hidden reasoning, credentials, raw stdout/stderr, or unrestricted tool arguments.
- Existing standby Ink UI remains preserved and is not made the new primary surface.

## 6. Explicit Non-Goals

- No direct Executor-to-Executor communication.
- No unrestricted cross-sandbox filesystem access.
- No second scheduler, semantic router, or Planner-owned recovery policy.
- No automatic resume of a blocked Task without an explicit Kernel-authorized trigger.
- No unbounded event journal or unbounded progress history.
- No requirement to expose hidden model reasoning or raw CLI logs.

## 7. Completion Record

**Status:** Implemented and validated; GitHub synchronization in progress.
**Implementation date:** 2026-08-25.

**Delivered behavior:**

- Dependency readiness is a bounded Kernel/Runtime fact. Pending publication waits
  without becoming an ordinary block; missing handoff, workspace, Result Object,
  unauthorized Result Reference, and identity mismatch produce structured
  terminal diagnostics. Downstream Executor input remains limited to integrated
  Git state, immutable Result Objects, edge-scoped Result References, and
  attempt-scoped capabilities.
- Explicit blocked/parked Task recovery is a durable
  `task_resume_requested` event followed by a Kernel `resume_task` decision.
  Runtime applies the state transition and dispatch only after authorization.
  Unknown and contract blockers remain fail-closed; legacy missing-graph recovery
  remains parked for replan.
- Conversation transcript retention is separate from result-stream retention.
  Multiple result identities and historical turn snapshots survive compaction,
  stale-cursor replay, reconnect, and same-Conversation follow-up turns.
- Executor progress is a safe, bounded, replayable projection with stable
  Task/Subtask/attempt identity, cursor, event key, sequence, heartbeat/waiting
  distinction, terminal milestones, and redaction. It is not raw process output,
  prompt content, credentials, unrestricted tool arguments, or verifier evidence.
- Web presents one inline `LIVE EXECUTION`/`EXECUTION SUMMARY` panel in the main
  Conversation, grouped by Subtask, plus a clickable `Executor Detail` drawer
  backed by durable replay history. Trajectory and Work Graph use the same
  projection. Session/Task switching clears stale selection and history.
- Native Planner/TUI and Feishu receive passive safe progress facts. Feishu
  coalesces frequent events and flushes blockers, failures, publication, and
  completion immediately; progress never triggers a new Planner turn. The
  standby Ink UI remains preserved.
- A 2026-08-25 production-history regression was corrected: account startup
  recovery now supplies the passive `onDecisionApplying` callback, successful
  replan materialization always resolves the generation replan request, and the
  one known legacy pre-apply uncertainty is replayed only through a
  Kernel-authorized `recovery_resolution_requested(retry)`. The same bounded
  repair runs during explicit Resume, so the historical HTML-report Task starts
  a real Executor attempt instead of returning an unknown-blocker message.
- Explicit `/task resume`, `/task unblock`, and `/task recover` inputs now open
  an `InteractionTrace` before command dispatch. Real Executor activity is tied
  to the recovery turn, while an already-settled recovery command closes the
  trace without leaving a false running state.
- Historical recovery turns infer their Task identity from the explicit command.
  The latest relevant turn receives the durable execution timeline and artifact
  facts; older turns remain visible without duplicating the same large timeline
  into every turn. The Session sidebar labels the writable Conversation as
  `当前` and uses `运行中` only when a live turn is actually executing.
- Public timeline reconstruction is bounded to 20 attempts per Subtask, 50
  progress events per attempt, and 200 Kernel decisions. Kernel decision replay
  uses a lightweight `action/task/subtask/reason` query instead of parsing the
  full decision ledger payload. On the production-history Task with 1,781
  decisions and approximately 790 MB of legacy event/snapshot/decision JSON,
  the Session projection improved from approximately 8.0 seconds to 0.5 seconds
  and the execution-timeline endpoint from approximately 19.0 seconds to
  0.22 seconds.
- Public progress strips workspace command and tool arguments. User surfaces
  show bounded milestones such as `Executor started a workspace command`
  instead of shell paths, command text, or arguments.
- The real historical Zhipu Hong Kong stock analysis Task
  `task_plan_event_proposal_71fa097522f9864c1e60abff6887168c22de8b22b1c91dbd520f73a92b4d7a89`
  completed and integrated. Its user-visible HTML artifact is
  `reports/zhipu-02513-decline-analysis-2026-08-25-v2.html` (30,316 bytes,
  SHA-256 `080146f78cf07d1a8f914fde80824c4885860883b0f45e17666af0f0899610c2`)
  and is available through the authenticated preview and download endpoints.

**Acceptance audit:** All plan acceptance criteria are satisfied:

- Authorized dependency handoff: the native artifact smoke and focused graph
  tests prove that downstream work consumes integrated state and immutable
  Result References without reading an upstream sandbox.
- False blocking: pending publication produces a wait decision; missing or
  mismatched dependency material produces a structured bounded diagnostic
  rather than a generic `unknown` block.
- Explicit Resume: recovery is a durable Kernel request and either dispatches a
  real attempt or returns a structured no-op/block reason. State restoration is
  applied only after Kernel authorization.
- State consistency: focused resume and capacity-loop tests cover the
  `Task/Subtask/frontier` transition and prevent `running Task + no ready
  Subtask` divergence caused by Resume.
- Conversation retention: the real Conversation exposes all five historical
  turns after restart/replay; only the latest relevant turn carries the large
  timeline and artifact projection.
- Web progress UX: the main Conversation retains four per-Subtask execution
  summary cards, and each card opens the same durable ordered detail stream.
- Stream correctness: public events are ordered, deduplicated, bounded, and
  isolated by Conversation/Task/Subtask/attempt in projector and Web tests.
- Native and Feishu projection: Planner Host and Feishu tests prove passive,
  throttled safe progress delivery with terminal milestones and
  `triggerTurn: false`.
- Public safety: focused redaction tests and real-browser inspection confirm no
  raw prompt, hidden reasoning, credentials, stdout/stderr, shell command, or
  unrestricted tool arguments appear in public progress.
- Standby Ink preservation: the existing Ink module and its full test coverage
  remain present and passing; it was not promoted to the primary surface.

Docker is not part of the current native production flow and is therefore not
an acceptance requirement for this delivery.

**Validation completed:**

- `npm run lint` passed.
- `npm run build` passed.
- `cd web && npm run build` passed.
- `npm test` passed: 330 files, 1533 tests passed, 6 files and 17 tests skipped
  by existing conditional coverage.
- 45 focused recovery-turn, historical Web projection, timeline bounding,
  lightweight decision query, public redaction, and sidebar-status regressions
  passed.
- Focused dependency, resume, retention, trace, Web, Planner Host, Feishu,
  artifact, and execution tests passed, including the six regressions found in
  the first full-suite run.
- Focused account recovery coverage passed for pending replan application,
  startup repair of the legacy uncertain application, and in-process explicit
  Resume through real dispatch and Task completion. The regression asserts that
  no `unknown blocker` Decision is produced.
- `RUN_BROWSER_E2E=1 npm test -- tests/e2e/artifact-preview-and-ime.test.ts`
  passed after making the Chrome 151 harness accept its stderr-advertised
  DevTools port.
- Real browser verification passed on desktop and a 390x844 mobile viewport:
  five historical turns remain visible, the completed execution summary exposes
  four clickable Subtask cards, the durable detail drawer contains 106 ordered
  events without raw `/bin/zsh -lc` text, the HTML artifact previews and
  downloads correctly, cards stack vertically on mobile, both drawers fit the
  viewport, and neither viewport has horizontal overflow.
- `npm run smoke:metaclaw` passed.
- `npm run smoke:metaclaw -- --scenario artifact` passed and produced a real
  artifact in the controlled workspace store.
- `git diff --check` passed.

**Docker validation:** Not applicable to this delivery. The current production
flow is native; Docker remains an optional repository compatibility path and is
not a release or completion gate for these changes.

**Closing commit:** Not committed by instruction. Commit and GitHub
synchronization remain pending explicit user instruction.

**Known residual risks:** Generic uncertain applications and external effects
still require their existing explicit recovery flow by design. The automated
legacy repair is restricted to the exact pre-apply presentation-callback
failure and matching durable replan identity. Optional container compatibility
behavior is outside this plan's scope. One local Chrome 151 E2E launch exceeded
the five-second DevTools-port wait once; the identical standalone launch and an
unchanged immediate test rerun passed, so no product or assertion relaxation
was made.
