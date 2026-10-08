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
Until the Windows native transport is implemented and validated, a Node `net`
named pipe must neither advertise the Desktop-session capability nor issue a
Desktop ticket. The client's Unix-only check is not a Server authorization gate.

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

### Windows native boundary amendment (2026-10-08)

The Windows implementation uses a narrow Node-API adapter owned by the platform
boundary. A P0 binary has loaded unchanged in Windows Node 22.23.3 and Electron
44.5.1 Main (embedded Node 24.21.0), and kernel-observed pipe PID matches the
respective host. The standalone helper spike also passed pipe checks, but it
would introduce a second transport process identity and private forwarding
protocol. Node-API keeps the pipe owned directly by the independent Server and
the Desktop client; it does not move Server into Electron.

Only the platform/client/installation adapters may consume these OS primitives.
Renderer receives no native module or ticket. Node public APIs and Node-API are
the integration surface; no private Node/libuv handles are permitted. Windows
pipe creation must use a restricted current-user DACL, first-instance protection
and remote-client rejection. Client connection verifies kernel Server PID and
SID before writing; Server admission verifies the connecting principal. Private
files are checked through pinned handles, including owner, ACL and reparse
boundaries, before their contents become identity inputs.

This selects the carrier, not a completed transport: asynchronous connection
lifecycle, cancellation, bounded buffering, private file writes/replacement,
remote rejection and packaged dependency closure remain validation gates. The
spike is not shipped, and ordinary Node named pipes always keep tickets closed.
After the native transport/private-file and cross-account/SMB checks passed,
source composition selects the installed native adapter; packaging and full
product acceptance remain separate gates. Existing Unix behavior,
single-use ticket/HTTP proof and Installer/Updater activation authority remain
the same. See the Windows implementation log for commit-bound evidence.

The approved plan is larger than an Electron wrapper: independent service
survival, local authentication, clean-machine dependencies and upgrade recovery
are release gates. Source implementation, local smoke, signing/notarization and
real-provider acceptance are recorded separately in the implementation log.
No changes to Kernel policy, Task scheduling, public protocol v2 semantics or
business database schema are authorized by this ADR.

Windows x64 inventory distinguishes native x64 images from bounded, validated
pure-IL AnyCPU assemblies supplied by Git Credential Manager. The only allowed
native x86 image is PortableGit's fixed `usr/libexec/getprocaddr32.exe` helper,
which MSYS uses for WOW64 compatibility; it remains an independent tool
subprocess. Electron, Node, Git's primary entrypoint, SQLite and MetaWork's
platform module must still be native x64. This does not add 32-bit Windows
support or move process-control authority into a bundled Git helper.
