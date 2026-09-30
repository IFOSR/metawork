# Cross-Platform Release Preparation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish the current MetaWork preview as one synchronized release line with reproducible macOS Intel, macOS Apple Silicon, Windows, and Linux-host build artifacts.

**Architecture:** Keep the signed Runtime/Planner manifest contract, extend the packaging matrix to `darwin`, `linux`, and `win32`, and use platform-specific archive/installer/launcher behavior. Windows uses Node named-pipe endpoints and `.cmd` launchers; Linux is built on Linux hosts or CI rather than cross-faked on macOS.

**Tech Stack:** Node.js 22.19+, TypeScript/ESM, Vitest, npm, PowerShell, GitHub Actions, Ed25519 release manifests.

---

### Task 1: Lock the release version and synchronization contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `docs/README.md`
- Create: `docs/releases/v1.2.0-preview.6.md`
- Test: release/version focused tests

**Steps:**
1. Add a failing test asserting the root package, lockfile, release notes, and generated artifact release IDs use the same preview version.
2. Run the focused test and verify it fails because the repository is still on `1.2.0-preview.5`.
3. Bump the current preview to `1.2.0-preview.6`, record the delivered changes and platform matrix, and add release notes.
4. Run the focused test and verify it passes.

### Task 2: Make release packaging platform-aware

**Files:**
- Modify: `scripts/package-release.mjs`
- Modify: `src/installation/release-manifest.ts`
- Create/modify: release packaging tests

**Steps:**
1. Add failing tests for native platform detection, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, and `win32-x64` artifact naming and archive format.
2. Run the focused tests and verify the new matrix cases fail.
3. Implement platform validation, Windows ZIP packaging, and explicit host/target checks without weakening signing requirements.
4. Run the focused tests and verify they pass.

### Task 3: Add native Windows runtime plumbing

**Files:**
- Modify: `src/gateway/gateway-paths.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/management-api-server.ts`
- Modify: `src/tui-bridge/planner-host-bridge.ts`
- Modify: `src/client/client-endpoint-resolver.ts`
- Modify: `src/installation/paths.ts`
- Modify: `src/installation/native-launcher.ts`
- Modify: `src/installation/source-native-installer.ts`
- Modify: `src/installation/source-native-updater.ts` and pointer helpers as needed
- Test: gateway, planner-host, launcher, path, and installer tests

**Steps:**
1. Add failing tests for Windows named-pipe paths, `.cmd` launchers, and platform-safe socket cleanup.
2. Run the focused tests and verify they fail on Unix-only assumptions.
3. Implement the smallest platform abstraction that preserves existing Unix behavior and adds Windows named pipes and launchers.
4. Run focused tests on macOS and verify existing Unix behavior remains green.

### Task 4: Add Windows installer and Linux-host build entry points

**Files:**
- Create: `scripts/install.ps1`
- Create: `scripts/build-release.mjs`
- Modify: `package.json`
- Create/modify: `.github/workflows/release-build.yml`
- Modify: `scripts/install.sh` and `scripts/bootstrap-install.sh` only where trust/version contracts require it
- Test: installer/build-script contract tests

**Steps:**
1. Add failing tests for Windows manifest selection, signature/hash verification, ZIP extraction, and Linux host target commands.
2. Run the focused tests and verify they fail because no Windows installer/build matrix exists.
3. Implement the PowerShell installer and host-native build entry point; do not generate Linux artifacts on macOS.
4. Add GitHub Actions jobs for macOS x64, macOS arm64, Windows x64, Linux x64, and Linux arm64, with signing performed only when the release secret is present.
5. Run focused tests and validate workflow YAML and scripts.

### Task 5: Update documentation and validate artifacts

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/current/technical-overview.md`
- Modify: `docs/current/technical-overview.zh-CN.md`
- Modify: `AGENTS.md` only if release onboarding changes

**Steps:**
1. Document the release matrix, Windows native installer, and Linux-host build requirement.
2. Build Runtime/Web/Planner locally, generate unsigned staging artifacts for macOS x64 and arm64 where possible, and verify archive contents.
3. Run lint, focused Release tests, build, and the full test suite where local dependencies allow.
4. Commit with a Conventional Commit subject and push `main` to GitHub.
