# Web Turn-Task Presentation Isolation Implementation Plan

> **Status:** Completed
> **Plan date:** 2026-09-10
> **Completion date:** 2026-09-10

**Goal:** Keep Web Conversation summaries and Trajectory details scoped to the Task owned by the selected Turn.

**Architecture:** Add `turnId` to the passive execution projection, make Turn-to-Task binding monotonic, and centralize a read-only display projection that filters foreign Task events. Preserve all durable history and all concurrent Subtasks within the selected Task.

**Tech Stack:** Node.js 22, TypeScript ESM, React, Vitest.

---

### Task 1: Lock The Runtime Turn-To-Task Contract

**Files:**
- Modify: `src/management/web-session-runtime-types.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/ws.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/management/server.test.ts`

1. Add failing tests for `execution` events carrying `turnId`.
2. Add a failing test proving a foreign Task trace cannot replace a Turn's Task.
3. Run the focused tests and verify the expected failures.
4. Implement the minimal protocol and binding changes.
5. Run the focused tests.

### Task 2: Scope Conversation Cards And Trajectory Events

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/ConversationView.tsx`
- Modify: `web/src/components/LiveExecutionPanel.tsx`
- Modify: `web/src/components/TrajectoryView.tsx`
- Modify: `web/src/components/TrajectoryEventTable.tsx`
- Create: `web/src/turn-task-presentation.ts`
- Test: `tests/web/conversation-view.test.ts`
- Test: `tests/web/trajectory-view.test.ts`
- Test: `tests/web/turn-task-presentation.test.ts`

1. Add failing projection tests for mixed Task events and multiple current-Task Subtasks.
2. Add failing source contract tests for exact historical Turn selection.
3. Run the focused Web tests and verify the expected failures.
4. Add the minimal display projection and selected Trajectory Turn state.
5. Run the focused Web tests.

### Task 3: Rehydrate Existing Mixed History Safely

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

1. Add a failing read-session test containing a mixed historical Turn.
2. Filter foreign Task-bound events while preserving Task-neutral Turn events.
3. Verify the durable source record is not mutated.
4. Run the focused Management tests.

### Task 4: Documentation And Validation

1. Update `CONTEXT.md` with the Turn-to-Task presentation invariant.
2. Run focused Management, Server, and Web tests.
3. Run `npm run lint`.
4. Run `npm run build`.
5. Run `git diff --check`.
6. Record delivered behavior, validation, completion date, and closing commit status.

## Delivered

- Public execution events carry both `turnId` and `taskId`.
- A Turn's first authoritative Task binding is monotonic; foreign Task events
  cannot replace its identity, status, cards, artifacts, or timeline.
- Gateway replay snapshots aggregate trace events only within the latest Turn.
- Persisted `turn.taskId` is authoritative over a mismatched historical
  Timeline; inconsistent Timelines are excluded from presentation.
- Conversation execution cards and Trajectory events include only the selected
  Turn's Task while retaining every concurrent Subtask in that Task.
- Trajectory defaults to the latest Turn, and explicit historical navigation
  selects the exact Turn. Workspace or Conversation changes clear that
  selection.
- Existing mixed history is filtered at read time without deleting durable
  Task, trace, artifact, or audit facts.

## Validation

- `tests/gateway`: 218 passed.
- `tests/management`: 127 passed.
- `tests/web`: 77 passed.
- `tests/session`: 198 passed, 3 skipped, 1 unrelated existing failure in
  `tests/session/scripted-session.test.ts`; the stale assertion expects an
  uncertified safe result to leave a blocked Task.
- `npm run lint`: passed.
- `npm run build`: passed.
- `npm exec --prefix web tsc -- --noEmit -p web/tsconfig.json`: passed.
- `git diff --check`: passed.
- Read-only review: 0 Critical; all 3 Important findings fixed and covered by
  regression tests.

## Closing Commit

No commit was created; the worktree contains other in-progress changes.
