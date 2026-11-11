# Desktop adoption of an existing Web Runtime

- Plan date: 2026-10-08
- Status: Complete; published in v0.1.6 on 2026-10-08

## Problem and delivery

Desktop treats any existing release identity as a Desktop installation, then
requires a Desktop-only Node path before checking compatibility. Native Web/TUI
installations either fail immediately or have no actionable upgrade entrance.

- Matching releases reuse the existing account, configuration and Server. Missing
  Desktop tools are provisioned from the verified payload outside the immutable
  active release; no fresh account or configuration is created.
- Older releases get an in-app upgrade action using the already downloaded app.
  The existing native updater owns database/configuration migration, backup,
  pointer activation and rollback. No API-key form is shown for existing installs.
- The update helper can stop/restart a pre-Desktop Server through its formal CLI,
  without requiring a Desktop session from that old Server.
- Joint activation still waits for authenticated Desktop rendering. Recovery has
  a stable verified helper independent of the staged application.
- App staging uses Electron's physical filesystem to retain `app.asar` as an
  archive and preserves relative framework symlinks. Relaunch keeps the Desktop
  profile. Internal packages also pass the existing signed-payload verifier.
- Account preferences use `account-preferences`, avoiding Chromium's
  `Preferences` file on case-insensitive macOS. Existing drafts/preferences are
  copied forward without overwriting newer data. Startup diagnostics record only
  allowlisted error codes and stages, never exception bodies or credentials.
- The retired `1.2.0-preview.*` numbering can migrate into the `0.1.*` line;
  ordinary stable downgrades are rejected before provisioning or stopping Server.

## Ownership and validation

Electron owns presentation and installation transport only. Installation helpers
own provisioning and native activation; Client adapters own formal lifecycle
commands. Storage/Kernel/Planner ownership and public Gateway semantics do not
change. No parallel migration implementation is introduced.

Validate matching native reuse, older-release adoption, user cancellation,
preserved configuration/data, missing tools, failed activation and recovery.
Run Desktop and owning installation tests, type checks and builds; exercise an
isolated real Electron/native fixture where available. Never use the developer's
normal installation or customer data for acceptance.

## Completion

- Completion date: 2026-10-08 (implementation and local acceptance).
- 13 Desktop tests and 63 focused native lifecycle/release/installation/update/
  rollback tests passed. Root/Desktop TypeScript checks and Runtime/Desktop
  builds passed.
- Real packaged Electron fixture: matching native Runtime, with no Desktop tools,
  reached authenticated Web while keeping the original Server PID, config,
  credentials and database marker. An older-identity native fixture exercised
  cancellation (including the real confirmation path), upgrade, Desktop relaunch
  and the authenticated-render commit receipt, retaining the same account data.
  This fixture uses current Server code to isolate adoption/lifecycle behavior;
  old schema compatibility was checked separately below.
- The reported customer commit `e33e516` actually uses schema 37. Its original
  migrations source created a real schema-37 database with a Task and interaction.
  The current native updater migrated it to schema 47, retaining both records,
  configuration and credentials, then rolled it back to schema 37 with the
  interaction intact. Evidence: `.tmp/schema37-7AK4ZX/evidence.json`.
- Packaged fixture/evidence live under `.tmp/desktop-adoption-acceptance-v3`;
  isolated runtime roots are under `.tmp/adopt-muyw6hwv`. Tests used synthetic
  credentials and made no provider requests. No customer or normal developer
  installation was changed. The fixture uses an ephemeral signing key and is
  not a customer release.
- Closing implementation commit: the `fix(desktop): adopt existing native runtimes`
  commit containing this plan. Release delivery is tracked in
  `2026-10-08-v0.1.6-release.md`.

- Customer delivery: [v0.1.6](https://github.com/IFOSR/metawork/releases/tag/v0.1.6), source commit `c534d4c6`; final DMG passed clean installation, native reuse and old-version adoption.
