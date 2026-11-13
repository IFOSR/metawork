# AnyFusion Web Bootstrap Cookie Authentication Design

Status: Approved
Plan date: 2026-08-16

## Goal

Remove token copying from the normal `anyfusion web` experience while
preserving a local security boundary for task execution, configuration changes,
and session output.

## Scope

- Normal Web startup opens an authenticated browser automatically.
- `--no-open`, SSH, and port-forwarded use retain a manual token fallback.
- The native AnyFusion-Pi TUI remains the default `anyfusion` surface.
- Web and TUI remain mutually exclusive Runtime modes in this change.

## Authentication Model

The Web process owns three process-local secrets:

- A short-lived, single-use bootstrap token placed only in the browser URL
  fragment.
- A manual access token printed only for `--no-open`.
- An opaque session token stored only in an HttpOnly browser cookie.

The browser fragment is never sent in an HTTP request. The Web application reads
it once, posts it to the bootstrap exchange endpoint, receives the session
cookie, and removes the fragment with `history.replaceState`.

The manual TokenGate posts the fallback token to the same exchange endpoint. It
does not persist the token in localStorage or sessionStorage.

## Server Contract

- `POST /api/auth/bootstrap` accepts a bootstrap or manual access token and sets
  the process-local session cookie.
- `GET /api/auth/session` reports whether the cookie is valid.
- `POST /api/auth/logout` clears the cookie.
- Browser API requests authenticate with the cookie. Bearer authentication
  remains available for script compatibility.
- WebSocket upgrades require a valid session cookie and an allowed loopback
  Origin before the protocol switches.

The cookie uses `HttpOnly`, `SameSite=Strict`, and `Path=/`. It is a browser
session cookie and becomes useless when the AnyFusion Web process restarts.
The service continues to bind only to `127.0.0.1`.

## Startup UX

`anyfusion web` opens:

```text
http://127.0.0.1:8788/#bootstrap=<single-use-token>
```

The terminal prints the clean Web address but not an access token. If automatic
opening fails, the user can restart with `anyfusion web --no-open`.

`anyfusion web --no-open` prints the clean Web address and the manual Web access
token. The browser shows TokenGate only when no valid session cookie or
bootstrap fragment is available.

## Failure Handling

- Invalid, expired, or consumed bootstrap tokens return 401 without setting a
  cookie.
- A rejected or stale cookie returns the application to TokenGate.
- Failed bootstrap exchange always removes the fragment from the address bar.
- Foreign browser Origins cannot exchange credentials or open WebSockets.
- A stale cookie cannot cause reconnect loops.

## Validation

- Real HTTP tests for cookie issuance, bootstrap single use, manual fallback,
  stale cookie rejection, and foreign Origin rejection.
- Real WebSocket tests for Cookie-authenticated upgrade and unauthenticated
  rejection.
- Frontend tests for fragment extraction, URL cleanup, bootstrap exchange, and
  no browser storage of manual tokens.
- CLI/startup tests proving normal mode hides the token and `--no-open` exposes
  only the manual fallback.
- Root TypeScript validation, Web production build, and focused regression
  tests.
