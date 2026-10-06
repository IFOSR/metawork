# MetaWork Desktop implementation

- Status: Native implementation validated and accepted by the user; signed release acceptance remains open
- Plan date: 2026-10-05
- Authority: approved Desktop design and ADR-0045
- Branch: `feat/metawork-desktop`
- Working tree: `/Users/yuanjubian/program/metawork-desktop`
- Git storage: shared with original repository; separate fork removed per user clarification
- Original main: `/Users/yuanjubian/program/metawork`; preserve unrelated local notes during integration
- Remote sync / merge: authorized by the user on 2026-10-06 after validation
- Native implementation acceptance date: 2026-10-06; closing commit recorded below after commit creation
- Last validated: 2026-10-06 (Asia/Shanghai)

## 2026-10-06 main integration authorization

The user accepted the current implementation and explicitly requested merging
all validated Desktop changes to main and pushing to GitHub. This supersedes
the historical no-merge/no-push instructions recorded below. The integration
includes Desktop, unified settings activation, internal LLM provisioning,
baseline agent operations, PDF/vision support and execution activity/cleanup
repairs. The latest PDF acceptance records 539 focused tests and real Electron,
synthetic-PDF and original-invoice business results. This is a source integration,
not a claim that unsigned local acceptance completes signed-release gates.

## 2026-10-06 agent baseline operations follow-up

- Source implementation and native/live Electron validation completed 2026-10-06. See the
  [baseline operations plan](2026-10-06-agent-baseline-permissions-design.md)
  and [ADR-0046](../adr/0046-agent-baseline-operations-and-responsibility-separation.md).
- Remove research/engineering permission selection for ordinary Executors;
  provide system-owned baseline operations and separate responsibility from
  authorization. Preserve Planner, restricted custom agents and historical
  revision boundaries. Eligible existing profiles migrate only through the
  combined settings activation transaction.
- Verified 585 related regressions, 30 Web unit tests, 7 browser workflows,
  combined public fetch/local analysis/test commands on the native backend,
  and new Electron acceptance against the refreshed Server. Draft edits kept
  the old revision; unified activation migrated eligible profiles without a
  Server restart. Temporary test agents were removed and user settings retained.
- Real Docker execution remains open: this host has no Docker installation.
  Native evidence does not certify Docker or a full Planner/LLM business task.
  Closing commit: not created; changes remain in the local working tree.

## 2026-10-06 development journal recovery follow-up

- Reported refresh failed before activation because directory stream sequence 3
  referenced missing segment `a70f3f4f-c3ee-4ce6-bc72-f1dd59970ac7` (530 bytes).
  No retained backup or snapshot contained the original body. Two old Servers
  (47652 and 51024) still had different database revisions open with the same
  journal root and no runtime lock. This permits old orphan maintenance to
  remove another revision's bodies; the exact unlink was not observed.
- Fixed unconditional Server lock cleanup: acquisition tokens and idempotent
  release/exit prevent an old Server deleting a newer runtime/update lock.
- macOS development refresh now finds database holders independently of the
  lock, verifies node/cwd ownership, requests graceful termination and waits for
  actual process exit (including old exit hooks). Unknown owners or failed
  termination stop the operation before repair/update.
- Added explicit `--refresh --repair-directory-journal`: under the update lock,
  preserve SQLite and surviving event files, remove only missing directory
  delivery indexes, advance replay floor without resetting the head. Refuse
  missing Conversation bodies or directory streams with audit observations.
  Strict production journal backup/restore is unchanged. Recovery tests are
  in the root suite used by Docker, with process discovery mocked for Linux.
- Validation: 31 focused lock/recovery/companion tests passed; root TypeScript
  and Server/Web build passed. A copy of the actual damaged installation
  repaired successfully and passed strict upgrade-companion backup; evidence
  is under `.tmp/desktop-recovery-validation-ZVnhz2/`.
- Actual installation remains unrepaired in this session: sending SIGTERM to
  its verified old Server returned EPERM in the execution sandbox. No live
  socket was removed and no actual account database was changed by this
  follow-up. Electron startup and activation with this fix remain pending the
  documented recovery command from the user's terminal. No closing commit.

## 2026-10-06 single settings activation follow-up

- Removed the remaining create/edit dialog activation and automatic manual
  preview. Dialog “保存” only merges the edited agent into the page draft;
  enable/disable/removal use the same draft and only the page's “保存并激活”
  commits. Other pending settings are preserved and the base revision does not
  advance on dialog save.
- Draft management/preparation accepts the current page candidate, so newly
  added models can be selected and newly added agents can be edited or removed
  before activation. Preserve full controlled agent definitions (tool,
  permission, generated-runtime reference and manual fields) when constructing
  the eventual combined candidate. Preparation does not compile/probe or take
  the runtime gate. Runtime busy state only blocks the final activation.
- Fixed hot-change classification for a new agent referencing a model added
  in the same transaction. Unbounded tool/skill edits still require restart.
- Validation: 63 focused configuration, Web and lifecycle tests passed across
  the relevant runs; root TypeScript and Server/Web production builds passed.
  Regression coverage saves an unpriced model with a new agent, edits that
  unactivated agent, confirms active state is unchanged, rejects missing prices
  only at combined activation, and commits exactly once after supplying prices.
- The browser flow now asserts no activation before the page action and covers
  reopening new agents plus busy draft editing. Its live run was blocked by
  `listen EPERM 127.0.0.1` in this sandbox. The running installed Server has not
  been replaced; use `npm run dev:desktop -- --refresh` to install this source
  revision. GUI acceptance and a closing commit remain pending.

## Implementation gates

- [x] Independent branch and worktree; no remote Git operations.
- [x] Record approved architecture and ownership amendment.
- [x] P0 source/local proof: local auth, instance identity and process isolation.
- [x] P1 source/local proof: shell, service lifecycle, shared Web, native bridge and Renderer recovery.
- [x] P2 implementation: preferences/drafts, native files, notification feed and menu integration.
- [ ] P2 acceptance: real task notifications, multi-client approvals and native permission denial matrix.
- [ ] P3 release acceptance: verified bundled runtime, clean install and coordinated signed update/rollback.
- [x] P4 local arm64: real Electron smoke using installed Server-owned production Web assets.
- [ ] P4 release acceptance: signed macOS installation, Intel, clean-machine and long-duration matrix.

Checked source/local gates do not imply the complete release gates in the approved
design have passed. No completion date or closing commit is claimed.

## Implemented behavior

| Design area | Implementation and validation boundary |
| --- | --- |
| Process ownership | `apps/desktop` imports client/installation adapters only; dependency-boundary test traverses Main imports. Independent Node Server, isolated offline Planner and existing Executor path remain authoritative. |
| Local authentication | Owner-checked Unix discovery, Server/HTTP instance proof, 15-second single-use ticket and existing HttpOnly session. Renderer receives no ticket. Previous exchanged sessions and sockets are revoked; reconnect can reuse a valid session for the same instance. Browser login remains explicit. |
| Lifecycle | Single Desktop instance, close hides, quit preserves Server, separate confirmed global stop with bounded account activity summary. Renderer crash opens recovery, wake reconnects. Formal Server commands retain runtime lock/recovery ownership. |
| Shared UI | One Web build, optional typed platform adapter, directory hints, authorized artifact download/save/reveal, menu actions, Workspace title, responsive sidebar/header, 200% zoom. No second business UI. |
| Preferences | Installation/account-scoped atomic preference writes, bounded drafts, theme, route and viewport hints independent of HTTP port. Logout clears sensitive local UI state and private session. |
| Notifications | Bounded account feed of committed activity hints, stable deduplication, generic OS text, navigation to existing Web approval/task views. Feed tests pass; no paid-model notification acceptance claimed. |
| First installation | Local setup page retains failed input, independent installer helper accepts user Provider configuration through stdin and uses existing SecretStore/configuration authority. The installation flow separately provisions the system-owned `deepseek-flash` Internal LLM before Server startup from the protected existing installation source; users do not configure this service. Optional terminal launchers; installation/config directory selection; canonical data root retained. |
| Dependency delivery | Formal Runtime/Planner archive consumer; explicit Node/Git/Pi distribution inputs; signed descriptor, inventory, licenses, ABI probes, native signing and restricted PATH checks. Pi provisioning supplies engineering/research AgentClasses; Codex is optional. A real redistributable complete payload has not been assembled or accepted. |
| Coordinated update | Same-team signed app selection, pinned release keys and compatibility admission; independent installed Node helper, native updater/backup/journal recovery, shell replacement and durable activation record. Commit waits for both candidate Server identity and new Desktop authenticated Web render receipt bound to challenge/release/instance/PID. Recovery does not execute or revalidate the staged candidate. |
| Build/development | Locked Electron 44.5.1; separate npm trees; isolated Server + Vite + Electron orchestrator, explicit refresh, production-assets smoke. CI arm64/Intel jobs added but not run remotely. Production signing/notary gates reject missing release inputs. |

Cross-schema desktop updates remain refused by compatibility admission. Supporting
those combinations requires additional verified migration/rollback acceptance;
the current helper does not establish that support.

## Validation evidence

### macOS native application identity correction (2026-10-06)

Status: implemented and validated 2026-10-06. Closing commit: not created
(working-tree delivery).

- Prior checks of `app.getName()` and Electron menu objects were insufficient:
  the macOS menu bar and Dock still read `Electron` from the stock bundle.
- Development launch now prepares a cached `MetaWork.app` with native name and
  display name `MetaWork` and ID `com.metawork.desktop.development`. It preserves
  the existing icon and npm Electron dependency, and keeps the executable's
  development-mode identity so the isolated Server/session behavior is retained.
  Only the local copy receives an ad-hoc signature; production signing stays
  unchanged. Smoke and benchmark use the same shell preparation entry.
- The Electron smoke now queries AppKit's `NSRunningApplication.localizedName`,
  bundle ID and `.app` path. Verified all three against the actual running shell;
  authenticated production Web, menu actions, Renderer recovery and Server
  survival passed with no Renderer errors. Existing Server PID 9908 was retained.
- Six Desktop tests, changed-script syntax checks and whitespace checks passed.
  Evidence: `.tmp/desktop-development/evidence/electron-smoke.json` and
  `.tmp/desktop-native-identity-smoke.log`. The renamed shell was restarted for
  direct use after validation. AppKit confirmed the foreground process name as
  `MetaWork`; direct menu Accessibility inspection and screenshot capture were
  unavailable under macOS privacy permissions. Native identity evidence is in
  `.tmp/desktop-development/evidence/native-identity-check.json`.



### Settings-wide activation audit (2026-10-06)

Status: source changes and focused validation completed 2026-10-06; installed
Server refresh and live Desktop acceptance remain pending. Closing commit: not
created (working-tree delivery).

- Reviewed connection/Key, model catalog, agent, Span decision-model and task
  concurrency settings. Dialogs save drafts; enable/disable/removal and inline
  edits join that draft. The page-level “保存并激活” is the only activation call.
- Retired standalone Provider Key, Span Key and configuration rollback HTTP
  writes, plus their Server handlers/client methods. Both Key kinds are staged
  inside the combined activation transaction with existing compensation.
- Removed the obsolete Web manual compilation callback and preview state;
  unchanged persisted assertions remain intact, while edited duties reset them.
  AI rewriting and discovery still produce draft/read-only results.
- Made `runtimePolicy.maxConcurrentTasks` hot-activatable and fixed recovery/queue
  promotion to read the activated Kernel projection. Other attempt/backend
  limits retain their existing restart-required contract.
- Validation: 57 Web/configuration tests plus 5 focused HTTP-dispatch/account
  regression tests passed; root TypeScript lint, Server/Web production build
  and whitespace checks passed. A broader account run passed 27 tests but its
  existing explicit-Resume test hit sandbox `listen EPERM`; live socket/GUI
  acceptance was not completed in this environment. No installed Server refresh
  is claimed.

### Live validation completed after permission change (2026-10-06)

Status: this settings activation follow-up is implemented and verified in the
real Electron client on 2026-10-06. Closing commit: not created (working-tree
delivery). This does not close the unrelated distribution/release gates below.

- Development refresh exposed an always-false tool detector in its updater
  wiring. Replaced it with the production PATH detector; enabled installed Pi
  tools now pass the candidate probe. The development installation was upgraded
  to `0.1.4-desktop-development-1791275090552` and restarted successfully.
- All **7 browser end-to-end tests passed**, including agent lifecycle, Span Key
  submission through unified activation, Provider edits and busy-account draft
  editing. Corrected the old busy-state assertion: draft deletion stays enabled
  while final activation remains blocked.
- Real Electron + installed Server + production Web assets: created and edited
  a temporary agent, enabled/disabled it in the draft, and changed task capacity.
  The active revision remained unchanged before the page-level activation.
  Two page-level activations persisted the combined changes and then the
  confirmed removal/restored task limit. Server PID **9908** stayed unchanged;
  no standalone Key, rollback or manual-compile write occurred and no Renderer
  errors were observed. The original full configuration was restored afterward
  through the same activation transaction; the temporary agent was removed.
- Electron production-assets smoke passed: authenticated load **595 ms**,
  native file fixture actions, draft reload, responsive sizes/zoom, native menu,
  reconnect and Renderer recovery. The Server survived Electron exit. The actual
  application/menu identity was also verified as `MetaWork`.
- All **145** management/account/configuration/updater regression tests passed,
  including the previously sandbox-blocked explicit-Resume case. Root/Desktop
  TypeScript checks and whitespace validation passed.
- Evidence: `.tmp/desktop-development/evidence/settings-activation-live.json`,
  `settings-before-activation.png`, `settings-activated.png`, `electron-smoke.json`;
  logs `.tmp/settings-live-{refresh,browser,electron,electron-settings}.log`
  and `.tmp/settings-final-regression.log`. These results supersede the blocked
  retry below. The current release was launched again for manual use.

### Live validation retry (2026-10-06)

- Ran `npm run dev:desktop -- --refresh --prepare-only`: Server/Web and offline
  Planner builds passed, but refresh stopped before version switch because
  DesktopServiceManager could not discover the existing Server for shutdown.
  A direct local Gateway connection confirmed `connect EPERM` at
  `.tmp/desktop-development/data/gateway.sock`.
- Ran `npm run smoke:desktop`: Electron failed to launch before opening a window.
- Ran the targeted Settings browser lifecycle flow with `RUN_BROWSER_E2E=1`:
  the test HTTP listener was denied with `listen EPERM` on `127.0.0.1`.
- Logs: `.tmp/settings-live-refresh.log`, `.tmp/settings-live-electron.log`,
  `.tmp/settings-live-browser.log`. Installed release remains
  `0.1.4-desktop-development-1791269215134`. Live verification remains blocked
  by this session's sandbox permissions; no successful refresh or GUI acceptance
  is claimed.

### Settings activation follow-up (2026-10-06)

- Follow-up for the `harnesses.pi-cli.enabled` restart warning: the installed development release still lacked the prior Harness activation fix. Reproducing against the current account configuration confirmed plain enablement is hot in source, but a simultaneous responsibility edit incorrectly failed the bounded structural comparison. Responsibility is now excluded alongside the other existing hot-edit fields. Both enablement cases classify as hot; injected skill and tool-argument changes remain restart-required. 45 focused tests and the read-only current-configuration reproduction passed. Installing this code into the running development Server still requires a release refresh; no live activation is claimed.
- Fixed enabling an Executor whose existing Pi/Codex Harness was disabled: the candidate enables that referenced tool, and bounded hot-activation classification accepts only the enable flag change while continuing to require restart for tool command/argument changes. Enable/disable confirmations now edit the Settings draft, preserve other edits, and submit through the page-level `保存并激活`; draft serialization includes both AgentClass enablement and the referenced Harness. Disable/remove preserve shared tool definitions. Validation: 74 focused configuration/runtime/Web tests passed; browser workflow expectations updated, live desktop acceptance pending refresh of the installed Server.
- Fixed the Agent configuration blank page: the route policy renderer now receives the selected system model explicitly instead of reading an out-of-scope variable. Rendering regressions cover Planner fixed routing and Executor fixed/auto routing with system, user, and missing models (26 focused Web tests passed). Web builds now run TypeScript checking before Vite bundling, which rejects this undefined-variable failure before delivery.
- Fixed legacy/provider model identities being written into `AgentClass.modelPolicy.modelRef`; the Settings workbench now resolves `provider/modelId` identities to the configuration-owned safe reference and leaves unknown identities visibly invalid for reselection.
- Executor removal is a direct confirmed edit to the Settings draft; it has no per-agent activation step and is committed only through the page-level `保存并激活` action.
- Activation price checks now compare the candidate with the active baseline. A removal or unrelated edit is not blocked by a pre-existing missing price, while newly enabled or newly changed model bindings still require both price fields.
- System-managed Provider/Model entries are marked in the configuration schema and omitted from the user model service catalog; Settings activation preserves them without exposing edit or delete controls.
- Added a schema regression covering `systemManaged` metadata on both Provider and Model entries; an already-running pre-change Server must be restarted after the configuration format changes.
- Electron now sets the native application identity to `MetaWork`; the macOS application, File, Edit, View, and Window menus use one locale-selected label set from `app.getLocale()`, so Chinese and English menu labels do not mix.
- Focused regression coverage: 5 enabled-price tests and 23 Settings workbench tests passed after the follow-up.
- A subsequent full-suite rerun in the restricted agent sandbox could not bind TCP/Unix sockets (`listen EPERM`), so its network-dependent failures are environment failures; the focused configuration/runtime tests remained green.

All commands below were local, without merge, push or modification of the normal
installation. The test runtime uses `.tmp/desktop-development` and the
system-managed `deepseek-flash` development connection. Local evidence/build
output is Git-ignored.

| Check | Observed result |
| --- | --- |
| Root and Desktop TypeScript, Web TypeScript, script syntax, whitespace | Passed (`npm run lint`, `npm run lint:desktop`, Web `tsc`, `node --check`, `git diff --check`). |
| Server/Web and Desktop production builds | Passed (`npm run build`, `npm run build:desktop`); isolated Planner `build:offline` also passed. |
| Web/Gateway/client/management/installation/activity regression run | **967/967 passed**, 297 reported suites; `.tmp/desktop-domain-results.json`. This run preceded the additional shell-health/restart tests below. |
| Desktop preference/bridge/dependency boundary suite | **5/5 passed** (`npm run test:desktop`). |
| Final focused release/activation/shell-health suite | **13/13 passed**. Includes missing update helpers/non-executable runtime admission, wrong/stale health receipts, candidate process exit and persisted activation-phase recovery. |
| Actual Electron production-assets smoke | Passed after latest Main changes: HttpOnly-authenticated Web, no Renderer Node, native directory/save/reveal with controlled dialog/HTTP fixtures, draft reload, 1440/1100/900 widths, 200% zoom, menus, ten reconnects, forced Renderer crash/recovery and Server survival after Electron exit. |
| Startup sample | Latest warm ready **559ms**, earlier cold sample approximately **4331ms**. These individual measurements do not prove p95 or RSS/CPU budgets. |
| Repeated startup baseline | **20 warm + 20 stopped-Server cold samples**: ready p95 **561ms / 1740ms**, visible-window p95 **391ms / 405ms**. Development Electron with installed production Web and no model work; excludes signed payload verification, OS reboot and filesystem cache clearing. This is a local baseline, not release certification. |
| Evidence | `.tmp/desktop-development/evidence/electron-smoke.json`, `desktop-1440.png`, `desktop-1100.png`, `desktop-900.png`, `desktop-200-percent.png`; inspected during local work. |
| Performance evidence | `.tmp/desktop-development/evidence/startup-benchmark.json` contains per-sample startup timings and Desktop/Server RSS/CPU snapshots. Planner/Executor task-load budgets remain unmeasured. |
| Memory baseline | Median summed Desktop working set **450 MiB warm / 458 MiB cold**; Server RSS **256 MiB / 275 MiB**. Desktop summed working sets can double-count shared pages; these are startup snapshots, not sustained-task budgets. |

The file-operation smoke uses controlled dialog and artifact HTTP fixtures; it
does not represent a real model-produced artifact. Signed-app/helper integration
was not run. Unit recovery tests do not certify OS-level interruption recovery.

## Remaining release gates and concrete blockers

1. **Signed distribution:** `security find-identity -v -p codesigning` reports
   **0 valid identities**. Developer ID, release signing keys and notarytool
   credentials must be supplied through the release environment. No signed
   `.app` or DMG has been produced; no Gatekeeper/notarization claim is made.
2. **Complete dependency payload:** provide and verify relocatable Node/Git/Pi
   distributions with full runtime libraries/resources and redistribution
   notices. Exercise Planner/Executor/SQLite/Workers/MCP without source checkout,
   global CLIs, npm installation or Xcode CLT. The preparer accepts these inputs;
   it does not manufacture or certify them merely from a development machine.
3. **Clean-machine task:** configure an authorized provider in an isolated test
   installation; run setup → workspace → task → approval/execution → artifact
   save, including credential failure and Executor readiness UX. The local
   DeepSeek development connection does not close this clean-machine acceptance.
4. **Signed joint upgrade matrix:** run real app/runtime upgrades and inject
   process interruption around staging, drain, migration, pointer/shell switch,
   authenticated render and commit. Verify disk-full, permission/read-only DMG,
   missing journal companion and failed candidate startup with real files.
5. **Architecture and OS:** this host is arm64; separate native Intel acceptance
   is outstanding. Test Finder PATH, application movement, Unicode/space paths,
   notification denial, sleep/wake and installed native ABI/signatures.
6. **Multi-client and duration:** real Web/TUI/Desktop/Feishu task/approval
   coherence, long conversation bounds, repeated-switch listener/cache budgets,
   release-mode cold/warm p95, and per-process RSS/CPU under real task load remain
   open; the development startup baseline above does not close those gates.
   Docker is unavailable on this host; macOS GUI/packaging cannot be replaced by
   Docker even when backend Docker tests become available.

## Local operation and handoff

See [`apps/desktop/README.md`](../../apps/desktop/README.md) for reproducible dev,
payload, packaging, update/recovery and removal instructions. The smoke leaves
its isolated Server running deliberately to verify client-exit survival. After
the final benchmark, this session stopped that test Server through the formal
installed Server command; a subsequent development run can start it again.
The normal installation and original worktree remain separate. No remote CI,
publishing, merge, push or closing commit was performed.
