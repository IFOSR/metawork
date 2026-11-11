# AnyFusion Web Release Hardening Implementation Plan

Status: Completed
Plan date: 2026-08-16
Completion date: 2026-08-16

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make the AnyFusion Web surface safe and predictable for local release by closing authentication, token recovery, settings-schema, configuration-revision, and release-contract defects.

**Architecture:** Keep the process-local bearer-token model and the startup-pinned runtime configuration. Authenticate each WebSocket before adding it to broadcast recipients, make browser token rejection explicit, serialize only schema-valid settings changes, and pass the running configuration revision into Planner MCP instead of reading the latest active revision implicitly.

**Tech Stack:** Node.js 22, TypeScript ESM, React 18, Vite, Vitest, Zod, native HTTP/WebSocket implementation.

---

### Task 1: WebSocket Authentication Boundary

**Files:**
- Modify: `src/management/server.ts`
- Modify: `src/management/websocket.ts`
- Create: `tests/management/server.test.ts`

**Step 1: Write the failing tests**

- Start a real `ManagementServer` on an ephemeral port.
- Connect one authenticated and one unauthenticated WebSocket.
- Trigger an execution broadcast and assert only the authenticated connection
  receives it.
- Attempt a WebSocket upgrade with a foreign `Origin` and assert rejection.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/management/server.test.ts`
Expected: FAIL because unauthenticated connections are broadcast recipients and
foreign origins are accepted.

**Step 3: Implement the minimal fix**

- Track only authenticated connections in the broadcast set.
- Remove authenticated connections on close.
- Accept only absent, same-origin, or loopback-equivalent origins.
- Add bounded frame/message sizes and close invalid clients.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/management/server.test.ts`
Expected: PASS.

### Task 2: Stored Token Rejection Recovery

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/api/types.ts`
- Create: `web/src/auth.ts`
- Create: `tests/web/auth.test.ts`

**Step 1: Write the failing tests**

- Assert that an unauthorized REST or WebSocket result is classified as an
  authentication rejection.
- Assert that rejecting a stored token clears both storage locations.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL because no shared authentication-rejection helper exists.

**Step 3: Implement the minimal fix**

- Add shared storage helpers.
- Surface HTTP 401 and WebSocket `unauthorized` through an `onUnauthorized`
  callback.
- Clear storage and return to `TokenGate`.
- Stop automatic reconnect after an authentication rejection.
- Clarify the token-gate copy and provide a replace-token action.

**Step 4: Run tests and build**

Run: `npx vitest run tests/web/auth.test.ts`
Run: `npm run build --prefix web`
Expected: PASS.

### Task 3: Schema-valid Settings Editing

**Files:**
- Modify: `web/src/components/ModelForm.tsx`
- Modify: `web/src/components/AgentClassForm.tsx`
- Create: `web/src/config-edit.ts`
- Create: `tests/web/config-edit.test.ts`

**Step 1: Write the failing tests**

- Assert that displayed model capabilities exactly match schema values.
- Assert conversion from fixed to automatic policy creates a valid automatic
  policy.
- Assert conversion from automatic to fixed policy creates a valid fixed
  policy.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/web/config-edit.test.ts`
Expected: FAIL because invalid capabilities and invalid policy shapes are
currently produced.

**Step 3: Implement the minimal fix**

- Centralize capability constants and policy conversion helpers.
- Render `disabled` reasoning and every schema-valid capability.
- Serialize fixed and automatic policies as distinct objects.

**Step 4: Run tests and build**

Run: `npx vitest run tests/web/config-edit.test.ts`
Run: `npm run build --prefix web`
Expected: PASS.

### Task 4: Startup-pinned Configuration Revision

**Files:**
- Modify: `src/planning/planner-mcp-server.ts`
- Modify: `src/planning/planner-process-supervisor.ts`
- Modify: `src/index.ts`
- Modify: `src/management/server.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/components/SettingsPanel.tsx`
- Modify: `web/src/App.tsx`
- Test: `tests/planning/planner-process-supervisor.test.ts`
- Test: `tests/planning/planner-mcp-server.test.ts`
- Test: `tests/management/server.test.ts`

**Step 1: Write the failing tests**

- Assert Planner MCP loads the explicitly requested revision rather than the
  repository's current active revision.
- Assert Planner process launch receives the running revision.
- Assert successful Web activation reports the active repository revision and
  `restartRequired: true` while the running revision remains unchanged.

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/planning/planner-process-supervisor.test.ts tests/planning/planner-mcp-server.test.ts tests/management/server.test.ts`
Expected: FAIL because Planner MCP reads active implicitly and activation has no
restart semantics.

**Step 3: Implement the minimal fix**

- Inject `METACLAW_CONFIGURATION_REVISION` into Planner and Planner MCP
  processes.
- Resolve that immutable snapshot by ID.
- Include `runningRevisionId`, `activeRevisionId`, and `restartRequired` in the
  Web activation response.
- Keep the running Session and top bar on the startup revision.
- Show a restart-required result in Settings.

**Step 4: Run focused tests**

Run: `npx vitest run tests/planning/planner-process-supervisor.test.ts tests/planning/planner-mcp-server.test.ts tests/management/server.test.ts`
Expected: PASS.

### Task 5: Release Contract And Documentation

**Files:**
- Modify: `tests/fixtures/task8-cross-repository-contract.json`
- Modify: `web/src/components/TokenGate.tsx`
- Modify: `README.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/plans/2026-08-16-web-release-hardening.md`

**Step 1: Verify the generated schema hash**

Run: `npx vitest run tests/acceptance/task8-cross-repository-contract.test.ts`
Expected: FAIL with the old pinned hash.

**Step 2: Update the pinned hash**

- Replace the manifest hash with the verified generated schema hash.
- Do not alter protocol or schema versions.

**Step 3: Update user documentation**

- Explain that the Web token is process-local and unrelated to Provider keys.
- Explain that Web configuration activation requires restart.
- Record delivered behavior, validation, completion date, and closing commit.

**Step 4: Run release validation**

Run: `npm run lint`
Run: `npm run build --prefix web`
Run: `npm test`
Expected: all non-skipped checks pass.

## Delivered Behavior

- WebSocket session and execution data is sent only to authenticated clients;
  foreign browser origins are rejected, unauthenticated connections time out,
  messages are bounded to 1 MiB, and all close paths detach listeners.
- The terminal labels the process-local Web access token distinctly from
  Provider API keys. Rejected stored tokens return the browser to the token
  gate without reconnect loops or stale-client races.
- Web settings emit schema-valid Model capabilities, reasoning levels, and
  fixed/automatic model policies. Switching to automatic mode preserves the
  current fixed Model as the only initially allowed Model.
- Web configuration activation validates, compiles, probes the enabled local
  Executor drivers, and activates an immutable next-start revision. Probe
  failures include actionable issues and do not change the active revision.
- The running Session, Planner, Planner MCP, Kernel, and Execution Runtime stay
  pinned to the startup revision. The Web API and settings UI distinguish it
  from the repository's active next-start revision and require restart.
- The generated Planner schema hash is pinned to
  `3fdae07d2dccc5ca5021b7a8a3e6b6352062676b32595d1fdcbb1eb17a7a63d6`.

## Validation

- Focused release-hardening suite: 9 files, 45/45 tests passed after independent
  review fixes.
- Full Vitest suite: 229 files passed, 4 skipped; 954 tests passed, 15 skipped.
  Three unrelated long-running tests timed out only in the overloaded full run;
  their three files then passed individually (19/19 tests).
- `npm run lint`
- `npm run build --prefix web`
- `git diff --check`

Closing implementation commit: `e565b99`.
