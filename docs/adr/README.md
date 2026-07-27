# Architecture Decision Records

This directory contains only ADRs that still contribute to the current MetaClaw architecture. Superseded proposals and fully absorbed decisions live under [the ADR archive](../archive/adr/README.md) and are historical context, not implementation authority.

## Required reading order

For architecture or roadmap work, read the smallest applicable set in this order:

1. [ADR-0020: Core Module Ownership And Dependency Direction](0020-core-module-ownership-and-dependency-direction.md) — normative module ownership, public seams and dependency direction.
2. [ADR-0019: PlanningAgentPlan v3 And Work Graph Authority](0019-planning-agent-plan-v3-work-graph-authority.md) — current plan/work-graph/storage/runtime contract.
3. Select only the topic ADRs needed from the table below.

Do not bulk-load archived ADRs. Open one only when investigating why an older design existed or when a current ADR explicitly cites it as historical context.

ADR-0021 is the current authority for the strict Work Graph v4, Subtask execution context, dependency handoff, completion envelope, execution evidence, and minimal attempt receipt. ADR-0019 remains authority only for v3 historical and migration context.

ADR-0022 is the current authority for the unified Phase 3 Kernel event/snapshot/decision Interface, decision ledger, `awaiting_decision`, synchronous control loop, capacity candidate switching, and response-only correction.

ADR-0023 is the current authority for the Phase 4 durable KernelWorkflow, structured failure and availability rules, idempotent application recovery, Work Graph revisions, continuation, outbox and manual recovery.

ADR-0024 is the current authority for Phase 5 resource partitions, persistent workspaces, per-attempt Docker sandboxes, durable resource leases and runtime capability elevation.

ADR-0025 is the current authority for Phase 6A single-Task runnable frontier, Kernel dispatch batches, asynchronous attempt supervision, Git-backed workspaces, deterministic publication and merge-conflict recovery.

## Current authority matrix

| Topic | Current authority | What it decides |
| --- | --- | --- |
| Single-Task concurrency and Git publication | [ADR-0025](0025-single-task-concurrency-and-git-publication.md) | Runnable frontier, dispatch batches, attempt supervision, Git workspace ownership, publication gate and conflict repair |
| Resource partitions and sandboxed attempts | [ADR-0024](0024-resource-partition-sandbox-and-runtime-elevation.md) | Partition identity/conflicts, persistent workspace, Docker attempt boundary, leases, elevation and recovery |
| Core modules and dependencies | [ADR-0020](0020-core-module-ownership-and-dependency-direction.md) | Planner/Kernel/Runtime control loop, module owners, Application Shell, persistence adapters and phase design gates |
| Durable Kernel workflow and recovery | [ADR-0023](0023-durable-kernel-workflow-recovery-and-availability.md) | Durable inbox/application/outbox, structured failure, retry/fallback, derived availability, continuation, revisions and recovery |
| Unified Kernel control plane | [ADR-0022](0022-unified-kernel-control-plane-and-decision-ledger.md) | Versioned event/snapshot/decision contract, ledger-first loop, attempt landing, capacity recovery and response-only correction |
| v4 work graph and Subtask execution | [ADR-0021](0021-work-graph-v4-subtask-execution-contract.md) | strict v4 dependencies, context refs, handoff protocol, completion envelope, evidence port and attempt receipt |
| v3 work graph and durable execution facts | [ADR-0019](0019-planning-agent-plan-v3-work-graph-authority.md) | strict schema v3, graph authority, Planner/Kernel validation, v3 persistence and Runtime apply/recovery |
| Static routing contracts | [ADR-0018](0018-supported-routing-contracts-and-unified-executor-definitions.md) | Routing Capability, canonical definitions, catalog projection, bindings and definition provenance |
| Dynamic AgentClass status | [ADR-0017](0017-kernel-executor-status-projection.md) | bounded health/outcome projection and static/dynamic fact split |
| Planner semantics and context | [ADR-0015](0015-planner-owned-semantics-and-tool-mediated-context.md) | semantic ownership, isolated planner runner, bounded/tool-mediated read-only context and fail-closed behavior |
| PlanningAgent/Kernel/Runtime chain | [ADR-0014](0014-planning-agent-policy-kernel-boundary.md) | proposal, authorization and side-effect application separation; ADR-0020 governs the target unified Kernel seam |
| Single-active top-level Task | [ADR-0011](0011-single-active-task-admission-gate.md) | current product constraint; ADR-0020 governs final Kernel ownership of admission policy |

When two current ADRs appear to overlap, the more specific topic ADR defines its data contract while ADR-0020 defines module ownership and dependency direction. A newer ADR must explicitly amend or supersede an older one; implementation plans cannot silently override ADRs.

## Status rules

- `Accepted`: current decision authority, including explicit amendments listed in the file.
- `Superseded` or `Historical`: stored under `docs/archive/adr/` and not valid for new implementation decisions.
- Avoid long-lived `partially superseded` ADRs. Absorb their remaining valid rules into a current ADR, then archive the old record.

New ADRs must state status, date, scope, affected current ADRs and whether they amend or supersede them. Material roadmap phases must also satisfy ADR-0020's design gate.
