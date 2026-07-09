# MetaClaw Documentation

This directory contains both current technical documentation and historical planning material. Start with the current docs before opening dated plans.

## Current Docs

- [Technical Overview](current/technical-overview.md): the previous long-form README, preserved as the current deep architecture and runtime reference.
- [中文技术总览](current/technical-overview.zh-CN.md): the previous long-form Chinese README, preserved as the Chinese deep architecture and runtime reference.
- [Repository README](../README.md): public project overview, install path, repository structure, and high-level architecture.
- [CONTEXT](../CONTEXT.md): current PlanningAgent, PolicyKernel, and work-unit migration vocabulary.

## Architecture Decisions

ADRs in [adr/](adr/) capture durable architectural decisions. Prefer ADRs over older plans when you need to understand why the current runtime is shaped the way it is.

Key recent ADRs:

- [ADR-0011: Single Active Task Admission Gate](adr/0011-single-active-task-admission-gate.md)
- [ADR-0012: Persistent Planner Subtask Runtime](adr/0012-persistent-planner-subtask-runtime.md)
- [ADR-0013: Planner-First Work-Unit Dispatch](adr/0013-planner-first-work-unit-dispatch.md)
- [ADR-0014: PlanningAgent / PolicyKernel Boundary](adr/0014-planning-agent-policy-kernel-boundary.md)

## Historical Plans

Files in [plans/](plans/) and older top-level docs record design exploration, implementation rounds, reviews, and roadmap history. Treat them as historical context unless they are explicitly referenced by the current README, `CONTEXT.md`, or an ADR.

## Operational Notes

- [Docker Pi Executor](docker-pi-executor.md): Docker-based notes for the Pi executor path.
- [Tech Debt](tech-debt/): the ADR-0014 legacy-compat-layers list is now closed (all bridges removed); kept as a historical record of what was retired.

## For Agents

When you need deep architecture context, read `current/technical-overview.md` after `AGENTS.md` and `CONTEXT.md`. Avoid loading every dated plan by default; use this map and the ADR index to choose the smallest relevant set.
