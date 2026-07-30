---
status: accepted
amended_by: ADR-0020, ADR-0022
---

# Single active task admission gate (deliberate, current scope)

> Architecture alignment (2026-07-27): the single-active-top-level-Task constraint remains accepted, but the `TaskAdmissionGate` implementation below is historical. Roadmap Phase 3 delivered admission authority behind the unified `ControlKernel.decide(event, snapshot)` seam and deleted `src/session/task-admission-gate.ts`; Application Shell only applies the resulting decision. Read the Decision section below as the origin of the product constraint, not as the current code path.

## Context

MetaClaw historically allowed multiple top-level tasks to coexist: a user could
queue a second task, preempt a running one with an urgent request, and let the
scheduler auto-resume a parked task ahead of a later queued task. That
multi-task scheduling surface (queueing, preemption, cross-session resume
choice) carries real complexity in the session/scheduler/TUI layers.

The current development priority is the **PlanningAgent / Control Kernel / Runtime
convergence path** (strict v3 work graphs, dependency handoff, recovery policy,
resource partitioning and later concurrency). To reduce
development load and concentrate effort on that primary functionality, we
deliberately narrow the runtime to **one active top-level task at a time** for
now. This is a scope decision, not a discovery of a bug.

## Decision

> Historical implementation (superseded by ADR-0022). The rule survives; `TaskAdmissionGate` does not.

1. Introduce `TaskAdmissionGate` (`src/session/task-admission-gate.ts`) as the
   single intake boundary. While a top-level task is running it:
   - **allows** `direct_reply`, `clarification`, task `status_query` /
     `clear_tasks`, and any intent/execution that *references the active task
     itself*;
   - **rejects** new top-level task intake, `fork_follow_up` that would spawn
     another top-level task, and execution requests for a *different* task.
2. The gate is wired into `SessionIntentApplicationService` and
   `SessionTaskExecutionApplicationService` at each task-creating / task-executing
   entry point.
3. Rejection emits a zh-CN user message (matching the rest of the UI) telling
   the user to query status or finish/cancel the active task first.

## Considered Options

- **Keep full multi-task scheduling.** Rejected for now: queueing + preemption
  + cross-session resume is a large surface to keep correct while the routing
  layer is being rewritten. Deferring it lowers blast radius.
- **Silently drop extra tasks.** Rejected: users need explicit feedback on why a
  request was not accepted.

## Consequences

- **Queueing, preemption, and auto-resume of a *second* task are intentionally
  disabled.** The single active task may still contain multiple subtasks on
  different executors (see CONTEXT.md "Single Active Task") — the restriction is
  on *top-level* task intake. Independent Subtasks inside that Task may run
  concurrently under ADR-0025; they do not weaken this admission constraint.
- The following pre-existing acceptance cases encode the *old* multi-task
  behavior (queue / preempt / multi-task resume). They are **kept but
  `it.skip`-ped**, not deleted, because multi-task scheduling is expected to
  return — at which point the gate is relaxed and these cases are rewritten
  against the new policy rather than blindly un-skipped (tracked in the
  [future multi-Task scheduling roadmap](../plans/future-multi-task-scheduling-roadmap.md)):
  - `tests/tui/auto-resume-preempted.test.ts` — "resumes the preempted parked task before a later normal queued task"
  - `tests/tui/guidance-blocks.test.ts` — "shows a completion guidance block that points to the next queued task"
  - `tests/tui/guidance-panel.test.ts` — "updates the guidance panel after task completion points to the next queued task"
  - `tests/tui/memory-resume-acceptance.test.ts` — "keeps task-local memory ahead of global memory when a parked task resumes after preemption"
  - `tests/session/cross-session-last-task-round12-acceptance.test.ts` — "allows the user to choose resuming the most recent unfinished task..."
- This decision is **reversible**: when multi-task scheduling is reprioritized,
  relax the gate (e.g. allow scheduler-internal resume/preempt paths to bypass
  it) rather than deleting it.
