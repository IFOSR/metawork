# ADR-0019: PlanningAgentPlan v3 And Work Graph Authority

- Status: Accepted
- Date: 2026-07-16
- Scope: PlanningAgent, Control Kernel, v3 Subtask persistence, and serial work-graph runtime
- Architecture: ADR-0020 assigns the shared graph contract/rules to Work Graph and forbids Execution Runtime from depending on Planning implementation details

> Alignment note (2026-07-27): this ADR remains authority for v3 historical and migration context only; ADR-0021 governs the current strict v4 graph. Two migration statements below are closed — the Kernel named `PolicyKernel` here is now `ControlKernel` (ADR-0022), and the shared graph rules have moved out of `src/planning/` into the independent `src/work-graph/` module.

## Context

PlanningAgentPlan v2 carried several parallel routing facts: a top-level execution summary, Subtask kind and hint fields, candidate lists, selected executors, and runtime fallback synthesis. These representations could disagree with the dependency graph and with canonical Routing Capability definitions. They also allowed old or incomplete plans to reach Runtime through semantic defaults.

Phase 1 needs a final graph structure before dependency handoff and concurrency are implemented. The structure must already identify true capability boundaries, remain independently authorizable by the Kernel, survive persistence without duplicate routing facts, and execute safely in the current serial runtime.

## Decision

PlanningAgentPlan is hard-cut to strict schema v3. `plan_work_graph` carries one non-empty graph; every other action carries `workGraph: null`. Each executable Subtask has non-empty controlled `requiredCapabilities` and one ordered `preferredAgentClassList` containing exactly every canonical AgentClass that statically covers the full capability set. The first item is preferred. Custom AgentClasses and database free-text capabilities do not enter v3 graphs.

`validateWorkGraphStructure` is the pure shared authority for graph invariants. It reports stable structured violations for identity and dependency errors, cycles and roots, longest-path-derived layer conflicts, and locally mergeable same-preferred single-chain edges. It has no catalog, storage, health, or Runtime dependency. Planner validation and PolicyKernel consume the same seam.

The current source file may remain under `src/planning/` during migration, but its logical owner is the Work Graph module. The first later phase that extends graph handoff or runnable-frontier behavior must establish the independent Work Graph public entry instead of adding more consumers of Planning internals.

Planner owns generation and one repair attempt. PolicyKernel independently repeats strict and catalog-aware validation, applies existing state/risk admission, then removes only dynamically `error` or `disabled` AgentClasses. It preserves order and keeps `unverified` and `healthy`. Any rewrite is structurally revalidated; exhausted or newly invalid graphs are rejected.

Migration v21 preserves the old Subtask table as read-only `subtasks_v2_audit` and creates a v3-only production table. Non-terminal v2 tasks are parked for explicit natural-language replan; Runtime never reads audit rows. Runtime may apply an approved new graph only when none exists or recover an existing v3 graph when no new graph is supplied. It does not replace an existing graph, synthesize a fallback graph, infer capabilities, or switch AgentClasses after execution failure.

### Durable runtime facts and recovery

Task, v3 Subtask, TaskEvent, WorkUnit and WorkUnitEvent persistence—not `MetaclawSession.output` or executor memory—is the recovery source of truth. Planner proposes durable structure but never performs Executor work. Runtime claims one concrete WorkUnit for one Subtask attempt, records lifecycle facts, and releases the claim when execution completes, blocks or suspends. Resume and process recovery rebuild from persisted facts and authorized v3 graphs.

This decision does not claim that real worktree allocation or partition leases already exist. Their identity, authorization, heartbeat/expiry and cleanup semantics remain roadmap Phase 5 work governed by ADR-0020's Resource Model, Control Kernel and Execution Runtime ownership split.

## Consequences

- The work graph is the sole fact for Subtask boundaries, dependencies, and current serial execution order.
- Planner errors are repairable before authorization, while hand-built or bypassed plans remain rejectable by the Kernel.
- Static eligibility and dynamic health have separate authorities and cannot legalize each other.
- v2 execution state remains auditable without a compatibility parser or inferred migration.
- Dependency-result injection, attempt fallback/retry, Kernel recovery control, resource partitioning, and concurrency remain explicit later phases.
- ADR-0018 remains the authority for unified built-in Executor definitions, but its v3 deferral and continued `candidateAgentClasses` wire-format consequence are superseded by this decision.
- The durable Task/Subtask/WorkUnit facts and Session-as-projection rule formerly recorded in ADR-0012 are incorporated here; ADR-0012 is historical.
