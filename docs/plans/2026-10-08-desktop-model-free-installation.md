# Desktop installation without model credentials

- Date: 2026-10-08
- Status: Model-free installation completed locally; Finder upgrade acceptance failed and is superseded by the lifecycle correction below. No publication.
- Completion date: 2026-10-08
- Closing implementation commit: `0f7e73418e29548268fbdd65e09b6057ad01e7b8`.

## Scope and ownership

Fix internal release hash ordering and separate installation from model setup.
Installer remains the sole owner of release/configuration initialization. It
creates an ordinary revision with empty Provider/Model catalogs and disabled
editable AgentClass presets; no fake endpoints or credentials are generated.
Configuration owns the absent Planner binding. Server/Application Shell composes
the same AccountRuntime and Gateway while semantic work remains unavailable.
Planning retains its existing supervisor and receives a real binding only via
the existing strict-idle configuration activation/compensation transaction.
Web renders shared configuration readiness and routes setup to ordinary Settings.
Desktop removes its credential form/IPC and initializes through the native helper.
No additional storage writer, semantic router, recovery policy, or Desktop backend.

Internal commit hashes are immutable build identities, not chronological version
numbers. Comparisons ignore only the known internal commit suffix, preserving
ordinary semantic version, signature, protocol and database compatibility gates.

## Validation and delivery

Required: focused installer, release ordering, nullable Planner/activation tests;
root/Desktop/Web typechecks; packaged fresh install through main UI and Settings;
real prior Runtime adoption preserving configuration and data; local arm64 DMG.
User installs the final artifact manually. Existing normal installation is not a
test target. No GitHub release, push, tag, Apple identity or Intel build.

Preliminary validation: packaged model-free install, Settings save, failed
credential probe and first activation without restart passed. Update acceptance
found a logical/canonical path mismatch for symlinked installation directories;
the helper now checks physical request identity while preserving selected path
prefixes. A dedicated symlink regression test passes.

Final validation:

- 131 focused native tests passed across installer/updater, release comparison,
  request paths, staged configuration, activation, account Planner and supervisor.
  All 16 Desktop tests passed. Root/Desktop typechecks and Web production build passed.
- Exact final app: automatic installation with empty Provider/Model catalogs;
  authenticated main UI and Settings; saving disabled presets; a failed credential
  probe preserves revision/readiness; first real configuration activation succeeds
  without restarting Server. No paid model request was executed.
- Exact app copied without modifying/re-signing its shell or payload: actual prior
  Runtime `0.1.8-internal-bc0fb75` upgraded to `0.1.8-internal-0f7e734` through a
  symlinked `/tmp` installation root. Cancellation preserved the original service;
  accepted update committed with authenticated render, unchanged configuration
  content hash, unchanged credential file and retained database sentinel.
- DMG filesystem verification and mounted signed payload inventory passed. Mounted
  app.asar, icon and descriptor match the tested app. The test mount was detached.

Local delivery: `apps/desktop/release/MetaWork-darwin-arm64.dmg`, arm64 Internal,
392411144 bytes; SHA-256
`00f9c164a2c478e2b761add7395ee0682e56c68a1745d20131ebe5c140e4b649`.
Desktop and Runtime both come from the closing implementation commit. Evidence is
under `apps/desktop/release/evidence/` and
`.tmp/onboarding-0f7e734/exact-upgrade/evidence/`. No normal installation was
replaced, and no release/tag/push/upload was performed. User installs the DMG
manually to complete personal acceptance.

## Acceptance correction (2026-10-08)

The user's Finder installation reproduced an update loop. The previous direct
Electron process smoke did not validate LaunchServices process-coalition cleanup,
so it was insufficient to claim customer upgrade readiness. See
[Finder lifecycle correction](2026-10-08-desktop-finder-update-lifecycle.md).
