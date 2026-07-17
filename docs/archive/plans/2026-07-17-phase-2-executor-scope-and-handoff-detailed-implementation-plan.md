# Phase 2 Executor Scope And Dependency Handoff Detailed Implementation Plan

## Plan status

- Plan date: 2026-07-17
- Status: completed
- Parent plan: [Phase 2 overall action plan](2026-07-17-phase-2-executor-scope-and-dependency-handoff.md)
- Governing architecture: [ADR-0020](../../adr/0020-core-module-ownership-and-dependency-direction.md) and [ADR-0021](../../adr/0021-work-graph-v4-subtask-execution-contract.md)
- Completion date: 2026-07-17
- Implementation commits: `9783518` (`feat: isolate executor scope and dependency handoffs`) and `1472a3c` (`fix: keep phase 2 smoke on the api key path`)

## Objective

Complete roadmap Phase 2 by making the current Subtask the only executable scope, defining strict typed dependency handoffs, and binding each execution attempt to one WorkUnit. The runtime remains serial and does not implement retry, fallback, partitioning, or concurrency.

## Frozen contracts

- `PlanningAgentPlan` hard-cuts from schema v3 to strict v4.
- `dependencies` replaces `dependsOn` and carries a non-empty typed handoff contract on every edge. Supported item types are only `text` and `artifact`.
- Each Subtask declares keyed acceptance criteria and typed evidence references. Only direct dependency handoffs are injected.
- Every Executor response ends with a strict `<!-- metaclaw:completion:v1 -->` JSON envelope. The envelope is parsed, validated, persisted, and stripped from all user-visible and memory-facing output.
- A single Subtask execution context builder owns scope rendering. Top-level Task data is background; sibling IDs and titles are explicitly out of scope.
- Planner-selected evidence is injected with deterministic bounds. Codex and Pi may use an attempt-scoped read-only evidence port; unsupported executors receive only the selected evidence.
- Completion contract errors block the Subtask and Task without retry. Phase 3 adds one Kernel-authorized same-AgentClass correction attempt; Phase 4 generalizes recovery policy.

## Implementation sequence

1. Establish the independent Work Graph public seam, strict v4 schema, shared Planner/Kernel validation, and planner context identifiers.
2. Apply SQLite migration v22: preserve v3 graphs as read-only audit, park non-terminal v3 tasks, create v4 Subtask/handoff/attempt receipt storage, and add attempt-aware WorkUnit claims.
3. Implement the deep Subtask attempt module: claim, context construction, evidence access, one Adapter invocation, completion parsing, deterministic verification, atomic persistence, and release.
4. Cut Session and Executor callers over once, remove Task-level prompt/history passthrough, and aggregate only clean persisted Subtask output.
5. Validate focused contracts and migrations, run the Docker/Linux suite and real Planner-to-Executor smoke, then update and archive the Phase 2 plans.

## Acceptance gates

- One capability-complete task creates one Subtask, one attempt, one Executor invocation, and one artifact set.
- A dependent node receives only validated handoffs from its completed direct dependencies and never receives ordinary assistant/Executor history.
- Missing, extra, invalid, or oversized completion data deterministically blocks without exposing the raw envelope as successful output.
- Claim, running, receipt, result/error, and release facts carry the same Task/Subtask/attempt/WorkUnit identity.
- Completed handoffs are immutable recovery snapshots; completed nodes are never rerun or reparsed.
- `npm run lint`, focused Vitest, `npm run build`, the Docker full suite, and a real artifact smoke all pass and are recorded here before completion.

## Deferred work

- Phase 3: unified Kernel event/decision seam and one fixed handoff-format correction attempt.
- Phase 4: persistent retry counters, backoff, fallback, candidate exhaustion, and circuit breaking.
- Phase 5: partition/lease enforcement and a versioned `workspace_state` handoff type.
- Phase 6: asynchronous runnable-frontier dispatch.

## Implementation record (2026-07-17)

Delivered behavior:

- Added the independent `src/work-graph/` public contract and hard-cut Planning, Kernel, persistence, and Runtime to Work Graph v4.
- Applied SQLite v22 with read-only v3 audit, v4 Subtasks, immutable handoffs, Task evidence, terminal attempt receipts, attempt-aware WorkUnit events/claims, legacy-task parking, and the active-attempt uniqueness constraint.
- Added the single Subtask execution context builder, deterministic selected-evidence preview, attempt-scoped evidence authorization/port, Codex MCP transport, Pi extension transport, Completion Protocol v1 parser/gates, and the deep `SubtaskAttemptRunner` transaction boundary.
- Reduced Session to the serial ready-node shell and removed Task prompt/history/memory passthrough, handoff inference, receipt handling, and direct claim/release from Session and Executor Adapters.
- Clean Subtask Markdown is displayed once; completion envelopes never enter Interaction, Memory, delivery, or downstream context; Task completion aggregates persisted clean results, warnings, and deduplicated artifacts.
- Completion contract failures block without retry; `/task resume`, restart, and timers do not replan or retry a blocked attempt.

Validation completed:

- `npm run lint`: passed.
- Focused Docker Vitest for assistant-reference eligibility, Completion Protocol, Attempt Runner, WorkUnit claim, and smoke harness: 5 files / 23 tests passed.
- `npm run build`: passed and generated the v4 Planner schema.
- Final Docker/Linux suite: 182 files / 769 tests passed, with 2 files / 4 tests skipped (184 files / 773 tests total).
- Planner MCP smoke: passed with all six v4 tools.
- Real Codex Planner smoke: passed through the configured `docker/pi.env` API-key provider and called `get_runtime_state`.
- Real Planner → Kernel → Runtime → Codex Executor artifact smoke: passed; one Subtask produced one clean result and one artifact under the authorized Task target path.

The earlier refresh-token failure was a diagnostic-command error: the command copied personal Codex login files while failing to load the API key stored in `docker/pi.env`. No login is required by the production path. The final smoke uses the project runtime entrypoint, `anyint` provider, and `OPENAI_API_KEY`; it also verifies that the v4 generated schema contains no unsupported `oneOf` and that smoke artifacts target only the runtime-authorized directory.
