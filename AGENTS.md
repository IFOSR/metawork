# Repository Guidelines

## Start Here

MetaWork is the canonical product and repository identity. It is a proprietary
commercial system. AnyFusion is a separate open-source upstream/component
family; retain its name only for attributed components and compatibility
contracts. `MetaClaw`, `metaclaw`, and
`Metaclaw*` remain internal/runtime names and compatibility identifiers. Do not
rename those contracts during unrelated work.

Read only what the task needs, in this order:

1. [`CONTEXT.md`](CONTEXT.md) — current contracts, domain vocabulary, runtime
   invariants, and product boundaries.
2. [`docs/current/technical-overview.md`](docs/current/technical-overview.md) —
   full runtime, deployment, configuration, and repository overview.
3. [`docs/adr/README.md`](docs/adr/README.md) — accepted decisions and the
   authority matrix. Read [ADR-0020](docs/adr/0020-core-module-ownership-and-dependency-direction.md)
   before architecture or roadmap work.
4. [`docs/README.md`](docs/README.md) — current docs, plans, operational notes,
   and archives.

Authority order: code and tests, accepted ADRs, [`CONTEXT.md`](CONTEXT.md), current
technical docs, active plans, then archived material. [`docs/archive/`](docs/archive/) is
historical unless a current authority explicitly cites it.

Architecture shortcuts:

- Current convergence target: [ADR-0055](docs/adr/0055-no-kernel-target-architecture-and-contract-reset.md)
  supersedes the older Kernel control-axis target; use the
  [local continuation record](docs/plans/2026-11-08-metawork-convergence-continuation-record.md)
  to distinguish implemented behavior from pending production cutover. Keep this
  work local until the user's verification; do not commit or push.
- Planner: [ADR-0015](docs/adr/0015-planner-owned-semantics-and-tool-mediated-context.md),
  [Workspace execution mode ADR-0050](docs/adr/0050-planner-owned-workspace-execution-mode.md)
- AgentClass definitions/status: [ADR-0018](docs/adr/0018-supported-routing-contracts-and-unified-executor-definitions.md), [ADR-0017](docs/adr/0017-kernel-executor-status-projection.md)
- Work Graph/publication: [ADR-0021](docs/adr/0021-work-graph-v4-subtask-execution-contract.md), [ADR-0025](docs/adr/0025-single-task-concurrency-and-git-publication.md), [ADR-0026](docs/adr/0026-phase-6-single-task-reliability-closure.md)
- Control loop and recovery: [ADR-0022](docs/adr/0022-unified-kernel-control-plane-and-decision-ledger.md), [ADR-0023](docs/adr/0023-durable-kernel-workflow-recovery-and-availability.md), [ADR-0055 D6](docs/adr/0055-no-kernel-target-architecture-and-contract-reset.md)
- Execution backends/resources: [ADR-0024](docs/adr/0024-resource-partition-sandbox-and-runtime-elevation.md), [runtime security](docs/current/phase-5-runtime-security.md)
- Single-Task boundary: [ADR-0011](docs/adr/0011-single-active-task-admission-gate.md), [future roadmap](docs/plans/future-multi-task-scheduling-roadmap.md)
- Accounts, Conversations, and client Gateway: [ADR-0031](docs/adr/0031-account-runtime-and-unified-client-gateway.md), [approved design](docs/plans/2026-08-18-account-runtime-unified-gateway-design.md)
- Workspace-scoped Conversation organization: [ADR-0035](docs/adr/0035-workspace-scoped-conversation-organization.md), [approved design](docs/plans/2026-08-27-workspace-scoped-conversation-organization-design.md)

## Repository Map

MetaWork is a Node 22.19+ TypeScript ESM service and CLI/TUI. `src/index.ts` is
the composition root. Detailed ownership and dependency rules live in
[ADR-0020](docs/adr/0020-core-module-ownership-and-dependency-direction.md).

| Area | Start here |
| --- | --- |
| Planning (Manager transport) | [`src/planning/`](src/planning/), [`src/planning/manager-host/`](src/planning/manager-host/) |
| Control contracts, settlement, pure policy and graph rules | [`src/control/`](src/control/), [`src/execution/`](src/execution/), [`src/work-graph/`](src/work-graph/) |
| Application Shell | [`src/session/`](src/session/) |
| Workspace Catalog and Conversation directory | [`src/workspace/`](src/workspace/) |
| Attempts, recovery, execution backends, Git publication | [`src/execution/`](src/execution/), [`src/executor/`](src/executor/), [`src/resource/`](src/resource/) |
| Durable facts | [`src/storage/`](src/storage/) |
| Task and long-term memory | [`src/task/`](src/task/), [`src/memory/`](src/memory/) |
| CLI, commands, native TUI bridge, and retired Ink UI | [`src/cli/`](src/cli/), [`src/commands/`](src/commands/), [`src/tui-bridge/`](src/tui-bridge/), [`src/tui/`](./docs/archive/plans) |
| Gateway, Feishu, notifications, delivery | [`src/gateway/`](src/gateway/), [`src/integrations/`](src/integrations/), [`src/notifications/`](src/notifications/), [`src/delivery/`](src/delivery/) |
| Electron Desktop, shared Web platform adapter, signed payload tooling | [`apps/desktop/`](apps/desktop/), [`web/src/platform/`](web/src/platform/), [ADR-0045](docs/adr/0045-desktop-thin-shell-and-local-session.md) |
| Official account authorization and hosted AI | [`src/authorization/`](src/authorization/), [`official-server/`](official-server/), [ADR-0047](docs/adr/0047-account-license-and-official-ai.md), [operations](docs/current/official-account-operations.md) |
| Supporting domains | [`src/guidance/`](src/guidance/), [`src/learning/`](./docs/archive/plans), [`src/intent/`](src/intent/), [`src/core/`](src/core/) |

Main entry points:

- [`src/index.ts`](src/index.ts) — composition and mode selection.
- [`src/session/metaclaw-session.ts`](src/session/metaclaw-session.ts) — Application Shell.
- [`src/planning/anyfusion-planning-agent.ts`](src/planning/anyfusion-planning-agent.ts) and
  [`src/planning/planner-process-runner.ts`](src/planning/planner-process-runner.ts) — Planner boundary.
- [`src/control/control-contracts.ts`](src/control/control-contracts.ts) and
  [`src/control/control-workflow.ts`](src/control/control-workflow.ts) — control
  event/decision/snapshot contracts and the in-process control seam.
- [`src/execution/control-execution-runtime.ts`](src/execution/control-execution-runtime.ts) and
  [`src/execution/subtask-attempt-runner.ts`](src/execution/subtask-attempt-runner.ts) — execution chain.
- [`src/tui-bridge/planner-tui-bridge.ts`](src/tui-bridge/planner-tui-bridge.ts) and
  [`src/tui-bridge/planner-tui-process.ts`](src/tui-bridge/planner-tui-process.ts) — default native Planner TUI adapter.
- [`src/tui/app.tsx`](src/tui/app.tsx) — retired Ink UI kept only until the single-TUI cutover cleanup; it is not reachable from `metawork tui`.
- [`src/gateway/server.ts`](src/gateway/server.ts) and
  [`src/gateway/feishu-runtime.ts`](src/gateway/feishu-runtime.ts) — remote surfaces.

Tests mirror source domains under [`tests/`](tests/). Scenarios and fixtures are in
[`examples/`](examples/); native smoke orchestration is in [`scripts/`](scripts/).
Local Docker runtime/test assets are retired (ADR-0055 D12); official-server
deployment assets have a separate owner.

## Working Rules

- Preserve ADR-0020's ownership and dependency direction. Detailed runtime rules
  belong in `CONTEXT.md`, not this file.
- Planning runs the packaged upstream Pi (`pi`, version pinned at build time) as the Manager,
  through `src/planning/manager-host/`. The vendored `planner/AnyFusion-Pi` fork is removed
  (ADR-0055 D6); do not reintroduce it. The Manager only produces a proposal: MetaWork validates
  it, and only MetaWork may mutate storage, schedule work, authorize execution or control an
  Executor.
- The Ink TUI under `src/tui/` and the vendored standalone agent TUI
  (`InteractiveMode`) are deleted. ADR-0055 D11 supersedes
  the earlier single-TUI target: this round uses Web, and bare `metawork` opens
  Web against an explicitly started Server. Remaining bridge/API cleanup is
  tracked in the review report; do not reintroduce a TUI or `METACLAW_STANDBY_TUI`.
- Do not add a second semantic router, Runtime-owned recovery policy, Planner
  storage mutation, or pre-release compatibility path without an ADR.
- Persistence changes must follow `CONTEXT.md` and update repositories and focused
  native persistence/recovery tests together.
- Architecture changes must update the applicable ADR, `CONTEXT.md`, current
  technical overview, and this guide only when onboarding/navigation changes.

## Build And Validation

- `npm install`, `npm run dev`, `npm run build`, `npm run start`
- `npm run lint`, `npm test`, `npm run test:watch`
- `npm run smoke:metawork` — native Manager-session smoke. It requires an
  explicitly prepared packaged Pi executable (`METAWORK_PI_COMMAND`, or
  `desktop-tools/executor/bin/pi`) and dedicated provider/model fixtures under
  `METAWORK_CONFIG_HOME`. It does not read an active account revision automatically.
  See [runtime security](docs/current/phase-5-runtime-security.md) for fixture paths
  and acceptance limits. Docker/container mode is rejected.
- `npm run smoke:metawork -- --scenario artifact` — Manager-to-Executor artifact
  smoke with the same explicit fixture requirements.

The acceptance scope is macOS arm64 + Web (ADR-0055 D14). Linux, Desktop and
Feishu acceptance are deferred. Windows code is retained but unmaintained
(ADR-0055 D13); there is no maintained Docker test fallback. Core policy,
execution or storage changes require focused tests at the owning seam, plus
lint/build and the maintained-host suite.

Manager and Executor use the same upstream Pi pinned on the packaging host,
with version and integrity recorded in the release manifest. Their dependency
tree, process, home and sessions are isolated from personal installations.
The native integration fixture covers Manager RPC/permission and an Executor
process against a local model endpoint. It does not replace complete task or
signed clean-machine acceptance. Never rebuild the removed fork, use a
host-global Pi as a runtime fallback, or run Manager code inside the MetaWork
process.

## Code, Plans, And Commits

Use strict TypeScript and ESM imports, two-space indentation, single quotes,
semicolons, and kebab-case filenames. Keep Ink/React in `.tsx` and non-UI logic
in `.ts`.

Material plans belong in `docs/plans/`; record status and plan date, then add the
completion date, delivered behavior, validation, and closing commit before
reporting completion. See [`docs/README.md`](docs/README.md).

Use Conventional Commit subjects (`feat:`, `fix:`, `docs:`, `test:`,
`refactor:`). Do not commit credentials, Feishu secrets, generated databases,
local workspace state, or `dist/` unless explicitly required.
