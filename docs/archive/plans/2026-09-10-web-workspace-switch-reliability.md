# Web Workspace Switch Reliability Implementation Plan

**Status:** Complete
**Plan date:** 2026-09-10
**Completion date:** 2026-09-10

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove Web Workspace navigation races without serializing independent Conversation task execution.

**Architecture:** Serialize only per-Web-client navigation mutations (`selectWorkspace`, `activateSession`, and Conversation creation/foreground activation). Keep Gateway message submission and AccountRuntime execution independent. Capture the target Conversation at message submission start so a foreground switch cannot retarget an in-flight message.

**Tech Stack:** Node 22, TypeScript ESM, React/Vite, Vitest.

---

### Task 1: Lock the navigation and submission contracts with failing tests

**Files:**
- Modify: `tests/management/web-gateway-session-runtime.test.ts`
- Modify: `tests/web/workspace-shell.test.ts`

**Steps:**
1. Add a test proving a delayed Workspace selection cannot overtake a later selection.
2. Add a test proving a message started for Conversation A is submitted to A after the Web foreground switches to B.
3. Add source-contract assertions that Workspace switching does not auto-attach the most recent Conversation.
4. Run the focused tests and verify they fail for the intended reasons.

### Task 2: Serialize navigation-only runtime mutations

**Files:**
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `tests/management/web-gateway-session-runtime.test.ts`

**Steps:**
1. Add a per-client navigation queue helper.
2. Route Workspace selection, Conversation activation, and Conversation creation through that queue.
3. Keep `submit()` outside the queue.
4. Capture the active Conversation ID before attachment enrichment and use it for attachment reads and Gateway submission.
5. Run the focused runtime tests.

### Task 3: Make Web Workspace switching one authoritative UI transition

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/http.ts`
- Modify: `tests/web/workspace-shell.test.ts`

**Steps:**
1. Add a switching guard that disables repeated selector changes.
2. Stop auto-attaching the latest Conversation during Workspace switching.
3. Use one guarded reload path for the selected Workspace directory.
4. Ignore stale directory responses from earlier Workspace/search requests.
5. Run Web tests and build the Web bundle.

### Task 4: Validate concurrency boundaries

**Files:**
- Modify: `tests/management/web-gateway-session-runtime.test.ts`
- Modify: `tests/e2e/workspace-conversation-directory-browser.test.ts` if the existing browser fixture can assert the behavior without broad refactoring.

**Steps:**
1. Verify Conversation A remains executable while Conversation B is created and foregrounded.
2. Verify A and B retain separate submission targets.
3. Run focused tests, lint, Web build, and the browser Workspace E2E.
4. Update this plan with completion and validation details.

## Delivered

- Serialized per-Web-client Workspace selection, Conversation activation, and
  Conversation creation/foreground activation in the Gateway session runtime.
- Bound message submission and attachment enrichment to the Conversation active
  when submission began; message submission remains outside the navigation queue.
- Made Workspace switching one guarded UI transition. The selector and other
  navigation controls are disabled during the transition.
- Removed automatic attachment to the most recently updated Conversation when
  changing Workspace.
- Added request/version guards for Conversation directory and record loads so
  stale responses cannot overwrite the current Workspace view.
- Preserved AccountRuntime concurrency: a running Task in Conversation A is not
  cancelled or serialized with Conversation B's navigation or submission.

## Validation

- `npm test -- --run tests/web/workspace-shell.test.ts`
- `npm test -- --run tests/management/web-gateway-session-runtime.test.ts`
- `npm test -- --run tests/management/web-gateway-session-runtime.test.ts tests/management/server.test.ts tests/web/workspace-shell.test.ts tests/web/session-selection.test.ts`
- `npm run lint`
- `npm run build`
- `RUN_BROWSER_E2E=1 npx vitest run tests/e2e/workspace-conversation-directory-browser.test.ts`
