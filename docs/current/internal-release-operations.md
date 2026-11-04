# Internal release operations (no Apple notarization)

Runbook for publishing an **internal** release: the same Runtime/Planner/Memory
archives as a formal release, plus an Apple Silicon DMG that is ad-hoc signed
instead of Developer ID signed and notarized. Use it when the build is for
internal verification and will not be submitted to Apple; use
[releasing.md](releasing.md) for a formal, notarized release.

Recorded from the `v0.1.21` internal release (2026-11-03); re-run unchanged for
`v0.1.23` (2026-11-04): 14 assets, DMG 465,056,678 bytes in 12 parts, Runtime
workflow 9m43s, DMG assembly 2m.

## What gets published

| Asset | Target(s) | Built by |
| --- | --- | --- |
| `metawork-VERSION-build-<sha>.tar.gz` | `darwin-arm64`, `darwin-x64`, `linux-x64` | `internal-runtime-release.yml` |
| `planner-VERSION-build-<sha>.tar.gz` | same three | `internal-runtime-release.yml` |
| `memory-VERSION-build-<sha>.tar.gz` | same three | `internal-runtime-release.yml` |
| `manifest.<target>.json` (signed) | same three | `internal-runtime-release.yml` |
| `install.sh` | — | `internal-runtime-release.yml` |
| `MetaWork-darwin-arm64.dmg` | Apple Silicon only | built locally, assembled by `internal-desktop-upload.yml` |

Not published by this path: the Intel DMG, native Windows (and `install.ps1`),
and container images (`publish-images.yml` is a separate manual workflow).

The three Runtime targets are not optional: the internal publish step calls
`verifyReleaseAssets` with a fixed `['darwin-arm64','darwin-x64','linux-x64']`
target list, so a missing target fails the whole upload. "Skip the Intel DMG"
means skip the DMG only.

## Required configuration

Internal releases need **one** credential, and no Apple material:

| Kind | Name | Why |
| --- | --- | --- |
| Secret | `METAWORK_RELEASE_SIGNING_KEY` | Signs the Runtime manifests and (when used) the Desktop descriptor. Must match the repo trust root `metawork-release-2026-03` in `scripts/verify-release-assets.mjs`. |

Do **not** configure `METAWORK_APPLE_*` for this path. `release-build.yml`
preflight requires them; the internal workflows do not read them.

## Runbook

### 0. Version and notes

1. Bump `version` in `package.json`, `web/package.json`,
   `apps/desktop/package.json` **and** each `package-lock.json`
   (`version` plus `packages[""].version`) to the new version.
2. Add a `CHANGELOG.md` section.
3. Write `docs/releases/vVERSION.md` (title `MetaWork VERSION (Internal)`).
   State that the build is internal and not Apple-notarized, list the downloads,
   and list what is deferred (Intel DMG, Windows, images).
4. `npx tsc --noEmit`, focused tests, then commit and push.

Published releases are immutable: never reuse a version that already exists.

### 1. Keep the formal pipeline from firing

`release-build.yml` triggers on `push: tags: v*`. Creating the release tag for an
internal build would start it, and it fails immediately because the Apple secrets
are absent — leaving a red run. Disable it for the duration and re-enable after
publishing:

```sh
gh api -X PUT repos/IFOSR/metawork/actions/workflows/371354739/disable
gh api repos/IFOSR/metawork/actions/workflows/371354739 --jq .state   # disabled_manually
# ... release work ...
gh api -X PUT repos/IFOSR/metawork/actions/workflows/371354739/enable
gh api repos/IFOSR/metawork/actions/workflows/371354739 --jq .state   # active
```

### 2. Create the draft release

```sh
COMMIT=$(git rev-parse HEAD)
gh release create vVERSION --draft --target "$COMMIT" \
  --title "MetaWork VERSION (Internal)" --notes-file docs/releases/vVERSION.md
```

A draft created this way can carry a placeholder tag (`untagged-…`) until the tag
ref exists. Fix it explicitly, otherwise `gh release view vVERSION` and the
desktop workflow cannot resolve the release:

```sh
ID=$(gh api repos/IFOSR/metawork/releases --jq '.[] | select(.tag_name|startswith("vVERSION")) | .id')
gh api -X PATCH "repos/IFOSR/metawork/releases/$ID" -f tag_name=vVERSION
git push origin "$COMMIT:refs/tags/vVERSION"
```

### 3. Build the Runtime archives (CI)

```sh
gh workflow run internal-runtime-release.yml \
  -f release_tag=vVERSION -f source_ref=main
gh run list --workflow=internal-runtime-release.yml -L 1
```

The workflow installs dependencies, prepares and verifies the pinned memory
engine (FTS5 gate), builds the Runtime for its three native runners with
`npm run build:release`, verifies signatures/hashes/revisions against the tag, and
uploads 13 assets into the existing release with `--clobber`.

### 4. Build the Apple Silicon DMG locally

A DMG cannot be produced by CI on the internal path (no Apple identity), and the
payload must be prepared for the **same commit** as the Runtime archives, because
`prepare-runtime.mjs` requires `sourceCommit` to start with the manifest revision.

```sh
W=.tmp/internal-release
mkdir -p "$W"
node scripts/package-release.mjs --source-root . --out-dir "$W/artifacts" \
  --release-id "VERSION-desktoppayload-$(date +%H%M)" --channel stable \
  --key-id local-verify --signing-key "$W/key.private.pem" \
  --memory-root "$W/memory/tdai" --memory-revision installed-engine \
  --memory-source local \
  --artifact-base-url "https://github.com/IFOSR/metawork/releases/download/vVERSION"

node apps/desktop/packaging/prepare-runtime.mjs \
  --artifacts "$W/artifacts" \
  --node-root <tools>/node --git-root <tools>/git --executor-root <tools>/executor \
  --trusted-keys "$W/trusted-release-keys.json" \
  --signing-key "$W/key.private.pem" --key-id local-verify \
  --source-commit "$(git rev-parse HEAD)" --development true \
  --output "$W/resources"

cd apps/desktop
METAWORK_DESKTOP_RESOURCES="$PWD/../../$W/resources" METAWORK_DESKTOP_INTERNAL=1 \
  npx electron-builder --config packaging/electron-builder.config.mjs --mac --arm64 --publish never
```

Notes:

- `--development true` is what makes the descriptor internal; the API also
  requires `development: true` to accept it, and `METAWORK_DESKTOP_INTERNAL=1`
  substitutes an ad-hoc seal for Developer ID signing + notarization.
- `--memory-root` must point at a **writable** copy of the engine. A read-only
  engine tree taken from an installed release makes both `package-release.mjs`
  and `install-cli` fail with `EACCES`/`ENOTEMPTY` while cleaning staging.
- The local ad-hoc key pair only satisfies local verification; it is not the repo
  trust root, so these artifacts are not accepted by `verifyReleaseAssets`.

Confirm the payload identity before uploading:

```sh
python3 -c "import json;d=json.load(open('release/mac-arm64/MetaWork.app/Contents/Resources/desktop-release.json'));print(d['releaseId'], d['sourceCommit'], d['development'])"
codesign --verify --strict release/mac-arm64/MetaWork.app
shasum -a 256 release/MetaWork-darwin-arm64.dmg
stat -f "%z" release/MetaWork-darwin-arm64.dmg
```

### 5. Upload the DMG in parts and let CI assemble it

GitHub asset uploads of ~450 MB are unreliable from a laptop, so split the DMG
into 40 MB parts named `MetaWork-darwin-arm64.dmg.part-NNNN` (4 digits, index 0):

```sh
rm -rf /tmp/dmgparts && mkdir -p /tmp/dmgparts
split -b 40m -a 4 -d apps/desktop/release/MetaWork-darwin-arm64.dmg \
  /tmp/dmgparts/MetaWork-darwin-arm64.dmg.part-
cat /tmp/dmgparts/* | shasum -a 256    # must equal the DMG hash

# Upload in batches of ~4 parts; each takes about 2 minutes.
gh release upload vVERSION /tmp/dmgparts/MetaWork-darwin-arm64.dmg.part-000{0,1,2,3}
```

Then assemble, verify and publish the single asset from CI:

```sh
gh workflow run internal-desktop-upload.yml \
  -f release_tag=vVERSION \
  -f source_commit="$(git rev-parse HEAD)" \
  -f sha256="$(shasum -a 256 apps/desktop/release/MetaWork-darwin-arm64.dmg | cut -d' ' -f1)" \
  -f byte_size="$(stat -f "%z" apps/desktop/release/MetaWork-darwin-arm64.dmg)" \
  -f part_count=12
```

The job requires a **draft** release whose `targetCommitish` equals
`source_commit`, concatenates the parts in order, checks size and SHA-256, uploads
`MetaWork-darwin-arm64.dmg`, verifies the asset digest and deletes the parts.
If the target commit is wrong, either dispatch with the release's commit or
`gh api -X PATCH .../releases/$ID -f target_commitish=<sha>` first.

### 6. Verify and publish

```sh
gh api repos/IFOSR/metawork/releases/$ID --jq '.assets[] | "\(.name) \(.size) \(.digest)"'
gh release edit vVERSION --draft=false --latest \
  --title "MetaWork VERSION (Internal)" --notes-file docs/releases/vVERSION.md
gh api repos/IFOSR/metawork/releases/latest --jq .tag_name
gh api repos/IFOSR/metawork/actions/workflows/371354739 --jq .state   # re-enable first
```

Expected asset count: 13 Runtime/Planner/Memory assets + 4 extras (`install.sh`,
3 manifests) counted inside those 13, plus the DMG — i.e. 14 assets with no
`part-*` left behind.

## Pitfalls seen and fixed

| Symptom | Cause | Fix |
| --- | --- | --- |
| `missing build output: memory/tdai/package.json` | `internal-runtime-release.yml` predated the bundled memory engine | added `prepare-memory-engine.mjs` + `verify-memory-engine.mjs` (same as the formal pipeline) |
| `ERR_MODULE_NOT_FOUND: esbuild` while preparing the engine | the engine script imports the repo toolchain but ran before any install | both release workflows now run `npm ci` before preparing the engine |
| `fatal: remote error: upload-pack: not our ref <sha>` | dispatch used a hand-typed commit that does not exist | always use `$(git rev-parse HEAD)` or `source_ref=main` |
| `Runtime compatibility matrix mismatch` in `prepare-runtime.mjs` | payload built from a different commit than the Runtime artifacts | rebuild the archives (`package-release.mjs`) from the same commit before preparing |
| `gh release view vVERSION` → `release not found`, `releases/tags/…` → 404 | a fresh draft carries an `untagged-…` placeholder and `/releases/tags/` never returns drafts | PATCH `tag_name`, create the tag ref, and resolve drafts by listing releases |
| `ReleaseAsset.name already exists` / partial asset set | upload interrupted midway | list assets, delete the leftovers via the assets API, re-upload |
| `net/http: TLS handshake timeout` from the GitHub API | transient network/API failures | retry the same command; no state change is needed |
| `Installed Runtime is newer; download a newer Desktop` in the app | Desktop refuses to adopt a candidate whose version compares lower than the installed runtime | bump the version for the new build instead of reusing it |

## Related

- [releasing.md](releasing.md) — formal notarized release pipeline and required Apple configuration.
- `docs/releases/` — per-version release notes used as the GitHub release body.
- `scripts/verify-release-assets.mjs` — the asset/signature contract every published release must satisfy.
