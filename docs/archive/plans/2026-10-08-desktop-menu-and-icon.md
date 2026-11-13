# Desktop menu and M icon

- Plan date: 2026-10-08
- Status: Completed locally; awaiting user installation acceptance
- Completion date: 2026-10-08
- Scope: Simplify the macOS menu, make connection actions reflect availability,
  provide honest update discovery and replace the stock Electron icon.

## Behavior

The application menu exposes About, Settings, Check for Updates and Reconnect.
Advanced contains manual installation, installation directory selection, terminal
command setup, Server stop and clearing local login/drafts (with confirmation).
Repair is visible only when the startup journal requires recovery. Reconnect is
disabled while connected/connecting; the authenticated notification feed reports
unavailability and restores the disabled state after recovery.

Check for Updates queries the official latest release, compares numeric versions
and offers the matching architecture's official DMG download only for a newer
version. The user confirms the download and installs it by replacing the app.
This is not unattended installation; native activation and signature validation
remain the installation authority. Older online releases do not downgrade an
ahead-of-latest local Internal build.

The icon retains the pale rounded square, dark circular center and cyan stroke,
with a vector M replacing the Electron atom. SVG, transparent PNG and macOS ICNS
are versioned together. Both packaged and development shells select the icon.

## Validation

Desktop type checks and all 16 Desktop tests passed. Release-check tests cover equal/older releases,
architecture matching, unexpected URLs and network failure. The real Electron
menu smoke verifies disabled Reconnect while connected/connecting, transport
loss and recovery, hidden repair when healthy, Advanced grouping and the
ahead-of-latest update message. No GitHub publication or normal-installation
replacement is part of this change.

The final local arm64 Internal DMG passed clean installation, authenticated Web,
menu behavior and Server survival after Desktop exit. Its mounted app.asar and
M icon exactly match the tested packaged application. The PNG was visually
inspected. The GitHub latest endpoint was read successfully (v0.1.7); nothing
was published. This shell build uses the already verified
`0.1.8-internal-1e26ed0` Runtime payload without changing its installation identity.

Closing commit: `feat(desktop): simplify menus and add M application icon`.
