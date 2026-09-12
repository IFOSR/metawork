# Changelog

All notable public changes to MetaWork are documented in this file. Historical
AnyFusion release entries remain unchanged for auditability.

The project follows [Semantic Versioning](https://semver.org/) for public preview releases.

## [1.2.0-preview.1] - 2026-09-11

### Fixed

- Linux/WSL2 fresh installs no longer abort with "non-macOS native installation
  requires explicit METAWORK_SECRET_STORE=file" before the provider wizard;
  the release installer now defaults to the file-backed secret store on
  non-macOS hosts (matching `setup.sh`).
- The one-command `curl | bash` install no longer hangs silently after
  "Installing MetaWork to ...": the provider setup wizard now receives the
  terminal directly instead of redirecting the installing shell's stdin,
  which previously made bash wait for the next script line on the keyboard.
- Large artifact downloads (Runtime ~14MB, Planner ~122MB) now show progress
  bars and retry transient failures.
- `metawork server start` no longer fails with `EACCES` when refreshing the
  active configuration revision: write access is restored before rebuilding
  the deliberately immutable per-revision generated trees.

### Security

- Release signing key rotated to `metawork-release-2026-02`;
  `metawork-release-2026-01` is revoked. Manifests published before this
  release are no longer accepted by the installer.

## [Unreleased]

### Added

- Settings 工作台「获取模型列表」：可在 Provider 卡片中用表单里填写的 BaseURL/API Key
  现场探测该 Provider 的 OpenAI 兼容 `/models`,自动列出模型并为内置目录收录的模型
  标注能力标签（新端点 `POST /api/config/discover-models`）。
- `GET /api/config/completion` 现在同时下发公开的模型能力目录
  (`modelCapabilityCatalog`),使界面在「加入候选」时即可补全能力。
- Settings 工作台新增条件浮现的**能力标签勾选编辑器**（仅对目录未收录、能力待确认的
  模型展示，支持一键「使用目录推荐」）。
- Settings 工作台新增**保存前预检**：按 AgentClass 的硬性能力要求检查已绑定模型，
  直接指出「哪个 AgentClass 绑定的哪个模型缺少什么能力」，避免激活时才报错。
- Planner 现在可独立更新：Settings 工作台第一步之后（Provider 目录之后、Executor
  之前）新增 Planner 板块与「更新 Planner」按钮，只提交 Planner 绑定及其依赖的
  Model/Provider，不影响其它设置。

### Changed

- Settings 工作台板块顺序调整为：运行时容量 → Provider 模型目录 → Planner →
  Executor 路由；「保存并激活」不再修改 Planner（Planner 由「更新 Planner」单独提交），
  并有明确文案提示。

### Fixed

- 激活与运行时（Kernel/Executor）的候选模型投影会按内置能力目录兜底合并能力标签，
  避免目录已收录的模型因配置里能力为空而被 Planner 绑定等硬性要求拒绝。
- `no eligible model candidate` 现在携带每个候选被拒绝的具体原因
  （例如 `k3: missing_capability:structured-output`），不再是无从定位的报错。
- 常规「保存并激活」不再把 `agentClasses.planner` 整体丢弃（旧实现会因此被判定为
  进程级变更，误报「此更改需要重启服务后生效」），而是用运行中的 Planner 原样覆盖。
- 更新 Planner 成功后只同步 Planner 基线，保留其它板块尚未保存的编辑。

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

- Replaced the Executor-wide `attemptTimeoutMs` interpretation with the
  idle-only `runtimePolicy.executorIdleTimeoutMs` watchdog. Existing persisted
  configurations using the retired field are normalized during read, while
  conflicting old/new values fail closed.
- Kept complete bounded Turn history in the Web Conversation view while
  scoping the default Trajectory and execution cards to the newest Turn's
  Task. Late catalog refreshes and stale Conversation reads can no longer
  erase or overwrite the selected Conversation.
- Serialized only Web navigation mutations so Workspace or Conversation
  switching cannot retarget an in-flight message and does not reduce
  cross-Conversation Task concurrency.
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
