# Repository Guidelines

## Project Structure & Module Organization

MetaClaw is a Node 20 TypeScript CLI/TUI project. Source code lives in `src/`, with the entry point at `src/index.ts`.

Key areas are organized by responsibility:

- `src/core/` is intentionally narrow and contains shared primitives, reusable semantic-intent helpers, strategy primitives, and legacy routing compatibility seams.
- `src/planning/` owns the `PlanningAgent` interface, planning context construction, plan validation, and the semantic adapter that reuses old intent logic behind the planner boundary.
- `src/kernel/` owns pure `PolicyKernel` authorization for `PlanningAgentPlan` decisions. It validates, rewrites, rejects, or clarifies, but does not write storage or call executors.
- `src/session/` coordinates interactive/script/gateway session intake, explicit memory fast paths, PlanningAgent/PolicyKernel wiring, kernel decision application, task admission for deterministic paths, and persistence.
- `src/planner/` contains planner skills and legacy planner-runtime compatibility reference. It should not be the storage-writing main dispatch authority.
- `src/task/` owns task state, runtime, scheduler, resume planning, ranking, and semantic retrieval.
- `src/memory/` owns memory capture, recall, review, preferences, context bundles, and vault export.
- `src/execution/` owns execution runtime, work graph application/recovery, work-unit claiming, orchestration, aggregation, progress, workspace, and conversation runtime.
- `src/executor/` owns executor adapters plus AgentClass admin/seeder services, prompts, and skill packages.
- `src/guidance/`, `src/learning/`, `src/intent/`, `src/delivery/`, and `src/routing/` own their named domains, with `src/routing/` now treated as a legacy policy reference layer rather than the main dispatch path.
- `src/storage/` holds SQLite repositories and migrations for tasks, subtasks, agent classes, work units, planning decisions, and events.
- `src/gateway/`, `src/notifications/`, and `src/integrations/` handle gateway and delivery integrations.
- `src/commands/`, `src/tui/`, `src/cli/`, and `src/utils/` cover command routing, UI, CLI args, and shared utilities.

Tests mirror these domains under `tests/`. Design notes and roadmaps are in `docs/`, while runnable/manual scenarios and fixtures are in `examples/`. Current PlanningAgent/PolicyKernel/work-unit vocabulary and migration context live in `CONTEXT.md`.

For deeper current architecture context, read `docs/current/technical-overview.md`. Use `docs/README.md` as the docs map before opening older dated planning documents.

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

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit prefixes, for example `feat: converge metaclaw session architecture` and `docs: clarify install verification flow`. Use concise imperative subjects with prefixes such as `feat:`, `fix:`, `docs:`, `test:`, or `refactor:`. Pull requests should describe the user-visible change, list validation commands run, link related plans/issues, and include screenshots or terminal output when TUI, CLI, or gateway behavior changes.

## Security & Configuration Tips

Do not commit local credentials, Feishu app secrets, generated databases, or `dist/` artifacts unless explicitly required. Keep environment-specific setup in ignored local files or documented shell steps, and update `README.md` or `docs/` when configuration expectations change.
