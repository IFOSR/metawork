# Phase 2: One-Command Prebuilt Release Install

- Status: Delivered and deployed (2026-09-03)
- Plan date: 2026-09-03
- Scope: A1 packaging pipeline, A3 re-run-as-update semantics, A2 user-facing
  `install.sh`, C2 end-to-end verification, A4 README quick install.
- Out of scope (tracked separately): npm distribution (blocked on commercial
  licensing decision), native Windows support, cosign/GPG beyond the existing
  Ed25519 manifest chain.

## Delivered behavior

1. **Packaging (A1)** — `scripts/package-release.mjs` (`npm run
   package:release`) packages the built Runtime (`dist`, `web/dist`,
   `node_modules`, `package.json`) and the vendored Planner (excluding `.git`)
   into per-platform tarballs plus `manifest.<platform>-<arch>.json`. The
   manifest matches the existing `scripts/bootstrap-install.sh` trust contract
   (schema v1: releaseId, channel, expiry, minimum versions, artifact
   byteSize/sha256, compatibility block, Ed25519 signature). Signing uses
   `--signing-key`/`METAWORK_RELEASE_SIGNING_KEY`; `--generate-dev-key`
   exists for local testing only. `stableStringify` is kept in sync with
   `src/installation/release-manifest.ts` and the verifier embedded in the
   installer scripts.

2. **User installer (A2)** — `scripts/install.sh`: downloads and verifies the
   signed manifest and both artifacts before extraction, reconnects the
   terminal (`/dev/tty`) under `curl | bash` so the Phase 1 provider wizard
   can run, and hands off to the offline installer. Fail-closed environment
   aliases (`METAWORK_*`/`ANYFUSION_*`) are preserved.

3. **Re-run semantics (A3)** — the installer detects an existing
   `app/current`: a different release ID routes through the update
   transaction (configuration, secrets, and task data preserved; database
   upgraded to a new revision); the same release ID exits 0 as a no-op.

3b. **Uninstall** — `install.sh --uninstall [--purge]` (offline, same entry
   point) stops a running Server via its lock file PID, removes only
   launchers carrying the managed marker (user-owned files with the same
   names survive), clears legacy launcher backups with `--purge`, and deletes
   the install root after restoring write access to read-only release trees.

4. **Fixed en-route defect** — `src/install-cli.ts` now compares
   `import.meta.url` against `realpathSync(process.argv[1])`. Without this,
   macOS launch paths under `/var/folders/...` or `/tmp` (symlink chains to
   `/private`) never matched the module URL, so the installer entry point
   silently exited 0 without running. This also unblocks the pre-existing
   `scripts/bootstrap-install.sh` on macOS.

5. **README (A4)** — both READMEs lead with the one-command install; source
   install moved to a dedicated section; maintainer packaging notes added.

## Deployment (2026-09-03)

The release host is the Huoshan server at `https://14.103.216.193/metawork-release/`
(nginx location on the existing 443 default server; the IP's Let's Encrypt
certificate covers it, and plain HTTP 301-upgrades to HTTPS). Files served:

- `install.sh` — stable entry point
- `latest/` → `1.2.0-preview.0-37d5d43/` — current release directory
- per-platform tarballs (darwin-x64, **darwin-arm64**, linux-x64) + signed
  manifests, key id `metawork-release-2026-01`

The darwin-arm64 package was cross-produced on the Intel workstation without
any M-series hardware: the whole product has exactly one first-party native
module (`better-sqlite3`), whose official `node-v127-darwin-arm64` prebuild
was fetched from the upstream GitHub release and swapped into an otherwise
pure-JS tree; the vendored Planner's platform-specific packages
(`@rolldown/binding-darwin-*`, `@mariozechner/clipboard-darwin-*`,
`lightningcss-darwin-*`) were replaced from the npm registry, while
`fsevents` ships a universal binary and `@earendil--works/pi-tui` prebuilds
already carry both architectures. All embedded binaries were verified with
`file` to be arm64/universal; runtime verification on real Apple Silicon
hardware is still pending (first M-series user should confirm).

The production signing key pair lives outside the repository at
`~/.config/metawork-release/metawork-release-2026-01.{private,public}.pem`
(private key mode 0600). Its public key is embedded in `scripts/install.sh`.
A `nip.io` host name was tried first and is blocked by the provider's web
block service (`webblock.volcengine.com`); the IP + TLS path is the working
contract. Packaging notes: production trees must run `npm ci --omit=dev`
**without** `--ignore-scripts` (better-sqlite3 prebuild download), and tar
staging dereferences symlinks (`tar -h`) for npm workspace layouts.

## Validation

- `npm run lint` (tsc) passes; `tests/installation/` 23 files / 119 tests
  pass; `tests/scripts/install-script.test.ts` (new) asserts the installer's
  trust ordering, update/idempotency semantics, TTY reconnection, alias
  conflict handling, and platform guard; existing
  `tests/scripts/bootstrap-install-trust.test.ts` unchanged and passing.
- Deployed-host end-to-end: fresh headless install over the real
  `https://14.103.216.193/metawork-release/install.sh` (darwin-x64) including
  `metawork --help` on the installed launcher; interactive wizard path over
  pty (preset, masked key, live probe rejection, install, no key leakage);
  linux-x64 package installed and launched inside a `node:22-slim` container.
- Earlier local smoke (dev key, local HTTP) additionally verified the
  update path: a task row, provider config, and secret survived an update to
  a second release ID, and a third run of the same manifest exited 0.

## Open items

- CI automation: a tag-triggered workflow running `npm run package:release`
  with the production key from a clean tree (today the release was packaged
  and uploaded manually from a workstation; the darwin-arm64 variant was
  cross-packaged as described above, and linux-arm64 can follow the same
  cross-packaging recipe if needed).
- Decide the npm distribution model (B1) separately.
