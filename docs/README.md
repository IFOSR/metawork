# AnyFusion Documentation

This directory contains both current technical documentation and historical planning material. Start with the current docs before opening dated plans.

## Current Docs

- [Technical Overview](current/technical-overview.md): the previous long-form README, preserved as the current deep architecture and runtime reference.
- [中文技术总览](current/technical-overview.zh-CN.md): the previous long-form Chinese README, preserved as the Chinese deep architecture and runtime reference.
- [Phase 5 Runtime Security And AgentClass Operations](current/phase-5-runtime-security.md): short-lived attempt containers, control/egress networks, persistent workspace retention, image pinning, and runtime elevation operations.
- [Repository README](../README.md): public project overview, install path, repository structure, and high-level architecture.
- [CONTEXT](../CONTEXT.md): current PlanningAgent, ControlKernel, decision-ledger, and work-unit vocabulary.

## Releases

- [AnyFusion v1.2.0 Preview](releases/v1.2.0-preview.0.md): public preview highlights, architecture summary, deployment status, and known limitations.
- [Changelog](../CHANGELOG.md): public release history.

## Architecture Decisions

Use the [ADR authority index](adr/README.md) before opening individual decisions. It records the required reading order, current topic owner and archive policy. ADRs under [archive/adr/](archive/adr/) are historical and must not guide new implementation.

Key recent ADRs:

- [ADR-0011: Single Active Task Admission Gate](adr/0011-single-active-task-admission-gate.md)
- [ADR-0015: Planner-Owned Semantics And Tool-Mediated Context](adr/0015-planner-owned-semantics-and-tool-mediated-context.md)
- [ADR-0017: Kernel Executor Status Projection](adr/0017-kernel-executor-status-projection.md)
- [ADR-0018: Supported Routing Contracts And Unified Executor Definitions](adr/0018-supported-routing-contracts-and-unified-executor-definitions.md)
- [ADR-0020: Core Module Ownership And Dependency Direction](adr/0020-core-module-ownership-and-dependency-direction.md): normative module and dependency guide for the active convergence roadmap.
- [ADR-0022: Unified Kernel Control Plane And Decision Ledger](adr/0022-unified-kernel-control-plane-and-decision-ledger.md): current event, snapshot, decision, ledger, Subtask and synchronous-loop contract delivered by Phase 3.
- [ADR-0023: Durable Kernel Workflow, Recovery And Availability](adr/0023-durable-kernel-workflow-recovery-and-availability.md): Phase 4 durable inbox/application/outbox, recovery, structured failure, retry/fallback, availability, continuation and graph revision authority.
- [ADR-0024: Resource Partition, Sandbox And Runtime Elevation](adr/0024-resource-partition-sandbox-and-runtime-elevation.md): Phase 5 resource identities, Docker attempts, persistent workspaces, leases and structured permission elevation.
- [ADR-0025: Single-Task Concurrency And Git Publication](adr/0025-single-task-concurrency-and-git-publication.md): Phase 6 runnable frontier, batch dispatch, asynchronous attempts, Git-backed workspaces and publication.
- [ADR-0026: Phase 6 Single-Task Reliability Closure](adr/0026-phase-6-single-task-reliability-closure.md): final Phase 6 scope, reliable Task termination/recovery closure and deferral of multi-Task scheduling.

The current Phase 2 contract is [ADR-0021: Work Graph v4 And Subtask Execution Contract](adr/0021-work-graph-v4-subtask-execution-contract.md).

## Completed Roadmap

- [Planner、Kernel 与并发调度收敛路线图](plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md): completed convergence from capability-aware work graphs and executor scope through the Kernel control plane, resource partitions, single-Task DAG concurrency, Git publication and reliable asynchronous cancellation/recovery.
- [Phase 6 final reliability closure](plans/2026-07-28-phase-6-single-task-reliability-closure.md): SQLite v27 cancellation/replan facts, durable Task/Subtask cleanup, explicit partial acceptance and the strict completion gate.

## Future Roadmap

- [Multi-top-level-Task scheduling](plans/future-multi-task-scheduling-roadmap.md): deferred independent work for admission, priority, fairness and starvation protection. It is not an unfinished Phase 6 stage; ADR-0011 remains active.

## Historical Plans

Files in [plans/](plans/) contain active plans explicitly linked above. Superseded and completed plans are moved to [archive/plans/](archive/plans/); treat archived plans as historical context unless they are referenced by the current README, `CONTEXT.md`, or an ADR.

The completed [Phase 1 work-graph semantics convergence plan](archive/plans/2026-07-16-phase-1-work-graph-semantics-convergence.md) records the v3 contract, migration, runtime cutover, and validation evidence.

The completed [Phase 2 overall action plan](archive/plans/2026-07-17-phase-2-executor-scope-and-dependency-handoff.md) and [detailed implementation plan](archive/plans/2026-07-17-phase-2-executor-scope-and-handoff-detailed-implementation-plan.md) record the Work Graph v4, execution-scope, evidence, completion, handoff, attempt, migration, and validation contracts.

The completed [Phase 2 attempt-terminal and Work Graph regression fix plan](archive/plans/2026-07-20-phase-2-attempt-terminal-and-work-graph-regression-fix-plan.md) records the pre-Phase-3 hardening of blocked/stale terminal ownership, attempt-safe release, restored Phase 1 topology rules, and behavior-test coverage.

The completed [Phase 3 overall action plan](archive/plans/2026-07-20-phase-3-kernel-control-plane-convergence.md) and [detailed implementation plan](archive/plans/2026-07-20-phase-3-kernel-control-plane-detailed-implementation-plan.md) record the unified ControlKernel, decision ledger, synchronous control loop, capacity handling, outcome landing, response-only correction, and validation evidence.

The completed [Phase 5 implementation plan](archive/plans/2026-07-22-phase-5-resource-partition-sandbox-elevation-detailed-implementation-plan.md) records resource identities, persistent workspaces, leases, Docker attempt sandboxes, runtime elevation, Kernel v3 recovery and validation evidence.

## Operational Notes

- [Docker + SSH runtime](../README.md#running-interactively-via-docker--ssh): run the TUI in a container with a real PTY, browse `/workspace` files, and configure the separate Planner Codex, Executor Codex, and Executor Pi provider files under `docker/`. The default planner + executor is Codex (`gpt-5.6-luna`); Pi is retained as an executor candidate.
- [Tech Debt](tech-debt/): the active post-Phase-6 first-release cleanup handoff is tracked in [redundancy and compatibility cleanup](tech-debt/post-phase6-first-release-redundancy-cleanup.md). Active command/TUI work is tracked in the [UX backlog](tech-debt/task-command-and-tui-ux-backlog.md), with visible command placeholders listed in [pending command implementations](tech-debt/pending-command-implementations.md). The earlier natural-language inventory remains in [nl-keyword-semantic-inference-debt](tech-debt/nl-keyword-semantic-inference-debt.md) and is consolidated into the post-Phase-6 cleanup record for implementation. The closed [Kernel decision authority record](archive/tech-debt/kernel-decision-authority-scattered-in-runtime-debt.md) documents how Phase 3–5 converged every strategic decision onto `ControlKernel`. The closed [LangGraph durable workflow evaluation](archive/tech-debt/langgraph-durable-workflow-adoption-candidates.md) records why Phase 4 retained the smaller self-owned workflow. Closed capability and workspace-partition records also remain under [archive/tech-debt/](archive/tech-debt/).

## For Agents

When you need deep architecture context, read `current/technical-overview.md` after `AGENTS.md` and `CONTEXT.md`. Avoid loading every dated plan by default; use this map and the ADR index to choose the smallest relevant set.
