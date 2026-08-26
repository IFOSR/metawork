<p align="center">
  <strong>Shanghai Metafusion Artificial Intelligence Technology Co., Ltd.</strong>
</p>

<div align="center">

# MetaWork

**A commercial AI Task OS for durable, governed agent work.**

MetaWork turns natural-language requests into persistent Tasks and Work Graphs
that survive restarts, execute through controlled Planner and Executor
boundaries, and deliver verifiable results instead of stopping at a chat reply.

[Why MetaWork](#why-metawork) · [Installation](#installation) ·
[Usage](#usage) · [Architecture](#architecture) ·
[Compatibility](#compatibility) · [中文](README.zh-CN.md)

</div>

## Why MetaWork

MetaWork provides one commercial service system for planning, authorizing,
executing, recovering, and delivering agent work.

- **Durable work:** Tasks, Work Graphs, results, recovery facts, and audit
  history persist across process restarts.
- **Governed execution:** the Planner proposes work, the ControlKernel
  authorizes state changes, and Executors run only concrete approved attempts.
- **Multiple clients, one runtime:** native TUI, Web, Feishu, scripts, and Unix
  clients share the same versioned Gateway command and event plane.
- **Explainable routing:** every authorized attempt is pinned to a configuration
  revision and a complete Provider, Model, AgentClass, Harness, and Permission
  Profile binding.
- **Explicit recovery:** retry, fallback, continuation, merge repair,
  cancellation, and resume remain ControlKernel decisions.

```text
Plan -> Authorize -> Dispatch -> Execute -> Verify -> Publish -> Deliver
```

## Product Boundary

MetaWork is the canonical product represented by this repository. It is a
proprietary commercial system.

[AnyFusion](https://github.com/IFOSR) is a separate open-source project.
MetaWork may reuse or adapt attributed AnyFusion components and contracts. In
particular, the vendored `planner/AnyFusion-Pi` fork remains the isolated
Planner component, and durable/protocol compatibility identifiers retain their
existing names where changing them would break installations.

## Installation

The primary native path is macOS. Linux and WSL2 use the same Unix-oriented
source setup with file-backed secrets. Native Windows PowerShell is not a
supported production path; use WSL2 or the optional Docker compatibility path.

### Prerequisites

- Node.js `>=22.19.0`
- npm
- Git
- Native build tools for `better-sqlite3`
- An OpenAI-compatible Provider base URL and API key

Codex CLI and Pi Agent are installed independently. Setup detects them on
`PATH`; it does not install, upgrade, downgrade, or reconfigure either CLI.

### Install

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork

export METAWORK_PROVIDER_KEY='replace-with-your-key'
export METAWORK_PROVIDER_URL='https://your-openai-compatible-endpoint.example/v1'

# Optional
export METAWORK_PROVIDER_MODEL='your-model-id'
export METAWORK_PROVIDER_REGION='international'

./setup.sh

export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

The installer builds the MetaWork Runtime and vendored `planner/AnyFusion-Pi`
sources in separate dependency trees. Releases, account state, configuration,
generated runtime files, and update journals are stored under `~/.metawork`.

### Runtime layout

```text
~/.local/bin/
├── metawork
├── anyfusion
└── metaclaw

~/.metawork/
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

Set `METAWORK_INSTALL_ROOT` before installation to use a different root.

## Usage

### Native TUI

```bash
cd /path/to/your/project
metawork
```

The launch directory becomes the read-only Planner workspace context.
Authorized Executor changes happen in managed Task/Subtask Git worktrees and
pass through the publication gate.

### Web workspace

```bash
metawork web
metawork web start
metawork web restart
metawork web --port 9000 --no-open
```

The default Web endpoint is `http://127.0.0.1:8788`. Normal startup exchanges a
short-lived URL-fragment bootstrap for an HttpOnly, SameSite=Strict session
cookie. Use `--no-open` for SSH, port forwarding, or manual browser startup.

### Management commands

```text
metawork status
metawork doctor
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

## Architecture

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

- `ClientGateway` owns the versioned multi-client command/event protocol.
- `ConversationSession` owns one serialized input mailbox and one persisted
  AnyFusion-Pi Planner session.
- `AccountRuntime` owns shared account services and the single active
  top-level Task boundary.
- `ControlKernel` is the deterministic policy authority.
- Execution owns claims, leases, backends, attempts, Git publication, and
  normalized observations.

See [the current technical overview](docs/current/technical-overview.md) and
[accepted ADRs](docs/adr/README.md) for the complete contracts.

## Compatibility

`anyfusion` and `metaclaw` remain compatibility CLI aliases for `metawork`.
Existing `ANYFUSION_*` product settings remain accepted as aliases for their
`METAWORK_*` equivalents and fail closed when both values conflict.
Component-specific `ANYFUSION_PI_*` and `ANYFUSION_PLANNER_*` variables retain
their names because they identify the AnyFusion-Pi integration.

An existing `~/.anyfusion` installation is migrated transactionally to
`~/.metawork`. MetaWork does not keep steady-state dual reads or writes after a
successful migration. Durable compatibility names such as `anyfusion.db`,
`AnyFusionConfigurationV2`, and `anyfusion-planner-host-v2` are intentionally
preserved.

## Project Status

MetaWork is under active commercial development. The current runtime admits one
active top-level Task per account while allowing bounded parallel Subtask
attempts inside that Task. Interfaces and operational contracts may change
before a generally available commercial release.

## License

MetaWork is proprietary and is not offered under the repository's historical
open-source license file. Company-approved commercial license terms must be
provided separately before external distribution.

AnyFusion-derived and other third-party open-source components retain their own
copyright, license, attribution, and notice requirements. The root `LICENSE`
file is retained unchanged for historical and third-party review; it does not
license the MetaWork product as a whole.
