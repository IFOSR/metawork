// Activates the Feishu gateway platform definition through the authoritative
// ConfigurationService so Servers pick the binding up from the active
// configuration snapshot instead of ad-hoc runtime state.
import { join } from 'node:path';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import { ConfigurationService } from '../configuration/configuration-service.js';
import { FileConfigurationRepository } from '../configuration/file-configuration-repository.js';
import { createProductionConfigurationProbe } from '../configuration/production-configuration-probe.js';
import { createProductionSecretStore } from '../configuration/production-secret-store.js';
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

export async function activateFeishuGatewayPlatform(
  input: ActivateFeishuPlatformInput,
): Promise<{ revisionId: string }> {
  const paths = resolveMetaWorkPaths(undefined, input.installRoot);
  const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, paths.root);
  const repository = new FileConfigurationRepository(accountPaths.config);
  await repository.initialize();
  const recovery = await repository.recover();
  if (recovery.status === 'empty') {
    throw new Error('active configuration is missing; install MetaWork first');
  }
  const snapshot = await repository.getActiveSnapshot();

  const next: AnyFusionConfigurationV2 = structuredClone(snapshot.config);
  next.gateway = {
    ...next.gateway,
    enabled: true,
    platforms: {
      ...next.gateway.platforms,
      feishu: input.feishu,
    },
  };

  const service = new ConfigurationService({
    repository,
    createRevisionId: () => `${input.revisionPrefix ?? 'feishu-setup'}-${Date.now()}`,
    probe: createProductionConfigurationProbe({
      releaseRoot: paths.appCurrent,
      secretStore: createProductionSecretStore({
        secretsRoot: accountPaths.secrets,
        env: process.env,
        references: Object.values(snapshot.config.providers).map(provider => provider.apiKeyRef),
      }),
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
  return { revisionId: draft.revisionId };
}
