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
- **Multiple clients, one runtime:** native TUI, Web, Feishu, and Unix clients
  share the same versioned Gateway command and event plane. Server owns the
  Runtime and remains alive when Clients exit.
- **Explainable routing:** every authorized attempt is pinned to a configuration
  revision and a complete Provider, Model, AgentClass, Harness, and Permission
  Profile binding.
- **Capability-driven routing:** each Executor has its own Chinese Skill-style
  capability manual. The manual is compiled from the Executor's selected Models,
  model capability evidence, runtime affordances, and user natural-language
  guidance. Planner uses the final manual for semantic matching, while its
  machine-readable routing projection is used for validation and model
  selection.
- **Context continuity:** Planner uses its persisted Pi session to understand
  references such as "this image" or "the report just produced". MetaWork's
  Context Bridge provides bounded Conversation facts, validates selected
  historical Artifacts, and materializes only authorized inputs for the
  Executor.
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

### Build and runtime lifecycle

Run the build command from any directory to rebuild the source checkout
recorded for this installation. It installs dependencies, rebuilds Runtime,
Planner, and Web, then atomically activates one release without changing
account data. Stop the persistent Server first:

```bash
metawork server stop
metawork build
metawork server start
```

`metawork server start`, `metawork tui`, and `metawork web` all use the same
activated `app/current` release. `metawork build` does not start a Server or a
Client and refuses to run while Server is active.

### Web workspace

```bash
metawork web
metawork web --no-open
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

### Executor capability configuration

Each Executor has an independent capability manual rather than a shared set of
free-form tags. Configure the Executor's allowed or automatic Models first,
then describe in natural language what it is good at, what it should avoid, and
which Model contributes a particular capability. The single **Update Capability
Profile** operation uses the same semantic compilation path to:

1. recompute system facts from the current Model pool;
2. merge the user's natural-language definition with those facts;
3. generate a Chinese Skill-style manual for that Executor;
4. derive read-only labels and a structured routing projection.

The final manual is the semantic source used by Planner. The routing projection
is its machine-readable view used by Planner validation and ControlKernel model
selection. User guidance takes precedence over conflicting generated
positioning, but it cannot authorize an unconfigured Model, widen permissions,
or bypass Kernel authorization. Removing a Model automatically removes the
capabilities it was the only evidence for after the profile is refreshed.

## Architecture

```text
Client
  -> ClientGateway
    -> ConversationSession
      -> AccountRuntime
        -> PlanningAgent (semantic planning only)
          -> PlanningAgentPlan v8
            -> ControlKernel (authorization and recovery)
              -> Work Graph / Runtime
                -> Executor attempt
```

- `ClientGateway` owns the versioned multi-client command/event protocol.
- `ConversationSession` owns one serialized input mailbox and one persisted
  AnyFusion-Pi Planner session. New semantic Planner turns cannot directly
  reply to work-like requests; except for slash-prefixed system commands, they
  must submit work to an Executor. Historical direct-reply records remain
  readable for audit and replay.
- `AccountRuntime` owns shared account services and the account's scheduling
  policy. Each Conversation has one durable execution slot, while independent
  Conversations may run concurrently within configured limits.
- `ControlKernel` is the deterministic policy authority.
- Execution owns claims, leases, native worktree or Docker compatibility
  backends, attempts, Git publication, and normalized observations.

### Planner-to-Executor routing

```text
User request
  -> Planner reads routing projection and capability manuals
  -> PlanningAgentPlan v8
  -> Validator checks graph and required capabilities
  -> ControlKernel authorizes an immutable binding
  -> Auto Model Resolver selects an allowed, capability-compatible Model
  -> Executor adapter runs the approved attempt
```

The Planner owns natural-language interpretation and decomposition. It does not
mutate Tasks, authorize execution, access storage directly, or execute shell
commands. The Kernel is the only authority that schedules work, selects an
authorized Model binding, handles recovery, and admits an Executor attempt.

### Planner, MetaWork, and Executor context continuity

Context continuity follows one directional bridge:

```text
Pi session history + user input
  -> Planner understands and selects context
  -> MetaWork Context Bridge provides and validates Artifact facts
  -> Runtime materializes authorized inputs
  -> Executor runs the current Subtask
```

Historical images, documents, HTML, text, and Executor results use explicit
Artifact references rather than guessed filenames or private paths. MetaWork
checks Conversation and Workspace ownership, publication status, regular-file
safety, and content hashes before an Artifact can enter an attempt. The
Executor receives only the current Subtask and attempt-local inputs; it does
not inspect Conversation history or the Artifact store directly. This keeps
semantic understanding in Planner, deterministic validation in MetaWork, and
execution in the Executor.

### Pi Agent and image execution

`pi-agent` remains one user-visible Executor with one capability manual. Its
runtime adapter is composite:

```text
pi-agent
  ├─ ordinary research, analysis, coding, and tool work
  │    -> standard operator-installed `pi --mode json`
  └─ image-generation / image-editing Subtask
       -> MetaWork Image API Runner
```

Image work uses the Model and Provider binding already authorized by the
Kernel. MetaWork validates input and output image signatures, writes artifacts
inside the attempt workspace, and certifies them through Completion Protocol
v4. The image Runner is not a second AgentClass and does not modify the
vendored AnyFusion-Pi Planner. Upgrading the local Pi installation therefore
does not overwrite MetaWork's image execution code.

Native macOS/worktree execution does not require Docker. Docker is an explicit
compatibility backend for constrained deployments; it packages the standard Pi
CLI and MetaWork Image Runner in a pinned attempt image, and routes image
requests through an attempt-scoped model gateway so Provider credentials do not
enter the container.

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

MetaWork is under active commercial development. The current runtime supports
bounded parallel top-level Tasks across Conversations, while each Conversation
serializes its own Task execution slot. The Planner-first routing, unified
Executor capability profiles, and Pi image execution path are implemented and
covered by the repository test suite. Provider-specific live image generation
and editing still require a configured OpenAI-compatible endpoint and may incur
usage charges before production smoke testing.

## License

MetaWork is proprietary and is not offered under the repository's historical
open-source license file. Company-approved commercial license terms must be
provided separately before external distribution.

AnyFusion-derived and other third-party open-source components retain their own
copyright, license, attribution, and notice requirements. The root `LICENSE`
file is retained unchanged for historical and third-party review; it does not
license the MetaWork product as a whole.
