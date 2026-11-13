# Desktop Finder update lifecycle correction

- Date: 2026-10-08
- Status: Completed locally; user's manual installation acceptance pending. No publication.
- Completion date: 2026-10-08
- Closing implementation commit: `0a3df55c38436beeca34897ee79032ea4b513d70`
  (lifecycle transport: `d79fbd757fc50760e05aa0db4dce32a575a668ce`).

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

## Delivered and verified

- 27 focused native transport, transaction/recovery, diagnostic, health and
  lifecycle tests; all 16 Desktop tests; root/Desktop typechecks and Web build.
- Final unchanged app `0.1.8-internal-0a3df55`: LaunchServices upgrade from actual
  prior Runtime `0.1.8-internal-bc0fb75`, with historical committed journal,
  interrupted running status and dead helper lock. Committed authenticated render,
  preserved configuration hash and database sentinel, two subsequent Finder
  launches directly into the main UI, and Server survival after each Desktop exit.
- Final unchanged app: clean model-free install, authenticated main UI, Settings
  save, failed credential probe preservation and first activation without restart.
- Patched fixture fault injection: port conflict caused a recorded health failure
  and rollback; a subsequent explicit retry committed, retaining credentials,
  configuration and work. The test cleanup now handles canonical profile paths.
- Fresh unique OS application identity with a valid local ad-hoc seal: same Finder
  upgrade, two reopenings and Server survival passed without inherited MetaWork
  background authorization. This is separate from unchanged final artifact proof.
- Final DMG checksum, mounted payload signature/inventory, app resource seal,
  MetaWork code identity, and shell/icon/executable/CodeResources equality passed.
  No test re-signing was applied to the final artifact or its exact test copy.

Final artifact: `apps/desktop/release/MetaWork-darwin-arm64.dmg` (arm64 Internal),
396415280 bytes, SHA-256
`7e93e7bbbeb073b5182c8f2acbb16fca4b79523431dc036c01e9765954d7b106`.
The signed local sidecar identifies source/shell commit `0a3df55c...`.
Evidence: `apps/desktop/release/evidence/{finder-upgrade,fresh-application-identity,
failure-recovery-retry,packaged-install,dmg-verification}.json`.

All test clients/Servers stopped, completed test launchd jobs removed, test DMG
unmounted and 12 disposable fixture directories moved to Trash with a manifest.
The normal `/Applications/MetaWork.app`, installation and Desktop profile were
preserved for the user's requested manual installation. No GitHub operation,
Apple certificate, Intel artifact or paid model task was used.

## Post-installation failed bundle cleanup (2026-10-08)

The user's normal installation subsequently committed `0.1.8-internal-0a3df55`
at 23:17:29; both app and Runtime identities match. A prior recovery left a sibling
`MetaWork.app.metawork-failed-<uuid>` in Applications. Successful commit removed
its own backup but did not own that older orphan. The inactive failed bundle was
moved to Trash after checking the committed journal and running process path;
Applications now contains only `MetaWork.app`, with normal account data retained.

Source correction: shell recovery discards only the failed replaceable app bundle,
then renames the retained original backup into place. It no longer creates a
visible failed-app sibling. An interruption between removal and rename retains
the backup for retry; absence of a backup preserves the installed app. Three
filesystem regressions plus sixteen activation/transaction tests pass, as does
the root typecheck. This follow-up is source-only; the already installed app and
the `0a3df55` DMG were not modified or repackaged.
