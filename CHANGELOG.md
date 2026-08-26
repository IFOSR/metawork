# Changelog

All notable public changes to MetaWork are documented in this file. Historical
AnyFusion release entries remain unchanged for auditability.

The project follows [Semantic Versioning](https://semver.org/) for public preview releases.

## [Unreleased]

### Added

- Configuration Control Plane with a revisioned `ConfigurationService`,
  immutable `ConfigurationSnapshot`, and one-configuration-revision-per-generation
  binding for Planner, Kernel, and Runtime.
- Local management API over a mode-0600 Unix socket (`/api/v1/server/health`)
  plus `metawork config|provider|model|planner|executor|doctor|status` admin
  surface and structured view events.
- Transactional native install/update/rollback core with durable upgrade
  journal, signed release verification, database backup, and preflight doctor.
- `ServerApplication` unified lifecycle and `ServerUpdateCoordinator` update
  lease/quiesce/awaitIdle transaction.
- Frozen future A2A Executor transport boundary (ADR-0029 + roadmap).
- Native Codex Planner thread binding with same-thread resume and a two-turn
  memory smoke gate.
- Event-driven recovery probes for enabled AgentClasses already in `error`,
  including bounded Planner-visible diagnostics and `/executor refresh`.
- Planner and Executor activity state projected to the current Ink TUI.
- Account-scoped `RuntimeRegistry -> AccountRuntime -> ConversationRegistry`
  production composition with one versioned ClientGateway for Unix, Web,
  Feishu, native TUI and scripted input.
- Durable Gateway command admission, ordered replay/reconnect, bounded
  sanitized event journals, and a provider-independent `smoke:gateway` gate.
- Transactional account migration with SQLite WAL-safe backup, verified staging
  manifests, crash recovery, and legacy-state archival.
- Canonical MetaWork product identity, CLI, environment variables, installation
  root, Web presentation, and compatibility-safe AnyFusion root migration.

### Changed

- Dispatched Executors through Harness Drivers and removed the legacy
  backend-executor-adapter, builtin-executor-catalog, executor-admin-service,
  agent-class-seeder, planner-process-runner, and planner-tui-process modules.
- Removed Guidance next-task selection and implicit preemption scoring; Guidance
  now renders recovery hints from existing facts only.
- Formatted task completion once in the Delivery service before transport
  selection instead of per-notifier.
- Added native macOS setup for the isolated nested AnyFusion-Pi Planner,
  current-directory read-only inspection, and MetaWork-only Executor homes
  without installing or modifying existing Codex/Pi CLIs.
- Advanced the current pre-release baseline to Kernel wire/ledger v5 and
  fresh-install SQLite schema v29 with durable Planner proposal turn/submission identity and accepted-turn locking.
- Completed deterministic asynchronous dispatch of up to four isolated attempts
  inside the one active top-level Task, with Git-backed publication and durable
  cancellation/replan recovery.
- Availability-exhausted replans now persist a deferred proposal and recover
  through Kernel admission instead of leaving an errored Executor permanently
  unavailable.
- Native install/update/rollback now activates database, configuration,
  SecretStore and generated-runtime revisions under
  `accounts/local-default`; legacy installation-global state is migration
  evidence only.
- Account-owned periodic recovery no longer depends on open Conversations;
  shutdown drains client attachments, accepted commands, cancellation retries,
  Planner/Executor work, and an in-flight account timer before closing storage.
- Expired Gateway cursors now reset to a bounded current/terminal snapshot,
  oversized answers remain successful through bounded projection, and native
  Pi reconnect/frame handling fails safely and remains retryable.

## [1.2.0-preview.0] - 2026-07-17

### Added

- Public AnyFusion product positioning backed by AnyInt and MetaFusion.
- Developer Preview and limited Internal Pilot status indicators.
- GitHub Actions CI covering TypeScript checks, the Vitest suite, and production builds.
- Public `anyfusion` CLI command with a retained legacy compatibility alias.
- Formal preview release notes and reusable social-preview artwork.

### Changed

- Restructured the English and Chinese README first screens around product positioning, project status, Quick Start, Architecture, and Roadmap.
- Aligned public package metadata with the AnyFusion `1.2.0-preview.0` preview release.
- Updated public-facing documentation to use the AnyFusion brand while preserving internal implementation identifiers.

### Deployment status

- Deployed for limited internal pilot use.
- Current execution scope supports one active top-level task with dependency-aware subtask execution.

### Known limitations

- Only one top-level task can be active at a time.
- Public CI excludes credential-dependent live-model smoke tests.
- CLI, configuration, and runtime contracts may change during the preview period.
- Some command and TUI workflows remain under active development.

[Unreleased]: https://github.com/IFOSR/metawork/compare/v1.2.0-preview.0...HEAD
[1.2.0-preview.0]: https://github.com/IFOSR/metawork/releases/tag/v1.2.0-preview.0
