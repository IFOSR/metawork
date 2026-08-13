# MetaWork Server Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

Status: Implemented (core code tasks complete; release-infrastructure smoke and AnyFusion-Pi cutover deferred)
Plan date: 2026-08-11
Last revised: 2026-08-13
Execution gate: Tasks that remove legacy authority or mutate SQLite may not start until Task 1 ADRs and the complete schema 30-to-31 migration/rollback contract are accepted.

**Completion (2026-08-13):** Delivered the Configuration Control Plane, Harness
Driver dispatch, admin/management surfaces, Guidance ownership, Delivery
unification, ServerApplication/ServerUpdateCoordinator, installer transaction
core, and the frozen A2A boundary. Validated with `tsc --noEmit`, `npm run build`,
`npm run lint`, and the focused Vitest suites; the native installer e2e smoke,
release-gate workflow, and AnyFusion-Pi companion cutover remain deferred to a
macOS release environment. See the task-by-task commit history on `main`.

**Goal:** Deliver the native MetaWork Server upgrade with one installation root, one revisioned configuration authority, generation-scoped Planner/Kernel/Runtime bindings, isolated AgentClass runtimes, controlled AnyFusion-Pi lifecycle, and a signed transactional update/rollback path.

**Architecture:** Add a Configuration Control Plane at the Application Shell boundary while preserving `Planner proposes -> Kernel decides -> Runtime applies -> Executor executes`. Prepare immutable revisions and new consumers without changing the current runtime authority, then perform one explicit cutover after Planner v8, Work Graph v7, Kernel authorization, recovery, Harness Drivers, and Runtime consumers are complete. Do not introduce dual-read or dual-write compatibility paths.

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
- Run `npm run build`, `npm run lint`, and the focused Vitest command after every
  task. A task is not complete if a deleted or renamed type/module leaves another
  production consumer uncompilable.
- Before deleting or renaming a production module, attach an `rg` inventory of
  all imports and migrate every consumer in the same task.
- Do not modify `~/.codex`, `~/.pi`, global Codex/Pi binaries, or user projects during tests.
- Keep `src/tui/` and its tests intact. Do not include standby Ink TUI retirement.
- Commit each task independently with the listed Conventional Commit subject.
- Tasks 8 through 10 form one release integration phase. Each commit must remain
  buildable, but none may be released or activated independently.
- AnyFusion-Pi changes must use a separate clean worktree. Do not reuse or clean
  a sibling checkout containing user changes.

### Task 1: Freeze Configuration And Routing Ownership

**Files:**
- Create: `docs/adr/0027-configuration-control-plane-and-revision-authority.md`
- Create: `docs/adr/0028-agentclass-model-and-harness-routing-contract.md`
- Create: `docs/adr/0029-executor-transport-and-a2a-boundary.md`
- Create: `docs/adr/0030-native-release-trust-and-upgrade-transaction.md`
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
~/.anyfusion/config/active/config.yaml
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

ADR-0027 must additionally establish:

```text
one configuration revision per Work Graph generation
all graph revisions, decisions, deferred replans, dispatches, attempts and receipts
remain pinned to that revision
```

ADR-0028 must define Provider/Model health identity, structured failure subjects,
binding-fingerprint attempt history, and code-owned Permission Profile grammar.

ADR-0030 must define the signed release trust root and one crash-recoverable update
transaction:

```text
lock -> close admission -> quiesce dispatch -> drain -> stop surfaces
-> WAL checkpoint/backup -> verify signed release -> migrate clone
-> stage release/config/runtime -> switch -> start/health check -> commit
```

**Step 4: Add the initial module entry point**

Create `src/configuration/index.ts` exporting only placeholder type-only ports. Do not add storage or runtime imports.

**Step 5: Run validation**

Run:

```bash
npx vitest run tests/configuration/configuration-module-boundary.test.ts
npm run build
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
  configFile: '/Users/test/.anyfusion/config/active/config.yaml',
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
  data: string;
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
  manifestSchemaVersion,
  releaseId,
  channel,
  publishedAt,
  expiresAt,
  minimumInstallerVersion,
  minimumNodeVersion,
  platform,
  arch,
  metawork: { source, revision, url, byteSize, sha256 },
  planner: { source, revision, url, byteSize, sha256 },
  compatibility: {
    configurationSchema,
    plannerHostProtocol,
    planningPlanSchema,
    planningPlanSchemaHash,
    workGraphSchema,
    kernelDecisionSchema,
    databaseSchema,
  },
  signature: { algorithm, keyId, value },
  previousCompatibleRelease,
}
```

Reject missing revision pins, wrong channel/platform/arch, expired manifests,
unknown or revoked keys, invalid signatures, artifact hash/size mismatches, and
incompatible protocol versions before executing downloaded payloads or activation.
Default update forbids downgrade; explicit rollback may select only a previously
verified compatible manifest.

**Step 5: Route legacy path helper through the new value object**

Change `resolveMetaclawDir()` to return `paths.data` during the migration window. Do not retain a second independently configurable state root.

**Step 6: Run validation**

```bash
npx vitest run tests/installation/paths.test.ts tests/installation/release-manifest.test.ts tests/utils/paths.test.ts
npm run build
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
- local CLI Harness requires command and driver ID.
- Permission Profiles reference code-owned, versioned profile IDs and expose only
  schema-bounded parameters;
- arbitrary permission DSL, commands, host paths, secret access, and policy
  overrides fail validation.

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

PermissionProfile is a reference/configuration shape, not a policy interpreter.
Resource/Kernel code owns grammar, canonicalization, grants, denials, and
elevation semantics.

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
npm run build
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
- Create: `src/configuration/keychain-secret-store.ts`
- Create: `src/configuration/file-secret-store.ts`
- Create: `src/configuration/activation-journal.ts`
- Modify: `src/configuration/index.ts`
- Create: `tests/configuration/configuration-service.test.ts`
- Create: `tests/configuration/file-configuration-repository.test.ts`
- Create: `tests/configuration/secret-store.test.ts`
- Create: `tests/configuration/activation-journal.test.ts`

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
- revision directories are immutable;
- one active pointer is the only activation switch;
- crash recovery resolves prepared/committed journals without mixed projections;
- active pointers to missing or hash-mismatched revisions enter recovery-blocked.

**Step 2: Run tests and verify failure**

```bash
npx vitest run tests/configuration/configuration-service.test.ts tests/configuration/file-configuration-repository.test.ts tests/configuration/secret-store.test.ts
```

Expected: FAIL.

**Step 3: Implement immutable revision activation**

Use:

```text
stage revision directory
  -> compile and hash config/projections/generated runtime
  -> fsync files and directory
  -> rename to immutable revisions/<revision-id>
  -> write prepared journal
  -> atomically replace the single active pointer
  -> fsync parent
  -> write committed journal
```

Do not add SQLite schema changes in this task. Keep revision audit behind a port;
the only schema bump is owned by Task 8.

**Step 4: Implement SecretStore**

Create a port with:

```ts
get(reference: SecretReference): Promise<string>;
put(reference: SecretReference, value: string): Promise<void>;
delete(reference: SecretReference): Promise<void>;
```

Implement macOS Keychain using the `security` CLI. Implement the mode-`0700`
directory/mode-`0600` file store only as an explicit fallback; failure to access
Keychain must not silently downgrade. Linux may use a documented explicit file
fallback until a Secret Service adapter is delivered.

Tests must prove secrets never appear in YAML, immutable revision directories,
diffs, SQLite audit payloads, Planner/Kernel projections, receipts, argv, or logs.

**Step 5: Run validation**

```bash
npx vitest run tests/configuration
npm run build
npm run lint
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/configuration tests/configuration
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
generated/agent-runtime/<revision-id>/planner/planner-default
generated/agent-runtime/<revision-id>/executors/codex-engineering
generated/agent-runtime/<revision-id>/executors/codex-review
generated/agent-runtime/<revision-id>/executors/pi-research
```

Test that two AgentClasses using `codex-cli` receive different generated directories and different model/permission files.
Assert referenced revision directories cannot be mutated or garbage-collected.

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
npm run build
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/configuration src/executor tests/configuration tests/executor
git commit -m "feat: compile isolated agent runtimes"
```

### Task 6: Inventory Legacy Configuration And Prepare One-Way Import

**Files:**
- Create: `src/configuration/legacy-configuration-reader.ts`
- Create: `src/configuration/configuration-migration-service.ts`
- Create: `tests/configuration/configuration-migration-service.test.ts`
- Modify: `src/utils/config.ts`
- Modify: `tests/utils/config.test.ts`

**Step 1: Write failing migration tests**

Build fixtures for:

```text
~/.metaclaw
~/.config/anyfusion
~/.local/share/anyfusion
legacy ANYFUSION_CONFIG_HOME/ANYFUSION_BIN_HOME/ANYFUSION_PI_SOURCE_ROOT
provider.env and old config.yaml/.env
Planner/Codex/Pi generated model/settings files
SQLite canonical AgentClasses
historical sibling AnyFusion-Pi checkout
existing npm/global anyfusion launcher
```

Assert they produce one schema-v2 candidate, a SecretStore import plan, source
hash inventory, conflict report, and a redacted report.

**Step 2: Test ambiguous inputs fail closed**

Examples:

- two different Provider URLs for the same profile;
- unknown custom Executor command;
- AgentClass model not present in any ModelProfile;
- dirty or unreadable Planner configuration.
- conflicting values from `~/.metaclaw` and native AnyFusion roots;
- two legacy override variables selecting different roots.

Expected error shape:

```ts
{ path, code, message, severity: 'error', suggestedFix }
```

**Step 3: Run tests and verify failure**

```bash
npx vitest run tests/configuration/configuration-migration-service.test.ts tests/utils/config.test.ts
```

Expected: FAIL.

**Step 4: Implement deterministic dry-run import**

The migration command must:

```text
read legacy
  -> build candidate
  -> build SecretStore import plan
  -> record source hashes
  -> validate
  -> show redacted diff
  -> stage immutable candidate revision
```

Repeated dry-runs against unchanged sources must produce the same candidate hash.
Dirty sibling repositories are reported but never moved or overwritten. This task
does not activate the candidate and does not change current runtime authority.

**Step 5: Prove legacy authority remains unchanged**

Add tests proving this task does not stop AgentClass seeding, change existing
Configuration readers, or mutate the SQLite schema. Legacy removal happens only
in Task 10 after all new consumers are ready.

**Step 6: Run validation**

```bash
npx vitest run tests/configuration/configuration-migration-service.test.ts tests/utils/config.test.ts
npm run build
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/configuration src/utils/config.ts tests/configuration tests/utils
git commit -m "feat: prepare legacy configuration import"
```

### Task 7: Unify Planner Process Lifecycle And Host Bridge

**Files:**
- Create: `src/planning/planner-process-supervisor.ts`
- Create: `src/planning/planner-audit-contract.ts`
- Move: `src/tui-bridge/planner-tui-bridge.ts` to `src/tui-bridge/planner-host-bridge.ts`
- Modify: `src/tui-bridge/planner-host-protocol.ts`
- Modify: `src/planning/planner-process-runner.ts`
- Modify: `src/tui-bridge/planner-tui-process.ts`
- Modify: `src/planning/anyfusion-planning-agent.ts`
- Modify: `src/storage/planner-run-repo.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/index.ts`
- Create: `tests/planning/planner-process-supervisor.test.ts`
- Move: `tests/tui-bridge/planner-tui-bridge.test.ts` to `tests/tui-bridge/planner-host-bridge.test.ts`
- Modify: `tests/planner-process-runner.test.ts`
- Modify: `tests/tui-bridge/planner-tui-process.test.ts`

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

**Step 3: Extract shared Planner audit types**

Move `PlannerToolCallTrace` and other persisted Planner audit types out of
`planner-process-runner.ts` before changing process ownership. Update Storage and
all other imports to use the independent audit contract.

**Step 4: Implement the supervisor**

Interactive mode inherits terminal stdio. RPC mode uses JSONL stdin/stdout and one short-lived child per turn. Preserve same-session serialization.

**Step 5: Rename the Bridge**

Keep the Host Protocol unchanged unless ADR-0028 requires a version bump. The Bridge stays in the MetaWork Server process and exposes no generic mutation API.

Keep the old runner/process modules as delegating wrappers until Task 10's atomic
authority cutover. Do not delete them while production imports remain.

**Step 6: Update the AnyFusion-Pi companion**

Files in the AnyFusion-Pi repository:

- Modify: `packages/coding-agent/src/anyfusion/planner-bootstrap.ts`
- Modify: `packages/coding-agent/src/anyfusion/planner-host-client.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-bootstrap.test.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-host-client.test.ts`

Only update protocol names/configuration inputs required by the host change. Do not move Kernel or Runtime logic into Pi.

Use a new clean AnyFusion-Pi worktree pinned from the intended base commit. Do not
clean, reset, or commit through the existing sibling checkout.

**Step 7: Run validation in both repositories**

MetaWork:

```bash
npx vitest run tests/planning/planner-process-supervisor.test.ts tests/tui-bridge
npm run build
npm run lint
```

AnyFusion-Pi:

```bash
npm run check
npm test --workspace @earendil-works/pi-coding-agent -- anyfusion-planner
```

Expected: PASS.

**Step 8: Commit both repositories**

MetaWork:

```bash
git add src/planning src/tui-bridge src/session src/storage src/index.ts tests
git commit -m "refactor: unify planner process lifecycle"
```

AnyFusion-Pi:

```bash
git add packages/coding-agent/src/anyfusion packages/coding-agent/test
git commit -m "refactor: align planner host lifecycle"
```

Record the AnyFusion-Pi commit in the release manifest fixture.

### Task 8: Upgrade The Full Planning Chain And Apply The Single SQLite V31 Migration

**Files:**
- Modify: `src/planning/planning-agent-plan-schema.ts`
- Modify: `src/planning/planning-types.ts`
- Modify: `src/planning/planning-agent-plan-validator.ts`
- Modify: `src/planning/planning-context-builder.ts`
- Modify: `src/work-graph/types.ts`
- Modify: `src/work-graph/validation.ts`
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/execution/work-graph-runtime-service.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/execution/work-unit-claim-service.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/storage/subtask-repo.ts`
- Modify: `src/storage/planner-run-repo.ts`
- Modify: `src/storage/kernel-decision-repo.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/generate-planner-schema.ts`
- Modify: `package.json`
- Modify: `tests/planning/planning-agent-plan-schema.test.ts`
- Modify: `tests/planning/planning-agent-plan-validator.test.ts`
- Modify: `tests/planning/planning-context-builder.test.ts`
- Modify: `tests/planning/work-graph-structure-rules.test.ts`
- Modify: `tests/kernel/control-kernel.test.ts`
- Modify: `tests/execution/work-graph-runtime-service.test.ts`
- Modify: `tests/execution/kernel-execution-runtime.test.ts`
- Modify: `tests/storage/migrations.test.ts`

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

The generated structural schema must use constrained strings for `agentClassRef`
and `modelRef`, with no hard-coded or runtime-generated enum. Test separate
revision-scoped semantic validation against PlannerConfigurationView for
existence, enabled state, Harness compatibility, and ModelPolicy.

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

Before implementation, use `rg` to inventory every consumer of
`preferredAgentClassList`, Plan v7, Work Graph v6, persisted subtask bindings,
claim payloads, dispatch payloads, Session projections, and recovery payloads.
Migrate every production consumer in this task. Do not accept v7 after the
cutover migration.

**Step 4: Implement the only SQLite schema bump**

Implement one transactionally complete `30 -> 31` migration. No other task in
this plan may change `CURRENT_SCHEMA_VERSION`. V31 must include:

```text
configuration_revisions audit table
Planner run / Kernel decision / attempt receipt revision and binding columns
Work Graph generation configuration revision
deferred replan and dispatch revision/binding fields
Provider/Model health projection tables or columns
remove work_units -> agent_classes foreign key
remove kernel_executor_status -> agent_classes foreign key
all required indexes, constraints and immutable triggers
recoverable Plan v7 -> v8 payload conversion
recoverable Work Graph v6 -> v7 payload conversion
deferred proposal, dispatch, Kernel event/snapshot JSON conversion
imported revision backfill for recoverable records
```

Run against a real schema-30 fixture. An ambiguous AgentClass/model binding must
rollback the whole migration. Validate `foreign_key_check`, index/trigger sets,
row counts, terminal ledger hashes, and idempotent second startup.

**Step 5: Update AnyFusion-Pi Planner instructions**

Files:

- Modify: `packages/coding-agent/src/metaclaw-planner/SKILL.md`
- Modify: `packages/coding-agent/src/anyfusion/planner-system-prompt.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-system-prompt.test.ts`
- Modify: `packages/coding-agent/test/anyfusion-planner-proposal-types.test.ts`

Remove canonical Executor names from prose. Require the Planner to use the supplied catalog and model policy.

**Step 6: Run two-repository contract validation**

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

The gate must additionally:

```text
generate the v8 schema and acceptance fixture in MetaWork
have AnyFusion-Pi emit a proposal using that schema
feed the proposal through the real MetaWork validator and Kernel admission
pin both commits, Host Protocol, Plan/Graph versions and schema hash in a manifest fixture
```

**Step 7: Commit**

MetaWork:

```bash
git add src/planning src/work-graph src/kernel src/execution src/session src/storage src/generate-planner-schema.ts package.json tests
git commit -m "feat: authorize AgentClass and model proposals"
```

AnyFusion-Pi:

```bash
git add packages/coding-agent/src/metaclaw-planner packages/coding-agent/src/anyfusion packages/coding-agent/test
git commit -m "feat: emit Planner v8 executor bindings"
```

### Task 9: Pin Configuration And Health Identity Through Kernel Recovery

**Files:**
- Modify: `src/kernel/control-kernel.ts`
- Modify: `src/kernel/kernel-workflow.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/execution/subtask-attempt-runner.ts`
- Modify: `src/executor/adapter.ts`
- Modify: `src/core/kernel-failure.ts`
- Modify: `src/kernel/executor-status-projection.ts`
- Modify: `src/storage/planner-run-repo.ts`
- Modify: `src/storage/kernel-decision-repo.ts`
- Modify: `src/storage/executor-attempt-receipt-repo.ts`
- Modify: `src/storage/generation-replan-request-repo.ts`
- Modify: `src/storage/dispatch-item-repo.ts`
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
  === generation.configurationRevision
  === deferredReplan.configurationRevision
  === kernelDecision.configurationRevision
  === dispatchItem.configurationRevision
  === attemptReceipt.configurationRevision;
```

Test that every graph revision, retry, fallback, recovery packet, and attempt in
one generation remains pinned after the active configuration changes. Runtime
must reject a binding whose revision differs from the generation or Decision.

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

Derive a stable binding fingerprint from the full tuple plus generation/subtask.
Use it in deterministic attempt identity and fallback history so two models under
one AgentClass remain distinct attempts.

**Step 4: Implement Provider/Model health facts**

Extend normalized failure identity to:

```ts
type KernelFailureSubject =
  | { kind: 'attempt'; attemptId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'agent_class'; agentClassRef: string }
  | { kind: 'provider'; providerRef: string }
  | { kind: 'model'; providerRef: string; modelRef: string };
```

Add Kernel-owned AgentClass, Provider, Model, and binding health projections.
Probe/recovery facts carry `configurationRevision`, subject identity, and probe
generation. Runtime persists normalized facts but cannot choose fallback, reset
cooldown, or substitute a model.

**Step 5: Fill the V31 audit fields**

Use the columns already created by Task 8. Do not modify SQLite schema here.
Decision JSON remains authoritative; audit columns support query and invariant
checks.

**Step 6: Run validation**

```bash
npx vitest run tests/kernel tests/execution/subtask-attempt-runner.test.ts tests/storage
npm run build
npm run lint
```

Expected: PASS.

**Step 7: Commit**

```bash
git add src/kernel src/execution src/executor/adapter.ts src/storage tests
git commit -m "feat: bind execution to configuration revisions"
```

### Task 10: Switch Harness Drivers And Perform The Atomic Authority Cutover

**Files:**
- Create: `src/executor/harness-driver-registry.ts`
- Create: `src/executor/local-cli-executor-adapter.ts`
- Create: `src/executor/container-compatibility-adapter.ts`
- Modify: `src/execution/execution-runtime.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/executor/adapter.ts`
- Delete: `src/executor/backend-executor-adapter.ts`
- Delete: `src/executor/builtin-executor-catalog.ts`
- Delete: `src/executor/executor-admin-service.ts`
- Delete: `src/executor/agent-class-seeder.ts`
- Delete: `src/planning/planner-process-runner.ts`
- Delete: `src/tui-bridge/planner-tui-process.ts`
- Modify: `src/executor/agent-class-service.ts`
- Modify: `src/execution/attempt-model-gateway.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/commands/executor-commands.ts`
- Modify: `src/utils/config.ts`
- Modify: `tests/execution/execution-runtime.test.ts`
- Modify: `tests/execution/execution-runtime-boundary.test.ts`
- Create: `tests/executor/harness-driver-registry.test.ts`
- Create: `tests/executor/local-cli-executor-adapter.test.ts`
- Modify: `tests/executor/executor-module-boundary.test.ts`
- Delete: `tests/executor/backend-executor-adapter.test.ts`
- Delete: `tests/executor/builtin-executor-catalog.test.ts`
- Delete: `tests/planner-process-runner.test.ts`
- Delete: `tests/tui-bridge/planner-tui-process.test.ts`
- Create: `tests/architecture/configuration-authority-cutover.test.ts`

**Step 1: Write failing registry tests**

Register one Harness Driver and two AgentClasses:

```text
codex-cli -> codex-engineering
codex-cli -> codex-review
```

Assert both resolve through the same driver but receive different RuntimeBindings and private Homes.

**Step 2: Inventory and migrate every legacy consumer**

Attach `rg` output for builtin catalog, AgentClassRepo/static fields,
`provider.env`, Harness settings, PlannerProcessRunner, direct command writes,
and name-based allowlists. Switch Planning, Kernel snapshot assembly, Session,
Recovery, Commands, and Runtime to the new projections and driver registry.

**Step 3: Add regression tests for removed authority**

Read production source and assert it does not contain:

```text
['codex-cli', 'pi-agent'].includes
worktree_executor_not_canonical
provider.env as runtime configuration authority
direct AgentClassRepo writes from commands or UI
fallback reads from legacy Harness model/settings files
```

**Step 4: Run tests and verify failure**

```bash
npx vitest run tests/executor/harness-driver-registry.test.ts tests/executor/local-cli-executor-adapter.test.ts tests/execution/execution-runtime.test.ts
```

Expected: FAIL.

**Step 5: Implement transport-neutral resolution**

Resolution becomes:

```text
AgentClassRef
  -> RuntimeConfigurationView
  -> HarnessRef
  -> HarnessDriverRegistry
  -> transport Adapter
```

No Adapter may infer a Harness from the AgentClass name.

**Step 6: Perform one atomic authority cutover**

Execute exactly:

```text
import secrets and validate references
  -> finalize staged revision from Task 6
  -> publish Planner/Kernel/Runtime projections
  -> publish revision-scoped generated runtime
  -> atomically switch the single active pointer
  -> run Configuration/Planner/Kernel/Runtime health checks
  -> stop legacy AgentClass seeding and legacy readers
  -> remove delegating Planner wrappers and obsolete catalog/admin modules
```

Do not dual-read. If validation or activation fails, the active pointer and all
legacy authority remain unchanged. Historical revision artifacts remain until no
generation, decision, dispatch, attempt, receipt, or recovery record references
them.

**Step 7: Preserve container compatibility**

Move Docker behavior behind `ContainerCompatibilityAdapter`. Native installation and the default Runtime continue using `LocalCliExecutorAdapter`.

**Step 8: Run validation**

```bash
npx vitest run tests/executor tests/execution/execution-runtime.test.ts tests/execution/execution-runtime-boundary.test.ts
npx vitest run tests/architecture/configuration-authority-cutover.test.ts
npm run build
npm run lint
```

Expected: PASS.

**Step 9: Commit**

```bash
git add src/executor src/execution src/planning src/tui-bridge src/session src/commands src/utils tests
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

Define `/api/v1/server/health` as a versioned, bounded response covering release,
database schema, active configuration revision, Planner protocol, Kernel
workflow availability, dispatch quiescence, and blocking recovery state. Public
HTTP management, TLS, remote authentication, and rate limiting are not delivered
in this plan.

**Step 6: Replace the legacy Executor wizard**

Remove `start-executor-register-wizard` and direct `AgentClassRepo` writes. `/executor` slash commands become read-only Runtime status or ConfigurationService-backed administration.

**Step 7: Run validation**

```bash
npx vitest run tests/cli tests/commands tests/gateway
npm run build
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
- Create: `src/session/server-update-coordinator.ts`
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
- Create: `tests/session/server-update-coordinator.test.ts`
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

Test an explicit update lifecycle:

```text
acquireUpdateLease
  -> closeTaskAdmission
  -> quiesceDispatch
  -> awaitIdle(timeout)
  -> stopSurfaces/outbox/publication/timers
  -> close database
  -> startCandidate or restartPrevious
  -> openTaskAdmission
```

`quiesceDispatch` must prevent new dispatch and must not reuse a drain loop that
continues to kick pending attempts. Concurrent update requests allow one holder.
Timeout aborts the update instead of force-killing attempts.

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
npx vitest run tests/session/server-application.test.ts tests/session/server-update-coordinator.test.ts tests/guidance tests/gateway/delivery.test.ts tests/notifications/feishu-notifier.test.ts
```

Expected: FAIL.

**Step 5: Implement and remove shadow policy**

Make `src/index.ts` only parse args, create `ServerApplication`, select a surface, and start it. Remove next-task scoring and implicit preemption paths touched by this task.

**Step 6: Preserve standby Ink**

Run all `tests/tui/` unchanged. Do not delete source, tests, or dependencies.

**Step 7: Run validation**

```bash
npx vitest run tests/session tests/guidance tests/gateway tests/notifications tests/tui
npm run build
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
- Create: `src/installation/release-verifier.ts`
- Create: `src/installation/database-backup.ts`
- Create: `src/installation/upgrade-journal.ts`
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
- Create: `tests/installation/release-verifier.test.ts`
- Create: `tests/installation/database-backup.test.ts`
- Create: `tests/installation/upgrade-journal.test.ts`
- Create: `tests/installation/configuration-wizard.test.ts`
- Modify: `tests/scripts/native-install-lib.test.ts`

**Step 1: Write failing install transaction tests**

Test:

```text
bootstrap
  -> preflight
  -> acquire update lock and close admission
  -> quiesce/drain/stop Server
  -> resolve and verify signed manifest
  -> stage release
  -> checkpoint and back up database
  -> migrate a cloned database
  -> install MetaWork
  -> install planner/
  -> configure
  -> compile
  -> doctor
  -> activate
  -> start candidate
  -> health check
  -> reopen admission and commit journal
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
  -> WAL checkpoint and verified database backup
  -> migrate cloned database
  -> doctor
  -> switch database/config/generated/app pointers
  -> start candidate with admission closed
  -> health check
```

Inject failures after backup, migration, each pointer switch, restart, and health
check. On failure, assert database hash/schema, `app/current`, active
configuration revision, generated runtime revision, daemon version, and admission
state all return to the compatible previous combination.

**Step 4: Run tests and verify failure**

```bash
npx vitest run tests/installation tests/scripts/native-install-lib.test.ts
```

Expected: FAIL.

**Step 5: Implement the bootstrap trust root**

`scripts/bootstrap-install.sh` contains only versioned trust-root material and a
minimal verifier/downloader. It must verify the signed manifest before executing
any downloaded shell or Node payload. Reject unknown/revoked keys, expired
manifests, wrong channel/platform/arch, invalid signatures, and artifact hash or
size mismatch. Local rollback uses the previously verified stored manifest and
does not require the network.

**Step 6: Implement one Installer Core**

`scripts/bootstrap-install.sh` and `setup.sh` must both delegate to the same built `install-cli` entry. Delete the non-macOS legacy Bash Executor selection path.

The upgrade path must use `ServerUpdateCoordinator`; it cannot switch files under
a running daemon. Before migration:

```text
PRAGMA wal_checkpoint(TRUNCATE)
close database handles
SQLite backup API -> data/backups/<upgrade-id>/metaclaw.db
record database hash/schema/release/config revision
```

Run migration against a clone first. Health check must pass before reopening Task
admission. Rollback restores database, configuration pointer, generated runtime
pointer, `app/current`, old daemon, then health checks the restored system.

**Step 7: Implement the configuration wizard**

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

**Step 8: Run validation**

```bash
npx vitest run tests/installation tests/scripts/native-install-lib.test.ts
npm run build
npm run lint
```

Expected: PASS.

**Step 9: Commit**

```bash
git add src/installation src/install-cli.ts scripts setup.sh tsup.config.ts package.json tests
git commit -m "feat: add transactional native server installer"
```

### Task 14: Freeze The Remote Executor Seam And Defer A2A Delivery

**Files:**
- Modify: `docs/adr/0029-executor-transport-and-a2a-boundary.md`
- Create: `docs/plans/future-a2a-executor-transport-roadmap.md`
- Modify: `src/executor/adapter.ts`
- Modify: `tests/executor/executor-module-boundary.test.ts`

**Step 1: Write the transport-seam boundary test**

Assert the existing authorized attempt port is transport-neutral and contains the
identity required by a future remote envelope:

```text
attemptId
generationId
configurationRevision
bindingFingerprint
authorized AgentClass/Harness/Model/Permission Profile
resource/capability grant
artifact provenance requirements
idempotency key
```

Do not create an A2A configuration variant or inactive production adapter.

**Step 2: Freeze ownership**

ADR-0029 must state that future A2A remains
`Planner -> Kernel -> Runtime -> ExecutorAdapter -> transport`, and that remote
transport cannot select models, AgentClasses, permission profiles, retry,
fallback, or scheduling.

**Step 3: Write the separate roadmap**

The future plan must cover version negotiation, authentication/trust rotation,
request idempotency, disconnect/poll/stream/cancel, uncertain outcomes, artifact
integrity, remote permission/resource boundaries, and failure normalization.

**Step 4: Run validation**

```bash
npx vitest run tests/executor/executor-module-boundary.test.ts
npm run build
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/adr/0029-executor-transport-and-a2a-boundary.md docs/plans/future-a2a-executor-transport-roadmap.md src/executor/adapter.ts tests/executor/executor-module-boundary.test.ts
git commit -m "docs: freeze future A2A executor boundary"
```

### Task 15: Remove Legacy Sources And Close The Release Gate

**Files:**
- Verify deletion: `src/executor/agent-class-seeder.ts` if no dynamic initialization remains
- Verify deletion: `src/storage/agent-class-repo.ts` after migration consumers are gone
- Delete: obsolete tests that only preserve removed static AgentClass behavior
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/native-release-smoke.yml`
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
clean install
  -> configure
  -> doctor
  -> start MetaWork
  -> launch AnyFusion-Pi fixture
  -> submit Planner proposal
  -> Kernel authorize
  -> local Executor attempt
  -> receipt with matching revision
  -> signed update from schema 30 to 31
  -> daemon quiesce/restart
  -> injected candidate health failure
  -> restore database/config/generated/app and old daemon
```

Hash fake user `~/.codex` and `~/.pi` before and after.
Run legacy migration fixtures for both `~/.metaclaw` and native AnyFusion roots.

**Step 5: Add native macOS and Linux release gates**

The macOS job must use a temporary HOME and exercise real `better-sqlite3`, file
permissions, symlinks, launcher execution, Keychain integration, Planner child
processes, signed manifest verification, daemon drain/restart, schema 30-to-31
migration, and failed-candidate rollback. Linux CI covers SecretStore fallback
and POSIX compatibility. Docker does not replace native macOS acceptance.

**Step 6: Run focused release gates**

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

**Step 7: Verify the AnyFusion-Pi companion**

```bash
cd ../AnyFusion-Pi
npm run check
npm test --workspace @earendil-works/pi-coding-agent -- anyfusion
npm run build:offline
```

Expected: PASS.

Use the clean worktree created for Tasks 7-8. Verify the release manifest pins
the tested MetaWork and AnyFusion-Pi commits, Host Protocol, Plan/Graph versions,
and schema hash.

**Step 8: Update plan completion metadata**

Record:

```text
Completion date
Delivered behavior
Validation commands
MetaWork closing commit
AnyFusion-Pi pinned commit
Known deferred work
```

Do not mark the design complete until one-command installation, signed update,
database rollback, daemon restart, and both native macOS/Linux gates have passed
in clean temporary HOMEs.

**Step 9: Commit**

```bash
git add -A
git commit -m "feat: complete MetaWork server upgrade"
```

## Final Acceptance Checklist

- `anyfusion` starts MetaWork Server first and presents the controlled AnyFusion-Pi TUI.
- MetaWork release root contains `planner/` directly, with no `server/` or `planner/AnyFusion-Pi/` redundancy.
- `~/.anyfusion/config/active/config.yaml`, reached through the single active
  revision pointer, is the only current static configuration authority.
- Every Work Graph generation, including graph revisions, deferred recovery,
  dispatches, retries/fallbacks and receipts, uses one immutable configuration revision.
- Planner schema contains no hard-coded Executor names.
- Runtime contains no AgentClass-name allowlist.
- Harness, ModelProfile, AgentClass, PermissionProfile, and generated runtime are independent.
- One local Harness supports multiple isolated AgentClasses.
- Codex/Pi Executors never read or write user `~/.codex` or `~/.pi`.
- Runtime and Adapter never decide retry, fallback, replan, or model substitution.
- AgentClass, Provider, Model, and binding health use explicit revision-scoped identities.
- Gateway and management surfaces never directly mutate Storage or call Executors.
- The authorized attempt port is transport-neutral; A2A implementation remains
  deferred to its separate roadmap.
- Release manifests are signed and verified through a versioned trust root before
  downloaded payload execution.
- Schema 30-to-31 update and rollback restore database, configuration, generated
  runtime, application release, daemon, and admission as one compatible combination.
- Native macOS and Linux release gates pass.
- Desktop Client code is absent; only versioned Server management contracts exist.
- Standby Ink TUI source, tests, and dependencies remain intact.
