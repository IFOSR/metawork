<p align="center">
  <strong>Shanghai Metafusion Artificial Intelligence Technology Co., Ltd.</strong>
</p>

<div align="center">

# MetaWork

**A commercial AI Task OS for durable, governed agent work.**

MetaWork turns a natural-language request into a durable Task and Work Graph, runs it
through one owned control path (Manager proposal → admission → Router → Executor →
certification → delivery), and keeps the result, its receipts and its recovery facts
across restarts instead of ending at a chat reply.

[Install](#install) · [Quick start](#quick-start) · [What's new in 0.1.29](#whats-new-in-0129) ·
[Architecture](#architecture) · [Upgrading](#upgrading-from-the-previous-architecture) ·
[Usage](#usage) · [License](#license) · [中文](README.zh-CN.md)

</div>

## Install

**Current release: v0.1.29 (internal), one build for every asset —
`0.1.29-build-0ab2ee7`, revision `0ab2ee7`.** Download from
[the latest release](https://github.com/IFOSR/metawork/releases/latest).

| Platform | Addressed to | Download |
| --- | --- | --- |
| macOS Apple Silicon (`arm64`) | **Desktop app** (bundles Runtime, Web and Executor Pi) | [MetaWork-darwin-arm64.dmg](https://github.com/IFOSR/metawork/releases/latest/download/MetaWork-darwin-arm64.dmg) — 345,114,277 bytes, SHA-256 `10a1723041b7537982fd383c20660b16d1cae3843892f5f965997f1517a7cf71` |
| macOS Apple Silicon (`arm64`) | **Server package**, used through the Web client | [install.sh](https://github.com/IFOSR/metawork/releases/latest/download/install.sh) · [manifest.darwin-arm64.json](https://github.com/IFOSR/metawork/releases/latest/download/manifest.darwin-arm64.json) |
| macOS Intel (`x64`) | **Server package**, used through the Web client | [install.sh](https://github.com/IFOSR/metawork/releases/latest/download/install.sh) · [manifest.darwin-x64.json](https://github.com/IFOSR/metawork/releases/latest/download/manifest.darwin-x64.json) |
| Linux / WSL2 (`x64`) | **Server package**, used through the Web client | [install.sh](https://github.com/IFOSR/metawork/releases/latest/download/install.sh) · [manifest.linux-x64.json](https://github.com/IFOSR/metawork/releases/latest/download/manifest.linux-x64.json) |

The release holds 15 assets of that single build: nine archives (`metawork`,
`memory` and `pi` for each of the three targets), three signed manifests,
`install.sh`, the Pi build-time pin and one Desktop DMG.

- **Only macOS Apple Silicon has a Desktop installer.** macOS Intel and Linux x64
  receive Server packages and use the Web client; there is no Intel DMG, no Linux
  Desktop package and no Linux arm64 archive.
- **No Windows artifacts are published** — not the Server package, not
  `install.ps1`. Windows source is unmaintained and lives only on the
  [`fix/windows-native-web`](https://github.com/IFOSR/metawork/tree/fix/windows-native-web) branch.
- The Desktop DMG is **ad-hoc signed and not notarized** (internal build), so the
  first launch needs Finder → right-click → **Open**, or
  System Settings → Privacy & Security → **Open Anyway**.
- Server archives are verified by the installer against the signed manifest
  (`sha256` + byte size, trust root `metawork-release-2026-03`); each archive
  carries Runtime (`dist` + production dependencies + Web assets), the Memory
  engine and the pinned Pi Executor.

Two ways to use it: the **Desktop app** (macOS arm64, step-by-step below) or a
**Server package plus the Web client** on any of the three targets. Both share one
installation root and one account data set.

## Install steps

The steps below cover the Desktop app, the Server packages, a source checkout and
how to remove MetaWork again.

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
5. The first launch does not ask for model credentials. It installs the Runtime
   bundled with the app into `~/.metawork` automatically and restarts the
   background service; progress and the final state are shown in the window, and
   no manual confirmation is needed. If a previous update was interrupted, the app
   isolates the incompatible installation, installs the bundled version cleanly,
   and restores the previous installation if that clean install fails. Existing
   credentials, conversations and work data are preserved.
6. When the background service is ready, MetaWork opens the Web workspace.
   Configure models later in Settings, then complete the first login and choose a
   Workspace.

Desktop bundles Node, Pi Executor, Server/Web and Memory; there is no packaged
Planner fork. macOS Command Line Tools provide the system Git used for repository
operations; Codex is optional. The default installation is `~/.metawork`. Existing
model settings, conversations and work data are preserved; do not delete this
directory to add Desktop. **Install Terminal Command…** optionally adds
`metawork`, allowing Web to connect to the same Server. Quitting Desktop leaves
Server and background work running.

To use the browser later, start Desktop (or start the installed Server), then run
`metawork web` after installing the terminal command; a bare `metawork` opens the
same Web client. The TUI that earlier versions documented is removed and is no
longer a supported client. Web uses the Server and account data created by
Desktop; do not create a second installation for it.

To update, download/mount the latest DMG, quit MetaWork, and replace
`MetaWork.app` in Applications. The next launch adopts the bundled Runtime and
restarts the background service automatically, showing progress instead of asking
for a manual step. There is no separate file-installation menu. Do not delete
`~/.metawork` or the application support directory.

### Server with Web / Feishu

Prerequisites: **Node.js 22.x, at least 22.19.0**, Git, your model provider's API
URL/model ID/API key, and at least one supported Executor CLI (Pi Agent or Codex)
on `PATH`. The installer detects Executor CLIs but does not install them.
Prebuilt archives include native dependencies; npm and native build tools are
required for source builds, not ordinary prebuilt installation.

macOS Apple Silicon or Intel, Linux x64 or WSL2 x64, in an interactive terminal:

```bash
curl -fsSL https://github.com/IFOSR/metawork/releases/latest/download/install.sh -o metawork-install.sh
bash metawork-install.sh
export PATH="$HOME/.local/bin:$PATH"
metawork --help
```

This command uses the **latest stable release's signed manifest** and verifies the
Runtime/Memory/Pi archives before installation.

The setup wizard configures the model provider; Linux/WSL2 defaults to file-backed
secrets. Unsupported architectures are rejected rather than given another platform's archive.

Start Server in one terminal and keep it running:

```bash
metawork server start
```

In another terminal, choose your client:

```bash
metawork web                    # opens the local Web workspace (bare `metawork` does the same)
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
│   ├── current -> releases/<releaseId>
│   └── releases/
├── data/
│   ├── gateway.sock
│   └── runtime.lock
├── credentials.json
├── accounts/local-default/
│   ├── account.json
│   ├── config/
│   │   ├── active -> revisions/<revisionId>
│   │   └── revisions/
│   ├── manager/
│   ├── conversations/
│   ├── generated/
│   ├── data/
│   │   ├── anyfusion.db
│   │   ├── database-revisions/
│   │   ├── backups/
│   │   └── results/
│   ├── workspace-catalog/
│   ├── workspace-store/
│   ├── workspace-git/
│   ├── attempts/
│   └── gateway/
└── upgrade-journals/
```

Set `METAWORK_INSTALL_ROOT` before installation to use a different root.

## Quick start

### Path A — macOS Apple Silicon Desktop

1. Open the DMG and drag **MetaWork.app** into **Applications** (first launch may
   need Finder → right-click → **Open** because the internal build is not
   notarized).
2. Launch it. The app installs the Runtime bundled inside the `.app` into
   `~/.metawork`, starts the background Server and reports progress — no manual
   confirmation, no terminal commands. If a previous update was interrupted, it
   isolates the incompatible installation and installs cleanly, restoring the old
   one if that fails.
3. When the window shows the Web workspace, open **设置** and configure once:
   add a Provider (Base URL + API key, then **获取模型列表**), pick a model, bind a
   model to each required role (总管 Manager is always enabled; 助理/分析师
   Executors), then **保存并激活**.
4. Add a Workspace (a local directory) with **＋**, start **新建会话**, and describe
   the task in natural language. The Manager proposes a Work Graph, MetaWork
   admits it, the Router picks an Executor/model per Subtask, and results are
   certified, published through the Git gate and delivered into the Conversation.

### Path B — Server package + Web client (any of the three targets)

```bash
# 1. Install or update one activated release under ~/.metawork
curl -fsSL https://github.com/IFOSR/metawork/releases/latest/download/install.sh | bash

# 2. Start the Server (foreground; use scripts/supervision templates for background)
metawork server start

# 3. Open the Web client (bare `metawork` opens the same page)
metawork web            # http://127.0.0.1:8788
```

Then configure models and roles exactly as in Path A, step 3, and create a
Workspace and a Conversation. `metawork web --no-open` only prints/uses the URL
(for example over SSH or through a port forward). Feishu is optional:
`metawork server setup-feishu`.

### First configuration checklist

1. **Provider and model** — Settings → 模型 → 新增模型; the workbench probes the
   Provider's `/models` endpoint and labels known capabilities.
2. **Role binding** — Settings → 智能体; every required role must bind a model of
   its own before **保存并激活** is accepted (the check names the missing role).
3. **Workspace** — a local directory the Executor may modify. Executor changes
   happen in managed Git worktrees and pass the publication gate.
4. **Conversation** — one Conversation holds the Turn history; the Trajectory view
   shows the newest Turn's Task and each older Turn's execution card.

### Command cheat sheet

```text
metawork server start | stop | restart | status | doctor   # Server lifecycle and health
metawork web [--no-open]          # Web Client at http://127.0.0.1:8788
metawork server setup-feishu      # connect a Feishu bot (interactive wizard)
metawork gateway pairing list | approve | revoke <open_id>
metawork build                    # rebuild the source checkout and activate one release
metawork config show | validate | history | diff | rollback
metawork provider list | add | edit | test | remove
metawork model    list | add | edit | test | remove
metawork executor list | add | edit | enable | disable | remove | test
```

## What's new in 0.1.29

0.1.29 turns the Executor's web tools onto DeepSeek and starts counting what they
bill. The full list is in [the release notes](docs/releases/v0.1.29.md).

- `web_search` prefers DeepSeek's Search API whenever a DeepSeek Provider
  credential is configured and falls back to Bing HTML otherwise; results now
  carry publication date, site and authority. The Baidu scraper is gone.
- `web_fetch` is routed by affordance: research attempts read pages through
  DeepSeek's extraction API, workspace attempts keep curl so a local service they
  started stays reachable.
- The DeepSeek credential is the Provider key itself — no separate search key —
  and an unresolvable credential degrades to Bing instead of failing the attempt.
- Billed web-tool requests are metered: each billable DeepSeek search is one
  `search` request and each billable fetch is one `tool_request`, shown in the
  account usage view. Free fallbacks and rejected URLs are not counted.

## What's new in 0.1.27

0.1.27 is the release that lands the target architecture and the recovery work
around it. Every item below is in this build; the full list with evidence is in
[the release notes](docs/releases/v0.1.27.md).

**Architecture**
- The Kernel control axis is gone. Task admission, lifecycle, dispatch, recovery
  and publication are owned by the Task Runtime over the `src/control` contracts;
  the Manager only produces a proposal that MetaWork validates.
- The packaged Manager and Executor both run the **pinned upstream Pi (`1.5.0`)**;
  the vendored `planner/AnyFusion-Pi` fork was deleted and is no longer shipped.
- Planning facts carry the **execution write fact** (Executor commits in the
  Conversation Git worktree, Runtime merges it back) instead of presenting the
  Manager's read-only tool surface as a property of the Workspace, and
  clarifications are reserved for user-intent ambiguity.
- Schema `67 → 68` upgrades **in place** (`task_operation_results.outcome` gains
  `repair_pending`); older or unknown schemas are still refused before any write.

**Execution and recovery**
- A blocked Subtask with a recoverable failure keeps the Task `needs_action`
  instead of finalising it, so **继续未完成部分** can resume with its receipts.
- A Task left `executing` without live dispatch is parked: the idle replan is
  cancelled and the block is concluded through the Task state authority.
- Reconciliation cancels orphan replans of terminal Tasks, so a failed Task can no
  longer keep the Conversation slot `releasing` and queue everything behind it.
- `recoverDue` now dispatches when runnable work exists, and an explicitly
  accepted receipt counts as a completion source.
- Running or terminating a process requires exclusive Workspace access; external
  process termination is gated on an explicit user turn.
- Anti-bot/verification pages returned by `web_fetch`/`web_search` become blocked,
  retryable sources instead of being handed to the model as content.
- When the Router's decision model is unavailable it uses the deterministic
  default binding (`selection: default_fallback`); only an empty candidate set
  blocks a Subtask.

**Web**
- The Manager planning process is observable: phase timeline, tool names,
  argument/result field names and elapsed time, expanded inline in the planning
  card and removed with it once the turn is sealed.
- Trace events no longer carry a status, so finished turns stop showing endless
  `running` progress and its pulse animation.

**Desktop**
- An interrupted update whose restore stage failed is recovered automatically:
  the incompatible installation is isolated (never a symlink, never while an
  update helper or background server is alive), the current version is installed
  cleanly, and the previous installation is restored if that clean install fails.
- Choosing a data directory accepts an empty directory for a new installation and
  rejects a non-empty directory that is not a MetaWork installation.
- `electron-builder` packages the pinned local Electron distribution instead of
  fetching checksum metadata again.

**Packaging**
- Archives are built from an explicit runtime allowlist that excludes development
  toolchains (`typescript`, `vitest`, `esbuild`, `tsup`, `vite`, `rollup`,
  `@types`, `.bin`) and repository `docker`/`.github` trees.
- The Apple Silicon DMG drops from roughly 465 MB to roughly 345 MB for the same
  product surface, and all 15 assets carry one release identity.

## Architecture

### Control flow

```text
User -> Manager:      understand intent, propose the Work Graph
                     (no Agent/model fields, no storage writes)
     -> Task Runtime: admit the proposal, validate the graph, persist its revision
     -> Router:       per ready Subtask decide {Agent, model, rationale}
     -> Task Runtime: persist the route decision, claim the attempt, launch an Executor
     -> Executor:     do the authorized work inside enforced boundaries
     -> Task Runtime: receipts, lifecycle, publication, mechanical recovery
     -> Manager:      assemble the Task result for the user
```

There are exactly three roles — **Manager**, **Router**, **Executor** — and no
Kernel. A Work Graph is a pure rule module, the Task Runtime is an application
module, the Host is an enforcement boundary, Storage is an adapter, and the
Application Shell owns admission and client projection.

### One owner per fact

| Concern | Owner |
| --- | --- |
| Turn/Conversation admission, Task creation | Application Shell + Task Runtime admission |
| Intent understanding, graph proposal, replan semantics, final summary | Manager (`src/planning`, upstream Pi via `src/planning/manager-host`) |
| Graph schema, DAG, dependency and frontier rules | Work Graph (`src/work-graph`) |
| Agent/model selection per Subtask and its rationale | Router (`src/routing`) |
| Route persistence, candidate facts, dispatch identity | Task Runtime (`src/task`, `src/execution`) |
| Task/Subtask/Attempt lifecycle, leases, cancellation, recovery | Task Runtime (`src/task`, `src/execution`) |
| Executor tool surface, turn loop, tool retry/repair | Executor/Harness (`src/executor`, upstream Pi) |
| Permission semantics | Manager |
| Permission record, scope validation, application | Permission Service (`src/resource`, `src/execution/permission-workflow-service`) |
| Permission enforcement | Host/Executor process boundary |
| Completion certification and result delivery | Delivery/Completion (`src/delivery`) |
| Workspace publication, merge order, conflict repair request | Task Runtime publication worker |
| Token usage per model call | Metering (`src/metering`) |
| Server bind, authentication, allowed origins, loopback-only internals | Server/Gateway (`src/gateway`, `src/management`) |
| Restart recovery mechanics | Task Runtime startup recovery (`src/account`, `src/execution`) |

A single in-process lifecycle facade (`ControlLoopPolicy`) evaluates owner
policies for one Task. It is **not** a durable inbox/decision ledger, not a
replay engine and not a second approval of Router output; duplicate decision
paths, Kernel compatibility APIs and renamed central coordinators are prohibited.

### Durability and recovery

- Tasks, Subtasks, attempts, results, publications, permissions, usage and client
  facts each have one owner table and survive restart; recovery items
  (`task_recovery_items`) record interrupted operations instead of a replayed
  control ledger.
- SQLite schema `68` is defined in `src/storage/current-schema.ts`: startup accepts
  the current schema, upgrades exactly the preceding schema (`67 → 68`) in place,
  and refuses older or malformed schemas before mutating anything.
- Executor work has no overall wall-clock limit. The optional watchdog fires only
  when the Executor process is genuinely idle and is paused while an authoritative
  operation is active.
- Completion is certified before delivery; an undelivered publication never
  renders as complete, and only Manager-declared optional Subtasks may be absent
  from a successful result.

### What a release contains

| Component | Where it comes from | Why |
| --- | --- | --- |
| Runtime | `dist/` (tsup build) + production `node_modules` + `web/dist` | One Server process, one Web bundle |
| Memory engine | pinned `memory/tdai` tree | Local long-term memory works offline |
| Executor Pi | pinned upstream Pi distribution | No host-global Pi dependency, no fork |
| Manifest | Ed25519 signature (`metawork-release-2026-03`) | Installer verifies byte size + SHA-256 per archive |
| Desktop payload (DMG only) | the same Runtime/Memory/Pi archives | The app adopts a payload without downloading anything |

The Manager and the Executor run the **same** pinned upstream Pi version, recorded
in the manifest together with its lockfile digest; a build fails when that Pi is
missing or is not the pinned release. The Manager runs in a separate process under
`src/planning/manager-host` and only ever produces a proposal.

### Network and enforcement boundary

- The Server speaks HTTP; TLS terminates at a reverse proxy. `server.host`,
  `server.allowedOrigins` and `server.trustProxy` are the configuration surface; a
  wildcard bind with an empty allowlist refuses to start.
- Browser access requires an account login; the login session is the transport and
  Origin/CSRF validation stays on.
- Internal endpoints (Manager bridge, memory sidecar, official local service, MCP)
  stay on loopback or a Unix socket. The documented isolation boundary is a
  trusted user process plus Host enforcement — there is no OS sandbox in this
  build, and the retired Docker attempt backend is not a supported fallback.

## Upgrading from the previous architecture

This release is the cutover to the target architecture, so it is worth being
explicit about what changed, why, and what happens to an existing installation.

### What was removed

| Removed | Replaced by |
| --- | --- |
| `ControlKernel`, `DurableKernelWorkflow`, Kernel events/snapshots/decisions, decision ledger and replay | `src/control` contracts + `ControlLoopPolicy` over the Task Runtime; recovery items in `task_recovery_items` |
| Vendored `planner/AnyFusion-Pi` fork | Pinned upstream Pi for both Manager and Executor (`src/planning/manager-host`) |
| Agent/model selection inside the Manager proposal | Router decides agent + model per Subtask and persists the rationale |
| Ink TUI, the standalone agent TUI and TUI-only flags | Web client (`metawork web`; bare `metawork` opens it) |
| Docker attempt backend, attempt images, egress proxy, Docker-only tests | Trusted host execution plus Host enforcement |
| Codex execution adapter, its configuration and catalog | Host-only execution configuration |
| Model price, per-task cost, amount-confirmation state | Metering keeps token facts only; billing authority stays in `official-server` |
| Native Windows support | Declared unmaintained; source kept on a side branch, no artifacts published |

### Why this is the better architecture

- **One owner per fact.** Every lifecycle, route, permission, publication and
  usage fact has exactly one writer, so a failure is attributed to the owner that
  produced it instead of to "the system". There is no duplicate decision path, no
  ledger replay, and no second approval of a Router decision.
- **Fewer moving parts per request.** The removed Kernel added a durable inbox, a
  decision ledger and replay machinery to answer questions the owners could answer
  directly. Dropping them removes a whole class of stuck-state bugs: the 0.1.27
  fixes for parked Tasks, orphan replans and resumable blocks are exactly the
  failures that a second decision authority used to hide.
- **Reproducible releases.** Manager and Executor ship the same pinned upstream
  Pi, archives are built from an explicit runtime allowlist, and every asset is
  signed and hash-verified, so "works on my machine" drift is much harder.
- **Predictable upgrades.** One forward-only schema step, the same installation
  root, automatic Runtime adoption in the Desktop app, and a restore path when a
  clean install fails — instead of migration chains and hand-run repair scripts.
- **Honest failure semantics.** Hard denies cannot be overridden by any model,
  unknown capability fails closed, `no_candidate` blocks a Subtask explicitly
  rather than silently falling back, and an undelivered publication never renders
  as complete.
- **Smaller, more focused delivery.** The DMG went from roughly 465 MB to roughly
  345 MB and the archives no longer carry development toolchains.

### How an existing installation upgrades

- **Same root, same data.** The installation root (`~/.metawork`) and the account
  data (Conversations, Workspaces, memory assets, task results, configuration
  revisions) are unchanged. Nothing is re-imported and nothing is rewritten
  outside the accounted schema upgrade.
- **Database.** Startup accepts schema `68`, upgrades exactly `67` in place, and
  refuses anything older or malformed **before** writing, naming the backup and
  the reset instruction. There is no export/partial-open path, and the retired
  Kernel ledger is not read.
- **Desktop (macOS arm64).** Replace `MetaWork.app` with the new DMG and launch it.
  It adopts the Runtime bundled inside the app, restarts the background Server and
  shows progress; no manual step. If an interrupted update left an incompatible
  installation behind, it isolates that directory, installs cleanly and restores
  the previous installation when the clean install fails. Existing credentials,
  Conversations and Workspaces are preserved.
- **Server packages.** Re-run `install.sh` (or `metawork build` for a source
  checkout). The installer stages and verifies the archives first, then activates
  one release under `app/releases/<releaseId>` behind the `app/current` symlink;
  `metawork server start` and the Web client pick it up after the restart, and the
  endpoint (default `http://127.0.0.1:8788`) is unchanged.
- **What is intentionally not compatible.** There is no Kernel API, decision
  ledger, TUI entry, Windows package or Docker attempt backend to fall back to, and
  no compatibility shim is provided for them. Historical runtime identifiers
  (`MetaClaw`, `anyfusion`, `METACLAW_*`) keep their names only where renaming
  would break installed data or a signed contract; they do not carry a second
  behaviour. Scripts that used the removed surfaces need to move to the Web client,
  the CLI commands below, or the `src/control` contracts.

## Why MetaWork

MetaWork provides one commercial service system for planning, admitting,
executing, recovering, and delivering agent work.

- **Durable work:** Tasks, Work Graphs, results, recovery facts, and audit history
  persist across process restarts.
- **Governed execution:** the Manager proposes work, MetaWork admits and validates
  the proposal, and Executors run only concrete approved attempts.
- **Multiple clients, one runtime:** Desktop, Web and Feishu share the same
  versioned Gateway command and event plane. The Server owns the Runtime and stays
  alive when clients exit.
- **Unified multi-client observation:** Web and Feishu follow the same Tasks and
  Conversations. Switching sessions reads a bounded client read model instead of
  replaying an entire historical session, and running, queued and
  needs-attention work is visible from every client.
- **Explainable routing:** every attempt is pinned to a configuration revision, a
  Provider, a Model, an AgentClass and a Permission Profile, and carries the
  Router's persisted rationale in the trace.
- **Capability-driven routing:** the Router compares each AgentClass's recorded
  duties and capability evidence with the Subtask's goal and acceptance criteria.
  Generic capability tags do not score quality, no model price state is kept, and
  concrete execution and permission requirements stay enforced.
- **Context continuity:** the Manager keeps its persisted Pi session for references
  such as "this image" or "the report just produced"; MetaWork's context bridge
  supplies bounded Conversation facts, validates selected historical artifacts and
  materializes only authorized inputs for the Executor.
- **Reliable long execution:** Executor work has no overall wall-clock limit. The
  optional watchdog expires only when the Executor process is genuinely idle and is
  paused while an authoritative operation is active.
- **Explicit recovery:** retry, fallback, continuation, merge repair, cancellation
  and resume are owned by MetaWork's durable control contracts.

```text
Propose -> Admit -> Route -> Dispatch -> Execute -> Verify -> Publish -> Deliver
```

## Product Boundary

MetaWork is the canonical product represented by this repository. It is a
proprietary commercial system.

[AnyFusion](https://github.com/IFOSR) is a separate open-source project.
MetaWork may reuse or adapt attributed AnyFusion components and contracts, and
`MetaClaw`/`anyfusion` identifiers retain their historical names where changing
them would break existing installations. The packaged Manager and Executor run
the pinned upstream Pi (ADR-0055 D6); the vendored `planner/AnyFusion-Pi` fork is
removed and is not part of this repository or its releases.

## Usage

### Web workspace

Connects to the running Server (`metawork server start`):

```bash
cd /path/to/your/project
metawork web
metawork web --no-open
```

The launch directory is proposed as the initial Workspace context, and the
browser opens `http://127.0.0.1:8788`. Normal startup
exchanges a short-lived URL-fragment bootstrap for an HttpOnly,
SameSite=Strict session cookie; use `--no-open` for SSH, port forwarding, or
manual browser startup. Authorized Executor changes happen in managed
Task/Subtask Git worktrees and pass through the publication gate.

Every Turn in the selected Conversation remains visible and available to the
persisted Manager session. The Conversation view keeps the complete bounded
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
recorded for this installation. It installs dependencies, rebuilds Runtime and Web,
then atomically activates one release without changing account data. Stop the persistent Server first:

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

The settings workbench is ordered runtime capacity → Provider catalog → Manager →
Executor routing, because both the Manager and the Executors can only use Models from an
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

### Agent roles and model binding

The Settings workbench has three groups: **模型** (Providers and models),
**执行工具** (the bundled Executor Pi and each AgentClass's readiness) and
**智能体** (roles). The Manager role 总管 is always enabled and is the planning
entry point; 助理 and 分析师 are Executor roles. Every required role must bind a
model of its own before **保存并激活** is accepted, and the pre-activation check
names the role that is still missing a binding instead of failing vaguely.

Saving is a single activation: the draft is validated, written as a configuration
revision and applied to the running Server as one unit. The Manager cannot be
swapped while a Task is running, and unsaved edits in other sections are preserved.

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

The final manual is the semantic source for the Manager. The routing projection is
its machine-readable view used by Manager validation and MetaWork's model
selection. User guidance takes precedence over conflicting generated
positioning, but it cannot authorize an unconfigured Model, widen permissions,
or bypass MetaWork's admission checks. Removing a Model automatically removes the
capabilities it was the only evidence for after the profile is refreshed.

## License

MetaWork is proprietary and is not offered under the repository's historical
open-source license file. Company-approved commercial license terms must be
provided separately before external distribution.

AnyFusion-derived and other third-party open-source components retain their own
copyright, license, attribution, and notice requirements. The root `LICENSE`
file is retained unchanged for historical and third-party review; it does not
license the MetaWork product as a whole.
