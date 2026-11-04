# Bounded Server shutdown and exit recovery

**Plan date:** 2026-11-04
**Status:** Complete (2026-11-04)
**Release:** v0.1.23, v0.1.24 (update stop semantics)

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

Performed against this machine's installation while the Server ran the fixed
code:

- A normal `server stop` logs
  `MetaWork shutdown requested: signal=SIGTERM pid=… ppid=… uid=… argv=…`, the
  final deposition no longer reports "database connection is not open", and the
  process, lock and endpoint are gone afterwards.
- A frozen instance with withdrawn endpoint and socket, whose lock is older than
  the startup window, is reported as a stuck instance by `server status` and is
  reclaimed by `server stop --force`.
- The same instance with its lock deleted is not reported as running, and
  `server stop --force` reclaims it through the ownership/argv scan in a fixture
  install root (a development Server outside `app/releases/` is correctly left
  alone).
- A stale lock left behind by a forced kill is not reported as running, and the
  next `server start` reclaims it by PID.
- The Desktop stop/connect recovery paths are covered by unit tests; the
  installed Desktop is upgraded by opening the v0.1.23 DMG and completing its
  one-time background update.

## Follow-up: the Desktop update loop (v0.1.24)

The v0.1.23 build shipped bounded shutdown, but a Desktop background update could
still fail in a loop at the `stop` stage with `stop/unexpected`:

- `DesktopServiceManager.stopForUpdate` treated a non-zero stop CLI exit as a
  failure. The stop CLI grants the Server a fixed 10s grace window, while a real
  drain can exceed it — an unreachable memory engine (`tdai_unreachable`) was
  enough. The update then rolled back and the app showed the same
  `stop/unexpected` diagnostic on every retry.
- A Server that hung *before* withdrawing its endpoints made
  `finishMacOSServerExit` throw `Background Server has not completed shutdown`,
  which the update cannot recover from.
- The helper discarded its error message, so the stage/code in
  `desktop-update-status.json` was the only evidence.

Delivered in v0.1.24:

- A stop succeeds when the installation has no live instance left. The CLI
  result is informational, the drain is awaited (bounded), and a still-live
  installation is reported with the CLI's own error.
- The explicit update/repair path may force an unwithdrawn Server
  (`forceUnwithdrawn`) after re-verifying the launchd job and process identity;
  ordinary connect keeps refusing.
- The helper writes `Desktop update failed: …` to `upgrades/desktop-helper.log`.

Validation: `tests/client/desktop-service-manager.test.ts` covers "CLI failed but
the instance is gone" and "hung before withdrawal is forced with
`forceUnwithdrawn`"; `tests/installation/macos-server-exit.test.ts` covers the
opt-in force and keeps the default fail-closed behaviour.

Stale `upgrades/desktop-stage-*` directories from rolled-back attempts were also
leaking disk (14 GB on this machine); they are removed when an attempt finalizes
or rolls back, and the release run cleaned the existing ones by hand.

## Follow-up: the upgrade id outgrew the grammar (v0.1.24)

With the stop stage fixed, the update advanced to `updateRuntime` and failed
there with `configuration revision id is not a valid reference:
u-r-0-1-24-desktoppayload-1903-<uuid>`. `createConfigurationRevisionId` only
shortened the prefix: an upgrade id is `<releaseId>-<uuid>`, so a 25-character
internal release id plus a uuid slugged to 63 characters, left a zero-length
prefix budget and produced a 65-character id. Every background update from such
a build failed and rolled back.

- The id builder now trims an over-long input from its description side and keeps
  the unique suffix; unit tests use the exact failing input, assert the id ends
  with the uuid and stays unique across install/update/rollback.
- Release process gap: the update transaction had no end-to-end gate. Added
  `scripts/verify-desktop-update.mjs` (+ `scripts/desktop-update-gate.ts`): it
  installs the machine's current release into a disposable root, runs the real
  `SourceNativeUpdater.update()` against a candidate payload, and requires the
  upgrade to commit with a legal upgrade id, `app/current` on the candidate and
  the bundled memory engine present. Verified to fail with the previous logic and
  pass with the fix, and recorded as a mandatory pre-upload step in the internal
  release runbook.

Known issue, not addressed in v0.1.24: a rolled-back attempt leaves its
`upgrades/desktop-stage-*` bundle behind (~1.4 GB per attempt); cleanup only runs
after a commit.
