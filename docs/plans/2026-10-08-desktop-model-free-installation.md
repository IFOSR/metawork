# Desktop installation without model credentials

- Date: 2026-10-08
- Status: In progress; local arm64 Internal validation only. No publication.

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
prefixes. A dedicated symlink regression test passes. Final package acceptance
and closing commit: pending.
