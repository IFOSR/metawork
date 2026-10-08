# Customer upgrade reliability

- Plan date: 2026-10-08
- Status: Completed locally; release gate and source correction ready for next release
- Scope: Establish the published v0.1.7 failure conditions, repair the normal
  customer upgrade/recovery path, and validate Desktop and native Server upgrades.

## Acceptance

- Reproduce using the released app and actual older Runtime, with isolated
  account data and the constrained environment of a Finder launch.
- Compare fresh installation, matching-release reuse, old-to-new upgrade,
  rejected/failed upgrade, interrupted recovery and a subsequent successful retry.
- Preserve configuration, credential contents and durable account facts; verify
  the final authenticated Desktop render and matching Server identity.
- Exercise native Server updater rollback/recovery separately. State platform
  and release-asset limits explicitly rather than extrapolating Mac results.
- Provide a customer recovery procedure using verified product entry points,
  with safe failure diagnostics and no manual database/journal edits.
- Record fixes, validation evidence, remaining limitations and closing commit.

The prior laptop recovery and source-only loop correction are documented in
`2026-10-08-desktop-update-recovery-loop.md`; they are not broad release acceptance.

## Findings

The released v0.1.7 path can complete a normal old Runtime to Desktop adoption;
an isolated run using the unchanged release preserved authentication, the
Server process, configuration and credentials. The failure is conditional:
readiness failures or interrupted shell replacement can leave a recovery
journal. The old Desktop then held its helper lock during relaunch and treated
terminal rollback as an unfinished update. Its repair action could reapply the
same request, producing the loop seen on the user's Mac. The original local
readiness failure is not recoverable from the old redacted logs, so this plan
does not assign it a narrower cause.

## Delivered behavior

- The update transaction now distinguishes repair-only recovery from applying a
  new request, releases its helper lock before relaunch, and refuses mismatched
  journals.
- Recovery diagnostics persist only bounded stage and allowlisted error codes;
  diagnostic write failures cannot block authoritative rollback.
- A newly downloaded, verified Desktop provisions its own support helper before
  repairing an interrupted transaction. Recovery still preserves the original
  activation identities and trust anchor when staging or the old helper is gone.
- After the candidate passes its authenticated health check and the activation
  journal is committed, the helper removes the old application backup and the
  temporary staged bundle. Failed or interrupted activation retains both for
  rollback.
- The release workflow now uses the previous latest DMG on both macOS
  architectures and injects a readiness failure plus a killed-helper
  interruption, then verifies rollback, repair, retry and retained data.

## Validation

- Native activation, source updater, transaction, diagnostics and shell-health
  focused suites passed; Desktop tests, root/Desktop lint and builds passed.
- The published v0.1.7 app completed a normal old-runtime adoption in an
  isolated account.
- The patched isolated Desktop completed failure → rollback → repair → retry
  and helper-kill → recovery → retry, preserving authenticated rendering,
  configuration, credentials and a database work sentinel. The fixture uses an
  ephemeral signing key and is not a release artifact.
- The local arm64 Internal DMG passed clean installation and DMG checksum
  verification. The existing committed backup was removed from `/Applications`
  after confirming the new Desktop was running.
- Linux and Intel real-host execution were not performed on this workstation;
  both remain required by the release matrix.

## Customer rollout

v0.1.7 remains subject to the advisory in its release notes. Publish a new
version containing this correction only after the release workflow's previous
DMG gate passes. Customers with a working installation do not need to
downgrade; customers in a recovery loop should use the verified Desktop repair
procedure in `docs/current/releasing.md` and preserve their installation data.

Closing commits: `fix(desktop): make update recovery safe for customers` and
`fix(desktop): remove committed update backups`.
