# Web Workspace Creation And Login Implementation Plan

> **Status:** Ready
> **Plan date:** 2026-09-16
> **Design:** [Web Workspace Creation And Login Design](2026-09-16-web-workspace-creation-and-login-design.md)

> **For the executing agent:** REQUIRED SUB-SKILL: use the executing-plans skill
> to implement this plan task-by-task.

**Goal:** Let a user who types the Web URL directly log in and create a Workspace
by browsing the local filesystem, without the Server ever generating a login
password and without a launch token authenticating anyone.

**Architecture:** The launch context stops being an authentication credential
and becomes a one-time, unauthenticated, read-only Workspace suggestion applied
through the ordinary authorized `select_workspace` path. Web-side Workspace
creation is a new cookie-authenticated read-only directory listing endpoint plus
a Web picker. Built-in login credentials become the fixed `admin` / `123456`
pair already used by the launcher scripts.

**Tech Stack:** Node 22, TypeScript ESM, React/Vite, Vitest, Node `fs/promises`.

---

## Ground Rules

- Run focused tests only. `better-sqlite3` is unavailable on the host Windows
  environment and the full suite is slow; run `npm run lint` for host checks.
- Commit after every task with the given Conventional Commit subject.
- Never leave a dual read/write path behind: each task removes the old contract
  in the same commit that adds the replacement.
- All Web-facing copy is Chinese, matching the existing UI.

---

### Task 1: Make built-in login credentials fixed

**Files:**
- Modify: `src/management/login-credentials.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/management/login-credentials.test.ts`

**Step 1: Rewrite the failing tests**

Replace both the `generates a random password when nothing is configured` and
`generateLoginCredentials exposes username and password for startup presentation`
tests in `tests/management/login-credentials.test.ts`:

```ts
import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  resolveLoginCredentials,
  verifyLogin,
} from '../../src/management/login-credentials.js';

function scryptHash(password: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
}

describe('login credentials', () => {
  it('uses configured username and password from environment', () => {
    const credentials = resolveLoginCredentials({
      ANYFUSION_WEB_USERNAME: 'alice',
      ANYFUSION_WEB_PASSWORD: 'secret-password',
    });

    expect(credentials.username).toBe('alice');
    expect(credentials.builtInDefault).toBe(false);
    expect(verifyLogin('alice', 'secret-password', credentials)).toBe(true);
    expect(verifyLogin('alice', 'wrong', credentials)).toBe(false);
    expect(verifyLogin('bob', 'secret-password', credentials)).toBe(false);
  });

  it('supports scrypt password hashes instead of plaintext', () => {
    const hash = scryptHash('plain-secret');
    const credentials = resolveLoginCredentials({
      ANYFUSION_WEB_USERNAME: 'carol',
      ANYFUSION_WEB_PASSWORD_HASH: hash,
    });

    expect(credentials.passwordHash).toBe(hash);
    expect(credentials.builtInDefault).toBe(false);
    expect(verifyLogin('carol', 'plain-secret', credentials)).toBe(true);
    expect(verifyLogin('carol', 'other-secret', credentials)).toBe(false);
  });

  it('keeps the built-in credentials fixed instead of generating a password', () => {
    const first = resolveLoginCredentials({});
    const second = resolveLoginCredentials({});

    expect(first.username).toBe('admin');
    expect(first.password).toBe('123456');
    expect(first.builtInDefault).toBe(true);
    // 登录信息永不随机生成：两次解析必须完全一致。
    expect(second).toEqual(first);
    expect(verifyLogin('admin', '123456', first)).toBe(true);
  });

  it('honors a configured username while reporting the built-in password default', () => {
    const credentials = resolveLoginCredentials({ ANYFUSION_WEB_USERNAME: 'admin' });

    expect(credentials.username).toBe('admin');
    expect(credentials.password).toBe('123456');
    expect(credentials.builtInDefault).toBe(true);
  });
});
```

**Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/management/login-credentials.test.ts`
Expected: FAIL because `builtInDefault` is `undefined` and the default password
is a random 8-character string.

**Step 3: Implement the fixed resolution order**

Replace the body of `src/management/login-credentials.ts`:

```ts
import { scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Web 工作台账密登录凭据（单账号，服务端预设）。
 *
 * 凭据来源优先级：
 * 1. `ANYFUSION_WEB_USERNAME` + `ANYFUSION_WEB_PASSWORD_HASH`（scrypt，格式 `saltHex:hashHex`）
 * 2. `ANYFUSION_WEB_USERNAME` + `ANYFUSION_WEB_PASSWORD`（明文）
 * 3. 内置默认 `admin` / `123456`
 *
 * 内置默认值与 `metawork.sh`、`src/installation/native-launcher.ts` 一致。
 * 凭据永不随机生成：登录信息只能由用户显式修改，Server 不得擅自变更。
 */

const USERNAME_PATTERN = /^[\w.@-]{1,64}$/u;
const BUILT_IN_USERNAME = 'admin';
const BUILT_IN_PASSWORD = '123456';

export interface LoginCredentials {
  readonly username: string;
  /** 明文密码；仅在未配置 hash 时存在。 */
  readonly password?: string;
  /** scrypt hash（`saltHex:hashHex`）；优先于明文密码。 */
  readonly passwordHash?: string;
  /** 是否仍在使用内置默认密码（仅用于启动提示，不代表凭据被生成）。 */
  readonly builtInDefault: boolean;
}

export interface LoginCredentialsEnv {
  ANYFUSION_WEB_USERNAME?: string;
  ANYFUSION_WEB_PASSWORD?: string;
  ANYFUSION_WEB_PASSWORD_HASH?: string;
}

export function resolveLoginCredentials(env: LoginCredentialsEnv): LoginCredentials {
  const username = normalizeUsername(env.ANYFUSION_WEB_USERNAME) ?? BUILT_IN_USERNAME;
  if (env.ANYFUSION_WEB_PASSWORD_HASH) {
    assertHashFormat(env.ANYFUSION_WEB_PASSWORD_HASH);
    return {
      username,
      passwordHash: env.ANYFUSION_WEB_PASSWORD_HASH,
      builtInDefault: false,
    };
  }
  if (env.ANYFUSION_WEB_PASSWORD) {
    return {
      username,
      password: env.ANYFUSION_WEB_PASSWORD,
      builtInDefault: false,
    };
  }
  return {
    username,
    password: BUILT_IN_PASSWORD,
    builtInDefault: true,
  };
}

export function verifyLogin(
  username: string,
  password: string,
  credentials: LoginCredentials,
): boolean {
  if (!safeEquals(credentials.username, normalizeUsername(username) ?? '\0')) {
    return false;
  }
  if (credentials.passwordHash) {
    const [saltHex, expectedHex] = credentials.passwordHash.split(':');
    if (!saltHex || !expectedHex) return false;
    try {
      const salt = Buffer.from(saltHex, 'hex');
      const actual = scryptSync(password, salt, 32);
      const expected = Buffer.from(expectedHex, 'hex');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
  return safeEquals(credentials.password ?? '\0', password);
}

function safeEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) {
    // 长度不同也要消耗一次比较，避免通过耗时区分长度。
    timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function normalizeUsername(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed || !USERNAME_PATTERN.test(trimmed)) return null;
  return trimmed.toLocaleLowerCase();
}

function assertHashFormat(hash: string): void {
  const parts = hash.split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/u.test(parts[0]!) || !/^[0-9a-f]{64}$/u.test(parts[1]!)) {
    throw new Error(
      'ANYFUSION_WEB_PASSWORD_HASH must be formatted as "<scryptSaltHex>:<scryptHashHex>" (16-byte salt, 32-byte key).',
    );
  }
}
```

**Step 4: Update the startup notice**

In `src/server/server-composition.ts`, inside `startWebMode`, replace the
generated-password block:

```ts
  const loginCredentials = resolveLoginCredentials(process.env);
  if (loginCredentials.builtInDefault) {
    process.stdout.write(
      'MetaWork Web 正在使用内置登录凭据 admin / 123456；'
      + '请通过 ANYFUSION_WEB_USERNAME 与 ANYFUSION_WEB_PASSWORD(_HASH) 修改。\n',
    );
  }
```

**Step 5: Run the tests and the type check**

Run: `npm test -- --run tests/management/login-credentials.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no errors. Any remaining reference to `generateLoginCredentials` must
be removed; confirm with
`grep -rn "generateLoginCredentials" src tests`.

**Step 6: Commit**

```bash
git add src/management/login-credentials.ts src/server/server-composition.ts \
  tests/management/login-credentials.test.ts
git commit -m "fix(web): keep built-in login credentials fixed at admin/123456"
```

---

### Task 2: Stop launch tokens from authenticating

**Files:**
- Modify: `src/management/web-auth.ts`
- Test: `tests/management/web-auth.test.ts`

**Step 1: Rewrite the failing tests**

Replace `tests/management/web-auth.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { WebAuthService } from '../../src/management/web-auth.js';

describe('WebAuthService', () => {
  it('rejects an issued launch token as a login credential', () => {
    const auth = new WebAuthService({ manualAccessToken: 'manual-token' });

    expect(auth.exchange('launch-token')).toBeNull();
    expect(auth.getSession('anyfusion_web_session=launch-token')).toBeNull();
  });

  it('keeps manual login reusable without fabricating a launch context', () => {
    let counter = 0;
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      createSessionToken: () => `session-token-${counter += 1}`,
    });

    const first = auth.exchange('manual-token');
    const second = auth.exchange('manual-token');
    expect(first).toEqual({
      sessionToken: 'session-token-1',
      clientId: 'session-token-1',
    });
    expect(second).toEqual({
      sessionToken: 'session-token-2',
      clientId: 'session-token-2',
    });
    expect(auth.getSession('anyfusion_web_session=session-token-1')).toEqual({
      clientId: 'session-token-1',
    });
  });

  it('formats, validates, isolates, and revokes HttpOnly session cookies', () => {
    const tokens = ['session-token-a', 'session-token-b'];
    const auth = new WebAuthService({
      manualAccessToken: 'manual-token',
      createSessionToken: () => tokens.shift()!,
    });

    const first = auth.createSession();
    expect(first.clientId).toBe('session-token-a');
    expect(auth.sessionCookie(first.sessionToken)).toBe(
      'anyfusion_web_session=session-token-a; HttpOnly; SameSite=Strict; Path=/',
    );
    expect(auth.getSession('anyfusion_web_session=session-token-a')).toEqual({
      clientId: 'session-token-a',
    });
    expect(auth.hasSession('anyfusion_web_session=unknown')).toBe(false);
    expect(auth.clearSessionCookie()).toBe(
      'anyfusion_web_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );

    auth.revokeSession('anyfusion_web_session=session-token-a');
    expect(auth.getSession('anyfusion_web_session=session-token-a')).toBeNull();
    expect(auth.getSession('anyfusion_web_session=session-token-b')).toBeNull();
  });
});
```

**Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/management/web-auth.test.ts`
Expected: FAIL — `launch-token` still creates a session, and `createSession()`
still accepts an argument.

**Step 3: Remove the launch-context branch**

In `src/management/web-auth.ts`:

1. Delete the `launchContexts` option and the `WebLaunchContextService` import.
2. Delete `launchContext` from `WebAuthSessionState`.
3. Replace `exchange` and `createSession`:

```ts
export interface WebAuthServiceOptions {
  manualAccessToken?: string;
  createSessionToken?: () => string;
}

export interface WebAuthSessionState {
  readonly clientId: string;
}

export interface WebAuthExchangeResult extends WebAuthSessionState {
  readonly sessionToken: string;
}
```

```ts
  exchange(token: string): WebAuthExchangeResult | null {
    // 启动提示 token 不是登录凭据：只有手动访问 token 能换取会话。
    if (!tokenMatches(this.manualAccessToken, token)) return null;
    return this.createSession();
  }

  createSession(): WebAuthExchangeResult {
    const sessionToken = this.uniqueSessionToken();
    const state: WebAuthSessionState = { clientId: sessionToken };
    this.sessions.set(sessionToken, state);
    return { sessionToken, ...state };
  }
```

**Step 4: Update the construction sites**

In `src/server/server-composition.ts`:
`const webAuth = new WebAuthService({ launchContexts: webLaunchContexts });`
becomes
`const webAuth = new WebAuthService();`

Keep `const webLaunchContexts = new WebLaunchContextService();` — Task 3 wires it
into the Server.

In `tests/management/server.test.ts`, inside `createManagementServer`, replace the
`WebAuthService` construction:

```ts
  const webAuth = new WebAuthService({
    manualAccessToken: 'manual-token',
    createSessionToken: () => `session-token-${sessionCounter += 1}`,
  });
```

Leave the `launchContexts` override field in place; it is used again in Task 3.

**Step 5: Run the tests**

Run: `npm test -- --run tests/management/web-auth.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no errors.

**Step 6: Commit**

```bash
git add src/management/web-auth.ts src/server/server-composition.ts \
  tests/management/web-auth.test.ts tests/management/server.test.ts
git commit -m "fix(web): stop treating launch tokens as login credentials"
```

---

### Task 3: Serve launch hints from a dedicated unauthenticated endpoint

**Files:**
- Modify: `src/management/server.ts`
- Modify: `src/management/web-session-runtime-types.ts`
- Modify: `src/management/web-gateway-session-runtime.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/management/server.test.ts`
- Test: `tests/management/web-gateway-session-runtime.test.ts`

**Step 1: Write the failing endpoint tests**

In `tests/management/server.test.ts`, replace the
`binds an automatic launch context to one session cookie and consumes its token once`
and `isolates launch contexts between browser sessions` tests with:

```ts
  it('serves a launch Workspace hint without authenticating the caller', async () => {
    const port = await reservePort();
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'launch-token',
    });
    const launch = launchContexts.issue({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    const server = createManagementServer(port, { launchContexts });
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth/launch-context`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({ token: launch.token }),
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        workspaceHint: '/repo-a',
        conversationId: 'conv_1',
      });
      // 提示端点不得下发会话 cookie。
      expect(response.headers.get('set-cookie')).toBeNull();
      // 一次性消费。
      const reused = await fetch(
        `http://127.0.0.1:${port}/api/auth/launch-context`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: `http://127.0.0.1:${port}`,
          },
          body: JSON.stringify({ token: launch.token }),
        },
      );
      expect(reused.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('rejects launch hint requests from a foreign browser origin', async () => {
    const port = await reservePort();
    const server = createManagementServer(port);
    await server.start();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/auth/launch-context`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://attacker.example',
          },
          body: JSON.stringify({ token: 'whatever' }),
        },
      );
      expect(response.status).toBe(403);
    } finally {
      await server.stop();
    }
  });
```

Then replace the
`uses the authenticated browser launch hint only for initial and newly created Conversations`
test with a test proving the Server no longer applies a launch hint on login:

```ts
  it('does not apply a launch hint during login', async () => {
    const port = await reservePort();
    const launchContexts = new WebLaunchContextService({
      generateToken: () => 'launch-browser',
    });
    const launch = launchContexts.issue({ workspaceHint: '/repo-browser' });
    const server = createManagementServer(port, { launchContexts });
    await server.start();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ token: launch.token }),
      });
      // 启动提示 token 不再能换取会话。
      expect(response.status).toBe(401);
      const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ username: 'admin', password: 'test-password' }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('set-cookie')!.split(';', 1)[0]!;
      const session = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
        headers: { cookie },
      });
      await expect(session.json()).resolves.toEqual({ authenticated: true });
    } finally {
      await server.stop();
    }
  });
```

Also update `logs in with username and password, locks after repeated failures`:
change `expect(ok.status).toBe(204)` to `expect(ok.status).toBe(200)` and change
the `/api/auth/session` expectation to `{ authenticated: true }`.

**Step 2: Run the tests and verify they fail**

Run: `npm test -- --run tests/management/server.test.ts`
Expected: FAIL — `/api/auth/launch-context` returns 404, login returns 204, and
`/api/auth/session` still returns `launchContext`.

**Step 3: Add the endpoint and drop the session launch context**

In `src/management/server.ts`:

1. Add the dependency to `ManagementServerDeps`:

```ts
  /** 启动目录提示；仅由未鉴权的 /api/auth/launch-context 读取。 */
  launchContexts: WebLaunchContextService;
```

2. Import it: `import type { WebLaunchContextService } from './web-launch-context.js';`

3. Replace the `/api/auth/bootstrap` handler body so it only exchanges the manual
   token:

```ts
    if (request.method === 'POST' && url.pathname === '/api/auth/bootstrap') {
      if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
        this.sendJson(response, 403, { error: 'forbidden_origin' });
        return;
      }
      const body = await readRequestBody(request);
      const session = body.token ? this.deps.webAuth.exchange(body.token) : null;
      if (!session) {
        this.sendJson(response, 401, { error: 'unauthorized' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': this.deps.webAuth.sessionCookie(session.sessionToken),
      });
      response.end(`${JSON.stringify({ authenticated: true })}\n`);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/launch-context') {
      if (!this.isAllowedWebSocketOrigin(request.headers.origin)) {
        this.sendJson(response, 403, { error: 'forbidden_origin' });
        return;
      }
      const body = await readRequestBody(request);
      const token = typeof body.token === 'string' ? body.token.trim() : '';
      if (!token) {
        this.sendJson(response, 400, { error: 'launch token is required' });
        return;
      }
      const launch = this.deps.launchContexts.consume(token);
      if (!launch) {
        this.sendJson(response, 404, { error: 'launch_context_unavailable' });
        return;
      }
      // 只返回目录提示，绝不建立会话。
      this.sendJson(response, 200, {
        workspaceHint: launch.workspaceHint,
        ...(launch.conversationId ? { conversationId: launch.conversationId } : {}),
      });
      return;
    }
```

4. Change `/api/auth/login` to return the authenticated payload. In
   `handleLogin`, replace

```ts
    const session = this.deps.webAuth.createSession();
    response.writeHead(204, {
      'Set-Cookie': this.deps.webAuth.sessionCookie(session.sessionToken),
    });
    response.end();
```

with

```ts
    const session = this.deps.webAuth.createSession();
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': this.deps.webAuth.sessionCookie(session.sessionToken),
    });
    response.end(`${JSON.stringify({ authenticated: true })}\n`);
```

5. Simplify `/api/auth/session` to `this.sendJson(response, 200, { authenticated: true });`

In `src/management/web-session-runtime-types.ts`, delete the
`initializeClient` member from `ManagementWebSessionRuntime` and drop the now
unused `WebLaunchContextInput` import.

In `src/management/web-gateway-session-runtime.ts`:

1. Delete `WebGatewaySessionRuntime.initializeClient` and
   `WebGatewayClientSession.initializeClient`.
2. Delete the now-unused `initializeWorkspace` caller branch and the
   `WebLaunchContextInput`/`WorkspaceInitializationResult` imports that become
   unused (`initializeWorkspace` itself stays; `selectWorkspace` still uses it).
3. In `WebGatewayClientSession.selectWorkspace`, keep the existing
   `enqueueNavigation(() => this.initializeWorkspace(path))`.

In `src/server/server-composition.ts`, pass the service into the Server:

```ts
  const managementServer = new ManagementServer({
    port: options.port,
    webDistDir,
    token: options.webAuth.manualAccessToken,
    webAuth: options.webAuth,
    launchContexts: options.launchContexts,
    ...
```

and add `launchContexts: WebLaunchContextService;` to `startWebMode`'s options
type plus `launchContexts: webLaunchContexts` at its call site.

In `tests/management/server.test.ts`, add
`launchContexts: overrides.launchContexts ?? new WebLaunchContextService(),` to
the `new ManagementServer({...})` call and delete
`async initializeClient() { return { status: 'not_requested' }; },` from
`createSessionRuntime`.

**Step 4: Run the tests**

Run: `npm test -- --run tests/management/server.test.ts`
Expected: PASS

Run: `npm test -- --run tests/management/web-gateway-session-runtime.test.ts`
Expected: PASS. If the file references `initializeClient`, replace those call
sites with `selectWorkspace`.

Run: `npm run lint`
Expected: no errors.

**Step 5: Commit**

```bash
git add src/management/server.ts src/management/web-session-runtime-types.ts \
  src/management/web-gateway-session-runtime.ts src/server/server-composition.ts \
  tests/management/server.test.ts tests/management/web-gateway-session-runtime.test.ts
git commit -m "refactor(web): serve launch workspace hints without a session"
```

---

### Task 4: Open the browser with a launch hint instead of a login token

**Files:**
- Modify: `src/client/web-client-launcher.ts`
- Modify: `src/management/token.ts`
- Test: `tests/client/web-client-launcher.test.ts`
- Delete: `tests/management/token.test.ts`

**Step 1: Rewrite the failing test**

Replace both test bodies in `tests/client/web-client-launcher.test.ts` so the
expected URL fragment is `#launch=`:

```ts
    expect(open).toHaveBeenCalledWith(
      'http://127.0.0.1:8788/#launch=opaque-launch-token',
    );
```

```ts
    await expect(launcher.start({ conversationId: undefined, noOpen: true })).resolves.toBe(
      'http://127.0.0.1:8788/#launch=opaque-launch-token',
    );
```

and rename the mocked `token: 'opaque-bootstrap-token'` values to
`token: 'opaque-launch-token'`.

**Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/client/web-client-launcher.test.ts`
Expected: FAIL — the fragment is still `#bootstrap=`.

**Step 3: Update the launcher**

In `src/client/web-client-launcher.ts`, replace the URL construction:

```ts
    // 启动提示不是登录凭据：仅携带本机目录建议，浏览器仍需用户登录。
    const url = `${endpoint.webOrigin.replace(/\/+$/u, '')}/#launch=${encodeURIComponent(launch.token)}`;
```

**Step 4: Delete the dead startup presentation helper**

`buildWebStartupPresentation` in `src/management/token.ts` is unused production
code. Delete the function and the whole of `tests/management/token.test.ts`, and
delete the now-unused `bootstrap` parameters it introduced. Keep
`generateToken`, `formatWebAccessTokenLine`, `tokenMatches`, and
`bearerTokenFromHeader`.

**Step 5: Run the tests**

Run: `npm test -- --run tests/client/web-client-launcher.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no errors.

**Step 6: Commit**

```bash
git add src/client/web-client-launcher.ts src/management/token.ts \
  tests/client/web-client-launcher.test.ts
git rm tests/management/token.test.ts
git commit -m "feat(web): open the browser with a launch hint instead of a login token"
```

---

### Task 5: Build the server-side directory browser

**Files:**
- Create: `src/management/workspace-directory-browser.ts`
- Test: `tests/management/workspace-directory-browser.test.ts`

**Step 1: Write the failing test**

Create `tests/management/workspace-directory-browser.test.ts`:

```ts
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceDirectoryBrowser } from '../../src/management/workspace-directory-browser.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workspace-browser-'));
  roots.push(root);
  for (const name of ['zeta', 'alpha', 'Beta']) {
    await mkdir(join(root, name));
  }
  await writeFile(join(root, 'notes.txt'), 'not a directory');
  await symlink(join(root, 'alpha'), join(root, 'linked-alpha'));
  await symlink(join(root, 'notes.txt'), join(root, 'linked-file'));
  return root;
}

describe('WorkspaceDirectoryBrowser', () => {
  it('lists directories only, sorted and with the realpath-resolved path', async () => {
    const root = await fixture();
    // /var 在 macOS 上是 /private/var 的符号链接：realpath 必须被应用。
    const browser = new WorkspaceDirectoryBrowser();
    const result = await browser.browse(root);

    expect(result.path).not.toContain('/../');
    expect(result.entries.map(entry => entry.name)).toEqual([
      'alpha',
      'Beta',
      'linked-alpha',
      'zeta',
    ]);
    expect(result.entries.every(entry => entry.path.startsWith(result.path))).toBe(true);
    expect(result.entries.map(entry => entry.name)).not.toContain('notes.txt');
    expect(result.entries.map(entry => entry.name)).not.toContain('linked-file');
  });

  it('reports the parent directory and clamps the filesystem root', async () => {
    const browser = new WorkspaceDirectoryBrowser();
    const root = await browser.browse('/');

    expect(root.path).toBe('/');
    expect(root.parent).toBeNull();
  });

  it('returns the default path when no path is requested', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ defaultPath: () => root });

    await expect(browser.browse()).resolves.toMatchObject({ path: root });
  });

  it('caps the number of returned entries', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser({ maxEntries: 2 });

    const result = await browser.browse(root);

    expect(result.entries).toHaveLength(2);
  });

  it('rejects relative, missing, file, and unreadable paths', async () => {
    const root = await fixture();
    const browser = new WorkspaceDirectoryBrowser();

    await expect(browser.browse('relative/path')).rejects.toThrow('browse_path_invalid');
    await expect(browser.browse(join(root, 'missing'))).rejects.toThrow('browse_path_not_found');
    await expect(browser.browse(join(root, 'notes.txt'))).rejects.toThrow('browse_path_invalid');
  });
});
```

**Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/management/workspace-directory-browser.test.ts`
Expected: FAIL with "Failed to resolve import
`../../src/management/workspace-directory-browser.js`".

**Step 3: Implement the module**

Create `src/management/workspace-directory-browser.ts`:

```ts
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

export const MAX_BROWSE_ENTRIES = 500;

export interface WorkspaceBrowseEntry {
  readonly name: string;
  readonly path: string;
}

export interface WorkspaceBrowseResult {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: WorkspaceBrowseEntry[];
}

export interface WorkspaceDirectoryBrowserDeps {
  readonly defaultPath?: () => string;
  readonly maxEntries?: number;
}

/**
 * 只读目录列举，供未创建的 Workspace 选择使用。
 *
 * 根策略为 `/`：允许向上导航到文件系统根，不排除任何目录。所有返回路径都
 * 经过 realpath 归一化，保证浏览器展示的路径与 Server 后续授权的路径一致。
 * 这里只增加“可发现性”，不增加授权能力：select_workspace 本来就接受任意
 * 存在的绝对目录。
 */
export class WorkspaceDirectoryBrowser {
  private readonly defaultPath: () => string;
  private readonly maxEntries: number;

  constructor(deps: WorkspaceDirectoryBrowserDeps = {}) {
    this.defaultPath = deps.defaultPath ?? homedir;
    this.maxEntries = deps.maxEntries ?? MAX_BROWSE_ENTRIES;
  }

  async browse(requestedPath?: string): Promise<WorkspaceBrowseResult> {
    const candidate = requestedPath?.trim() || this.defaultPath();
    if (!isAbsolute(candidate)) throw new Error('browse_path_invalid');
    const canonical = await resolveCanonical(candidate);
    const info = await stat(canonical).catch(() => null);
    if (!info) throw new Error('browse_path_not_found');
    if (!info.isDirectory()) throw new Error('browse_path_invalid');
    const dirents = await readdir(canonical, { withFileTypes: true }).catch(error => {
      throw mapReadError(error);
    });
    const names = dirents
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort(compareNames)
      .slice(0, this.maxEntries);
    const entries: WorkspaceBrowseEntry[] = [];
    for (const name of names) {
      // 符号链接必须解析后确认是目录，避免把文件链接展示成可选项。
      const child = await stat(resolve(canonical, name)).catch(() => null);
      if (!child?.isDirectory()) continue;
      entries.push({ name, path: resolve(canonical, name) });
    }
    return {
      path: canonical,
      parent: canonical === dirname(canonical) ? null : dirname(canonical),
      entries,
    };
  }
}

async function resolveCanonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw mapReadError(error);
  }
}

function mapReadError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new Error('browse_path_not_found');
  if (code === 'EACCES' || code === 'EPERM') return new Error('browse_path_forbidden');
  return new Error('browse_path_invalid');
}

function compareNames(left: string, right: string): number {
  const normalized = left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
  return normalized !== 0 ? normalized : left.localeCompare(right);
}
```

**Step 4: Run the tests**

Run: `npm test -- --run tests/management/workspace-directory-browser.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no errors.

**Step 5: Commit**

```bash
git add src/management/workspace-directory-browser.ts \
  tests/management/workspace-directory-browser.test.ts
git commit -m "feat(web): add a read-only workspace directory browser"
```

---

### Task 6: Expose the directory browser over the management API

**Files:**
- Modify: `src/management/server.ts`
- Modify: `src/server/server-composition.ts`
- Test: `tests/management/server.test.ts`

**Step 1: Write the failing tests**

Add to `tests/management/server.test.ts`:

```ts
  it('browses directories for cookie sessions only', async () => {
    const port = await reservePort();
    const root = await mkdtemp(join(tmpdir(), 'browse-endpoint-'));
    await mkdir(join(root, 'repo'));
    const browser = new WorkspaceDirectoryBrowser({ defaultPath: () => root });
    const server = createManagementServer(port, { workspaceDirectoryBrowser: browser });
    await server.start();

    try {
      // Bearer token 共享 clientId，无法界定“谁在浏览服务器目录”。
      const bearer = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/browse`,
        { headers: { authorization: 'Bearer manual-token' } },
      );
      expect(bearer.status).toBe(403);

      const cookie = await exchangeToken(port, 'manual-token');
      const response = await fetch(
        `http://127.0.0.1:${port}/api/workspaces/browse`,
        { headers: { cookie } },
      );
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        path: string;
        parent: string | null;
        entries: Array<{ name: string }>;
      };
      expect(payload.path).toBe(await realpath(root));
      expect(payload.entries.map(entry => entry.name)).toEqual(['repo']);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps browse failures onto HTTP status codes', async () => {
    const port = await reservePort();
    const root = await mkdtemp(join(tmpdir(), 'browse-errors-'));
    const server = createManagementServer(port, {
      workspaceDirectoryBrowser: new WorkspaceDirectoryBrowser({ defaultPath: () => root }),
    });
    await server.start();

    try {
      const cookie = await exchangeToken(port, 'manual-token');
      const browse = (path: string) => fetch(
        `http://127.0.0.1:${port}/api/workspaces/browse?path=${encodeURIComponent(path)}`,
        { headers: { cookie } },
      );

      expect((await browse('relative')).status).toBe(400);
      expect((await browse(join(root, 'missing'))).status).toBe(404);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
```

Add the needed imports at the top of the test file:
`realpath` from `node:fs/promises` (extend the existing import),
`mkdir`/`rm` if not already imported, and
`import { WorkspaceDirectoryBrowser } from '../../src/management/workspace-directory-browser.js';`.

Add `readonly workspaceDirectoryBrowser?: WorkspaceDirectoryBrowser;` to
`ManagementServerTestOverrides` and pass it through in `createManagementServer`.

**Step 2: Run the tests and verify they fail**

Run: `npm test -- --run tests/management/server.test.ts`
Expected: FAIL — `/api/workspaces/browse` returns 404.

**Step 3: Add the endpoint**

In `src/management/server.ts`:

1. Import the browser:
   `import { WorkspaceDirectoryBrowser } from './workspace-directory-browser.js';`
2. Add to `ManagementServerDeps`:
   `workspaceDirectoryBrowser: WorkspaceDirectoryBrowser;`
3. Add the handler immediately before the `/api/workspaces/select` handler:

```ts
    if (request.method === 'GET' && url.pathname === '/api/workspaces/browse') {
      // 目录枚举只对浏览器 cookie 会话开放：manual-bearer-client 是共享身份。
      if (!authSession) {
        this.sendJson(response, 403, { error: 'cookie_session_required' });
        return;
      }
      try {
        const result = await this.deps.workspaceDirectoryBrowser.browse(
          url.searchParams.get('path') ?? undefined,
        );
        this.sendJson(response, 200, result);
      } catch (error) {
        const code = (error as Error).message;
        const status = code === 'browse_path_forbidden'
          ? 403
          : code === 'browse_path_not_found' ? 404 : 400;
        this.sendJson(response, status, { error: code });
      }
      return;
    }
```

In `src/server/server-composition.ts`, pass
`workspaceDirectoryBrowser: new WorkspaceDirectoryBrowser(),` to the
`new ManagementServer({...})` call inside `startWebMode`.

**Step 4: Run the tests**

Run: `npm test -- --run tests/management/server.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no errors.

**Step 5: Commit**

```bash
git add src/management/server.ts src/server/server-composition.ts \
  tests/management/server.test.ts
git commit -m "feat(web): expose a cookie-only workspace directory browse endpoint"
```

---

### Task 7: Resolve the launch suggestion in the Web client

**Files:**
- Modify: `web/src/auth.ts`
- Test: `tests/web/auth.test.ts`

**Step 1: Rewrite the failing tests**

In `tests/web/auth.test.ts`, replace the import block and the first two tests:

```ts
import {
  clearLaunchFragment,
  exchangeWebCredential,
  launchTokenFromHash,
  resolveWebLaunchSuggestion,
} from '../../web/src/auth.js';
```

```ts
  it('extracts the launch hint token from the fragment and removes it', () => {
    expect(launchTokenFromHash('#launch=token%20value')).toBe('token value');
    const replaceState = vi.fn();

    clearLaunchFragment(
      { pathname: '/settings', search: '?tab=models' },
      { replaceState },
    );

    expect(replaceState).toHaveBeenCalledWith(null, '', '/settings?tab=models');
  });

  it('exchanges a launch hint without creating a session', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('window', { location: { hash: '#launch=launch-token' } });
    vi.stubGlobal('history', { replaceState: vi.fn() });

    await expect(resolveWebLaunchSuggestion(fetchImpl)).resolves.toEqual({
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/launch-context', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'launch-token' }),
    });
  });

  it('ignores an expired or already consumed launch hint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('window', { location: { hash: '#launch=stale' } });
    vi.stubGlobal('history', { replaceState: vi.fn() });

    await expect(resolveWebLaunchSuggestion(fetchImpl)).resolves.toBeNull();
  });
```

Update the `exchanges a credential without browser storage` test expectation to:

```ts
    await expect(exchangeWebCredential('manual-token', fetchImpl)).resolves.toEqual({
      authenticated: true,
    });
```

and its mocked response body to `{ authenticated: true }`.

**Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/web/auth.test.ts`
Expected: FAIL — `launchTokenFromHash` and `resolveWebLaunchSuggestion` do not
exist.

**Step 3: Implement the launch suggestion**

In `web/src/auth.ts`, replace `WebLaunchContext`, `bootstrapTokenFromHash`,
`clearBootstrapFragment`, and `establishWebSession`:

```ts
export interface WebLaunchSuggestion {
  workspaceHint: string;
  conversationId?: string;
}

export interface WebAuthSession {
  authenticated: true;
}

export function launchTokenFromHash(hash = window.location.hash): string | null {
  return new URLSearchParams(hash.replace(/^#/u, '')).get('launch');
}

export function clearLaunchFragment(
  location: Pick<Location, 'pathname' | 'search'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
): void {
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

/**
 * 启动目录提示：一次性、60 秒有效、未鉴权，只返回本机目录建议。
 * 它不能建立会话，因此不构成免密登录。
 */
export async function resolveWebLaunchSuggestion(
  fetchImpl: FetchLike = fetch,
): Promise<WebLaunchSuggestion | null> {
  const token = launchTokenFromHash();
  if (!token) return null;
  clearLaunchFragment();
  const response = await fetchImpl('/api/auth/launch-context', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (response.status === 400 || response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json() as Promise<WebLaunchSuggestion>;
}

export async function establishWebSession(): Promise<WebAuthSession | null> {
  return hasWebSession();
}
```

**Step 4: Run the tests**

Run: `npm test -- --run tests/web/auth.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add web/src/auth.ts tests/web/auth.test.ts
git commit -m "feat(web): resolve launch workspace hints in the browser client"
```

---

### Task 8: Add the Web Workspace creator

**Files:**
- Modify: `web/src/api/http.ts`
- Create: `web/src/components/WorkspaceCreator.tsx`
- Modify: `web/src/components/WorkspaceSelector.tsx`
- Modify: `web/src/components/SessionSidebar.tsx`
- Modify: `web/src/components/WorkspaceShell.tsx`
- Modify: `web/src/components/WorkspaceHeader.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Test: `tests/web/workspace-shell.test.ts`

**Step 1: Write the failing contract test**

Add to `tests/web/workspace-shell.test.ts`:

```ts
  it('creates a Workspace by browsing local directories', async () => {
    const [app, sidebar, selector, creator, http, styles] = await Promise.all([
      readFile(new URL('App.tsx', root), 'utf8'),
      readFile(new URL('components/SessionSidebar.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceSelector.tsx', root), 'utf8'),
      readFile(new URL('components/WorkspaceCreator.tsx', root), 'utf8'),
      readFile(new URL('api/http.ts', root), 'utf8'),
      readFile(new URL('styles.css', root), 'utf8'),
    ]);

    // 侧栏 Workspace 卡片提供创建入口。
    expect(selector).toContain('onCreateWorkspace');
    expect(selector).toContain('workspace-create-button');
    expect(sidebar).toContain('onCreateWorkspace');
    expect(app).toContain('workspaceCreatorOpen');
    expect(app).toContain('<WorkspaceCreator');

    // 目录浏览器只通过浏览选择，不接受手输路径。
    expect(http).toContain('/api/workspaces/browse');
    expect(creator).toContain('browseWorkspaceDirectory');
    expect(creator).toContain('选择此目录');
    expect(creator).toContain('onSelect');
    expect(creator).not.toContain('<input');
    for (const code of [
      'browse_path_invalid',
      'browse_path_forbidden',
      'browse_path_not_found',
    ]) {
      expect(creator).toContain(code);
    }

    expect(styles).toContain('.workspace-creator');
    expect(styles).toContain('.workspace-create-button');
  });

  it('applies a launch hint only after authentication', async () => {
    const app = await readFile(new URL('App.tsx', root), 'utf8');

    expect(app).toContain('resolveWebLaunchSuggestion');
    expect(app).toContain('applyStartupLaunchSuggestion');
    expect(app).not.toContain('startupLaunchContext');
  });
```

**Step 2: Run the test and verify it fails**

Run: `npm test -- --run tests/web/workspace-shell.test.ts`
Expected: FAIL — `components/WorkspaceCreator.tsx` does not exist.

**Step 3: Add the HTTP method**

In `web/src/api/http.ts`, add after `getWorkspaces()`:

```ts
  browseWorkspaceDirectory(path?: string): Promise<{
    path: string;
    parent: string | null;
    entries: Array<{ name: string; path: string }>;
  }> {
    const suffix = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : '';
    return this.request(`/api/workspaces/browse${suffix}`);
  }
```

**Step 4: Add the creator component**

Create `web/src/components/WorkspaceCreator.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { HttpClient } from '../api/http';

interface BrowseState {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
}

export function WorkspaceCreator({
  http,
  open,
  disabled = false,
  onClose,
  onSelect,
}: {
  http: HttpClient | null;
  open: boolean;
  disabled?: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [state, setState] = useState<BrowseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !http) return;
    let active = true;
    setLoading(true);
    setError(null);
    void http.browseWorkspaceDirectory()
      .then(result => { if (active) setState(result); })
      .catch((cause: Error) => { if (active) setError(browseErrorLabel(cause.message)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, http]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const openPath = (path: string) => {
    if (!http || loading || disabled) return;
    setLoading(true);
    setError(null);
    void http.browseWorkspaceDirectory(path)
      .then(result => setState(result))
      .catch((cause: Error) => setError(browseErrorLabel(cause.message)))
      .finally(() => setLoading(false));
  };

  const segments = (state?.path ?? '').split('/').filter(Boolean);

  return (
    <div className="workspace-creator-backdrop" onClick={onClose}>
      <div
        className="workspace-creator"
        role="dialog"
        aria-label="添加 Workspace"
        onClick={event => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="workspace-creator-kicker">ADD WORKSPACE</span>
            <h2>选择本机目录</h2>
          </div>
          <button type="button" className="ghost-button" onClick={onClose}>关闭</button>
        </header>
        <nav className="workspace-creator-path" aria-label="当前目录">
          <button type="button" onClick={() => openPath('/')}>/</button>
          {segments.map((segment, index) => (
            <button
              key={`${segment}-${index}`}
              type="button"
              onClick={() => openPath(`/${segments.slice(0, index + 1).join('/')}`)}
            >
              {segment}
            </button>
          ))}
        </nav>
        {error && <div className="result-banner result-error">{error}</div>}
        <div className="workspace-creator-list">
          {state?.parent && (
            <button
              type="button"
              className="workspace-creator-row"
              onClick={() => openPath(state.parent!)}
            >
              <span aria-hidden="true">↰</span>
              <strong>.. 上级目录</strong>
            </button>
          )}
          {state?.entries.map(entry => (
            <button
              type="button"
              className="workspace-creator-row"
              key={entry.path}
              onClick={() => openPath(entry.path)}
            >
              <span aria-hidden="true">▸</span>
              <strong>{entry.name}</strong>
            </button>
          ))}
          {!loading && !error && state?.entries.length === 0 && !state.parent && (
            <div className="workspace-creator-empty">该目录下没有子目录</div>
          )}
          {loading && <div className="workspace-creator-empty">正在读取目录…</div>}
        </div>
        <footer>
          <code title={state?.path}>{state?.path ?? ''}</code>
          <button
            type="button"
            className="primary-button"
            disabled={!state || loading || disabled}
            onClick={() => { if (state) onSelect(state.path); }}
          >
            选择此目录
          </button>
        </footer>
      </div>
    </div>
  );
}

function browseErrorLabel(code: string): string {
  if (code.includes('browse_path_forbidden')) return '没有权限读取该目录。';
  if (code.includes('browse_path_not_found')) return '目录不存在或已被移动。';
  if (code.includes('browse_path_invalid')) return '该路径不是可用的目录。';
  return `读取目录失败：${code}`;
}
```

**Step 5: Wire the entry points**

`web/src/components/WorkspaceSelector.tsx`: add `onCreateWorkspace` to props and
wrap the label:

```tsx
      <div className="workspace-selector-head">
        <label htmlFor="workspace-select">Workspace</label>
        <button
          type="button"
          className="workspace-create-button"
          aria-label="添加 Workspace"
          title="添加本机目录为 Workspace"
          disabled={disabled}
          onClick={onCreateWorkspace}
        >
          ＋
        </button>
      </div>
```

Also change the inactive path hint from
`'从 Workspace 目录启动 MetaWork Web'` to `'点击 ＋ 添加本机目录'`.

`web/src/components/SessionSidebar.tsx`: add `onCreateWorkspace: () => void` to
the props type, forward it to `WorkspaceSelector`, and remove the now-redundant
`请先选择 Workspace` empty text in favour of `点击 ＋ 添加本机目录后新建会话`.

`web/src/components/WorkspaceShell.tsx`: add `onCreateWorkspace: () => void` to
the props and forward it to `SessionSidebar`.

`web/src/components/WorkspaceHeader.tsx`: change the fallback text
`'未设置 · 输入 /workspace /absolute/path'` to
`'未设置 · 点击左侧 ＋ 添加本机目录'` and update the existing
`tests/web/workspace-shell.test.ts` assertion that currently expects
`/workspace /absolute/path` in `header`.

`web/src/App.tsx`:

1. Replace the `establishWebSession` import usage and add imports:

```ts
import {
  establishWebSession,
  exchangeWebCredential,
  loginWithPassword,
  resolveWebLaunchSuggestion,
  type WebLaunchSuggestion,
} from './auth';
import { WorkspaceCreator } from './components/WorkspaceCreator';
```

2. Replace the module-level startup cache and state:

```ts
let startupAuthentication: ReturnType<typeof establishWebSession> | null = null;
let startupLaunchSuggestionPromise: Promise<WebLaunchSuggestion | null> | null = null;
```

```ts
  const [startupLaunchSuggestion, setStartupLaunchSuggestion] = useState<WebLaunchSuggestion | null>(null);
  const [workspaceCreatorOpen, setWorkspaceCreatorOpen] = useState(false);
```

3. Replace the startup effect:

```ts
  useEffect(() => {
    let active = true;
    startupAuthentication ??= establishWebSession();
    startupLaunchSuggestionPromise ??= resolveWebLaunchSuggestion().catch(() => null);
    void Promise.all([startupAuthentication, startupLaunchSuggestionPromise])
      .then(([session, suggestion]) => {
        if (!active) return;
        setStartupLaunchSuggestion(suggestion);
        setAuthenticated(Boolean(session));
      })
      .catch(error => {
        if (!active) return;
        setAuthError((error as Error).message);
        setAuthenticated(false);
      });
    return () => {
      active = false;
    };
  }, []);
```

Delete the `session.workspaceInitialization` notice branch: the bootstrap
endpoint no longer reports Workspace initialization.

4. In the load effect, apply the suggestion before reading the Conversation
   directory and use the suggestion's `conversationId`:

```ts
    void Promise.all([http.getWorkspaces(), http.getConfig()])
      .then(async ([workspaceCatalog, config]) => {
        const applied = await applyStartupLaunchSuggestion(
          http,
          workspaceCatalog,
          startupLaunchSuggestion,
        );
        setWorkspaces(applied.workspaces);
        setActiveWorkspaceId(applied.activeWorkspaceId);
        const catalog = applied.activeWorkspaceId
          ? await http.getConversations(applied.activeWorkspaceId)
          : null;
        const requestedConversationId = startupLaunchSuggestion?.conversationId ?? null;
```

Change the effect dependency array from
`[authenticated, startupLaunchContext]` to
`[authenticated, startupLaunchSuggestion]`.

5. Add the module-level helper next to `activationMessage`:

```ts
async function applyStartupLaunchSuggestion(
  http: HttpClient,
  catalog: { activeWorkspaceId: string | null; workspaces: WorkspaceSummary[] },
  suggestion: WebLaunchSuggestion | null,
): Promise<{ activeWorkspaceId: string | null; workspaces: WorkspaceSummary[] }> {
  const hint = suggestion?.workspaceHint;
  if (catalog.activeWorkspaceId || !hint) return catalog;
  const selection = await http.selectWorkspace(hint).catch(() => null);
  if (!selection?.activeWorkspaceId) return catalog;
  const refreshed = await http.getWorkspaces().catch(() => null);
  return {
    activeWorkspaceId: selection.activeWorkspaceId,
    workspaces: refreshed?.workspaces ?? catalog.workspaces,
  };
}
```

6. Remove every remaining `startupLaunchContext` reference: in `handleAuth`
   drop `setStartupLaunchContext(session.launchContext);` (keep
   `setAuthenticated(true)`), and in `handleLogin` drop
   `setStartupLaunchContext(null);`. The launch suggestion is resolved once at
   startup and is never re-derived from an auth response.

7. Split Workspace selection so creation reuses the same transition:

```ts
  const handleSelectWorkspace = (workspace: WorkspaceSummary) => {
    if (workspace.availability !== 'available') {
      setActivationNotice(`Workspace ${workspace.displayName} 当前不可用。`);
      return;
    }
    void handleSelectWorkspacePath(workspace.canonicalPath);
  };

  const handleCreateWorkspace = (path: string) => {
    setWorkspaceCreatorOpen(false);
    void handleSelectWorkspacePath(path);
  };

  const handleSelectWorkspacePath = async (workspacePath: string) => {
    const http = httpRef.current;
    if (!http) return;
    if (workspaceSwitchRef.current) return;
    workspaceSwitchRef.current = true;
    const switchRequestId = ++workspaceSwitchRequestRef.current;
    ++conversationRequestRef.current;
    ++recordRequestRef.current;
    setWorkspaceSwitching(true);
    setActivationNotice(null);
    try {
      const result = await http.selectWorkspace(workspacePath);
      ... // 其余逻辑保持与原 handleSelectWorkspace 完全一致
```

Keep the rest of the original body verbatim, replacing only the call argument.
The removed guard is the `workspace.id === activeWorkspaceId` early return, which
must not apply to a freshly browsed path.

8. Render the creator next to `SettingsPanel`:

```tsx
      <WorkspaceCreator
        http={httpRef.current}
        open={workspaceCreatorOpen}
        disabled={workspaceSwitching}
        onClose={() => setWorkspaceCreatorOpen(false)}
        onSelect={handleCreateWorkspace}
      />
```

9. Pass `onCreateWorkspace={() => setWorkspaceCreatorOpen(true)}` into
   `WorkspaceShell`, and add a creation button to the `workspace-home` empty
   state whose text becomes
   `点击左侧 ＋ 或此处按钮，选择本机目录创建 Workspace。`

**Step 6: Add the styles**

In `web/src/styles.css`, add the creator styles next to the existing
`.workspace-selector` block, plus a light-theme override next to
`root[data-theme='light'] .workspace-selector`:

```css
.workspace-selector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.workspace-create-button {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid #35443a;
  border-radius: 6px;
  color: var(--accent);
  background: transparent;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.workspace-create-button:hover:not(:disabled) {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.06);
}

.workspace-create-button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.workspace-creator-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(6, 9, 7, 0.66);
}

.workspace-creator {
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  gap: 12px;
  width: min(560px, 100%);
  max-height: min(620px, 100%);
  padding: 18px;
  border: 1px solid #29342b;
  border-radius: 14px;
  background: var(--surface-raised);
}

.workspace-creator header,
.workspace-creator footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.workspace-creator-kicker {
  color: #738076;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 9px;
  letter-spacing: 0.12em;
}

.workspace-creator-path {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 11px;
}

.workspace-creator-path button {
  padding: 2px 6px;
  border: 0;
  border-radius: 5px;
  color: var(--accent);
  background: transparent;
  cursor: pointer;
}

.workspace-creator-list {
  min-height: 0;
  overflow-y: auto;
  border: 1px solid #29342b;
  border-radius: 10px;
}

.workspace-creator-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid #202922;
  color: var(--text);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.workspace-creator-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.workspace-creator-empty {
  padding: 16px 12px;
  color: var(--text-dim);
  font-size: 12px;
}

.workspace-creator footer code {
  overflow: hidden;
  color: var(--text-dim);
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

```css
:root[data-theme='light'] .workspace-creator {
  border-color: var(--line-subtle);
  background: var(--surface-raised);
}

:root[data-theme='light'] .workspace-creator-list {
  border-color: var(--line-subtle);
}

:root[data-theme='light'] .workspace-creator-row {
  border-bottom-color: var(--line-subtle);
  color: var(--text-primary);
}
```

**Step 7: Run the tests and build the Web bundle**

Run: `npm test -- --run tests/web/workspace-shell.test.ts tests/web/auth.test.ts`
Expected: PASS

Run: `npm run lint`
Expected: no errors.

Run: `npm run build:web`
Expected: the Vite build succeeds.

**Step 8: Commit**

```bash
git add web/src tests/web
git commit -m "feat(web): create Workspaces from a local directory browser"
```

---

### Task 9: Close documentation and run the validation gate

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/plans/2026-09-16-web-workspace-creation-and-login.md`
- Modify: `docs/plans/2026-09-16-web-workspace-creation-and-login-design.md`

**Step 1: Record delivery**

Add the completed entry to the `## Completed Delivery` list in
`docs/README.md`, following the existing one-paragraph format, and set
`**Status:** Complete` plus `**Completion date:** 2026-09-16` in both plan
documents. Record the delivered behaviour, the validation commands, and the
closing commit SHA.

**Step 2: Run the focused validation gate**

Run each command and confirm the expected result:

```bash
npm test -- --run tests/management/login-credentials.test.ts
npm test -- --run tests/management/web-auth.test.ts
npm test -- --run tests/management/server.test.ts
npm test -- --run tests/management/web-gateway-session-runtime.test.ts
npm test -- --run tests/management/workspace-directory-browser.test.ts
npm test -- --run tests/client/web-client-launcher.test.ts
npm test -- --run tests/web/auth.test.ts
npm test -- --run tests/web/workspace-shell.test.ts
npm run lint
npm run build:web
```

**Step 3: Commit**

```bash
git add docs/README.md docs/plans
git commit -m "docs(plans): record Web workspace creation and login delivery"
```

---

## Manual Acceptance

After the automated gate, verify on a native macOS host:

1. `metawork server start` prints the built-in-credential notice once and never
   prints a generated password. Restart it and confirm the credentials are
   unchanged.
2. Open `http://127.0.0.1:<port>/` in a browser with no cookie. The login page
   appears. There is no password-less entry.
3. Log in with `admin` / `123456`. Open a second tab at the same URL and confirm
   it skips the login page. Log out and confirm the cookie is cleared.
4. Run `metawork web` from a project directory. The browser opens with
   `#launch=<token>` and still shows the login page. After logging in, the
   started directory becomes the active Workspace.
5. With no active Workspace, click `＋` in the sidebar, browse to a directory,
   and select it. The Workspace appears in the selector and accepts a new
   Conversation.
6. Confirm `metawork web --no-open` still prints a URL and that the Server
   terminal shows the manual access token used by the login page's token mode.
