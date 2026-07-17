<p align="center">
  <a href="https://anyint.ai/"><img src="docs/assets/brand-anyint.svg" alt="AnyInt" height="88" align="middle" /></a>
  <img src="docs/assets/brand-times.svg" alt="x" height="88" align="middle" />
  <a href="https://www.metafusion.cc/"><img src="docs/assets/brand-metafusion.svg" alt="MetaFusion" height="88" align="middle" /></a>
</p>

<div align="center">

# AnyFusion

**AI Task Control Plane for Durable, Governed Agent Workflows**

Turn long-running enterprise work into persistent, policy-governed task graphs executed by specialized agents.

<strong>AnyFusion is a strategic open-source initiative backed by AnyInt and MetaFusion,<br />with core development led by AnyInt. It is currently deployed for limited internal pilot use.</strong>

<sub>Hosted by MetaAny as a neutral open-source home.</sub>

<br /><br />

[![Developer Preview](https://img.shields.io/badge/status-Developer%20Preview-F59E0B)](docs/releases/v1.2.0-preview.0.md)
[![Internal Pilot](https://img.shields.io/badge/deployment-Internal%20Pilot-6366F1)](docs/releases/v1.2.0-preview.0.md#current-deployment-status)
[![CI](https://github.com/MetaAny/AnyFusion/actions/workflows/ci.yml/badge.svg)](https://github.com/MetaAny/AnyFusion/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2563EB.svg)](#license)

[Overview](#an-operating-system-for-long-running-agent-work) · [Capabilities](#core-capabilities) · [How It Works](#how-it-works) · [Quick Start](#quick-start) · [Status](#project-status) · [中文](README.zh-CN.md)

</div>

## An operating system for long-running agent work

Most agent tools optimize a single interactive session. Enterprise work is different: it can span hours or days, cross repositories and business domains, depend on several specialist agents, pause on missing inputs, and still need a controlled path to completion.

AnyFusion is a local-first task control plane between people, business surfaces, and agent runtimes. It preserves the objective and execution state, decomposes complex work into a dependency-aware graph, routes each unit to an appropriate agent class, governs every state-changing decision, and records the evidence required to resume, verify, and deliver the result.

It is designed for workflows where continuity, control, and accountability matter more than producing one more chat response.

## Core Capabilities

| Capability | What it provides |
| --- | --- |
| **Durable task scheduling** | Persistent task and subtask lifecycles, dependency readiness, blocking, parking, resumption, cancellation, and recovery across process or session boundaries. |
| **Policy-governed planning** | Natural-language planning is separated from authorization: the Planner proposes, the Control Kernel decides, and the Runtime applies only approved side effects. |
| **Dependency-aware work graphs** | Complex objectives become explicit DAGs with acceptance criteria, typed dependencies, scoped context, and durable handoff contracts between work units. |
| **Specialized-agent orchestration** | Capability-based routing maps each subtask to ordered agent-class candidates such as Codex, Pi, Hermes, or organization-specific vertical agents without embedding routing policy in prompts. |
| **Isolated execution** | Every agent receives one bounded assignment, the required evidence, and direct dependency outputs—not an uncontrolled copy of the entire conversation or sibling work. |
| **Verification and accountability** | Structured completion contracts capture acceptance evidence, artifacts, handoffs, attempt receipts, and audit events before results are exposed or delivered. |
| **Operational memory and delivery** | Confirmed preferences, task history, semantic retrieval, terminal workflows, Gateway surfaces, and Feishu delivery remain connected to the same durable task state. |

## Built for complex enterprise workflows

AnyFusion is intended to coordinate long-running work that crosses specialist boundaries, for example:

- **Engineering delivery:** planning, implementation, test execution, review, documentation, and artifact delivery across dedicated engineering agents.
- **Research and analysis:** source collection, domain-specific analysis, evidence review, synthesis, and report generation with explicit dependency handoffs.
- **Business operations:** intake from enterprise messaging, controlled specialist processing, human clarification when required, verification, and final delivery through the original channel.

The executor layer is adapter-based, so organizations can register vertical agents while keeping task state, routing facts, policy decisions, and completion evidence under one control plane.

## How It Works

```mermaid
flowchart LR
  Intake[People / CLI / Gateway / Feishu] --> Planning[Planning Agent<br/>Intent and work graph]
  Planning --> Kernel[Control Kernel<br/>Policy and authorization]
  Kernel --> Scheduler[Durable Scheduler<br/>State and dependency readiness]
  Scheduler --> Routing[Capability Routing<br/>Agent class and runtime health]
  Routing --> Agents[Specialized Agent Work Units<br/>Engineering / Analysis / Custom]
  Agents --> Verify[Verification and Delivery<br/>Evidence / artifacts / handoffs]

  State[(Persistent Task State<br/>memory / attempts / audit)]
  Planning <--> State
  Kernel <--> State
  Scheduler <--> State
  Verify --> State
```

Three boundaries keep the workflow governable:

1. **The Planner proposes; it never grants itself execution authority.**
2. **The Control Kernel makes deterministic policy decisions from explicit runtime facts.**
3. **The Runtime executes scoped decisions and reports normalized outcomes for the next decision.**

Work graphs already model independent branches, specialist assignments, and typed dependency delivery. The current preview deliberately serializes ready-subtask execution while resource partitioning, durable leases, conflict detection, and crash-safe concurrent dispatch are completed. This preserves the final concurrency model without claiming unsafe parallelism prematurely.

## Quick Start

AnyFusion targets Node.js 20+ and a Unix-like shell. On Windows, WSL2 with Ubuntu is the recommended runtime.

```bash
git clone https://github.com/MetaAny/AnyFusion.git
cd AnyFusion
./setup.sh
anyfusion
```

`setup.sh` installs dependencies, builds the CLI, links `anyfusion`, creates a local config, and detects available executor commands on `PATH`.

Then give AnyFusion a multi-step objective in natural language:

```text
Analyze these contracts, assign legal and commercial review to the appropriate specialist agents, and deliver a consolidated risk matrix with supporting evidence.
```

AnyFusion classifies the request, creates a durable task when required, authorizes the work graph, dispatches ready work units, validates their completion contracts, and preserves the resulting evidence and artifacts. Run `npm run smoke:anyfusion` separately when credentials are available for a live end-to-end validation.

## Project Status

| Area | Current state |
| --- | --- |
| Release | `v1.2.0-preview.0` |
| Maturity | Developer Preview |
| Deployment | Limited internal pilot use |
| Task scope | One active top-level task with dependency-aware subtasks |
| Dispatch | Serial ready-subtask execution in the current preview; safe asynchronous concurrency is on the published roadmap |
| Compatibility | CLI, configuration, and runtime contracts may evolve before a stable release |

AnyFusion is not presented as Production Ready. The preview is intended to validate the task control plane, work-graph contracts, specialist routing, verification model, and operational workflow before stable compatibility commitments are made.

## Documentation

| Resource | Purpose |
| --- | --- |
| [Technical Overview](docs/current/technical-overview.md) | Runtime architecture, operational setup, modules, and implementation details |
| [Architecture Decisions](docs/adr/README.md) | Accepted boundaries and authoritative design decisions |
| [Concurrency Roadmap](docs/plans/2026-07-16-planner-kernel-concurrency-convergence-roadmap.md) | Control-plane, resource-partitioning, recovery, and parallel scheduling plan |
| [Preview Release Notes](docs/releases/v1.2.0-preview.0.md) | Current release scope, deployment status, and known limitations |
| [Changelog](CHANGELOG.md) | Versioned lifecycle and notable changes |
| [Documentation Map](docs/README.md) | Index of current, historical, and contributor-facing documentation |

## License

AnyFusion is licensed under the [Apache License, Version 2.0](LICENSE).

Copyright 2026 The AnyFusion Contributors.
