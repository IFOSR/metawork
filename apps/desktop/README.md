# MetaWork Desktop

Electron is a client and installation adapter. The business UI comes from the
same `web` build served by the independent MetaWork Server. Closing a window
hides it; quitting Desktop leaves Server running. The separate stop menu shows
the account's active work and invokes the formal Server stop path.

The v0.1.5 internal DMG is an Apple Silicon package **without an Apple Developer ID
signature and without notarization** for company use. macOS may require Finder
**Open** or **System Settings → Privacy &
Security → Open Anyway** on first launch. Install Command Line Tools with
`xcode-select --install` before first use because the internal Git wrapper calls
macOS's system Git. See the
[acceptance record](../../docs/plans/2026-10-05-metawork-desktop-implementation.md)
and the [release runbook](../../docs/current/releasing.md) for Actions signing/tool
inputs for a future signed public release. The [publication status](../../docs/plans/2026-10-07-v0.1.5-release.md)
records the internal package and its validation.

## Development

Use Node 22.19+ and the npm locks. Planner dependencies remain isolated.

```sh
npm ci
npm ci --prefix web --ignore-scripts
npm ci --prefix apps/desktop
npm ci --prefix planner/AnyFusion-Pi --ignore-scripts
npm run dev:desktop
```

The orchestrator prepares an isolated installation at `.tmp/desktop-development`,
starts its independent Server on a discovered port, runs Vite with HTTP/WS
proxies, and starts Electron. Browser UI development can use the same Vite URL
with ordinary browser login. It never installs terminal commands. The isolated
development account is provisioned with the system-managed `deepseek-flash`
connection so the Settings page contains no placeholder Provider or model.

`npm run dev:desktop -- --production-assets` uses the installed Server's Web
assets instead of Vite. `--refresh` explicitly stops and updates only the marked
development installation; watchers never restart active work. `--prepare-only`
builds/installs without opening the app. An unmarked existing installation is
refused. `METAWORK_DESKTOP_DEVELOPMENT_ROOT` can select another isolated root.

On macOS, refresh also checks open database revisions for old development
Servers whose lock was lost, verifies their process name and installation cwd,
and waits for them to exit before upgrading. It never removes a live socket to
force startup. If an earlier broken development run lost a directory-event
body, use the explicit repair command:

```sh
npm run dev:desktop -- --refresh --repair-directory-journal
```

This stops the verified development Servers, holds the runtime/update lock,
backs up the original database and surviving journal files under the account's
`data/backups/directory-repair-*`, then expires only missing workspace-directory
delivery events. Sequence numbers remain monotonic and clients reload the
directory. Missing Conversation/audit bodies fail closed; the normal updater's
strict companion backup remains unchanged. The repair backup is forensic
evidence of the damaged state, not a complete rollback checkpoint.

```sh
npm run lint:desktop
npm run test:desktop
node scripts/dev-desktop.mjs --prepare-only
npm run smoke:desktop
npm run benchmark:desktop
```

The smoke records evidence under the isolated root, checks authenticated real
Web assets, draft restoration, native bridge operations with controlled dialog
and HTTP fixtures, menu actions, 1440/1100/900 widths, 200% zoom, ten reconnects,
Renderer crash recovery and Server survival after Electron exit. It does not
run a paid model task or certify a signed installation. To stop the isolated
Server, set `METAWORK_INSTALL_ROOT` and `ANYFUSION_INSTALL_ROOT` to that root and
run its installed `dist/index.js server stop` with Node.

The startup benchmark collects 20 warm and 20 cold samples plus Desktop process
and Server RSS/CPU snapshots. Cold samples explicitly stop only the marked
development installation. Results go to `evidence/startup-benchmark.json`;
they measure development Electron and installed Web, without signed payload
verification or model tasks, and do not certify production startup performance.

## Runtime payload and macOS package

First build Server/Web and the offline Planner, then produce the two formal
signed release archives with `scripts/package-release.mjs`. Supply matching
absolute artifact URLs in that manifest. Prepare resources from those archives
and relocatable, licensed tool distributions:

```sh
npm run build:desktop
cd apps/desktop
node packaging/prepare-runtime.mjs \
  --artifacts /build/formal-release \
  --node-root /build/node-distribution \
  --git-root /build/git-distribution \
  --executor-root /build/pi-distribution \
  --trusted-keys /build/trusted-public-keys.json \
  --signing-key /secure/release-private.pem \
  --key-id release-key-id \
  --source-commit FULL_COMMIT_ID \
  --codesign-identity 'Developer ID Application: YOUR COMPANY (TEAMID)' \
  --output /build/desktop-resources
```

The tool directories provide `bin/node`, `bin/git`, and `bin/pi`, respectively,
plus their complete libraries/resources/licenses. The preparer checks the
signed archive hashes, rejects links/special archive entries, verifies the
payload inventory, probes Node ABI/SQLite/Git/Pi and produces a signed Desktop
descriptor. Production preparation signs every Mach-O/native module before
sealing the inventory and rejects absolute non-system library dependencies.
Tool probes use bundled executables and a restricted PATH.
[Dependency gates](packaging/DEPENDENCIES.md) describe the remaining
redistribution and native-library checks. Production builds require the exact
clean source commit. Development signatures require `--development true` and
are rejected by packaged Main.

```sh
METAWORK_DESKTOP_RESOURCES=/build/desktop-resources \
CSC_NAME='Developer ID Application: YOUR COMPANY (TEAMID)' \
METAWORK_NOTARY_PROFILE=metawork-notary \
npm run package:mac -- --arm64
```

Build x64 on its own Intel runner with `--x64`. Packaging enforces signing,
notarizes/staples both the app and DMG, and runs Gatekeeper verification. It
does not publish artifacts. No signing key, provider secret, database or runtime
worktree belongs in the repository or application resources.

## Installation, updates and removal

The main menu's **检查更新…** checks the official latest release and offers a
matching Mac DMG download after confirmation. It never silently installs or
downgrades a newer local build. Install the download by quitting Desktop and
replacing the app in Applications. **高级 → 从文件安装更新…** remains available
for an already downloaded application. Installation selection, terminal setup,
Server stop and clearing local login/drafts also live under **高级**.
Reconnect is disabled while connected or connecting, and becomes available on
connection failure. **修复未完成的更新…** appears only when recovery is required.

First launch verifies the bundled distribution, accepts model configuration in
the startup page and invokes the native installer in a separate Node process.
Production installation does not require developer internal LLM credentials.
Optional internal AI features remain unavailable until separately provisioned;
existing internal configuration is preserved during update.
The canonical installation is `~/.metawork` unless explicitly selected. Finder
can restore an installation/configuration selection from Desktop preferences.
An existing incompatible Runtime is rejected rather than opening a second one.

Use **安装新版应用…** in a running compatible Desktop to select the next signed
MetaWork.app. The adapter verifies its signing team, release trust and
compatibility, stages it, and asks for the global-stop impact confirmation.
After Desktop exits, an independent installed helper runs the native updater,
replaces the app, checks the new Server identity and waits for the new Desktop
to authenticate and render shared Web assets before committing. On failure it
uses the native backup/journal-companion guards before
restoring the previous app. **修复未完成的更新…** retries an interrupted transaction.
Version/schema combinations not supported by the current adapter are refused;
do not bypass that gate by copying a Runtime directory over `app/current`.

Terminal command installation is optional and refuses unrelated launchers.
Removing the app does not stop Server or remove account data. Stop Server
explicitly before removing the desktop application and its generated app
backups. Keep `~/.metawork` and any selected configuration directory to retain
work. Account/database removal is a separate deliberate operation; there is no
automatic destructive uninstall path.

Notifications are generic and available only while Desktop is running. They
navigate to authorized Web views; approvals always use the latest Server
revision/generation. Logout clears desktop drafts/route/viewport state and the
private session. Provider credentials remain in the existing SecretStore.
