<p align="center">
  <a href="https://anyint.ai/"><img src="docs/assets/brand-anyint.svg" alt="AnyInt" height="96" align="middle" /></a>
  <img src="docs/assets/brand-times.svg" alt="x" height="96" align="middle" />
  <a href="https://www.metafusion.cc/"><img src="docs/assets/brand-metafusion.svg" alt="MetaFusion" height="96" align="middle" /></a>
</p>

<div align="center">

# MetaClaw

**A local AI Task OS for durable agentic work.**

Turn natural-language requests into tasks that can be planned, scheduled, resumed, verified, remembered, and delivered through local agent runtimes.

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

[Technical Overview](docs/current/technical-overview.md) | [Docs](docs/README.md) | [Architecture Decisions](docs/adr) | [Chinese](README.zh-CN.md)

</div>

## What is MetaClaw?

MetaClaw is an open-source local runtime for agentic work. It sits between people and agent CLIs such as Codex, Pi, Hermes, and other local executors, turning a chat-style request into a durable task with state, memory, planning, work-unit dispatch, verification, and delivery.

A normal assistant answers the current turn. MetaClaw gives longer-running work an operating system: tasks can be created, parked, resumed, searched, split into subtasks, assigned to executor work units, checked against evidence, and delivered back through terminal or Gateway surfaces.

MetaClaw is currently optimized for local-first teams and research workflows that need more than prompt copy-paste: repository edits, multi-step analysis, artifact generation, Feishu delivery, and repeatable task recovery.

## Why MetaClaw?

Agents are becoming capable workers, but most agent runs are still fragile sessions. When a terminal closes, context gets lost. When a task blocks, the system forgets why. When multiple executors exist, routing logic gets mixed into prompts. When output returns, there is often no durable evidence trail.

MetaClaw treats agent work as work:

- A request becomes either conversation, task control, or durable work.
- Durable work gets explicit task state and resume context.
- Planning is separated from authorization through `PlanningAgent` and `PolicyKernel`.
- Subtasks are persisted as a task-owned work graph.
- Runtime claims a healthy idle executor work unit or probes and creates one on demand; executors never receive raw user input directly.
- Results are verified, recorded, and delivered with artifacts.

## Features

- **Durable task state**: created, ready, running, parked, blocked, done, archived, and cancelled tasks survive interruptions.
- **Planner-owned semantics**: natural-language input flows through an isolated Codex `PlanningAgent`, then `PolicyKernel`, before any state change or executor call.
- **Tool-mediated context**: bounded read-only Planner MCP tools expose task, current-session, runtime, and executor facts only when the Planner needs them.
- **Work graphs and work units**: complex requests can become persisted subtasks with dependencies, acceptance criteria, executor candidates, and claimable runtime slots.
- **Local executor adapters**: Codex CLI is the default executor; Pi Agent, Hermes Agent, and custom CLI executors can be registered for specialized work.
- **Memory with boundaries**: confirmed preferences, task history, and context bundles are recalled only when clearly applicable.
- **Hybrid task retrieval**: historical tasks are searchable through SQLite FTS and semantic ranking signals.
- **Gateway delivery**: terminal, local Gateway, Feishu progress cards, artifact upload, and Markdown preview links share one session runtime.
- **Verification loop**: executor outputs can be checked for evidence, artifacts, test results, and missing acceptance criteria.
- **Real smoke gate**: `npm run smoke:metaclaw` runs an end-to-end task through the built CLI and verifies generated artifacts.

## Quick Install

MetaClaw targets Node.js 20+ and a Unix-like shell. On Windows, WSL2 with Ubuntu is the recommended runtime.

```bash
git clone https://github.com/IFOSR/metaclaw.git
cd metaclaw
./setup.sh
metaclaw --help
npm run smoke:metaclaw
```

`setup.sh` installs dependencies, builds the CLI, links `metaclaw`, creates a local config, and detects available executor commands on `PATH`.

Manual development setup:

```bash
npm install
npm run build
npm link
metaclaw --help
```

## Running interactively via Docker + SSH

On Windows, `docker exec -it` does not give the Ink TUI a real terminal, which
crashes it with `Raw mode is not supported`. The included SSH workflow runs the
container as an SSH server, giving you a genuine PTY for the TUI **and** a
general-purpose shell for browsing/editing `/workspace` output files. VS Code
Remote-SSH can also open `/workspace` as a full folder.

Prerequisites: Docker Desktop, and `docker/pi.env` with `OPENAI_API_KEY` **and**
`OPENAI_BASE_URL` set (copy `docker/pi.env.example`). `docker/pi.env` is the
single API config entry point — both `codex` (default planner + executor) and
`pi` (available as an executor candidate) read their key and base URL from it.
`entrypoint.sh` substitutes `OPENAI_BASE_URL` into the Codex and Pi templates
at container start. Planner and executor use separate `CODEX_HOME` directories;
only API credentials are shared. The image contains `dist/index.js`,
`dist/planner-mcp.js`, the generated PlanningAgentPlan v2 schema, the Planner
Skill, and both Codex configurations. Host `dist`, Codex/PI configuration, and
the entrypoint are not bind-mounted. After source changes, use `-Rebuild`;
only dedicated `/workspace` and `/data` volumes persist at runtime.

```powershell
.\docker\shell.ps1 -Start    # build image (if needed) + start the SSH container
.\docker\shell.ps1 -SetupSsh # one-time: set up passwordless key login
.\docker\shell.ps1           # SSH in and launch the TUI (default)
.\docker\shell.ps1 -Bash     # SSH in to a plain bash shell (browse files)
.\docker\shell.ps1 -Stop     # stop the container (keeps it for next time)
.\docker\shell.ps1 -Remove   # stop and remove the container
.\docker\shell.ps1 -Rebuild  # rebuild the image, then recreate the container
```

SSH details: host `localhost`, port `2222`, user `root`, password `metaclaw`
(local single-machine default). The host key is written to
`.tmp/ssh_known_hosts` so your global known_hosts is untouched.

**Passwordless login (optional, recommended):** run `.\docker\shell.ps1 -SetupSsh`
once. It generates a dedicated key under `.tmp/ssh_key` (gitignored), installs
the public key into the container, and writes an SSH client config defining the
host alias `metaclaw`. After that, `.\docker\shell.ps1` and `.\docker\shell.ps1
-Bash` connect with no password prompt. The public key is re-seeded on every
`-Start`, so it survives `-Rebuild`. You can also connect directly with
`ssh -F .tmp/ssh_key/config metaclaw`.

To open the workspace in VS Code: install the **Remote - SSH** extension. After
`-SetupSsh`, connect to host `metaclaw` and open `/workspace`. (Without
`-SetupSsh`, add a host `localhost:2222` user `root` and use the `metaclaw`
password.)

## Getting Started

Start MetaClaw in an interactive terminal:

```bash
metaclaw
```

Then give it work in natural language:

```text
Compare these three contracts and create a concise risk matrix.
```

MetaClaw decides whether the input should be a direct reply, task control action, clarification, or durable task. Durable work is planned, authorized, persisted, dispatched to an executor work unit, verified, and recorded with artifacts when produced.

Useful commands:

```bash
/tasks
/tasks active
/task <id>
/task <id> resume
/task <id> block waiting for source files
/task index search contract risk matrix
/dashboard
/memory
/config
/help
```

## Repository Structure

```text
.
|-- src/                 # TypeScript source for the CLI, TUI, runtime, planners, storage, and integrations
|-- tests/               # Vitest suites mirroring source domains
|-- docs/                # Current docs, ADRs, historical plans, and technical notes
|-- examples/            # Runnable/manual scenarios and fixtures
|-- scripts/             # Smoke tests, setup helpers, and operational scripts
|-- docker/              # Container and executor runtime support
|-- dist/                # Built CLI output generated by tsup
|-- CONTEXT.md           # Current migration vocabulary and architecture context
|-- AGENTS.md            # Repository instructions for coding agents
|-- setup.sh             # Main local install script
|-- metaclaw.sh          # Runtime helper script
`-- package.json         # Node package metadata and development commands
```

Source modules are organized by runtime responsibility:

| Path | Responsibility |
| --- | --- |
| `src/cli/` | CLI argument parsing such as `--script`, `--gateway`, and connection modes. |
| `src/tui/` | Ink terminal UI for interactive input, task status, and progress display. |
| `src/session/` | Main session coordinator for interactive, scripted, Gateway, memory, planning, policy, and persistence flows. |
| `src/planning/` | `PlanningAgent` interface (`CodexPlanningAgent`), context construction, plan schemas/vocabulary, and validation. |
| `src/kernel/` | Pure `PolicyKernel` authorization for planner decisions. |
| `src/task/` | Task state machine, scheduler, resume planning, ranking, and retrieval. |
| `src/execution/` | Execution runtime, work graph application, work-unit claiming, orchestration, aggregation, progress, and conversation runtime. |
| `src/executor/` | Executor adapters, agent-class registration, default seeding, prompts, and skill packages. |
| `src/memory/` | Memory capture, recall, review, preferences, context bundles, and vault export. |
| `src/storage/` | SQLite migrations and repositories for tasks, subtasks, work units, planning decisions, memory, and events. |
| `src/gateway/` | Local Gateway server/client and Feishu Gateway runtime. |
| `src/delivery/` | Verification, artifact extraction, aggregation checks, and delivery preparation. |
| `src/integrations/` | External integration helpers such as Markdown preview. |
| `src/commands/` | Slash command router and command handlers. |
| `src/core/` | Narrow shared primitives, the LLM bridge, capability classes, and strategy primitives. |

## Architecture

```mermaid
flowchart LR
  User[User] --> Surfaces[TUI / CLI / Gateway / Feishu]
  Surfaces --> Session[MetaclawSession]
  Session --> FastPath[Explicit memory and preference fast paths]
  Session --> Planner[PlanningAgent]
  Planner --> Plan[PlanningAgentPlan]
  Plan --> Kernel[PolicyKernel]
  Kernel --> Decision{KernelDecision}

  Decision -->|direct_reply| Conversation[ConversationRuntimeService]
  Decision -->|clarification| Clarify[Ask for missing input]
  Decision -->|task_control| Control[Task control runtime]
  Decision -->|plan_work_graph| Apply[KernelDecisionApplier]
  Decision -->|reject / no_action| Stop[Preserve state]

  Apply --> Task[TaskRuntimeService]
  Task --> Scheduler[SchedulerEngine]
  Scheduler --> Memory[MemoryContextService]
  Memory --> WorkGraph[WorkGraphRuntimeService]
  WorkGraph --> Subtasks[Persisted subtasks]
  Subtasks --> Claim[WorkUnitClaimService]
  Claim --> Spec[SubtaskExecutionSpec]
  Spec --> Executors[ExecutionRuntime: Codex / Pi / Hermes / custom CLI]
  Executors --> Verify[Verification and artifact capture]
  Verify --> Delivery[Terminal / Gateway / Feishu / preview links]

  Conversation --> Delivery
  Clarify --> Delivery
  Control --> Delivery
  Stop --> Delivery

  Session <--> Store[(Local SQLite)]
  Task <--> Store
  WorkGraph <--> Store
  Claim <--> Store
  Memory <--> Store
  Kernel -. audit .-> Store
```

The important boundary is that natural-language planning does not directly execute work. The isolated Codex `PlanningAgent` owns semantic interpretation and uses bounded read-only MCP tools when task/session/runtime facts are needed. `PolicyKernel` validates and authorizes the v2 proposal against state, conflicts, confidence, catalog membership, and confirmation requirements. Runtime then applies the decision and obtains live executor health only from `WorkUnit` claim/probe state.

The current production path deliberately keeps one active top-level task admitted at a time. Multiple subtasks can exist inside that task, and ready subtasks are claimed by executor work units as dependencies are satisfied. This keeps local execution predictable while the planner, policy, and work-unit lifecycle continue to harden.

## CLI and Development

| Command | Description |
| --- | --- |
| `npm run dev` | Build in watch mode with tsup. |
| `npm run build` | Bundle the CLI and Planner MCP, then generate the PlanningAgentPlan v2 JSON Schema. |
| `npm run start` | Run the built CLI from `dist/`. |
| `npm test` | Run the Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run lint` | Type-check with `tsc --noEmit`. |
| `npm run smoke:metaclaw` | Run the real end-to-end task smoke gate. |

For deeper implementation details, see the [Technical Overview](docs/current/technical-overview.md). For the documentation map, ADRs, and historical plans, start with [docs/README.md](docs/README.md).

## License

MIT
