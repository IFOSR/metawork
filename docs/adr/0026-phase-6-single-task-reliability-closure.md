# ADR-0026: Phase 6 Single-Task Reliability Closure

- **Status**: Accepted
- **Date**: 2026-07-28
- **Scope**: Final Phase 6 scope, single-Task termination/recovery closure, and multi-Task scheduling deferral
- **Amends**: ADR-0022 and ADR-0025 only where they scheduled multi-Task work as Phase 6 scope
- **Preserves**: ADR-0011
- **Governed by**: ADR-0020

## Context

ADR-0025 delivered the concurrent attempt and Git-publication substrate inside the single active top-level Task. The remaining Phase 6 risk is reliable termination, recovery and completion across several independent attempts; expanding to multiple top-level Tasks would add admission, priority, fairness and starvation policy before that substrate is fully closed.

## Decision

Phase 6 ends with one admitted top-level Task. Within that Task, the Work Graph may authorize parallel independent attempts, each isolated by its own WorkUnit claim, resource lease, sandbox and durable dispatch item. Git-backed worktrees and publication remain the completion boundary, and retries/takeovers preserve the worktree, Git history and checkpoint while replacing the disposable attempt/container.

The final Phase 6 implementation must close whole-Task cancellation, cascading cancellation of every non-terminal Subtask and dispatch/publication item, exact attempt abort, late-outcome fencing, multi-attempt crash recovery, and the invariant that a Task cannot become `done` while dispatch, publication, sandbox, WorkUnit or resource-lease state remains active or uncertain. Task cancellation retains audit and recovery material but cannot publish new completion facts.

An attempt becomes terminal only when its immutable receipt, Subtask transition, terminal dispatch item and Kernel outcome inbox event commit in one SQLite transaction. Container, WorkUnit and resource-lease cleanup follows as an idempotent replayable supervisor step. If Docker, Git or persistent facts cannot prove reconciliation is safe, MetaClaw enters recovery-blocked mode: status and diagnostics remain available, but no attempt starts and no unproven claim or lease is released.

Because the product is unreleased, the closing implementation accepts only the current Kernel v4 contract and a fresh SQLite v27 database. Earlier Kernel/schema dual reads, legacy dispatch entrypoints and compatibility-only executor/session facades are not part of the initial product contract.

Multi-top-level-Task admission, priority, fairness, starvation protection, queueing, preemption and cross-Task recovery are deferred to a future independent roadmap. They must reuse the durable dispatch/publication seams when eventually introduced, but are not Phase 6 acceptance conditions. ADR-0011 therefore remains accepted and is not archived.

## Consequences

Phase 6 acceptance focuses on one Task's concurrent DAG execution, isolated attempts, Git integration and recoverable asynchronous execution. The current architecture does not promise or imply multi-Task scheduling; earlier Phase 6B wording that treated an ADR-0011 hard cut as pending work is superseded by this ADR.
