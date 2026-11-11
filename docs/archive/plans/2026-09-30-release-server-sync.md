# Release Server Synchronization

**Plan date:** 2026-09-30
**Status:** Superseded on 2026-10-03 by GitHub Release distribution
**Goal:** Historical record of the retired installation-server publication path.
GitHub Releases are now the only official distribution service.

**Design:** Reuse the existing signed GitHub assets without rebuilding or
re-signing. Verify all four platform manifests, signatures, release/revision
identity, archive sizes and SHA-256 hashes before activation. Upload to an
isolated directory, retain previous releases, and atomically switch `latest`.
Publish both installers. Verify through public HTTPS and restore the previous
pointer if verification fails. This is release hosting, not account migration
or a change to ADR-0030's local updater.

## Steps

1. Add failing release-set and deployment regression tests, including missing
   targets, mixed versions, corrupt archives and rollback.
2. Implement dependency-free verification and serialized server activation.
   Connect the existing deployment workflow directly to successful publication
   through `workflow_call`; retain a manual repair entry point.
3. Deploy the already published `1.2.0-preview.6-build-0064851` assets, verify
   all public downloads, and preserve old artifacts for in-flight installers.
4. Update release documentation with the synchronization contract and precise
   publication/deployment dates. Run release tests, TypeScript checking and
   workflow syntax validation. Record live evidence and closing commit.

## Delivered

- Published the existing signed `1.2.0-preview.6-build-0064851` assets without
  rebuilding or changing their signatures.
- Atomically switched the installation server's `latest` pointer and published
  both Unix and PowerShell installers.
- Added signed manifest, archive hash/size, release identity, platform
  completeness, and public HTTPS verification.
- Added rollback coverage and connected successful GitHub Release publication
  to the installer deployment workflow.

## Acceptance

- All four public manifests select Preview 6 and revision `0064851`.
- Both installation scripts match the repository.
- All eight public archives pass signed size/hash verification.
- Failed verification leaves or restores the previous `latest` pointer.
- The release workflow includes installation-server deployment, rather than
  relying on a separate manual script-only upload.

**Completion date:** 2026-09-30
**Validation:** `npm run lint`, `node --check` for the three release scripts,
`git diff --check`, 20 focused Release tests passed, and live HTTPS verification
of four manifests, eight archives, `install.sh`, and `install.ps1`; 17
deployment regression tests passed after adding interrupted-activation recovery,
semantic Release ID ordering, and same-ID archive immutability checks. Workflow
YAML passed `actionlint` with the repository's intentional custom
`macos-15-intel` runner label ignored.
**Implementation commit:** `a6063d4` (`fix(release): synchronize published installer assets`)
**Closing commit:** `478c76f` (`fix(release): harden activation recovery`)
