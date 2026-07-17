# ADR-0019: PlanningAgentPlan v3 And Work Graph Authority

- Status: Accepted
- Date: 2026-07-16
- Scope: PlanningAgent, PolicyKernel, v3 Subtask persistence, and serial work-graph runtime

## Context

PlanningAgentPlan v2 carried several parallel routing facts: a top-level execution summary, Subtask kind and hint fields, candidate lists, selected executors, and runtime fallback synthesis. These representations could disagree with the dependency graph and with canonical Routing Capability definitions. They also allowed old or incomplete plans to reach Runtime through semantic defaults.

Phase 1 needs a final graph structure before dependency handoff and concurrency are implemented. The structure must already identify true capability boundaries, remain independently authorizable by the Kernel, survive persistence without duplicate routing facts, and execute safely in the current serial runtime.

## Decision

PlanningAgentPlan is hard-cut to strict schema v3. `plan_work_graph` carries one non-empty graph; every other action carries `workGraph: null`. Each executable Subtask has non-empty controlled `requiredCapabilities` and one ordered `preferredAgentClassList` containing exactly every canonical AgentClass that statically covers the full capability set. The first item is preferred. Custom AgentClasses and database free-text capabilities do not enter v3 graphs.

`validateWorkGraphStructure` is the pure shared authority for graph invariants. It reports stable structured violations for identity and dependency errors, cycles and roots, longest-path-derived layer conflicts, and locally mergeable same-preferred single-chain edges. It has no catalog, storage, health, or Runtime dependency. Planner validation and PolicyKernel consume the same seam.

Planner owns generation and one repair attempt. PolicyKernel independently repeats strict and catalog-aware validation, applies existing state/risk admission, then removes only dynamically `error` or `disabled` AgentClasses. It preserves order and keeps `unverified` and `healthy`. Any rewrite is structurally revalidated; exhausted or newly invalid graphs are rejected.

Migration v21 preserves the old Subtask table as read-only `subtasks_v2_audit` and creates a v3-only production table. Non-terminal v2 tasks are parked for explicit natural-language replan; Runtime never reads audit rows. Runtime may apply an approved new graph only when none exists or recover an existing v3 graph when no new graph is supplied. It does not replace an existing graph, synthesize a fallback graph, infer capabilities, or switch AgentClasses after execution failure.

## Consequences

- The work graph is the sole fact for Subtask boundaries, dependencies, and current serial execution order.
- Planner errors are repairable before authorization, while hand-built or bypassed plans remain rejectable by the Kernel.
- Static eligibility and dynamic health have separate authorities and cannot legalize each other.
- v2 execution state remains auditable without a compatibility parser or inferred migration.
- Dependency-result injection, attempt fallback/retry, Kernel recovery control, resource partitioning, and concurrency remain explicit later phases.
- ADR-0018 remains the authority for unified built-in Executor definitions, but its v3 deferral and continued `candidateAgentClasses` wire-format consequence are superseded by this decision.
