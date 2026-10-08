# Desktop Finder update lifecycle correction

- Date: 2026-10-08
- Status: Implementation and local acceptance in progress; no publication.

## Observed failure

The installed app was `0.1.8-internal-0f7e734`; the active Runtime remained
`0.1.8-internal-bc0fb75`. Both installed and staged payloads passed full signature
and inventory verification. The updater stopped during `verify`, before preparing
a new activation journal, leaving a dead helper lock and running diagnostic.
At 22:19:18 macOS loginwindow recorded updater PID 85398 as a subordinate of
Finder-launched Desktop PID 84284. At 22:19:19 it recorded:
`was foreground, and still had subordinate processes, and is not allowed by BTM so terminating its subordinates`.
Detached spawn/unref only changed POSIX process/session behavior; it did not
remove the child from the application's macOS coalition. The same launch
mechanism also threatened Server survival when quitting a Finder-launched app.

Final unmodified DMG acceptance caught a second necessary condition. The internal
builder skipped Apple signing and retained the renamed Electron stub's invalid
linker signature (`Identifier=Electron`, missing resource seal). Unlike the
ad-hoc-sealed test fixture, macOS BTM denied it background execution and explicitly
unloaded even its launchd job. The internal packager must apply and verify a local
ad-hoc seal with `Identifier=com.metawork.desktop`; no Apple certificate is needed.
This is not a bypass of a user's background-execution policy. Re-signing a test
copy can hide packaging defects, so final acceptance must keep the app unchanged.

## Correction

Use ephemeral, one-shot user-session launchd jobs for updater and Desktop-started
Server. No login item, certificate, admin privilege, auto-restart, or new lifecycle
authority. The formal Installer/Upgrader still owns verification, stop, backups,
activation, health and recovery. A token-bound readiness receipt permits Desktop
to exit only after the independent updater initializes. Retire only completed
jobs; never boot out a live job. Delete temporary mode-0600 job definitions after
launchd consumes them. Preserve installation/config/profile selection.

Startup explains one-time backend completion for an already installed new app,
with one explicit action explaining task stop/client interruption. No duplicate
confirmation or automatic retry. Interrupted pre-verification diagnostics are
visible even when the old activation journal is committed. Reopening an unchanged
successful installation reuses its Server. Verification failure before a new
journal also reopens the client to report failure without bypassing recovery.

## Required acceptance

- Focused transport, activation/recovery, diagnostics and Desktop tests/typechecks.
- LaunchServices (`open -a`, Finder-equivalent), historical completed journal,
  interrupted status/dead helper; preserve configuration and stored work.
- Repeat Finder launches after commit without another upgrade prompt; Server
  survives quitting the Finder-launched app, including when that app started it.
- Final unchanged arm64 internal DMG; fresh installation and actual prior Runtime
  upgrade. No GitHub release/push/tag/upload. Retain formal user data.
