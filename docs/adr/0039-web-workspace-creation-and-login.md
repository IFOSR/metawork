# ADR-0039: Web Workspace Creation And Login

- **Status:** Accepted
- **Date:** 2026-09-16
- **Scope:** Web authentication, Web launch hints, Workspace creation from a
  Client surface, and read-only Server directory enumeration
- **Amends:** ADR-0034, ADR-0035
- **Preserves:** ADR-0011, ADR-0020, ADR-0031
- **Design:**
  `docs/plans/2026-09-16-web-workspace-creation-and-login-design.md`
- **Implementation plan:**
  `docs/plans/2026-09-16-web-workspace-creation-and-login.md`
- **Governed by:** ADR-0020

## Context

ADR-0034 delivered a Server-owned startup hint: `metawork web` registers a
short-lived, single-use bootstrap context, the Browser URL carries an opaque
token fragment, and the authenticated Web session reuses that launch hint.
ADR-0035 then made Client Workspace selection Server-authorized and stated that
local Client startup cwd is only an untrusted Workspace selection hint.

That contract had three defects.

First, the launch token was also a login credential. `WebAuthService.exchange()`
accepted a launch token and created an authenticated session, so opening the
generated URL bypassed explicit login.

Second, `resolveLoginCredentials()` generated a random password whenever
`ANYFUSION_WEB_USERNAME`/`ANYFUSION_WEB_PASSWORD` were absent, and the Server
printed it on every start. Login information changed without any user action,
and differed between the launcher scripts (fixed `admin` / `123456`) and direct
Server starts.

Third, no Client surface could create a Workspace. A user who typed the Web URL
directly received `launchContext: null`, `activeWorkspaceId` stayed null, the
sidebar listed only pre-existing Workspaces, and `/workspace <path>` required an
active Conversation, which in turn required an active Workspace. The first
Workspace was unreachable from Web.

## Decision

### 1. A launch hint is not a credential

The launch context keeps exactly one responsibility: telling an unauthenticated
Browser which local directory `metawork web` was started in. It has a
60-second TTL, is single-use, and is served by an unauthenticated read-only
endpoint.

```text
metawork web
  -> registerWebLaunchContext(socket, { workspaceHint: cwd, conversationId? })
  -> open http://127.0.0.1:<port>/#launch=<token>

Browser (unauthenticated)
  -> POST /api/auth/launch-context { token } -> { workspaceHint, conversationId? }

Browser (authenticated)
  -> POST /api/workspaces/select { path: workspaceHint }
  -> POST /api/conversations/<id>/attach                  (when conversationId is present)
```

`POST /api/auth/launch-context` never sets a session cookie, and
`WebAuthService.exchange()` accepts only the manually typed access token. A
launch token therefore cannot authenticate anyone. This replaces ADR-0034's
rule that "the authenticated Web session may reuse that launch hint for later
new Conversations".

The suggestion is applied through the ordinary authorized `select_workspace`
Gateway command, exactly like a manual selection. Workspace authorization stays
where ADR-0035 put it.

### 2. Built-in login credentials are fixed

`resolveLoginCredentials()` resolves in this order and never randomizes:

```text
ANYFUSION_WEB_PASSWORD_HASH (scrypt saltHex:hashHex)
  > ANYFUSION_WEB_PASSWORD
    > built-in default admin / 123456
```

The built-in default matches `metawork.sh` and
`src/installation/native-launcher.ts`. No production path generates or rotates a
password. Environment variables remain the supported configuration mechanism.

### 3. A Client may create a Workspace by browsing a local directory

A new cookie-session-only, read-only endpoint lists directories:

```text
GET /api/workspaces/browse?path=<absolute path>
  -> { path, parent, crumbs: [{ name, path }], entries: [{ name, path }] }
```

- The root policy is `/`: navigation up to the filesystem root is allowed and no
  directory is excluded.
- `crumbs` is the Server-built path decomposition, including the filesystem root
  as its first element. Clients render and navigate with `crumbs` and never
  parse an operating-system path, so Windows drive and separator semantics stay
  entirely Server-side.
- Only directories are listed, never files. Entries are capped at 500 and sorted
  case-insensitively with numeric collation.
- Every reported path is `realpath`-resolved. A symlinked directory is reported
  under its canonical target path with the link name preserved as its display
  name, so the reported path is exactly what `select_workspace` later
  re-resolves and stores.
- Only cookie-authenticated sessions may browse. The shared
  `manual-bearer-client` identity is refused because it cannot distinguish which
  human is enumerating the Server filesystem.

The browse endpoint grants no new Workspace authority:
`select_workspace` already accepted any existing absolute directory from an
authenticated principal. It adds discovery only. It never mutates the Workspace
Catalog, and `WorkspaceRecord`, Conversation bindings, and the Catalog format are
unchanged.

### 4. Explicitly deferred

Database-backed Web user management, session TTL and sliding renewal, and
restart-surviving signed cookies are not delivered by this decision. The current
in-memory session map is not authoritative beyond Server lifetime, and a future
decision must not treat it as such.

## Removed Contracts

These existed only because the launch token authenticated. They are removed in
the same release with no compatibility read:

| Removed | Location |
| --- | --- |
| `launchContext` on the auth session state | `src/management/web-auth.ts` |
| `launchContext` in `/api/auth/bootstrap` and `/api/auth/session` | `src/management/server.ts` |
| `ManagementWebSessionRuntime.initializeClient` | `src/management/web-session-runtime-types.ts` |
| `WebGatewayClientSession.initializeClient` | `src/management/web-gateway-session-runtime.ts` |
| `WebSessionCreationResult.workspaceInitialization` | `src/management/web-session-types.ts`, `web/src/api/session-types.ts` |
| `bootstrapTokenFromHash` / `clearBootstrapFragment` | `web/src/auth.ts` |
| `buildWebStartupPresentation` | `src/management/token.ts` |

`WorkspaceInitializationResult` itself remains: `select_workspace` still returns
it for `/workspace` and `POST /api/workspaces/select`.

## Consequences

- A user who types the Web URL and logs in reaches the product without running
  the `metawork web` client, which was the reported defect. The existing cookie
  behaviour is unchanged: a valid session skips the login page in a new tab.
- `metawork web` still opens the Browser and still supplies the startup
  directory as a Workspace suggestion, but never logs the user in.
- `metawork web --no-open` no longer yields a login-capable URL. Users who
  forward the port read the manual access token from the Server terminal and
  type it into the login page's token mode.
- The launch suggestion survives login only in browser memory for that load. A
  reload after consumption behaves like an ordinary URL entry with no
  suggestion.
- The built-in `admin` / `123456` default is weak by normal standards. It is
  intentional for this single-user, loopback-only product and matches the
  existing launcher scripts. Deployments that expose the Server beyond loopback
  must set `ANYFUSION_WEB_PASSWORD_HASH`.

## Rejected Alternatives

### Keep the launch token as a password-less login credential

Rejected because login must require explicit user input, and because a URL that
authenticates cannot be safely shared, logged, or reconstructed from history.

### Randomize the built-in password on first start and persist it

Rejected because it changes login information without user action, and because
persisted Web users would require multi-user Account semantics the current
single-Account Runtime does not have.

### Accept a typed absolute path instead of browsing

Rejected because directory browsing is the established, lower-error interaction
for this product, and because the Server must own path interpretation rather
than round-tripping an operator-formatted string.

### Root the browser below `/`

Rejected because it would silently hide legitimate project locations such as
`/data` or `/Volumes` while adding no real protection: the Server is
loopback-only and `select_workspace` already accepts any existing absolute
directory.

### Let the client parse the path for breadcrumbs

Rejected because it would break Windows drive and separator semantics and would
duplicate Server-owned path interpretation in the Application Shell.
