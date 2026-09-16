# Web Settings Model And Agent Readiness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> **Status:** Complete
> **Completed:** 2026-09-16

**Goal:** Replace implementation-oriented Web settings with a model-and-agent experience, store Provider API Keys in one editable MetaWork-root file, and block new work only when the required Pi agent is unavailable.

**Architecture:** Extend the existing revisioned configuration with optional display names, keep stable Provider and AgentClass IDs for routing, and replace production Keychain/file-secret selection with one `CredentialsFileSecretStore` at `<metawork-root>/credentials.json`. Add an Application-Shell `AgentInstallationReadinessService`, project it through Management HTTP/WebSocket, and inject one read-only new-work admission check into the unified `ClientGateway`; Kernel health, routing, execution, recovery, and running Tasks remain unchanged.

**Tech Stack:** Node.js 22.19+, TypeScript ESM, Zod, React 18, Vitest, existing Management HTTP/WebSocket and Gateway v2 contracts.

---

## Execution Notes

- Execute in a dedicated worktree created from commit `2ec5c8c`.
- Do not copy or revert the unrelated Workspace UI changes currently present in
  the original working tree.
- Follow TDD for every behavior change: add the focused failing test, run it,
  implement the minimum behavior, rerun the focused test, then commit.
- Do not introduce `~/.config/metawork` as a new persistence root.
- The credential path is `resolveMetaWorkPaths().credentials`, defaulting to
  `~/.metawork/credentials.json` and following the existing install-root
  override.
- Do not add a second router, scheduler, Executor health model, or recovery
  policy.
- Do not run a paid Provider smoke without explicit user approval.

### Task 1: Add Revision-Scoped User Display Names

**Files:**
- Create: `src/configuration/user-facing-names.ts`
- Modify: `src/configuration/schema.ts:60-210`
- Modify: `src/configuration/types.ts:10-170`
- Modify: `src/configuration/staged-legacy-configuration.ts:80-190`
- Modify: `src/configuration/legacy-configuration-reader.ts:315-440`
- Modify: `src/configuration/configuration-completion-service.ts:1-180`
- Modify: `src/configuration/public-routing-identity.ts:1-110`
- Test: `tests/configuration/schema.test.ts`
- Test: `tests/configuration/configuration-completion-service.test.ts`
- Test: `tests/configuration/public-routing-identity.test.ts`

**Step 1: Write the failing schema and fallback-name tests**

Add tests proving:

```ts
const parsed = AnyFusionConfigurationV2Schema.parse({
  ...completeConfiguration(),
  providers: {
    openai: {
      ...completeConfiguration().providers.openai,
      displayName: '我的 OpenAI',
    },
  },
  agentClasses: {
    ...completeConfiguration().agentClasses,
    'codex-engineering': {
      ...completeConfiguration().agentClasses['codex-engineering'],
      displayName: '代码助手',
    },
  },
});

expect(parsed.providers.openai.displayName).toBe('我的 OpenAI');
expect(parsed.agentClasses['codex-engineering'].displayName).toBe('代码助手');
```

Also test:

- whitespace-only display names are rejected when present;
- names over 80 characters are rejected;
- missing `pi-agent` resolves to `智能体 1`;
- missing `codex-cli` resolves to `智能体 2`;
- another missing AgentClass name uses the existing humanized fallback;
- configured Provider display names override public preset labels in completion
  and public routing identity.

**Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run \
  tests/configuration/schema.test.ts \
  tests/configuration/configuration-completion-service.test.ts \
  tests/configuration/public-routing-identity.test.ts
```

Expected: FAIL because the strict schemas reject `displayName` and no shared
fallback helper exists.

**Step 3: Implement the shared naming contract**

Add:

```ts
export const DEFAULT_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'pi-agent': '智能体 1',
  'codex-cli': '智能体 2',
};

export function resolveAgentDisplayName(
  agentClassRef: string,
  configured?: string,
): string {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  return DEFAULT_AGENT_DISPLAY_NAMES[agentClassRef]
    ?? humanizeConfigurationReference(agentClassRef);
}

export function resolveProviderDisplayName(
  providerRef: string,
  configured?: string,
  catalogLabel?: string,
): string {
  return configured?.trim()
    || catalogLabel?.trim()
    || humanizeConfigurationReference(providerRef);
}
```

Add `displayName?: string` to `ProviderDefinition` and
`AgentClassDefinition`, with `z.string().trim().min(1).max(80).optional()` in
both schemas. Seed `智能体 1` and `智能体 2` in newly staged built-in
configuration, but keep legacy documents valid when the field is absent.

Use the helper in completion and public routing identity. Do not change
`providerRef`, `agentClassRef`, Harness IDs, model policy, or authorization
bindings.

**Step 4: Run the focused tests and lint**

Run:

```bash
npx vitest run \
  tests/configuration/schema.test.ts \
  tests/configuration/configuration-completion-service.test.ts \
  tests/configuration/public-routing-identity.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/configuration/user-facing-names.ts \
  src/configuration/schema.ts \
  src/configuration/types.ts \
  src/configuration/staged-legacy-configuration.ts \
  src/configuration/legacy-configuration-reader.ts \
  src/configuration/configuration-completion-service.ts \
  src/configuration/public-routing-identity.ts \
  tests/configuration/schema.test.ts \
  tests/configuration/configuration-completion-service.test.ts \
  tests/configuration/public-routing-identity.test.ts
git commit -m "feat(config): add user display names"
```

### Task 2: Introduce The Single MetaWork Credentials File

**Files:**
- Create: `src/configuration/credentials-file-secret-store.ts`
- Modify: `src/configuration/secret-store.ts`
- Modify: `src/configuration/production-secret-store.ts`
- Modify: `src/configuration/index.ts`
- Modify: `src/installation/paths.ts`
- Test: `tests/configuration/credentials-file-secret-store.test.ts`
- Test: `tests/configuration/production-secret-store.test.ts`
- Test: `tests/installation/paths.test.ts`

**Step 1: Write failing path and store tests**

Test the path contract:

```ts
expect(resolveMetaWorkPaths('/Users/test').credentials)
  .toBe('/Users/test/.metawork/credentials.json');
expect(resolveMetaWorkPaths('/Users/test', '/opt/metawork').credentials)
  .toBe('/opt/metawork/credentials.json');
```

Test the file format and update behavior:

```ts
const store = new CredentialsFileSecretStore(join(root, 'credentials.json'));
await store.put('file-secret:anyfusion/providers/openai', 'sk-first');
await store.put('keychain:anyfusion/providers/deepseek', 'sk-second');

expect(JSON.parse(await readFile(join(root, 'credentials.json'), 'utf8'))).toEqual({
  version: 1,
  providers: {
    openai: 'sk-first',
    deepseek: 'sk-second',
  },
});
expect(await store.get('keychain:anyfusion/providers/openai')).toBe('sk-first');
```

Also test:

- a write replaces one Provider without losing other entries;
- a failed temporary-file rename leaves the original file intact;
- malformed JSON is reported and never overwritten;
- the file is mode `0600` where POSIX permissions are available;
- unsupported non-Provider references fail clearly;
- `delete()` removes only the addressed Provider.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run \
  tests/configuration/credentials-file-secret-store.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/installation/paths.test.ts
```

Expected: FAIL because `MetaWorkPaths.credentials` and
`CredentialsFileSecretStore` do not exist.

**Step 3: Implement the store**

Add `credentials: resolve(root, 'credentials.json')` to `MetaWorkPaths`.

Implement a Provider-only adapter behind the existing `SecretStore` interface:

```ts
interface CredentialsDocument {
  version: 1;
  providers: Record<string, string>;
}

export class CredentialsFileSecretStore implements SecretStore {
  constructor(readonly filePath: string) {}

  async get(reference: SecretReference): Promise<string> {
    const providerRef = providerRefFromSecretReference(reference);
    const document = await this.read();
    const value = document.providers[providerRef];
    if (!value) throw new Error(`provider credential is missing: ${providerRef}`);
    return value;
  }

  async put(reference: SecretReference, value: string): Promise<void> {
    const providerRef = providerRefFromSecretReference(reference);
    const current = await this.readOrEmpty();
    await this.writeAtomic({
      version: 1,
      providers: { ...current.providers, [providerRef]: value },
    });
  }
}
```

`providerRefFromSecretReference()` accepts existing
`file-secret:anyfusion/providers/<ref>` and
`keychain:anyfusion/providers/<ref>` references so active revisions do not need
rewriting solely for the storage cutover.

Replace production selection logic with one store:

```ts
export function createProductionSecretStore(input: {
  credentialsFile: string;
}): CredentialsFileSecretStore {
  return new CredentialsFileSecretStore(input.credentialsFile);
}
```

Do not keep platform- or environment-selected production stores after cutover.
Keep `FileSecretStore` and `KeychainSecretStore` only for the one-time import
implemented in Task 3 and for historical tests until the cutover is complete.

**Step 4: Run tests and lint**

Run:

```bash
npx vitest run \
  tests/configuration/credentials-file-secret-store.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/installation/paths.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/configuration/credentials-file-secret-store.ts \
  src/configuration/secret-store.ts \
  src/configuration/production-secret-store.ts \
  src/configuration/index.ts \
  src/installation/paths.ts \
  tests/configuration/credentials-file-secret-store.test.ts \
  tests/configuration/production-secret-store.test.ts \
  tests/installation/paths.test.ts
git commit -m "feat(config): add MetaWork credentials file"
```

### Task 3: Cut Runtime And Activation Over To The Credentials File

**Files:**
- Create: `src/configuration/legacy-provider-credential-import.ts`
- Modify: `src/server/server-composition.ts:420-540, 1460-1725`
- Modify: `src/install-cli.ts:80-120`
- Modify: `src/gateway/feishu-activation.ts:35-75`
- Modify: `src/configuration/configuration-runtime-coordinator.ts`
- Modify: `src/configuration/local-agent-credentials.ts`
- Test: `tests/configuration/legacy-provider-credential-import.test.ts`
- Test: `tests/configuration/configuration-runtime-coordinator.test.ts`
- Test: `tests/configuration/production-runtime-bindings.test.ts`

**Step 1: Write failing cutover tests**

Cover:

- when `<root>/credentials.json` exists, startup never reads Keychain or old
  secret files;
- when it is absent, the importer reads each active Provider reference once and
  atomically creates the new file;
- an unreadable legacy credential is skipped while readable Providers import;
- no permanent fallback occurs after the new file exists;
- configuration activation writes submitted Provider Keys to the new file;
- runtime Planner and Executor binding reads the same new store.

Use injected fake legacy stores rather than real macOS Keychain commands.

**Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run \
  tests/configuration/legacy-provider-credential-import.test.ts \
  tests/configuration/configuration-runtime-coordinator.test.ts \
  tests/configuration/production-runtime-bindings.test.ts
```

Expected: FAIL because composition still chooses FileSecretStore or Keychain.

**Step 3: Implement the one-time best-effort import**

Implement:

```ts
export async function importLegacyProviderCredentials(input: {
  target: CredentialsFileSecretStore;
  targetExists: boolean;
  providers: Record<string, ProviderDefinition>;
  legacyStoreFor(reference: SecretReference): SecretStore | null;
}): Promise<{ imported: string[]; missing: string[] }> {
  if (input.targetExists) return { imported: [], missing: [] };
  // Read every active reference first, then perform one atomic target write.
}
```

Rules:

- the existence of a valid `credentials.json` is the migration marker;
- do not create a migration database or long-lived dual-read adapter;
- malformed existing `credentials.json` fails startup/config access rather than
  being overwritten;
- old stores are never deleted automatically;
- a missing imported Key remains editable through Web.

Update Server, Admin CLI, installer, Feishu activation, configuration runtime,
completion, model discovery, and runtime bindings to receive the same
`CredentialsFileSecretStore` created from
`resolveMetaWorkPaths().credentials`.

Preserve existing `apiKeyRef` values. Do not rewrite historical revisions.

**Step 4: Run focused tests and lint**

Run:

```bash
npx vitest run \
  tests/configuration/legacy-provider-credential-import.test.ts \
  tests/configuration/configuration-runtime-coordinator.test.ts \
  tests/configuration/production-runtime-bindings.test.ts \
  tests/configuration/runtime-private-binding-resolver.test.ts \
  tests/configuration/planner-runtime-environment.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/configuration/legacy-provider-credential-import.ts \
  src/server/server-composition.ts \
  src/install-cli.ts \
  src/gateway/feishu-activation.ts \
  src/configuration/configuration-runtime-coordinator.ts \
  src/configuration/local-agent-credentials.ts \
  tests/configuration/legacy-provider-credential-import.test.ts \
  tests/configuration/configuration-runtime-coordinator.test.ts \
  tests/configuration/production-runtime-bindings.test.ts
git commit -m "refactor(config): cut credentials over to MetaWork file"
```

### Task 4: Simplify Credential Status And Update APIs

**Files:**
- Modify: `src/management/server.ts:100-150, 980-1025`
- Modify: `src/server/server-composition.ts:1660-1725`
- Modify: `web/src/api/http.ts:270-305`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/settings-model.ts`
- Modify: `web/src/components/provider-secret-state.ts`
- Test: `tests/management/server.test.ts`
- Test: `tests/web/provider-secret-state.test.ts`
- Test: `tests/web/settings-workbench.test.ts`

**Step 1: Write failing API tests**

Define one response shape:

```ts
export interface ProviderCredentialStatus {
  configured: boolean;
  maskedApiKey: string | null;
}
```

Test:

```ts
expect(await response.json()).toEqual({
  openai: {
    configured: true,
    maskedApiKey: '••••••••cdef',
  },
  missing: {
    configured: false,
    maskedApiKey: null,
  },
});
```

For update:

```ts
const body = await updateResponse.json();
expect(body).toEqual({
  configured: true,
  maskedApiKey: '••••••••cret',
});
expect(JSON.stringify(body)).not.toContain('sk-new-secret');
```

Also test invalid/unsafe Provider refs, blank Keys, unauthorized access, and a
failed write retaining the previous status.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run \
  tests/management/server.test.ts \
  tests/web/provider-secret-state.test.ts \
  tests/web/settings-workbench.test.ts
```

Expected: FAIL because status is currently `Record<string, boolean>` and write
returns `apiKeyRef`.

**Step 3: Implement masked summaries**

Use one helper:

```ts
export function maskApiKey(value: string): string {
  const suffix = value.slice(-4);
  return `••••••••${suffix}`;
}
```

Change:

- `ConfigQuery.getSecretStatus()` to return credential summaries;
- `ConfigQuery.writeSecret()` to return the updated summary;
- `GET /api/config/secrets/status` to return masks;
- `POST /api/config/secrets` to overwrite a Key and never echo plaintext;
- Web `HttpClient` and settings types to consume the new shape.

Keep Provider verification/model discovery separate from file-write success.
Do not make an unreachable Provider prevent the user from saving a Key.

**Step 4: Run focused tests and lint**

Run:

```bash
npx vitest run \
  tests/management/server.test.ts \
  tests/web/provider-secret-state.test.ts \
  tests/web/settings-workbench.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/management/server.ts \
  src/server/server-composition.ts \
  web/src/api/http.ts \
  web/src/api/types.ts \
  web/src/settings-model.ts \
  web/src/components/provider-secret-state.ts \
  tests/management/server.test.ts \
  tests/web/provider-secret-state.test.ts \
  tests/web/settings-workbench.test.ts
git commit -m "feat(web): expose masked credential updates"
```

### Task 5: Build Agent Installation Readiness

**Files:**
- Create: `src/management/agent-installation-readiness-service.ts`
- Create: `src/management/agent-installation-catalog.ts`
- Test: `tests/management/agent-installation-readiness-service.test.ts`

**Step 1: Write failing service tests**

Use an injected runner:

```ts
type VersionProbeRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<
  | { kind: 'exit'; code: number; stdout: string; stderr: string }
  | { kind: 'missing' }
  | { kind: 'timeout' }
  | { kind: 'error'; detail: string }
>;
```

Test:

- exit 0 produces `installed` and captures a bounded version;
- `ENOENT`/`missing` produces `missing`;
- timeout, non-zero exit, and launch errors produce `broken`;
- Pi is `required: true`;
- Codex is `required: false`;
- concurrent refresh calls invoke each command once;
- normal reads honor a 30-second TTL;
- forced refresh bypasses TTL;
- an older slow result cannot overwrite a newer result;
- diagnostics are redacted and bounded;
- display names come from an injected active-configuration resolver.

**Step 2: Run the test and verify failure**

Run:

```bash
npx vitest run tests/management/agent-installation-readiness-service.test.ts
```

Expected: FAIL because the service does not exist.

**Step 3: Implement the service**

Use:

```ts
export type AgentInstallStatus =
  | 'checking'
  | 'installed'
  | 'missing'
  | 'broken';

export interface AgentReadiness {
  agentId: 'pi-agent' | 'codex-cli';
  required: boolean;
  displayName: string;
  status: AgentInstallStatus;
  version: string | null;
  detail: string | null;
  installUrl: string;
  checkedAt: string;
}
```

Catalog entries:

```ts
{
  agentId: 'pi-agent',
  command: 'pi',
  args: ['--version'],
  required: true,
  installUrl: 'https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent',
}
{
  agentId: 'codex-cli',
  command: 'codex',
  args: ['--version'],
  required: false,
  installUrl: 'https://developers.openai.com/codex/cli/',
}
```

Before implementation, verify both links are still the maintained official
installation pages. Keep links in this catalog only.

The default runner must use `execFile`, `safeHostEnvironment()`, a bounded
timeout, and no shell.

Expose synchronous `getState()`, asynchronous `refresh({ force })`,
`subscribe()`, and:

```ts
isRequiredAgentReady(): boolean;
```

Do not mutate Kernel Executor health.

**Step 4: Run test and lint**

Run:

```bash
npx vitest run tests/management/agent-installation-readiness-service.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/management/agent-installation-readiness-service.ts \
  src/management/agent-installation-catalog.ts \
  tests/management/agent-installation-readiness-service.test.ts
git commit -m "feat(management): detect local agent readiness"
```

### Task 6: Project Readiness Through Management HTTP And WebSocket

**Files:**
- Modify: `src/management/server.ts:150-240, 285-365, 760-830`
- Modify: `src/management/web-session-runtime-types.ts`
- Modify: `src/server/server-composition.ts:220-270, 1180-1245`
- Modify: `web/src/api/types.ts:250-380`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/ws.ts`
- Test: `tests/management/server.test.ts`
- Test: `tests/web/gateway-contract-parity.test.ts`

**Step 1: Write failing transport tests**

Test authenticated:

```text
GET  /api/agents/readiness
POST /api/agents/readiness/refresh
```

Expected HTTP body:

```json
{
  "agents": [
    {
      "agentId": "pi-agent",
      "required": true,
      "displayName": "智能体 1",
      "status": "installed"
    }
  ]
}
```

Test:

- unauthenticated requests return 401;
- refresh calls `refresh({ force: true })`;
- a newly authenticated WebSocket receives the current readiness snapshot;
- a service state transition broadcasts
  `agent_readiness_state`;
- Web protocol types and `WsClient` have a corresponding handler.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run \
  tests/management/server.test.ts \
  tests/web/gateway-contract-parity.test.ts
```

Expected: FAIL because readiness is not a Management dependency or protocol
event.

**Step 3: Wire the service**

Extend `ManagementServerDeps` with:

```ts
agentReadiness: {
  getState(): readonly AgentReadiness[];
  refresh(input?: { force?: boolean }): Promise<readonly AgentReadiness[]>;
  subscribe(listener: (agents: readonly AgentReadiness[]) => void): () => void;
};
```

On `start()`:

- subscribe and broadcast `{ type: 'agent_readiness_state', agents }`;
- trigger one non-blocking forced refresh;
- unsubscribe during stop.

After WebSocket hello/replay, send the current readiness event.

Instantiate the service once in `server-composition.ts`, resolve current names
from the active configuration, and pass it to both Management and the Gateway
admission added in Task 7.

Add `HttpClient.getAgentReadiness()`,
`HttpClient.refreshAgentReadiness()`, Web API types, and a
`WsClient.onAgentReadinessState` handler.

**Step 4: Run tests and lint**

Run:

```bash
npx vitest run \
  tests/management/server.test.ts \
  tests/web/gateway-contract-parity.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/management/server.ts \
  src/management/web-session-runtime-types.ts \
  src/server/server-composition.ts \
  web/src/api/types.ts \
  web/src/api/http.ts \
  web/src/api/ws.ts \
  tests/management/server.test.ts \
  tests/web/gateway-contract-parity.test.ts
git commit -m "feat(web): project agent readiness"
```

### Task 7: Enforce Required-Agent Admission In The Unified Gateway

**Files:**
- Modify: `src/gateway/client-gateway.ts:30-210`
- Modify: `src/gateway/protocol.ts`
- Modify: `src/gateway/server.ts:320-405`
- Modify: `src/management/web-gateway-session-runtime.ts:80-210`
- Modify: `src/management/web-session-runtime-types.ts`
- Modify: `src/management/server.ts:320-355, 675-705`
- Modify: `src/server/server-composition.ts:1170-1235`
- Modify: `web/src/api/types.ts`
- Test: `tests/gateway/client-gateway.test.ts`
- Test: `tests/gateway/server-lifecycle.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`
- Test: `tests/management/server.test.ts`

**Step 1: Write failing admission tests**

Inject:

```ts
newWorkAdmission: {
  check(command) {
    return command.kind === 'user_message' || command.kind === 'create_conversation'
      ? { allowed: false as const, reason: 'required_agent_unavailable', agentId: 'pi-agent' }
      : { allowed: true as const };
  },
}
```

Test:

- `user_message` is rejected before Conversation resolution and mailbox
  submission;
- `create_conversation` is rejected before Workspace mutation;
- slash commands, Workspace selection, history reads, and attach remain
  allowed;
- Codex absence does not affect admission;
- the rejected reason is `required_agent_unavailable` with `pi-agent`;
- no durable command reservation remains for the rejected input;
- after readiness becomes installed, a retry with the same client-generated
  request can proceed;
- existing/running Task callbacks are untouched.

**Step 2: Run focused tests and verify failure**

Run:

```bash
npx vitest run \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/server-lifecycle.test.ts \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/management/server.test.ts
```

Expected: FAIL because Gateway has no environment-readiness admission.

**Step 3: Add one pre-reservation admission check**

Add:

```ts
export type NewWorkAdmissionResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'required_agent_unavailable';
      agentId: 'pi-agent';
    };
```

Run the check after authentication/account resolution and before command-store
reservation. Apply it only to `user_message` and `create_conversation`.

Return a rejected receipt with:

```ts
{
  status: 'rejected',
  reason: 'required_agent_unavailable',
  agentId: 'pi-agent',
}
```

Extend the relevant receipt/error projections additively so Web, TUI, and
Feishu retain the structured code. For the Web HTTP create-Conversation route,
map this result to HTTP 409:

```json
{
  "code": "required_agent_unavailable",
  "agentId": "pi-agent"
}
```

For WebSocket input, include `code`, `agentId`, and the client request ID in the
error event. Do not turn the result into a Kernel failure.

**Step 4: Run focused tests and lint**

Run:

```bash
npx vitest run \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/server-lifecycle.test.ts \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/management/server.test.ts
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  src/gateway/client-gateway.ts \
  src/gateway/protocol.ts \
  src/gateway/server.ts \
  src/management/web-gateway-session-runtime.ts \
  src/management/web-session-runtime-types.ts \
  src/management/server.ts \
  src/server/server-composition.ts \
  web/src/api/types.ts \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/server-lifecycle.test.ts \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/management/server.test.ts
git commit -m "feat(gateway): require Pi for new work"
```

### Task 8: Add Web Readiness State, Blocking, And Draft Recovery

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/components/WorkspaceShell.tsx`
- Modify: `web/src/components/SessionSidebar.tsx`
- Modify: `web/src/components/Composer.tsx`
- Create: `web/src/components/AgentReadinessBanner.tsx`
- Test: `tests/web/agent-readiness.test.ts`
- Test: `tests/web/workspace-shell.test.ts`
- Test: `tests/web/composer-ime.test.ts`

**Step 1: Write failing Web-state tests**

Extract pure helpers where possible and test:

```ts
expect(requiredAgentBlock(readiness)).toEqual({
  blocked: true,
  message: '需要先安装智能体 1 才能开始新工作。',
});
```

Source/contract tests must prove:

- new Conversation controls are disabled while Pi is missing/broken/checking;
- existing Conversation/history selection stays enabled;
- the composer shows the required-agent explanation;
- Settings remains accessible;
- WebSocket readiness updates remove the block immediately;
- `window.focus` triggers one forced refresh after an install page was opened;
- Codex missing does not disable any work action;
- a Server rejection restores the exact submitted draft and attachments.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run \
  tests/web/agent-readiness.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/web/composer-ime.test.ts
```

Expected: FAIL because App has no readiness state or request-correlated draft
recovery.

**Step 3: Implement global readiness state**

In `App.tsx`:

- fetch readiness after authentication;
- consume `agent_readiness_state`;
- derive a Pi block;
- pass the block to new-Conversation actions and Composer;
- render `AgentReadinessBanner` with an action that opens Settings at the agent
  section;
- preserve history, Workspace selection, and Settings.

Extend the WebSocket input message with a client request ID:

```ts
{ type: 'input'; requestId: string; text: string; attachments?: ... }
```

Have `WsClient.sendInput()` return the request ID. Keep the submitted draft and
attachment metadata in a pending map until `turn_started` acknowledges that
request. If the Server returns `required_agent_unavailable` for that request,
restore the exact draft and attachments.

Do not restore a draft for unrelated transport errors or an already
acknowledged turn.

**Step 4: Run tests, build Web, and lint**

Run:

```bash
npx vitest run \
  tests/web/agent-readiness.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/web/composer-ime.test.ts
npm run build:web
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  web/src/App.tsx \
  web/src/api/ws.ts \
  web/src/api/types.ts \
  web/src/components/WorkspaceShell.tsx \
  web/src/components/SessionSidebar.tsx \
  web/src/components/Composer.tsx \
  web/src/components/AgentReadinessBanner.tsx \
  tests/web/agent-readiness.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/web/composer-ime.test.ts
git commit -m "feat(web): guide required agent setup"
```

### Task 9: Refactor Provider UI Into The Model List

**Files:**
- Create: `web/src/components/ModelConnectionDialog.tsx`
- Modify: `web/src/components/SettingsPanel.tsx:130-220, 330-1080, 1090-1400`
- Modify: `web/src/settings-model.ts`
- Modify: `web/src/components/provider-secret-state.ts`
- Modify: `web/src/styles.css:668-1065`
- Test: `tests/web/settings-workbench.test.ts`
- Test: `tests/web/provider-secret-state.test.ts`

**Step 1: Write failing model-list tests**

Tests must require:

- the first settings heading is `模型列表`;
- ordinary copy does not contain `Provider`, `SecretStore`, `apiKeyRef`, or
  `Customer Provider`;
- adding a model opens a dialog;
- name, API URL, and API Key are required on initial add;
- a generated stable Provider ref is hidden from the user;
- existing cards show configured `displayName`;
- every card exposes rename and API Key update;
- a configured Key shows the mask from the Server;
- blank Key input preserves the existing Key;
- discovery failure keeps the card and entered fields editable;
- model selection and model capability controls still work.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run \
  tests/web/settings-workbench.test.ts \
  tests/web/provider-secret-state.test.ts
```

Expected: FAIL because the page still renders Provider-first terminology and
adds `自定义 Provider` immediately.

**Step 3: Implement the model-list experience**

Replace `addProvider()` with a modal draft:

```ts
interface NewModelConnectionDraft {
  displayName: string;
  baseUrl: string;
  apiKey: string;
}
```

On confirmation:

1. trim and validate all three fields;
2. generate the stable internal Provider ref;
3. add the Provider draft with `displayName`;
4. call discovery with the entered URL/Key;
5. keep the draft even when discovery fails;
6. persist through the existing activation path.

When building candidate configuration, include:

```ts
providers[provider.providerRef] = {
  ...originalProvider,
  displayName: provider.displayName.trim(),
  protocol: originalProvider.protocol ?? 'openai-compatible',
  baseUrl: provider.baseUrl.trim(),
  apiKeyRef: resolvedInternalReference,
  region: originalProvider.region ?? 'international',
  enabled: provider.enabled !== false,
};
```

Cards show:

- editable name;
- API URL;
- `已配置 · ••••••••abcd` or `未配置`;
- replacement password input;
- discovered models;
- rediscover and delete actions.

Keep the internal TypeScript names if renaming them would add risk; only
ordinary UI terminology must change.

**Step 4: Run tests, Web build, and lint**

Run:

```bash
npx vitest run \
  tests/web/settings-workbench.test.ts \
  tests/web/provider-secret-state.test.ts
npm run build:web
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  web/src/components/ModelConnectionDialog.tsx \
  web/src/components/SettingsPanel.tsx \
  web/src/settings-model.ts \
  web/src/components/provider-secret-state.ts \
  web/src/styles.css \
  tests/web/settings-workbench.test.ts \
  tests/web/provider-secret-state.test.ts
git commit -m "feat(web): replace Provider UI with model list"
```

### Task 10: Refactor Agent Cards And Advanced Settings

**Files:**
- Modify: `web/src/components/SettingsPanel.tsx:230-330, 530-680, 1400-1580`
- Modify: `web/src/components/AgentClassConfig.tsx`
- Modify: `web/src/settings-model.ts`
- Modify: `web/src/styles.css:1066-1785`
- Test: `tests/web/settings-workbench.test.ts`
- Test: `tests/web/agent-readiness.test.ts`

**Step 1: Write failing agent and advanced-section tests**

Require:

- the second top-level heading is `智能体`;
- built-in fallback names are `智能体 1` and `智能体 2`;
- both names are editable;
- no ordinary card displays `Executor`, `AgentClass`, Harness, Pi Agent, Codex
  Engineering, or raw driver IDs;
- Fixed/Auto routing, model pools, capability configuration, and capability
  profiles remain inside each agent card;
- the third section is a closed `高级设置`;
- only Planner and concurrency/queue controls are inside it;
- Pi missing shows required-install copy and install/refresh actions;
- Codex missing shows the approved optional benefit copy;
- Codex missing does not imply Pi lacks coding ability.

**Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run \
  tests/web/settings-workbench.test.ts \
  tests/web/agent-readiness.test.ts
```

Expected: FAIL because Planner and runtime policy are top-level, names are
technical, and readiness is not rendered in agent cards.

**Step 3: Implement the final information architecture**

Extend routing drafts/facts with `displayName`. Persist AgentClass names in
`buildCandidateConfiguration()`:

```ts
agentClasses[ref] = {
  ...current,
  displayName: entry.displayName.trim(),
  // existing modelPolicy, manual, and capability fields remain unchanged
};
```

Render:

```tsx
<section aria-labelledby="models-heading">...</section>
<section aria-labelledby="agents-heading">...</section>
<details className="advanced-settings">
  <summary>高级设置</summary>
  <PlannerConfiguration ... />
  <RuntimePolicyConfiguration ... />
</details>
```

For Pi missing:

```text
未安装 · MetaWork 运行新任务所必需
```

For Codex missing, include:

```text
推荐安装智能体 2（Codex）
- 对 OpenAI GPT/Codex 系列模型提供更完整的原生兼容
- 更适合代码理解、修改、测试和仓库级工程任务
- 增加一个可选智能体，让路由、任务分配和故障回退更灵活

Codex 是可选增强项。未安装不会影响 MetaWork 使用，智能体 1
仍可通过模型和能力配置完成代码、研究等任务。
```

Buttons:

- Pi: `打开安装页面`, `重新检测`;
- Codex: `查看安装说明`, `重新检测`.

Opening an install page records a local “refresh on next focus” flag. Do not run
an install command.

**Step 4: Run tests, Web build, and lint**

Run:

```bash
npx vitest run \
  tests/web/settings-workbench.test.ts \
  tests/web/agent-readiness.test.ts
npm run build:web
npm run lint
```

Expected: PASS.

**Step 5: Commit**

```bash
git add \
  web/src/components/SettingsPanel.tsx \
  web/src/components/AgentClassConfig.tsx \
  web/src/settings-model.ts \
  web/src/styles.css \
  tests/web/settings-workbench.test.ts \
  tests/web/agent-readiness.test.ts
git commit -m "feat(web): present user-owned agents and advanced settings"
```

### Task 11: Perform Visual And Browser Acceptance

**Files:**
- Modify: `web/src/styles.css`
- Modify: `tests/e2e/web-routing-identity-and-theme.test.ts`
- Modify: `tests/e2e/workspace-conversation-directory-browser.test.ts` only if
  readiness blocking changes the test fixture setup

**Step 1: Add failing browser assertions**

Use the existing authenticated Web E2E harness and assert:

- desktop and mobile settings layouts do not overflow;
- section order is 模型列表 → 智能体 → 高级设置;
- model-add dialog is keyboard reachable and visually distinct;
- long model names and masked Keys do not break card layout;
- advanced settings starts closed;
- Pi-required banner disables new work but leaves Settings/history reachable;
- Codex optional card remains actionable without blocking;
- successful refresh removes the block without reload.

**Step 2: Run the focused E2E and capture the baseline failure**

Run:

```bash
npx vitest run \
  tests/e2e/web-routing-identity-and-theme.test.ts \
  tests/e2e/workspace-conversation-directory-browser.test.ts
```

Expected: FAIL on the new settings/readiness assertions.

**Step 3: Apply the visual pass**

Use `@frontend-design` for the visual pass after behavior is green.

Requirements:

- preserve the current MetaWork visual language and theme tokens;
- replace the unattractive generic add control with a deliberate labeled
  action;
- use a clear card hierarchy for name, connection state, models, and actions;
- make required Pi status visually stronger than optional Codex status;
- avoid dense internal diagnostic copy in the default view;
- keep mobile controls at least 40px high and prevent horizontal scrolling;
- use only meaningful transitions for dialog and advanced-section expansion.

Do not redesign unrelated Workspace, Conversation, or execution panels.

**Step 4: Run browser, build, and lint validation**

Run:

```bash
npx vitest run \
  tests/e2e/web-routing-identity-and-theme.test.ts \
  tests/e2e/workspace-conversation-directory-browser.test.ts
npm run build:web
npm run lint
```

Expected: PASS. If an existing E2E baseline failure remains, reproduce it on
the base commit and record it rather than weakening the new assertions.

**Step 5: Commit**

```bash
git add \
  web/src/styles.css \
  tests/e2e/web-routing-identity-and-theme.test.ts \
  tests/e2e/workspace-conversation-directory-browser.test.ts
git commit -m "test(web): cover settings and readiness experience"
```

### Task 12: Update Architecture Documentation And Close Validation

**Files:**
- Modify: `docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md`
- Modify: `CONTEXT.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/README.md`
- Modify: `docs/plans/2026-09-16-web-settings-model-agent-readiness-design.md`
- Modify: `docs/plans/2026-09-16-web-settings-model-agent-readiness.md`

**Step 1: Update the authoritative contracts**

Record:

- optional revision-scoped Provider/AgentClass `displayName`;
- user-facing 模型列表/智能体 terminology versus stable internal IDs;
- `<metawork-root>/credentials.json` as the sole production Provider-Key
  authority;
- no `~/.config/metawork` persistence root for this feature;
- Pi required and Codex optional installation readiness;
- readiness as Application-Shell admission, not Kernel health;
- Web/TUI/Feishu unified new-work blocking;
- running Tasks remain unaffected.

Update the design and implementation plan headers with completion date,
delivered behavior, validation, and closing commit after all tests pass.

**Step 2: Run the complete focused regression set**

Run:

```bash
npx vitest run \
  tests/configuration/schema.test.ts \
  tests/configuration/credentials-file-secret-store.test.ts \
  tests/configuration/legacy-provider-credential-import.test.ts \
  tests/configuration/configuration-runtime-coordinator.test.ts \
  tests/configuration/production-runtime-bindings.test.ts \
  tests/configuration/runtime-private-binding-resolver.test.ts \
  tests/management/agent-installation-readiness-service.test.ts \
  tests/management/server.test.ts \
  tests/gateway/client-gateway.test.ts \
  tests/gateway/server-lifecycle.test.ts \
  tests/management/web-gateway-session-runtime.test.ts \
  tests/web/agent-readiness.test.ts \
  tests/web/provider-secret-state.test.ts \
  tests/web/settings-workbench.test.ts \
  tests/web/workspace-shell.test.ts \
  tests/web/composer-ime.test.ts
```

Expected: PASS.

**Step 3: Run repository validation**

Run:

```bash
npm run lint
npm run build
npm test
```

Expected: PASS. Do not repeatedly retry a platform-incompatible failure; follow
the repository Docker guidance and record the exact host limitation.

**Step 4: Perform native non-paid acceptance**

With an isolated install root:

1. start MetaWork with both `pi` and `codex` available and verify versions;
2. hide `codex` from `PATH`, refresh, and verify work remains enabled;
3. hide `pi` from `PATH`, refresh, and verify new Conversation and send are
   blocked across Web and local Gateway;
4. restore `pi`, refresh, and verify immediate recovery without restart;
5. update a Provider Key and inspect
   `<install-root>/credentials.json`;
6. confirm Web shows only the mask and no HTTP/WebSocket payload contains the
   raw Key;
7. rename both built-in agents and restart to verify persistence;
8. verify an already running Task is not cancelled by a later failed probe.

Do not call a paid model. Model discovery against a paid or rate-limited
Provider requires separate approval.

**Step 5: Commit documentation and closure**

```bash
git add \
  docs/adr/0033-hot-configuration-activation-and-auto-model-routing.md \
  CONTEXT.md \
  docs/current/technical-overview.md \
  docs/current/technical-overview.zh-CN.md \
  docs/README.md \
  docs/plans/2026-09-16-web-settings-model-agent-readiness-design.md \
  docs/plans/2026-09-16-web-settings-model-agent-readiness.md
git commit -m "docs: record settings and agent readiness delivery"
```

## Final Acceptance Checklist

- Settings has exactly 模型列表, 智能体, and collapsed 高级设置.
- Ordinary users never need Provider, Executor, AgentClass, Harness,
  SecretStore, or `apiKeyRef` terminology.
- Model and agent names are editable and persist in activated configuration.
- API Keys are editable, masked in Web, and stored only in
  `<metawork-root>/credentials.json`.
- No new `~/.config/metawork` persistence path is introduced.
- Pi absence blocks new work through the unified Server path.
- Codex absence explains installation benefits but never blocks work.
- Pi recovery takes effect after refresh without restart.
- Existing routing, capability profiles, history, running Tasks, and recovery
  behavior pass regression validation.

## Delivery Record

- Delivered user-facing `模型列表`, `智能体`, and collapsed `高级设置`
  sections without changing the Provider, AgentClass, Harness, routing, or
  execution interfaces.
- Added editable model and agent display names, model connection creation and
  rename flows, masked API Key status, API Key replacement, model discovery
  retry, and stable internal references.
- Added Pi/Codex installation readiness projection. Missing Pi blocks only new
  work; missing Codex is shown as an optional enhancement with GPT/Codex
  compatibility and coding benefits, without implying that Pi lacks coding
  capability.
- Made `<metawork-root>/credentials.json` the production Provider credential
  file, defaulting to `~/.metawork/credentials.json`; no
  `~/.config/metawork` persistence root is introduced by this feature.
- Validation completed: settings tests `27 passed`, Web tests `100 passed`,
  focused core regression `219 passed`, browser E2E `2 passed`, lint, Web
  build, and `git diff --check`. The full suite retains two unrelated baseline
  failures in production-composition and Planner supervisor path assertions.
