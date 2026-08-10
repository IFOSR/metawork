# Planner Initial Memory Context

Status: completed
Plan date: 2026-07-15
Completion date: 2026-07-15

Delivered:

- `PlanningContext.initialContext` now carries bounded confirmed global memory and bounded current-session conversation history.
- `MemoryContextService.preparePlanningInitialContext()` owns retrieval, filtering, shaping, and the `top_k_preferences` limit.
- `MetaclawSession` assembles the block once before each `PlanningAgent.plan()` call.
- The Codex Planner prompt explains evidence precedence and prevents embedded memory content from overriding authorization, tool, or system rules.
- Direct replies remain persisted interactions and are recalled on the next turn.
- Pending/unconfirmed global memories are excluded.

Validation performed:

- `npm run lint` — passed.
- Focused Docker tests — 3 files, 18 tests passed.
- Full Docker suite — 172 files and 764 tests passed; 2 files / 4 tests skipped by existing configuration.

Implementation/closing commits: not created; changes remain in the working tree for user review.

## Goal

Inject bounded confirmed long-term memory and recalled conversation history once at the start of each `PlanningAgent.plan()` turn. Later direct replies remain persisted as interactions and are recalled through the same conversation-history path on subsequent turns.

## Scope

- Extend `PlanningContext` with a read-only initial context block.
- Build that block in the memory domain from confirmed global memories and bounded current-session conversation history.
- Attach it before invoking `PlanningAgent`; do not move memory policy into `PolicyKernel`.
- Keep the existing task-execution `MemoryContextService.prepareExecutionContext()` path unchanged.
- Include the block in the Codex planner prompt.
- Add public-session behavior tests for memory-aware direct replies and subsequent conversation-history recall.
- Update the accepted ADR and current technical overview to match runtime behavior.

## Validation

- Focused tests run in Docker because storage tests require Linux `better-sqlite3`.
- Host `npm run lint`.
- Full Docker test suite when focused behavior is green.
