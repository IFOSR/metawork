# Desktop dependency release gate

The package consumes a signed `scripts/package-release.mjs` Runtime/Planner pair.
It never runs npm on the user's machine. `prepare-runtime.mjs` additionally takes
separate, relocatable Node, Git and Executor distributions; host `/usr/bin/git`,
Homebrew symlinks and an npm package requiring a postinstall download are not
acceptable substitutes.

| Component | Required evidence |
| --- | --- |
| Electron 44.5.1 | Exact lock; Electron/Chromium licenses; supported macOS; Developer ID signature |
| Node 22 / ABI 127 | Exact patch in signed descriptor; native architecture; distribution license |
| Server/Web | Same commit and formal archive; worker, schema, MCP and Web entry points |
| Planner | Same commit; isolated offline build/dependencies; third-party notices |
| better-sqlite3 | Bundled Node ABI probe; architecture; signed Mach-O and license |
| Git | Relocatable bin/libexec/templates/libraries; GPL notices/source offer; no CLT dependency |
| Pi Executor | Approved redistributable CLI with its own dependency closure; license notices; no global install dependency |

Each tool tree must include its license/notice files. The production preparer
signs all Mach-O files (including dylibs and `.node`) before inventory generation,
verifies those signatures and rejects absolute non-system library references.
It probes tools with a restricted bundled PATH. Also test with PATH
restricted to the bundled tools plus `/usr/bin:/bin`, with Xcode CLT absent, and
with the original build/source directories unavailable. The preparer probes
Node ABI, SQLite, Git and Pi; it does not certify redistribution rights or the
absence of dependencies in every tool path. Those remain release review gates.

Production packaging requires a clean matching commit, trusted Ed25519 release
keys, Developer ID identity and a configured notarytool keychain profile.
Development manifests are explicitly marked and rejected by packaged Main.
No private keys or provider credentials belong in resources or this repository.
