<p align="center">
  <strong>Shanghai Yuanjubian Artificial Intelligence Technology Co., Ltd.</strong>
</p>

<div align="center">

# MetaWork

**A local-first AI Task OS for durable, governed agent work.**

MetaWork turns natural-language objectives into persistent tasks that survive
restarts, run through an isolated Planner/Executor pipeline, and deliver
verified, auditable results — not just a chat reply.

[![Developer Preview](https://img.shields.io/badge/status-Developer%20Preview-F59E0B)](docs/releases/v1.2.0-preview.0.md)
[![CI](https://github.com/IFOSR/metawork/actions/workflows/ci.yml/badge.svg)](https://github.com/IFOSR/metawork/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2563EB.svg)](#license)

[Why MetaWork](#why-metawork) · [Installation](#installation) ·
[Usage](#usage) · [How it works](#how-it-works) ·
[Project status](#project-status) · [中文](README.zh-CN.md)

</div>

## Why MetaWork

Most AI agent sessions are ephemeral: they answer the current turn and end.
There is no durable state, no governance, and no verifiable artifact to show
for the work. MetaWork raises agent work to the level of a task operating
system.

### Durable tasks, not ephemeral turns

- Tasks are first-class objects with an explicit state machine — `created`,
  `ready`, `running`, `parked`, `blocked`, `done`, `archived`, `cancelled`.
- Work survives process restarts and resumes with context, instead of starting
  over from scratch.
- Tasks are searchable (local SQLite full-text index) and can pause for a
  missing resource or user authorization, then continue where they left off.

### Governed execution, separated from planning

Every strategic state change flows through one deterministic control loop:

```text
Planner proposes → ControlKernel decides → Runtime applies → Executor performs one authorized attempt
```

- The Planner proposes semantics; it never schedules, authorizes, or mutates
  storage.
- The ControlKernel is the only strategic decision seam, writing every decision
  to an append-only, immutable ledger.
- There is no second semantic router, no hidden retry loop, and no silent
  fallback path.

### Isolated, real execution

- The Planner and each Executor run as separate processes.
- Every attempt owns a private `(task, generation, subtask)` Git worktree that
  persists across retries and restarts.
- Codex and Pi run through your existing local CLIs, without sharing their
  personal homes. The worktree backend is the default trusted native path.

### Verified and deterministically published

- Completion Protocol v3 requires structured evidence or a controlled failure.
- The runtime computes one authoritative workspace delta per attempt.
- Successful attempts produce immutable receipts and candidate Git commits,
  integrated in deterministic order. Merge conflicts use bounded,
  Kernel-authorized repair.
- Results, artifacts, and handoffs become visible only after publication
  succeeds.

### Local-first and self-hosted

- Native macOS installation with no Docker requirement.
- Secrets stay in the macOS keychain; runtime state lives in a local SQLite
  database.

### Revisioned configuration, signed upgrades

- Static configuration is immutable and revision-scoped; each Work Graph
  generation pins exactly one revision.
- Upgrades are signed, crash-recoverable transactions: a pinned trust root,
  verified backup and migration, a candidate health check, and atomic pointer
  activation with rollback.

### Multiple surfaces

- Native TUI (default), browser UI, Feishu delivery, and a local Gateway.

## Installation

The current native installer targets macOS. Linux and WSL2 remain development
and runtime environments; Docker is retained only as a compatibility and CI
validation path.

### Prerequisites

- Node.js `>=22.19.0`
- npm
- Git
- macOS native build tools (for `better-sqlite3`)
- Existing `codex` and `pi` commands on `PATH`
- An OpenAI-compatible provider URL and API key

```bash
xcode-select --install
brew install node@22 git
export PATH="$(brew --prefix node@22)/bin:$PATH"

node --version
npm --version
git --version
codex --version
pi --version
```

### Install

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork

export ANYFUSION_PROVIDER_KEY='replace-with-your-key'
export ANYFUSION_PROVIDER_URL='https://your-openai-compatible-endpoint.example/v1'

./setup.sh
```

Optional provider variables:

```bash
export ANYFUSION_PROVIDER_MODEL='your-model-id'    # default: gpt-5.6-terra
export ANYFUSION_PROVIDER_REGION='international'  # default: international
```

The installer:

- Builds the MetaWork runtime and the vendored Pi planner in separate
  dependency trees, directly from the checked-in `planner/AnyFusion-Pi` sources.
- Installs the launcher at `~/.local/bin/anyfusion`.
- Writes all state and configuration under `~/.anyfusion` (override with
  `ANYFUSION_INSTALL_ROOT`).
- Does not install, upgrade, downgrade, link, or reconfigure Codex or Pi, and
  does not read or write your `~/.codex` or `~/.pi` homes.

### Runtime layout

```text
~/.local/bin/
└── anyfusion                # launcher

~/.anyfusion/
├── app/current              # active release
├── app/releases/            # versioned releases
├── config/active/           # active immutable configuration revision
├── config/secrets/          # secrets (macOS: keychain; Linux: file, 0600)
├── data/metaclaw.db         # durable runtime state
├── data/planner-sessions/
├── data/execution-workspaces/
└── upgrade-journals/
```

On non-macOS platforms, set `ANYFUSION_SECRET_STORE=file`; the keychain store
requires macOS.

## Usage

### Native TUI (default)

```bash
cd /path/to/your/project
anyfusion
```

The launch directory is the read-only root the Planner inspects. It is not
forced to the MetaWork repository or a fixed `/workspace`.

### Web interface

```bash
anyfusion web
anyfusion web restart          # restart the running instance into Web mode
anyfusion web --port 9000 --no-open
```

`anyfusion web` opens `http://127.0.0.1:8788` and authenticates the browser
automatically through a short-lived URL fragment, exchanged immediately for an
HttpOnly, SameSite=Strict session cookie. Use `--no-open` for SSH, port
forwarding, or manual browser startup.

### CLI reference

```text
anyfusion                                   # native TUI
anyfusion web [restart] [--port <p>] [--no-open]
anyfusion --script <file>                   # scripted session
anyfusion --gateway                         # local gateway
anyfusion --connect                         # attach to a running gateway
anyfusion gateway <run|setup|pairing|doctor|install|start|stop|restart|status>
anyfusion <configure|config|provider|model|planner|executor|doctor|status> ...
```

Management commands:

```text
anyfusion status
anyfusion doctor
anyfusion config show | validate | history | diff | rollback
anyfusion provider list | add | edit | test | remove
anyfusion model    list | add | edit | test | remove
anyfusion executor list | add | edit | enable | disable | remove | test
```

The command-line entry point is `anyfusion`; compatibility aliases are
`metawork` and `metaclaw`.

## How it works

MetaWork separates agent work into four explicit runtime boundaries:

- **Planner** — owns natural-language understanding and produces strict
  `PlanningAgentPlan v8` proposals (direct replies, task bindings, Work Graph
  proposals). It inspects your repository read-only and never mutates state.
- **ControlKernel** — owns admission, dispatch, retry, fallback, cancellation,
  recovery, permission, and publication policy. `decide(event, snapshot)` is
  the only strategic decision seam.
- **Runtime** — applies authorized decisions: durable Task and Subtask state,
  Work Graph execution, WorkUnit claims and leases, workspaces, and process
  lifecycle. It reports normalized facts back to the Kernel.
- **Executor adapter** — transports exactly one authorized attempt per call,
  through the worktree backend (default) or the Docker compatibility backend.

The current release boundary is one active top-level Task, which may contain
dependency-aware Subtasks with up to four independent attempts running
concurrently.

## Project status

| Area | Current state |
| --- | --- |
| Version | `v1.2.0-preview.0` |
| Maturity | Developer Preview |
| Runtime | Node.js `>=22.19.0`, TypeScript ESM |
| Planner contract | PlanningAgentPlan v8 |
| Work Graph contract | v7 |
| Kernel contract | v5 |
| Completion contract | v3 |
| Persistence | SQLite schema v31 |
| Canonical Executors | Codex CLI and Pi Agent |

This is not a stable production release. Installation, configuration, and
extension contracts may change before the first stable version.

## Documentation

| Resource | Purpose |
| --- | --- |
| [Current Technical Overview](docs/current/technical-overview.md) | Full runtime, deployment, configuration, and repository overview |
| [Runtime Security](docs/current/phase-5-runtime-security.md) | Workspaces, resource leases, permission boundaries, and execution backends |
| [Architecture Decisions](docs/adr/README.md) | Accepted decisions and authority matrix |
| [Documentation Map](docs/README.md) | Current docs, plans, technical debt, and archives |

## License

MetaWork is licensed under the [Apache License, Version 2.0](LICENSE).

Copyright 2026 Shanghai Yuanjubian Artificial Intelligence Technology Co., Ltd.
