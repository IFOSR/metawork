import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SourceNativeInstaller } from '../../../src/installation/source-native-installer.js';
import { resolveMetaWorkPaths } from '../../../src/installation/paths.js';
import { createProductionSecretStore } from '../../../src/configuration/production-secret-store.js';
import { ConfigurationService } from '../../../src/configuration/configuration-service.js';
import { commandExistsOnPath } from '../../../src/configuration/production-configuration-probe.js';
import { FileConfigurationRepository } from '../../../src/configuration/file-configuration-repository.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../../src/account/account-id.js';
import { resolveAccountPaths } from '../../../src/account/account-paths.js';
import { acquireRuntimeUpdateLock } from '../../../src/installation/runtime-update-lock.js';
import { SourceNativeUpdater } from '../../../src/installation/source-native-updater.js';
import { DesktopServiceManager } from '../../../src/client/desktop-service-manager.js';
import { isInstanceRunning } from '../../../src/management/lock.js';
import { ensureInternalLlmProvisioned } from '../../../src/configuration/internal-llm-provisioning.js';
import { repairDevelopmentDirectoryJournal, stopDevelopmentDatabaseHolders } from './development-recovery.js';

const [root, source, releaseId, mode] = process.argv.slice(2);
if (!root || !source || !releaseId) throw new Error('Explicit development root, source and release are required');
// This is a build-time setup process. It is never imported into the Electron Main bundle.
const paths = resolveMetaWorkPaths(undefined, resolve(root));
await mkdir(paths.root, { recursive: true, mode: 0o700 });
await ensureInternalLlmProvisioned({ installRoot: root });
const internalLlm = JSON.parse(await readFile(join(root, 'internal/llm.json'), 'utf8')) as {
  baseUrl?: string;
  modelId?: string;
};
const internalCredentials = JSON.parse(await readFile(join(root, 'internal/llm-credentials.json'), 'utf8')) as {
  internal?: { llm?: string };
};
const developmentProvider = {
  baseUrl: internalLlm.baseUrl ?? 'https://api.deepseek.com/v1',
  apiKey: internalCredentials.internal?.llm ?? '',
  modelId: internalLlm.modelId ?? 'deepseek-flash',
  region: 'international',
  secretReference: 'file-secret:anyfusion/providers/provider' as const,
  displayName: 'DeepSeek（系统默认）',
  systemManaged: true,
};
if (!developmentProvider.apiKey) throw new Error('Development internal LLM credential is missing');
if (mode === 'update') {
  const previous = JSON.parse(await readFile(join(root, 'app/current/release-identity.json'), 'utf8'));
  const running = () => isInstanceRunning(join(root, 'data/runtime.lock'));
  if (await running()) await new DesktopServiceManager({ installRoot: root, nodePath: process.execPath,
    releaseId: previous.releaseId, configHome: process.env.METAWORK_CONFIG_HOME }).stop();
  await stopDevelopmentDatabaseHolders(root);
  if (process.argv.includes('--repair-directory-journal')) {
    const backup = await repairDevelopmentDirectoryJournal(root);
    if (backup) process.stdout.write(`已修复工作区目录事件索引；原始数据库和剩余日志保存在 ${backup}\n`);
  }
  await new SourceNativeUpdater({ paths, installLaunchers: false,
    secretStore: createProductionSecretStore({ credentialsFile: paths.credentials }),
    isServerRunning: running, detectCommand: commandExistsOnPath,
  }).update({ releaseId, sourceRoot: resolve(source), plannerRoot: join(resolve(source), 'planner/AnyFusion-Pi') });
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const repository = new FileConfigurationRepository(accountPaths.config);
  const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials });
  const service = new ConfigurationService({ repository, secretStore, probe: async () => ({ ok: true }) });
  await service.initialize();
  const active = await service.getActiveSnapshot();
  const defaultModel = active.config.models['default-model'];
  if (
    defaultModel?.modelId === 'configure-in-settings'
    || (defaultModel?.modelId === developmentProvider.modelId
      && active.config.providers.provider?.displayName === developmentProvider.displayName)
  ) {
    await secretStore.put(developmentProvider.secretReference, developmentProvider.apiKey);
    const config = structuredClone(active.config);
    config.providers.provider = {
      ...config.providers.provider,
      displayName: developmentProvider.displayName,
      systemManaged: true,
      baseUrl: developmentProvider.baseUrl,
      apiKeyRef: developmentProvider.secretReference,
    };
    config.models['default-model'] = {
      ...defaultModel,
      modelId: developmentProvider.modelId,
      systemManaged: true,
      costInputPerMillion: 0.021,
      costOutputPerMillion: 16.8,
    };
    const draft = service.createDraft(config, active.revisionId);
    const validation = service.validateDraft(draft.revisionId);
    if (!validation.ok) throw new Error(validation.issues.map(issue => issue.message).join('; '));
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);
    await service.activateDraft(draft.revisionId, active.revisionId);
  }
} else {
const lock = await acquireRuntimeUpdateLock(paths.root, 'update');
try {
  await new SourceNativeInstaller({ paths, installLaunchers: false,
    secretStore: createProductionSecretStore({ credentialsFile: paths.credentials }), detectCommand: async () => false,
  }).install({ releaseId, sourceRoot: resolve(source), plannerRoot: join(resolve(source), 'planner/AnyFusion-Pi'),
    provider: developmentProvider,
  });
} finally { await lock.release(); }
}
