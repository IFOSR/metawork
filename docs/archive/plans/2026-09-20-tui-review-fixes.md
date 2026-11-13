# Unified TUI Review Fixes

Status: Implemented; automated verification passed
Plan date: 2026-09-20

## Goal And Boundary

Close the ten findings from the single-TUI implementation review under the
already approved ADR-0041/design. Preserve the Gateway v2 wire contract,
Server ownership, Web and Feishu behavior. No storage migration, new semantic
router, restored legacy TUI, or automatic commit.

## Implementation Sequence

Each step adds a regression test, observes its failure, implements the fix,
and reruns the affected tests before proceeding.

1. Fix the vendored `anyfusion/gateway-socket-transport.ts` event parser and
   `gateway-client.ts` connection-stream classification. Test real Unix socket
   frames and reconnect cursor isolation.
2. Fix completion event-before-receipt ordering in `metawork-tui/controller.ts`.
   Test both response orders and superseded requests.
3. Connect Workspace commands and the Conversation selector through the existing
   Gateway methods in `controller.ts` and `app.ts`. Test navigation without a
   current Workspace, selection, and creation from the actual UI actions.
4. Wire Task queries on opening/selecting a Task. Extend the safe client read
   model, adapter and Dashboard to consume existing routing/Attempt DTO fields.
   Test actual key actions and snapshot-driven rendering.
5. Fix stale Task snapshots, immutable Turn/Task association, pending input
   correlation, running history records, history order and selected viewport
   in `reducer.ts`, `protocol-adapter.ts` and `conversation-panel.ts`.
6. Require fresh authoritative Task facts before permission actions; clear
   missing permissions and avoid treating admission as authoritative resolution.
7. Separate Gateway entry dispatch from the local runtime import graph. Preserve
   Planner RPC behavior and add a transitive dependency boundary regression.
8. Run the vendored focused tests/build, root lint and Gateway/Web/Feishu/
   architecture regressions. Record exact results and remaining validation gaps.

## Validation Commands

- `npm --prefix planner/AnyFusion-Pi/packages/coding-agent test -- test/metawork-tui-controller.test.ts test/metawork-tui-reducer.test.ts test/metawork-tui-app.test.ts test/metawork-tui-render.test.ts`
- `npm --prefix planner/AnyFusion-Pi run build:offline`
- `npm run lint`
- `npm test -- tests/gateway tests/web tests/architecture tests/integrations`

## Closure

Completion date: 2026-09-20.

Delivered behavior:

- Both read-only response kinds pass the actual Unix socket parser and never
  change the active Conversation replay target. Completion responses arriving
  before admission receipts are buffered and matched without replaying an
  already-consumed wire event.
- Workspace selection and Conversation list/select/create use the existing
  Gateway methods. The selector is wired into the actual application focus
  tree, and per-Conversation drafts are connected to editor changes.
- Task opening, Turn selection and incoming progress refresh the read-only
  Task view; in-flight refreshes retain a dirty follow-up. Existing safe
  routing and timeline Attempt fields are normalized and rendered. Stale
  snapshots cannot roll back newer Turn facts or change a bound Task ID.
- Running history retains user input, admitted local requests correlate by
  request ID, latest/older history are queried separately, and overlapping
  history pages merge around shared IDs and Server timestamps for disjoint
  newest pages. History can advance a nonterminal
  Turn to a terminal status without reopening terminal Turns.
- Turn selection moves the visible history window. PgUp/PgDn scroll bounded
  conversation and Dashboard viewports independently while the editor keeps
  focus; long answers do not scroll the wide-screen Dashboard away.
  Task result metadata does not
  invent an active result transfer.
- Permission panels/actions require a fresh matching Task response. A null
  pending permission clears stale local state. Admission does not mark an
  authorization as resolved.
- `main.ts` dispatches modes without importing runtime modules; `main-runtime.ts`
  retains the non-Gateway CLI behavior. HTTP dispatcher setup remains in the
  runtime path. Presentation source metadata no longer imports package-manager
  types, and an AST-based dependency test traverses the client graph.

Validation (2026-09-20):

- Observed initial failing regressions for the ten findings, then passing fixes.
  Independent review found four additional related edge cases; added failing
  tests and fixed in-flight refresh, latest history merge/status and result
  metadata handling. Follow-up review also covered disjoint newest history
  pages and Dashboard visibility beside long answers; both have regression tests.
- Vendored Pi: 15 focused test files, 120 tests passed (TUI controller/reducer/
  rendering/keyboard/selector/preferences, actual Unix socket transport,
  Gateway client, Planner policy/bootstrap, RPC and HTTP dispatcher).
- Root: 80 test files, 540 tests passed (Gateway, Web, Feishu integrations,
  architecture, independent client lifecycle and unified runtime integration).
- Smoke-script contract test: 1 test passed. Final targeted architecture/native
  TUI/protocol mirror rerun: 15 tests passed.
- `npm --prefix planner/AnyFusion-Pi run build:offline`: passed.
- `npm run lint`: passed.
- `git diff --check`: passed.

Compatibility: this follow-up does not modify production code under `src/` or
`web/`, shared Gateway payload contracts, database schemas or Feishu handlers.
The vendored runtime entry move is covered by build and focused Planner/RPC
tests; it does not change the server-side Planner policy.

Not executed in this follow-up: live Feishu delivery, a real provider-backed
Planner/Executor smoke, Docker validation, or manual native-terminal acceptance.
Keyboard/render tests use the actual Pi TUI with an injected terminal; transport
tests use real Unix sockets with a controlled peer. Those tests are not a claim
of external-service end-to-end acceptance.

Closing commit: none; user has not requested a commit.

## Follow-up: Task Binding During No-op

Status: Implemented; automated verification passed.
Started: 2026-09-20. Completion date: 2026-09-21.

The September 20 native run exposed a presentation bug while an Executor
result awaited publication. `no_op` correctly requested no additional runtime
action, but its action payload had no Task target. The execution trace adapter
emitted `taskId: null`, and `InteractionTraceStream` incorrectly cleared the
Turn's existing Task binding. A concurrent TUI `get_task_view` request then
failed with `turn_task_mismatch`.

Delivered behavior:

- Execution decision traces without an action Task target use the existing
  execution request's `contextTaskId`, without changing the Kernel decision.
- Null or absent event-local Task identity no longer clears the Turn binding.
  Starting a new Turn still resets the binding to null.
- Gateway ownership checks, execution scheduling, completion, Web/Feishu
  handlers, wire contracts and storage formats are unchanged.

Validation:

- Observed both new regressions fail before applying the production changes.
- Session/trace/execution regressions: 4 files, 55 tests passed.
- Gateway, Web, Feishu, Management projections and architecture regressions:
  80 files, 569 tests passed.
- `npm run lint` and `git diff --check`: passed.

This follow-up changes two shared Server presentation paths, unlike the
client-only review fixes above. Automated checks found no Web/Feishu regression;
live provider execution, external Feishu delivery and installed-runtime
acceptance were not repeated. The installed Server was not updated or restarted.

Closing commit: none; changes remain uncommitted.
