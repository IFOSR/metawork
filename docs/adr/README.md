# Architecture Decision Records

This directory contains only ADRs that still contribute to the current MetaClaw architecture. Superseded proposals and fully absorbed decisions live under [the ADR archive](../archive/adr/README.md) and are historical context, not implementation authority.

## Required reading order

For architecture or roadmap work, read the smallest applicable set in this order:

1. [ADR-0020: Core Module Ownership And Dependency Direction](0020-core-module-ownership-and-dependency-direction.md) — normative module ownership, public seams and dependency direction.
2. Select only the topic ADRs needed from the table below.

Do not bulk-load archived ADRs. Open one only when investigating why an older design existed or when a current ADR explicitly cites it as historical context.

ADR-0021 is the foundational authority for Work Graph dependency, handoff and
completion semantics. ADR-0025/0026 evolved the active graph contract to v5 for
concurrent dispatch, Git publication, cancellation and generation recovery.
ADR-0023 owns the durable-workflow evolution. The earlier v3 contract and
migration record are archived as ADR-0019.

ADR-0022 is the origin authority for the unified Kernel event/snapshot/decision Interface, decision ledger, `awaiting_decision`, synchronous control loop, capacity candidate switching, and response-only correction. Its contract has since been amended through ADR-0023/0024/0025/0026 and the current Kernel wire version is v5.

ADR-0023 is the current authority for the durable KernelWorkflow, structured failure and availability rules, idempotent application recovery, Work Graph revisions, continuation, outbox, manual recovery, and the 2026-07-30 deferred-availability/executor-recovery amendment.

ADR-0024 is the current authority for Phase 5 resource partitions, persistent workspaces, per-attempt Docker sandboxes, durable resource leases and runtime capability elevation.

ADR-0025 is the current authority for Phase 6A single-Task runnable frontier, Kernel dispatch batches, asynchronous attempt supervision, Git-backed workspaces, deterministic publication and merge-conflict recovery.

ADR-0026 fixes Phase 6's final scope to reliable asynchronous concurrency inside one top-level Task. It preserves ADR-0011; multi-Task scheduling is a future independent roadmap rather than Phase 6 work.

ADR-0027 through ADR-0030 govern the accepted MetaWork Server upgrade transition.
They do not describe already-delivered behavior until the implementation plan's
release gate is complete:

- ADR-0027 owns the revisioned Configuration Control Plane, immutable activation,
  and one-configuration-revision-per-Work-Graph-generation rule.
- ADR-0028 owns Harness/Model/AgentClass routing bindings, revision-scoped health
  identity, model fallback identity, and Permission Profile references.
- ADR-0029 freezes remote Executor/A2A as a future transport adapter only.
- ADR-0030 owns signed native releases and the crash-recoverable program,
  configuration, generated-runtime, and database upgrade transaction.

ADR-0031 governs the accepted AccountRuntime and unified client Gateway target.
The implementation plan — characterization, contracts, account storage and
migration, AccountRuntime ownership, Conversation runtime, unified Gateway core,
and surface adapters — is delivered with focused tests, and production surfaces
route through the unified Gateway.
The runtime-wide service extraction from MetaclawSession into account-scoped
factories is complete across nine service clusters (Kernel, repositories,
workspace, execution, task, coordinator, runtime-execution, kernel-execution,
and planner). ConversationSession now carries the conversation-facing state and
callback surface (output, focus, guidance, delivery, executor callbacks and a
planner submission delegate) through the unified ConversationRuntimePort.
The physical removal of direct client Session constructor sites and full
surface cutover wiring remain the release-gate closure. It moves runtime-wide
ownership out of per-client Sessions, defines Account and Conversation
cardinality, scopes ADR-0011 per AccountRuntime, and requires TUI, Web
conversation, Feishu and future App traffic to use one Gateway command/event
plane.

## Current authority matrix

| Topic | Current authority | What it decides |
| --- | --- | --- |
| Account Runtime and unified client Gateway | [ADR-0031](0031-account-runtime-and-unified-client-gateway.md) | Account/Conversation/connection cardinality, account-scoped Runtime and Kernel ownership, client Gateway ingress/egress, identity mapping and account data isolation |
| Revisioned Configuration Control Plane | [ADR-0027](0027-configuration-control-plane-and-revision-authority.md) | Static configuration authority, immutable revision layout, generation-scoped revision pinning, projections, activation and one-way cutover |
| AgentClass, Model and Harness routing | [ADR-0028](0028-agentclass-model-and-harness-routing-contract.md) | Authorized binding tuple, model policy, health identities, fallback attempt identity and Permission Profile ownership |
| Future remote Executor transport | [ADR-0029](0029-executor-transport-and-a2a-boundary.md) | A2A transport-only boundary, authorized envelope and explicit deferral from the current release |
| Native release trust and upgrade transaction | [ADR-0030](0030-native-release-trust-and-upgrade-transaction.md) | Signed manifest trust, update locking, quiescence, database backup/migration, activation, health checks and rollback |
| Single-Task concurrency and Git publication | [ADR-0025](0025-single-task-concurrency-and-git-publication.md) | Runnable frontier, dispatch batches, attempt supervision, Git workspace ownership, publication gate and conflict repair |
| Phase 6 single-Task reliability closure | [ADR-0026](0026-phase-6-single-task-reliability-closure.md) | Task termination, multi-attempt recovery/completion closure, and deferral of multi-Task scheduling |
| Resource partitions and sandboxed attempts | [ADR-0024](0024-resource-partition-sandbox-and-runtime-elevation.md) | Partition identity/conflicts, persistent workspace, Docker attempt boundary, leases, elevation and recovery |
| Core modules and dependencies | [ADR-0020](0020-core-module-ownership-and-dependency-direction.md) | Planner/Kernel/Runtime control loop, module owners, Application Shell, persistence adapters and phase design gates |
| Durable Kernel workflow and recovery | [ADR-0023](0023-durable-kernel-workflow-recovery-and-availability.md) | Durable inbox/application/outbox, structured failure, retry/fallback, deferred availability, Executor recovery, continuation and revisions |
| Unified Kernel control plane | [ADR-0022](0022-unified-kernel-control-plane-and-decision-ledger.md) | Versioned event/snapshot/decision contract, ledger-first loop, attempt landing, capacity recovery and response-only correction |
| Work Graph and Subtask execution foundation | [ADR-0021](0021-work-graph-v4-subtask-execution-contract.md) | dependency/context/handoff/completion/evidence semantics retained by the active v5 graph; concurrent dispatch and publication amendments live in ADR-0025/0026 |
| Static routing contracts | [ADR-0018](0018-supported-routing-contracts-and-unified-executor-definitions.md) | Routing Capability, canonical definitions, catalog projection, bindings and definition provenance |
| Dynamic AgentClass status | [ADR-0017](0017-kernel-executor-status-projection.md) | bounded health/outcome/recovery projection, static/dynamic fact split, and `error` versus `disabled` semantics |
| Planner semantics and context | [ADR-0015](0015-planner-owned-semantics-and-tool-mediated-context.md) | semantic ownership, isolated planner runner, bounded/tool-mediated read-only context and fail-closed behavior |
| Single-active top-level Task | [ADR-0011](0011-single-active-task-admission-gate.md), [ADR-0031](0031-account-runtime-and-unified-client-gateway.md) | current product constraint; ADR-0031 scopes the unchanged one-Task rule per AccountRuntime |

When two current ADRs appear to overlap, the more specific topic ADR defines its data contract while ADR-0020 defines module ownership and dependency direction. A newer ADR must explicitly amend or supersede an older one; implementation plans cannot silently override ADRs.

## Status rules

- `Accepted`: current decision authority, including explicit amendments listed in the file.
- `Superseded` or `Historical`: stored under `docs/archive/adr/` and not valid for new implementation decisions.
- Avoid long-lived `partially superseded` ADRs. Absorb their remaining valid rules into a current ADR, then archive the old record.

New ADRs must state status, date, scope, affected current ADRs and whether they amend or supersede them. Material roadmap phases must also satisfy ADR-0020's design gate.
