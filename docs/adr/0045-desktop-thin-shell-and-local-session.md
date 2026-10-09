# ADR-0045: Desktop thin shell and local session

- Status: Accepted (implementation in progress on isolated desktop branch)
- Date: 2026-10-05
- Plan: [MetaWork Desktop](../plans/2026-10-05-metawork-desktop-design-review.md)

## Decision

`apps/desktop` is an Electron client and local installation adapter in the same
private repository. `web` remains the only business UI; the independent Node
Server owns AccountRuntime, storage, recovery, Planner and execution. Desktop
must not import those implementations. npm lockfiles and the separate Planner
dependency tree remain authoritative; no workspace migration is required.

The installation adapter may initialize a verified distribution and invoke the
formal Server start/status/stop commands. This is a narrow amendment to ADR-0034;
client disconnection never stops Server. Closing a window hides it. Quitting
Electron leaves Server alive with independent logs, executable and immutable
installed release. A separate explicit stop action explains all-client impact
and uses the Server's drain policy. A conflicting instance blocks startup.

A Unix-socket-only `register_desktop_session` request authenticates the existing
local OS-user principal to the Server's current account; clients cannot choose
an account. A bounded ticket service issues 15-second, single-use tickets bound
to installation, process instance and caller nonce. A proof obtained over the
owner-checked local socket is checked against HTTP before sending the ticket.
The HTTP exchange establishes the existing HttpOnly/SameSite session in a
private Electron session. Renderer receives no ticket or raw credential.
ADR-0039 browser credentials and non-authenticating launch hints are unchanged.
This does not isolate malicious programs already running as the same OS user.

Native IPC requires the owned main frame, exact validated origin and bounded
arguments. No generic filesystem/shell/IPC bridge is permitted. External
navigation and child windows cannot acquire the bridge. Directory selection is
only a hint to the existing authorized workspace command. Downloads are based
on authorized artifact IDs and reveal is restricted to completed downloads.
Preferences and bounded drafts use installation/account scope independent of
HTTP port; neither is a business fact or a second credential store.

Installer/Upgrader remains the only runtime activation authority (ADR-0030).
Shell, Server/Web, Planner, Node ABI and native dependencies form a verified
release combination. Updates preserve database/journal companion backups and
recovery gates. Unsigned development artifacts cannot pass the production
release gate. macOS arm64 is first; Intel needs separate validation.
The update helper commits only after the new Server identity and a matching
new Desktop authenticated-render receipt are confirmed. Interrupted recovery
uses the durable activation record and native rollback checks, without requiring
the staged candidate to remain executable.

## Consequences and validation

The approved plan is larger than an Electron wrapper: independent service
survival, local authentication, clean-machine dependencies and upgrade recovery
are release gates. Source implementation, local smoke, signing/notarization and
real-provider acceptance are recorded separately in the implementation log.
No changes to Kernel policy, Task scheduling, public protocol v2 semantics or
business database schema are authorized by this ADR.

## Existing native installation amendment (2026-10-08)

First Desktop launch admits existing Web/TUI installations through the same
Installer/Upgrader authority. Matching release identities reuse the current
Server and account. Native distributions need not contain Desktop tools: the
verified installation helper may provision a release-scoped `desktop-support`
directory outside the immutable active release. It supplies durable Node/tools
and update recovery code, not another active Runtime or account.

Different release identities expose an explicit upgrade action using the app
already downloaded. SourceNativeUpdater validates actual database schema and
configuration compatibility, including the historical preview-to-current product
version transition from `1.2.0-preview.*` into the `0.1.*` product line. This
explicit historical renumbering is the only version-order exception; ordinary
stable-to-older-Desktop downgrades remain rejected. Existing backup, migration, activation and rollback gates remain
mandatory. Newer unsupported database schemas continue to fail closed.

Installer lifecycle operations use the installed Server's formal start/stop CLI,
so a pre-Desktop Server need not implement Desktop authentication to be upgraded
or restarted after rollback. Ordinary client attachment and user-facing stop
retain their Desktop session checks. Joint commit still requires the candidate
Server identity and authenticated-render receipt. Native adoption retains a
verified helper independently of the staged app; repair can run without that
candidate. Relaunch preserves the installation, config home and Desktop profile.

## Model-free first launch and internal identities (2026-10-08)

Desktop installation initializes the ordinary account configuration with empty
Provider/Model catalogs and disabled editable AgentClass presets. No placeholder
provider, model or credential may be generated. Server exposes the same Gateway,
workspace browsing and Settings while the Planner binding is explicitly absent;
new semantic work is rejected by the existing Gateway admission gate. Web
projects configuration readiness and offers a Settings action. The existing
strict-idle activation transaction binds the Planner after real models/agents
are configured; compensation can restore the unconfigured state. No separate
Desktop backend or alternate storage/recovery owner is introduced.

Internal release IDs ending in `-internal-<commit hash>` identify immutable builds.
Their hashes carry no chronological order: same-product internal builds may be
explicitly replaced through the normal verified update transaction. Product
version downgrade and stable/prerelease ordering, actual schema compatibility,
backup and authenticated health checks remain enforced. This corrects identity
comparison, rather than adding a compatibility bypass.

## Finder process lifecycle correction (2026-10-08)

On macOS, detached spawn/unref does not remove a child from a Finder application's
process coalition. Desktop-started Server and updater therefore launch through
ephemeral one-shot user-session launchd jobs. These jobs have no KeepAlive or
login registration; they transport the existing formal lifecycle commands and
do not introduce a service/recovery owner. Temporary private environment-bearing
job definitions are removed after bootstrap. A token-bound updater readiness
receipt precedes Desktop exit. A live job must never be booted out by a new launch.
Customer acceptance must use LaunchServices, repeat upgrades with historical
journals, and verify Server survival after Desktop exits. Direct Electron spawn
alone is insufficient. Startup uses one explicit completion action, explains
task/client interruption, and distinguishes interrupted updates from first use.

Internal macOS packaging also requires a valid local ad-hoc app seal whose code
identifier matches `com.metawork.desktop`. An Apple certificate is not required.
Keeping the renamed Electron stub's invalid linker signature lets BTM reject and
unload even launchd jobs on app exit. Launchd does not bypass macOS background
policy. Final smoke must use the unchanged packaged app, never a re-signed copy.

## Managed Pi and optional host tools (2026-10-09)

Desktop ships the Pi Executor separately from the internal AnyFusion-Pi Planner.
Managed Pi is selected by the installed release's absolute entrypoint and paired
Node, never by the user's global Pi. Codex remains an optional external tool;
its absence must not block application installation or update. Settings, probes
and worktree execution consume the same resolved executable binding. Personal
tool homes are not substituted for isolated attempt homes.

A damaged managed tool tree can be restored only from a verified payload with
the exact active release identity, after formal Server stop and under the
existing runtime/update lock. A staged, verified support tree is selected by an
atomic release-scoped pointer; the immutable active application is not edited.
Automatic repair is attempted once per release, then requires an explicit retry.
The ordinary Web settings remain reachable when execution tools are unavailable.
