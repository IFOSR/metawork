# Web Session Workspace Redesign Implementation Plan

> Status: Completed
> Plan date: 2026-08-17
> Completion date: 2026-08-17

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the split AnyFusion Web layout with a persistent session workspace containing a detailed Conversation view, a dense Trajectory view, and a safe single-live-session activation model.

**Architecture:** Keep `ManagementServer` and Web as Application-Shell adapters. Add a versioned file-backed Web session catalog and presentation projection without changing SQLite schema 30 or moving Planner/Kernel/Runtime authority. Maintain one live `MetaclawSession`; historical sessions are browsable read-only and can be activated only through an idle-runtime gate. Conversation and Trajectory consume the same persisted/live turn projection, `InteractionTrace`, and `ExecutionTimeline`.

**Tech Stack:** Node 22, strict TypeScript ESM, Vitest, native HTTP/WebSocket, React 18, Vite 6, existing DOMPurify/marked rendering.

---

## Working Rules

- Read `CONTEXT.md`, ADR-0020, and the approved design before each relevant task.
- Use TDD: write one failing test, run it, implement the smallest change, rerun focused tests.
- Do not add a second semantic router or any Planner/Kernel/Executor mutation path.
- Do not advance SQLite schema 30 or add a schema 31 compatibility path.
- Persist only sanitized Web presentation projections. Never persist or send hidden reasoning, raw prompt, credentials, raw tool payloads, or raw stdout/stderr.
- Keep previous uncommitted work intact. Commit each coherent task with a Conventional Commit subject.

## Task 1: Define Web Session Contracts

**Files:**
- Create: `src/management/web-session-types.ts`
- Create: `web/src/api/session-types.ts`
- Test: `tests/management/web-session-types.test.ts`

**Step 1: Write the failing test**

Define tests for:

- stable session metadata fields: `id`, `title`, `createdAt`, `updatedAt`, `active`;
- a `ConversationTurn` containing user input, terminal status, final answer, Task ID, and sanitized trace events;
- explicit activation states: `active`, `browsable`, `activation_blocked`;
- versioned persisted payloads;
- bounded turn/event limits.

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run tests/management/web-session-types.test.ts
```

Expected: FAIL because the Web session contracts do not exist.

**Step 3: Write minimal implementation**

Create domain-neutral Application-Shell contracts. Keep `InteractionTrace` and
`ExecutionTimeline` referenced by type rather than duplicated. Add constants for
bounded history sizes and a discriminated activation result.

**Step 4: Run test to verify it passes**

Run the same focused test and expect PASS.

**Step 5: Commit**

```bash
git add src/management/web-session-types.ts web/src/api/session-types.ts tests/management/web-session-types.test.ts
git commit -m "feat: define web session workspace contracts"
```

## Task 2: Add File-Backed Session Catalog

**Files:**
- Create: `src/storage/file-web-session-store.ts`
- Create: `src/management/web-session-catalog.ts`
- Create: `tests/storage/file-web-session-store.test.ts`
- Create: `tests/management/web-session-catalog.test.ts`

**Step 1: Write the failing repository tests**

Cover:

- initialization under `resolveAnyFusionPaths().data/web-sessions`;
- creating an empty session;
- atomic catalog and record writes;
- reload after process restart;
- title normalization and truncation;
- list sorting by `updatedAt`;
- search over title and persisted turn text;
- malformed record isolation without destroying the catalog;
- bounded turn retention.

Use a temporary `ANYFUSION_INSTALL_ROOT`; never write test data to the operator's
real home.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/storage/file-web-session-store.test.ts tests/management/web-session-catalog.test.ts
```

Expected: FAIL because the store and catalog are absent.

**Step 3: Write minimal implementation**

Implement:

- `FileWebSessionStore` with versioned JSON records;
- temp-file write, fsync, atomic rename;
- path confinement to the configured Web session directory;
- invalid-record quarantine;
- `WebSessionCatalog` methods for create, list, search, read, update projection,
  and archive.

The catalog owns presentation metadata only. It must not import Kernel,
Executor, or concrete SQLite repositories.

**Step 4: Run focused tests**

Expect all catalog/store tests to pass and confirm no files are written outside
the temporary install root.

**Step 5: Commit**

```bash
git add src/storage/file-web-session-store.ts src/management/web-session-catalog.ts tests/storage/file-web-session-store.test.ts tests/management/web-session-catalog.test.ts
git commit -m "feat: persist web session catalog"
```

## Task 3: Project Live Conversation Turns

**Files:**
- Create: `src/management/web-conversation-projector.ts`
- Modify: `src/management/server.ts`
- Modify: `src/session/session-transport-adapter.ts`
- Test: `tests/management/web-conversation-projector.test.ts`

**Step 1: Write the failing projector test**

Simulate:

1. user input submission;
2. query and Planner trace deltas;
3. Kernel/routing trace deltas;
4. execution timeline updates;
5. output lines;
6. terminal delivery.

Assert that the projector emits one ordered turn, updates it during execution,
and persists only after a terminal status. Assert that a failure/block preserves
the visible diagnostic summary.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/management/web-conversation-projector.test.ts
```

Expected: FAIL because no projector exists.

**Step 3: Write minimal implementation**

Add a projector that:

- starts a turn from the submitted input;
- merges trace snapshots/deltas idempotently by event ID;
- merges the current `ExecutionTimeline`;
- captures output deltas as final-answer material;
- writes a bounded, sanitized terminal projection through `WebSessionCatalog`;
- emits live structured conversation deltas independently of legacy output lines.

Do not alter `MetaclawSession` decision behavior. Extend
`SessionStreamAdapter` only if a structured submit/output callback is needed.

**Step 4: Run focused tests**

Run the projector test and existing trace stream tests. Expect PASS.

**Step 5: Commit**

```bash
git add src/management/web-conversation-projector.ts src/management/server.ts src/session/session-transport-adapter.ts tests/management/web-conversation-projector.test.ts
git commit -m "feat: project web conversation turns"
```

## Task 4: Add Session Activation Gate

**Files:**
- Create: `src/management/web-session-runtime.ts`
- Modify: `src/management/server.ts`
- Modify: `src/index.ts`
- Modify: `src/session/metaclaw-session.ts`
- Test: `tests/management/web-session-runtime.test.ts`
- Test: `tests/management/server.test.ts`

**Step 1: Write the failing activation tests**

Test:

- new session creation;
- browsing a historical session without replacing the live session;
- activation while the current Planner turn is idle;
- activation rejection while `activePlannerRuns > 0`;
- activation rejection while a current Task still owns active runtime work;
- successful disposal/recreation with the selected stable session ID;
- Planner session path reuse;
- all WebSocket clients receiving the active-session change;
- no forced disposal on a blocked activation.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/management/web-session-runtime.test.ts tests/management/server.test.ts
```

Expected: FAIL because `ManagementServer` currently owns one anonymous
singleton session and has no catalog or activation protocol.

**Step 3: Write minimal implementation**

Add an Application-Shell runtime coordinator that owns:

- the current live session ID and `MetaclawSession`;
- session factory recreation;
- safe activation checks;
- attach/detach of output, trace and timeline subscriptions;
- catalog/projector lifecycle.

Keep `ManagementServer` as the transport adapter. Inject the coordinator and
catalog through `src/index.ts`; do not make the Web server instantiate storage
or Runtime policy itself.

When activation succeeds, recreate the same stable Planner session ID. When it
fails, return a structured reason such as `planner_turn_active`,
`task_runtime_active`, or `session_unavailable`.

**Step 4: Run focused tests**

Run the two focused files and the existing management WebSocket tests. Expect
PASS.

**Step 5: Commit**

```bash
git add src/management/web-session-runtime.ts src/management/server.ts src/index.ts src/session/metaclaw-session.ts tests/management/web-session-runtime.test.ts tests/management/server.test.ts
git commit -m "feat: add safe web session activation"
```

## Task 5: Add Session HTTP/WebSocket Protocol

**Files:**
- Modify: `src/management/server.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/ws.ts`
- Test: `tests/management/server.test.ts`

**Step 1: Write failing protocol tests**

Cover:

- session list and search responses;
- historical session projection fetch;
- new session request;
- activate-session success and blocked response;
- WebSocket hello containing active session;
- session catalog delta;
- active-session snapshot;
- structured conversation snapshot/delta;
- reconnect replay ordering.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/management/server.test.ts
```

Expected: FAIL because the endpoints and messages are absent.

**Step 3: Write minimal implementation**

Add authenticated endpoints under `/api/sessions` and typed WebSocket messages.
Preserve existing `output`, `trace_snapshot`, `trace_delta`, and `execution`
messages until the new structured conversation path is fully adopted.

Use sequence cursors and idempotent merge rules for reconnect. Return
structured activation errors rather than generic strings.

**Step 4: Run focused tests**

Expect existing auth, trace, execution, and new session protocol tests to pass.

**Step 5: Commit**

```bash
git add src/management/server.ts web/src/api/types.ts web/src/api/http.ts web/src/api/ws.ts tests/management/server.test.ts
git commit -m "feat: expose web session protocol"
```

## Task 6: Build the Workspace Shell

**Files:**
- Create: `web/src/components/WorkspaceShell.tsx`
- Create: `web/src/components/SessionSidebar.tsx`
- Create: `web/src/components/WorkspaceHeader.tsx`
- Create: `web/src/components/Composer.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/workspace-shell.test.ts`

**Step 1: Write failing structural tests**

Assert:

- sidebar includes new session, search, session rows and settings;
- main header includes selected title and Conversation/Trajectory tabs;
- composer is rendered once outside the tab content;
- historical sessions show a continue action;
- active-session and activation-blocked states are represented;
- responsive CSS includes collapsed rail/drawer behavior.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/web/workspace-shell.test.ts
```

Expected: FAIL because the current `App` directly renders `ChatPane` and
`InteractionTracePanel`.

**Step 3: Write minimal implementation**

Refactor `App.tsx` into:

```text
WorkspaceShell
  SessionSidebar
  WorkspaceHeader
  Tab content
  Composer
```

Use the existing AnyFusion visual tokens, but adopt the reference's neutral
editor-like spacing and full-width main canvas. Do not copy DeepSeek branding.
Keep the composer sticky and preserve authentication/settings behavior.

**Step 4: Run Web TypeScript and structural tests**

```bash
npx vitest run tests/web/workspace-shell.test.ts
npm run build
npx tsc --noEmit --pretty false
```

Expect PASS.

**Step 5: Commit**

```bash
git add web/src/components/WorkspaceShell.tsx web/src/components/SessionSidebar.tsx web/src/components/WorkspaceHeader.tsx web/src/components/Composer.tsx web/src/App.tsx web/src/styles.css tests/web/workspace-shell.test.ts
git commit -m "feat: add web session workspace shell"
```

## Task 7: Build Detailed Conversation View

**Files:**
- Create: `web/src/components/ConversationView.tsx`
- Create: `web/src/components/ConversationTurn.tsx`
- Create: `web/src/components/ExecutionNarrative.tsx`
- Create: `web/src/components/ExecutionStep.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/conversation-view.test.ts`

**Step 1: Write failing rendering tests**

Use fixture data containing Planner, context tool, structured intent, Kernel
decision, routing, Executor progress, verification and delivery events. Assert:

- all sections render in order;
- tool name, action, risk, Task/Subtask, binding, attempt and artifact facts
  are visible;
- details can expand;
- the final answer is visually separated and rendered as sanitized Markdown;
- active steps show status and elapsed time;
- raw prompt/model text/secret-like fields are absent.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/web/conversation-view.test.ts
```

Expected: FAIL because the current ChatPane only renders a flat output string.

**Step 3: Write minimal implementation**

Render one full-width chronological turn. Group trace events into Planner,
Authorization and routing, Execution, and Verification/delivery sections.
Keep completed sections readable; keep the active section expanded. Reuse the
existing markdown sanitization boundary for final answers.

Do not render hidden reasoning or raw tool payloads. Use structured details
already sanitized by the server.

**Step 4: Run focused tests**

Run the new Web tests and root session trace tests. Expect PASS.

**Step 5: Commit**

```bash
git add web/src/components/ConversationView.tsx web/src/components/ConversationTurn.tsx web/src/components/ExecutionNarrative.tsx web/src/components/ExecutionStep.tsx web/src/App.tsx web/src/styles.css tests/web/conversation-view.test.ts
git commit -m "feat: render detailed conversation execution"
```

## Task 8: Build Dense Trajectory View

**Files:**
- Create: `web/src/components/TrajectoryView.tsx`
- Create: `web/src/components/TrajectorySummary.tsx`
- Create: `web/src/components/TrajectoryTimeline.tsx`
- Create: `web/src/components/TrajectoryEventTable.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/trajectory-view.test.ts`

**Step 1: Write failing rendering tests**

Assert:

- duration/turn/tool/attempt/status summary;
- phase timeline segments;
- searchable event table;
- actor/phase/status filters;
- expandable safe details;
- no second data source is introduced.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/web/trajectory-view.test.ts
```

Expected: FAIL because the existing trace card view has no trajectory mode.

**Step 3: Write minimal implementation**

Project the shared structured turn data into a compact table and timeline.
Compute durations from event timestamps only in the presentation layer. Keep
the selected turn/session and live streaming state synchronized with
Conversation.

**Step 4: Run focused tests**

Run trajectory tests, Web TypeScript, and Web build. Expect PASS.

**Step 5: Commit**

```bash
git add web/src/components/TrajectoryView.tsx web/src/components/TrajectorySummary.tsx web/src/components/TrajectoryTimeline.tsx web/src/components/TrajectoryEventTable.tsx web/src/App.tsx web/src/styles.css tests/web/trajectory-view.test.ts
git commit -m "feat: add web trajectory view"
```

## Task 9: Wire History, Resume, and Reconnect UX

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/components/SessionSidebar.tsx`
- Modify: `web/src/components/Composer.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/session-workspace.test.ts`

**Step 1: Write failing interaction tests**

Cover:

- create new session;
- select historical session for browse;
- continue a historical session;
- blocked activation explanation;
- search/filter;
- active row updates after a new turn;
- reconnect restores the selected session and current turn;
- composer disabled in read-only history mode;
- tab switching preserves scroll and draft state.

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/web/session-workspace.test.ts
```

Expected: FAIL because the new shell is not wired to the session protocol.

**Step 3: Write minimal implementation**

Use `WsClient` for live deltas and `HttpClient` for catalog/history reads.
Maintain separate `activeSessionId`, `browsedSessionId`, `conversationTab`,
and `draft` state. Treat a browse selection as read-only until activation
succeeds.

**Step 4: Run focused tests**

Expect all workspace interaction tests to pass.

**Step 5: Commit**

```bash
git add web/src/App.tsx web/src/api/http.ts web/src/api/ws.ts web/src/components/SessionSidebar.tsx web/src/components/Composer.tsx web/src/styles.css tests/web/session-workspace.test.ts
git commit -m "feat: wire web session history and resume"
```

## Task 10: Update Documentation and Release Gates

**Files:**
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `CONTEXT.md`
- Modify: `docs/README.md`
- Modify: `docs/plans/2026-08-17-web-session-workspace-redesign-design.md`

**Step 1: Write documentation acceptance checklist**

Document:

- session rail and new/history behavior;
- browse versus activate semantics;
- single-live-session safety gate;
- Conversation/Trajectory views;
- detailed safe execution narrative;
- persistence location and recovery behavior;
- responsive behavior;
- restart command.

**Step 2: Run documentation checks**

Run:

```bash
git diff --check
```

Expected: no whitespace errors and all current docs point to the approved
design/implementation plan.

**Step 3: Commit**

```bash
git add CONTEXT.md docs/README.md docs/current/technical-overview.md docs/current/technical-overview.zh-CN.md docs/plans/2026-08-17-web-session-workspace-redesign-design.md docs/plans/2026-08-17-web-session-workspace-redesign.md
git commit -m "docs: document web session workspace"
```

## Task 11: Full Validation

**Files:**
- No production changes expected.

**Step 1: Run focused backend tests**

```bash
npm test -- tests/management/web-session-types.test.ts tests/storage/file-web-session-store.test.ts tests/management/web-session-catalog.test.ts tests/management/web-conversation-projector.test.ts tests/management/web-session-runtime.test.ts tests/management/server.test.ts
```

**Step 2: Run focused Web tests**

```bash
npm test -- tests/web/workspace-shell.test.ts tests/web/conversation-view.test.ts tests/web/trajectory-view.test.ts tests/web/session-workspace.test.ts
```

**Step 3: Run type checks and builds**

```bash
npm run lint
npm run build
(cd web && npx tsc --noEmit --pretty false && npm run build)
```

**Step 4: Run the Web smoke path**

Start/restart Web with:

```bash
metawork web restart
```

Verify manually:

- new session appears immediately;
- first query creates a titled history row;
- Planner steps stream into Conversation;
- Trajectory updates while the turn is running;
- final answer follows the execution narrative;
- historical browse is read-only;
- safe idle activation resumes the selected Planner session;
- blocked activation explains the active Planner/Task reason;
- reconnect restores the selected session.

**Step 5: Record validation**

Update the design and implementation plan completion records with exact test
counts, build results, known unrelated full-suite failures, and the closing
commit. Do not claim full `npm test` success if the existing long-running
environment-sensitive suites still fail.

## Completion Record

- Delivered persistent file-backed Web sessions, safe browse/activate behavior,
  one live `MetaclawSession`, stable Planner session ID reuse, and structured
  HTTP/WebSocket session protocols.
- Replaced the permanent split layout with a fixed session rail, full-width
  Conversation/Trajectory canvas, detailed streamed execution narrative,
  searchable trajectory table, responsive mobile rail, and shared composer.
- Preserved the trace privacy boundary: no hidden reasoning, raw prompts,
  credentials, raw tool values, or raw process output are persisted or rendered.
- Validation: 45 focused tests passed; root `npm run lint` and `npm run build`
  passed; Web TypeScript and Vite build passed.
- Runtime smoke: `node dist/index.js web restart --port 8788 --no-open`
  stopped the prior PID, started the replacement, served `/` with HTTP 200, and
  returned the active catalog from authenticated `/api/sessions`.
- Browser smoke: authenticated desktop layout showed the session rail,
  Conversation/Trajectory tabs, full canvas, and sticky composer without
  overflow.
- Full `npm test` was not rerun because the repository contains known slow and
  environment-sensitive suites.
- Closing implementation commit: `2237fa4`.
