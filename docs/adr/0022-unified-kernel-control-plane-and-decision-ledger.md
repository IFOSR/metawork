# ADR-0022: Unified Kernel Control Plane And Decision Ledger

- **Status**: Accepted
- **Date**: 2026-07-20
- **Scope**: Phase 3 control-plane decisions, persistence, attempt landing, capacity recovery, and completion correction
- **Amends**: ADR-0011, ADR-0014, ADR-0017, ADR-0021
- **Governed by**: ADR-0020

## Context

The existing `PolicyKernel` authorizes only `PlanningAgentPlan`. Dispatch, capacity exhaustion, execution failure landing, timer recovery and completion-contract handling are still selected by Session, Scheduler, Task Runtime or Attempt Runner. That leaves multiple strategic interpreters and prevents later recovery and concurrency work from sharing one auditable control plane.

## Decision

MetaClaw will expose one pure Kernel Interface:

```ts
decide(event: KernelEvent, snapshot: KernelSnapshot): KernelDecision
```

Events, snapshots and decisions are versioned discriminated unions. The Kernel receives bounded facts, emits one high-level action, derives its ID deterministically from the event ID, and never reads time, repositories, adapters or raw logs.

An Application module named `KernelControlLoop` owns snapshot construction, ledger-first issuance, one-decision application and observation until quiescence. Runtime satisfies `apply(decision): Promise<KernelEvent | null>` through internal Task, Execution and Delivery handlers. Session may trigger the loop and project output but may not interpret outcomes strategically.

SQLite v23 introduces `kernel_decisions` with a unique `event_id` and complete sanitized event/snapshot/decision JSON. The existing planning table becomes `planning_decisions_legacy_audit` with read-only triggers. New planning and runtime decisions write only the unified ledger. Phase 3 provides at-most-once issuance; a crash after ledger insert and before apply fails closed.

Subtasks use a lifecycle distinct from top-level Tasks and add `awaiting_decision`. A non-success attempt atomically writes its terminal receipt and moves the Subtask to `awaiting_decision`; the WorkUnit is released before the normalized outcome is submitted. Only a Kernel Decision may move that Subtask onward.

Pre-attempt capacity failure creates no attempt receipt. The Kernel may authorize sequential probes of the remaining already-authorized AgentClasses. Exhaustion yields a ledger-backed capacity block. Timer ticks may only recheck that capacity block; execution failures and lost heartbeats do not auto-recover in Phase 3.

The first completion-contract failure may authorize one response-only metadata
correction on the same AgentClass. Correction receives only the original
response, structured violations and exact trailer format under a bounded
no-tools/read-only profile. It does not re-execute the business Subtask. If
correction is unavailable or fails, a safe result remains deliverable and
uncertified while Kernel retains ordinary recovery/decision authority; metadata
failure alone does not create a permanent block.

The existing multi-Task queue, priority/preemption and parked auto-resume production policies are removed. ADR-0011's single-active top-level Task constraint remains. Multi-Task scheduling is deferred to a future independent roadmap; it is not part of Phase 6's final scope (ADR-0026).

## Ownership And Dependencies

- Planning owns semantic proposals and may depend on Work Graph and Routing Catalog.
- Control Kernel owns strategic interpretation and may depend only on pure domain facts, Work Graph and Routing Catalog.
- Runtime owns side effects and normalized observations, not next-action policy.
- Storage is an Adapter for the ledger and execution facts; it does not define Kernel semantics.
- Application Shell owns triggers and presentation only.

## Consequences

All current strategic behavior becomes testable through the single Kernel Interface and auditable in one ledger. Runtime handlers become simpler and fail closed when facts are contradictory. The hard cut removes compatibility paths and requires coordinated migration of Session, storage and tests.

Durable event inbox/outbox, unapplied-decision recovery, generic apply idempotency and failure recovery are explicitly deferred to Phase 4. Partition/lease enforcement remains Phase 5. Multi-Task scheduling and concurrency remain Phase 6.

### Result-first delivery amendment (2026-08-21, ADR-0032)

Runtime may persist and publish a safe `ResultObject` projection before the
Subtask is certified. It submits a normalized `execution_result_observed` fact
to the same `KernelWorkflow`; it does not submit a new strategic route.
`ControlKernel` remains the only authority for `awaiting_decision`, completion,
recovery, retry, replan, manual acceptance and downstream release.

Gateway `result_delivery_available`, `result_chunk` and `result_completed`
events are presentation facts. They must carry the certification state and
cannot mutate Kernel or Task state. A safe `uncertified` result is therefore
visible to the user while the Subtask remains under Kernel control.

Response-only correction is best-effort metadata repair. Its failure cannot
discard a safe body or independently create a permanent block. Security,
authorization and unsafe workspace facts remain fail-closed.
