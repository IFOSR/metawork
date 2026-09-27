# Navigation Performance Architecture Remediation Implementation Plan

Status: Active Delivery. Implementation and closure acceptance are not complete.
Plan date: 2026-09-26.
Completion date / closing commit: pending.

**Goal:** Make Workspace switching, Conversation switching, Conversation creation, and historical Conversation loading bounded, indexed, and independent of unrelated historical data volume.

**Architecture:** Keep the existing durable Conversation, Gateway, Task, Kernel, and Execution facts as authoritative sources, but introduce one materialized Workspace/Conversation directory projection owned by the Workspace/Application layer. Navigation reads that projection instead of rebuilding activity from all Tasks or replaying every Conversation journal. Conversation attach uses a bounded snapshot plus paged history; the event journal remains an audit/recovery source rather than the primary navigation database.

**Tech Stack:** Node 22, TypeScript ESM, SQLite/better-sqlite3, Gateway v2, Web HTTP/WebSocket client, vendored AnyFusion-Pi MetaWork TUI, existing migration and focused-test infrastructure.

---

## 1. Non-Goals And Invariants

The following must remain unchanged:

- `ControlKernel` remains the only strategic decision owner.
- Planner, Runtime, Task, Execution, Gateway, Web, and TUI ownership from ADR-0020 remains unchanged.
- Conversation journals and Task/Kernel facts remain durable audit/recovery sources.
- Conversation Workspace binding rules remain owned by the existing domain:
  ADR-0035 permits rebinding an empty Conversation before its first ordinary
  Query; afterward it is immutable. Navigation itself never reparents a
  Conversation, and read-model adapters may not add their own binding policy.
- Navigation must never mutate Task, Kernel, Executor, slot, billing, or attempt state.
- A stale client response must not overwrite a newer Workspace or Conversation selection.
- Existing Web/TUI protocol versioning, replay cursors, and reconnect semantics remain compatible or receive an explicit protocol revision.

The following are explicitly not acceptable as the primary fix:

- A request-local or process-local cache without an invalidation/rebuild contract.
- Increasing page size or reducing event payloads while retaining full catalog scans.
- Removing activity information from the UI.
- Making the UI wait longer or hiding the loading state.
- Replaying the complete journal and then slicing the result in the client.

## 2. Target Read/Navigation Model

The target data flow is:

```text
Durable Conversation/Task/Attempt/Planner facts
  -> Workspace Directory Projection
  -> indexed Workspace page/query
  -> Web/TUI bounded directory view

Conversation facts
  -> bounded Conversation Snapshot Projection
  -> attach/reconnect

Conversation turns
  -> paged History Store/reader
  -> visible turn pages only
```

The directory projection must contain enough data to render a Workspace list without opening a Conversation journal or scanning all Tasks:

```text
accountId
workspaceId
conversationId
title
preview
createdAt
updatedAt
archived
activityState
activityTaskId
activityUpdatedAt
projectionVersion
```

The projection is a read model. It does not become a second owner of lifecycle semantics. Activity state is produced by the canonical Task lifecycle projection and stored as a bounded summary.

## 3. Phase 0: Baseline And Instrumentation

### Task 0.1: Add request-stage timing without changing behavior

**Files:**
- Modify: `src/management/server.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/workspace/workspace-directory-service.ts`
- Modify: `src/gateway/file-event-journal.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/workspace/workspace-directory-service.test.ts`

Record bounded diagnostic counters and durations for:

- catalog read;
- activity projection;
- Workspace authorization;
- directory filtering/sorting;
- journal read/parse/replay;
- Conversation record read;
- presentation read;
- history enrichment;
- billing/task/artifact projection;
- number of directory items, Tasks, and replayed events.

Do not log user input, raw model output, credentials, artifact contents, or full IDs.

### Task 0.2: Establish production-shaped performance fixtures

Create test fixtures representing:

- `3,114` catalog entries with `3,017` unbound legacy entries;
- several Workspaces with 1, 40, and 100 Conversations;
- thousands of unrelated Tasks;
- a 700 KB Conversation journal;
- a multi-megabyte Web presentation record.

The fixture must be generated in a temporary directory/database and must not touch `~/.metawork`.

### Task 0.3: Capture baseline and define budgets

Measure:

- Workspace select;
- Workspace directory first page;
- Conversation attach;
- first history page;
- new Conversation;
- Web historical record load.

The permanent requirement is that latency scales with returned page size and selected Conversation size, not with unrelated catalog/Task count. Initial local targets should be confirmed from the baseline; proposed targets are:

- Workspace directory first page: p95 under 300 ms;
- empty Conversation creation: p95 under 300 ms;
- bounded Conversation attach: p95 under 500 ms;
- first history page: p95 under 300 ms;
- no request performs more than one directory projection query or one selected-Conversation snapshot read.

## 4. Phase 1: Materialized Workspace Directory Projection

### Task 1.1: Define the projection contract and owner

**Files:**
- Create: `src/workspace/workspace-directory-projection.ts`
- Create: `src/workspace/workspace-directory-projection-repo.ts`
- Modify: `docs/current/task-lifecycle-state-contracts.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Test: `tests/workspace/workspace-directory-projection.test.ts`

Define:

- one projection row per Conversation;
- indexed query by `accountId`, `workspaceId`, `archived`, `updatedAt`, and `conversationId`;
- deterministic sort order;
- cursor format that is stable under concurrent upserts;
- explicit projection version;
- rebuild and consistency-check operations.

The projection owner is the Workspace/Application layer. It consumes canonical TaskView/activity facts and must not reimplement Task lifecycle rules.

### Task 1.2: Add durable indexed storage and migration

**Files:**
- Modify: `src/storage/migrations.ts`
- Create: `src/storage/workspace-directory-projection-repo.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/storage/migrations.test.ts`
- Test: `tests/storage/workspace-directory-projection-repo.test.ts`

Add a schema migration for the projection table and indexes. The migration must:

- be transactional;
- be restart-safe;
- not rewrite or delete Conversation journals;
- support an empty or partially built projection during startup recovery;
- expose projection version and rebuild status.

Do not migrate the production database during implementation testing. Use a
temporary copy or fixture database. The September 26 baseline measured a
212,860,928-byte main SQLite file (about 203 MiB); the earlier 26 GB observation
was the entire data directory, not the database.

### Task 1.3: Build a startup/rebuild projector

**Files:**
- Create: `src/workspace/workspace-directory-projector.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/workspace/workspace-directory-projector.test.ts`

The projector must:

- import Workspace-bound Conversation metadata;
- exclude or separately classify unbound legacy Conversations;
- derive activity using the canonical `TaskView`/activity contract;
- process in bounded batches;
- be resumable after interruption;
- publish a projection-ready fact only after the index is queryable.

Startup must not block Server readiness on an unbounded synchronous rebuild. The Server may serve a clear “directory rebuilding” state, but must not fall back to the old O(N x Task) request path.

### Task 1.4: Convert directory reads to indexed reads

**Files:**
- Modify: `src/workspace/workspace-directory-service.ts`
- Modify: `src/management/web-session-catalog.ts`
- Modify: `src/gateway/workspace-gateway-runtime.ts`
- Test: `tests/workspace/workspace-directory-service.test.ts`
- Test: `tests/gateway/workspace-gateway-runtime.test.ts`

Replace `readCatalog().map(project()).filter().sort().slice()` with an indexed repository query. Requirements:

- filtering and pagination happen in the repository;
- the query never calls `getConversationActivity()` per row;
- query cost is independent of unrelated Workspace/Conversation count;
- Workspace authorization checks one requested Workspace by ID rather than listing and re-authorizing every Workspace;
- `list_workspace_conversations` returns a bounded page and cursor.

### Task 1.5: Update the projection incrementally

**Files:**
- Modify: `src/workspace/workspace-directory-service.ts`
- Modify: `src/account/account-runtime.ts`
- Modify: `src/account/account-runtime-composition.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Test: `tests/account/account-runtime.test.ts`
- Test: `tests/workspace/workspace-directory-projector.test.ts`

Update only the affected Conversation projection when:

- a Conversation is created, renamed, archived, or bound;
- Planner activity starts/ends;
- TaskView/activity changes;
- a Replan Job or retry wake changes the visible phase;
- an active attempt starts/settles.

The activity projector must receive a conversation-scoped fact or use a precomputed account projection. It must not scan all Tasks once per Conversation.

## 5. Phase 2: Remove Replay And Refresh Multiplication

### Task 2.1: Remove directory-time N+1 replay

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/web-session-catalog.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

`projectMetadata()` must use Workspace binding already present in directory metadata. `workspaceFor()` may remain only as a compatibility fallback for a single legacy detail record, never for directory listing.

Add a test that listing 100 Conversations causes zero Conversation journal replays.

### Task 2.2: Stop persisting duplicate Workspace snapshots on reads

**Files:**
- Modify: `src/gateway/workspace-gateway-runtime.ts`
- Modify: `src/gateway/file-event-journal.ts`
- Modify: `src/gateway/server.ts`
- Test: `tests/gateway/workspace-gateway-runtime.test.ts`
- Test: `tests/gateway/file-event-journal.test.ts`

Workspace snapshot publication must distinguish:

- projection changed: append/update durable snapshot;
- client selected Workspace: send current snapshot to that connection;
- directory query: return current indexed page without appending a journal event.

Selecting a Workspace must not append an identical snapshot merely because a client navigated there.

### Task 2.3: Collapse Web Workspace switch into one authoritative response

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/server.ts`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

The Workspace selection response must include:

- selected Workspace;
- active Conversation ID, if any;
- first bounded Conversation page;
- page cursor;
- projection version.

Remove the mandatory follow-up `GET /api/workspaces` and `GET /api/workspaces/:id/conversations` sequence from the switch path. Keep those endpoints for refresh/recovery, not normal selection.

### Task 2.4: Make activity updates row-scoped

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/App.tsx`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/reducer.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

An activity change must update one Conversation summary. It must not call `listSessions()` or rebuild the entire Workspace directory.

## 6. Phase 3: Bounded Conversation Attach And History

### Task 3.1: Define bounded attach snapshot

**Files:**
- Modify: `src/gateway/event-journal.ts`
- Create: `src/gateway/conversation-snapshot-store.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `src/gateway/client-protocol.ts`
- Modify: `src/gateway/client-events.ts`
- Test: `tests/gateway/conversation-gateway-runtime.test.ts`
- Test: `tests/gateway/conversation-snapshot-store.test.ts`

Attach/reconnect must return:

- current Conversation metadata;
- current live Turn projection;
- bounded terminal/result/artifact summary;
- latest sequence/cursor;
- explicit snapshot version.

It must not replay every historical event on an ordinary Conversation switch.

Full replay remains available only for explicit audit/recovery tooling, never
for navigation cursor recovery. Stale/invalid or over-budget reconnect cursors
receive a negotiated reset plus bounded snapshot and reload indexed history.
Explicit incremental event ranges must also respect the segment/byte budget.

### Task 3.2: Make history paging the only initial history path

**Files:**
- Modify: `src/server/server-composition.ts`
- Modify: `src/gateway/conversation-gateway-runtime.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/controller.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/reducer.ts`
- Test: `tests/gateway/conversation-history.test.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/reducer.test.ts`

On attach:

- load only the newest bounded history page;
- preserve the history cursor;
- load older pages only on explicit user scroll/action;
- never attach and then separately perform an unbounded replay.

The history reader must use a store/index that can locate page boundaries without parsing the entire Conversation record.

### Task 3.3: Split Conversation history storage from the aggregate record

**Files:**
- Create: `src/session/conversation-history-store.ts`
- Modify: `src/session/file-conversation-store.ts`
- Modify: `src/storage/file-conversation-presentation-store.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/session/conversation-history-store.test.ts`
- Test: `tests/storage/file-conversation-presentation-store.test.ts`

Use one of these bounded layouts, selected during implementation design review:

- one file per turn/chunk with an indexed manifest; or
- a dedicated SQLite history table with `(account_id, conversation_id, sequence)` index.

The chosen design must support:

- newest-page reads without parsing all turns;
- append without rewriting the full historical presentation;
- atomic turn replacement by ID;
- restart-safe migration from current JSON records;
- compatibility reads during migration.

### Task 3.4: Batch historical enrichment

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/management/execution-projector.ts`
- Modify: billing projection repository/service files
- Test: `tests/management/web-gateway-session-runtime.test.ts`

For a history page:

- resolve Task IDs in one batch;
- load timelines in one batch;
- load artifacts in one batch;
- load billing projections in one batch;
- enrich only the visible page.

Do not call billing/task/artifact projection once per historical Turn.

## 7. Phase 4: Fast Conversation Creation

### Task 4.1: Make create return the created summary directly

**Files:**
- Modify: `src/gateway/workspace-gateway-runtime.ts`
- Modify: `src/workspace/workspace-directory-service.ts`
- Test: `tests/gateway/workspace-gateway-runtime.test.ts`

Remove the post-create `listConversations({ query: conversation.title })` lookup. The create operation already has the canonical Conversation metadata; it should construct the directory summary directly or read one projection row by ID.

### Task 4.2: Separate creation from activation

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `web/src/App.tsx`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/controller.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/controller.test.ts`

New Conversation flow:

```text
create -> durable metadata -> bounded empty snapshot -> client selects it
```

It must not synchronously:

- rebuild the full Workspace directory;
- read the Conversation twice;
- perform a full journal replay;
- emit a full session catalog refresh.

### Task 4.3: Fix catalog mutation atomicity

**Files:**
- Modify: `src/workspace/workspace-directory-service.ts`
- Modify: `src/session/file-conversation-store.ts`
- Test: `tests/workspace/workspace-directory-service.test.ts`

Create/archive/update currently use read-modify-write of the entire catalog. Serialize all catalog mutations through one repository operation or migrate metadata mutation to the indexed store. Add a concurrent-create test to prevent lost updates.

## 8. Phase 5: Event Journal Redesign

This phase follows the bounded projection work. It must not be used to postpone the directory/attach fixes.

### Task 5.1: Replace full JSON rewrite with appendable segments

**Files:**
- Modify: `src/gateway/file-event-journal.ts`
- Create: `src/gateway/event-journal-segment-index.ts`
- Modify: `src/gateway/event-journal.ts`
- Test: `tests/gateway/file-event-journal.test.ts`

Target behavior:

- append does not read and rewrite the entire Conversation file;
- replay after a cursor reads only the snapshot plus required segments;
- segment metadata records first/last sequence;
- compaction is background and restart-safe;
- duplicate event IDs remain idempotent;
- stale cursors receive a bounded snapshot and explicit cursor reset.

### Task 5.2: Add compatibility migration and crash tests

**Files:**
- Modify: `src/gateway/file-event-journal.ts`
- Test: `tests/gateway/file-event-journal-recovery.test.ts`

Cover:

- old JSON journal read;
- interrupted segment write;
- duplicate append;
- partial compaction;
- process restart;
- stale cursor;
- concurrent append serialization.

## 9. Phase 6: Client Rendering And Request Convergence

### Task 6.1: Web request-count tests

**Files:**
- Modify: `web/src/App.tsx`
- Create/modify: Web component/API tests

Assert that:

- Workspace switch does not immediately issue redundant workspace/conversation GETs;
- Conversation activation performs one bounded attach and one visible history read;
- new Conversation does not refresh the entire directory;
- activity update changes one row;
- stale switch responses cannot replace newer state.

### Task 6.2: TUI navigation tests

**Files:**
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/controller.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/reducer.ts`
- Test: corresponding controller/reducer tests

Assert that:

- Conversation attach does not require full journal replay;
- history page loads are bounded;
- older history loads only after explicit action;
- cursor/reconnect behavior remains correct;
- the selected Conversation remains stable during background activity.

## 10. Acceptance And Rollout

### Required automated gates

- `npx tsc --noEmit`
- focused Workspace projection, Gateway, history, Web runtime, and TUI tests
- migration tests from current JSON/catalog format
- production-shaped performance fixtures
- full test suite without new failures

### Required live acceptance

Use the actual installed Server and the real local account data, without deleting or rewriting production state:

1. switch between all existing Workspaces;
2. switch among an empty, normal, and largest historical Conversation;
3. create a new Conversation;
4. load older history pages;
5. reconnect Web and TUI;
6. update activity from a running/background Task;
7. restart Server during projection rebuild and journal compaction.

Collect:

- endpoint wall time;
- number of SQL/file reads;
- replayed event count;
- response bytes;
- client render/commit duration;
- projection lag;
- cursor correctness;
- no duplicate or missing Conversation entries.

### Rollout order

1. Phase 0 instrumentation and baseline.
2. Phase 1 indexed directory projection.
3. Phase 2 remove replay/N+1 and duplicate refreshes.
4. Phase 3 bounded attach/history.
5. Phase 4 fast create and catalog mutation hardening.
6. Phase 5 journal redesign.
7. Phase 6 Web/TUI request/render convergence.

Do not activate Phase 3 or Phase 5 before Phase 1 has a rebuild and recovery path. Do not remove legacy JSON reads until restart, migration, and rollback tests pass.

## 11. Completion Criteria

The work is complete only when all of the following are true:

- Directory query cost depends on requested page size, not total catalog or Task count.
- Workspace directory listing performs zero per-Conversation Journal replays.
- Ordinary Conversation attach does not replay the complete historical journal.
- First history page does not parse the entire historical aggregate record.
- New Conversation creation does not trigger full directory refresh or full replay.
- Web and TUI consume the same bounded Gateway/read-model contracts.
- Projection rebuild is resumable and restart-safe.
- Legacy unbound Conversations remain readable but do not slow Workspace-bound navigation.
- All current Task/Kernel/Attempt/slot/billing semantics remain unchanged.
- Performance evidence is recorded with the actual installed Server, not only unit-test timing.

## 12. Delivery Checkpoint (2026-09-26)

This is a progress record, not a completion or deployment claim.

- Existing installed Server baseline, four Workspaces, one sample each:
  select 11,436–12,278 ms; directory 5,155–6,072 ms; attach 5,207–5,966 ms;
  historical record 2–158 ms. Tests were also running during this sample.
  These are individual samples, not statistically reliable p95 measurements.
- `scripts/benchmark-navigation.mjs` provides repeatable endpoint timing;
  creation requires explicit `--create`. It does not claim browser rendering
  or TUI acceptance.
- Request-local, opt-in diagnostics and batched canonical activity projection
  are implemented. Directory listing no longer replays every Conversation.
- Concurrent catalog mutation regression reproduced: twelve creates retained
  only one catalog entry. Catalog writers now share a serialization boundary.
  This does not claim transactionality across record/presentation/catalog files.
- Schema 43 adds a Workspace-owned durable directory projection, rebuild
  checkpoint, per-Workspace revision and source-change invalidation queue.
  SQLite adapter persists identities, not lifecycle policy. The Application
  projector consumes canonical activity facts in bounded batches.
- Pagination uses a scoped keyset and a directory revision. A changed directory
  returns `stale_directory_cursor` explicitly; clients must restart from the
  first page, not append a silently inconsistent page.
- Bootstrap still parses the legacy catalog once outside request handling.
  Rebuild yields between batches; incomplete projections reject reads with
  `directory_rebuilding`. The legacy non-indexed service path remains for
  isolated consumers during delivery; production composition injects the index.
- Remaining gates include full client pagination/reset handling, attach/history,
  journal redesign, Web/TUI request convergence, deployment and live acceptance.
  No release has been installed or restarted for this work.

## 13. Indexed History And Review Checkpoint (2026-09-26)

This is still Active Delivery. No completion date or closing commit is claimed.

### Implemented In Source

- Schema 43 also contains account/Conversation-scoped metadata and history
  indexes. History uses the SQLite option in Task 3.3: one stable insertion
  sequence per Turn, keyset older-page cursors scoped to account, Conversation
  and history kind, atomic legacy import, and in-place Turn replacement.
- A durable per-Conversation write intent closes the aggregate-file/history
  index crash window. Readers replay it before serving metadata or a page;
  injected failure after the file commit is recovered on reopening.
- Web history reads the newest ten canonical terminal Turns and overlays rich
  presentation for visible IDs. This includes TUI-only Turns that have no Web
  presentation. Earlier pages load on explicit action. A newest-page refresh
  preserves previously loaded overlapping history and its older cursor.
- Web metadata reads and production TUI history use indexed ports; fixture
  assertions verify that paging does not call the aggregate Conversation reader.
  Legacy import remains a one-time selected-Conversation cost.
- The snapshot/segment implementation has ports, SQLite index, immutable
  segment files, permanent event-ID deduplication, atomic index commit, bounded
  current-Turn snapshot, and explicit compaction tests. **It is wired only in
  the isolated navigation fixture.** Production still constructs
  `FileEventJournal`; bounded attach is not yet a production closure claim.
- Independent review found five client/projector ordering defects. Regressions
  now cover delayed activity publication overwriting newer Planner state,
  A/B/A selection while B is pending, invalidation before search cache reuse,
  row-event reconciliation over stale HTTP pages, and search-aware row updates.
- A final ownership check corrected the plan's overbroad binding invariant:
  ADR-0035 and the existing domain permit empty pre-first-Query rebinding.
  The directory reflects that authorized metadata change and invalidates both
  Workspace cursors; it does not add a second binding policy. Workspace
  projection on attach also uses metadata rather than hydrating history.

### Validation Recorded

- Root and Web TypeScript checks passed.
- The stable broad navigation/domain rerun passed **792 tests in 138 files**.
  The preceding run had one source-shape assertion for the replaced
  active-selection shortcut; its expectation now requires both active identity
  and pending navigation. After the final binding/metadata correction, another
  focused six-file run passed **31 tests**, including its two new regressions.
- The vendored TUI controller/reducer/selector/wire suite passed 59 tests.
  This is not live installed-TUI acceptance.
- The isolated fixture now includes 3,017 unbound metadata entries, 1/40/100
  Workspace Conversations, 3,000 unrelated Tasks, a multi-MB rich presentation,
  and a legacy journal containing 45 large terminal answers.
- Real HTTP acceptance verifies paging all 45 Turns with no duplicates, no
  aggregate record reads after import, and no journal replay during bounded
  fixture attach/history. One local sample: directory 3.9 ms, ordinary attach
  59.7 ms, large cold attach 209.7 ms, large first history page 62.4 ms, create
  252.4 ms. These are individual fixture samples, not p95 or production results.
- Actual browser actions against that temporary Server verified 100 directory
  entries in two pages, ten initial historical Turns, all 45 Turns after explicit
  older-page actions, visible first/last conclusions, correct rapid A/B/A
  selection, and an empty newly created Conversation with an enabled Composer.
  Reload/reconnect restored the selected large Conversation, ten latest Turns,
  the older-page action and enabled Composer. The browser error list was empty.
  An actual authenticated WebSocket test received row-scoped activity through
  the canonical Workspace stream without a directory query.
- The earlier full suite ran concurrently with source edits and module caching:
  2,710 passed, 11 failed, 11 skipped. One failure loaded the earlier migration
  module against the newer history test. Other failures require a stable
  rerun/baseline comparison; this result does **not** establish no new failures.

### Remaining Acceptance Gates

1. Complete physical batching of Task/timeline/artifact/billing enrichment, not
   only page-bounded or per-Task memoized reads.
2. Finish create/activate read-count convergence and startup request convergence.
   Catalog mutation is serialized but still rewrites its legacy metadata file.
3. Review history backfill across mixed legacy/basic/rich records and TUI
   oversized-page/result/artifact/billing preservation before snapshot cutover.
4. Wire the segmented journal into the single production composition only after
   explicit stale-cursor reset, byte-bounded maintenance, orphan cleanup,
   interrupted compaction, migration and rollback acceptance. Current compaction
   is explicit; background maintenance is not yet installed.
5. Complete directory consistency/deletion reconciliation and TUI directory
   pagination/reset acceptance, plus installed browser/live-Task acceptance.
6. Rerun the stable full suite and compare residual failures against the baseline.
7. Install through the canonical updater, then run the real-account Web/TUI
   before/after and restart gates in Section 10. No production database,
   installed release, Server process or user Task has been changed by this work.
   The temporary fixture Server and its browser session were closed after tests.

## 14. Production Wiring And Closure Checkpoint (2026-09-26)

This checkpoint supersedes the source-wiring and batching limitations recorded
in Section 13. Status remains Active Delivery until the installed acceptance
gates below pass; no completion date or closing commit is claimed.

### Delivered Contracts

- Production composition uses one `SegmentedEventJournal` through
  `createAccountEventJournal`. The legacy JSON journal is an import source only.
  Append, event-ID deduplication, sequence watermark, snapshot and historical
  Turn/Task observations commit through one SQLite transaction after immutable
  bodies are durable. Background compaction and orphan cleanup are bounded and
  drain before storage shutdown.
- Reconnect negotiates `bounded_replay_v1`. Future, expired and over-budget
  cursors explicitly reset the client to a bounded snapshot plus indexed
  history. Resume opens at most 16 segments and 256 KiB of bodies; navigation
  never falls back to a full audit replay.
- Selected historical Task views use a Gateway-owned, account/Conversation/Turn
  observation index, not only the current-Turn snapshot. Legacy import retains
  conflicting Task evidence and original observation order. This projection
  cannot authorize execution or become Task lifecycle authority.
- Visible-page enrichment is physically batched. Populated SQLite tests measure
  12 billing-family reads for both one and ten Turns, and six timeline-family
  reads (seven including narrow Task selection) for both one and ten Tasks.
  Kernel plan identity normalization also uses one page-scoped query rather
  than deserializing every selected Task's decision ledger.
- Canonical Turn input, answer and terminal status take precedence over stale
  rich-presentation stubs; trace, artifact and billing enrichment remain intact.
  Empty creation avoids the redundant initial write intent while retaining
  crash recovery for metadata/history initialization.
- Web startup configuration initialization no longer overwrites a newer search
  or socket directory page. TUI directory requests, paged history and all three
  cursor-reset reasons use correlated requests and navigation generations.
  Directory rebuild is fenced against concurrent observations and reconciles
  removals before declaring the projection ready.
- Workspace activity publication and user-Workspace lookup use indexed
  metadata, never the aggregate history solely to recover a Workspace binding.
- Native update and manual rollback use an upgrade-ID-bound journal-body
  companion with a complete marker, index identity checks and SHA-256 hashes.
  Restore validates all bodies/destinations before publishing missing files,
  never overwrites conflicts, and runs before pointer activation. This is
  point-in-time rollback, not preservation of post-upgrade writes (ADR-0030).

### Isolated Performance And User-Flow Evidence

The temporary fixture contains 3,017 unbound Conversations, Workspaces initially
containing 1/40/100 Conversations, 3,000 unrelated Tasks and 45 large historical
answers. No production state is used or mutated by this fixture.

Ten samples per Workspace, with the originally selected Conversation pinned
across repeated creation, produced these endpoint p95 ranges:

| Action | Fixture p95 across three Workspaces |
| --- | --- |
| Select Workspace | 5.4-12.0 ms |
| Directory first page | 3.9-7.2 ms |
| Ordinary attach | 56.4-78.0 ms |
| Ordinary history page | 4.5-8.8 ms |
| Empty creation | 223.1-283.5 ms |

A separate ten-sample large-history test switched away before each attach:
attach median 67.6 ms, p95 321.9 ms; history first-page median 42.0 ms,
p95 58.8 ms. The first-page response was 1,569,726 bytes and contained exactly
the newest ten Turns. These are fixture measurements, not installed-account
p95 or controlled before/after proof.

Actual browser actions against the fixture verified all 45 conclusions through
four explicit older-page loads; reload/reconnect restored the newest ten,
older-page action and enabled Composer. Creation issued one POST without a full
directory refresh. Search found a Conversation beyond the first 50 rows.
Workspace selection used one selection POST without redundant directory GETs.
The browser error list was empty. Single click-to-render observations were
252.5 ms for large history and 267.5 ms for creation, not rendering p95.

The real Unix socket Gateway/TUI-controller test paged all 13 long Unicode
answers with byte-for-byte content equality and zero audit replay calls.
Process-level SIGKILL fixtures cover legacy import, append and compaction
around the SQLite commit boundary. Companion tests cover restoration after
compaction, missing/corrupt backups and pointer-preserving failure.

### Final Regression And Installed Baseline

- Stable navigation regression: **784 tests in 120 files passed**, including
  the production historical Task callback and metadata-only activity callback.
  The final vendored Gateway/TUI regression passed **156 tests in 10 files**.
  Root and Web typechecks passed.
- The broad full run completed with **2,858 passed, 11 failed, 11 skipped**
  across 461 files. Nine failures were individually reproduced on the clean
  `e02c430` worktree: billing finality, configuration module boundary, five
  session routing/output files (six assertions), and the InputController call
  shape. The other two are newly added release-rollback guard tests collected
  during their red/green implementation; the repaired five-test transaction
  suite passes. Installer integration verification is still in progress.
  This is not a claim that a single final frozen-tree full run was green.
- An additional installed baseline used the existing schema-42 Server and
  four real Workspaces, three samples per action, without creating Tasks or
  Conversations. Workspace-select medians were 12,252.7-13,791.6 ms;
  directory medians 6,127.3-6,837.2 ms; attach medians 6,453.9-7,018.2 ms.
  Tests were running concurrently, so these are small-sample, loaded-host
  measurements, not controlled p95 estimates.
- Peer review identified two installer closure defects: interrupted activation
  recovery bypassed segment restoration, and repeated rollback selected a
  historical checkpoint by filename rather than activation lineage. Both are
  being covered at the transaction/updater seams before any installation.

### Remaining Closure Gates

1. Finish final stable root/Web typechecks, focused Server/Gateway/installer/TUI
   regressions and full-suite baseline comparison after source edits stop.
   Baseline classification is recorded above; do not classify any additional
   failures without reproducing them on the clean baseline.
2. Install through the canonical updater only after the implementation and
   recovery gates pass. The installed `app/current` has not yet been changed.
3. Perform Section 10's real-account Workspace/Conversation switching, creation,
   older-history and Web/TUI reconnect checks, then record installed timings.
4. Exercise real background activity and restart during rebuild/compaction in
   the installed acceptance environment. Automated/fixture coverage is not a
   substitute for these gates, and no paid AI task is needed for navigation-only
   measurements.

The temporary fixture Server and browser sessions were closed after their
checks. Production data, installed release and production Server remain
unchanged at this checkpoint.

## 15. Installed Acceptance And Admission-Store Extension (2026-09-27)

Schema 43 was built and activated through the canonical `metawork build`
transaction as `1.2.0-preview.5-build-e02c430-1790443185756`; the sole
`app/current` Server was started and gracefully restarted. This supersedes
earlier statements that no installation had occurred. SQLite `quick_check`
passed, and all 122 done / 38 cancelled Tasks retained their original states.

### Installed Evidence

- Ten samples per existing Workspace: select medians 104.5-129.0 ms,
  directory medians 2.9-3.5 ms, attach medians 13.0-59.4 ms; attach p95
  247.0-302.4 ms and first-history p95 6.4-22.2 ms.
- The real Web client paged a 26-Turn Conversation as 10/20/26 unique Turns.
  All IDs matched the retained source; all answers, including system-command
  results, rendered. Reload restored the newest ten, older-page action and
  enabled Composer. The largest 2.77 MB legacy rich record rendered three
  answers and three bill cards; first cold attach/import was 525 ms and its
  history request 137 ms. Browser errors were empty.
- The installed TUI rendered historical answers and PageUp scrolled earlier
  content. Its default page is bounded to 50 Turns / the Server byte budget.
  A ten-Turn-page controller using the installed modules and real Unix socket
  verified 10/20/26 paging twice across disconnect/reconnect, exact answer
  equality and exhausted cursors.
- Five empty acceptance Conversations were created, without submitting AI
  work. Four endpoint samples were 393.9-448.2 ms; one browser request was
  488.1 ms with no directory refresh. The provisional 300 ms creation target
  is **not met**, so this is not closure.
- One retained historical Task correctly failed the account check: its
  `legacy-account` / `legacy-conversation` ownership already exists in the
  pre-upgrade schema-42 database. Navigation must not bypass isolation or
  silently reassign historical ownership to hide this pre-existing condition.

### Additional Bottleneck And Approved-Goal Alignment

Installed acceptance exposed a remaining O(account-history) path outside the
directory/history indexes: `FileCommandAdmissionStore` parses and rewrites all
account admissions for each reserve/transition, including Workspace selection
and Conversation creation. The inspected file contained 1,719 admissions and
2,621,562 bytes. Merely meeting a small fixture budget would leave navigation
latency growing with continued use.

Extend the same bounded-read implementation, without changing command policy:

1. Gateway retains ownership of `CommandAdmissionStore`, fingerprints,
   idempotency receipts and its pending/submitted/terminal/uncertain contract.
   Storage supplies an indexed SQLite adapter; the composition root injects
   it. Do not add a router, admission state or alternative recovery policy.
2. Store one command per `(account_id, idempotency_key)` with a recoverable-state
   index. Preserve terminal receipts and first Conversation assignment exactly.
   Point reads/updates must not parse unrelated commands or rewrite an account
   aggregate.
3. Import every legacy admission, including terminal deduplication evidence,
   once in a transaction with its account import marker. Retain legacy files
   unchanged as point-in-time downgrade inputs; never leave two writers.
4. Schema 43 is already installed, so add a transactional **43-to-44** migration
   and update Docker/migration tests. Do not alter schema 43 in place.
5. Cover transition equivalence, identity conflicts, concurrency, rollback of
   interrupted import, restart, query plans/read counts with thousands of
   unrelated terminal commands, and a real Gateway duplicate-command test.
6. Re-run canonical installation and real-account navigation/create/reconnect
   acceptance after this extension. Correct stale TUI reconnect error hints
   observed after a successful Server reconnect at the client presentation
   seam, without changing durable command or Task state.

The earlier full-suite/baseline evidence remains historical. Final acceptance
must explicitly name the schema-44 build and its validation; no closing commit
or completed-plan status is recorded yet.

## 16. Historical Task Association Fix (2026-09-27, Source Checkpoint)

Status at this source checkpoint: implemented and locally validated; the
overall plan remains Active Delivery. Section 17 supersedes this checkpoint's
deployment status. No closing commit is claimed.

- The production `getTaskView` callback no longer uses the current-Turn
  snapshot to recover historical trace-only Task associations. It reads one
  Account/Conversation/Turn observation and its consistent journal watermark.
  Normal navigation has no full-replay fallback.
- Gateway owns the pure observation fold and both ports. Storage persists its
  opaque JSON in the provisional schema-43 `gateway_turn_task_observations`
  table, atomically with segment/event identities and the stream watermark.
  The existing 42-to-43 transaction creates the table; installed schema 42
  and production files were not touched.
- Envelope OR payload Turn identity, first/latest trace times, latest
  completion/progress fields, and conflicting evidence retain the existing
  resolver semantics. At most two distinct Task IDs are retained per Turn:
  later observations cannot erase ambiguity. This is a presentation read
  model, not lifecycle authority.
- Legacy retained import builds observations once. Duplicate appends,
  sequence reservations, database reopen, and segment compaction preserve
  them. Injected multi-Turn append/import failures roll back observations,
  segment indexes and watermarks together.
- Validation: 24 focused association tests across four files pass, including
  execution of the actual production callback and an independent pre-change
  resolver-equivalence oracle. Another 71 tests across seven files pass for
  migrations, journal recovery/maintenance wiring, read-only queries and
  segment backup. Root and new-test TypeScript checks pass. Full-suite stable
  integration and installed acceptance remain with the main delivery gates.
- No billing implementation, TUI, or snapshot-store byte-limit code was
  changed by this fix.

## 17. Schema-44 Installed Checkpoint

Status: Active Delivery. The implementation below is installed, but final
acceptance is not closed. Completion date and closing commit remain pending.
This section supersedes earlier source-only and schema-43 deployment notes.

### Delivered And Installed

- The canonical updater built and activated
  `1.2.0-preview.5-build-e02c430-1790448097030`. The sole production entry remains
  `~/.metawork/app/current/dist/index.js`; no workspace-dist Server or parallel
  deployment was introduced. The prior schema-44 acceptance build was
  `1.2.0-preview.5-build-e02c430-1790446368974`.
- Schema 44 adds the separate 43-to-44 admission tables without changing the
  already installed schema-43 definition. All 1,719 legacy terminal admissions
  were imported with one account marker. Invalid terminal receipts, identity
  conflicts and interrupted marker commits fail closed. Legacy JSON remains
  read-only. Gateway fingerprints, first Conversation assignment and recovery
  states are unchanged.
- Web restores the latest authorized selection after reauthentication, consumes
  launch intent only once, coalesces hello/startup history reads, and fences
  stale lifetime, navigation, socket-selection and cleared-search responses.
  An off-page remembered Conversation first uses a Workspace-fenced attach,
  then reads history. The real Server's active-only history contract is
  preserved; a mock that allowed pre-attach history reads was corrected.
- TUI removes only its own transient reconnect failure notices after successful
  recovery. Recovery generations prevent a late failed connection attempt from
  overwriting a newer successful recovery or navigation.
- The HTTP performance fixture now uses the real `ClientGateway` and indexed
  admission adapter with 3,000 unrelated terminal commands, rather than
  bypassing admission. Eight process-level directory tests kill real child
  processes around batch/completion commits and a bounded deletion sweep,
  supplementing the journal's process-crash gates.

### Observed Acceptance

- Installed database `quick_check` passed. Existing Tasks retained their
  original states: 122 done and 38 cancelled. No AI Task was submitted for
  navigation acceptance.
- Twenty schema-44 endpoint samples across four Workspaces: select median
  **6.1 ms**, p95 **8.1 ms**; directory median **3.8 ms**, p95 **4.8 ms**.
  The largest directory response in this run was 21,576 bytes.
- Creation: twenty samples, median **278.7 ms**, p95 **332.7 ms**, maximum
  **343.0 ms**. Therefore the provisional p95 <300 ms target is **not met**.
  These samples and four later diagnostic samples created 24 empty
  Conversations. Their logged identities, persisted empty records, unchanged
  metadata and absence of Tasks were checked before normal API archival.
  Pre-existing history was not deleted.
- The same run's selected rows were earlier empty acceptance Conversations:
  attach median 4.9 ms / p95 149.9 ms; empty history median 4.6 ms / p95 6.2 ms.
  These are **not** rich historical attach measurements and must not be
  presented as a like-for-like comparison with the schema-42 history baseline.
- A separate latest-build run selected substantive nonempty Conversations:
  ten samples in each of three Workspaces while full regression was running.
  Attach medians were **6.2-60.4 ms**, with per-Workspace p95 **26.7-181.7 ms**;
  history medians were **9.9-14.3 ms**, with p95 **11.7-22.6 ms**. The fourth
  Workspace had no substantive Conversation and was excluded explicitly.
  The largest rich Conversation's latest Web load used exactly one attach
  (247 ms) and one history request (89 ms), rendering three answers and three
  bill cards with no uncaught browser errors.
- Real Web history again paged 10/20/26 unique Turns with 10/20/26 rendered
  answers, an exhausted older cursor and an enabled Composer. Real Server
  restart followed by login restored the selected Workspace, the same three
  rich answers and three bill cards; Composer and new-Conversation controls
  were enabled.
- Real installed PTY TUI observed socket ENOENT while Server was stopped,
  returned to ready with the same completed Turn, cleared the obsolete footer
  error, and scrolled to earlier answer content with PageUp.
- Final installed TUI modules, connected to the real Unix Gateway with a
  ten-Turn page size, again produced 10/20/26 pages on two independent
  connections. All identities and answers exactly matched retained source,
  and both cursors exhausted correctly.
- The latest installed HTTP attach guard rejects a mismatched expected
  Workspace without exposing inactive history (404), then accepts the correct
  Workspace and returns ten Turns plus the older-page cursor.
- Final browser interaction check alternated an existing empty Conversation
  and the rich three-Turn Conversation for five rounds. Click-to-ready
  measured through DOM convergence plus two animation frames was
  **249.9-300.3 ms** (median **255.0 ms**) for the rich Conversation and
  **31.6-159.5 ms** (median **32.6 ms**) for the empty one. Each rich load
  retained three answers, three bill cards and an enabled Composer. Every
  switch issued exactly one attach and one history request, with no directory
  request or uncaught browser error. This is a small headless-browser
  interaction sample under full-suite load, not a controlled browser p95.
- A production-shaped creation timing probe measured approximately 51 ms for
  the Conversation write, 51 ms for the catalog write and 47 ms for each of
  two durable journal appends. The preceding catalog read was approximately
  5 ms. This identifies durable writes as substantial remaining latency;
  removing file/directory synchronization is not an acceptable optimization.

### Validation And Remaining Gates

- Source checkpoints: 976 navigation/installer focused tests passed; 60
  admission/schema/Docker-contract tests passed before the additional strict
  receipt tests; the strict adapter/export/Gateway selection passed 46 tests.
  Final attach/client/recovery coverage passed 380 tests in 56 files.
  Independent review of the final Workspace-fenced attach passed 129 tests
  across four files with no remaining findings in that scope.
  Root and Web typechecks passed, and the canonical build rebuilt all surfaces.
  Counts overlap and must not be summed into a total.
- A broad schema-44 run was intentionally interrupted after live acceptance
  exposed the pre-attach history contract mismatch. It is not a successful
  full-suite result. The final frozen-code run completed across **470 files**:
  **2,979 passed, 9 failed, 11 skipped** (2,999 tests; approximately 26 minutes).
  Each of the nine failed assertions matched its test identity and failure
  headline in the clean `e02c430` baseline evidence; there were no additional
  failed assertions or suite-only failures. These are the existing bill-finality,
  configuration-module-boundary and seven Session assertions (including two
  in task-boundary-round3). The run exits nonzero and is not an all-green
  suite. This supersedes Section 14's earlier full-run counts.
  Evidence: `/tmp/metawork-navigation-final-full.json` and the
  `/tmp/metawork-navigation-baseline*.json` reports.
- The provisional creation p95 budget remains open. Catalog mutation is
  serialized as permitted by Task 4.3, but its aggregate write is not a
  constant-size metadata write. A future optimization must preserve durable
  source ownership and crash recovery, not bypass the write or relax receipt
  durability.
- Live running/background-Task activity and precisely timed production
  interruption during rebuild/compaction have not been exercised. Isolated
  real-process SIGKILL and live idle-Server restart tests do not replace those
  Section 10 gates. Docker container execution was unavailable due to the
  registry token timeout; schema/Docker workflow contract tests did run.
- Final runtime verification still reports schema 44, `quick_check=ok`,
  122 done Tasks and 38 cancelled Tasks. The canonical Server remains running
  on the release named above; acceptance Browser and TUI clients were closed.
  No production Task facts were edited to manufacture active-work or recovery
  evidence. Documentation and `git diff --check` are aligned; no closing commit
  has been made.

## 18. Realtime Terminal-State Convergence Correction (2026-09-27)

Status: source correction implemented and installed Web/TUI acceptance passed.
This section records the PDF issue in which a Task
had already completed and produced its report, but the live Web card stayed
`running` until a page refresh.

### Root Cause

The live Web runtime had two different inputs:

- `InteractionTrace` events drove the visible Turn status;
- the durable `ExecutionTimeline` drove execution details and was re-read
  during history enrichment.

`WebGatewaySessionRuntime` projected the second input only as an `execution`
event. It did not reconcile `RuntimeTurnState.status` from a terminal
`ExecutionTimeline`. If the terminal trace event was late, filtered by Task
attribution, or absent after reconnect, the live status remained `running`;
a refresh then appeared to fix the problem because historical enrichment
derived status from the durable timeline.

### Delivered Correction

- The runtime now projects the durable ExecutionTimeline before mapping the
  incoming trace event.
- A terminal timeline (`done`, `failed`, `blocked`, `cancelled`, or equivalent
  delivery stage) monotonically closes a still-running live Turn.
- Existing terminal Turns are never reopened by a late progress event.
- The correction uses the existing Task/Execution projection and does not add
  a second lifecycle owner or mutate durable Task state.

Regression coverage:

- `tests/management/web-gateway-session-runtime.test.ts`: a live Turn remains
  running while execution is active, then receives a terminal Task timeline
  and is projected as `completed` without refresh.
- Existing cancelled-Turn, late-trace, Gateway replay, history enrichment,
  and execution projection tests remain green.

Validation: `npx tsc --noEmit`, `git diff --check`, 109 Gateway/management/
trace/projector tests, and the 92 Retry Wake/Span integration tests passed.
The canonical installed Server was not changed by this source checkpoint.

### 18.1 Durable Progress In The Trajectory Projection (2026-09-27)

The PDF also exposed a second projection mismatch: the live execution card
continued changing while the Trajectory event table stopped at an older event
count. Executor progress is durably retained in
`ExecutionTimeline.progressHistory`, while the table was reading only
`InteractionTrace.events`. These are intentionally different presentation
facts, so copying one lifecycle state machine into the other would create a
second owner and would not be correct.

The correction keeps the existing ownership split and makes the Trajectory
surface render `ExecutionNarrative` in addition to the event table. The
narrative combines trace milestones with the durable attempt progress history,
so progress that arrives through the execution projector remains visible while
the live Task is running and after reconnect. The Conversation surface remains
compact and does not render the detailed narrative.

Regression coverage:

- `tests/web/trajectory-view.test.ts` asserts that Trajectory consumes the
  shared execution narrative.
- Existing execution-projector, Web runtime, trace-stream and live-card tests
  remain green.
- `AccountRuntime` activity projection now safely degrades when an optional
  dispatch-fact repository is unavailable; its activity state remains governed
  by the canonical lifecycle projector.

Source validation for this correction: `npx tsc --noEmit`, `npm run build`,
`git diff --check`, and the focused Web/Gateway/management/account suites
passed. The isolated native Gateway/Web/TUI smoke passed. The full suite
completed with 3,123 passed, 9 baseline failures, and 12 skipped; the failure
set is identical to the recorded baseline. The canonical Server was rebuilt
and restarted successfully on the new release, with a ready endpoint manifest.

### 18.2 Client-side Execution Timeline Convergence (2026-09-27)

The previous correction still left a client-side race: the Web `execution`
event updated only `executionTimeline`, while Turn status was updated only by
`trace_delta`. If a durable terminal timeline arrived without a terminal trace
delta, the live page could remain `running` until a history reload rebuilt the
Turn. The same issue existed in the retained `WebConversationProjector`, where
a late `running` timeline could reopen a terminal projection.

The delivered correction adds one presentation reducer, `mergeExecutionTimeline`,
which applies the exact Task identity guard and projects terminal timeline
states into the live Turn. Terminal Turn states are monotonic; the reducer does
not allow a late `running` timeline to reopen a completed, failed, or cancelled
Turn. Retry recovery remains explicit: a blocked Turn may return to `running`
only when the durable timeline represents a valid retry continuation.

Regression coverage:

- `tests/web/conversation-live-turn.test.ts`: terminal timeline convergence and
  late-running non-reopen behavior.
- `tests/management/web-conversation-projector.test.ts`: retained projector
  terminal monotonicity while preserving `waiting_retry` recovery.

Validation after this correction: both focused suites pass (18 tests), the
canonical TypeScript/build pass, the installed Server is ready, and the
isolated native Web/TUI/Gateway smoke passes. The full-suite nine-failure set
is unchanged from baseline. Real Span API smoke remains unexecuted because no
Span credential is configured in this environment.
