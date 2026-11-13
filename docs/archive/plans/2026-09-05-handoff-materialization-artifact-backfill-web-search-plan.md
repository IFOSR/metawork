# Declaration-Independent Materialization + Web-Search Steering

- Date: 2026-09-05 (evening)
- Status: Delivered 2026-09-05. Revised per user review: declarations are not
  a second source of truth — Runtime-owned facts (workspace delta, graph
  edges, result objects) are the only authority (user-authorized). Validation:
  tests/execution + tests/kernel + tests/executor 350 green;
  gateway/management/web/session-focused 403 green; lint clean.
  ADR-0021 amended with the declaration-independent materialization note.
- Context: after the interaction-trace dedupe fix (`boundedId` hash), three
  known gaps remain. This plan covers all three; the trace backfill is
  deferred as optional hardening (see
  `2026-09-05-artifact-registration-and-trace-backfill-plan.md` §2).

## Fix A — Artifact registration backfill (preview gap, problem 1)

### Root cause (verified)

Publication only registers artifacts **declared in the executor completion
JSON** (`workspace-publication-worker` → `UserArtifactPublicationService.sources`).
The pi-research attempt wrote `wechat-channels-extraction-research-2026-09.md`
but declared nothing, so `task_artifacts` stayed empty and every downstream
preview surface (Web 任务产物 panel, `/api/artifacts/:id/preview`, inline
answer links, Feishu cloud-doc sync) had no data. The file is already
recorded in `executor_attempt_runtime.workspace_delta_json`
(`changed[].beforeHash === null`).

### Design (as delivered)

The completion protocol already derives `normalizedArtifacts` from the
workspace delta — the real bug was a hard rule: `deliveryKind === 'report'`
force-emptied the artifact list. **Deleted the special case**: output-area
files now register for every delivery kind (existence/containment validation
unchanged, deleted paths never register, edit-only noChangeReason semantics
untouched). No filter lists, no new merge logic — the existing chain
(publication → UserArtifactPublicationService → task_artifacts → Web/Feishu
surfaces) picked the change up with zero downstream edits.

### Tests

- Unit (worker/publication seam): undeclared `.md` in delta → registered and
  copied; declared+discovered dedupe; filters applied; discovery failure is
  non-fatal.
- E2E (existing publication test seam): research-style attempt → artifact
  row exists with `previewKind: markdown`.

## Fix B — Missing edge-scoped handoff after contract correction

### Root cause (verified from kernel events, 2026-09-05 18:54 run)

The research subtask's primary completion was `completion_malformed`
(uncertified) → contract correction → correction completed → source marked
`done`, but **no `subtask_handoffs` row exists for the edge** to the
write-report subtask, because handoff rows are inserted during publication
integration **only from the completion envelope's declared `handoffs`**, and
neither the malformed primary nor the response-only correction declared one.
Dependency readiness then hard-blocks: `missing_handoff` (terminal).

Two systemic gaps:
1. Completion verification does not validate that every outgoing dependency
   edge has a declared handoff — a handoff-less completion passes.
2. Dependency materialization treats `missing_handoff` as terminal even when
   the source has a complete, safe result object that fully satisfies the
   edge's intent.

### Design (as delivered)

**The Work Graph edge is the handoff authorization.** At publication
integration, Runtime materializes a default `result_reference` handoff row
for every outgoing edge that has none, backed by the source attempt's safe
projection (`materializeEdgeHandoffs` in `workspace-publication-worker.ts`;
declared handoffs and edge-materialized ones share `insertEdgeHandoff`).
Edges without any result object still block terminally — fail-closed for
genuinely absent results. No new violation kinds, no correction-loop patches:
the whole `missing_handoff`-for-undeclared-envelopes bug class is deleted.
ADR-0021 amended.

### Tests

- RED unit: correction-path completion without handoffs → B1 violation
  surfaces; correction envelope declaring the handoff → passes.
- Kernel decision tests: `missing_handoff` + safe result → synthesize +
  dispatch proceeds; `missing_handoff` + no result object → terminal block
  preserved.
- Regression: today's exact incident shape (malformed primary → correction →
  edge to write-report) completes end-to-end in the execution test seam.

## Fix C — Steer attempts to `web_search` instead of bash+curl

### Finding

Live reproduction showed pi-research running `bash` + `curl` against Bing
**and DuckDuckGo** (exit=28 timeout, 25 s each) even though the attempt home
ships the `web_search`/`web_fetch` extension with the Bing→Baidu chain.
The extension can't help if the model routes around it.

### Design (as delivered)

User tightened the steering: `web_search` is the mandated primary channel;
curl/wget is the explicit fallback only when `web_search` reports
网络不可用. Delivered in both surfaces: the attempt context boundary rules
(`prompt-builder.ts`) and the extension's own tool description/guidelines
(`pi-agent.ts` PI_WEB_EXTENSION_SOURCE).

### Tests

- Prompt builder unit test: web-tools attempts include the rule; non-web
  attempts unchanged.

## Sequencing and validation

1. Fix A (~0.5 day) → 2. Fix B (~1 day, includes ADR note) → 3. Fix C (~0.2 day).
4. Full focused suites + lint; redeploy via `metawork server stop && metawork
   build && metawork server start`; user-perspective re-run of a research
   task to confirm preview + streaming + no missing-handoff block.
