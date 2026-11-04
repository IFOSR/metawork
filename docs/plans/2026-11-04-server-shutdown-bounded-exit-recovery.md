# Bounded Server shutdown and exit recovery

**Plan date:** 2026-11-04
**Status:** Complete (2026-11-04)
**Release:** v0.1.23

## Problem

A local Server stopped at 14:58 and never exited. It had already withdrawn its
listeners, endpoint manifest and instance lock, and was waiting inside
`uv_thread_join()` during `process.exit()`. Because the lock was gone, `server
status` reported "not running", `connect` considered the install startable, and
the login panel received `Failed to fetch` with no way to recover except a manual
`kill -9`.

Four independent defects chained into that permanent state:

1. Shutdown released AccountRuntime storage before the memory drain, so the final
   deposition always failed with "The database connection is not open" and was
   lost on every clean stop.
2. Exit had no bound: `process.exit()` waits on the threadpool join with no
   timeout, and a stuck exit has already consumed the one-shot signal handler, so
   a second SIGTERM is never dispatched.
3. `ServerLifecycle.stop()` deleted the instance lock before the process exited,
   so every observer treated a stuck process as stopped.
4. The recovery paths refused to act: `startMacOSBackgroundProcess` treated a
   launchd job with a PID as reusable, `finishMacOSServerExit` refused to kill a
   withdrawn Server that still held database descriptors, and `manager.stop()`
   required a reachable endpoint before it could stop anything.

## Delivered behaviour

- Shutdown order is Planner → memory deposition → AccountRuntime storage
  release, with every step attempted and failures reported after storage is
  released (`src/server/server-runtime-shutdown.ts`).
- The stopping Server arms a detached exit watchdog before draining; it SIGKILLs
  itself after `METAWORK_EXIT_WATCHDOG_MS` (default 60s)
  (`src/server/exit-watchdog.ts`, `src/server/server-composition.ts`).
- The instance lock outlives `ServerLifecycle.stop()` and is removed by the
  process `exit` handler; readiness reports `zombie` for a live process whose
  lock is past the startup window with withdrawn endpoints
  (`src/server/server-lifecycle.ts`, `src/server/server-endpoint-manifest.ts`).
- `metawork server stop --force` and `metawork server restart --force` escalate
  SIGTERM → SIGKILL and, when the lock is already gone, scan for
  `…/app/releases/<release>/dist/index.js server start` processes of this user
  under the install root (`src/management/lock.ts`,
  `src/management/server-process-scan.ts`, `src/cli/args.ts`, `src/index.ts`).
- Desktop reclaims a withdrawn instance from the stop action and from `connect`,
  and no longer refuses to force a withdrawn Server that still holds descriptors
  (`src/client/desktop-service-manager.ts`,
  `src/installation/macos-server-exit.ts`, `apps/desktop/main/main.ts`).
- Stop reasons are auditable: `signal/ppid/uid/argv` on the Server, and
  `reason=user-stop|update|pi-repair` in `logs/desktop-restart.log` on Desktop.

## Validation

- `tests/server/server-runtime-shutdown.test.ts`: deposition precedes storage
  release, storage is released when the deposition fails.
- `tests/server/server-lifecycle.test.ts`, `tests/server/server-application.test.ts`:
  the lock survives `stop()`.
- `tests/server/exit-watchdog.test.ts`: detached watchdog, budget, environment
  override, never throws.
- `tests/server/server-endpoint-manifest.test.ts`: `zombie` classification and
  the "unreadable lock is not evidence" rule.
- `tests/installation/macos-server-exit.test.ts`: a withdrawn Server holding
  descriptors is now forced, and identity changes still fail closed.
- `tests/client/desktop-service-manager.test.ts`: reclaim before spawn, no kill of
  a healthy instance, stop without an authenticated endpoint.
- `tests/management/lock.test.ts`, `tests/management/server-process-scan.test.ts`:
  forced escalation, ownership/argv/root filtering, fail-closed scan.
- `npm run lint`, `npx vitest run tests/server tests/management tests/installation tests/client`,
  `apps/desktop` `vitest run tests` and `tsc --noEmit`.

## Live acceptance

On the local installation: a normal stop leaves no process behind and the memory
deposition succeeds; a frozen instance is reported as a stuck instance and is
reclaimed by `metawork server stop --force` both with and without its lock; the
Desktop stop action recovers without a reachable endpoint.
