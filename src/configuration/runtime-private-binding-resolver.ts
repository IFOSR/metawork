import {
  authorizedExecutorBindingFingerprint,
  type AuthorizedExecutorBinding,
  type RevisionedAgentBinding,
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

export interface PlannerRuntimeEnvironmentResolverInput {
  configuration: RuntimeConfigurationView;
  plannerBinding: RevisionedAgentBinding;
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

  const environment = await resolveProviderEnvironment({
    configuration,
    providerRef: authorizedBinding.providerRef,
    modelId: model.modelId,
    secretStore,
  });
  return Object.freeze({
    revisionId: configuration.revisionId,
    bindingFingerprint: authorizedExecutorBindingFingerprint(authorizedBinding),
    environment,
  });
}

export async function resolvePlannerRuntimeEnvironment(
  input: PlannerRuntimeEnvironmentResolverInput,
): Promise<Readonly<Record<string, string>>> {
  const { configuration, plannerBinding, secretStore } = input;
  requireRevision(configuration, plannerBinding);
  const agentClass = configuration.agentClasses[plannerBinding.agentClassRef];
  if (!agentClass || !agentClass.enabled || agentClass.kind !== 'planner') {
    throw new Error(`Planner AgentClass is not enabled: ${plannerBinding.agentClassRef}`);
  }
  if (agentClass.harnessRef !== plannerBinding.harnessRef) {
    throw new Error(
      `Harness binding mismatch for Planner AgentClass ${plannerBinding.agentClassRef}: `
      + `expected ${agentClass.harnessRef}, received ${plannerBinding.harnessRef}`,
    );
  }
  const harness = configuration.harnesses[plannerBinding.harnessRef];
  if (!harness || !harness.enabled || harness.kind !== 'planner') {
    throw new Error(`Planner Harness is not enabled: ${plannerBinding.harnessRef}`);
  }
  const model = configuration.models[plannerBinding.modelRef];
  if (!model || !model.enabled || !modelPolicyAllows(agentClass, plannerBinding.modelRef)) {
    throw new Error(`Planner Model binding is not enabled: ${plannerBinding.modelRef}`);
  }
  if (model.providerRef !== plannerBinding.providerRef) {
    throw new Error(
      `Provider binding mismatch for Planner Model ${plannerBinding.modelRef}: `
      + `expected ${model.providerRef}, received ${plannerBinding.providerRef}`,
    );
  }
  if (plannerBinding.permissionProfileRef !== null) {
    throw new Error('Planner binding must not include an Executor Permission Profile');
  }
  return resolveProviderEnvironment({
    configuration,
    providerRef: plannerBinding.providerRef,
    modelId: model.modelId,
    secretStore,
  });
}

function requireRevision(
  configuration: RuntimeConfigurationView,
  binding: RevisionedAgentBinding,
): void {
  if (configuration.revisionId !== binding.configurationRevision) {
    throw new Error(
      `Configuration revision mismatch: expected ${configuration.revisionId}, `
      + `received ${binding.configurationRevision}`,
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

async function resolveProviderEnvironment(input: {
  configuration: RuntimeConfigurationView;
  providerRef: string;
  modelId: string;
  secretStore: SecretStore;
}): Promise<Readonly<Record<string, string>>> {
  const provider = input.configuration.providers[input.providerRef];
  if (!provider || !provider.enabled) {
    throw new Error(`Provider is not enabled: ${input.providerRef}`);
  }
  if (provider.protocol !== 'openai-compatible') {
    throw new Error(
      `Provider protocol is not supported for runtime binding: ${provider.protocol}`,
    );
  }
  if (!provider.baseUrl.trim()) {
    throw new Error(`Provider base URL is empty: ${input.providerRef}`);
  }

  assertSecretReference(provider.apiKeyRef);
  let apiKey: string;
  try {
    apiKey = await input.secretStore.get(provider.apiKeyRef);
  } catch {
    throw new Error(`Provider credential could not be resolved: ${input.providerRef}`);
  }
  if (!apiKey.trim()) {
    throw new Error(`Provider credential is empty: ${input.providerRef}`);
  }

  const providerKeyVariable = `OPENAI_API_KEY__${input.providerRef
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')}`;
  return Object.freeze({
    OPENAI_BASE_URL: provider.baseUrl,
    OPENAI_API_KEY: apiKey,
    [providerKeyVariable]: apiKey,
    OPENAI_MODEL: input.modelId,
  });
}
