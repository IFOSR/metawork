# Publishing Server/Web and Desktop together

Root, Web and Desktop package/lock versions must match. Prepare release notes,
CHANGELOG and a release plan before tagging. Use a new version: the workflow
refuses to overwrite published releases. Source preparation is not publication.

## GitHub Actions configuration

Keep all secret values out of Git and logs.

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `METAWORK_RELEASE_SIGNING_KEY` | Existing Ed25519 private PEM matching `metawork-release-2026-03` |
| Secret | `METAWORK_APPLE_CERTIFICATE_P12` | Base64 Developer ID Application certificate and private key |
| Secret | `METAWORK_APPLE_CERTIFICATE_PASSWORD` | P12 import password |
| Secret | `METAWORK_APPLE_ID` | Notarization Apple ID |
| Secret | `METAWORK_APPLE_APP_PASSWORD` | App-specific notarization password |
| Variable | `METAWORK_APPLE_TEAM_ID` | Apple developer team |
| Variable | `METAWORK_APPLE_SIGNING_IDENTITY` | Exact Developer ID Application identity |
| Variable | `METAWORK_DESKTOP_TOOLS_DARWIN_ARM64_URL` | HTTPS URL of the reviewed arm64 tool archive |
| Variable | `METAWORK_DESKTOP_TOOLS_DARWIN_ARM64_SHA256` | SHA-256 of that archive |
| Variable | `METAWORK_DESKTOP_TOOLS_DARWIN_X64_URL` | HTTPS URL of the reviewed Intel tool archive |
| Variable | `METAWORK_DESKTOP_TOOLS_DARWIN_X64_SHA256` | SHA-256 of that archive |

Each tool archive contains regular files/directories under `node/`, `git/` and
`executor/`, with executables `node/bin/node`, `git/bin/git`, `executor/bin/pi`.
Include complete libraries, Git templates/libexec, package dependencies and
licenses. Dereference symlinks when creating the archive. Node must be 22.x/ABI
127 and match the native runner. Homebrew links, host `/usr/bin/git`, credentials
and tools requiring downloads on the user's machine are not valid inputs.
See [dependency acceptance](../../apps/desktop/packaging/DEPENDENCIES.md).

## Build and publish

1. Run type checks, focused release/installer tests and Web/Desktop builds.
2. Complete signed clean-machine and coordinated-update acceptance on both Mac
   architectures. Record evidence in the release plan.
3. Once acceptance/infrastructure are ready, remove publication-pending wording
   from READMEs/release notes and set the release date. Commit the exact source.
4. Push `vVERSION`, or dispatch the release workflow against the exact commit.
   Preflight checks versions/tag and signing/tool configuration.
5. Native jobs produce Server including `web/dist`, Planner and signed manifests.
   Desktop jobs consume those same archives, prepare signed payloads, sign and
   notarize/staple DMGs, exercise a clean installation with fixture provider
   settings and a restricted PATH, and sign their download manifests. This
   smoke checks installation/authenticated Web/Server survival, not paid tasks
   or coordinated update recovery; those remain separate acceptance evidence.
6. Publication verifies four native manifests/eight archives, two Desktop
   manifests/two DMGs and two installer scripts (18 files). It uploads a draft,
   downloads/verifies it again, then promotes latest. A failed build preserves
   the previous latest release; a published version requires a new tag.
7. Verify unauthenticated README downloads and exercise installers in disposable
   installations. Record source/closing commits, evidence and completion date.

Runtime manifests contain immutable tag-based artifact URLs, preventing mixed
downloads during latest promotion. Desktop filenames are
`MetaWork-darwin-arm64.dmg` and `MetaWork-darwin-x64.dmg` inside an immutable tag.

## Installation behavior

Production Desktop accepts the user's provider configuration without copying
developer internal LLM credentials. Existing internal configuration is preserved;
when absent, optional internal AI functions remain unavailable. The development
helper's system-model provisioning is separate from production installation.

Desktop updates coordinate app and Server through **Install New Application…**.
CLI-managed installations stop Server, run the installer, and restart. Clients
of the same installation/account share one Server and its data.

## Local production preparation

See [Desktop packaging](../../apps/desktop/README.md#runtime-payload-and-macos-package).
Pass `--artifact-base-url https://github.com/IFOSR/metawork/releases/download/vVERSION`
to `scripts/package-release.mjs` or `npm run build:release --`. Build each target
on a matching native host. Development signatures cannot produce production apps.
