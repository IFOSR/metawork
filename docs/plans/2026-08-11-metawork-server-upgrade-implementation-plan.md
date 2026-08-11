# MetaWork Server Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the approved native MetaWork Server upgrade with one installation root, one revisioned configuration authority, explicit Planner/Kernel/Runtime projections, isolated AgentClass runtimes, controlled AnyFusion-Pi lifecycle, and extensible local/A2A Executor transports.

**Architecture:** Add a Configuration Control Plane at the Application Shell boundary while preserving `Planner proposes -> Kernel decides -> Runtime applies -> Executor executes`. Cut consumers over in dependency order: configuration types and revisions, Planner projection, Kernel authorization, Runtime binding, then installers and management surfaces. Do not keep long-lived dual-read or dual-write compatibility paths.

**Tech Stack:** Node.js 22.19+, TypeScript ESM, Zod, js-yaml, better-sqlite3, Vitest, Unix sockets/JSONL, Git worktrees, native Codex/Pi CLIs, AnyFusion-Pi companion repository.

---

## Execution Rules

- Create a dedicated worktree before implementation:

```bash
git worktree add ../metawork-server-upgrade -b feat/server-upgrade main
cd ../metawork-server-upgrade
```

- Read `CONTEXT.md`, ADR-0020, and the approved design before each phase:

```bash
sed -n '1,260p' CONTEXT.md
sed -n '1,260p' docs/adr/0020-core-module-ownership-and-dependency-direction.md
sed -n '1,260p' docs/plans/2026-08-07-metawork-server-upgrade-technical-design.md
```

- Use TDD. Each production change starts with a focused failing test.
- Run `npm run lint` after every task and the focused Vitest command listed below.
- Do not modify `~/.codex`, `~/.pi`, global Codex/Pi binaries, or user projects during tests.
- Keep `src/tui/` and its tests intact. Do not include standby Ink TUI retirement.
- Commit each task independently with the listed Conventional Commit subject.

### Task 1: Freeze Configuration And Routing Ownership

**Files:**
- Create: `docs/adr/0027-configuration-control-plane-and-revision-authority.md`
- Create: `docs/adr/0028-agentclass-model-and-harness-routing-contract.md`
- Create: `docs/adr/0029-executor-transport-and-a2a-boundary.md`
- Modify: `docs/adr/README.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Create: `tests/configuration/configuration-module-boundary.test.ts`

**Step 1: Write the failing architecture test**

Create a source-boundary test that scans production imports and fails when:

```ts
expect(configurationImportsKernel).toBe(false);
expect(configurationImportsRuntime).toBe(false);
expect(planningImportsRuntimePrivateBinding).toBe(false);
expect(kernelImportsConcreteConfigurationRepository).toBe(false);
expect(gatewayImportsStorageAdapter).toBe(false);
```

The test must allow:

```text
Application Shell -> Configuration Service
Planning -> Planner Configuration View
Kernel -> Kernel Configuration View
Runtime -> Runtime-private Binding
```

**Step 2: Run the test and verify it fails**

Run:

```bash
npx vitest run tests/configuration/configuration-module-boundary.test.ts
```

Expected: FAIL because `src/configuration/` and the declared public entry points do not exist.

**Step 3: Write the ADRs**

ADR-0027 must establish:

```text
~/.anyfusion/config/config.yaml
  -> ConfigurationService
  -> immutable ConfigurationSnapshot
  -> Planner/Kernel/Runtime projections
```

ADR-0028 must define:

```ts
type ModelPolicy =
  | { mode: 'fixed'; modelRef: string }
  | {
      mode: 'auto';
      allowedModelRefs: string[];
      defaultModelRef?: string;
      fallback?: { enabled: boolean; order: string[] };
    };
```

ADR-0029 must state that A2A is an `ExecutorAdapter`, not a scheduler, router, or Planner-to-Executor shortcut.

**Step 4: Add the initial module entry point**

Create `src/configuration/index.ts` exporting only placeholder type-only ports. Do not add storage or runtime imports.

**Step 5: Run validation**

Run:

```bash
npx vitest run tests/configuration/configuration-module-boundary.test.ts
npm run lint
```

Expected: PASS.

**Step 6: Commit**

```bash
git add docs/adr docs/current CONTEXT.md src/configuration tests/configuration
git commit -m "docs: define configuration and routing authority"
```

### Task 2: Introduce The Unified Installation Path Model

**Files:**
- Create: `src/installation/paths.ts`
- Create: `src/installation/release-manifest.ts`
- Create: `tests/installation/paths.test.ts`
- Create: `tests/installation/release-manifest.test.ts`
- Modify: `src/utils/paths.ts`
- Modify: `tsup.config.ts`

**Step 1: Write failing path tests**

Cover the default layout:

```ts
expect(resolveAnyFusionPaths('/Users/test')).toMatchObject({
  root: '/Users/test/.anyfusion',
  appCurrent: '/Users/test/.anyfusion/app/current',
  configFile: '/Users/test/.anyfusion/config/config.yaml',
  database: '/Users/test/.anyfusion/data/metaclaw.db',
  plannerSessions: '/Users/test/.anyfusion/data/planner-sessions',
  executionWorkspaces: '/Users/test/.anyfusion/data/execution-workspaces',
  generatedAgentRuntime: '/Users/test/.anyfusion/generated/agent-runtime',
  attempts: '/Users/test/.anyfusion/tmp/attempts',
});
```

Also assert:

```ts
expect(resolveReleasePaths(root, '2.0.0').plannerRoot)
  .toBe(`${root}/app/releases/2.0.0/planner`);
expect(resolveReleasePaths(root, '2.0.0')).not.toHaveProperty('serverRoot');
```

**Step 2: Run tests and verify failure**

```bash
npx vitest run tests/installation/paths.test.ts tests/installation/release-manifest.test.ts
```

Expected: FAIL with missing modules.

**Step 3: Implement path value objects**

Implement:

```ts
export interface AnyFusionPaths {
  root: string;
  appCurrent: string;
  releases: string;
  configFile: string;
  secrets: string;
  database: string;
  configurationRevisions: string;
  plannerSessions: string;
  executionWorkspaces: string;
  generatedAgentRuntime: string;
  attempts: string;
  logs: string;
  cache: string;
}
```

Support only `ANYFUSION_INSTALL_ROOT` as the root override. Do not fall back to `~/.local/share/anyfusion`.

**Step 4: Implement strict release manifest parsing**

Use Zod for:

```ts
{
  releaseId,
  metaworkRevision,
  plannerRevision,
  configurationSchema,
  plannerHostProtocol,
  planningPlanSchema,
  workGraphSchema,
  kernelDecisionSchema,
  databaseSchema,
  checksums,
}
```

Reject missing revision pins and incompatible protocol versions before activation.

**Step 5: Route legacy path helper through the new value object**

Change `resolveMetaclawDir()` to return `paths.data` during the migration window. Do not retain a second independently configurable state root.

**Step 6: Run validation**

```bash
npx vitest run tests/installation/paths.test.ts tests/installation/release-manifest.test.ts tests/utils/paths.test.ts
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/installation src/utils/paths.ts tsup.config.ts tests/installation tests/utils/paths.test.ts
git commit -m "feat: define unified AnyFusion installation paths"
```

### Task 3: Add Configuration Schema V2 And Safe Projections

**Files:**
- Create: `src/configuration/types.ts`
- Create: `src/configuration/schema.ts`
- Create: `src/configuration/projections.ts`
- Create: `src/routing/types.ts`
- Create: `src/routing/configuration-catalog.ts`
- Modify: `src/configuration/index.ts`
- Create: `tests/configuration/schema.test.ts`
- Create: `tests/configuration/projections.test.ts`
- Create: `tests/routing/configuration-catalog.test.ts`

**Step 1: Write failing schema tests**

Use one complete fixture containing:

```yaml
schemaVersion: 2
providers: {}
models: {}
harnesses: {}
agentClasses: {}
permissionProfiles: {}
runtimePolicy: {}
gateway: {}
```

Test:

- unknown fields fail;
- duplicate references fail;
- disabled model references fail activation;
- Planner AgentClass must reference a Planner Harness;
- Executor AgentClass must reference an Executor Harness;
- `fixed` requires `modelRef`;
- `auto` requires non-empty `allowedModelRefs`;
- A2A Harness requires endpoint and auth reference;
- local CLI Harness requires command and driver ID.

**Step 2: Run tests and verify failure**

```bash
npx vitest run tests/configuration/schema.test.ts tests/configuration/projections.test.ts tests/routing/configuration-catalog.test.ts
```

Expected: FAIL with missing modules.

**Step 3: Implement the strict Zod schema**

Define:

```ts
export type ConfigurationSnapshot = {
  revisionId: string;
  contentHash: string;
  config: AnyFusionConfigurationV2;
};
```

Keep Provider, ModelProfile, HarnessDefinition, AgentClassDefinition, PermissionProfile, RuntimePolicy, and GatewayConfig as separate referenced objects.

**Step 4: Implement projections**

Expose:

```ts
buildPlannerConfigurationView(snapshot)
buildKernelConfigurationView(snapshot)
buildRuntimeConfigurationView(snapshot)
```

Add tests proving Planner and Kernel projections contain no:

```text
apiKeyRef
command
host path
auth token
raw endpoint credential
```

**Step 5: Implement Routing Catalog projection**

Move Planner-safe routing vocabulary into `src/routing/`. Keep pure capability validation there. Do not import concrete file repositories.

**Step 6: Run validation**

```bash
npx vitest run tests/configuration tests/routing/configuration-catalog.test.ts
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/configuration src/routing tests/configuration tests/routing
git commit -m "feat: add configuration schema and safe projections"
```

### Task 4: Implement Revisioned Configuration Service

**Files:**
- Create: `src/configuration/configuration-service.ts`
- Create: `src/configuration/file-configuration-repository.ts`
- Create: `src/configuration/configuration-validator.ts`
- Create: `src/configuration/configuration-diff.ts`
- Create: `src/configuration/secret-store.ts`
- Modify: `src/configuration/index.ts`
- Modify: `src/storage/migrations.ts`
- Create: `src/storage/configuration-revision-repo.ts`
- Create: `tests/configuration/configuration-service.test.ts`
- Create: `tests/configuration/file-configuration-repository.test.ts`
- Create: `tests/configuration/secret-store.test.ts`
- Create: `tests/storage/configuration-revision-repo.test.ts`
- Modify: `tests/storage/migrations.test.ts`

**Step 1: Write failing service tests**

Test the exact lifecycle:

```text
createDraft
  -> validateDraft
  -> compileDraft
  -> probeDraft
  -> activateDraft
```

Assert:

- activation uses optimistic concurrency;
- activation writes a new immutable revision;
- failed validation leaves active unchanged;
- stale expected revision returns `revision_conflict`;
- rollback creates a new revision pointing to prior content;
- diff is redacted;
- atomic replacement never exposes a partial YAML file.

**Step 2: Run tests and verify failure**

```bash
npx vitest run tests/configuration/configuration-service.test.ts tests/configuration/file-configuration-repository.test.ts tests/configuration/secret-store.test.ts
```

Expected: FAIL.

**Step 3: Add SQLite revision audit**

Bump the SQLite schema once for this program:

```sql
CREATE TABLE configuration_revisions (
  revision_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  previous_revision_id TEXT,
  source TEXT NOT NULL,
  change_summary_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

SQLite records audit metadata only. The active static configuration remains the YAML source of truth.

**Step 4: Implement the file repository**

Use:

```text
config.yaml.tmp
  -> fsync
  -> rename config.yaml
```

Store immutable redacted revision copies under `data/configuration-revisions/`. Never write Secret values there.

**Step 5: Implement SecretStore**

Create a port with:

```ts
get(reference: SecretReference): Promise<string>;
put(reference: SecretReference, value: string): Promise<void>;
delete(reference: SecretReference): Promise<void>;
```

Implement a mode-`0700` directory and mode-`0600` file fallback. Keep OS credential-manager adapters behind the same port for a later platform-specific task.

**Step 6: Run validation**

```bash
npx vitest run tests/configuration tests/storage/configuration-revision-repo.test.ts tests/storage/migrations.test.ts
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/configuration src/storage tests/configuration tests/storage
git commit -m "feat: add revisioned configuration service"
```

### Task 5: Compile Generated Agent Runtimes

**Files:**
- Create: `src/configuration/configuration-compiler.ts`
- Create: `src/executor/runtime-home-materializer.ts`
- Create: `src/executor/harness-driver.ts`
- Create: `src/executor/codex-cli-driver.ts`
- Create: `src/executor/pi-cli-driver.ts`
- Create: `tests/configuration/configuration-compiler.test.ts`
- Create: `tests/executor/runtime-home-materializer.test.ts`
- Create: `tests/executor/codex-cli-driver.test.ts`
- Create: `tests/executor/pi-cli-driver.test.ts`

**Step 1: Write failing compiler tests**

Assert:

```text
generated/agent-runtime/planner/planner-default
generated/agent-runtime/executors/codex-engineering
generated/agent-runtime/executors/codex-review
generated/agent-runtime/executors/pi-research
```

Test that two AgentClasses using `codex-cli` receive different generated directories and different model/permission files.

**Step 2: Write failing attempt Home tests**

For attempt `attempt-123`, assert:

```text
tmp/attempts/attempt-123/home
tmp/attempts/attempt-123/environment.json
tmp/attempts/attempt-123/receipt.json
tmp/attempts/attempt-123/logs
```

Assert `environment.json` is redacted and generated from the exact configuration revision.

**Step 3: Run tests and verify failure**

```bash
npx vitest run tests/configuration/configuration-compiler.test.ts tests/executor/runtime-home-materializer.test.ts tests/executor/codex-cli-driver.test.ts tests/executor/pi-cli-driver.test.ts
```

Expected: FAIL.

**Step 4: Implement HarnessDriver**

Use:

```ts
interface HarnessDriver {
  readonly id: string;
  probe(binding: RuntimeBinding): Promise<ExecutorProbeResult>;
  materializeHome(input: RuntimeHomeInput): Promise<MaterializedRuntimeHome>;
  buildLaunch(input: HarnessLaunchInput): HarnessLaunchSpec;
  parseResult(input: HarnessResultInput): ExecutorResult;
}
```

Codex sets only the generated `CODEX_HOME`. Pi sets independent `HOME`, `PI_CODING_AGENT_DIR`, and `PI_CODING_AGENT_SESSION_DIR`.

**Step 5: Add hard isolation assertions**

Tests must fail if generated launch environments contain:

```text
~/.codex
~/.pi
process.env.CODEX_HOME fallback
process.env.HOME fallback for Pi
```

**Step 6: Run validation**

```bash
npx vitest run tests/configuration/configuration-compiler.test.ts tests/executor/runtime-home-materializer.test.ts tests/executor/codex-cli-driver.test.ts tests/executor/pi-cli-driver.test.ts
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/configuration src/executor tests/configuration tests/executor
git commit -m "feat: compile isolated agent runtimes"
```

### Task 6: Migrate Legacy Configuration Once

**Files:**
- Create: `src/configuration/legacy-configuration-reader.ts`
- Create: `src/configuration/configuration-migration-service.ts`
- Create: `tests/configuration/configuration-migration-service.test.ts`
- Modify: `src/utils/config.ts`
- Modify: `tests/utils/config.test.ts`
- Modify: `src/executor/agent-class-seeder.ts`
- Modify: `tests/executor/agent-class-service.test.ts`

**Step 1: Write failing migration tests**

Build fixtures for:

```text
legacy config.yaml
provider.env
Planner models.json/settings.json
Codex config.toml
Pi models.json/settings.json
SQLite canonical AgentClasses
```

Assert they produce one schema-v2 candidate and a redacted report.

**Step 2: Test ambiguous inputs fail closed**

Examples:

- two different Provider URLs for the same profile;
- unknown custom Executor command;
- AgentClass model not present in any ModelProfile;
- dirty or unreadable Planner configuration.

Expected error shape:

```ts
{ path, code, message, severity: 'error', suggestedFix }
```

**Step 3: Run tests and verify failure**

```bash
npx vitest run tests/configuration/configuration-migration-service.test.ts tests/utils/config.test.ts
```

Expected: FAIL.

**Step 4: Implement one-way migration**

The migration command must:

```text
read legacy
  -> build candidate
  -> validate
  -> show redacted diff
  -> require confirmation
  -> activate revision
```

After activation, runtime code reads only ConfigurationService. Do not keep fallback reads from `provider.env`, Harness settings files, or SQLite AgentClass static fields.

**Step 5: Stop seeding static AgentClass authority**

Keep only dynamic WorkUnit initialization. If the current `work_units` foreign key requires legacy AgentClass rows, remove that foreign key in the same database migration rather than maintaining a shadow static catalog.

**Step 6: Run validation**

```bash
npx vitest run tests/configuration/configuration-migration-service.test.ts tests/utils/config.test.ts tests/executor/agent-class-service.test.ts tests/storage/migrations.test.ts
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/configuration src/utils/config.ts src/executor/agent-class-seeder.ts src/storage tests
git commit -m "feat: migrate legacy configuration to schema v2"
```

### Task 7: Unify Planner Process Lifecycle And Host Bridge

**Files:**
- Create: `src/planning/planner-process-supervisor.ts`
- Move: `src/tui-bridge/planner-tui-bridge.ts` to `src/tui-bridge/planner-host-bridge.ts`
- Modify: `src/tui-bridge/planner-host-protocol.ts`
- Delete: `src/planning/planner-process-runner.ts`
- Delete: `src/tui-bridge/planner-tui-process.ts`
- Modify: `src/planning/anyfusion-planning-agent.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/index.ts`
- Create: `tests/planning/planner-process-supervisor.test.ts`
- Move: `tests/tui-bridge/planner-tui-bridge.test.ts` to `tests/tui-bridge/planner-host-bridge.test.ts`
- Delete: `tests/planner-process-runner.test.ts`
- Delete: `tests/tui-bridge/planner-tui-process.test.ts`

**Step 1: Write failing supervisor tests**

Test:

```ts
await supervisor.startInteractive({ sessionId, cwd });
await supervisor.runRpcTurn({ sessionId, cwd, prompt, context, purpose });
await supervisor.probe();
await supervisor.stop();
```

Both launch modes must use the same:

```text
release planner command
Planner Home
session directory
schema path
Provider/model binding
current user cwd
Host Bridge socket
```

**Step 2: Run tests and verify failure**

```bash
npx vitest run tests/planning/planner-process-supervisor.test.ts tests/tui-bridge/planner-host-bridge.test.ts
```

Expected: FAIL.

**Step 3: Implement the supervisor**

Interactive mode inherits terminal stdio. RPC mode uses JSONL stdin/stdout and one short-lived child per turn. Preserve same-session serialization.

**Step 4: Rename the Bridge**

Keep the Host Protocol unchanged unless ADR-0028 requires a version bump. The Bridge stays in the MetaWork Server process and exposes no generic mutation API.

**Step 5: Update the AnyFusion-Pi companion**

Files in the AnyFusion-Pi repository:

- Modify: `packages/coding-agent/src/anyfusion/planner-bootstrap.ts`
- Modify: `packages/coding-agent/src/anyfusion/planner-host-client.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-bootstrap.test.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-host-client.test.ts`

Only update protocol names/configuration inputs required by the host change. Do not move Kernel or Runtime logic into Pi.

**Step 6: Run validation in both repositories**

MetaWork:

```bash
npx vitest run tests/planning/planner-process-supervisor.test.ts tests/tui-bridge
npm run lint
```

AnyFusion-Pi:

```bash
npm run check
npm test --workspace @earendil-works/pi-coding-agent -- anyfusion-planner
```

Expected: PASS.

**Step 7: Commit both repositories**

MetaWork:

```bash
git add src/planning src/tui-bridge src/session src/index.ts tests
git commit -m "refactor: unify planner process lifecycle"
```

AnyFusion-Pi:

```bash
git add packages/coding-agent/src/anyfusion packages/coding-agent/test
git commit -m "refactor: align planner host lifecycle"
```

Record the AnyFusion-Pi commit in the release manifest fixture.

### Task 8: Upgrade PlanningAgentPlan V8 And Work Graph V7

**Files:**
- Modify: `src/planning/planning-agent-plan-schema.ts`
- Modify: `src/planning/planning-types.ts`
- Modify: `src/planning/planning-agent-plan-validator.ts`
- Modify: `src/planning/planning-context-builder.ts`
- Modify: `src/work-graph/types.ts`
- Modify: `src/work-graph/validation.ts`
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/generate-planner-schema.ts`
- Modify: `package.json`
- Modify: `tests/planning/planning-agent-plan-schema.test.ts`
- Modify: `tests/planning/planning-agent-plan-validator.test.ts`
- Modify: `tests/planning/planning-context-builder.test.ts`
- Modify: `tests/planning/work-graph-structure-rules.test.ts`
- Modify: `tests/kernel/control-kernel.test.ts`

**Step 1: Write failing v8 tests**

Replace `preferredAgentClassList` with:

```ts
executorBindings: Array<{
  agentClassRef: string;
  modelSelection:
    | { mode: 'fixed-by-agent-class' }
    | { mode: 'proposed'; modelRef: string; reason: string }
    | { mode: 'agent-class-default' };
}>;
```

Test that the Zod schema is built from Planner Configuration View values instead of hard-coded `codex-cli` and `pi-agent` enums.

**Step 2: Verify failure**

```bash
npx vitest run tests/planning/planning-agent-plan-schema.test.ts tests/planning/planning-agent-plan-validator.test.ts tests/planning/work-graph-structure-rules.test.ts
```

Expected: FAIL.

**Step 3: Implement versioned contracts**

Set:

```text
PlanningAgentPlan schemaVersion = 8
Work Graph schemaVersion = 7
generated file = dist/planning-agent-plan-v8.schema.json
```

Do not accept v7 after the cutover migration.

**Step 4: Update AnyFusion-Pi Planner instructions**

Files:

- Modify: `packages/coding-agent/src/metaclaw-planner/SKILL.md`
- Modify: `packages/coding-agent/src/anyfusion/planner-system-prompt.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-system-prompt.test.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-proposal-types.test.ts`

Remove canonical Executor names from prose. Require the Planner to use the supplied catalog and model policy.

**Step 5: Run validation**

MetaWork:

```bash
npx vitest run tests/planning tests/kernel/control-kernel.test.ts
npm run build
npm run lint
```

AnyFusion-Pi:

```bash
npm run check
npm test --workspace @earendil-works/pi-coding-agent -- anyfusion-planner
```

Expected: PASS and `dist/planning-agent-plan-v8.schema.json` generated.

**Step 6: Commit**

MetaWork:

```bash
git add src/planning src/work-graph src/kernel package.json tests
git commit -m "feat: authorize AgentClass and model proposals"
```

AnyFusion-Pi:

```bash
git add packages/coding-agent/src/metaclaw-planner packages/coding-agent/src/anyfusion packages/coding-agent/test
git commit -m "feat: emit Planner v8 executor bindings"
```

### Task 9: Persist One Configuration Revision Through Kernel And Attempts

**Files:**
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/kernel/kernel-workflow.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/execution/subtask-attempt-runner.ts`
- Modify: `src/executor/adapter.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/planner-run-repo.ts`
- Modify: `src/storage/kernel-decision-repo.ts`
- Modify: `src/storage/executor-attempt-receipt-repo.ts`
- Modify: `tests/kernel/control-kernel.test.ts`
- Modify: `tests/kernel/kernel-workflow.test.ts`
- Modify: `tests/execution/subtask-attempt-runner.test.ts`
- Modify: `tests/storage/planner-run-repo.test.ts`
- Modify: `tests/storage/kernel-decision-repo.test.ts`
- Create: `tests/storage/executor-attempt-receipt-revision.test.ts`

**Step 1: Write failing revision tests**

Assert:

```ts
plannerRun.configurationRevision
  === kernelDecision.configurationRevision
  === attemptReceipt.configurationRevision;
```

Test that Runtime rejects an `AuthorizedExecutorBinding` whose revision differs from the Decision revision.

**Step 2: Verify failure**

```bash
npx vitest run tests/kernel/control-kernel.test.ts tests/kernel/kernel-workflow.test.ts tests/execution/subtask-attempt-runner.test.ts tests/storage
```

Expected: FAIL.

**Step 3: Add the authorized binding**

Use:

```ts
interface AuthorizedExecutorBinding {
  agentClassRef: string;
  harnessRef: string;
  modelRef: string;
  permissionProfileRef: string;
  configurationRevision: string;
}
```

Kernel validates this tuple against `KernelConfigurationView`. Runtime receives only the authorized binding.

**Step 4: Add persistence fields**

Add explicit audit columns:

```text
planner_runs.configuration_revision
planner_runs.resolved_model_ref
kernel_decisions.configuration_revision
executor_attempt_receipts.configuration_revision
executor_attempt_receipts.harness_ref
executor_attempt_receipts.model_ref
executor_attempt_receipts.permission_profile_ref
```

Keep the Decision JSON authoritative for behavior; columns support audit/query.

**Step 5: Run validation**

```bash
npx vitest run tests/kernel tests/execution/subtask-attempt-runner.test.ts tests/storage
npm run lint
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/kernel src/execution src/executor/adapter.ts src/storage tests
git commit -m "feat: bind execution to configuration revisions"
```

### Task 10: Replace Name-Based Executor Dispatch With Harness Drivers

**Files:**
- Create: `src/executor/harness-driver-registry.ts`
- Create: `src/executor/local-cli-executor-adapter.ts`
- Create: `src/executor/container-compatibility-adapter.ts`
- Modify: `src/execution/execution-runtime.ts`
- Modify: `src/executor/adapter.ts`
- Delete: `src/executor/backend-executor-adapter.ts`
- Delete: `src/executor/builtin-executor-catalog.ts`
- Delete: `src/executor/executor-admin-service.ts`
- Modify: `src/executor/agent-class-service.ts`
- Modify: `src/execution/attempt-model-gateway.ts`
- Modify: `tests/execution/execution-runtime.test.ts`
- Modify: `tests/execution/execution-runtime-boundary.test.ts`
- Create: `tests/executor/harness-driver-registry.test.ts`
- Create: `tests/executor/local-cli-executor-adapter.test.ts`
- Modify: `tests/executor/executor-module-boundary.test.ts`
- Delete: `tests/executor/backend-executor-adapter.test.ts`
- Delete: `tests/executor/builtin-executor-catalog.test.ts`

**Step 1: Write failing registry tests**

Register one Harness Driver and two AgentClasses:

```text
codex-cli -> codex-engineering
codex-cli -> codex-review
```

Assert both resolve through the same driver but receive different RuntimeBindings and private Homes.

**Step 2: Add a regression test for removed allowlists**

Read production source and assert it does not contain:

```text
['codex-cli', 'pi-agent'].includes
worktree_executor_not_canonical
```

**Step 3: Run tests and verify failure**

```bash
npx vitest run tests/executor/harness-driver-registry.test.ts tests/executor/local-cli-executor-adapter.test.ts tests/execution/execution-runtime.test.ts
```

Expected: FAIL.

**Step 4: Implement transport-neutral resolution**

Resolution becomes:

```text
AgentClassRef
  -> RuntimeConfigurationView
  -> HarnessRef
  -> HarnessDriverRegistry
  -> transport Adapter
```

No Adapter may infer a Harness from the AgentClass name.

**Step 5: Preserve container compatibility**

Move Docker behavior behind `ContainerCompatibilityAdapter`. Native installation and the default Runtime continue using `LocalCliExecutorAdapter`.

**Step 6: Run validation**

```bash
npx vitest run tests/executor tests/execution/execution-runtime.test.ts tests/execution/execution-runtime-boundary.test.ts
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/executor src/execution tests/executor tests/execution
git commit -m "refactor: dispatch executors through harness drivers"
```

### Task 11: Add Admin CLI, Management API, Doctor, And View Events

**Files:**
- Create: `src/cli/admin-args.ts`
- Create: `src/commands/configuration-admin.ts`
- Create: `src/gateway/management-api-server.ts`
- Create: `src/gateway/management-api-protocol.ts`
- Create: `src/gateway/view-events.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/index.ts`
- Modify: `src/gateway/doctor.ts`
- Modify: `src/gateway/protocol.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/commands/catalog.ts`
- Modify: `src/commands/global-commands.ts`
- Modify: `src/commands/executor-commands.ts`
- Create: `tests/cli/admin-args.test.ts`
- Create: `tests/commands/configuration-admin.test.ts`
- Create: `tests/gateway/management-api-server.test.ts`
- Create: `tests/gateway/view-events.test.ts`
- Modify: `tests/gateway/doctor.test.ts`
- Modify: `tests/commands/catalog.test.ts`

**Step 1: Write failing CLI tests**

Cover:

```text
anyfusion configure
anyfusion config show|validate|diff|history|rollback
anyfusion provider list|add|edit|test|remove
anyfusion model list|add|edit|test|remove
anyfusion planner show|configure|test
anyfusion executor list|add|edit|enable|disable|remove|test
anyfusion doctor
anyfusion status
```

Assert every command calls ConfigurationService rather than YAML, env, or SQLite directly.

**Step 2: Write failing management API tests**

Test the `/api/v1` operations from the approved design over a local Unix socket. Assert Secret values are never returned.

**Step 3: Write failing View Event tests**

Define:

```ts
type ClientViewEvent =
  | TaskStateChanged
  | PlannerStateChanged
  | ExecutorAttemptChanged
  | ConfigurationChanged
  | PermissionRequested
  | ArtifactPublished
  | NoticeRaised;
```

Assert CLI, Gateway, and Feishu adapters consume structured events without parsing display text.

**Step 4: Run tests and verify failure**

```bash
npx vitest run tests/cli/admin-args.test.ts tests/commands/configuration-admin.test.ts tests/gateway/management-api-server.test.ts tests/gateway/view-events.test.ts
```

Expected: FAIL.

**Step 5: Implement local management**

Default management transport is a mode-`0600` Unix socket. Do not enable public HTTP by default. Implement response states:

```text
activated
activated_restart_required
saved_as_draft
rejected
```

**Step 6: Replace the legacy Executor wizard**

Remove `start-executor-register-wizard` and direct `AgentClassRepo` writes. `/executor` slash commands become read-only Runtime status or ConfigurationService-backed administration.

**Step 7: Run validation**

```bash
npx vitest run tests/cli tests/commands tests/gateway
npm run lint
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/cli src/commands src/gateway src/index.ts tests/cli tests/commands tests/gateway
git commit -m "feat: add server configuration management surfaces"
```

### Task 12: Consolidate Server Lifecycle, Guidance, And Delivery

**Files:**
- Create: `src/session/server-application.ts`
- Modify: `src/index.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/session/session-presentation-service.ts`
- Modify: `src/guidance/orchestration.ts`
- Modify: `src/guidance/guidance-policy-engine.ts`
- Modify: `src/guidance/task-signal-service.ts`
- Modify: `src/gateway/delivery.ts`
- Modify: `src/gateway/delivery-factory.ts`
- Modify: `src/notifications/feishu.ts`
- Modify: `src/notifications/types.ts`
- Modify: `src/delivery/verification-and-delivery-service.ts`
- Create: `tests/session/server-application.test.ts`
- Modify: `tests/guidance/orchestration.test.ts`
- Modify: `tests/guidance/guidance-policy-engine.test.ts`
- Modify: `tests/gateway/delivery.test.ts`
- Modify: `tests/notifications/feishu-notifier.test.ts`

**Step 1: Write failing ServerApplication tests**

Test one lifecycle for:

```text
interactive Planner TUI
Gateway daemon
scripted session
standby Ink TUI
```

Assert shared startup/shutdown of database, ConfigurationService, PlannerHostBridge, Gateway, timers, and delivery.

**Step 2: Write failing Guidance ownership tests**

Assert Guidance cannot choose:

```text
next Task
retry
fallback
preemption
Executor
Model
```

It may render recovery hints from existing facts.

**Step 3: Write failing Delivery tests**

Assert completion formatting and target resolution occur once before transport selection:

```text
View/Domain Event -> DeliveryService -> CLI/Feishu/Gateway Adapter
```

**Step 4: Run tests and verify failure**

```bash
npx vitest run tests/session/server-application.test.ts tests/guidance tests/gateway/delivery.test.ts tests/notifications/feishu-notifier.test.ts
```

Expected: FAIL.

**Step 5: Implement and remove shadow policy**

Make `src/index.ts` only parse args, create `ServerApplication`, select a surface, and start it. Remove next-task scoring and implicit preemption paths touched by this task.

**Step 6: Preserve standby Ink**

Run all `tests/tui/` unchanged. Do not delete source, tests, or dependencies.

**Step 7: Run validation**

```bash
npx vitest run tests/session tests/guidance tests/gateway tests/notifications tests/tui
npm run lint
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/index.ts src/session src/guidance src/gateway src/notifications src/delivery tests
git commit -m "refactor: consolidate server lifecycle and delivery"
```

### Task 13: Build The Native Installer, Update, And Rollback Flow

**Files:**
- Create: `src/installation/installer-core.ts`
- Create: `src/installation/release-manager.ts`
- Create: `src/installation/configuration-wizard.ts`
- Create: `src/installation/doctor.ts`
- Create: `src/install-cli.ts`
- Create: `scripts/bootstrap-install.sh`
- Modify: `scripts/install-native-macos.mjs`
- Modify: `scripts/native-install-lib.mjs`
- Modify: `setup.sh`
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Create: `tests/installation/installer-core.test.ts`
- Create: `tests/installation/release-manager.test.ts`
- Create: `tests/installation/configuration-wizard.test.ts`
- Modify: `tests/scripts/native-install-lib.test.ts`

**Step 1: Write failing install transaction tests**

Test:

```text
bootstrap
  -> preflight
  -> resolve manifest
  -> stage release
  -> verify
  -> install MetaWork
  -> install planner/
  -> configure
  -> compile
  -> doctor
  -> activate
```

Assert activation never occurs after any blocking failure.

**Step 2: Write failing path and isolation tests**

Assert:

- release contains `dist/`, `node_modules/`, `package.json`, and `planner/`;
- no `server/` directory;
- no `planner/AnyFusion-Pi/` directory;
- Planner has a separate dependency tree;
- user current directory is captured at launcher invocation;
- `codex` and `pi` are detected but never installed or modified;
- PATH collision with a non-owned `anyfusion` aborts with a suggested fix.

**Step 3: Write failing update/rollback tests**

Test:

```text
stage new release
  -> dry-run config migration
  -> doctor
  -> switch app/current
  -> health check
```

On failed health check, assert both `app/current` and active configuration revision return to compatible previous values.

**Step 4: Run tests and verify failure**

```bash
npx vitest run tests/installation tests/scripts/native-install-lib.test.ts
```

Expected: FAIL.

**Step 5: Implement one Installer Core**

`scripts/bootstrap-install.sh` and `setup.sh` must both delegate to the same built `install-cli` entry. Delete the non-macOS legacy Bash Executor selection path.

**Step 6: Implement the configuration wizard**

Wizard order:

```text
region
Provider/Secret
Planner Harness
Planner Model Policy
Executor command detection
Executor AgentClasses
Model/Permission/Skill bindings
validation summary
activation
```

Allow non-interactive input through a config file. Missing Executor commands create disabled profiles rather than failing the entire install.

**Step 7: Run validation**

```bash
npx vitest run tests/installation tests/scripts/native-install-lib.test.ts
npm run build
npm run lint
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/installation src/install-cli.ts scripts setup.sh tsup.config.ts package.json tests
git commit -m "feat: add transactional native server installer"
```

### Task 14: Add The A2A Executor Adapter Behind The Existing Port

**Files:**
- Create: `src/executor/a2a-executor-adapter.ts`
- Create: `src/executor/a2a-protocol.ts`
- Modify: `src/executor/harness-driver-registry.ts`
- Modify: `src/configuration/schema.ts`
- Modify: `src/configuration/projections.ts`
- Create: `tests/executor/a2a-executor-adapter.test.ts`
- Modify: `tests/configuration/schema.test.ts`
- Modify: `tests/executor/executor-module-boundary.test.ts`

**Step 1: Write failing A2A mapping tests**

Test:

```text
AuthorizedAttemptInput
  -> A2A task/message
  -> remote status/artifacts
  -> normalized ExecutorResult
```

Cover probe, execute, streaming or polling, cancel, transport loss, auth failure, incompatible Agent Card, and artifact reference validation.

**Step 2: Add boundary tests**

Assert the A2A Adapter cannot import:

```text
ControlKernel
MetaclawSession
TaskRepo
WorkGraphRuntimeService
```

**Step 3: Run tests and verify failure**

```bash
npx vitest run tests/executor/a2a-executor-adapter.test.ts tests/executor/executor-module-boundary.test.ts tests/configuration/schema.test.ts
```

Expected: FAIL.

**Step 4: Implement transport-only behavior**

Static endpoint registration comes from Runtime-private Configuration View. Planner receives only safe capability and health projections.

**Step 5: Run validation**

```bash
npx vitest run tests/executor tests/configuration
npm run lint
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/executor src/configuration tests/executor tests/configuration
git commit -m "feat: add A2A executor transport"
```

### Task 15: Remove Legacy Sources And Close The Release Gate

**Files:**
- Delete: `src/executor/agent-class-seeder.ts` if no dynamic initialization remains
- Delete: `src/storage/agent-class-repo.ts` after migration consumers are gone
- Delete: obsolete tests that only preserve removed static AgentClass behavior
- Modify: `src/core/types.ts`
- Modify: `src/utils/config.ts`
- Modify: `src/commands/global-commands.ts`
- Modify: `src/commands/executor-commands.ts`
- Modify: `src/gateway/doctor.ts`
- Modify: `scripts/smoke-metaclaw-real-task.mjs`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CONTEXT.md`
- Modify: `AGENTS.md` only if navigation changes
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/current/phase-5-runtime-security.md`
- Modify: `docs/README.md`
- Modify: `docs/plans/2026-08-07-metawork-server-upgrade-technical-design.md`
- Modify: `docs/plans/2026-08-11-metawork-server-upgrade-implementation-plan.md`

**Step 1: Add a legacy-source detection test**

Create `tests/architecture/server-upgrade-legacy-removal.test.ts` and fail when production code still contains:

```text
executor.command
BUILTIN_EXECUTOR_VALUES
worktree_executor_not_canonical
provider.env as configuration authority
PlannerProcessRunner
runPlannerTuiProcess
PlannerTuiBridge
direct AgentClassRepo writes from UI/commands
fallback to ~/.codex or ~/.pi
```

Allow old physical database column names only inside Storage adapters.

**Step 2: Run the test and verify failure**

```bash
npx vitest run tests/architecture/server-upgrade-legacy-removal.test.ts
```

Expected: FAIL until all remaining consumers are removed.

**Step 3: Remove remaining legacy paths**

Delete old code and update tests to validate the new seams. Do not retain dead exports for pre-release compatibility.

**Step 4: Add end-to-end install smoke**

The smoke must use a temporary HOME and fake Codex/Pi commands:

```text
install
  -> configure
  -> doctor
  -> start MetaWork
  -> launch AnyFusion-Pi fixture
  -> submit Planner proposal
  -> Kernel authorize
  -> local Executor attempt
  -> receipt with matching revision
```

Hash fake user `~/.codex` and `~/.pi` before and after.

**Step 5: Run focused release gates**

```bash
npm run lint
npm test
npm run build
npm run smoke:anyfusion
npm run smoke:anyfusion -- --scenario artifact
```

Expected: PASS.

For POSIX/SQLite CI:

```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

Docker is CI validation only, not an installation prerequisite.

**Step 6: Verify the AnyFusion-Pi companion**

```bash
cd ../AnyFusion-Pi
npm run check
npm test --workspace @earendil-works/pi-coding-agent -- anyfusion
npm run build:offline
```

Expected: PASS.

**Step 7: Update plan completion metadata**

Record:

```text
Completion date
Delivered behavior
Validation commands
MetaWork closing commit
AnyFusion-Pi pinned commit
Known deferred work
```

Do not mark the design complete until one-command installation and rollback have passed in a clean temporary HOME.

**Step 8: Commit**

```bash
git add -A
git commit -m "feat: complete MetaWork server upgrade"
```

## Final Acceptance Checklist

- `anyfusion` starts MetaWork Server first and presents the controlled AnyFusion-Pi TUI.
- MetaWork release root contains `planner/` directly, with no `server/` or `planner/AnyFusion-Pi/` redundancy.
- `~/.anyfusion/config/config.yaml` is the only static configuration authority.
- Planner, Kernel, and Runtime use one immutable configuration revision per cycle.
- Planner schema contains no hard-coded Executor names.
- Runtime contains no AgentClass-name allowlist.
- Harness, ModelProfile, AgentClass, PermissionProfile, and generated runtime are independent.
- One local Harness supports multiple isolated AgentClasses.
- Codex/Pi Executors never read or write user `~/.codex` or `~/.pi`.
- Runtime and Adapter never decide retry, fallback, replan, or model substitution.
- Gateway and management surfaces never directly mutate Storage or call Executors.
- Local CLI and A2A Executors use the same authorized attempt port.
- Desktop Client code is absent; only versioned Server management contracts exist.
- Standby Ink TUI source, tests, and dependencies remain intact.
