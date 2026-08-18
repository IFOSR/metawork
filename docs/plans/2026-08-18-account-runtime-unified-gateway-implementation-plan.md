# Account Runtime And Unified Gateway Implementation Plan

> Status: Planned
> Plan date: 2026-08-18
> Governing ADR: ADR-0031
> Approved design: `docs/plans/2026-08-18-account-runtime-unified-gateway-design.md`

**Goal:** Make TUI, Web, Feishu and future App clients use one versioned Gateway and share one account-scoped Runtime while preserving isolated conversation/Planner sessions.

**Architecture:** Introduce an account-isolated data root, `RuntimeRegistry`, one `AccountRuntime` and Kernel coordinator per loaded account, many serialized `ConversationSession` instances, and one transport-neutral Gateway command/event protocol. Migrate the existing installation into `local-default`, cut Web/Feishu/TUI over one surface at a time, then remove every direct client-to-Session path.

**Tech Stack:** Node 22.19+, strict TypeScript ESM, SQLite/better-sqlite3, Unix sockets, native HTTP/WebSocket, React/Vite, Feishu SDK, vendored AnyFusion-Pi, Vitest, existing native updater and smoke framework.

---

## Working Rules

- Read `CONTEXT.md`, ADR-0020, ADR-0031 and the approved design before each
  task.
- Use TDD. Each behavior begins with a focused failing test.
- Preserve `Planner -> ControlKernel -> Runtime -> ExecutorAdapter`.
- Keep ADR-0011 at one active top-level Task per AccountRuntime.
- Do not expose hidden chain-of-thought, raw prompts, credentials, raw tool
  payloads or unredacted stdout/stderr through Gateway.
- Do not add a shared-database multi-account compatibility path. Account stores
  are physically isolated.
- Do not leave dual-read, dual-write or permanent direct-Surface compatibility
  paths after cutover.
- Keep the current `local-default` behavior usable at the end of every phase.
- Commit each coherent task using Conventional Commit subjects.
- Run focused owner tests after every task and the complete suite at phase
  boundaries.

## Phase 1: Characterization And Contracts

### Task 1: Characterize Current Multi-Surface And Cross-Session Risks

**Files:**

- Create: `tests/architecture/current-client-runtime-topology.test.ts`
- Create: `tests/session/cross-session-kernel-drain.test.ts`
- Modify: `tests/gateway/server-lifecycle.test.ts`
- Modify: `tests/integrations/feishu-app.test.ts`
- Modify: `tests/management/web-session-runtime.test.ts`

**Step 1: Write the topology characterization test**

Assert the current behavior before refactoring:

```ts
it('documents current incompatible session cardinalities', () => {
  expect(currentTopology()).toEqual({
    gateway: 'per_connection_session',
    web: 'single_active_web_session',
    feishu: 'single_shared_session',
  });
});
```

The helper may initially be a test-local description. Its purpose is to make
the expected removal explicit, not to add production architecture.

**Step 2: Write the failing cross-session Kernel test**

Create two Session/workflow fixtures backed by one database. Enqueue an older
`plan_proposed` event for Session A, then submit Session B's event. Prove that
the current repository claim API cannot constrain the drain to the intended
owner.

Expected assertion after the eventual fix:

```ts
expect(runtimeA.appliedEventIds).toEqual(['event_a']);
expect(runtimeB.appliedEventIds).toEqual(['event_b']);
```

**Step 3: Run the characterization tests**

```bash
npx vitest run \
  tests/architecture/current-client-runtime-topology.test.ts \
  tests/session/cross-session-kernel-drain.test.ts \
  tests/gateway/server-lifecycle.test.ts \
  tests/integrations/feishu-app.test.ts \
  tests/management/web-session-runtime.test.ts
```

Expected: topology tests document the current state; the cross-session ownership
test FAILS.

**Step 4: Record the baseline without fixing it**

Add comments referencing ADR-0031 and leave the failing ownership test skipped
with a precise reason only until Task 6. Do not alter production behavior here.

**Step 5: Commit**

```bash
git add tests/architecture tests/session/cross-session-kernel-drain.test.ts \
  tests/gateway/server-lifecycle.test.ts tests/integrations/feishu-app.test.ts \
  tests/management/web-session-runtime.test.ts
git commit -m "test: characterize client runtime topology"
```

### Task 2: Define Account, Principal And Conversation Contracts

**Files:**

- Create: `src/account/types.ts`
- Create: `src/account/account-id.ts`
- Create: `src/session/conversation-types.ts`
- Create: `src/gateway/client-protocol.ts`
- Test: `tests/account/account-types.test.ts`
- Test: `tests/gateway/client-protocol.test.ts`

**Step 1: Write failing identity tests**

Cover:

- reserved `local-default` Account ID;
- bounded validated account and conversation IDs;
- Principal kinds for local, Web, Feishu and App;
- explicit distinction between Principal, Account and Conversation;
- refusal of path traversal and empty identifiers.

**Step 2: Write failing protocol tests**

Define schema/decoder tests for:

```ts
const command: GatewayCommandEnvelope = {
  protocolVersion: 1,
  requestId: 'req_1',
  idempotencyKey: 'idem_1',
  connectionId: 'conn_1',
  conversation: { mode: 'attach', conversationId: 'conv_1' },
  command: { kind: 'user_message', text: 'hello', attachments: [] },
  clientCapabilities: ['trace_v1'],
};
```

Assert that client payloads cannot set trusted `accountId` or Principal fields.

**Step 3: Run tests to verify failure**

```bash
npx vitest run tests/account/account-types.test.ts tests/gateway/client-protocol.test.ts
```

Expected: FAIL because the modules do not exist.

**Step 4: Implement minimal contracts**

Use strict discriminated unions and pure parse/validation functions. Keep these
files free of concrete repositories, sockets, HTTP, Planner, Kernel and
Executor imports.

**Step 5: Run tests**

Expect both files to PASS.

**Step 6: Commit**

```bash
git add src/account src/session/conversation-types.ts \
  src/gateway/client-protocol.ts tests/account tests/gateway/client-protocol.test.ts
git commit -m "feat: define account and gateway contracts"
```

### Task 3: Define Gateway Error, Receipt And Event Contracts

**Files:**

- Create: `src/gateway/client-events.ts`
- Create: `src/gateway/client-errors.ts`
- Create: `web/src/api/gateway-types.ts`
- Test: `tests/gateway/client-events.test.ts`
- Test: `tests/web/gateway-contract-parity.test.ts`

**Step 1: Write failing event tests**

Cover monotonic sequence, account/conversation/request identity, sanitized
payload limits, terminal event kinds and replay snapshots.

**Step 2: Write failing parity tests**

Assert the Web client union recognizes every server event kind and rejects
unknown protocol versions.

**Step 3: Run tests to verify failure**

```bash
npx vitest run tests/gateway/client-events.test.ts tests/web/gateway-contract-parity.test.ts
```

**Step 4: Implement the contracts**

Define:

- `GatewayCommandReceipt`;
- `GatewayEventEnvelope`;
- `GatewayReplay`;
- structured authentication, authorization, busy, conflict, unavailable and
  stale-cursor errors.

Do not duplicate `InteractionTrace` or `ExecutionTimeline`; reference their
sanitized projection types.

**Step 5: Run tests and commit**

```bash
npx vitest run tests/gateway/client-events.test.ts tests/web/gateway-contract-parity.test.ts
git add src/gateway/client-events.ts src/gateway/client-errors.ts \
  web/src/api/gateway-types.ts tests/gateway/client-events.test.ts \
  tests/web/gateway-contract-parity.test.ts
git commit -m "feat: define gateway event protocol"
```

## Phase 2: Account Storage And Migration

### Task 4: Add Account-Scoped Path Resolution

**Files:**

- Create: `src/account/account-paths.ts`
- Modify: `src/installation/paths.ts`
- Modify: `src/configuration/agent-runtime-renderer.ts`
- Test: `tests/account/account-paths.test.ts`
- Modify: `tests/installation/paths.test.ts`

**Step 1: Write failing path tests**

Use a temporary `ANYFUSION_INSTALL_ROOT` and assert:

```text
accounts/local-default/account.json
accounts/local-default/data/anyfusion.db
accounts/local-default/config/
accounts/local-default/secrets/
accounts/local-default/generated/
accounts/local-default/planner/sessions/
accounts/local-default/conversations/
accounts/local-default/workspace-store/
accounts/local-default/attempts/
accounts/local-default/gateway/
```

Assert account IDs cannot escape the account root.

**Step 2: Run tests to verify failure**

```bash
npx vitest run tests/account/account-paths.test.ts tests/installation/paths.test.ts
```

**Step 3: Implement account path resolution**

Keep release/application paths installation-global. Add an explicit
`resolveAccountPaths(accountId)` and stop adding new account-owned fields to the
global path object.

**Step 4: Run tests**

Expect PASS.

**Step 5: Commit**

```bash
git add src/account/account-paths.ts src/installation/paths.ts \
  src/configuration/agent-runtime-renderer.ts tests/account/account-paths.test.ts \
  tests/installation/paths.test.ts
git commit -m "feat: add account-scoped paths"
```

### Task 5: Migrate Existing State Into `local-default`

**Files:**

- Create: `src/installation/account-layout-migrator.ts`
- Create: `src/account/file-account-repository.ts`
- Modify: `src/installation/source-native-updater.ts`
- Modify: `src/installation/source-native-installer.ts`
- Modify: `src/installation/upgrade-journal.ts`
- Modify: `src/installation/doctor.ts`
- Test: `tests/installation/account-layout-migrator.test.ts`
- Modify: `tests/installation/source-native-updater.test.ts`
- Modify: `tests/installation/doctor.test.ts`

**Step 1: Write failing migration tests**

Cover:

- fresh install creates `local-default`;
- legacy database, Planner sessions, configuration, generated runtime,
  workspaces, attempts and Web sessions move into the account root;
- hashes and SQLite integrity are verified before pointer cutover;
- interrupted copy resumes or rolls back;
- existing Planner session filenames remain unchanged;
- no legacy and account path are both writable after activation;
- repeated migration is idempotent.

**Step 2: Run focused tests**

```bash
npx vitest run \
  tests/installation/account-layout-migrator.test.ts \
  tests/installation/source-native-updater.test.ts \
  tests/installation/doctor.test.ts
```

Expected: FAIL.

**Step 3: Implement the migration transaction**

Use ADR-0030 activation-journal rules:

1. stop/close ordinary Runtime admission;
2. verify legacy state;
3. stage the account directory;
4. verify database and file hashes;
5. atomically activate account metadata/pointers;
6. retain rollback metadata;
7. refuse ordinary startup on mixed layout.

No runtime dual-read fallback is permitted.

**Step 4: Add doctor diagnostics**

Doctor reports account metadata, active data root and legacy-path residue.

**Step 5: Run tests and commit**

```bash
npx vitest run \
  tests/installation/account-layout-migrator.test.ts \
  tests/installation/source-native-updater.test.ts \
  tests/installation/source-native-installer.test.ts \
  tests/installation/doctor.test.ts
git add src/account/file-account-repository.ts \
  src/installation/account-layout-migrator.ts src/installation \
  tests/installation
git commit -m "feat: migrate local state into default account"
```

## Phase 3: Account Runtime Ownership

### Task 6: Add The Single-Writer Account Kernel Coordinator

**Files:**

- Create: `src/account/account-kernel-coordinator.ts`
- Modify: `src/kernel/kernel-workflow.ts`
- Modify: `src/storage/kernel-workflow-repo.ts`
- Modify: `src/session/metaclaw-session.ts`
- Test: `tests/account/account-kernel-coordinator.test.ts`
- Modify: `tests/storage/kernel-workflow-repo.test.ts`
- Unskip and modify: `tests/session/cross-session-kernel-drain.test.ts`

**Step 1: Write failing coordinator tests**

Test:

- one coordinator serializes concurrent submissions;
- snapshot is built for the exact claimed event;
- application uses the exact event's account Runtime port;
- task-filtered drains cannot bypass the coordinator;
- duplicate event submission returns the existing decision/application;
- recovery and ordinary submission cannot run two drain loops.

**Step 2: Run tests to verify failure**

```bash
npx vitest run \
  tests/account/account-kernel-coordinator.test.ts \
  tests/storage/kernel-workflow-repo.test.ts \
  tests/session/cross-session-kernel-drain.test.ts
```

**Step 3: Implement the coordinator**

Expose one account-owned interface:

```ts
interface AccountKernelCoordinator {
  submit(event: KernelEvent): Promise<KernelWorkflowResult>;
  recover(): Promise<KernelRecoveryReport>;
}
```

`DurableKernelWorkflow` may remain the internal sequencing mechanism, but
per-conversation code cannot instantiate it. Ensure claim/application ownership
is one coordinator instance for the account.

**Step 4: Remove the static snapshot closure**

Every claimed event must call `buildSnapshot(claimedEvent)`. Remove the
`buildSnapshot: () => snapshot` pattern from top-level planning admission.

**Step 5: Run tests**

The previously skipped cross-session test must PASS.

**Step 6: Commit**

```bash
git add src/account/account-kernel-coordinator.ts src/kernel/kernel-workflow.ts \
  src/storage/kernel-workflow-repo.ts src/session/metaclaw-session.ts \
  tests/account/account-kernel-coordinator.test.ts \
  tests/storage/kernel-workflow-repo.test.ts \
  tests/session/cross-session-kernel-drain.test.ts
git commit -m "fix: centralize account kernel coordination"
```

### Task 7: Extract AccountRuntime Composition

**Files:**

- Create: `src/account/account-runtime.ts`
- Create: `src/account/account-runtime-factory.ts`
- Create: `src/account/account-runtime-ports.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/session/session-kernel-runtime.ts`
- Modify: `src/execution/kernel-execution-runtime.ts`
- Modify: `src/index.ts`
- Test: `tests/account/account-runtime.test.ts`
- Modify: `tests/core/session-extraction-services.test.ts`
- Modify: `tests/session/startup-running-reconciliation.test.ts`

**Step 1: Write the failing ownership test**

Construct two Conversation fixtures for one account and assert exactly one
instance of:

- Kernel coordinator;
- `KernelExecutionRuntime`;
- Executor registry;
- startup recovery;
- Task timer/recovery service;
- workspace/attempt supervisor.

**Step 2: Run tests to verify failure**

```bash
npx vitest run \
  tests/account/account-runtime.test.ts \
  tests/core/session-extraction-services.test.ts \
  tests/session/startup-running-reconciliation.test.ts
```

**Step 3: Move runtime-wide construction**

Extract from `MetaclawSession`:

- repositories and Task/Work Graph runtime;
- Kernel and execution runtime;
- Executor/resource/workspace services;
- startup recovery;
- timers and account-wide callbacks.

Expose query, command and proposal ports rather than concrete implementations.

**Step 4: Make recovery one-time**

`AccountRuntime.initialize()` owns recovery. Creating or reconnecting a
Conversation must not call `recoverDurableStartup()`.

**Step 5: Keep a temporary test composition helper**

Existing tests may use `createTestAccountRuntime()` while Session tests migrate.
Do not expose this as a production compatibility constructor.

**Step 6: Run focused tests and commit**

```bash
npx vitest run tests/account tests/core/session-extraction-services.test.ts \
  tests/session/startup-running-reconciliation.test.ts \
  tests/execution/kernel-execution-runtime-recovery.test.ts
git add src/account src/session/metaclaw-session.ts \
  src/session/session-kernel-runtime.ts src/execution/kernel-execution-runtime.ts \
  src/index.ts tests/account tests/core/session-extraction-services.test.ts \
  tests/session/startup-running-reconciliation.test.ts
git commit -m "refactor: extract account runtime ownership"
```

### Task 8: Add RuntimeRegistry And Account Lifecycle

**Files:**

- Create: `src/account/runtime-registry.ts`
- Create: `src/account/account-lifecycle.ts`
- Modify: `src/session/server-application.ts`
- Modify: `src/index.ts`
- Test: `tests/account/runtime-registry.test.ts`
- Modify: `tests/session/server-application.test.ts`

**Step 1: Write failing lifecycle tests**

Cover:

- concurrent activation of the same Account is single-flight;
- unauthorized Accounts are not activated;
- one failed Account does not destroy another loaded Account;
- `local-default` may remain loaded for process lifetime;
- shutdown closes Gateway admission before Runtime services;
- busy Account cannot close;
- idle close disposes children exactly once.

**Step 2: Run tests**

```bash
npx vitest run tests/account/runtime-registry.test.ts tests/session/server-application.test.ts
```

Expected: FAIL.

**Step 3: Implement registry and lifecycle**

Inject an `AccountRuntimeFactory`; do not let Gateway or adapters create
AccountRuntime directly.

**Step 4: Update composition**

`src/index.ts` constructs installation-global services, Gateway and one
RuntimeRegistry. It no longer chooses a different Runtime composition for Web,
TUI and Gateway daemon modes.

**Step 5: Run tests and commit**

```bash
npx vitest run tests/account/runtime-registry.test.ts \
  tests/session/server-application.test.ts \
  tests/installation/composition-runtime.test.ts
git add src/account/runtime-registry.ts src/account/account-lifecycle.ts \
  src/session/server-application.ts src/index.ts tests/account/runtime-registry.test.ts \
  tests/session/server-application.test.ts
git commit -m "feat: add account runtime registry"
```

## Phase 4: Conversation Runtime

### Task 9: Add Durable Conversation Store And Bindings

**Files:**

- Create: `src/session/conversation-store.ts`
- Create: `src/session/file-conversation-store.ts`
- Create: `src/session/conversation-binding-repository.ts`
- Modify: `src/management/web-session-catalog.ts`
- Modify: `src/storage/file-web-session-store.ts`
- Test: `tests/session/file-conversation-store.test.ts`
- Modify: `tests/management/web-session-catalog.test.ts`

**Step 1: Write failing store tests**

Cover:

- versioned account-scoped Conversation records;
- stable Planner session ID;
- create/read/list/search/archive;
- platform/channel/thread bindings;
- one binding cannot resolve across Accounts;
- atomic writes and invalid-record quarantine;
- migration of Web session records into Conversation records;
- bounded sanitized terminal turns.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/session/file-conversation-store.test.ts \
  tests/management/web-session-catalog.test.ts \
  tests/storage/file-web-session-store.test.ts
```

**Step 3: Implement the store**

Generalize the existing Web session projection into an account Conversation
store. Web becomes one consumer; do not keep two authoritative catalogs.

**Step 4: Run tests and commit**

```bash
npx vitest run tests/session/file-conversation-store.test.ts \
  tests/management/web-session-catalog.test.ts
git add src/session/conversation-store.ts src/session/file-conversation-store.ts \
  src/session/conversation-binding-repository.ts \
  src/management/web-session-catalog.ts src/storage/file-web-session-store.ts \
  tests/session/file-conversation-store.test.ts \
  tests/management/web-session-catalog.test.ts
git commit -m "feat: persist account conversations"
```

### Task 10: Add Conversation Input Mailbox

**Files:**

- Create: `src/session/conversation-input-mailbox.ts`
- Modify: `src/session/input-controller.ts`
- Test: `tests/session/conversation-input-mailbox.test.ts`
- Modify: `tests/session/input-controller.test.ts`

**Step 1: Write failing mailbox tests**

Test:

- FIFO user-message execution;
- duplicate idempotency key returns the first receipt;
- one active turn per Conversation;
- cancellation targets one queued/active turn;
- permission resolution may be admitted while normal input is queued only when
  the contract explicitly allows it;
- failure of one turn releases the next turn;
- queue bounds return a structured busy error.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/session/conversation-input-mailbox.test.ts \
  tests/session/input-controller.test.ts
```

Expected: FAIL.

**Step 3: Implement the mailbox**

Keep serialization outside Planner and outside transport adapters. The mailbox
owns turn admission only; Account Kernel policy remains elsewhere.

**Step 4: Run tests and commit**

```bash
npx vitest run tests/session/conversation-input-mailbox.test.ts \
  tests/session/input-controller.test.ts
git add src/session/conversation-input-mailbox.ts src/session/input-controller.ts \
  tests/session/conversation-input-mailbox.test.ts tests/session/input-controller.test.ts
git commit -m "feat: serialize conversation input"
```

### Task 11: Extract ConversationSession And Registry

**Files:**

- Create: `src/session/conversation-session.ts`
- Create: `src/session/conversation-registry.ts`
- Create: `src/session/conversation-runtime-port.ts`
- Modify: `src/session/metaclaw-session.ts`
- Modify: `src/planning/planning-context-builder.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Test: `tests/session/conversation-session.test.ts`
- Test: `tests/session/conversation-registry.test.ts`
- Modify: `tests/session/planning-agent-session-routing.test.ts`

**Step 1: Write failing Session tests**

Assert:

- stable `conversationId` maps to stable Planner session ID;
- Session owns trace/output/focus but no Kernel/Execution/repository
  construction;
- two Conversations share AccountRuntime facts but not Planner history or
  current trace;
- multiple client attachments receive the same Conversation events;
- disconnecting the last client does not destroy an active turn;
- idle deactivation is safe and restartable.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/session/conversation-session.test.ts \
  tests/session/conversation-registry.test.ts \
  tests/session/planning-agent-session-routing.test.ts
```

**Step 3: Implement the reduced Session**

Move conversation-facing behavior from `MetaclawSession` into
`ConversationSession`. Inject `ConversationRuntimePort` from AccountRuntime.

**Step 4: Retire production construction in `MetaclawSession`**

Temporarily keep `MetaclawSession` as a deprecated test adapter that wraps one
AccountRuntime and ConversationSession. Production composition must no longer
import it.

**Step 5: Run tests and commit**

```bash
npx vitest run tests/session tests/account
git add src/session src/planning/planning-context-builder.ts \
  src/planning/planner-process-supervisor.ts tests/session
git commit -m "refactor: separate conversations from account runtime"
```

## Phase 5: Unified Gateway Core

### Task 12: Implement Authentication And Account Resolution

**Files:**

- Create: `src/gateway/authenticator.ts`
- Create: `src/gateway/account-resolver.ts`
- Create: `src/gateway/local-principal.ts`
- Modify: `src/management/web-auth.ts`
- Modify: `src/gateway/feishu-policy.ts`
- Test: `tests/gateway/authenticator.test.ts`
- Test: `tests/gateway/account-resolver.test.ts`
- Modify: `tests/management/web-auth.test.ts`
- Modify: `tests/gateway/feishu-policy.test.ts`

**Step 1: Write failing auth tests**

Cover:

- local installation Principal maps to `local-default`;
- Web auth produces a Principal, not direct Runtime access;
- Feishu app/tenant/user identity resolves only after policy approval;
- client-supplied Account ID is ignored;
- revoked, unknown and ambiguous mappings fail closed;
- cross-account conversation attachment is rejected.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/gateway/authenticator.test.ts \
  tests/gateway/account-resolver.test.ts \
  tests/management/web-auth.test.ts \
  tests/gateway/feishu-policy.test.ts
```

**Step 3: Implement auth ports**

Transport adapters produce authenticated Principals. `AccountResolver` maps
Principals to authorized Account records. It does not activate Runtime.

**Step 4: Run tests and commit**

```bash
npx vitest run tests/gateway/authenticator.test.ts \
  tests/gateway/account-resolver.test.ts tests/management/web-auth.test.ts \
  tests/gateway/feishu-policy.test.ts
git add src/gateway/authenticator.ts src/gateway/account-resolver.ts \
  src/gateway/local-principal.ts src/management/web-auth.ts \
  src/gateway/feishu-policy.ts tests/gateway tests/management/web-auth.test.ts
git commit -m "feat: resolve gateway principals to accounts"
```

### Task 13: Implement Conversation Resolution And Command Admission

**Files:**

- Create: `src/gateway/conversation-resolver.ts`
- Create: `src/gateway/command-admission.ts`
- Create: `src/gateway/client-gateway.ts`
- Modify: `src/gateway/types.ts`
- Test: `tests/gateway/conversation-resolver.test.ts`
- Test: `tests/gateway/command-admission.test.ts`
- Test: `tests/gateway/client-gateway.test.ts`

**Step 1: Write failing resolution tests**

Cover attach, bound and new modes. Verify Feishu DM/group/thread bindings remain
separate unless explicitly attached.

**Step 2: Write failing admission tests**

Assert:

- authentication precedes AccountRuntime activation;
- command idempotency returns the original receipt;
- conversation mailbox receives exactly one command;
- direct Runtime/Session objects are not exposed to adapters;
- structured busy/conflict/unavailable errors preserve request identity.

**Step 3: Run tests**

```bash
npx vitest run \
  tests/gateway/conversation-resolver.test.ts \
  tests/gateway/command-admission.test.ts \
  tests/gateway/client-gateway.test.ts
```

**Step 4: Implement Gateway core**

`ClientGateway` depends only on:

- Authenticator;
- AccountResolver;
- ConversationResolver;
- RuntimeRegistry facade;
- event journal/subscription ports.

**Step 5: Run tests and commit**

```bash
npx vitest run tests/gateway/conversation-resolver.test.ts \
  tests/gateway/command-admission.test.ts tests/gateway/client-gateway.test.ts
git add src/gateway/conversation-resolver.ts src/gateway/command-admission.ts \
  src/gateway/client-gateway.ts src/gateway/types.ts tests/gateway
git commit -m "feat: add unified client gateway"
```

### Task 14: Add Durable Event Journal And Replay

**Files:**

- Create: `src/gateway/event-journal.ts`
- Create: `src/gateway/file-event-journal.ts`
- Create: `src/gateway/gateway-subscriptions.ts`
- Modify: `src/session/interaction-trace-stream.ts`
- Modify: `src/management/execution-projector.ts`
- Test: `tests/gateway/file-event-journal.test.ts`
- Test: `tests/gateway/gateway-subscriptions.test.ts`
- Modify: `tests/session/interaction-trace-stream.test.ts`

**Step 1: Write failing journal tests**

Cover:

- monotonic per-Conversation sequence;
- bounded current/terminal replay;
- atomic persistence;
- duplicate event ID idempotency;
- stale cursor returns snapshot plus later deltas;
- account/conversation authorization filter;
- sensitive fields remain absent.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/gateway/file-event-journal.test.ts \
  tests/gateway/gateway-subscriptions.test.ts \
  tests/session/interaction-trace-stream.test.ts
```

**Step 3: Implement event projection**

Bridge existing safe trace and execution projections into Gateway events.
Persist sanitized projections only.

**Step 4: Run tests and commit**

```bash
npx vitest run tests/gateway/file-event-journal.test.ts \
  tests/gateway/gateway-subscriptions.test.ts \
  tests/session/interaction-trace-stream.test.ts \
  tests/management/execution-projector.test.ts
git add src/gateway/event-journal.ts src/gateway/file-event-journal.ts \
  src/gateway/gateway-subscriptions.ts src/session/interaction-trace-stream.ts \
  src/management/execution-projector.ts tests/gateway \
  tests/session/interaction-trace-stream.test.ts
git commit -m "feat: persist gateway event replay"
```

## Phase 6: Surface Cutovers

### Task 15: Cut Web Conversation Traffic Over To Gateway

**Files:**

- Create: `src/management/web-gateway-adapter.ts`
- Modify: `src/management/server.ts`
- Modify: `src/management/web-session-runtime.ts`
- Modify: `src/index.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/App.tsx`
- Test: `tests/management/web-gateway-adapter.test.ts`
- Modify: `tests/management/server.test.ts`
- Modify: `tests/management/web-session-runtime.test.ts`

**Step 1: Write failing Web cutover tests**

Assert:

- WebSocket authentication creates a Gateway connection;
- selected Conversation attaches through Gateway;
- multiple tabs receive the same Conversation replay;
- sending input produces one Gateway command;
- no Web code constructs or receives `MetaclawSession`;
- management/configuration endpoints remain available separately;
- reconnect resumes from an event cursor.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/management/web-gateway-adapter.test.ts \
  tests/management/server.test.ts \
  tests/management/web-session-runtime.test.ts
```

**Step 3: Implement the adapter**

Keep static hosting and management HTTP in `ManagementServer`. Move
conversation WebSocket traffic, session selection and replay to
`WebGatewayAdapter`.

**Step 4: Update the Web client**

Replace Session-specific messages with Gateway command/event envelopes while
preserving Conversation and Trajectory rendering.

**Step 5: Run Web and server validation**

```bash
npx vitest run tests/management tests/web
npm run build
cd web && npm run build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/management src/index.ts web tests/management tests/web
git commit -m "feat: route web conversations through gateway"
```

### Task 16: Cut Feishu Over To Gateway

**Files:**

- Modify: `src/gateway/feishu-adapter.ts`
- Modify: `src/gateway/feishu-events.ts`
- Modify: `src/gateway/feishu-runtime.ts`
- Modify: `src/integrations/feishu-app.ts`
- Modify: `src/index.ts`
- Test: `tests/gateway/feishu-conversation-routing.test.ts`
- Modify: `tests/gateway/feishu-adapter.test.ts`
- Modify: `tests/integrations/feishu-app.test.ts`

**Step 1: Write failing Feishu routing tests**

Cover:

- sender identity resolves Account access;
- each DM/group/thread binding resolves a separate Conversation;
- two concurrent chats do not share Planner trace/output;
- repeated webhook event ID creates one turn;
- progress/final/artifact delivery comes from Gateway events;
- delivery failure does not repeat the turn;
- no Feishu class receives `MetaclawSession`.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/gateway/feishu-conversation-routing.test.ts \
  tests/gateway/feishu-adapter.test.ts \
  tests/integrations/feishu-app.test.ts
```

**Step 3: Implement Feishu as a true Gateway adapter**

Normalize inbound events, authenticate/resolve Principal, submit the Gateway
command, attach an origin delivery subscription, and render Gateway progress/
final/artifact events.

**Step 4: Delete direct Session output slicing**

Remove `before`, `observedOutputLength`, shared output filtering and direct
`session.submit()` from Feishu handling.

**Step 5: Run tests and commit**

```bash
npx vitest run tests/gateway tests/integrations/feishu-app.test.ts
git add src/gateway/feishu-adapter.ts src/gateway/feishu-events.ts \
  src/gateway/feishu-runtime.ts src/integrations/feishu-app.ts src/index.ts \
  tests/gateway tests/integrations/feishu-app.test.ts
git commit -m "feat: route feishu through unified gateway"
```

### Task 17: Add AnyFusion-Pi Gateway Client Mode

**Files:**

- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts`
- Create: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/cli/args.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/main.ts`
- Modify: `planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/index.ts`
- Test: `planner/AnyFusion-Pi/packages/coding-agent/test/anyfusion/gateway-client.test.ts`
- Create: `tests/gateway/native-tui-gateway.test.ts`

**Step 1: Write failing Pi client tests**

Test:

- interactive editor submits raw user input to Gateway;
- the client renders snapshot/delta/final events;
- reconnect resumes by cursor;
- slash commands and permission selection use versioned command kinds;
- interactive client mode does not invoke the local semantic AgentSession;
- Planner semantic work remains server-side RPC bound to the Conversation
  Planner session ID.

**Step 2: Run Pi tests**

```bash
cd planner/AnyFusion-Pi
npx vitest run packages/coding-agent/test/anyfusion/gateway-client.test.ts
```

Expected: FAIL.

**Step 3: Implement client-only interactive mode**

Reuse Pi's editor, selectors and rendering components, but replace direct
semantic prompt execution with Gateway commands and events. Do not expose
Planner proposal tools to the client mode.

**Step 4: Update Server Planner launch**

AccountRuntime launches semantic Planner turns through controlled RPC. The TUI
is now a client and does not own the Planner session writer.

**Step 5: Run focused integration**

```bash
cd planner/AnyFusion-Pi && npm run build:offline
cd ../../..
npx vitest run tests/gateway/native-tui-gateway.test.ts \
  tests/session/planner-process-lifecycle.test.ts \
  tests/session/planning-agent-session-routing.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add planner/AnyFusion-Pi src/planning/planner-process-supervisor.ts \
  src/index.ts tests/gateway/native-tui-gateway.test.ts \
  tests/session/planner-process-lifecycle.test.ts \
  tests/session/planning-agent-session-routing.test.ts
git commit -m "feat: connect native tui through gateway"
```

### Task 18: Unify Server Composition And CLI Modes

**Files:**

- Modify: `src/index.ts`
- Modify: `src/cli/args.ts`
- Modify: `src/installation/composition-runtime.ts`
- Modify: `src/session/server-application.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/management/server.ts`
- Test: `tests/architecture/unified-server-composition.test.ts`
- Modify: `tests/installation/composition-runtime.test.ts`
- Modify: `tests/gateway/server-lifecycle.test.ts`

**Step 1: Write failing composition tests**

Assert one Server process can host:

- Gateway core;
- local socket adapter;
- Web adapter/management server;
- Feishu adapter;
- RuntimeRegistry;
- `local-default` AccountRuntime;
- zero client-owned Runtime instances.

Also assert `anyfusion`, `anyfusion web` and `anyfusion gateway run` no longer
select mutually incompatible Runtime compositions. Compatibility CLI aliases
may select which client UI opens, not which Server architecture exists.

**Step 2: Run tests**

```bash
npx vitest run \
  tests/architecture/unified-server-composition.test.ts \
  tests/installation/composition-runtime.test.ts \
  tests/gateway/server-lifecycle.test.ts
```

**Step 3: Implement unified composition**

Create one `ServerApplication` lifecycle:

```text
lock -> configuration/release -> RuntimeRegistry -> Gateway core
-> enabled adapters -> admission -> shutdown drain
```

**Step 4: Preserve restart semantics**

`anyfusion web restart` or the replacement service command restarts the unified
Server, not a Web-only Runtime.

**Step 5: Run tests and commit**

```bash
npx vitest run tests/architecture/unified-server-composition.test.ts \
  tests/installation/composition-runtime.test.ts tests/gateway/server-lifecycle.test.ts
git add src/index.ts src/cli/args.ts src/installation/composition-runtime.ts \
  src/session/server-application.ts src/gateway/server.ts src/management/server.ts \
  tests/architecture/unified-server-composition.test.ts \
  tests/installation/composition-runtime.test.ts tests/gateway/server-lifecycle.test.ts
git commit -m "refactor: unify server client composition"
```

## Phase 7: Remove Old Paths And Harden

### Task 19: Remove Direct Session Compatibility Paths

**Files:**

- Delete or reduce: `src/session/metaclaw-session.ts`
- Delete or replace: `src/management/web-session-runtime.ts`
- Delete direct bridge: `src/gateway/feishu-runtime.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/session/session-transport-adapter.ts`
- Modify: `src/tui-bridge/planner-host-bridge.ts`
- Modify: tests importing `MetaclawSession`
- Test: `tests/architecture/no-direct-client-session-paths.test.ts`

**Step 1: Write the failing architecture test**

Scan production imports and assert:

```ts
expect(clientAdaptersImportingMetaclawSession()).toEqual([]);
expect(productionMetaclawSessionConstructors()).toEqual([]);
expect(perConnectionRuntimeConstructors()).toEqual([]);
```

Also assert only AccountRuntime composition can construct Kernel/Execution
services.

**Step 2: Run test**

```bash
npx vitest run tests/architecture/no-direct-client-session-paths.test.ts
```

Expected: FAIL until old paths are removed.

**Step 3: Delete compatibility behavior**

Remove:

- per-socket `new MetaclawSession`;
- Web-owned live Session;
- Feishu-owned shared Session;
- Planner TUI direct Runtime registration;
- per-Session startup recovery;
- per-Session KernelWorkflow construction.

Keep the standby Ink UI source-preserved as required by repository policy, but
make any future activation use Gateway.

**Step 4: Migrate tests to AccountRuntime/Conversation fixtures**

Do not retain a production constructor solely for old tests.

**Step 5: Run architecture and full Session tests**

```bash
npx vitest run tests/architecture tests/session tests/gateway tests/management
```

Expected: PASS.

**Step 6: Commit**

```bash
git add -A src/session src/gateway src/management src/tui-bridge tests
git commit -m "refactor: remove direct client runtime paths"
```

### Task 20: Add Multi-Surface End-To-End Acceptance

**Files:**

- Create: `tests/integration/unified-client-runtime.integration.test.ts`
- Create: `scripts/smoke-unified-gateway.ts`
- Modify: `package.json`
- Modify: `scripts/smoke-metaclaw-real-task.mjs`
- Modify: `Dockerfile.test`

**Step 1: Write the end-to-end test**

Start one Server with local socket and Web enabled plus a fake Feishu adapter.
Verify:

1. Web creates Conversation A and starts a Task.
2. TUI attaches to Conversation A and sees the same Task/trace.
3. Feishu Conversation B sees the same account Task state but not Conversation
   A Planner history.
4. concurrent direct replies in A and B retain separate final answers.
5. a duplicate Feishu event does not create a second turn.
6. client reconnect resumes from cursor.
7. Server restart recovers AccountRuntime once and preserves Conversations.
8. ADR-0011 still prevents a second active top-level Task in the Account.

**Step 2: Run the test to verify failure**

```bash
npx vitest run tests/integration/unified-client-runtime.integration.test.ts
```

**Step 3: Implement smoke orchestration**

Add:

```bash
npm run smoke:gateway
```

The smoke must use an isolated install root and must not touch the operator's
live `~/.anyfusion`.

**Step 4: Run focused and container acceptance**

```bash
npx vitest run tests/integration/unified-client-runtime.integration.test.ts
npm run smoke:gateway
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

Expected: all pass.

**Step 5: Commit**

```bash
git add tests/integration/unified-client-runtime.integration.test.ts \
  scripts/smoke-unified-gateway.ts scripts/smoke-metaclaw-real-task.mjs \
  package.json Dockerfile.test
git commit -m "test: add unified gateway acceptance"
```

### Task 21: Security, Load And Recovery Hardening

**Files:**

- Create: `tests/security/gateway-account-isolation.test.ts`
- Create: `tests/gateway/gateway-load.test.ts`
- Create: `tests/account/account-recovery-isolation.test.ts`
- Modify: `src/gateway/client-gateway.ts`
- Modify: `src/gateway/file-event-journal.ts`
- Modify: `src/account/runtime-registry.ts`
- Modify: `src/utils/redact-sensitive-text.ts`

**Step 1: Write security tests**

Prove:

- one Account cannot attach to another Account's Conversation;
- raw platform identity cannot override Account resolution;
- event journal traversal is impossible;
- secret-like fields never enter Gateway events;
- Feishu group members cannot access another paired user's Account;
- revoked Principal loses new admission without corrupting active durable work.

**Step 2: Write load tests**

Exercise:

- many read-only connections on one Conversation;
- bounded mailbox overflow;
- concurrent Conversations;
- reconnect storms;
- slow client backpressure;
- event-journal retention.

**Step 3: Write recovery-isolation tests**

One corrupt Account must enter blocked/quarantined state while another Account
continues serving.

**Step 4: Run tests**

```bash
npx vitest run \
  tests/security/gateway-account-isolation.test.ts \
  tests/gateway/gateway-load.test.ts \
  tests/account/account-recovery-isolation.test.ts
```

**Step 5: Implement bounded protections**

Add queue, payload, attachment, event, connection and replay limits. Fail closed
on identity or path ambiguity.

**Step 6: Run tests and commit**

```bash
npx vitest run tests/security tests/gateway tests/account
git add src/gateway src/account/runtime-registry.ts \
  src/utils/redact-sensitive-text.ts tests/security tests/gateway \
  tests/account/account-recovery-isolation.test.ts
git commit -m "fix: harden gateway account isolation"
```

## Phase 8: Documentation And Release Closure

### Task 22: Update Current Architecture And Operations

**Files:**

- Modify: `CONTEXT.md`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/README.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/current/phase-5-runtime-security.md`
- Modify: `docs/adr/README.md`
- Create: `docs/current/account-runtime-and-gateway-operations.md`
- Modify: `CHANGELOG.md`

**Step 1: Update authority documents**

After implementation, move ADR-0031 behavior from accepted target to current
implementation facts. Document:

- Account/Conversation/Gateway vocabulary;
- account data layout;
- one AccountRuntime/Kernel coordinator;
- client authentication and bindings;
- restart/recovery;
- event replay and diagnostics;
- App integration contract.

**Step 2: Update operational commands**

Document unified Server start/stop/restart/status and remove mode-specific
instructions that imply separate Runtime instances.

**Step 3: Run link and text checks**

```bash
rg -n "per-connection session|single shared session|web mode.*gateway|MetaclawSession" \
  CONTEXT.md AGENTS.md README.md README.zh-CN.md docs/current docs/README.md
npm run lint
```

Expected: only historical/migration explanations retain the old terms.

**Step 4: Commit**

```bash
git add CONTEXT.md AGENTS.md README.md README.zh-CN.md CHANGELOG.md docs
git commit -m "docs: publish account runtime architecture"
```

### Task 23: Final Validation And Plan Closure

**Files:**

- Modify: `docs/plans/2026-08-18-account-runtime-unified-gateway-implementation-plan.md`
- Modify: `docs/plans/2026-08-18-account-runtime-unified-gateway-design.md`
- Modify: `docs/README.md`

**Step 1: Run full validation**

```bash
npm run lint
npm run build
npm test
cd planner/AnyFusion-Pi && npm run build:offline
cd ../../..
cd web && npm run build
cd ..
npm run smoke:metaclaw
npm run smoke:gateway
```

On environments where SQLite/POSIX tests require Docker:

```bash
docker build -f Dockerfile.test -t metaclaw-test .
docker run --rm metaclaw-test
```

Expected: all required gates pass.

**Step 2: Run architecture audits**

```bash
npx vitest run \
  tests/architecture/no-direct-client-session-paths.test.ts \
  tests/architecture/unified-server-composition.test.ts \
  tests/security/gateway-account-isolation.test.ts \
  tests/integration/unified-client-runtime.integration.test.ts
```

Expected: PASS.

**Step 3: Verify repository boundaries**

Confirm:

- no production client adapter imports `MetaclawSession`;
- no per-conversation Kernel/Execution construction remains;
- only AccountRuntime owns durable startup recovery;
- all user message surfaces use Gateway;
- no legacy account data root is writable;
- standby Ink UI source and dependencies remain preserved.

**Step 4: Close the plan**

Add:

- completion date;
- delivered behavior;
- migration evidence;
- exact validation results;
- closing commit;
- any explicitly deferred non-goals.

Move the plan to completed delivery in `docs/README.md`.

**Step 5: Commit**

```bash
git add docs/plans/2026-08-18-account-runtime-unified-gateway-implementation-plan.md \
  docs/plans/2026-08-18-account-runtime-unified-gateway-design.md docs/README.md
git commit -m "docs: close unified gateway plan"
```

## Phase Gates

### Gate A: Ownership

After Task 8:

- AccountRuntime exists;
- startup recovery runs once;
- one account Kernel coordinator owns drains;
- current clients may still use temporary adapters.

Do not begin surface cutover until Gate A passes.

### Gate B: Conversation Isolation

After Task 11:

- stable Conversations and Planner sessions exist;
- input is serialized per Conversation;
- two Conversations cannot share trace/output state.

Do not cut Feishu over until Gate B passes.

### Gate C: Gateway

After Task 14:

- authentication, account/conversation resolution, idempotency and replay pass;
- no adapter needs concrete Runtime objects.

Do not cut any production surface over until Gate C passes.

### Gate D: Surface Convergence

After Task 18:

- Web, Feishu and native TUI use Gateway;
- one Server composition hosts all enabled adapters;
- the App has a stable protocol target.

### Gate E: Removal And Release

After Task 23:

- all direct Session paths are removed;
- account isolation and recovery tests pass;
- full build, suite and smoke gates pass;
- current documentation reflects delivered behavior.

## Rollback Strategy

- Phases 1 and 3 contract work may be reverted before account-layout activation.
- Account-layout migration must retain the verified pre-migration root and
  activation journal until Gate E.
- Surface cutovers are feature-gated only during their task; each task removes
  the old path before completion. Do not ship permanent dual routing.
- If one surface fails acceptance, roll back that coherent cutover commit while
  retaining completed AccountRuntime/Gateway foundations.
- If account storage activation fails, restore the previous verified layout
  through ADR-0030 rather than adding a runtime legacy read path.

## Explicitly Deferred

- more than one active top-level Task per AccountRuntime;
- cross-account collaboration;
- cloud organizations, billing and administrative UI;
- distributed RuntimeRegistry or Kernel leadership;
- remote A2A Executor transport;
- concrete future App authentication and UI.
