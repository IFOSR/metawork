# Edge Handoff Completion Invariant (in-place execution)

- Date: 2026-10-28
- Status: Delivered in the working tree; release/installed acceptance pending.
- Trigger: 2026-10-28 acceptance task `输出 hello.py 脚本的实际执行结果` and a
  two-node weight-loss plan (`research-outline -> build-pptx`) where the upstream
  node was certified `done` but the dependent node could never be dispatched.
- ADR: amendment recorded in
  [ADR-0021](../../docs/adr/0021-work-graph-v4-subtask-execution-contract.md).

## Root cause (verified from durable facts)

1. `subtask-attempt-runner.ts` resolves `directCompletion = inPlaceExecution ||
   nonWritingExecution`; in the current in-place product mode every writable
   attempt takes it.
2. `AttemptTerminalService.land()` therefore writes subtask `done` **without**
   creating a `workspace_publications` row.
3. Edge handoffs were only materialized by `WorkspacePublicationWorker`, which
   never runs for that completion. `subtask_handoffs` has no rows after
   2026-10-22 (the in-place switch); the first two-node plan afterwards hit it.
4. Dispatch admission sees `source is done but the edge-scoped handoff is
   missing` (`terminal: true`), emits `block_work`, and the Task concludes
   `needs_action` with `reason=input_required` — which no user input can resolve.

## Decision

State the invariant on the completion boundary: `done` and "outgoing edge
handoffs exist" are one atomic fact. One idempotent writer, one transaction,
fail closed when the safe body is missing. Structural edge failures are system
blockers (auto replan once, then `blockerKind: 'system'`), never user-input
requests.

## Implementation

| Seam | Change |
| --- | --- |
| `src/execution/subtask-handoff-materializer.ts` (new) | Single idempotent writer, deterministic result-reference identity, `assertEdgeHandoffsMaterializable()` |
| `src/execution/attempt-terminal-service.ts` | `land()` accepts `edgeHandoffs` and writes them in the `done` transaction; no writer configured ⇒ fail closed |
| `src/execution/subtask-attempt-runner.ts` | Pre-check before landing; passes safe projection + declared handoffs; maps failure to a non-retryable infrastructure failure |
| `src/execution/workspace-publication-worker.ts` | Reuses the shared writer (legacy path stays idempotent) |
| `src/kernel/control-kernel.ts` | Structural dependency failure: one automatic replan, then `block_work` with `blockerKind: 'system'`; `no_op` while the repair replan converges |
| `src/core/types.ts`, `src/task/task-state-facts.ts`, `src/execution/kernel-execution-runtime.ts` | `kernel_anomaly` blocker type: stays `needs_action`, reason `system_anomaly`, no `provide_input` action |
| `src/execution/subtask-handoff-repair.ts` (new) | Backfill for pre-fix rows, rebuilt from certified safe projections; reports what it cannot rebuild |

## Validation

- `tests/execution/subtask-handoff-materializer.test.ts` — edge listing,
  reference/read-scope construction, idempotency, fail-closed without a safe
  body, no body required without an out-edge, declared artifacts preserved.
- `tests/execution/subtask-handoff-repair.test.ts` — backfill rebuilds, is
  idempotent, reports missing projections.
- `tests/execution/attempt-terminal-service.test.ts` — a direct completion that
  owes an edge refuses to land without a handoff writer (rollback proven).
- `tests/execution/subtask-attempt-runner.test.ts` — an in-place completion now
  materializes the outgoing edge in the same transaction.
- `tests/kernel/control-kernel.test.ts` — structural failure spends the one
  automatic replan, blocks as `system` afterwards, and does not re-block while
  the repair replan runs.
- `tests/task/task-state-regressions.test.ts` — `kernel_anomaly` projects
  `needs_action` + `system_anomaly` with no fake pending action.
- Live repair: the affected account task
  `task_plan_event_proposal_43fd…f5cd9` received its
  `research-outline -> build-pptx` handoff (result reference over the
  attempt's 19,283-byte safe projection); DB backup taken beforehand.
- `npm run lint` clean; `tests/execution tests/task tests/commands tests/web
  tests/gateway` 1302 green. `tests/e2e` and 14 `tests/kernel/control-kernel`
  cases fail identically with and without this change (pre-existing working-tree
  breakage, unrelated).

## Follow-ups

- Surface "system blocker" wording in the Web blocked card (`Execution needs
  attention` is still English) and translate `reason.message` producers.
- Consider a startup/periodic consistency check that runs
  `backfillOutgoingHandoffs` and reports unresolved Tasks.
- Nothing here re-enables the retired publication/worktree path.
