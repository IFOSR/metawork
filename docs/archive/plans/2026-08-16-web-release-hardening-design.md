# AnyFusion Web Release Hardening Design

**Status:** Approved
**Plan date:** 2026-08-16

## Goal

Close the Web release blockers found in the post-publication review without
introducing live configuration hot reload or weakening the existing
configuration-revision boundaries.

## Decisions

### Web authentication

- The Web access token is a process-local bearer token, not a Provider,
  Executor, or integration credential.
- Only authenticated WebSocket connections may receive session or execution
  broadcasts.
- WebSocket upgrades must reject foreign browser origins.
- The browser must discard a rejected stored token and return to the token
  gate instead of reconnecting forever.
- "Trust this device" remains available only as persistence of the current
  process token; rejection always clears both session and local storage.

### Configuration activation

- Web configuration activation validates, compiles, probes, and activates an
  immutable revision in the configuration repository.
- The running Session, Planner, Kernel, and Execution Runtime remain pinned to
  the revision loaded at process startup.
- Planner MCP processes read the revision explicitly bound by the running
  Session rather than implicitly reading the repository's latest active
  revision.
- A successful Web activation reports `restartRequired: true` when the newly
  active repository revision differs from the running revision.
- The UI displays both the running revision and the next-start revision and
  states that AnyFusion must be restarted before the new configuration is
  applied.

### Settings contract

- Model capability controls use only values accepted by
  `AnyFusionConfigurationV2`.
- Fixed and automatic model policies are edited as distinct schema-valid
  shapes; the UI does not synthesize `modelRef: "auto"`.
- The Web forms remain a bounded editor for existing Provider, Model, and
  AgentClass records. Secret entry and new-record creation remain out of scope.

### Release gate

- The pinned Planner schema hash is updated only after the generated schema is
  verified.
- Management authentication, stale-token recovery, settings serialization, and
  revision pinning receive focused behavior tests.

## Non-goals

- Live Session reconstruction after configuration activation.
- Hot migration of an active Task or Work Graph to another revision.
- Browser-managed Provider secrets.
- Replacing the local bearer token with cookies or remote authentication.

## Validation

- Focused RED/GREEN tests for each corrected behavior.
- Root TypeScript validation.
- Web production build.
- Full Vitest suite, including the cross-repository Planner contract.
