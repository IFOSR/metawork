# Repository Guidelines

## Start Here

AnyFusion is the public product name. `MetaClaw`, `metaclaw`, and `Metaclaw*` remain
the internal/runtime names and the compatibility CLI alias. Do not rename internal
identifiers during unrelated work.

For a new task, read in this order:

1. This file for the repository map, authority boundaries, and validation rules.
2. [`CONTEXT.md`](CONTEXT.md) for the current domain vocabulary and contract
   versions.
3. [`docs/current/technical-overview.md`](docs/current/technical-overview.md) for
   the full runtime and deployment model.
4. [`docs/adr/README.md`](docs/adr/README.md), then only the ADRs relevant to the
   change. Read ADR-0020 before architecture or roadmap work.
5. [`docs/README.md`](docs/README.md) to locate active plans, operational notes,
   and historical records.

Current authority order is: code and tests, accepted ADRs, `CONTEXT.md`, current
technical docs, active plans, then archived material. Files under `docs/archive/`
explain history and are not implementation authority unless a current document
explicitly cites them.

## Current Architecture At A Glance

MetaClaw is a Node 20 TypeScript ESM CLI/TUI. `src/index.ts` is the composition
root. The active natural-language control path is:

```text
TUI / script / Gateway / Feishu
  -> MetaclawSession (Application Shell)
  -> PlanningAgent (semantic proposal, native Codex thread)
  -> durable KernelEvent
  -> DurableKernelWorkflow
  -> ControlKernel.decide(event, snapshot)
  -> idempotent Runtime application
  -> durable dispatch items
  -> AttemptSupervisor
  -> SubtaskAttemptRunner
  -> sandboxed Executor attempt
  -> receipt / Git candidate / publication
  -> normalized KernelEvent
```

The control contracts currently in force are:

- PlanningAgentPlan v6.
- Work Graph v5.
- Kernel event/snapshot/decision and ledger v5.
- Completion Protocol v2.
- Fresh-install-only SQLite schema v28. Earlier pre-release databases are
  rejected, not upgraded or dual-read.

The product admits one active top-level Task. Within it, the Kernel may authorize
up to four independent Subtask attempts in one deterministic batch. Do not
reintroduce a multi-Task scheduler, queue/preemption policy, parked auto-resume,
or a second semantic router; those are outside the current product boundary.

One live MetaClaw session binds to one native Codex Planner thread. The first turn
captures the Codex thread id and later turns resume it; MetaClaw does not replay
SQLite interaction history into Planner prompts. Stable Planner instructions,
Skill, and MCP registration use Codex-native configuration. Runtime facts,
confirmed preferences, task history, and diagnostics are queried through the
read-only Planner MCP.

The Ink TUI in `src/tui/app.tsx` is still a supported product surface. Keep its
input editor, command completion, task/guidance panels, progress projection, and
Planner/Executor activity indicators unless a separately approved migration
replaces them. A possible future Codex-native UI direction is not authorization
to delete the current TUI.

## Ownership And Dependency Boundaries

- `src/core/` is intentionally narrow: shared primitives and the normalized
  `KernelFailure` fact. It must not become a generic orchestration layer.
- `src/planning/` owns `PlanningAgent`, `CodexPlanningAgent`, the dedicated Codex
  runner, native thread resume, the read-only Planner MCP server, minimal context
  construction, plan vocabulary, schemas, and validation. Planning proposes; it
  never authorizes or applies runtime state.
- `src/kernel/` owns the pure `ControlKernel` and the durable workflow contract.
  `ControlKernel` exposes only `decide(event, snapshot)` and owns plan admission,
  dispatch, capacity, retry/fallback/replan, availability, cancellation,
  permission, partition, sandbox, and recovery policy. It reads no clock,
  repository, adapter, or raw log and performs no side effects.
- `src/work-graph/` owns shared Work Graph types and pure structural/frontier
  rules consumed by Planning, Kernel, and Execution.
- `src/session/` is the Application Shell. `MetaclawSession` coordinates
  interactive/script/gateway intake, explicit memory fast paths, Planning and
  Kernel wiring, persistence, output projection, and startup recovery. It may
  coordinate policy owners but must not invent strategic outcomes.
- `src/execution/` owns side effects after authorization: durable Kernel runtime
  application, Executor recovery refresh, graph materialization/recovery,
  WorkUnit claims, dispatch supervision, attempt execution, sandboxes, leases,
  workspaces, Git integration, aggregation, publication, and progress.
- `src/executor/` owns Executor adapters, canonical AgentClass definitions,
  admin/seeding, prompts, and Executor skill packages. Adapters normalize failures
  and provide structured `probe()` results; they do not choose recovery policy.
- `src/task/` owns Task state and runtime. Deterministic task search is exposed to
  Planning through read-only MCP, not used as a code-side semantic router.
- `src/resource/` owns normalized resource partitions, claims, permission
  profiles, capability requests, grants, and capability-use accounting.
- `src/memory/` owns explicit confirmed preferences, bounded deterministic
  session context, and vault export. Natural-language memory inference has been
  removed.
- `src/storage/` owns SQLite schema v28 and repositories for domain facts,
  workflow inbox/application/outbox, decision ledger, dispatch/publication,
  recovery checks, resources, workspaces, audits, and events. Storage is an
  adapter and owns no strategy.
- `src/gateway/` owns the local JSONL Gateway, client UI, Feishu configuration,
  policy, onboarding, and runtime bridge. `src/integrations/`,
  `src/notifications/`, and `src/delivery/` own external adapters and delivery
  preparation.
- `src/commands/` owns the single structured `CommandCatalog`; `src/tui/` owns
  the Ink UI; `src/cli/` owns CLI arguments. `src/guidance/`, `src/learning/`,
  and `src/intent/` retain their domain-specific deterministic helpers.

The intended dependency direction is:

```text
surfaces / Session / Runtime adapters
  -> Planning and Kernel public seams
  -> shared domain contracts

Kernel policy <- normalized facts
Kernel decisions -> Runtime side effects -> normalized facts
```

Do not let Kernel import Session, storage, Executor adapters, Docker, or UI code.
Do not let Runtime silently make retry, fallback, replan, cancellation, or
availability decisions. Do not let Planner mutate storage through MCP.

## Important Runtime Invariants

- Planner output is a proposal until a durable Kernel decision admits it.
- `kernel_decisions` is the immutable authorization ledger; UI output is only a
  projection and never the source of truth.
- Executor success produces an immutable receipt and Git candidate first.
  Subtask results, handoffs, artifacts, and `done` publish only after Git
  integration succeeds.
- A WorkUnit is a runtime instance, not a Subtask or AgentClass. Busy WorkUnits
  do not make an AgentClass unhealthy.
- AgentClass `error` is a recoverable observation; `disabled` is the
  administrative lock. Event-driven recovery probes inspect only enabled classes
  currently in `error` and may only perform `error -> healthy`. They do not poll
  healthy classes for new faults.
- Planning and Executor recovery refresh run concurrently, but Kernel admission
  waits for the refresh result. A relevant recovery may revise the proposal once
  in the same native Planner thread.
- Availability-blocked replans persist the exact deferred proposal. Recovery
  re-admits it through Kernel and moves the Task to `ready`; it does not call the
  model again or dispatch immediately.
- Task business state and live Planner/Executor activity are different facts.
  Activity indicators must be driven by the corresponding live state and must
  return to idle in `finally`/terminal paths.
- Every Executor attempt runs through `SandboxedExecutorAdapter` in a disposable
  Docker container. There is no host-process Executor fallback.

## Main Entry Points

- `src/index.ts`: CLI composition root; selects TUI, script, Gateway server/client,
  setup, doctor, and pairing modes.
- `src/tui/app.tsx`: current interactive Ink surface and Feishu runtime-bridge
  attachment.
- `src/session/metaclaw-session.ts`: main Application Shell and current wiring
  hotspot.
- `src/planning/codex-planning-agent.ts`,
  `src/planning/planner-codex-runner.ts`, and
  `src/planning/planner-mcp-server.ts`: Planner boundary.
- `src/kernel/control-kernel.ts` and `src/kernel/kernel-workflow.ts`: pure policy
  and durable serialization.
- `src/execution/kernel-execution-runtime.ts`,
  `src/execution/attempt-supervisor.ts`,
  `src/execution/subtask-attempt-runner.ts`, and
  `src/execution/workspace-publication-worker.ts`: authorized execution chain.
- `src/execution/executor-recovery-refresh-service.ts`: coalesced, event-driven
  recovery probes and audit.
- `src/gateway/server.ts`, `src/gateway/client-ui.tsx`, and
  `src/gateway/feishu-runtime.ts`: non-local-terminal surfaces.

Tests mirror source domains under `tests/`. Runnable/manual scenarios and fixtures
live in `examples/`. Docker and smoke orchestration live in `docker/` and
`scripts/`.

## Change Routing

When changing:

- natural-language meaning, plan shape, Planner tools, or thread continuity:
  start in `src/planning/`, then inspect Session integration and Planner tests;
- authorization or recovery policy: start in `src/kernel/`, add pure behavior
  tests, then update Runtime application;
- Docker, attempts, claims, workspaces, publication, or probes: start in
  `src/execution/` and `src/executor/`, preserving Kernel fact boundaries;
- task display or commands: inspect `src/commands/`, read services, Session
  projection, and TUI/Gateway consumers together;
- persistence: update the single current schema and matching repositories/tests;
  do not add compatibility migrations without an explicit product decision;
- architecture or roadmap: update the applicable accepted ADR, `CONTEXT.md`,
  current technical overview, and this guide when the onboarding map changes.

## Build, Test, And Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run `tsup --watch`.
- `npm run build`: bundle the CLIs and generate Planner schema/attempt extension
  artifacts.
- `npm run start`: run `dist/index.js`.
- `npm run lint`: type-check with `tsc --noEmit`.
- `npm test`: run Vitest once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run smoke:metaclaw`: default live two-turn native Codex Planner-session
  smoke. `npm run smoke:anyfusion` is the same script.
- `npm run smoke:metaclaw -- --scenario artifact`: explicit real
  Planner-to-Executor artifact gate.

## Testing Guidelines

Use Vitest with `*.test.ts` files under the matching `tests/<domain>/` folder.
Changes to `src/core/**`, `src/kernel/**`, `src/execution/**`, or
`src/storage/**` require focused behavior/regression tests at the owning seam.

`better-sqlite3` is not available in the local Windows environment. Tests touching
SQLite, and POSIX path-extraction tests, must run in Docker:

```text
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

Do not waste time repeatedly running the full suite on the Windows host.
`npm run lint` is the reliable host check. Run `npm run build` when source,
bundling, generated Planner schema, or runtime packaging changes. Live smoke
requires credentials, canonical attempt images, and the Docker topology described
in `docs/current/phase-5-runtime-security.md`.

## Coding And Documentation Style

Use strict TypeScript and ESM imports, two-space indentation, single quotes,
semicolons, and kebab-case filenames. Prefer domain-named deep modules with small
public interfaces over generic utility or orchestration layers. Keep Ink/React UI
in `.tsx` and non-UI logic in `.ts`.

Material implementation plans belong in `docs/plans/` and must record status and
plan date at the top. On completion, update the same file with completion date,
actual behavior delivered, validation, and closing commit. Move completed plans
to the archive only when the documentation map no longer treats them as active.

Use Conventional Commit subjects such as `feat:`, `fix:`, `docs:`, `test:`, and
`refactor:`. Do not commit credentials, Feishu secrets, generated databases, local
workspace state, or `dist/` artifacts unless explicitly required.
