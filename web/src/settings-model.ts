export type ConfigurationFieldState =
  | '已自动发现'
  | '已从 Provider 补全'
  | '已从本机 Agent 导入'
  | '需要确认'
  | '缺失';

export interface SettingsProviderEntry {
  providerRef: string;
  displayName: string;
  baseUrl: string;
  modelIds: string[];
  credentialState: ConfigurationFieldState;
  enabled?: boolean;
}

export interface SettingsModelEntry {
  ref: string;
  providerRef: string;
  modelId: string;
  capabilities: string[];
  capabilityState: ConfigurationFieldState;
  contextLimit?: number;
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  latencyTier?: string;
  qualityTier?: string;
  reasoning?: string;
  costTier?: string;
  enabled?: boolean;
}

export type RoutingMode = 'auto' | 'fixed';
export type RoutingObjective = 'balanced' | 'quality' | 'cost' | 'latency';

export interface AgentClassRoutingDraft {
  mode: RoutingMode;
  modelRef: string;
  allowedModelRefs: string[];
  defaultModelRef: string;
  objective: RoutingObjective;
  minimumQualityTier: 'low' | 'medium' | 'high';
}

export type RoutingDraftMap = Record<string, AgentClassRoutingDraft>;

export interface AgentClassRoutingFacts {
  agentClassRef: string;
  displayName: string;
  kind: 'planner' | 'executor';
  harnessRef: string;
  harnessLabel: string;
  transport: string;
  driverId: string;
  primaryUseCases: string[];
  avoidUseCases: string[];
  routingCapabilities: string[];
  capabilityContracts: string[];
  affordances: string[];
}

export const ROUTING_CAPABILITY_CONTRACTS: Record<string, string> = {
  'current-web-research': '研究当前公共网络信息，并保留可追溯来源后交付有来源支撑的结论。',
  'workspace-engineering': '在受控工作区理解、修改和验证代码或文本文件，并交付变更或产物。',
};

export interface ProviderModelOption {
  modelId: string;
  configured: boolean;
  modelRef: string | null;
}

export interface ModelCompatibility {
  eligible: boolean;
  requiredCapabilities: string[];
  missingCapabilities: string[];
}

export function buildProviderModelOptions(
  providers: readonly SettingsProviderEntry[],
  models: readonly SettingsModelEntry[],
  providerRef: string,
): ProviderModelOption[] {
  const provider = providers.find(item => item.providerRef === providerRef);
  const configured = models.filter(model => model.providerRef === providerRef);
  const configuredById = new Map(configured.map(model => [model.modelId, model.ref]));
  const modelIds = new Set([
    ...(provider?.modelIds ?? []),
    ...configured.map(model => model.modelId),
  ]);

  return [...modelIds]
    .sort((left, right) => left.localeCompare(right))
    .map(modelId => ({
      modelId,
      configured: configuredById.has(modelId),
      modelRef: configuredById.get(modelId) ?? null,
    }));
}

export function toggleModelRef(
  current: readonly string[],
  modelRef: string,
  enabled: boolean,
): string[] {
  const next = new Set(current);
  if (enabled) next.add(modelRef);
  else next.delete(modelRef);
  return [...next].sort((left, right) => left.localeCompare(right));
}

export function modelIdentityKey(providerRef: string, modelId: string): string {
  return `${providerRef}\u0000${modelId}`;
}

export function dedupeModelEntries(
  models: readonly SettingsModelEntry[],
): SettingsModelEntry[] {
  const seen = new Set<string>();
  return models.filter(model => {
    const key = modelIdentityKey(model.providerRef, model.modelId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function refsForModelIdentity(
  models: readonly SettingsModelEntry[],
  providerRef: string,
  modelId: string,
): string[] {
  return models
    .filter(model => model.providerRef === providerRef && model.modelId === modelId)
    .map(model => model.ref);
}

export function removeModelRefsFromRoutingDraft(
  draft: RoutingDraftMap,
  modelRefs: readonly string[],
): RoutingDraftMap {
  const removed = new Set(modelRefs);
  return Object.fromEntries(Object.entries(draft).map(([agentClassRef, entry]) => {
    if (entry.mode === 'fixed') {
      return [agentClassRef, {
        ...entry,
        modelRef: removed.has(entry.modelRef) ? '' : entry.modelRef,
      }];
    }
    const allowedModelRefs = entry.allowedModelRefs.filter(ref => !removed.has(ref));
    return [agentClassRef, {
      ...entry,
      allowedModelRefs,
      defaultModelRef: removed.has(entry.defaultModelRef) ? (allowedModelRefs[0] ?? '') : entry.defaultModelRef,
    }];
  }));
}

export function invalidRoutingDrafts(
  draft: RoutingDraftMap,
  models: readonly SettingsModelEntry[],
): string[] {
  const available = new Set(models.filter(model => model.enabled !== false).map(model => model.ref));
  return Object.entries(draft)
    .filter(([, entry]) => entry.mode === 'fixed'
      ? !entry.modelRef || !available.has(entry.modelRef)
      : entry.allowedModelRefs.length === 0
        || entry.allowedModelRefs.some(ref => !available.has(ref))
        || (entry.defaultModelRef.length > 0 && !entry.allowedModelRefs.includes(entry.defaultModelRef)))
    .map(([agentClassRef]) => agentClassRef)
    .sort((left, right) => left.localeCompare(right));
}

export function humanizeProviderRef(providerRef: string): string {
  return providerRef
    .split(/[-_]+/u)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || providerRef;
}

export function humanizeAgentClassRef(agentClassRef: string): string {
  const names: Record<string, string> = {
    planner: 'Planner',
    'codex-cli': 'Code CLI',
    'pi-agent': 'Pi Agent',
    'deepseek-cli': 'DeepSeek CLI',
    'kimi-cli': 'Kimi CLI',
  };
  return names[agentClassRef] ?? humanizeProviderRef(agentClassRef);
}

export function evaluateModelCompatibility(
  model: SettingsModelEntry,
  facts: AgentClassRoutingFacts,
): ModelCompatibility {
  const required = new Set<string>();
  if (facts.kind === 'planner') {
    required.add('planning');
    required.add('structured-output');
  }
  if (facts.kind === 'executor' && facts.harnessRef === 'codex-cli') {
    required.add('gpt-family');
  } else if (
    facts.kind === 'executor'
    && facts.agentClassRef !== 'pi-agent'
    && facts.routingCapabilities.includes('workspace-engineering')
  ) {
    required.add('coding');
    required.add('tools');
  } else if (
    facts.kind === 'executor'
    && facts.agentClassRef !== 'pi-agent'
    && facts.routingCapabilities.includes('current-web-research')
  ) {
    required.add('tools');
  }
  const requiredCapabilities = [...required].sort();
  const missingCapabilities = requiredCapabilities
    .filter(capability => capability === 'gpt-family'
      ? !isGptRelatedModel(model.modelId)
      : !model.capabilities.includes(capability));
  return {
    eligible: missingCapabilities.length === 0,
    requiredCapabilities,
    missingCapabilities,
  };
}

export function isGptRelatedModel(modelId: string): boolean {
  return /(?:^|[/:._-])gpt(?:[/:._-]|\d|$)/iu.test(modelId);
}

export function replaceModelIdentity(
  model: SettingsModelEntry,
  providerRef: string,
  modelId: string,
): SettingsModelEntry {
  return {
    ref: model.ref,
    providerRef,
    modelId,
    capabilities: [],
    capabilityState: '需要确认',
    enabled: model.enabled,
  };
}

export function mergeCompletedModelFacts(
  model: SettingsModelEntry,
  completed: {
    capabilities: string[];
    capabilityState: ConfigurationFieldState;
    contextLimit?: number;
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
    latencyTier?: string;
    qualityTier?: string;
  },
): SettingsModelEntry {
  return {
    ...model,
    capabilities: completed.capabilities,
    capabilityState: completed.capabilityState,
    ...(completed.contextLimit !== undefined ? { contextLimit: completed.contextLimit } : {}),
    ...(completed.costInputPerMillion !== undefined
      ? { costInputPerMillion: completed.costInputPerMillion }
      : {}),
    ...(completed.costOutputPerMillion !== undefined
      ? { costOutputPerMillion: completed.costOutputPerMillion }
      : {}),
    ...(completed.latencyTier ? { latencyTier: completed.latencyTier } : {}),
    ...(completed.qualityTier ? { qualityTier: completed.qualityTier } : {}),
  };
}

export function describeRoutingObjective(objective: RoutingObjective): string {
  return {
    balanced: '均衡完成成本',
    quality: '优先质量',
    cost: '优先成本',
    latency: '优先响应速度',
  }[objective];
}
