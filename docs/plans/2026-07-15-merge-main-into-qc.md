# Merge origin/main into QC + push to main

- Status: completed
- Plan date: 2026-07-15
- Completion date: 2026-07-15

## Delivered

Merged `origin/main` (3 commits, incl. `754103e`) into `QC` and resolved the conflict semantically.

- **Conflict resolved** in `src/session/metaclaw-session.ts`: kept QC's planner-first structure; main's `runConversationInput`/`setConversationRuntimeState`/`ConversationRuntimeService` path (and its orphaned `classifyMissingSemanticPriorities`/`getLlmTimeoutMs`/`awaitWithTimeout` helpers) are all dead in QC (no call sites survive the refactor) and were dropped. Ported the runtime-state intent into `deliverDirectReply` via a new `setDirectReplyRuntimeState(executorName)` helper that pins `runningExecutorName`/`lastEvent` while the planner reply is delivered and restores scheduler-backed state afterwards — executor name is `planning-agent` (QC's direct-reply executor), not `codex-cli`.
- **Feishu fix** (`feishu-app.ts` `sanitizeFeishuFinalReply`: `|| ''` → `|| reply`): auto-merged correctly by `git merge` (the merge-tree dry-run had been misleading). No manual edit needed.
- **TUI fix** (`app.tsx` `getComposerStatus` `runningExecutorName` branch + `runtimeSummary`): auto-merged correctly; compiles against the existing `RuntimeState.runningExecutorName` field.
- **Session test** `marks direct replies as active executor work…`: adapted to QC's planner-first model (no deferred writable executor). It now stubs `directReplyPlan({ response: { directReply: '最终回答' } })`, subscribes to snapshots to assert `runningExecutorName === 'planning-agent'` and `lastEvent === '普通对话由 planning-agent 生成回答'` while the reply is delivered, asserts the writable executor is never called and no task is created, and asserts `runningExecutorName` returns to `null` after the turn. Removed the now-unused `createDeferredExecutorResult` helper.

## Validation performed

- `npm run lint` (`tsc --noEmit`) passes on host.
- Docker full suite (`docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test`): **767 passed, 4 skipped** (2 test files skipped). Target files green: `tests/session/task-boundary-round3-acceptance.test.ts` (13 tests), `tests/tui/editor-submission.test.ts` (16 tests), `tests/integrations/feishu-app.test.ts` (72 tests).

## Note

Per user decision: committed locally only; no push. User will open the PR to `main` themselves.

## Goal

Merge the 3 incoming commits on `origin/main` (2 PR merges + `754103e fix: preserve Feishu direct replies and TUI executor status`) into the local `QC` branch, resolve the one real conflict semantically, recover a silently-dropped fix, then push `QC` to `main`.

The Feishu task-scope anchor tech debt (`docs/tech-debt/feishu-task-scope-output-anchor-debt.md`) is explicitly **out of scope** — confirmed unrelated to this conflict.

## Incoming changes (origin/main, 3 commits, +3/-35 ahead/behind)

- `754103e` — the only real change: Feishu direct-reply preservation + TUI executor status.
- `b62dccb`, `2fb0627` — PR merges already derived from QC; carry no net diff.

## Conflict analysis

`git merge-tree` reports exactly **1 textual conflict**: `src/session/metaclaw-session.ts`. The other 6 files auto-merge, but **`src/integrations/feishu-app.ts` auto-merges incorrectly** — git keeps QC's `|| ''` and silently drops main's one-line fix (`|| ''` → `|| reply`). Two files therefore need manual attention:

1. `src/session/metaclaw-session.ts` — textual conflict.
2. `src/integrations/feishu-app.ts` — silent semantic drop (no conflict marker).

### The architectural mismatch (the crux)

main's `754103e` modifies a `runConversationInput()` + `ConversationRuntimeService` path that **no longer exists in QC**. QC refactored to planner-first: direct replies go through `deliverDirectReply()` ([metaclaw-session.ts:905](src/session/metaclaw-session.ts#L905)), which only records `executorUsed: 'planning-agent'` and never calls a writable executor (`codex-cli`).

Consequence for the incoming tests:

- **`tests/tui/editor-submission.test.ts`** — pure unit test of `getComposerStatus` with a stubbed `runtimeState`. Architecture-independent. **Merges clean and passes as-is.** ✅
- **`tests/integrations/feishu-app.test.ts`** — `keeps direct-reply final answers that start with Markdown links…`. Tests the `feishu-app.ts` one-line fix. **Merges clean; passes once we recover the `|| reply` fix.** ✅
- **`tests/session/task-boundary-round3-acceptance.test.ts`** — `marks direct replies as active executor work while the executor is still answering`. This one **cannot pass verbatim in QC**: it stubs a *deferred codex-cli executor* and expects `runningExecutorName: 'codex-cli'` during a direct reply. In QC's planner-first model, a `direct_reply` plan never invokes the writable executor — the planner produces the reply synchronously in `deliverDirectReply`. This test encodes main's old architecture.

## Decisions

### D1 — Resolve the `metaclaw-session.ts` conflict: keep QC structure, port the *intent*

Keep QC's planner-first code as-is (do **not** resurrect `ConversationRuntimeService`/`runConversationInput`). Main's TUI fix needs `runtimeState.runningExecutorName` to be set during a direct-reply turn and cleared after. Port that intent into `deliverDirectReply`:

- The executor name for a direct reply in QC is `planning-agent` (already what `deliverDirectReply` records), not `codex-cli`.
- `deliverDirectReply` is currently synchronous and completes within `kernelDecisionApplier.apply()`. There is no async window where "executor still answering" is observable to the TUI in the same way main's deferred-executor test observes it.

Because `deliverDirectReply` is synchronous, setting then clearing `runningExecutorName` around it has no observable effect (set and clear happen before any subscriber can render). So the *minimal* faithful port is: set `runtimeState.runningExecutorName = 'planning-agent'` and `lastEvent` at the start of `deliverDirectReply`, emit, then restore via `refreshRuntimeState()`. This preserves the intent (TUI/Feishu see an active executor name during the turn) without faking a deferred executor.

### D2 — Recover the silently-dropped `feishu-app.ts` fix

After the merge, manually change [feishu-app.ts:1857](src/integrations/feishu-app.ts#L1857) `extractLatestTaskSummary(outputLines) || ''` → `|| reply`, matching main's `754103e`. Context is byte-identical between branches, so this is a clean one-line edit. Required for the incoming Feishu test to pass.

### D3 — Handle the session test that can't pass verbatim

The `marks direct replies as active executor work…` test asserts main's deferred-executor architecture. Options:

- **(Chosen) Adapt the test to QC's architecture.** Rewrite it to assert the QC contract: during a `direct_reply`, `runningExecutorName` becomes `'planning-agent'` (not `'codex-cli'`), `lastEvent` reflects the direct reply, and after the turn it returns to `null`. Drop the deferred-executor machinery (no writable executor is invoked). This keeps a real regression test for the ported behavior without faking an architecture QC doesn't have.

## Steps

1. **Fetch (done)** — `origin/main` is up to date locally.
2. **Merge** — `git merge origin/main` (no `--no-ff` needed; default merge commit). Expect conflict only in `metaclaw-session.ts`.
3. **Resolve `metaclaw-session.ts`** — keep QC version of the conflicting region; add a small runtime-state set/restore in `deliverDirectReply` (D1). Verify `app.tsx` auto-merged changes compile against the existing `RuntimeState.runningExecutorName` field (they will — field already exists).
4. **Recover `feishu-app.ts` fix** — apply the one-line `|| reply` edit (D2).
5. **Adapt the session test** — rewrite `marks direct replies as active executor work…` to QC's planner-first contract (D3).
6. **Type-check on host** — `npm run lint` (`tsc --noEmit`) is the only check that runs reliably on Windows. Fix any errors.
7. **Run storage-affected tests in Docker** — the session + feishu tests touch storage/SQLite, so they cannot run on the host. Build and run the suite in Docker:
   `docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test`
   Per AGENTS.md, path-extraction tests also only pass under Linux Docker.
8. **Commit** the merge with a conventional message, e.g. `merge: integrate origin/main preserving Feishu direct-reply and TUI executor status`.
9. **Commit only — no push.** The user will open the PR to main themselves. Stop after the local merge commit; do not push.

## Out of scope

- Pushing to `origin` (user handles PR).
- The Feishu task-scope anchor tech debt (`docs/tech-debt/feishu-task-scope-output-anchor-debt.md`) — confirmed unrelated to this conflict; separate effort.

## Validation

- `npm run lint` passes on host (type-check).
- Docker full suite passes, including:
  - `keeps direct-reply final answers that start with Markdown links…` (feishu)
  - `shows the active executor for direct replies that are not durable tasks` (tui)
  - adapted `marks direct replies as active executor work…` (session)
- No `CONFLICT` markers remain in any file.
- `git diff origin/main..QC` after merge shows only QC's 35 commits' worth of intended changes plus the merge resolution.

## Risks

- The adapted session test (D3) is a judgment call about QC's "correct" direct-reply behavior. If you'd rather keep the test asserting `codex-cli`, that would require routing direct replies through the writable executor — a larger architectural change that inverts QC's planner-first design and is **not** recommended for a merge.
- `deliverDirectReply` is synchronous; the set/restore of `runningExecutorName` around it has no async-observable window the way main's deferred-executor test had. The adapted test asserts the *final* post-turn state (`runningExecutorName === null`) and the during-turn state as set synchronously — which is all QC's model can honestly offer.
