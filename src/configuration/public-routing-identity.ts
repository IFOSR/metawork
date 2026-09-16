import type { RevisionedAgentBinding } from '../core/authorized-executor-binding.js';
import type {
  ConfigurationSnapshot,
  KernelConfigurationView,
  RuntimeConfigurationView,
} from './types.js';
import {
  publicDisplayNameFromRef,
  publicProviderDisplayName,
} from './public-provider-catalog.js';
import {
  resolveAgentDisplayName,
  resolveProviderDisplayName,
} from './user-facing-names.js';

export interface PublicRoutingIdentity {
  executorDisplayName: string;
  harnessDisplayName: string;
  providerDisplayName: string;
  modelDisplayName: string;
  availability: 'available' | 'unavailable';
}

type PublicRoutingConfiguration =
  | ConfigurationSnapshot
  | KernelConfigurationView
  | RuntimeConfigurationView;

export function resolvePublicRoutingIdentity(
  source: PublicRoutingConfiguration | null | undefined,
  binding: Pick<
    RevisionedAgentBinding,
    'agentClassRef' | 'harnessRef' | 'providerRef' | 'modelRef' | 'configurationRevision'
  >,
): PublicRoutingIdentity {
  const configuration = configurationFacts(source);
  const model = configuration?.revisionId === binding.configurationRevision
    ? configuration.models[binding.modelRef]
    : undefined;
  const provider = model && configuration
    ? configuration.providers[model.providerRef]
    : undefined;
  const providerRef = model?.providerRef ?? binding.providerRef;
  const configuredProvider = configuration?.revisionId === binding.configurationRevision
    ? configuration.providers[providerRef]
    : undefined;
  const agentClass = configuration?.revisionId === binding.configurationRevision
    ? configuration.agentClasses?.[binding.agentClassRef]
    : undefined;
  const harness = configuration?.revisionId === binding.configurationRevision
    ? configuration.harnesses?.[binding.harnessRef]
    : undefined;

  return {
    executorDisplayName: executorDisplayName(
      binding.agentClassRef,
      agentClass && 'displayName' in agentClass ? agentClass.displayName : undefined,
    ),
    harnessDisplayName: harnessDisplayName(
      binding.harnessRef,
      harness && 'driverId' in harness ? harness.driverId : undefined,
    ),
    providerDisplayName: resolveProviderDisplayName(
      providerRef,
      configuredProvider && 'displayName' in configuredProvider
        ? configuredProvider.displayName
        : undefined,
      provider && 'baseUrl' in provider && typeof provider.baseUrl === 'string'
        ? publicProviderDisplayName(providerRef, provider.baseUrl)
        : publicProviderDisplayName(providerRef),
    ),
    modelDisplayName: model?.modelId ?? '历史模型信息不可用',
    availability: model ? 'available' : 'unavailable',
  };
}

function configurationFacts(source: PublicRoutingConfiguration | null | undefined): {
  revisionId: string;
  models: KernelConfigurationView['models'] | RuntimeConfigurationView['models'];
  providers: KernelConfigurationView['providers'] | RuntimeConfigurationView['providers'];
  agentClasses?: KernelConfigurationView['agentClasses'] | RuntimeConfigurationView['agentClasses'];
  harnesses?: RuntimeConfigurationView['harnesses'];
} | null {
  if (!source) return null;
  if ('config' in source) {
    return {
      revisionId: source.revisionId,
      models: source.config.models,
      providers: source.config.providers,
      agentClasses: source.config.agentClasses,
      harnesses: source.config.harnesses,
    };
  }
  return {
    revisionId: source.revisionId,
    models: source.models,
    providers: source.providers,
    agentClasses: source.agentClasses,
    ...('harnesses' in source ? { harnesses: source.harnesses } : {}),
  };
}

function executorDisplayName(agentClassRef: string, configured?: string): string {
  if (agentClassRef === 'planner') return 'MetaWork Planner (AnyFusion-Pi)';
  return resolveAgentDisplayName(agentClassRef, configured);
}

function harnessDisplayName(harnessRef: string, driverId?: string): string {
  const identity = driverId ?? harnessRef;
  if (identity === 'codex-cli') return 'Codex CLI';
  if (identity === 'pi-cli') return 'Pi CLI';
  if (identity === 'anyfusion-planner-host-v2') return 'MetaWork Planner (AnyFusion-Pi)';
  return publicDisplayNameFromRef(harnessRef);
}
