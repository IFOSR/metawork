// Activates the Feishu gateway platform definition through the authoritative
// ConfigurationService so Servers pick the binding up from the active
// configuration snapshot instead of ad-hoc runtime state.
import { join } from 'node:path';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { ConfigurationService } from '../configuration/configuration-service.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import { createProductionConfigurationProbe } from '../configuration/production-configuration-probe.js';
import {
  createLegacyProductionSecretStore,
  createProductionSecretStore,
} from '../configuration/production-secret-store.js';
import { prepareProductionSecretStore } from '../configuration/production-secret-store.js';
import { importLegacyProviderCredentials } from '../configuration/legacy-provider-credential-import.js';
import type {
  AnyFusionConfigurationV2,
  FeishuGatewayPlatformDefinition,
} from '../configuration/types.js';
import { resolveMetaWorkPaths } from '../installation/paths.js';
import { commandExistsOnPath } from '../configuration/production-configuration-probe.js';

export interface ActivateFeishuPlatformInput {
  feishu: FeishuGatewayPlatformDefinition;
  installRoot?: string;
  revisionPrefix?: string;
}

export interface SetFeishuGatewayBindingInput {
  enabled: boolean;
  installRoot?: string;
  revisionPrefix?: string;
}

/**
 * Returns a copy of the configuration with this machine's Feishu platform
 * enabled/disabled. Credentials and the rest of the platform definition are
 * preserved so rebinding does not require the setup wizard.
 */
export function withFeishuGatewayEnabled(
  config: AnyFusionConfigurationV2,
  enabled: boolean,
): AnyFusionConfigurationV2 {
  const feishu = config.gateway?.platforms?.feishu;
  if (!feishu) {
    throw new Error('本机尚未绑定飞书，请先运行 `metawork server setup-feishu`');
  }
  const next = structuredClone(config);
  next.gateway = {
    ...next.gateway,
    platforms: { ...next.gateway.platforms, feishu: { ...feishu, enabled } },
  };
  return next;
}

export async function activateFeishuGatewayPlatform(
  input: ActivateFeishuPlatformInput,
): Promise<{ revisionId: string }> {
  const result = await activateFeishuPlatformMutation({
    installRoot: input.installRoot,
    revisionPrefix: input.revisionPrefix ?? 'feishu-setup',
    mutate: config => {
      const next: AnyFusionConfigurationV2 = structuredClone(config);
      next.gateway = {
        ...next.gateway,
        enabled: true,
        platforms: {
          ...next.gateway.platforms,
          feishu: input.feishu,
        },
      };
      return next;
    },
  });
  return { revisionId: result.revisionId! };
}

/**
 * Flips this machine's Feishu platform binding through the same authoritative
 * activation path as the setup wizard. When the platform is already in the
 * requested state no new revision is created and `changed` is false.
 */
export async function setFeishuGatewayBinding(
  input: SetFeishuGatewayBindingInput,
): Promise<{ revisionId: string | null; changed: boolean }> {
  return activateFeishuPlatformMutation({
    installRoot: input.installRoot,
    revisionPrefix: input.revisionPrefix ?? 'feishu-binding',
    mutate: config => {
      const current = config.gateway?.platforms?.feishu?.enabled;
      const next = withFeishuGatewayEnabled(config, input.enabled);
      return current === input.enabled ? null : next;
    },
  });
}

async function activateFeishuPlatformMutation(input: {
  installRoot?: string;
  revisionPrefix: string;
  mutate: (config: AnyFusionConfigurationV2) => AnyFusionConfigurationV2 | null;
}): Promise<{ revisionId: string | null; changed: boolean }> {
  const paths = resolveMetaWorkPaths(undefined, input.installRoot);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const repository = new FileConfigurationRepository(accountPaths.config);
  await repository.initialize();
  const recovery = await repository.recover();
  if (recovery.status === 'empty') {
    throw new Error('active configuration is missing; install MetaWork first');
  }
  const snapshot = await repository.getActiveSnapshot();
  const legacySecretStore = createLegacyProductionSecretStore({
    secretsRoot: accountPaths.secrets,
    env: process.env,
    references: Object.values(snapshot.config.providers).map(provider => provider.apiKeyRef),
  });
  const secretStore = createProductionSecretStore({ credentialsFile: paths.credentials });
  await prepareProductionSecretStore(secretStore);
  await importLegacyProviderCredentials({
    target: secretStore,
    providers: snapshot.config.providers,
    legacyStore: legacySecretStore,
  });

  const next = input.mutate(snapshot.config);
  if (!next) {
    return { revisionId: null, changed: false };
  }

  const service = new ConfigurationService({
    repository,
    createRevisionId: () => `${input.revisionPrefix}-${Date.now()}`,
    probe: createProductionConfigurationProbe({
      releaseRoot: paths.appCurrent,
      secretStore,
      detectCommand: command => Promise.resolve(commandExistsOnPath(command, process.env.PATH ?? '')),
    }),
  });
  const draft = service.createDraft(next, snapshot.revisionId);
  const validation = service.validateDraft(draft.revisionId);
  if (!validation.ok) {
    throw new Error(
      `Feishu 配置校验失败: ${validation.issues
        .map(issue => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const compiled = service.compileDraft(draft.revisionId);
  const probe = await service.probeDraft(draft.revisionId);
  if (!probe.ok) {
    throw new Error(`Feishu 配置探针失败: ${(probe.issues ?? []).join('; ')}`);
  }
  const activated = await service.activateDraft(draft.revisionId, snapshot.revisionId);
  if (!activated.ok) {
    throw new Error(
      `Feishu 配置激活失败: ${activated.code}（active revision: ${activated.activeRevisionId ?? 'none'}）`,
    );
  }
  return { revisionId: draft.revisionId, changed: true };
}
