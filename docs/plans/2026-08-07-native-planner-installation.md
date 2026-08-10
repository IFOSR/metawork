# Native Planner Installation

Status: Completed
Plan date: 2026-08-07
Completion date: 2026-08-07

## Objective

Make the separate AnyFusion-Pi Planner installable and runnable as a native
macOS process without Docker, without requiring `/workspace`, and without
installing or modifying the user's existing Codex and Pi CLIs.

## Delivered Behavior

- Planner TUI and RPC inherit the directory where the user starts AnyFusion.
- Planner remains read-only and exposes only `read`, `grep`, `find`, and `ls`
  for repository inspection.
- `./setup.sh` delegates to an idempotent native macOS installer.
- The installer clones or updates AnyFusion-Pi under
  `<metawork>/planner/AnyFusion-Pi`, builds both isolated source trees, creates
  AnyFusion-only homes and credentials, and installs only the AnyFusion
  launcher.
- Existing Codex and Pi commands are required but never installed, upgraded,
  downgraded, linked, or reconfigured.
- A dirty nested AnyFusion-Pi checkout is preserved and built without remote
  update.

## Validation

- AnyFusion-Pi `npm run build:offline` and `npm run check` passed.
- Seven focused Planner bootstrap and MCP launch tests passed.
- AnyFusion `npm run lint`, `npm run build`, and `bash -n setup.sh` passed.
- Three native installer isolation and provider tests passed.
- `./setup.sh` completed with the configured OpenAI-compatible provider and
  installed `~/.local/bin/anyfusion`.
- Codex/Pi paths, versions, executable hashes, and personal configuration
  hashes were unchanged after installation.
- All generated AnyFusion provider/model files are mode `0600`; the launcher
  is mode `0700`.
- Native PTY startup from `/tmp/anyfusion-native-smoke` displayed that current
  directory, connected to MetaClaw, reached `planner idle`, and exited cleanly
  through `/exit` without a model request.

Closing commit: Pending.
