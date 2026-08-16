# AnyFusion Web Bootstrap Cookie Authentication Implementation Plan

Status: Completed
Plan date: 2026-08-16
Completion date: 2026-08-16

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make normal AnyFusion Web startup automatically authenticated while retaining an explicit manual-token fallback for `--no-open`, SSH, and port-forwarded use.

**Architecture:** Add a process-local authentication service that exchanges a short-lived URL-fragment bootstrap token or manual access token for an HttpOnly session cookie. Browser REST and WebSocket traffic use the cookie; Bearer authentication remains for script compatibility. The frontend consumes and removes the fragment before rendering the application and shows TokenGate only when neither bootstrap nor cookie authentication succeeds.

**Tech Stack:** Node.js 22 HTTP/WebSocket server, TypeScript ESM, React 18, Vite, Vitest.

---

### Task 1: Process-local Web Authentication Service

**Files:**
- Create: `src/management/web-auth.ts`
- Test: `tests/management/web-auth.test.ts`

**Step 1: Write failing tests**

- Generate distinct bootstrap, manual access, and session tokens.
- Exchange the bootstrap token once and reject reuse or expiry.
- Exchange the manual token repeatedly for recovery sessions.
- Parse and verify the session cookie without exposing it to browser code.

**Step 2: Verify RED**

Run: `npx vitest run tests/management/web-auth.test.ts`
Expected: FAIL because the authentication service does not exist.

**Step 3: Implement the minimal service**

- Use constant-time token comparison.
- Track bootstrap expiry and consumption in process memory.
- Format an HttpOnly, SameSite=Strict, Path=/ session cookie.
- Keep the cookie a browser-session cookie without persistent expiry.

**Step 4: Verify GREEN**

Run: `npx vitest run tests/management/web-auth.test.ts`
Expected: PASS.

### Task 2: HTTP And WebSocket Cookie Authentication

**Files:**
- Modify: `src/management/server.ts`
- Modify: `tests/management/server.test.ts`

**Step 1: Write failing real-network tests**

- Exchange a bootstrap token and assert `Set-Cookie`.
- Assert bootstrap reuse fails.
- Exchange the manual token and assert success.
- Authenticate `/api/config` with Cookie and retain Bearer compatibility.
- Reject foreign Origin exchanges.
- Upgrade WebSocket with a valid Cookie and reject an unauthenticated upgrade.

**Step 2: Verify RED**

Run: `npx vitest run tests/management/server.test.ts`
Expected: FAIL because auth endpoints and Cookie-authenticated upgrades do not exist.

**Step 3: Implement endpoints and guards**

- Add `/api/auth/bootstrap`, `/api/auth/session`, and `/api/auth/logout`.
- Accept Cookie or Bearer authentication for management APIs.
- Require a valid session Cookie during WebSocket upgrade.
- Reject invalid upgrades before sending `101 Switching Protocols`.
- Preserve loopback Origin checks and existing frame/lifecycle limits.

**Step 4: Verify GREEN**

Run: `npx vitest run tests/management/server.test.ts tests/management/websocket.test.ts`
Expected: PASS.

### Task 3: Frontend Bootstrap And Cookie Session

**Files:**
- Replace: `web/src/auth.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api/http.ts`
- Modify: `web/src/api/ws.ts`
- Modify: `web/src/components/TokenGate.tsx`
- Test: `tests/web/auth.test.ts`

**Step 1: Write failing tests**

- Extract a bootstrap token from `location.hash`.
- Remove the fragment while preserving path and query.
- Exchange credentials without writing browser storage.
- Assert HttpClient sends no Authorization header in Cookie mode.
- Assert WsClient sends no auth message after opening.

**Step 2: Verify RED**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL on the old storage/Bearer behavior.

**Step 3: Implement frontend auth state**

- Bootstrap once before constructing API clients.
- Check `/api/auth/session` when no fragment exists.
- Use `credentials: 'same-origin'` for HTTP exchange and API calls.
- Let WebSocket rely on the browser Cookie.
- Reduce TokenGate to a manual fallback exchange form.
- Return to TokenGate on stale Cookie without reconnect loops.

**Step 4: Verify GREEN and build**

Run: `npx vitest run tests/web/auth.test.ts`
Run: `npm run build --prefix web`
Expected: PASS.

### Task 4: Startup UX And Fallback Output

**Files:**
- Modify: `src/index.ts`
- Modify: `src/management/token.ts`
- Modify: `tests/management/token.test.ts`

**Step 1: Write failing formatting tests**

- Normal mode returns a fragment bootstrap URL and no printed access token.
- `--no-open` prints the clean address and clearly labelled manual fallback
  token.

**Step 2: Verify RED**

Run: `npx vitest run tests/management/token.test.ts`
Expected: FAIL because startup still prints the token for every Web launch.

**Step 3: Implement startup behavior**

- Create the Web authentication service before `ManagementServer`.
- Open the fragment bootstrap URL only in normal mode.
- Print the manual token only for `--no-open`.
- Keep the displayed Web address free of credentials.

**Step 4: Verify GREEN**

Run: `npx vitest run tests/management/token.test.ts tests/management/server.test.ts`
Expected: PASS.

### Task 5: Documentation And Release Validation

**Files:**
- Modify: `README.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `docs/plans/2026-08-16-web-bootstrap-cookie-auth.md`

**Step 1: Update user documentation**

- Document automatic Web login.
- Document `--no-open` manual fallback.
- State that TUI remains the default and Web/TUI remain mutually exclusive.
- Remove instructions to paste a token during normal startup.

**Step 2: Run validation**

Run: `npm run lint`
Run: `npm run build --prefix web`
Run: `npx vitest run tests/management tests/web tests/executor/configuration-probe.test.ts tests/planning/planner-process-supervisor.test.ts tests/planning/planner-mcp-server.test.ts`
Run: `git diff --check`
Expected: all checks pass.

**Step 3: Record completion**

- Add completion date, delivered behavior, exact validation results, and the
  closing commit state.
- Leave the work uncommitted if Git author identity remains unavailable.

## Delivered Behavior

- Normal `anyfusion web` startup opens a short-lived bootstrap credential in
  the URL fragment, exchanges it once for an HttpOnly, SameSite=Strict session
  Cookie, and removes the fragment from the address bar.
- Normal startup no longer prints or asks the user to paste a token.
- `anyfusion web --no-open` prints a clearly labelled manual fallback token for
  SSH, port forwarding, and manual browser startup.
- TokenGate exchanges the fallback token for the Cookie and never writes it to
  localStorage or sessionStorage.
- Browser HTTP requests use same-origin Cookie credentials. Bearer
  authentication remains available for script compatibility.
- WebSocket upgrades require both a valid session Cookie and an allowed
  loopback Origin before switching protocols.
- A stale Cookie detected after WebSocket disconnect returns the browser to the
  fallback gate instead of reconnecting indefinitely.
- The native AnyFusion-Pi TUI remains the default `anyfusion` entry point; Web
  and TUI remain mutually exclusive Runtime modes.

## Validation

- Focused management, Web, Planner revision, and configuration probe suite:
  10 files, 57/57 tests passed.
- `npm run lint`
- `npm run build --prefix web`
- `git diff --check`

Closing commit: Pending; Git author identity remains unconfigured, so the
completed work is intentionally left uncommitted.
