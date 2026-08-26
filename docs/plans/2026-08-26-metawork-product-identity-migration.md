# MetaWork Product Identity Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Status:** Completed

**Plan date:** 2026-08-26

**Completion date:** 2026-08-26

**Goal:** Make MetaWork the canonical private product identity, CLI, and fresh-install root while preserving existing AnyFusion and MetaClaw entry points, persisted state, and concrete AnyFusion component contracts.

**Architecture:** Product naming is resolved only at Application Shell, configuration, installation, and presentation boundaries. Canonical `METAWORK_*` settings and `~/.metawork` paths are introduced with fail-closed AnyFusion aliases; existing roots are migrated through one verified offline transaction, never through steady-state dual reads or writes. Planner, Kernel, Work Graph, Execution, durable database identifiers, `AnyFusion-Pi`, and protocol IDs retain their existing semantics.

**Tech Stack:** Node.js 22.19+, TypeScript ESM, Bash, React/Vite, better-sqlite3, Vitest.

---

### Task 1: Add Canonical Product Environment Resolution

**Files:**

- Create: `src/installation/product-environment.ts`
- Create: `tests/installation/product-environment.test.ts`

**Step 1: Write the failing environment-alias tests**

Cover:

- canonical-only `METAWORK_INSTALL_ROOT`;
- compatibility-only `ANYFUSION_INSTALL_ROOT`;
- identical normalized values;
- conflicting values failing with both variable names;
- empty values treated as absent;
- provider, secret-store, and config-home pairs using the same resolver.

Use a table-driven test around:

```ts
resolveProductEnvironment(
  { METAWORK_INSTALL_ROOT: '/srv/metawork' },
  'METAWORK_INSTALL_ROOT',
  'ANYFUSION_INSTALL_ROOT',
);
```

**Step 2: Run the focused test and verify failure**

Run:

```bash
npx vitest run tests/installation/product-environment.test.ts
```

Expected: FAIL because `product-environment.ts` does not exist.

**Step 3: Implement the minimal resolver**

Export:

```ts
export function resolveProductEnvironment(
  env: NodeJS.ProcessEnv,
  canonicalName: string,
  compatibilityName: string,
): string | undefined;
```

Trim both values. Return the only configured value, accept equal values, and
throw a field-specific conflict error when both differ. Do not mutate `env`.

Also export constants for the public environment pairs used by installation:

```ts
export const PRODUCT_ENVIRONMENT = {
  installRoot: ['METAWORK_INSTALL_ROOT', 'ANYFUSION_INSTALL_ROOT'],
  providerKey: ['METAWORK_PROVIDER_KEY', 'ANYFUSION_PROVIDER_KEY'],
  providerUrl: ['METAWORK_PROVIDER_URL', 'ANYFUSION_PROVIDER_URL'],
  providerModel: ['METAWORK_PROVIDER_MODEL', 'ANYFUSION_PROVIDER_MODEL'],
  providerRegion: ['METAWORK_PROVIDER_REGION', 'ANYFUSION_PROVIDER_REGION'],
  secretStore: ['METAWORK_SECRET_STORE', 'ANYFUSION_SECRET_STORE'],
  configHome: ['METAWORK_CONFIG_HOME', 'ANYFUSION_CONFIG_HOME'],
} as const;
```

Do not add aliases for `ANYFUSION_PI_*` or `ANYFUSION_PLANNER_*`; those identify
the AnyFusion-Pi component.

**Step 4: Run the test and lint**

Run:

```bash
npx vitest run tests/installation/product-environment.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/installation/product-environment.ts \
  tests/installation/product-environment.test.ts
git commit -m "feat: resolve MetaWork environment compatibility"
```

### Task 2: Introduce MetaWork Paths Without Breaking Existing Callers

**Files:**

- Modify: `src/installation/paths.ts`
- Modify: `src/account/account-paths.ts`
- Modify: `src/utils/paths.ts`
- Modify: `tests/installation/paths.test.ts`
- Modify: `tests/account/account-paths.test.ts`
- Modify: `tests/utils/paths.test.ts`

**Step 1: Rewrite path tests for the canonical layout**

Assert that:

- `resolveMetaWorkPaths('/Users/test')` uses `/Users/test/.metawork`;
- its primary launcher is `/Users/test/.local/bin/metawork`;
- compatibility launchers are `anyfusion` and `metaclaw`;
- `METAWORK_INSTALL_ROOT` wins when configured alone;
- `ANYFUSION_INSTALL_ROOT` still works alone;
- conflicting roots fail closed;
- durable account database name remains `anyfusion.db`;
- legacy global database name remains `metaclaw.db`;
- `resolveAnyFusionPaths()` forwards to the same resolved object.

**Step 2: Run focused path tests and verify failure**

Run:

```bash
npx vitest run tests/installation/paths.test.ts \
  tests/account/account-paths.test.ts \
  tests/utils/paths.test.ts
```

Expected: FAIL on missing MetaWork APIs and old defaults.

**Step 3: Add canonical path types and forwarding aliases**

In `src/installation/paths.ts`:

- introduce `MetaWorkPaths` and `MetaWorkReleasePaths`;
- add `resolveMetaWorkRoot()` and `resolveMetaWorkPaths()`;
- use `~/.metawork` for a clean default;
- include `launcher`, `anyFusionLauncher`, and `metaclawLauncher`;
- preserve `resolveAnyFusionRoot`, `resolveAnyFusionPaths`,
  `AnyFusionPaths`, and `AnyFusionReleasePaths` as thin deprecated aliases;
- keep `resolveReleasePaths()` behavior and physical release layout unchanged.

Migrate `resolveAccountPaths()` and `resolveMetaclawDir()` to the canonical API.
Do not rename the latter in this task because it is an internal compatibility
helper used by the runtime.

**Step 4: Run focused tests and lint**

Run:

```bash
npx vitest run tests/installation/paths.test.ts \
  tests/account/account-paths.test.ts \
  tests/utils/paths.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/installation/paths.ts src/account/account-paths.ts \
  src/utils/paths.ts tests/installation/paths.test.ts \
  tests/account/account-paths.test.ts tests/utils/paths.test.ts
git commit -m "feat: add canonical MetaWork installation paths"
```

### Task 3: Add The MetaWork CLI And Preserve Managed Aliases

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/cli/args.ts`
- Modify: `src/installation/native-launcher.ts`
- Modify: `src/installation/source-native-installer.ts`
- Modify: `tests/cli/args.test.ts`
- Modify: `tests/installation/native-launcher.test.ts`
- Modify: `tests/installation/source-native-installer.test.ts`
- Modify: `tests/scripts/smoke-unified-gateway.test.ts`

**Step 1: Add failing CLI and launcher tests**

Assert:

- help title and examples use `MetaWork` and `metawork`;
- help lists `anyfusion` and `metaclaw` as compatibility aliases;
- script-path errors use `metawork`;
- the package is named `metawork`, is private, and exposes `metawork`;
- `anyfusion` and `metaclaw` still point to `dist/index.js`;
- `metawork-install` is canonical and `anyfusion-install` remains an alias;
- the generated launcher marker is `# MetaWork managed launcher`;
- old `# AnyFusion managed launcher` files are still recognized as managed;
- the launcher exports `METAWORK_INSTALL_ROOT` and mirrors it into
  `ANYFUSION_INSTALL_ROOT` for component compatibility;
- all three launchers resolve to the same release and state root.

**Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/cli/args.test.ts \
  tests/installation/native-launcher.test.ts \
  tests/installation/source-native-installer.test.ts \
  tests/scripts/smoke-unified-gateway.test.ts
```

Expected: FAIL on AnyFusion-first help, package metadata, and one-launcher
installation.

**Step 3: Implement the package and launcher facade**

Update package metadata:

```json
{
  "name": "metawork",
  "private": true,
  "bin": {
    "metawork": "./dist/index.js",
    "anyfusion": "./dist/index.js",
    "metaclaw": "./dist/index.js",
    "metawork-install": "./dist/install-cli.js",
    "anyfusion-install": "./dist/install-cli.js"
  }
}
```

Retain capability helper binaries. Do not change the runtime version in this
branding migration.

Teach native-launcher ownership checks to accept both old and new managed
markers. Install identical launchers at the three paths, and remove only
managed launchers during rollback. Keep `ANYFUSION_PI_SOURCE_ROOT` because it
points to the AnyFusion-Pi component.

**Step 4: Regenerate the lockfile and run tests**

Run:

```bash
npm install --package-lock-only
npx vitest run tests/cli/args.test.ts \
  tests/installation/native-launcher.test.ts \
  tests/installation/source-native-installer.test.ts \
  tests/scripts/smoke-unified-gateway.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json package-lock.json src/cli/args.ts \
  src/installation/native-launcher.ts \
  src/installation/source-native-installer.ts \
  tests/cli/args.test.ts tests/installation/native-launcher.test.ts \
  tests/installation/source-native-installer.test.ts \
  tests/scripts/smoke-unified-gateway.test.ts
git commit -m "feat: add MetaWork CLI with compatibility aliases"
```

### Task 4: Migrate Installer Inputs To MetaWork Variables

**Files:**

- Modify: `src/install-cli.ts`
- Modify: `src/configuration/production-secret-store.ts`
- Modify: `setup.sh`
- Modify: `scripts/install-native-macos.mjs`
- Modify: `tests/installation/native-install-cli.test.ts`
- Modify: `tests/configuration/production-secret-store.test.ts`
- Create: `tests/scripts/setup-product-environment.test.ts`

**Step 1: Write failing installer compatibility tests**

Cover:

- a clean install using only `METAWORK_*`;
- an install using only existing `ANYFUSION_*`;
- equal canonical and compatibility values;
- conflicting provider URL, key, model, region, install root, and secret-store
  values failing before filesystem mutation;
- installer usage and errors naming `metawork-install`;
- setup accepting canonical variables and retaining the AnyFusion-Pi source
  override;
- non-macOS defaulting the canonical secret-store setting to `file`.

Do not print provider secret values in diagnostics.

**Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/installation/native-install-cli.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/scripts/setup-product-environment.test.ts
```

Expected: FAIL because only `ANYFUSION_*` is read.

**Step 3: Implement canonical installer resolution**

Use `resolveProductEnvironment()` in TypeScript. In `setup.sh`, add a small
shell function that applies the same four resolution rules before invoking
Node. Export canonical values and mirror them into compatibility variables
only for unchanged lower-level component contracts.

Keep new secret references under the existing `anyfusion/` namespace during
this migration. Those references are persisted configuration identifiers, not
public branding.

**Step 4: Run focused tests and shell checks**

Run:

```bash
npx vitest run tests/installation/native-install-cli.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/scripts/setup-product-environment.test.ts
bash -n setup.sh
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/install-cli.ts src/configuration/production-secret-store.ts \
  setup.sh scripts/install-native-macos.mjs \
  tests/installation/native-install-cli.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/scripts/setup-product-environment.test.ts
git commit -m "feat: accept canonical MetaWork installer settings"
```

### Task 5: Add Verified Legacy Root Migration

**Files:**

- Create: `src/installation/product-root-migrator.ts`
- Create: `tests/installation/product-root-migrator.test.ts`
- Modify: `src/install-cli.ts`
- Modify: `tests/installation/native-install-cli.test.ts`
- Modify: `src/installation/source-native-updater.ts`
- Modify: `tests/installation/source-native-updater.test.ts`

**Step 1: Write failing migration tests**

Use real temporary directories and SQLite fixtures to cover:

- no legacy root returning `not_needed`;
- a populated `~/.anyfusion` root copied to staging and activated as
  `~/.metawork`;
- releases, `app/current`, account configuration, database symlink and target,
  secrets metadata, generated runtime, Planner sessions, Conversations,
  workspaces, attempts, results, and journals surviving migration;
- ephemeral `runtime.lock` and Unix socket paths not being copied;
- live legacy runtime lock refusing migration;
- target and legacy roots both containing unjournaled state failing closed;
- injected verification failure deleting staging and leaving the legacy root
  authoritative;
- injected post-activation update failure removing the candidate MetaWork root
  and preserving the legacy root;
- successful update archiving the old root under a timestamped
  `.anyfusion.migrated-*` path;
- replay after a prepared/activated migration journal completing
  deterministically.

**Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run tests/installation/product-root-migrator.test.ts \
  tests/installation/native-install-cli.test.ts \
  tests/installation/source-native-updater.test.ts
```

Expected: FAIL because the product-root transaction does not exist.

**Step 3: Implement the offline migration transaction**

The migrator must:

- run only for default roots, never explicit overrides;
- use the legacy root's physical `data/runtime.lock`;
- copy into a sibling staging root while excluding ephemeral lock/socket files;
- collect and verify a bounded tree manifest with file hashes and symlink
  targets;
- write a migration journal outside both roots;
- atomically rename staging to `~/.metawork`;
- expose `commit()` and `rollback()` so the native update transaction decides
  final authority;
- rename the legacy root to an archive only after the update commits;
- remove the candidate root on rollback and leave the legacy root untouched.

Do not reuse `AccountLayoutMigrator` as a second root authority. Shared manifest
utilities may be extracted only if both migrators preserve their existing
behavior and tests.

**Step 4: Integrate with native update**

Before resolving account paths for an update:

1. resolve canonical and compatibility defaults;
2. prepare the root migration if only the default legacy root exists;
3. run the existing updater against the candidate MetaWork root;
4. commit the root migration only after updater success;
5. roll it back on any error.

Clean install continues directly under `~/.metawork`. Explicit
`ANYFUSION_INSTALL_ROOT` continues using that root without automatic movement.

**Step 5: Run focused tests**

Run:

```bash
npx vitest run tests/installation/product-root-migrator.test.ts \
  tests/installation/native-install-cli.test.ts \
  tests/installation/source-native-updater.test.ts \
  tests/installation/account-layout-migrator.test.ts \
  tests/installation/runtime-update-lock.test.ts
npm run lint
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/installation/product-root-migrator.ts \
  src/install-cli.ts src/installation/source-native-updater.ts \
  tests/installation/product-root-migrator.test.ts \
  tests/installation/native-install-cli.test.ts \
  tests/installation/source-native-updater.test.ts
git commit -m "feat: migrate legacy AnyFusion install roots safely"
```

### Task 6: Cut Production Composition Over To Canonical Paths

**Files:**

- Modify: `src/index.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/planning/planner-mcp-server.ts`
- Modify: `src/executor/codex-cli-driver.ts`
- Modify: `src/executor/pi-cli-driver.ts`
- Modify: `src/storage/file-web-session-store.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/installation/doctor.ts`
- Modify: applicable focused tests under `tests/planning/`, `tests/executor/`,
  `tests/storage/`, and `tests/installation/`

**Step 1: Add an architecture regression test**

Create or extend an architecture test to assert production modules import
`resolveMetaWorkPaths`, while `resolveAnyFusionPaths` is referenced only by
compatibility tests/adapters.

**Step 2: Run the architecture test and verify failure**

Run:

```bash
npx vitest run tests/architecture/configuration-authority-cutover.test.ts
```

Expected: FAIL while production callers still use the compatibility API.

**Step 3: Migrate production callers**

Change imports and local variable names only. Do not rename:

- `AnyFusionPlanningAgent`;
- `AnyFusionConfigurationV2`;
- `AnyFusionPlannerHostProtocol`;
- `anyfusion-planner` Harness/AgentClass IDs;
- `anyfusion.db`;
- `file-secret:anyfusion/...`;
- AnyFusion-Pi paths, environment settings, or protocol source IDs.

Those names identify components or persisted contracts.

**Step 4: Run focused and architecture tests**

Run:

```bash
npx vitest run tests/architecture/configuration-authority-cutover.test.ts \
  tests/planning/planner-process-supervisor.test.ts \
  tests/executor/codex-cli-driver.test.ts \
  tests/executor/pi-cli-driver.test.ts \
  tests/storage/file-web-session-store.test.ts \
  tests/installation/doctor.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.ts src/planning/planner-process-supervisor.ts \
  src/planning/planner-mcp-server.ts src/executor/codex-cli-driver.ts \
  src/executor/pi-cli-driver.ts src/storage/file-web-session-store.ts \
  src/session/metaclaw-session.ts src/installation/doctor.ts \
  tests/architecture/configuration-authority-cutover.test.ts \
  tests/planning/planner-process-supervisor.test.ts \
  tests/executor/codex-cli-driver.test.ts \
  tests/executor/pi-cli-driver.test.ts \
  tests/storage/file-web-session-store.test.ts \
  tests/installation/doctor.test.ts
git commit -m "refactor: use MetaWork paths in production composition"
```

### Task 7: Update Current Product Presentation And Preserve Component Names

**Files:**

- Modify: `AGENTS.md`
- Modify: `CONTEXT.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/README.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `docs/current/phase-5-runtime-security.md`
- Modify: `src/index.ts`
- Modify: `src/management/lock.ts`
- Modify: `src/management/token.ts`
- Modify: `src/management/server.ts`
- Modify: `src/session/conversation-session.ts`
- Modify: `src/account/account-startup-recovery-service.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/configuration/public-routing-identity.ts`
- Modify: `web/src/components/TokenGate.tsx`
- Modify: `web/src/theme.ts`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Modify: related focused tests
- Create: `tests/architecture/public-product-identity.test.ts`
- Create: `tests/configuration/public-routing-identity.test.ts`

**Step 1: Add a failing public-identity audit**

The test should scan current authorities and public surfaces. It must reject
unqualified AnyFusion product claims but allow:

- `AnyFusion-Pi`;
- `AnyFusionPlanningAgent` and `AnyFusionConfigurationV2`;
- protocol, Harness, secret reference, database, media type, and fixture IDs;
- compatibility sections;
- historical release/archive links.

Assert current README and help surfaces contain MetaWork, describe AnyFusion as
an open-source component/upstream where mentioned, and do not claim MetaWork is
Apache-licensed or an open-source initiative.

**Step 2: Run the audit and verify failure**

Run:

```bash
npx vitest run tests/architecture/public-product-identity.test.ts \
  tests/management/token.test.ts tests/web/theme.test.ts
```

Expected: FAIL on current AnyFusion product framing.

**Step 3: Update public and operational presentation**

Apply these rules:

- MetaWork is the product and commercial service system;
- AnyFusion is referenced only as an open-source upstream/component;
- `AnyFusion-Pi` remains the Planner component name;
- current examples use `metawork` and `METAWORK_*`;
- compatibility sections document `anyfusion`, `metaclaw`, `~/.anyfusion`, and
  `ANYFUSION_*`;
- historical `docs/releases/v1.2.0-preview.0.md` remains unchanged;
- archived plans remain unchanged;
- README license sections state that MetaWork is proprietary and that
  third-party/open-source components retain their own notices;
- do not alter root `LICENSE` until company-approved proprietary terms are
  supplied.

Change Web theme persistence to `metawork.theme`, reading and migrating
`anyfusion.theme` once before deleting the compatibility key. Do not rename
HTTP cookies or durable Web session files in this task.

Update public routing display from `AnyFusion Planner` to
`MetaWork Planner (AnyFusion-Pi)` without changing its Harness ID.

**Step 4: Build Web and run presentation tests**

Run:

```bash
npm --prefix web install --package-lock-only
npm --prefix web run build
npx vitest run tests/architecture/public-product-identity.test.ts \
  tests/management/token.test.ts tests/web/theme.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/configuration/public-routing-identity.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add AGENTS.md CONTEXT.md README.md README.zh-CN.md CHANGELOG.md \
  docs/README.md docs/current src web/package.json web/package-lock.json \
  web/src tests/architecture/public-product-identity.test.ts \
  tests/management/token.test.ts tests/web/theme.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/configuration/public-routing-identity.test.ts
git commit -m "docs: present MetaWork as the canonical product"
```

### Task 8: Update Scripts, Smokes, And Compatibility Documentation

**Files:**

- Create: `metawork.sh`
- Modify: `anyfusion.sh`
- Modify: `metaclaw.sh`
- Modify: `scripts/smoke-metaclaw-real-task.mjs`
- Modify: `scripts/smoke-unified-gateway.mjs`
- Modify: `scripts/bootstrap-install.sh`
- Modify: `package.json`
- Modify: related script tests

**Step 1: Add failing wrapper and smoke tests**

Assert:

- `metawork.sh` is the canonical wrapper;
- `anyfusion.sh` and `metaclaw.sh` delegate without changing arguments;
- smoke help promotes `METAWORK_CONFIG_HOME` and `METAWORK_INSTALL_ROOT`;
- old variables remain accepted with conflict checks;
- AnyFusion-Pi smoke assertions retain the component name;
- package scripts expose `smoke:metawork`, while `smoke:anyfusion` and
  `smoke:metaclaw` remain aliases.

**Step 2: Run focused script tests and verify failure**

Run:

```bash
npx vitest run tests/scripts/smoke-metaclaw-real-task.test.ts \
  tests/scripts/smoke-unified-gateway.test.ts \
  tests/scripts/bootstrap-install-trust.test.ts
```

Expected: FAIL on canonical wrapper and environment help.

**Step 3: Implement wrapper and smoke compatibility**

Keep the existing underlying smoke scenario logic. Rename only public help,
default product paths, and package script entry points. Component-specific
AnyFusion-Pi assertions remain unchanged.

**Step 4: Run tests and shell syntax checks**

Run:

```bash
bash -n setup.sh metawork.sh anyfusion.sh metaclaw.sh \
  scripts/bootstrap-install.sh
npx vitest run tests/scripts/smoke-metaclaw-real-task.test.ts \
  tests/scripts/smoke-unified-gateway.test.ts \
  tests/scripts/bootstrap-install-trust.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add metawork.sh anyfusion.sh metaclaw.sh scripts package.json \
  package-lock.json tests/scripts
git commit -m "chore: make MetaWork the canonical runtime facade"
```

### Task 9: Run Full Validation And Close The Plan

**Files:**

- Modify: `docs/plans/2026-08-26-metawork-product-identity-migration.md`
- Modify: `docs/plans/2026-08-26-metawork-product-identity-migration-design.md`

**Step 1: Run static and build gates**

Run:

```bash
git diff --check
npm run lint
npm run build
npm --prefix web run build
```

Expected: PASS.

**Step 2: Run focused migration and compatibility suites**

Run:

```bash
npx vitest run tests/installation/product-environment.test.ts \
  tests/installation/paths.test.ts \
  tests/installation/native-launcher.test.ts \
  tests/installation/native-install-cli.test.ts \
  tests/installation/product-root-migrator.test.ts \
  tests/installation/source-native-installer.test.ts \
  tests/installation/source-native-updater.test.ts \
  tests/installation/account-layout-migrator.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/architecture/public-product-identity.test.ts \
  tests/management/token.test.ts tests/web/theme.test.ts
```

Expected: PASS.

**Step 3: Run the full repository suite**

Run:

```bash
npm test
```

Expected: PASS on native macOS. If any SQLite/POSIX-only failure is
environment-specific, run the required Docker gate:

```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

Expected: PASS.

**Step 4: Run smoke gates when provider credentials are available**

Run:

```bash
npm run smoke:metawork
npm run smoke:gateway
```

Expected: the native Planner session and Gateway smoke pass using the same
MetaWork root, while AnyFusion-Pi remains the persisted Planner component.

**Step 5: Audit naming boundaries**

Run:

```bash
rg -n "AnyFusion is the public product|AnyFusion 是公开产品名|# AnyFusion$|Why AnyFusion|为什么用 AnyFusion" \
  AGENTS.md CONTEXT.md README.md README.zh-CN.md docs/current docs/README.md
rg -n "AnyFusion-Pi|AnyFusionPlanningAgent|AnyFusionConfigurationV2|anyfusion-planner|anyfusion\\.db|file-secret:anyfusion" \
  src tests docs/current
```

Expected:

- the first command returns no stale current-product claims;
- the second command returns retained component and compatibility identifiers.

**Step 6: Record completion**

Add:

- completion date;
- delivered behavior;
- exact validation results;
- any deferred proprietary-license-text dependency;
- closing commit.

**Step 7: Commit**

```bash
git add docs/plans/2026-08-26-metawork-product-identity-migration.md \
  docs/plans/2026-08-26-metawork-product-identity-migration-design.md
git commit -m "docs: close MetaWork identity migration"
```

## Completion Record

Delivered behavior:

- MetaWork is the canonical package, CLI, native launcher, public product
  identity, documentation identity, Web identity, theme namespace, fresh-install
  root, and public environment-variable namespace.
- `anyfusion` and `metaclaw` remain compatibility CLI aliases. Existing
  `ANYFUSION_*` product settings remain fail-closed aliases for their
  `METAWORK_*` equivalents.
- Legacy `~/.anyfusion` state migrates transactionally into `~/.metawork`
  without steady-state dual reads or writes. Runtime locks, staged verification,
  rollback, archival, account data, SQLite/WAL state, releases, and managed
  launchers remain covered by focused tests.
- `AnyFusion-Pi`, `AnyFusionPlanningAgent`, `AnyFusionConfigurationV2`,
  `anyfusion-planner-host-v2`, `anyfusion.db`, `file-secret:anyfusion/...`, and
  component-specific `ANYFUSION_PI_*`/`ANYFUSION_PLANNER_*` names remain intact.
- Public Planner presentation is `MetaWork Planner (AnyFusion-Pi)` while the
  persisted Harness ID remains unchanged.
- Web theme storage now uses `metawork.theme`; a valid or invalid legacy
  `anyfusion.theme` value is consumed once, normalized, and removed.
- The private root package uses `UNLICENSED`. The root `LICENSE` file was not
  replaced because company-approved proprietary terms were not supplied;
  current docs state that it does not license MetaWork as a whole and preserve
  third-party/open-source attribution obligations.

Validation completed on 2026-08-26:

- `git diff --check`, `npm run lint`, `npm run build`, Web package-lock
  regeneration, and `npm --prefix web run build` passed.
- Shell syntax validation passed for `setup.sh`, `metawork.sh`,
  `anyfusion.sh`, `metaclaw.sh`, and `scripts/bootstrap-install.sh`.
- The migration/compatibility focused suite passed: 16 files, 95 tests.
- The final full repository suite passed: 339 files and 1,589 tests passed;
  7 files and 18 environment-gated tests were skipped by their existing
  conditions.
- `npm run smoke:gateway` passed: 7 files, 33 tests, using an isolated
  MetaWork root.
- The stale-product-claim audit returned no matches, while the retained
  component/compatibility audit returned the expected AnyFusion identifiers.
- `npm run smoke:metawork` was not run because this host does not have the
  required native MetaWork Provider configuration installed under
  `METAWORK_CONFIG_HOME`; no credentials were added or synthesized.

Implementation commits:

- `17da8e7 feat: resolve MetaWork environment compatibility`
- `04a56d8 feat: add canonical MetaWork installation paths`
- `4033f28 feat: add MetaWork CLI with compatibility aliases`
- `9ffa982 feat: accept canonical MetaWork installer settings`
- `a3d01c1 feat: migrate legacy AnyFusion install roots safely`
- `0125950 refactor: use MetaWork paths in production composition`
- `61f0cc6 docs: present MetaWork as the canonical product`
- `e6f5cf7 chore: make MetaWork the canonical runtime facade`
- Closing commit: `docs: close MetaWork identity migration` (this document
  update).
