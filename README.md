<p align="center">
  <strong>Shanghai Metafusion Artificial Intelligence Technology Co., Ltd.</strong>
</p>

<div align="center">

# AnyFusion

**A local-first AI Task OS for durable, governed agent work.**

AnyFusion turns natural-language requests into persistent Tasks and Work Graphs
that can survive restarts, run through controlled Planner and Executor
boundaries, and deliver verifiable results instead of ending at a chat reply.

[![Developer Preview](https://img.shields.io/badge/status-Developer%20Preview-F59E0B)](#project-status)
[![CI](https://github.com/IFOSR/metawork/actions/workflows/ci.yml/badge.svg)](https://github.com/IFOSR/metawork/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-2563EB.svg)](#license)

[Why AnyFusion](#why-anyfusion) · [Installation](#installation) ·
[Usage](#usage) · [How it works](#how-it-works) ·
[Project status](#project-status) · [中文](README.zh-CN.md)

</div>

## Why AnyFusion

Running more agents should not require more disconnected entry points.
AnyFusion provides one conversation surface backed by a durable control plane:
the Planner understands the request, the ControlKernel authorizes state
changes, and the Runtime executes only concrete approved work.

### Durable work, not session-only chat

- **Persistent Tasks** retain state, recovery facts, results, and audit history
  across process restarts.
- **Work Graphs** represent dependency-aware Subtasks, typed handoffs,
  acceptance criteria, and publication order.
- **Result-first delivery** can expose a safe useful result before completion
  certification, without incorrectly marking the Subtask done.
- **Recovery is explicit**: retry, fallback, continuation, merge repair,
  cancellation, and resume remain ControlKernel decisions.

### One runtime, multiple clients

The native TUI, Web workspace, Feishu integration, scripts, and Unix clients
all use the same versioned Gateway command and event plane. They share one
account-scoped Runtime while keeping Conversation history and presentation
state separate.

### Explainable routing and governed execution

AnyFusion separates AgentClass selection from concrete execution bindings.
Each authorized attempt is pinned to a configuration revision and a complete
Provider, Model, AgentClass, Harness, and Permission Profile tuple.

Executor Auto routing filters the user-approved model pool by compatibility,
health, capability, context, cost, latency, and quality constraints, then
records the selected binding and bounded rejection facts. The Runtime never
silently substitutes the current configuration for historical or in-flight
work.

```text
Plan -> Authorize -> Dispatch -> Execute -> Verify -> Publish -> Deliver
```

## Installation

The primary native path is macOS. Linux and WSL2 use the same Unix-oriented
source setup with file-backed secrets. Native Windows PowerShell is not a
supported production path; use WSL2 or the optional Docker compatibility path.

### Prerequisites

Required for installation:

- Node.js `>=22.19.0`
- npm
- Git
- Native build tools for `better-sqlite3`
- An OpenAI-compatible Provider base URL and API key

Recommended build tools:

```bash
# macOS
xcode-select --install
brew install node@22 git
export PATH="$(brew --prefix node@22)/bin:$PATH"

# Ubuntu, Debian, or WSL2
sudo apt-get update
sudo apt-get install -y git build-essential python3 make g++
```

Codex CLI and Pi Agent are installed independently. Setup detects `codex` and
`pi` on `PATH` and enables the available canonical Executor classes. It does
not install, upgrade, downgrade, or reconfigure either CLI. Executable Tasks
require at least one compatible enabled Executor.

### Install

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork

export ANYFUSION_PROVIDER_KEY='replace-with-your-key'
export ANYFUSION_PROVIDER_URL='https://your-openai-compatible-endpoint.example/v1'

# Optional. The installer defaults to gpt-5.6-terra and international.
export ANYFUSION_PROVIDER_MODEL='your-model-id'
export ANYFUSION_PROVIDER_REGION='international'

./setup.sh

export PATH="$HOME/.local/bin:$PATH"
anyfusion --help
```

On non-macOS systems, `setup.sh` selects the mode-`0600` file SecretStore
automatically. macOS uses Keychain-backed secrets unless explicitly configured
otherwise.

The installer:

- builds the AnyFusion Runtime and vendored `planner/AnyFusion-Pi` sources in
  separate dependency trees;
- installs the public launcher at `~/.local/bin/anyfusion`;
- stores releases, account state, configuration revisions, generated runtime
  files, and update journals under `~/.anyfusion`;
- keeps Planner sessions and Executor runtime homes isolated from personal
  `~/.codex` and `~/.pi` homes.

### Runtime layout

```text
~/.local/bin/
└── anyfusion

~/.anyfusion/
├── app/
│   ├── current
│   └── releases/
├── data/
│   ├── gateway.sock
│   └── runtime.lock
├── accounts/local-default/
│   ├── config/
│   ├── secrets/
│   ├── generated/
│   ├── data/
│   │   ├── anyfusion.db
│   │   ├── database-revisions/
│   │   ├── backups/
│   │   └── results/
│   ├── planner/sessions/
│   ├── conversations/
│   ├── workspace-store/
│   ├── attempts/
│   └── gateway/
└── upgrade-journals/
```

Set `ANYFUSION_INSTALL_ROOT` before installation to use a different root.

## Usage

### Native TUI

```bash
cd /path/to/your/project
anyfusion
```

The launch directory becomes the workspace context. Planner-side repository
access remains controlled and read-only; authorized Executor changes occur in
managed Task/Subtask Git worktrees and pass through the publication gate.

### Web workspace

```bash
anyfusion web
anyfusion web start
anyfusion web restart
anyfusion web --port 9000 --no-open
```

The default Web endpoint is `http://127.0.0.1:8788`. Normal startup exchanges a
short-lived URL-fragment bootstrap for an HttpOnly, SameSite=Strict session
cookie. Use `--no-open` for SSH, port forwarding, or manual browser startup.

### CLI reference

```text
anyfusion
anyfusion web [start|restart] [--port <p>] [--no-open]
anyfusion --script <file>
anyfusion --gateway
anyfusion --connect
anyfusion gateway <run|setup|pairing|doctor|install|start|stop|restart|status>
anyfusion <configure|config|provider|model|planner|executor|doctor|status> ...
```

Common management commands:

```text
anyfusion status
anyfusion doctor
anyfusion config show | validate | history | diff | rollback
anyfusion provider list | add | edit | test | remove
anyfusion model    list | add | edit | test | remove
anyfusion executor list | add | edit | enable | disable | remove | test
```

The source installer creates the `anyfusion` launcher.

## How it works

```text
Client
  -> ClientGateway
    -> ConversationSession
      -> AccountRuntime
        -> PlanningAgent
          -> ControlKernel
            -> Runtime
              -> Executor
```

- **ClientGateway** owns the versioned multi-client command/event protocol,
  replay, attachment, permission, and presentation-safe event flow.
- **ConversationSession** owns one serialized input mailbox, one persisted
  AnyFusion-Pi Planner session, and one bounded interaction trace.
- **AccountRuntime** owns account-wide configuration, memory, Task, Kernel,
  execution, publication, delivery, and recovery services.
- **PlanningAgent** owns natural-language semantics and submits strict
  `PlanningAgentPlan v8` proposals. It cannot mutate storage, authorize work,
  or control an Executor.
- **ControlKernel** is the sole policy authority for admission, dispatch,
  retry, fallback, cancellation, recovery, permissions, and publication.
- **Runtime** applies durable authorized decisions and reports normalized facts
  back to the Kernel.
- **Executor adapters** transport one authorized attempt through the native
  worktree backend or the explicit Docker compatibility backend.

One AccountRuntime admits one active top-level Task. A Task may contain a
dependency-aware Work Graph with up to four independent attempts running
concurrently. Successful attempts produce immutable receipts and candidate Git
commits; publication integrates them in deterministic order before completion
facts become authoritative.

Configuration is Provider-first and revisioned. Planner uses one fixed model
binding. Codex and Pi Executor policies may be fixed or Auto; Auto always
resolves to a concrete binding before execution. Configuration activation is
allowed only while the AccountRuntime activation gate is idle and affects new
Planner turns and new Task generations, never an in-flight attempt.

## Project status

| Area | Current state |
| --- | --- |
| Version | `v1.2.0-preview.0` |
| Maturity | Developer Preview |
| Runtime | Node.js `>=22.19.0`, TypeScript ESM |
| Planner contract | PlanningAgentPlan v8 |
| Work Graph contract | v7 |
| Kernel contract | v5 |
| Completion contract | v4 |
| Persistence | SQLite schema v33 |
| Canonical Executors | Codex CLI and Pi Agent |
| Top-level scheduling | One active Task per AccountRuntime |
| Subtask concurrency | Up to four attempts |

This is not a stable production release. Installation, configuration,
extension, and update contracts may change before the first stable version.
Multi-top-level-Task scheduling is intentionally deferred to a separate future
roadmap.

## Documentation

| Resource | Purpose |
| --- | --- |
| [Current Technical Overview](docs/current/technical-overview.md) | Full runtime, deployment, configuration, and repository overview |
| [Account Runtime Operations](docs/current/account-runtime-and-gateway-operations.md) | Server lifecycle, account paths, Gateway replay, and diagnostics |
| [Runtime Security](docs/current/phase-5-runtime-security.md) | Workspaces, resource leases, permissions, and execution backends |
| [Architecture Decisions](docs/adr/README.md) | Accepted decisions and authority matrix |
| [Documentation Map](docs/README.md) | Current docs, plans, technical debt, and archives |

## License

AnyFusion is licensed under the [Apache License, Version 2.0](LICENSE).

Copyright 2026 Shanghai Metafusion Artificial Intelligence Technology Co., Ltd.
