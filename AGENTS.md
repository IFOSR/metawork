# Repository Guidelines

## Project Structure & Module Organization

MetaClaw is a Node 20 TypeScript CLI/TUI project. Source code lives in `src/`, with the entry point at `src/index.ts`.

Key areas are organized by responsibility:

- `src/core/` is intentionally narrow and contains shared primitives plus the shared `KernelFailure` fact.
- `src/planning/` owns the `PlanningAgent` interface (`CodexPlanningAgent`), the dedicated Codex planner runner, the read-only Planner MCP server, minimal planning context construction, plan types/vocabulary, and plan validation. Planning only proposes.
- `src/kernel/` owns the pure `ControlKernel`, which exposes a single `decide(event, snapshot)` seam. It is the sole authority for plan admission, dispatch, capacity, execution failure recovery, retry/fallback/replan, derived AgentClass availability, permission grant/deny/escalation, partition waiting, and sandbox recovery. It reads no clock, repository, adapter, or raw log, and performs no side effects.
- `src/work-graph/` owns the shared work graph types and pure structural validation consumed by Planning, Kernel, and Execution.
- `src/session/` is Application Shell: it coordinates interactive/script/gateway session intake, explicit memory fast paths, PlanningAgent/ControlKernel wiring, and persistence. It triggers the kernel workflow and projects output; it never interprets outcomes strategically.
- `src/task/` owns task state and runtime. Deterministic task search is exposed to the Planner through its read-only MCP.
- `src/memory/` owns explicit confirmed preferences, deterministic recent conversation context, and vault export.
- `src/execution/` owns side effects only: the durable kernel execution runtime, work graph materialization/recovery, work-unit claiming, subtask attempt running, per-attempt sandboxes, workspaces, aggregation, and progress.
- `src/executor/` owns executor adapters plus AgentClass admin/seeder services, prompts, and skill packages. Adapters normalize raw errors into structured `KernelFailure` facts; they do not decide recovery.
- `src/resource/` owns resource partition identity, claims, permission rules, and capability-request evaluation.
- `src/guidance/`, `src/learning/`, `src/intent/`, and `src/delivery/` own their named domains.
- `src/storage/` holds SQLite repositories and migrations for tasks, subtasks, agent classes, work units, the kernel decision ledger, durable inbox/application/outbox, resources, workspaces, planner run/tool-call audits, and events. Storage is an adapter and owns no policy.
- `src/gateway/`, `src/notifications/`, and `src/integrations/` handle gateway and delivery integrations.
- `src/commands/`, `src/tui/`, `src/cli/`, and `src/utils/` cover command routing, UI, CLI args, and shared utilities.

Tests mirror these domains under `tests/`. Design notes and roadmaps are in `docs/`, while runnable/manual scenarios and fixtures are in `examples/`. Current PlanningAgent/ControlKernel/work-unit vocabulary and migration context live in `CONTEXT.md`.

For deeper current architecture context, read `docs/current/technical-overview.md`. Use `docs/README.md` as the docs map before opening older dated planning documents. Before architecture or roadmap changes, read `docs/adr/README.md` and ADR-0020; do not treat `docs/archive/adr/` as current implementation authority.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run dev`: run `tsup --watch` for incremental builds.
- `npm run build`: bundle `src/index.ts` to `dist/index.js`.
- `npm run start`: run the built CLI from `dist/`.
- `npm test`: run the full Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run lint`: type-check with `tsc --noEmit`.
- `npm run smoke:metaclaw`: execute the real-task smoke script in `scripts/`.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM imports. Follow the existing style: two-space indentation, single quotes, semicolons, and kebab-case filenames such as `task-runtime-service.ts`. Prefer small, domain-named services and repositories over generic utility modules. Keep React/Ink UI code in `.tsx` files and non-UI logic in `.ts` files.

## Testing Guidelines

Vitest is the test framework, configured for Node with globals enabled. Name tests `*.test.ts` and place them under the matching `tests/<domain>/` folder, for example `tests/core/task-engine.test.ts`. Coverage is configured for `src/core/**` and `src/storage/**`; changes there should include focused regression tests. Run `npm test` and `npm run lint` before submitting.

**`better-sqlite3` is NOT available in the local (Windows) environment, so any test that touches storage/SQLite cannot run locally — all tests MUST be run in Docker.** Do not waste time retrying the suite on the host machine; use `docker build -f Dockerfile.test -t metaclaw-test . && docker run --rm metaclaw-test`. Note also that path-extraction tests (e.g. inline resource matching) assume POSIX paths and only pass under the Linux Docker environment, not on Windows. `npm run lint` (`tsc --noEmit`) is the only check that runs reliably on the host.

## Plan Documentation Guidelines

Material implementation plans must be written to `docs/plans/`; do not leave the only copy in a chat or handoff. At the beginning of each plan, record its current status and plan date. When the plan is completed, update that same opening section with the completion date, the behaviors or features actually delivered, validation performed, and the implementation or closing commit(s). Do not report a plan as complete until its plan document has been updated.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes, for example `feat: converge metaclaw session architecture` and `docs: clarify install verification flow`. Use concise imperative subjects with prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `refactor:`. Pull requests should describe the user-visible change, list validation commands run, link related plans/issues, and include screenshots or terminal output when TUI, CLI, or gateway behavior changes.

## Security & Configuration Tips

Do not commit local credentials, Feishu app secrets, generated databases, or `dist/` artifacts unless explicitly required. Keep environment-specific setup in ignored local files or documented shell steps, and update `README.md` or `docs/` when configuration expectations change.
