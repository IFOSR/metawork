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
[License](#license) · [中文](README.zh-CN.md)

</div>

---

> **This branch (`fix/windows-native-web`) publishes the native Windows x64 build.**
> Installation here is Windows-only: [Install on Windows x64](#install-on-windows-x64).
> For macOS, Linux and WSL2, use the main branch instead:
> <https://github.com/IFOSR/metawork/blob/main/README.md>
>
> This branch is independent. It is not merged into `main`.

---


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
  the TUI task dashboard shows running, queued, and needs-attention work together.
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

This branch publishes the **native Windows x64 Server package** for **v0.1.22**.
It contains the Web workspace, the vendored Planner (`AnyFusion-Pi`), the pinned
memory engine, bundled Git for Windows, and the portable Python runtime used for
PDF processing. Everything runs as ordinary Windows processes: no WSL, no
Docker, no administrator rights and no Developer Mode.

| Platform | Version | Download / install |
| --- | --- | --- |
| **Windows native (`x64`) Server** | **0.1.22** | [Windows installer](https://github.com/IFOSR/metawork/releases/download/v0.1.22-windows/install.ps1) · [Signed manifest](https://github.com/IFOSR/metawork/releases/download/v0.1.22-windows/manifest.win32-x64.json) |
| macOS arm64 Desktop, macOS arm64/x64 Server, Linux x64 Server | See main | <https://github.com/IFOSR/metawork/blob/main/README.md> |

macOS and Linux are **not** built from this branch. Their Desktop DMG, Runtime
and Planner archives are published from the main branch, and their installation
steps live in the main README:
<https://github.com/IFOSR/metawork/blob/main/README.md>.

Windows assets verify against the signed `manifest.win32-x64.json`, which pins
the Runtime, Planner and memory-engine archives by SHA-256. The installer rejects
any archive whose hash or Ed25519 signature does not match, and refuses archives
for another platform or architecture.

The native Windows package has no Desktop shell. Use the browser Web workspace,
the native TUI, or Feishu against the local Server.

## Installation

This branch installs a **native Windows x64 runtime**: it runs directly on
Windows (no WSL, no Docker) and serves the browser Web workspace from
`http://127.0.0.1:8788`. Ordinary users need no administrator rights and no
Developer Mode.

| Preferred interface | Install | Open |
| --- | --- | --- |
| **Windows x64 (this branch)** | **PowerShell installer below** | Start Server, then `metawork web` |
| Terminal UI | Same Windows Server package | Start Server, then `metawork tui` |
| Feishu | Same Server package and Feishu app configuration | `metawork server setup-feishu` |
| macOS Desktop, macOS/Linux/WSL2 Server | **Not in this branch** | See [main](https://github.com/IFOSR/metawork/blob/main/README.md) |
| Source development | Source instructions below | CLI or isolated Desktop |

### Install on Windows x64

Prerequisites:

- **Node.js 22.x, at least 22.19.0** on `PATH`. This is required, not optional:
  the bundled native SQLite binding is built for Node 22 (ABI 127), so Node 24
  fails at startup with a native module error. Check with `node --version`.
- PowerShell 5.1 or later. `tar.exe` ships with Windows 10/11 and is used to
  extract the archives.
- Your model provider's API URL, model ID and API key.
- At least one supported Executor CLI on `PATH` (Pi Agent or Codex). The
  installer detects Executor CLIs but does not install them. Git for Windows is
  installed as part of the package and is used for repository operations.

Install in PowerShell:

```powershell
$version = 'v0.1.22-windows'
irm "https://github.com/IFOSR/metawork/releases/download/$version/install.ps1" -OutFile metawork-install.ps1
.\metawork-install.ps1 -ManifestUrl "https://github.com/IFOSR/metawork/releases/download/$version/manifest.win32-x64.json"
```

The Windows package is published as its **own Release** (`v0.1.22-windows`), not
as the repository's latest Release. The latest Release carries the macOS and
Linux downloads from the main branch, and a release may only contain artifacts
built from one identical commit, so the Windows-only build cannot share it.
Always pass the explicit `-ManifestUrl` shown above.

The installer downloads the signed manifest plus the Runtime, Planner and memory
engine archives, verifies every signature and SHA-256 hash before extracting,
and then runs the offline installer. It installs to
`%LOCALAPPDATA%\MetaWork` by default; pass `-InstallRoot` to choose another
directory. Installation does not need administrator rights.

Start Server and keep that window open:

```powershell
metawork server start
```

In another PowerShell window:

```powershell
metawork web                    # opens the local Web workspace
metawork tui                    # native terminal UI
metawork server setup-feishu    # optional Feishu app setup
```

`metawork web` opens the Server's actual local URL (default
`http://127.0.0.1:8788`). The first browser session asks you to sign in to the
MetaWork official account, then to configure a provider and activate models in
Settings before the first task.

Install checklist:

- `node --version` is `>=22.19.0` and below 23.
- `%LOCALAPPDATA%\MetaWork\app\current` exists and points at the release.
- `metawork server status` reports the running Server.
- `http://127.0.0.1:8788` loads the Web workspace.
- `metawork server doctor` reports no blocking problem.

To update: stop Server, run the installer again with the new version, then start
Server. Configuration, credentials and account data are preserved, and repeating
the same version does not reset the installation.

To uninstall:

```powershell
.\metawork-install.ps1 -Uninstall
```

Windows notes:

- Release, configuration and database pointers are NTFS junctions. They are the
  only directory links an ordinary user can create, which is why no Developer
  Mode or elevation is required.
- The installed package includes Git for Windows and its `bin` directory is added
  to `PATH` by the launcher, so Executors that need a POSIX shell can run commands.
- The server keeps its data under `%LOCALAPPDATA%\MetaWork`. Do not delete that
  directory to update; delete only the app pointers if support asks you to.

### macOS Desktop (internal, Apple Silicon)

> Not published from this branch. The macOS Desktop section is kept for
> reference; install macOS from
> <https://github.com/IFOSR/metawork/blob/main/README.md>.

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
5. The first launch does not ask for model credentials. If the installed Desktop
   and local Runtime have different release identities, it shows **完成更新并重启**.
   Click it once and wait; the page shows update progress and tells you not to
   click again or reopen the app. Existing credentials, conversations and work
   data are preserved.
6. After the one-time Runtime update, MetaWork opens the Web workspace. Configure
   models later in Settings, then complete the first login and choose a Workspace.

Desktop bundles Node, Pi Executor, Server/Web and Planner. macOS Command Line Tools
provide the system Git used for repository operations; Codex is optional. The default installation
is `~/.metawork`. Existing model settings, conversations and work data are
preserved; do not delete this directory to add Desktop. **Install Terminal Command…** optionally
adds `metawork`, allowing Web/TUI to connect to the same Server. Quitting Desktop
leaves Server and background work running.

To use the browser later, start Desktop (or start the installed Server), then run
`metawork web` after installing the terminal command. To use the native TUI, run
`metawork tui` in the same installation. Both clients use the Server and account
data created by Desktop; do not create a second installation for them.

To update, download/mount the latest DMG, quit MetaWork, and replace
`MetaWork.app` in Applications. On the next launch, if the Desktop and local
Runtime identities differ, choose **完成更新并重启** once and wait for the
progress indicator. There is no separate file-installation menu. Do not delete
`~/.metawork` or the application support directory.

### Server with Web / TUI / Feishu (macOS, Linux, WSL2)

These platforms are served by the **main branch**. Use
<https://github.com/IFOSR/metawork/blob/main/README.md> for their installation,
including the macOS Desktop DMG and the `install.sh` prebuilt archives.

Prerequisites: **Node.js 22.x, at least 22.19.0**, Git, your model provider's API
URL/model ID/API key, and at least one supported Executor CLI (Pi Agent or Codex)
on `PATH`. The installer detects Executor CLIs but does not install them.
Prebuilt archives include native dependencies; npm and native build tools are
required for source builds, not ordinary prebuilt installation.

Windows x64 is installed by the PowerShell procedure in
[Install on Windows x64](#install-on-windows-x64) above.

Start Server in one terminal and keep it running:

```bash
metawork server start
```

In another terminal, choose your client:

```bash
metawork web                    # opens the local Web workspace
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

Three steps from a fresh Windows install to your first delivered task:

```powershell
# 1. Start the Server (foreground; keep this window open)
metawork server start

# 2. In a second PowerShell window, open the Web workspace
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

## License

MetaWork is proprietary and is not offered under the repository's historical
open-source license file. Company-approved commercial license terms must be
provided separately before external distribution.

AnyFusion-derived and other third-party open-source components retain their own
copyright, license, attribution, and notice requirements. The root `LICENSE`
file is retained unchanged for historical and third-party review; it does not
license the MetaWork product as a whole.
