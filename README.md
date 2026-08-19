<p align="center">
  <strong>Shanghai Metafusion Artificial Intelligence Technology Co., Ltd.</strong>
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

One interface for all your agent work. The more agents you run, the more you
need a single entry point: you describe the goal, and MetaWork matches the
right Agent, model, and Harness behind the scenes.

### One interface, not an agent list

- **Users shouldn't manage an agent list.** When every agent has its own entry
  point, you can't tell which one to use, and context is lost moving between
  them.
- **A fixed combination isn't optimal.** As task characteristics change, so
  does the best model, Harness, cost, and latency combination.
- **New capabilities shouldn't add new entry points.** Vertical agents should
  mount as background capabilities, not as more UIs to learn.

### Task-level routing, not model leaderboards

The same task changes quality, cost, context, and completion time depending on
the model × Harness combination. MetaWork does not statically pick the
strongest model; it finds the better complete combination for the current
task's constraints.

- Most real engineering tasks are low-to-medium complexity; always calling the
  strongest combination is systematic waste.
- Cheaper per token is not cheaper per task: the Harness changes how much
  context is re-fed, which dominates real task cost.
- Routing scores the full combination — task profile × model tier × Harness
  profile — into a task-level Pareto-optimal choice, optimizing task cost and
  final delivery quality rather than single-token price or a single model score.

### A durable, governed task control plane

That routing mechanism ships as open source in MetaWork — not another chat
window, but a local, durable, recoverable, governed AI task control plane.

```text
Plan → Govern → Schedule → Route → Execute → Verify
```

- **Durable tasks** — tasks don't vanish when a session ends; they carry
  persistent state (`ready`, `running`, `parked`, `blocked`, `done`) across
  restarts.
- **Work Graph** — complex goals become a dependency-aware DAG; the scheduler
  runs only what is actually ready.
- **Governed execution** — the Planner proposes changes; the Control Kernel
  decides, validating state, policy, budget, and authorization.
- **Extensible executors** — Codex, Pi, Hermes, custom scripts, and vertical
  agents all mount onto the same control plane.

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

# API key for your foundation-model provider — authenticates MetaWork to the model service.
export ANYFUSION_PROVIDER_KEY='replace-with-your-key'

# Base URL of that provider's OpenAI-compatible API (usually ends in /v1).
export ANYFUSION_PROVIDER_URL='https://your-openai-compatible-endpoint.example/v1'

./setup.sh
```

`ANYFUSION_PROVIDER_KEY` is the API key for your foundation-model provider,
and `ANYFUSION_PROVIDER_URL` is its base URL — the OpenAI-compatible endpoint
you already use to call foundation models. Despite the `ANYFUSION_` prefix
(a legacy name for these variables), they tell MetaWork how to authenticate
against and reach the model service behind its Planner and Executors.

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
├── accounts/local-default/
│   ├── config/              # active and immutable configuration revisions
│   ├── secrets/             # secrets (macOS: keychain; Linux: file, 0600)
│   ├── data/anyfusion.db    # durable account runtime state
│   ├── planner/sessions/
│   ├── conversations/
│   ├── gateway/
│   ├── workspace-store/
│   └── attempts/
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
anyfusion web restart          # restart the unified Server with Web in foreground
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
| [Account Runtime Operations](docs/current/account-runtime-and-gateway-operations.md) | Unified Server lifecycle, account paths, Gateway replay, and diagnostics |
| [Runtime Security](docs/current/phase-5-runtime-security.md) | Workspaces, resource leases, permission boundaries, and execution backends |
| [Architecture Decisions](docs/adr/README.md) | Accepted decisions and authority matrix |
| [Documentation Map](docs/README.md) | Current docs, plans, technical debt, and archives |

## License

MetaWork is licensed under the [Apache License, Version 2.0](LICENSE).

Copyright 2026 Shanghai Metafusion Artificial Intelligence Technology Co., Ltd.
