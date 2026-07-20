# Phase 2 Attempt Terminal And Work Graph Regression Fix Plan

- Status: In progress
- Plan date: 2026-07-20
- Governing roadmap: [Planner/Kernel concurrency convergence roadmap](2026-07-16-planner-kernel-concurrency-convergence-roadmap.md)
- Governing architecture: [ADR-0020](../adr/0020-core-module-ownership-and-dependency-direction.md) and [ADR-0021](../adr/0021-work-graph-v4-subtask-execution-contract.md)

## Scope

- Remove the Completion Protocol contract-failure raw SQL Task transition and perform the blocked
  transition only through the Task domain, preserving the unresolved dependency that freezes
  resume and scheduler eligibility.
- Complete `contract_blocked` and `cancelled_or_stale` attempt terminal projections: the Subtask
  must not remain `running`, the same attempt-bound WorkUnit must record `failed`, and release must
  clear the claim without converting that failure to `idle`.
- Restore the Phase 1 `mergeable_same_agent_chain` and `same_layer_preferred_conflict` pure Work
  Graph violations in the v4 public validator so Planner and Kernel consume the same rules.
- Replace source-text-only regression assertions with focused coordinator/attempt behavior tests
  that exercise persisted Task, Subtask, receipt, WorkUnit, event, and dispatch outcomes.

## Ownership And Interfaces

- Task terminal state remains owned by `TaskRuntimeService`/`TaskEngine`; Execution Runtime may
  invoke that domain command but must not update the `tasks` table directly.
- `SubtaskAttemptRunner` owns receipt, Subtask terminal projection, and the exact attempt-bound
  WorkUnit terminal fact. It does not decide retry, fallback, correction, or replan policy.
- `SessionExecutionCoordinator` remains the Phase 2 serial shell. For an attempt that already
  persisted its blocked Task state, it only clears dispatch, records presentation/audit facts, and
  schedules the next Task; it must not perform a second Task transition.
- `src/work-graph/` remains the sole owner of pure graph violations. No duplicate Planner- or
  Kernel-local topology rule is permitted.
- No new Phase 3 event, correction attempt, retry counter, fallback, backoff, or recovery policy is
  introduced by this fix.

## Required Invariants

- A contract failure atomically persists its receipt, blocked Subtask, and Task-domain blocked
  state with one unresolved dependency; the raw Executor body is never published as success.
- A contract-failed WorkUnit records `failed` for the same Task/Subtask/attempt before release;
  release clears all claim columns and preserves `failed`.
- A stale attempt cannot commit handoffs or `done`; any still-running Subtask becomes `blocked`,
  and an unchanged claim records `failed` before release.
- Coordinator handling does not duplicate the Task dependency or silently no-op a required domain
  transition.
- A one-child/one-parent chain with the same preferred AgentClass reports
  `mergeable_same_agent_chain`; duplicate preferred ownership in one derived layer reports
  `same_layer_preferred_conflict`.
- Planner validation and Kernel authorization continue to consume the shared sorted violation set.

## Validation

- First run focused red-capable Docker tests for attempt terminal persistence, coordinator blocked
  dispatch behavior, and v4 topology violations; confirm each test fails for the reported symptom.
- After the fix, rerun those focused tests, adjacent Work Graph/Planner/Kernel/Scheduler tests,
  `npm run lint`, and `npm run build`.
- Run the full Linux container suite with
  `docker build -f Dockerfile.test -t metaclaw-test .` and `docker run --rm metaclaw-test`.
- Before completion, update this plan with the delivered behavior, validation evidence, and
  implementation/closing commit IDs. Update the roadmap/ADR/current overview only if the repaired
  behavior changes their normative wording; do not manufacture a Phase 3 design change here.
