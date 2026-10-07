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
- **Multiple clients, one runtime:** Desktop, Web, TUI, and Feishu clients
  share the same versioned Gateway command and event plane. Server owns the
  Runtime and remains alive when Clients exit.
- **Unified multi-client observation:** Web, Feishu, and the native TUI can
  follow the same Tasks and Conversations. Switching sessions reads a bounded
  client read model instead of replaying an entire historical session, while
  the TUI task dashboard shows running, queued, and blocked work together.
- **Explainable routing:** every authorized attempt is pinned to a configuration
  revision and a complete Provider, Model, AgentClass, Harness, and Permission
  Profile binding.
- **Capability-driven routing:** Planner uses each Executor's duties and
  capability evidence for task planning. The decision advisor compares detailed
  model strengths, limitations, task fit, available tools, and prices when
  selecting an Agent-model pair. Generic capability tags do not score quality;
  concrete execution and permission requirements remain enforced.
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

[Latest stable release](https://github.com/IFOSR/metawork/releases/latest) is the
source of truth for the current installable version. A newer source checkout
is not a published release.

The current internal release is **v0.1.5**. It includes the Server/Web/TUI
runtime and an Apple Silicon Desktop DMG for company use. The Desktop DMG is
**unsigned and not notarized**; it is intentionally distributed for the internal
macOS fleet. The [release page](https://github.com/IFOSR/metawork/releases/latest)
is the source of truth for the exact assets and checksums.

This internal release currently provides a macOS Apple Silicon (`arm64`) DMG.
An Intel (`x64`) Desktop build is not included; Intel users should use the
Server/Web/TUI installation or wait for an x64 build. Linux and Windows Desktop
packages are not provided.

## Installation

Desktop, browser, TUI and Feishu share one Server and the selected installation's
account data. Web is included in the Server package and does not require Desktop.

| Preferred interface | Install | Open |
| --- | --- | --- |
| macOS Desktop | Desktop DMG | MetaWork.app |
| Browser | Native Server package | Start Server, then `metawork web` |
| Terminal UI | Same Server package | Start Server, then `metawork tui` |
| Feishu | Same Server package and Feishu app configuration | `metawork server setup-feishu` |
| Source development | Source instructions below | CLI or isolated Desktop |

### macOS Desktop (internal, Apple Silicon)

1. Confirm that the Mac uses Apple Silicon under **Apple menu → About This Mac**.
2. Install Apple's Command Line Tools once if they are not already present:
   run `xcode-select --install` in Terminal and finish the macOS prompt. The
   internal package uses the system Git wrapper for repository operations.
3. Download [MetaWork-darwin-arm64.dmg](https://github.com/IFOSR/metawork/releases/latest/download/MetaWork-darwin-arm64.dmg)
   from the latest release, open it, and drag **MetaWork.app** to **Applications**.
4. The first launch may be blocked because this internal DMG is not notarized. In
   Finder, right-click **MetaWork.app** and choose **Open**, then confirm **Open**.
   If macOS still blocks it, open **System Settings → Privacy & Security**, scroll
   to the security message, and choose **Open Anyway**; then repeat step 3.
5. The MetaWork setup window asks for **模型 API 地址**, **模型 ID** and **API Key**.
   Enter the provider values used by your company and choose **安装并开始使用**.
   Credentials are stored in the local macOS credential store.
6. After setup, MetaWork opens the Web workspace. Keep the Desktop running while
   you complete the first login and choose a Workspace.

Desktop bundles Node, Pi Executor, Server/Web and Planner. macOS Command Line Tools
provide the system Git used for repository operations; Codex is optional. The default installation
is `~/.metawork`. Compatible existing installations are reused; incompatible
versions require a coordinated update. **Install Terminal Command…** optionally
adds `metawork`, allowing Web/TUI to connect to the same Server. Quitting Desktop
leaves Server and background work running.

To use the browser later, start Desktop (or start the installed Server), then run
`metawork web` after installing the terminal command. To use the native TUI, run
`metawork tui` in the same installation. Both clients use the Server and account
data created by Desktop; do not create a second installation for them.

To update, download/mount the latest DMG, then use **Install New Application…**
in the running Desktop to select its `MetaWork.app`. If macOS blocks the new app,
apply the right-click **Open** / **Open Anyway** steps above first. This updates
Desktop and Server together and explains the impact on active work. Use this path
for a Desktop-managed installation instead of updating only its Server.

### Server with Web / TUI / Feishu

Prerequisites: **Node.js 22.x, at least 22.19.0**, Git, your model provider's API
URL/model ID/API key, and at least one supported Executor CLI (Pi Agent or Codex)
on `PATH`. The installer detects Executor CLIs but does not install them.
Prebuilt archives include native dependencies; npm and native build tools are
required for source builds, not ordinary prebuilt installation.

macOS, Linux x64 or WSL2 x64, in an interactive terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.sh -o metawork-install.sh
bash metawork-install.sh
export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

Windows x64, in PowerShell (enable Developer Mode or use an elevated terminal
for NTFS release pointers):

```powershell
irm https://raw.githubusercontent.com/IFOSR/metawork/main/scripts/install.ps1 -OutFile metawork-install.ps1
.\metawork-install.ps1
```

Both scripts resolve the **latest stable release's signed manifest** and verify
its Runtime/Planner archives. The setup wizard configures the model provider.
Linux/WSL2 defaults to file-backed secrets. The release page also contains the
matching `install.sh` and `install.ps1` files when a platform archive is available.
The current internal release's prebuilt runtime is Apple Silicon; the shell
installer reports an unsupported architecture instead of installing a mismatched
archive.

Start Server in one terminal and keep it running:

```bash
metawork server start
```

In another terminal, choose your client:

```bash
metawork web                    # browser login: admin / 123456
metawork tui                    # native terminal UI
metawork server setup-feishu    # optional Feishu app setup
```

Web opens the Server's actual local URL (default port 8788). Feishu connectivity
is managed by the same Server. For background service operation use the
launchd/systemd templates under `scripts/supervision/`.

To update a CLI-managed installation: `metawork server stop`, repeat the installer,
then `metawork server start`. Configuration, credentials and account data are
preserved. Repeating the same version does not reset the installation.
`metawork server status` reports the running service; the latest Release page
reports the available version.

Optional settings AI rewriting/explanations and model summaries require
separately provisioned [internal LLM configuration](docs/current/internal-llm-service.md).
Its absence does not block installation or manual configuration.

### Source installation and Desktop development

Source builds require npm, native compilation tools and network access for the
pinned Python/PDF dependencies. To build the latest **released** source, get its
tag from the latest Release page and replace `<latest-tag>`:

```bash
git clone --branch <latest-tag> --depth 1 https://github.com/IFOSR/metawork.git
cd metawork
./setup.sh
export PATH="$HOME/.local/bin:$PATH"
```

For Desktop development from a checkout:

```bash
npm ci
npm ci --prefix web --ignore-scripts
npm ci --prefix apps/desktop
npm ci --prefix planner/AnyFusion-Pi --ignore-scripts
npm run dev:desktop
```

This uses `.tmp/desktop-development`, separate from production history. The
current development helper requires provisioned internal LLM configuration;
that is not a production Desktop installation requirement. After backend changes,
run `npm run dev:desktop -- --refresh`. See [Desktop development](apps/desktop/README.md).

Non-interactive native setup accepts `METAWORK_PROVIDER_KEY`,
`METAWORK_PROVIDER_URL`, `METAWORK_PROVIDER_MODEL` and `METAWORK_PROVIDER_REGION`.
Do not commit credentials or include them in release artifacts.

### Removal

Removing the Desktop app preserves account data and does not stop Server; stop
it explicitly first if desired. `bash metawork-install.sh --uninstall` removes
managed CLI launchers **and the install root, including account data**. Back up
work you want to keep.

Maintainers: see the [release runbook](docs/current/releasing.md).

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
`v0.1.4`, with signed native packages for macOS Intel, macOS Apple
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
