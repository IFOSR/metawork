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
  const harness = configuration?.revisionId === binding.configurationRevision
    ? configuration.harnesses?.[binding.harnessRef]
    : undefined;

  return {
    executorDisplayName: executorDisplayName(binding.agentClassRef),
    harnessDisplayName: harnessDisplayName(
      binding.harnessRef,
      harness && 'driverId' in harness ? harness.driverId : undefined,
    ),
    providerDisplayName: publicProviderDisplayName(
      providerRef,
      provider && 'baseUrl' in provider && typeof provider.baseUrl === 'string'
        ? provider.baseUrl
        : undefined,
    ),
    modelDisplayName: model?.modelId ?? '历史模型信息不可用',
    availability: model ? 'available' : 'unavailable',
  };
}

function configurationFacts(source: PublicRoutingConfiguration | null | undefined): {
  revisionId: string;
  models: KernelConfigurationView['models'] | RuntimeConfigurationView['models'];
  providers: KernelConfigurationView['providers'] | RuntimeConfigurationView['providers'];
  harnesses?: RuntimeConfigurationView['harnesses'];
} | null {
  if (!source) return null;
  if ('config' in source) {
    return {
      revisionId: source.revisionId,
      models: source.config.models,
      providers: source.config.providers,
      harnesses: source.config.harnesses,
    };
  }
  return {
    revisionId: source.revisionId,
    models: source.models,
    providers: source.providers,
    ...('harnesses' in source ? { harnesses: source.harnesses } : {}),
  };
}

function executorDisplayName(agentClassRef: string): string {
  if (agentClassRef === 'codex-cli') return 'Codex CLI';
  if (agentClassRef === 'pi-agent') return 'Pi Agent';
  if (agentClassRef === 'planner') return 'MetaWork Planner (AnyFusion-Pi)';
  return publicDisplayNameFromRef(agentClassRef);
}

function harnessDisplayName(harnessRef: string, driverId?: string): string {
  const identity = driverId ?? harnessRef;
  if (identity === 'codex-cli') return 'Codex CLI';
  if (identity === 'pi-cli') return 'Pi CLI';
  if (identity === 'anyfusion-planner-host-v2') return 'MetaWork Planner (AnyFusion-Pi)';
  return publicDisplayNameFromRef(harnessRef);
}
