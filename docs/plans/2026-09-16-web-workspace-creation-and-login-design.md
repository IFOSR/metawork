# Web Workspace Creation And Login Design

> **Status:** Approved
> **Design date:** 2026-09-16
> **Recorded by:** ADR-0039 (Web Workspace Creation And Login)
> **Amends:** ADR-0034 (Browser bootstrap context and startup hint), ADR-0035
> (Client Workspace Selection)
> **Preserves:** ADR-0011, ADR-0020, ADR-0031

## Problem

Three defects block a user who opens the Web surface without going through
`metawork web`.

1. **No Workspace can be created from Web.** `metawork web` sends a launch
   context carrying `process.cwd()` as `workspaceHint`, and the Server creates
   or selects that Workspace. A user who types the URL directly logs in with a
   password, receives no `launchContext`, and therefore has
   `activeWorkspaceId = null`. The sidebar only lists Workspaces that already
   exist in the catalog, and `/workspace <path>` requires an active
   Conversation, which in turn requires an active Workspace. The first
   Workspace is unreachable.

2. **Login credentials change by themselves.** `metawork.sh` and the generated
   native launcher both export `ANYFUSION_WEB_PASSWORD=123456`, but
   `resolveLoginCredentials()` falls back to
   `generateReadablePassword()` when the environment is absent
   (`src/management/login-credentials.ts`). Direct
   `node dist/index.js server start`, `npm run dev`, and Docker runs therefore
   print a freshly generated password on every Server start. User login
   information must never change without an explicit user action.

3. **The launch token doubles as a password-less login credential.**
   `WebAuthService.exchange()` treats a launch token as an authentication
   credential (`src/management/web-auth.ts`), so `metawork web` silently
   creates an authenticated browser session. Login must require explicit user
   input.

The existing cookie-session behaviour is already correct and stays unchanged:
`web/src/auth.ts` calls `GET /api/auth/session`, and an unexpired cookie skips
the login page. Second tabs, reloads, and logout already behave like a
conventional B/S application.

## Decision

### 1. Built-in credentials are fixed and never regenerated

`resolveLoginCredentials()` resolves in this order and never randomizes:

```text
ANYFUSION_WEB_PASSWORD_HASH (scrypt saltHex:hashHex)
  > ANYFUSION_WEB_PASSWORD
    > built-in default admin / 123456
```

The built-in default is `admin` / `123456`, identical to
`metawork.sh` and `src/installation/native-launcher.ts`. The Server prints a
one-line notice only while the built-in default is in effect, and never prints
a generated secret.

Environment variables remain the supported configuration mechanism. Persisted,
database-backed Web user management is deliberately out of scope; see
Non-Goals.

### 2. `metawork web` opens the browser but never authenticates

`WebClientLauncher` keeps registering a launch context over the Gateway socket
and keeps opening the browser, but the URL fragment stops being a login
credential. The user always completes login explicitly, either with
username/password or with the manually typed access token.

### 3. Launch context becomes a non-authenticating Workspace suggestion

The launch context keeps exactly one job: telling an *unauthenticated* browser
which local directory the user started `metawork web` in. It cannot create a
session, cannot authorize a Workspace, and expires after 60 seconds.

```text
WebClientLauncher
  -> registerWebLaunchContext(socket, { workspaceHint: cwd, conversationId? })
  -> open http://127.0.0.1:<port>/#launch=<token>

Browser (unauthenticated)
  -> POST /api/auth/launch-context { token }   -> { workspaceHint, conversationId? }
  -> clear the URL fragment, keep the suggestion in memory

Browser (authenticated)
  -> POST /api/workspaces/select { path: workspaceHint }   (ordinary authorized command)
  -> POST /api/conversations/<id>/attach                    (when conversationId is present)
```

Workspace authorization remains where ADR-0035 put it: the Server resolves,
validates, and authorizes the path through the existing
`select_workspace` Gateway command. The launch suggestion is never trusted as
identity.

### 4. Web-side Workspace creation uses a server-side directory browser

A new read-only endpoint lists directories so the user can pick a local
directory. This is the only new capability; it does not widen Workspace
authorization, because `select_workspace` already accepts any existing
absolute directory from an authenticated principal.

```text
GET /api/workspaces/browse?path=<absolute path>
  -> {
       path,
       parent,
       crumbs: [{ name, path }],
       entries: [{ name, path }]
     }
```

- `path` absent defaults to `os.homedir()`.
- Root policy is `/`: navigation up to the filesystem root is allowed and no
  directory is excluded.
- `crumbs` is the Server-built path decomposition, including the filesystem
  root as its first element. Clients render and navigate with `crumbs` and
  never parse an operating-system path themselves, so Windows drive and
  separator semantics stay entirely Server-side.
- Only directories are listed, never files. Entries are capped at 500 and
  sorted case-insensitively with numeric collation.
- Every reported path — `path`, `parent`, `crumbs[].path`, and `entries[].path`
  — is `realpath`-resolved. A symlinked directory is therefore reported under
  its canonical target path, which is exactly the path
  `select_workspace` later re-resolves and stores. The entry `name` keeps the
  link name so the listing still matches what the user sees in the directory.
- Only cookie-authenticated sessions may browse. The shared
  `manual-bearer-client` identity is refused, because it cannot distinguish
  which human is enumerating the Server filesystem.
- The endpoint is read-only and never mutates the Workspace Catalog.

## Auth Surface After The Change

| Surface | Behaviour |
| --- | --- |
| `GET /api/auth/session` | Unchanged; valid cookie skips login |
| `POST /api/auth/login` | Password or configured credentials; returns `{ authenticated: true }` |
| `POST /api/auth/bootstrap` | Manual access token only; no launch context; returns `{ authenticated: true }` |
| `POST /api/auth/launch-context` | New; unauthenticated, one-time, 60s, read-only suggestion |
| `POST /api/auth/logout` | Unchanged; revokes session and clears the cookie |

## Detailed Design

### Credential resolution

- `resolveLoginCredentials(env)` returns `{ username: 'admin', password: '123456', generated: false }`
  when neither `ANYFUSION_WEB_PASSWORD_HASH` nor `ANYFUSION_WEB_PASSWORD` is
  configured.
- `generateLoginCredentials()` and `generateReadablePassword()` are removed.
  Nothing in production generates a password.
- `startWebMode()` prints a stable notice while the built-in default is
  active instead of printing a generated password.
- `LoginCredentials.generated` is replaced by an explicit
  `builtInDefault: boolean` so the notice has one meaning.

### Launch context lifecycle

- `WebLaunchContextService` keeps `issue()`, the 60-second TTL, and the
  single-use `consume()`.
- `WebAuthService.exchange()` keeps only the `manualAccessToken` branch, and
  `WebAuthServiceOptions` becomes fully optional so the service can be
  constructed without options.
- `WebAuthSessionState.launchContext` is removed, together with
  `ManagementWebSessionRuntime.initializeClient()` and
  `WebGatewayClientSession.initializeClient()`.
  `ManagementServer.start()` already calls `sessionRuntime.initialize()`, so
  catalog initialization is unaffected.
- `WebClientLauncher` builds `/#launch=<token>`.
- `web/src/auth.ts` replaces `bootstrapTokenFromHash`/`clearBootstrapFragment`
  with launch-context resolution: read `#launch`, `POST
  /api/auth/launch-context`, clear the fragment, and return the suggestion or
  `null`.
- `App.tsx` applies a resolved suggestion only after authentication: select the
  suggested Workspace when the client has no active Workspace, then attach the
  suggested Conversation when present.

### Removed Contracts

These exist only because the launch token used to authenticate. They are
removed in the same release with no compatibility read:

| Removed | Location |
| --- | --- |
| `launchContext` on the auth session state | `src/management/web-auth.ts` |
| `launchContext` in `/api/auth/bootstrap` and `/api/auth/session` responses | `src/management/server.ts` |
| `ManagementWebSessionRuntime.initializeClient` | `src/management/web-session-runtime-types.ts` |
| `WebGatewayClientSession.initializeClient` | `src/management/web-gateway-session-runtime.ts` |
| `WebSessionCreationResult.workspaceInitialization` | `src/management/web-session-types.ts` |
| `WebSessionCreationResult.workspaceInitialization` | `web/src/api/session-types.ts` |
| `WorkspaceInitializationResult` creation-result projection | `src/management/web-gateway-session-runtime.ts` |
| `result.workspaceInitialization` reads | `web/src/App.tsx` |
| `bootstrapTokenFromHash` / `clearBootstrapFragment` | `web/src/auth.ts` |
| `buildWebStartupPresentation` | `src/management/token.ts` |

`WorkspaceInitializationResult` itself stays: `selectWorkspace` still returns
it for the `/workspace` and `POST /api/workspaces/select` paths.

### Directory browser

- New module `src/management/workspace-directory-browser.ts` owns path
  resolution, per-entry `realpath` normalization, Server-built crumbs, directory
  filtering, sorting, and the entry cap. It has no runtime dependency beyond
  `node:fs/promises` and `node:os`, so it can be unit tested without the native
  `better-sqlite3` dependency.
- Error codes: `browse_path_invalid`, `browse_path_forbidden`,
  `browse_path_not_found`.
- `ManagementServer` maps them to HTTP 400, 403, and 404.

### Web presentation

- `WorkspaceSelector` gains a `+` control on the `WORKSPACE` label row, matching
  the referenced workspace-creation affordance.
- New `web/src/components/WorkspaceCreator.tsx` renders a modal with a
  breadcrumb, a parent-directory control, the directory list, and a
  "select this directory" action. It never accepts a typed path: selection is
  always by browsing, per the approved decision.
- `SessionSidebar` and `WorkspaceShell` pass the create intent through.
- `App.tsx` extracts one `applyWorkspaceSelection(path)` transition used by
  both existing-Workspace selection and newly created Workspaces, preserving
  the navigation serialization and request-generation guards delivered by the
  Web Workspace switch reliability plan.
- The `WORKSPACE HOME` empty state gains the same creation entry point, and the
  header hint stops referring to `/workspace /absolute/path` as the only way to
  set a Workspace.

### Unchanged

- Account, Runtime, Kernel, Task, and Execution boundaries.
- Gateway protocol, event kinds, Conversation bindings, and Workspace Catalog
  persistence.
- ADR-0035's rule that Clients never read the Workspace Catalog directly.
- ADR-0011 single-Task admission.

## Security

- The directory browser adds **discovery**, not authority. Workspace creation
  already accepted any existing absolute directory from an authenticated
  principal, and the management Server binds `127.0.0.1` only with a
  localhost-only origin check.
- Browsing requires cookie authentication, so the shared bearer client cannot
  enumerate directories.
- Symlinks are resolved with `realpath` before the directory decision, so the
  reported path is always the canonical path that `select_workspace` later
  re-resolves and authorizes.
- The launch-context endpoint is unauthenticated by design. It is gated by a
  32-byte random token, a 60-second TTL, and single use, and it returns a
  directory hint only. It cannot create a session, list Workspaces, or read
  Conversations. The endpoint is not a new information channel for an attacker
  who already holds the token, because the token is delivered to the user's own
  browser.
- The built-in `admin` / `123456` default is weak by normal standards. It is
  intentional for this single-user localhost product and matches the existing
  launcher scripts. Deployments that expose the Server beyond loopback must set
  `ANYFUSION_WEB_PASSWORD_HASH`. The Server never regenerates credentials, so a
  configured value is stable across restarts.

### Documentation Authority

Because this changes an accepted authentication and Client Workspace contract,
the decision is recorded in a new ADR rather than edited into ADR-0034/0035 in
place, following `docs/adr/README.md`:

- **Create** `docs/adr/0039-web-workspace-creation-and-login.md`, stating
  status, date, scope, the amended ADRs, and the preserved decisions.
- **Update** `docs/adr/0034-independent-server-and-client-process-lifecycle.md`
  and `docs/adr/0035-workspace-scoped-conversation-organization.md` with an
  `Amended by: ADR-0039` pointer.
- **Update** `docs/adr/README.md` with the new topic row and its 0034/0035
  amendment relationship.
- **Update** `CONTEXT.md`: the Web Client and Workspace-selection paragraph must
  state that the Web launch hint is not a credential, that login is always
  explicit, and that a Workspace may be created from Web by browsing a local
  directory.
- **Update** `docs/current/account-runtime-and-gateway-operations.md`: the
  bootstrap-context paragraph must describe the launch-hint endpoint and the
  cookie-only directory browse endpoint.

## Consequences

- A user who types the Web URL and logs in can reach the product without ever
  running the `metawork web` client, which is the reported defect.
- `metawork web --no-open` no longer yields a login-capable URL. Users who
  forward the port read the manual access token from the Server terminal and
  type it into the login page's token mode.
- The launch suggestion survives login only in browser memory for that load.
  A reload after consumption behaves like a normal URL entry with no
  suggestion.
- `buildWebStartupPresentation()` in `src/management/token.ts` is unused
  production code and is removed together with its test.

## Non-Goals

- Persisted, database-backed Web users and a password-change surface. This
  requires a `web_users` table, a schema migration, and multi-user account
  semantics that the current single-Account Runtime does not have. It is a
  separate plan.
- Session TTL, sliding renewal, and restart-surviving signed cookies. The new
  tab and reload behaviour is already correct; extending cookie lifetime is a
  separate hardening item.
- Manual path entry in the Workspace creator. Deliberately excluded.
- Browsing-root allowlists. The approved root policy is `/`.
- TUI and Feishu Workspace creation.

## Testing

- `tests/management/login-credentials.test.ts`: built-in default is stable
  across calls; env and hash overrides still win; no generation path remains.
- `tests/management/web-auth.test.ts`: a launch token can no longer create a
  session; the manual token still can; the service constructs without options.
- `tests/management/web-launch-context.test.ts`: one-time consumption and TTL
  are unchanged for the new endpoint.
- `tests/management/workspace-directory-browser.test.ts`: directory-only
  listing, sorting, cap, crumbs, parent computation, root behaviour, per-entry
  `realpath` (including a symlink that must be reported under its target path),
  and each error code.
- `tests/management/server.test.ts`: browse endpoint authorization (cookie yes,
  bearer no), status mapping, and the launch-hint endpoint.
- `tests/management/web-gateway-session-runtime.test.ts`: no
  `initializeClient`, no `workspaceInitialization` in creation results.
- `git grep -n workspaceInitialization` over `src`, `web/src`, and `tests` must
  show only `WorkspaceInitializationResult` declarations and `selectWorkspace`
  usages.
- `tests/architecture/no-direct-client-session-paths.test.ts`: the launcher URL
  assertion moves from `#bootstrap=` to `#launch=`.
- `tests/e2e/*`: mock servers stop returning `launchContext` and
  `workspaceInitialization`.
- `tests/web/auth.test.ts` and `tests/web/workspace-shell.test.ts`: source and
  behaviour contracts for the launch fragment, the login page, and the
  Workspace creator.
- `npm run lint`, `npm run build`, and the Web bundle build.
