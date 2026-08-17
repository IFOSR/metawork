import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
} from '../core/authorized-executor-binding.js';
import {
  assertSecretReference,
  type SecretStore,
} from './secret-store.js';
import type {
  AgentClassDefinition,
  RuntimeConfigurationView,
  RuntimePrivateConfigurationBinding,
} from './types.js';

export interface RuntimePrivateBindingResolverInput {
  configuration: RuntimeConfigurationView;
  authorizedBinding: AuthorizedExecutorBinding;
  secretStore: SecretStore;
}

export async function resolveRuntimePrivateConfigurationBinding(
  input: RuntimePrivateBindingResolverInput,
): Promise<RuntimePrivateConfigurationBinding> {
  const { configuration, authorizedBinding, secretStore } = input;
  requireRevision(configuration, authorizedBinding);

  const agentClass = configuration.agentClasses[authorizedBinding.agentClassRef];
  if (!agentClass || !agentClass.enabled || agentClass.kind !== 'executor') {
    throw new Error(
      `Executor AgentClass is not enabled: ${authorizedBinding.agentClassRef}`,
    );
  }
  if (agentClass.harnessRef !== authorizedBinding.harnessRef) {
    throw new Error(
      `Harness binding mismatch for AgentClass ${authorizedBinding.agentClassRef}: `
      + `expected ${agentClass.harnessRef}, received ${authorizedBinding.harnessRef}`,
    );
  }

  const harness = configuration.harnesses[authorizedBinding.harnessRef];
  if (!harness || !harness.enabled || harness.kind !== 'executor') {
    throw new Error(
      `Executor Harness is not enabled: ${authorizedBinding.harnessRef}`,
    );
  }

  const model = configuration.models[authorizedBinding.modelRef];
  if (!model || !model.enabled || !modelPolicyAllows(agentClass, authorizedBinding.modelRef)) {
    throw new Error(
      `Model binding is not enabled: ${authorizedBinding.modelRef}`,
    );
  }
  if (model.providerRef !== authorizedBinding.providerRef) {
    throw new Error(
      `Provider binding mismatch for Model ${authorizedBinding.modelRef}: `
      + `expected ${model.providerRef}, received ${authorizedBinding.providerRef}`,
    );
  }

  if (agentClass.permissionProfileRef !== authorizedBinding.permissionProfileRef) {
    throw new Error(
      `Permission Profile binding mismatch for AgentClass `
      + `${authorizedBinding.agentClassRef}: expected `
      + `${agentClass.permissionProfileRef ?? 'none'}, received `
      + authorizedBinding.permissionProfileRef,
    );
  }
  if (!configuration.permissionProfiles[authorizedBinding.permissionProfileRef]) {
    throw new Error(
      `Permission Profile is not enabled: ${authorizedBinding.permissionProfileRef}`,
    );
  }

  const provider = configuration.providers[authorizedBinding.providerRef];
  if (!provider || !provider.enabled) {
    throw new Error(`Provider is not enabled: ${authorizedBinding.providerRef}`);
  }
  if (provider.protocol !== 'openai-compatible') {
    throw new Error(
      `Provider protocol is not supported for runtime binding: ${provider.protocol}`,
    );
  }
  if (!provider.baseUrl.trim()) {
    throw new Error(`Provider base URL is empty: ${authorizedBinding.providerRef}`);
  }

  assertSecretReference(provider.apiKeyRef);
  let apiKey: string;
  try {
    apiKey = await secretStore.get(provider.apiKeyRef);
  } catch {
    throw new Error(
      `Provider credential could not be resolved: ${authorizedBinding.providerRef}`,
    );
  }
  if (!apiKey.trim()) {
    throw new Error(`Provider credential is empty: ${authorizedBinding.providerRef}`);
  }

  // 与 AgentRuntimeRenderer 的多 provider 命名约定保持一致：单 provider 时
  // codex/pi 配置用 `OPENAI_API_KEY`，多 provider 时用 `OPENAI_API_KEY__<REF>`。
  // 两个变量都注入，兼容单/多 provider 以及历史配置模板。
  const providerKeyVariable = `OPENAI_API_KEY__${authorizedBinding.providerRef
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')}`;
  const environment = Object.freeze({
    OPENAI_BASE_URL: provider.baseUrl,
    OPENAI_API_KEY: apiKey,
    [providerKeyVariable]: apiKey,
    OPENAI_MODEL: model.modelId,
  });
  return Object.freeze({
    revisionId: configuration.revisionId,
    bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
    environment,
  });
}

function requireRevision(
  configuration: RuntimeConfigurationView,
  authorizedBinding: AuthorizedExecutorBinding,
): void {
  if (configuration.revisionId !== authorizedBinding.configurationRevision) {
    throw new Error(
      `Configuration revision mismatch: expected ${configuration.revisionId}, `
      + `received ${authorizedBinding.configurationRevision}`,
    );
  }
}

function modelPolicyAllows(
  agentClass: AgentClassDefinition,
  modelRef: string,
): boolean {
  return agentClass.modelPolicy.mode === 'fixed'
    ? agentClass.modelPolicy.modelRef === modelRef
    : agentClass.modelPolicy.allowedModelRefs.includes(modelRef);
}
