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
[Release](#release) · [Quick Start](#quick-start) · [Usage](#usage) ·
[Architecture](#architecture) ·
[Compatibility](#compatibility) · [中文](README.zh-CN.md)

</div>

## Why MetaWork

MetaWork provides one commercial service system for planning, authorizing,
executing, recovering, and delivering agent work.

- **Durable work:** Tasks, Work Graphs, results, recovery facts, and audit
  history persist across process restarts.
- **Governed execution:** the Planner proposes work, the ControlKernel
  authorizes state changes, and Executors run only concrete approved attempts.
- **Multiple clients, one runtime:** Web, Feishu, and Unix clients
  share the same versioned Gateway command and event plane. Server owns the
  Runtime and remains alive when Clients exit.
- **Unified multi-client observation:** Web, Feishu, and the native TUI can
  follow the same Tasks and Conversations. Switching sessions reads a bounded
  client read model instead of replaying an entire historical session, while
  the TUI task dashboard shows running, queued, and blocked work together.
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
- **Reliable long execution:** Executor work has no overall wall-clock limit.
  The optional watchdog expires only when the Harness is genuinely idle and is
  paused while an authoritative operation is active.
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

## Release

The current formal release is
[MetaWork `v0.1.3`](https://github.com/IFOSR/metawork/releases/tag/v0.1.3).
It is published on the stable installation channel. Its synchronized release
identity is recorded in the signed per-platform manifests; all targets are
built from the same tagged commit.

| Target | Native release |
| --- | --- |
| macOS Intel | `darwin-x64` |
| macOS Apple Silicon | `darwin-arm64` |
| Linux x64 | `linux-x64` |
| Windows x64 | `win32-x64` |

Each target publishes a Runtime archive, a vendored AnyFusion-Pi Planner
archive, and a target-specific Ed25519-signed manifest.
The manifests use signing key `metawork-release-2026-03`, pin Runtime and
Planner revision from the tagged commit, and record SHA-256 hashes that the installers
verify before installation. Linux arm64 has no prebuilt asset in this release;
build it on a native Linux arm64 host with `npm run build:release`.

## Installation

The published native paths are macOS Intel, macOS Apple Silicon, Linux x64,
and Windows x64. Linux and WSL2 use the Unix installer with file-backed
secrets. Windows uses the signed PowerShell installer and named pipes for local
Runtime connections. Linux arm64 is supported as a native build target, but is
not included in the current prebuilt release.

### Prerequisites

- Node.js `>=22.19.0`
- npm
- Git
- Native build tools for `better-sqlite3`
- An API key for an OpenAI-compatible model provider (DeepSeek, Kimi, Code
  CLI, or your own endpoint). The setup wizard collects and verifies it after
  the build.

Codex CLI and Pi Agent are installed independently. Setup detects them on
`PATH`; it does not install, upgrade, downgrade, or reconfigure either CLI.

### Quick install (macOS, Linux, WSL2)

The official distribution source is GitHub Releases. The installer below
tracks the latest stable Release; for this repository state it resolves to
`v0.1.3`. Release archives and signed manifests are downloaded directly from
GitHub's Release CDN.

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh | bash

export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

One command downloads the signed, prebuilt Runtime and vendored Planner
artifacts from the official GitHub Release, verifies them, and launches the provider setup wizard. On Linux
and WSL2 the installer automatically selects the file-backed secret store
(`METAWORK_SECRET_STORE=file`); no manual export is needed. Re-running
the same command updates an existing installation in place — configuration,
secrets, and task data are preserved. Windows users should use the native
PowerShell installer below. When the wizard completes, continue with
[Quick Start](#quick-start).

### Quick install (Windows x64)

Run PowerShell as the current user:

```powershell
irm https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.ps1 -OutFile metawork-install.ps1
.\metawork-install.ps1
```

The Windows package requires Node.js `>=22.19.0`, Git, and Windows Developer
Mode (or an elevated terminal) so the transactional release pointers can use
NTFS links. The installer verifies the signed manifest and both ZIP artifacts
before invoking the offline installer.

Running inside an IDE-embedded terminal, an agent, or CI where `curl | bash`
cannot attach the setup wizard to your keyboard? Download first, then run in
a real terminal (or set the environment variables below and stay
non-interactive):

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh -o metawork-install.sh
bash metawork-install.sh
```

Uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh | bash -s -- --uninstall
```

Stops a running Server, removes the managed launchers (`metawork`, `anyfusion`,
`metaclaw`), and deletes the install root. Add `--purge` to also remove legacy
launcher backups.

### Keeping the Server running

`metawork server start` runs in the foreground. For an always-on deployment use
the supervision templates under `scripts/supervision/` (launchd plist for
macOS, systemd unit for Linux) — they restart the Server automatically if it
exits.

### Install from source

```bash
git clone https://github.com/IFOSR/metawork.git
cd metawork
./setup.sh

export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

After the build, the installer launches a short setup wizard: pick a provider
preset (DeepSeek, Kimi, or Code CLI) or enter any OpenAI-compatible endpoint,
confirm the model, and paste your API key. The wizard verifies the key with a
live request, stores it in the local secret store, and completes the
installation. No configuration needs to be exported beforehand.

<details>
<summary>Non-interactive install (CI, Docker, scripts)</summary>

Skip the wizard by exporting the provider environment before running
`./setup.sh`:

```bash
export METAWORK_PROVIDER_KEY='your-key'
export METAWORK_PROVIDER_URL='https://api.deepseek.com/v1'
# Optional (Linux/WSL2 defaults to the file-backed secret store automatically)
export METAWORK_SECRET_STORE='file'
export METAWORK_PROVIDER_MODEL='deepseek-chat'
export METAWORK_PROVIDER_REGION='international'
```

</details>

<details>
<summary>Publishing prebuilt releases (maintainers)</summary>

`npm run build:release` builds Runtime/Web/Planner on the current native host,
installs production dependencies, and packages the built Runtime,
`web/dist`, Runtime dependencies, and vendored Planner into per-platform
archives plus an Ed25519-signed manifest. The target must match the build
host; macOS must not cross-build a Linux release. For example, a Linux x64
host builds the Linux x64 release with:

```bash
npm run build:release -- \
  --platform linux \
  --arch x64 \
  --release-id 0.1.3-build-<tagged-revision> \
  --signing-key /secure/path/metawork-release-key.pem \
  --out-dir /tmp/metawork-release
```

Windows uses ZIP archives and `scripts/install.ps1`; macOS and Linux use
tarballs and `scripts/install.sh`. `--package-only` is only for packaging
already-built target dependencies and does not perform the build. The command
requires a real release key (`--signing-key` or
`METAWORK_RELEASE_SIGNING_KEY`); `--generate-dev-key` is for local testing
only. Published GitHub Actions builds use native runners for macOS Intel,
macOS Apple Silicon, Windows x64, and Linux x64. The packaging command fails
if the Runtime, Web, Planner, or dependency outputs are missing.

</details>

The installer builds the MetaWork Runtime and vendored `planner/AnyFusion-Pi`
sources in separate dependency trees. Releases, account state, configuration,
generated runtime files, and update journals are stored under `~/.metawork`.

### Runtime layout

macOS and Linux use this layout and connect local Clients to a Unix socket:

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

Windows uses `%LOCALAPPDATA%\MetaWork\bin\*.cmd` launchers and a named pipe
for the local Gateway:

```text
%LOCALAPPDATA%\MetaWork\
├── bin/
│   ├── metawork.cmd
│   ├── anyfusion.cmd
│   └── metaclaw.cmd
├── app/
│   ├── current
│   └── releases/
├── data/
│   ├── runtime.lock
│   └── planner-sessions/
└── accounts/local-default/
    ├── config/
    ├── secrets/
    ├── data/
    ├── conversations/
    ├── workspace-store/
    ├── attempts/
    └── gateway/
```

Set `METAWORK_INSTALL_ROOT` before installation to use a different root.

## Quick Start

Three steps from a fresh install to your first delivered task:

```bash
# 1. Start the Server (foreground; use the supervision templates above for
#    background deployment)
metawork server start

# 2. In a second terminal, launch the single MetaWork TUI from your project
#    directory
cd /path/to/your/project
metawork

# Or use the Web Client
metawork web            # opens http://127.0.0.1:8788 in your browser
```

3. Describe the task in natural language. The Planner interprets the request
and proposes a Work Graph, the ControlKernel authorizes it, and an Executor
completes approved attempts in managed Git worktrees. Results are verified,
published through the Git publication gate, and delivered back to the
Conversation.

Prefer working inside Feishu? Run `metawork server setup-feishu` after
step 1 — see [Feishu](#feishu).

### Command cheat sheet

```text
metawork server start | stop | restart | status | doctor   # Server lifecycle and health
metawork web [--no-open]          # Web Client at http://127.0.0.1:8788 (connects to the running Server)
metawork server setup-feishu      # connect a Feishu bot (interactive wizard)
metawork gateway pairing list | approve | revoke <open_id>   # Feishu DM access
metawork build                    # rebuild and atomically activate a release
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

Verify the provider key at any time with `metawork provider test`.

## Usage

### Web workspace

Connects to the running Server (`metawork server start`):

```bash
cd /path/to/your/project
metawork web
metawork web --no-open
```

The launch directory becomes the Conversation's read-only Planner workspace
context, and the browser opens `http://127.0.0.1:8788`. Normal startup
exchanges a short-lived URL-fragment bootstrap for an HttpOnly,
SameSite=Strict session cookie; use `--no-open` for SSH, port forwarding, or
manual browser startup. Authorized Executor changes happen in managed
Task/Subtask Git worktrees and pass through the publication gate.

Every Turn in the selected Conversation remains visible and available to the
persisted Planner session. The Conversation view keeps the complete bounded
Turn history, while Trajectory defaults to the newest Turn and shows only that
Turn's Task. Open an older Turn's execution card to inspect its exact
historical trajectory.

### Feishu

Connect a Feishu bot to the same runtime:

```bash
metawork server setup-feishu    # wizard: QR sign-in or App ID/Secret, DM and group policy
metawork server restart
```

WebSocket connection is recommended and needs no public callback address.
With the default pairing DM policy, a user messages the bot to request
access, then an operator approves it:

```bash
metawork gateway pairing list
metawork gateway pairing approve <open_id>
```

Approved users hand tasks to MetaWork directly in Feishu, and results are
delivered back to the same chat.

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

`metawork server start`, `metawork web`, and the Feishu Gateway all use the
same activated `app/current` release. `metawork build` does not start a Server
or a Client and refuses to run while Server is active. Restart the Server
after an install, update, or build so all clients use the newly activated
Runtime and Web assets.

The workspace `dist/` directory is only a build artifact; it is never a Server
runtime. The repository `npm run server:*` and `npm start` commands delegate to
the installed `app/current` release as well. After changing source code, run
`metawork server stop`, `npm run setup:native`, and
`metawork server start` so the change is built and activated in the one
production Runtime.

`runtimePolicy.executorIdleTimeoutMs` is the optional Executor watchdog. It is
an idle timeout, not a maximum Task or attempt duration. Existing installations
that used the retired `attemptTimeoutMs` field are normalized to the new name
when their configuration is read.

### Management commands

```text
metawork server status
metawork server doctor
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

### Provider catalog and capability labels

The settings workbench is ordered runtime capacity → Provider catalog → Planner →
Executor routing, because both the Planner and the Executors can only use Models from an
already configured Provider.

When adding or editing a Provider, fill in the Base URL and API key and press
**Get model list**: the workbench probes that Provider's OpenAI-compatible `/models`
endpoint with the credentials you just typed and lists every model it offers. The built-in
model capability catalog labels the models it knows about automatically; unknown models
show "capability unconfirmed" and can be completed by hand via **Add capabilities**.
Capabilities are written together with the model when you add it as a candidate, so no
model is ever saved with an empty capability list. The pre-activation check names the exact
AgentClass binding that is missing which capability, instead of failing activation with an
error that is hard to trace.

### Updating the Planner independently

The Planner is updated separately from the rest of the configuration: the Planner section
has its own **Update Planner** button that submits only the Planner binding plus the
Models/Providers it depends on (with those Providers' secrets). Everything else keeps
running unchanged, and **Save and activate** never modifies the Planner — so updating other
settings can never be applied by a Planner that has not been updated yet.

Constraints: the Planner cannot be updated while a Task is running (the button is disabled
and states the reason); if the Planner's Model lacks a required capability (for example
`planning` / `structured-output`) or is no longer in the catalog, a pre-check reports it
first; after a successful update only the Planner baseline is refreshed, so unsaved edits
in other sections are preserved.

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
TUI / Web / Feishu / CLI
  -> ClientGateway
    -> ConversationSession
      -> AccountRuntime
        -> isolated AnyFusion-Pi Planner
          -> PlanningAgentPlan v8
            -> validation + DurableKernelWorkflow
              -> ControlKernel
                -> Execution Runtime
                  -> Executor attempt
                    -> verification -> Git publication -> delivery
```

- The persistent Server is the Runtime owner. Clients are Gateway-only and do
  not access Storage, the Kernel, or Executor processes directly.
- `ClientGateway` owns the versioned multi-client command/event protocol.
- `ConversationSession` owns one serialized input mailbox and one persisted
  AnyFusion-Pi Planner session. New semantic Planner turns cannot directly
  reply to work-like requests; except for slash-prefixed system commands, they
  must submit work to an Executor. Historical direct-reply records remain
  readable for audit and replay.
- `AccountRuntime` owns shared account services and the account's scheduling
  policy. Each Conversation has one durable execution slot, while independent
  Conversations may run concurrently within configured limits.
- AnyFusion-Pi Planner runs as an isolated process and only proposes work. It
  does not mutate Storage, schedule work, authorize execution, or execute
  shell commands.
- `ControlKernel` is the only authority for authorization, scheduling, model
  binding, recovery, retry, fallback, continuation, cancellation, and resume.
- Execution Runtime applies Kernel decisions and owns claims, leases, native
  worktree or Docker compatibility backends, attempts, Git publication, and
  normalized observations.
- Storage persists durable facts through domain ports; it is not the owner of
  business policy or lifecycle decisions.

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

MetaWork is under active commercial development. The current formal release is
`v0.1.3`, with signed native packages for macOS Intel, macOS Apple
Silicon, Linux x64, and Windows x64. The runtime provides the Server/Client
Gateway split, unified multi-client observation, bounded read models for fast
Conversation switching, the native TUI task dashboard, isolated
Planner-first routing, unified Executor capability profiles, bounded parallel
top-level Tasks across Conversations, and the Pi image execution path.
Provider-specific live image generation and editing still require a configured
OpenAI-compatible endpoint and may incur usage charges before production smoke
testing.

## License

MetaWork is proprietary and is not offered under the repository's historical
open-source license file. Company-approved commercial license terms must be
provided separately before external distribution.

AnyFusion-derived and other third-party open-source components retain their own
copyright, license, attribution, and notice requirements. The root `LICENSE`
file is retained unchanged for historical and third-party review; it does not
license the MetaWork product as a whole.
