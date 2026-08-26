# AnyFusion Public README Refresh Design

**Status:** Completed

**Plan date:** 2026-08-26

**Completion date:** 2026-08-26

**Goal:** Bring the English and Chinese repository READMEs in line with the
current AnyFusion product name, installation behavior, runtime architecture,
configuration model, and released contract versions.

## Scope

- Update `README.md` and `README.zh-CN.md` together.
- Keep both files concise public landing pages rather than duplicating the
  long-form technical overview.
- Use code and tests, accepted ADRs, `CONTEXT.md`, and current technical docs
  as the authority for every installation and architecture claim.
- Preserve internal/runtime names such as MetaClaw only where compatibility or
  implementation context requires them.

## Public Narrative

The README should describe AnyFusion as a local-first AI Task OS that turns a
conversation into durable, governed work. The high-level execution path is:

```text
Client -> Gateway -> ConversationSession -> AccountRuntime
  -> PlanningAgent -> ControlKernel -> Runtime -> Executor
```

The public overview must emphasize:

- one unified client Gateway for TUI, Web, Feishu, script, and Unix clients;
- durable Tasks, Work Graph execution, recovery, verification, and Git
  publication;
- Planner proposal authority separated from ControlKernel authorization and
  Runtime side effects;
- revision-pinned Provider/Model/AgentClass/Harness bindings;
- one active top-level Task per AccountRuntime, with up to four concurrent
  Subtask attempts;
- Completion Protocol v4 and result-first delivery.

The README must not claim that AnyFusion computes a mathematical Pareto
frontier. Auto model routing is an explainable weighted selection over an
allowed candidate pool, and Planner routing remains fixed-only.

## Installation Contract

The primary source installation is `./setup.sh`. It requires Node.js 22.19+,
npm, Git, native build tools, provider credentials, and the vendored
`planner/AnyFusion-Pi` source. macOS is the primary native path; Linux and WSL2
use the same Unix-oriented setup with file-backed secrets. Codex and Pi are
independent Executor installations: setup detects them and enables the
available classes without modifying personal Executor homes.

The documented installed command is `anyfusion`. Source installation does not
promise `metawork` or `metaclaw` launchers. The runtime layout should show the
account-scoped configuration, generated runtime, database revisions, Planner
sessions, Conversations, workspaces, attempts, and installation-global lock
and socket.

## Validation

- Search both READMEs for stale `MetaWork`, schema v32, Pareto, and unsupported
  alias claims.
- Compare commands and paths with `setup.sh`, installation path helpers, the
  native launcher, CLI argument parsing, and `package.json`.
- Check Markdown links and `git diff --check`.
- Run `npm run lint` because README changes are shipped from the same release
  branch and must not mask an existing TypeScript regression.

## Delivered

- Replaced the MetaWork public brand with AnyFusion in both repository
  READMEs.
- Reframed the public architecture around ClientGateway,
  ConversationSession, AccountRuntime, PlanningAgent, ControlKernel, Runtime,
  and Executor boundaries.
- Updated installation, runtime layout, routing, concurrency, and persistence
  claims to match the active implementation.
- Removed unsupported source-install aliases and the obsolete Pareto-routing
  claim.

**Design commit:** `49bea8c`

**Closing commit:** `912bf62`
