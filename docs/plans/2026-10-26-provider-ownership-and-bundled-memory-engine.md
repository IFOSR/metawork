# Provider ownership and a bundled memory engine

- 计划日期：2026-10-26
- 状态：已实施
- 关联：[ADR-0049](../adr/0049-long-term-memory-ownership-deposition-and-delivery.md)、
  [TDAI 接入设计](2026-10-22-memory-system-tdai-integration-design.md)、
  [Server 级 Memory 合并前修复](2026-10-26-server-scoped-memory-pre-merge-remediation.md)

## 1. 问题

两个独立缺陷让「长期记忆」在真实安装里无法成立：

1. **幽灵 Provider。** 设置页的 Provider 卡片来自
   `ConfigurationCompletionService` 的并集，而该并集包含公开预设（preset）、
   公开目录和本机 Agent 发现。用户删掉的 Provider 会在下次打开设置时以
   「无模型」的空壳重新出现；启动时还会为固定三个 ref（`code-cli`、`kimi`、
   `deepseek`）回填凭据，进一步制造同一端点两条记录的现象。
2. **记忆引擎不在发布包里。** `resolveMemorySidecarCommand` 只找
   `<releaseRoot>/memory/tdai`，而 `scripts/package-release.mjs` 的白名单和
   release manifest 都只有 `metawork` 与 `planner`。结果是用户打开开关后
   只会看到降级状态，而设置页把任何降级都显示成「BM25/FTS5 不可用」。

## 2. Provider 归属不变量

- 所有 Provider 都是用户拥有、用户添加、用户可编辑、用户可删除。
- 安装时填写的 Provider 与设置页新增的 Provider 是同一套逻辑：同一个
  `ProviderDefinition`、同一条 activation、同一个 SecretStore 引用规则。
- 设置页只展示 `/api/config` 中已激活的 Provider 卡片。
- completion、本机 Agent 发现、公开目录**不得**生成 Provider 卡片；它们只能
  描述一张已存在的卡片（显示名、模型候选、凭据状态）。
- 「新增模型」表单提交后才进入草稿；草稿只在「保存并激活」成功时成为事实。
- Provider 删除后，只有激活成功才清理不再被引用的凭据。
- `openai-responses` 与 `openai-compatible` 仍然不能互相覆盖（协议身份参与
  去重）。
- Planner 的 Provider 不再是特殊连接，也不再存在不可删除连接。

## 3. 交付内容

| 变更 | 位置 |
| --- | --- |
| 卡片只来自 `config.providers` | `web/src/settings-model.ts`（`buildProviderCards`）、`web/src/components/SettingsPanel.tsx`（`loadCatalog`） |
| completion 不再收编 preset/目录/本机发现 | `src/configuration/configuration-completion-service.ts` |
| 删除启动时固定 ref 回填 | `src/server/server-composition.ts`；`importLocalAgentCredentialsForRefs` 随之移除，只保留面向已配置 Provider 的 `importLocalAgentCredentials` |
| 激活成功后清理孤儿凭据 | `src/configuration/provider-credential-cleanup.ts`，Web 激活路径与 admin CLI 激活路径各调用一次 |
| 发布包内置记忆引擎 | `memory/engine.lock.json`、`scripts/prepare-memory-engine.mjs`、`scripts/package-release.mjs`、`src/installation/release-manifest.ts`、`scripts/install.sh`、`scripts/bootstrap-install.sh`、`scripts/install.ps1`、`src/installation/source-native-installer.ts`、`src/installation/source-native-updater.ts`、`src/install-cli.ts`、`src/desktop-install-cli.ts`、`apps/desktop/packaging/prepare-runtime.mjs` |
| 引擎启动支持编译产物 | `src/memory/memory-sidecar-command.ts`（`dist/gateway/server.js` 优先，开发用 `src/gateway/server.ts`） |
| UI 区分引擎缺失与 FTS5 | `src/management/memory-management.ts`（`classifyMemoryEngineProblem`）、`web/src/components/MemorySettingsPanel.tsx` |
| 打包即验证 FTS5 | `scripts/verify-memory-engine.mjs`，`.github/workflows/release-build.yml` |

## 4. 验证

- `npm run lint`、`npm run build --prefix web` 通过。
- 定向套件通过：`tests/configuration/provider-credential-cleanup.test.ts`、
  `tests/configuration/configuration-completion-service.test.ts`、
  `tests/configuration/local-agent-credentials.test.ts`、
  `tests/management/memory-management.test.ts`、
  `tests/memory/memory-runtime.test.ts`、`tests/web/settings-workbench.test.ts`、
  `tests/installation/release-manifest.test.ts`、
  `tests/installation/desktop-release.test.ts`、
  `tests/installation/desktop-clean-install.integration.test.ts`、
  `tests/release/verify-release-assets.test.ts`、
  `tests/scripts/bootstrap-install-trust.test.ts`。
- 全量 `npm test`：新增改动涉及的套件全绿；其余 57 个失败用例在改动前的
  `HEAD` 上以完全相同的方式失败（`git stash` 基线对比），与本次改动无关。
- 打包流程需要 `memory/tdai/dist/gateway/server.js` 存在，并运行
  `node scripts/verify-memory-engine.mjs` 断言 `stores.ftsAvailable === true`。

## 5. 遗留与取舍

- 依赖树不进入主仓库：CI 按 `memory/engine.lock.json` 的 pin commit 拉取、构建
  并打包；manifest 记录 source、revision、archive SHA-256 与 lockfile SHA-256。
- 凭据清理只在激活提交后执行，因此回滚到删除 Provider 之前的 revision 时，
  该 Provider 的 Key 需要重新输入。这是「删除即删除」的代价，已在
  `provider-credential-cleanup.ts` 注释中说明。
- 源码安装（`install-native-macos.mjs`、Desktop 开发 payload）在缺少引擎时会
  继续安装并给出警告；正式发布由 manifest 强制要求 `memory` artifact。
