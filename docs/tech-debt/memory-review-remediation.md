# Memory review findings — verification and remediation record

**Date:** 2026-10-22
**Scope:** Review of the ADR-0049 long-term memory implementation against
[the design](../plans/2026-10-22-memory-system-tdai-integration-design.md).

Every reported finding was verified against the source before any fix. The
verdict column records what the code actually does, including one finding whose
stated consequence was wrong.

## Verdict table

| # | Finding | Verdict | Note |
|---|---|---|---|
| P1-1 | Web cannot enable/disable memory or switch the extraction model | **Confirmed** | All four sub-claims correct; the entire settings deliverable was non-functional |
| P1-2 | No final deposition on Server shutdown | **Confirmed** | Design §5.2 lists `Server 关闭` as a fallback trigger |
| P1-3 | Sidecar process leaks when the health gate fails | **Confirmed** | Degraded runtime dropped the child reference |
| P1-4 | 100-turn batch sends 200 messages (engine limit 100) | **Confirmed** | Permanent per-conversation stall, because the cursor only advances on success |
| P1-5 | Account-level `x-tdai-user-key` not implemented | **Confirmed, severity overstated** | The header is only required on `/v3/meta/*`; the adapter never calls that plane, so no request is rejected. Real gap is design conformance, not auth failure → reclassified P2 |
| P1-6 | `LIMIT` applied before the completed-turn filter starves later turns | **Confirmed** | 100 consecutive non-completed turns permanently block the conversation |
| P1-7 | `autoStart` and `dataDir` parsed but never applied | **Confirmed** | `policy.maxChars` had the same defect |
| P2-1 | Scheduler rescans conversations already fully deposited | **Confirmed** | Candidate query never compares against the cursor |
| P2-2 | `degraded` dropped at the Planner seam | **Confirmed** | Violates design §6.1/§6.6 |
| P2-3 | Disabled memories stay visible to the Planner | **Confirmed** | Rejected later by eligibility, so the Planner wastes a reference |
| P2-4 | `source='sanitized'` never reaches an asset | **Confirmed** | Plus duplicated scanner rules, contrary to D11 ("reuse safety-scanner") |
| P2-5 | Health gate is defined three different ways | **Confirmed** | Adapter, sidecar and runtime disagreed |
| P2-6 | Sidecar restart timer races `stop()` | **Confirmed** | Timer handle was never retained |
| P2-7 | The `needs-model` tri-state cannot be persisted | **Confirmed** | Schema rejected what §7.2 describes |
| P3 | Sidecar inherits the whole Server environment | **Confirmed** | Credentials stayed out, but so did every unrelated secret |

Root causes: the runtime honored its **options** instead of the resolved
**policy** (P1-7, `maxChars`); the memory domain was written against the data
plane only while the design also describes the meta plane (P1-5); and the
feature was never wired into the configuration activation and shutdown
transactions (P1-1, P1-2).

## Remediation

| # | Fix | Location | Regression test |
|---|---|---|---|
| P1-1 | `memory.*` added to the hot-path classifier; the runtime is owned by `MemoryRuntimeController`, which rebuilds it on activation (and on activation rollback) only when the `memory` section changed, draining pending turns first; evidence delivery and the management view resolve the live runtime instead of a captured instance | `configuration-diff.ts`, `memory-runtime-controller.ts`, `server-composition.ts`, `memory-evidence-service.ts`, `memory-management.ts` | `memory-review-regressions.test.ts` (P1-1), `memory-runtime-controller.test.ts` (P1-1), `memory-settings-activation.test.ts` (whole journey against the real engine) |
| P1-2 | `stop()` drains before stopping: the scheduler waits for the in-flight tick, then `flushAll` deposits every conversation with undeposited turns, looping until drained | `memory-flush-scheduler.ts`, `memory-service.ts`, `memory-runtime.ts` | `memory-review-regressions.test.ts` (P1-2) |
| P1-3 | The runtime adopts the sidecar before probing, and stops it when the health gate closes | `memory-runtime.ts` | `memory-runtime-controller.test.ts` (P1-3) — asserts the child received SIGTERM |
| P1-4 | The batch is bounded by **messages**: `memory-turns-per-deposit = floor(100 / 2) = 50`; the adapter refuses an oversized batch and truncates a message beyond 8,192 characters | `memory-turn-source.ts`, `memory-adapter`, `memory-service.ts` | `memory-review-regressions.test.ts` (P1-4) |
| P1-5 | The account-level read-only user key is read from the SecretStore and sent as `x-tdai-user-key` when configured | `memory-runtime.ts` | `memory-runtime.test.ts` |
| P1-6 | Eligibility is filtered in SQL; when nothing eligible remains, the cursor skips past the ineligible tail | `memory-turn-source.ts`, `memory-service.ts` | `memory-review-regressions.test.ts` (P1-6) — 100 failed turns no longer hide turn 101 |
| P1-7 | `autoStart` gates the spawn and `sidecar.dataDir` overrides the account default; `retrieval.maxChars` now bounds the stored evidence body | `memory-runtime.ts`, `memory-runtime-policy.ts` | `memory-review-regressions.test.ts` (P1-7), `memory-runtime-controller.test.ts` |
| P2-1 | The candidate queries compare against the deposition cursor in SQL, and the overflow query counts only eligible turns | `memory-flush-cursor-repo.ts` | `memory-review-regressions.test.ts` (P2-1) |
| P2-2 | Deposition state records degraded recall; `search_memory` returns `degraded` plus a Planner-facing reason and advice | `memory-recall-repo.ts`, `planner-mcp-server.ts` | `memory-review-regressions.test.ts` (P2-2), `planner-memory-tools.test.ts` |
| P2-3 | `search_memory` inner-joins `memory_bindings` on `enabled = 1` | `planner-mcp-server.ts` | `planner-memory-tools.test.ts`, `memory-review-regressions.test.ts` (P2-3) |
| P2-4 | Deposition records whether the segment was sanitized; the cursor flag is sticky and drives `source='sanitized'` at bind time. When the originating conversation is unknown the account-level fact is used, so clean provenance is never claimed falsely | `memory-flush-cursor-repo.ts`, `memory-service.ts` | `memory-review-regressions.test.ts` (P2-4) |
| P2-5 | One `interpretEngineHealth` verdict shared by the adapter, the sidecar supervisor and the runtime gate: FTS5 **and** a healthy/absent status are required | `memory-sidecar.ts`, `tdai-memory-adapter.ts`, `memory-runtime.ts` | `memory-review-regressions.test.ts` (P2-5) |
| P2-6 | The restart timer is retained and cleared by `stop()`; the callback re-checks the stopping flag | `memory-sidecar.ts` | `memory-runtime-controller.test.ts` (P2-6) |
| P2-7 | The schema accepts the enabled-without-model state and still rejects a half-chosen pair; the settings payload omits empty refs instead of writing `''` | `schema.ts`, `web/src/config-edit.ts` | `memory-configuration.test.ts`, `tests/web/config-edit.test.ts` |
| P3 | The sidecar environment is an explicit allowlist (Node/proxy/TLS/locale variables plus the explicit engine values), not a copy of `process.env` | `memory-sidecar.ts` | `memory-review-regressions.test.ts` (P3) |

### Deliberate non-change

The scanner rules in `memory-sanitizer.ts` remain separate from
`learning/safety-scanner.ts`. The review noted the duplication; folding them
together would mean the retired candidate scanner's rules govern live memory
deposition, so the memory rules were kept explicit and are covered directly by
`memory-sanitizer.test.ts`. Consolidating them is a follow-up for when the
`learning/` domain is retired, not a behaviour fix.

### Schema

`schema_version` 53 adds `memory_flush_state` (cursor plus sticky sanitized flag)
and `memory_recall_state` (degraded flag). Version 52 installations are migrated
by carrying any existing `conversation_history_streams(kind='memory')` cursor
forward, so no segment is deposited twice.

