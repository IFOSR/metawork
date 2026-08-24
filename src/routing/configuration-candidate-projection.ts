import type { ModelCapability } from '../configuration/types.js';
import type { AutoModelCandidate } from './auto-model-resolver.js';

export interface CandidateProjectionConfiguration {
  agentClasses: Record<string, {
    harnessRef: string;
  }>;
  providers?: Record<string, {
    enabled: boolean;
  }>;
  models: Record<string, {
    providerRef: string;
    modelId: string;
    capabilities: ModelCapability[];
    contextLimit?: number;
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
    latencyTier?: 'low' | 'medium' | 'high';
    qualityTier?: 'low' | 'medium' | 'high';
    enabled: boolean;
  }>;
}

export interface CandidateProjectionOptions {
  mode?: 'fixed' | 'auto';
}

/**
 * Builds the single system-owned candidate projection used by Kernel and
 * runtime availability probes. The user policy still narrows this set.
 */
export function projectConfigurationCandidates(
  configuration: CandidateProjectionConfiguration,
  agentClassRef: string,
  options: CandidateProjectionOptions = {},
): AutoModelCandidate[] {
  const codexAuto = options.mode !== 'fixed'
    && isCodexAgentClass(configuration, agentClassRef);
  return Object.entries(configuration.models)
    .filter(([, model]) => {
      const provider = configuration.providers?.[model.providerRef];
      return model.enabled && provider?.enabled !== false;
    })
    .map(([modelRef, model]) => ({
      providerRef: model.providerRef,
      modelRef,
      modelId: model.modelId,
      capabilities: model.capabilities,
      contextLimit: model.contextLimit,
      costInputPerMillion: model.costInputPerMillion,
      costOutputPerMillion: model.costOutputPerMillion,
      latencyTier: model.latencyTier,
      qualityTier: model.qualityTier,
      health: 'healthy' as const,
      available: true,
      providerEnabled: true,
      harnessCompatible: codexAuto ? isGptRelatedModel(model.modelId) : true,
    }))
    .sort((left, right) => left.modelRef.localeCompare(right.modelRef));
}

export function isGptRelatedModel(modelId: string): boolean {
  return /(?:^|[/:._-])gpt(?:[/:._-]|\d|$)/iu.test(modelId);
}

function isCodexAgentClass(
  configuration: CandidateProjectionConfiguration,
  agentClassRef: string,
): boolean {
  const agentClass = configuration.agentClasses[agentClassRef];
  return agentClassRef === 'codex-cli'
    || agentClassRef === 'code-cli'
    || agentClass?.harnessRef === 'codex-cli'
    || agentClass?.harnessRef.includes('codex') === true;
}
