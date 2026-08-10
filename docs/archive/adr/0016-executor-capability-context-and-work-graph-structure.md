# ADR-0016: Executor Capability Context and Work-Graph Structure

- Status: Partially superseded by ADR-0018 and ADR-0019; module ownership clarified by ADR-0020
- Date: 2026-07-15
- Scope: design decision only; production implementation starts after Phase 0

ADR-0018 temporarily deferred this ADR's v3 and graph commitments while unifying built-in definitions. ADR-0019 later accepted and implemented the final strict v3 contract, capability-boundary decomposition and shared graph rules, superseding this ADR's provisional v3 field details. Static catalog injection and versioned built-in definition decisions remain accepted. ADR-0020 assigns the shared graph contract and rules to the logical Work Graph module rather than Planning internals.

## Context

The Planner currently has enough freedom to turn implementation steps into serial subtasks even when one executor can complete the whole task. Repeated executor invocations then receive overlapping top-level context and can repeat work. The executor catalog is also exposed through a Planner MCP query that mixes static routing facts with runtime capacity.

ADR-0015 established the dedicated Planner MCP and PlanningAgent/PolicyKernel boundary. This ADR revises only its executor-catalog discovery decision; task/session read tools remain unaffected.

## Decision

### Inject a static catalog at Planner startup

Every planning run will receive a stable, read-only, Planner-safe snapshot of configured executor AgentClasses. The Planner and PolicyKernel must use the same snapshot for one decision. Static routing facts will not be fetched through Planner MCP, and `list_executor_classes` will be removed when the production phase lands.

The snapshot may describe stable routing characteristics, but it must not contain credentials, commands, WorkUnit claims, heartbeat, health, or live capacity. Runtime availability remains a Runtime concern.

### Decompose at executor boundaries

The default objective is the fewest executor calls and the fewest subtasks. If one AgentClass can complete the goal end to end, the Planner must emit one subtask. It may split only when the goal requires a capability handoff between different AgentClasses. Validation belongs inside the producing executor call unless an independently routed capability is actually required.

Requests that specify an executor count or multiple independent instances are not representable by the current Kernel. The Planner must clarify the limitation and ask whether it may continue with the minimum executor count implied by capability boundaries.

### Keep PlanningAgentPlan v3 minimal

Version 3 adds only `requiredCapabilities: string[]` to `SubtaskProposal` and makes `agentClassHint` and `candidateAgentClasses` non-empty with the hint first. Until the shared capability vocabulary is implemented, the only valid capability array is `[]`; non-empty output is repairable invalid output.

No decomposition rationale, explicit execution layer, or workspace partition is added. Historical v2 decisions remain read-only and are not re-authorized.

### Share one pure work-graph rule module

A pure module will derive graph facts and return structural violations. Both the Planner validator and PolicyKernel will call it. It will enforce mode/subtask counts, IDs, dependency references, acyclicity, same-derived-layer primary-class uniqueness, and mergeable same-class unbranched chains. It must preserve legitimate forks and joins.

The module must not read storage or runtime state. Capability coverage will be a separate catalog-aware Kernel concern after the capability model debt is resolved.

### Keep Runtime serial for now

Derived layers are validation facts, not a parallel execution promise. Ready subtasks remain serial and use stable subtask ID ordering. Workspace partitions, leases, cross-task contention, worktree isolation, and eventual parallelism are staged in the [Planner, Kernel, and concurrency convergence roadmap](../../plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md).

### Version built-in definitions

The future built-in AgentClass catalog must own canonical definitions, Planner-safe projections, Adapter bindings, and a definition version/provenance policy. Known untouched defaults may be upgraded; user-modified profiles must not be overwritten silently.

## Consequences

- Planner prompts become deterministic and no longer depend on an optional catalog MCP call.
- Planner and Kernel share structural semantics instead of maintaining two near-duplicate rule sets.
- This implementation scope is limited to `codex-cli` and `pi-agent`. A third executor is a future catalog extension and is not a prerequisite or acceptance condition for this ADR.
- Capability names temporarily remain empty, preventing a premature free-form vocabulary from becoming an accidental API.
- True concurrency and user-requested executor counts remain unsupported until the Kernel has explicit resource and isolation semantics.

## Superseded portion of ADR-0015

ADR-0015 remains authoritative for the dedicated read-only Planner MCP, audit, and PlanningAgent/PolicyKernel separation. Its executor catalog query is superseded by startup context injection once this ADR is implemented.
