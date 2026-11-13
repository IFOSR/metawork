# Artifact Registration Backfill & Executor Trace Streaming Resilience Plan

- Date: 2026-09-05
- Status: Proposed — awaiting user review
- Trigger: 2026-09-05 user acceptance found (1) the research report file was
  not previewable anywhere despite the answer referencing it, and (2) the
  trajectory showed a 9-minute hole (17:39 → 17:48) with zero executor steps.

## 1. Problem 1 — Artifacts written but never registered

### Evidence (verified against production data)

- File exists and was integrated:
  `workspaces/<task>/<generation>/<subtask>/files/wechat-channels-extraction-research-2026-09.md`
  (plus the `__integration__` copy).
- `executor_attempt_runtime.workspace_delta_json` recorded it:
  `{"changed":[{"path":"wechat-channels-extraction-research-2026-09.md","beforeHash":null,...}]}`.
- `task_artifacts` has **no row** for it (only historical images).
- Web already has the full surface: `turn.artifacts` section in
  `ConversationTurn`, `/api/artifacts/:id/{preview,download,metadata}`,
  `findArtifactReferences` matching answer text to registered artifacts.
  Feishu already syncs registered text artifacts to cloud docs.

### Root cause

`user-artifact-publication-service` only registers artifacts **declared in
the executor completion JSON** (`Completion artifacts`). The pi-research
attempt wrote the report but did not declare it, so registration broke and
every downstream preview mechanism had no data.

### Proposed fix

1. **Workspace-delta backfill registration** (publication seam): after a
   successful attempt, union completion-declared artifacts with new files
   from `workspace_delta.changed` (`beforeHash === null`), filtered by:
   hidden files/dirs (`.pi/`, `node_modules/`, etc.), temp suffixes
   (`.tmp`, `.lock`, `.log`), and a size cap (e.g. 10 MB). Map extension →
   `media_type`/`preview_kind` (`markdown|text|code|image|unsupported`).
   Dedupe by relative path. Registration is idempotent per attempt.
2. No Web/Feishu changes needed — once registered, the existing artifact
   panel, inline preview links, and cloud-doc sync activate automatically.
3. Guardrail: backfill registration must never fail the publication; on
   error, log a trace event and continue with declared artifacts only.

### Validation

- Unit: publication registers delta-discovered files, applies filters,
  dedupes declared-vs-discovered, survives unreadable files.
- E2E: research-style attempt producing an undeclared `.md` → artifact row
  exists; Web `turn.artifacts` includes it; answer text links resolve to
  `/api/artifacts/:id/preview`.

## 2. Problem 2 — Executor step stream disappears mid-attempt

### Root cause (CONFIRMED 2026-09-05 evening, fixed)

**Id truncation destroyed event uniqueness in the interaction trace dedupe.**
`InteractionTraceStream.append` dedupes by
`interactionTraceEventId(turnId, kind, eventKey)`, and `boundedId` truncated
each component to 160 chars. Production attemptIds are ~188 chars (they embed
the full 64-hex task id plus hashes), so `${attemptId}:progress:N` and
`${attemptId}:heartbeat:N` differ only past char 160 for every N. Every
executor progress/heartbeat event after the first collapsed onto the same
dedupe id and was silently dropped — for **every** attempt, reproducibly.

Evidence chain: raw attempt output yields 251 parseable progress events
(driver + filter healthy); the attempt runtime repo recorded them all (no
dedupe there); the trace turn stayed `running` throughout; HTTP probes during
a live reproduction proved the event loop responsive; repo progress kept
updating while the trace stayed silent; heartbeats were suppressed because
`lastProgressAtMs` kept refreshing — the "both dead" paradox resolved without
any event-loop stall. The earlier stall theory (event-loop freeze / SQLite
lock / machine sleep) was investigated and **disproven**.

Fix: `boundedId` now keeps a bounded head plus a deterministic sha256 digest
of the full value (length <= 160, uniqueness preserved; replay dedupe
contract intact). Regression tests in
`tests/session/interaction-trace-stream.test.ts` cover long eventKeys
(distinct suffixes must land; identical keys still dedupe). Validated: 393
tests green across management/web/gateway, lint clean.

### Remaining hardening (still valid, reprioritized)

1. **Settle-time trace backfill (should)**. With the dedupe bug fixed, live
   streaming works; backfilling from the persisted raw output on settle is
   now a robustness net (covers the worktree/container-compat path that has
   no line streaming, and any future silent-drop class) rather than the
   primary fix. Dedupe by `${attemptId}:progress:${sequence}` makes it
   idempotent against live events.
2. **File-tail watcher / event-loop probe**: downgraded to optional — no
   evidence of a real event-loop stall exists; skip unless new data appears.

### Side findings from the 2026-09-05 live reproduction

- (a) pi-research sometimes does web research via `bash`+curl (one
  DuckDuckGo curl timed out, exit=28) instead of the `web_search` extension —
  the extension is available; model behavior varies. Consider nudging the
  attempt contract to prefer `web_search` over ad-hoc curl.
- (b) After a contract-correction completion, the task blocked with "source
  is done but the edge-scoped handoff is missing" — a separate
  dependency-materialization gap on the correction path (P0-5 family),
  tracked separately.

## 3. Effort estimate

| Item | Scope | Estimate |
|---|---|---|
| 1. Artifact delta backfill | publication service + tests | ~0.5 day |
| 2. Settle-time trace backfill | attempt runner + tests | ~1 day |
| 3. File-tail watcher | runtime + tests | ~1 day |
| 4. Event-loop probe | diagnostics + trace event | ~0.5 day |

Recommended order: 1 (user-visible gap), 2 (closes the visibility hole),
then 3+4 together.
