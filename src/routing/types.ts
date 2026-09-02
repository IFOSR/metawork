import type {
  HarnessExecutionProtocolId,
  ModelCapability,
} from '../configuration/types.js';

export const ROUTING_CAPABILITY_IDS = [
  'current-web-research',
  'image-editing',
  'image-generation',
  'workspace-engineering',
] as const;

export type RoutingCapabilityId = typeof ROUTING_CAPABILITY_IDS[number];

export const EXECUTOR_AFFORDANCE_IDS = [
  'public-web-fetch',
  'public-web-search',
  'source-citation',
  'workspace-command-validation',
  'workspace-read-write',
] as const;

export type ExecutorAffordanceId = typeof EXECUTOR_AFFORDANCE_IDS[number];

export interface RoutingCapabilityDefinition {
  deliveryContract: string;
  requiredAffordances: readonly ExecutorAffordanceId[];
  requiredModelCapabilities: readonly string[];
  requiredHarnessProtocols: readonly HarnessExecutionProtocolId[];
  recoverySafety: 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent';
}

export const ROUTING_CAPABILITY_REGISTRY = {
  'current-web-research': {
    deliveryContract:
      '研究当前公共网络信息，保留可追溯来源，并交付有来源支撑的结论。',
    requiredAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
    requiredModelCapabilities: [],
    requiredHarnessProtocols: [],
    recoverySafety: 'read_only',
  },
  'image-editing': {
    deliveryContract:
      '使用明确支持图片编辑的模型处理输入图片，并交付可验证的图片产物。',
    requiredAffordances: [],
    requiredModelCapabilities: ['image-editing'],
    requiredHarnessProtocols: ['workspace-image-artifact-v1'],
    recoverySafety: 'workspace_reconcilable',
  },
  'image-generation': {
    deliveryContract:
      '使用明确支持图片生成的模型根据文本要求生成图片，并交付可验证的图片产物。',
    requiredAffordances: [],
    requiredModelCapabilities: ['image-generation'],
    requiredHarnessProtocols: ['workspace-image-artifact-v1'],
    recoverySafety: 'workspace_reconcilable',
  },
  'workspace-engineering': {
    deliveryContract:
      '在受控工作区理解、修改和验证代码或文本文件，并交付变更或产物。',
    requiredAffordances: ['workspace-read-write', 'workspace-command-validation'],
    requiredModelCapabilities: [],
    requiredHarnessProtocols: [],
    recoverySafety: 'workspace_reconcilable',
  },
} as const satisfies Record<RoutingCapabilityId, RoutingCapabilityDefinition>;

const modelRequirementsForRoutingCapability = (
  capability: RoutingCapabilityId,
): readonly string[] => ROUTING_CAPABILITY_REGISTRY[capability].requiredModelCapabilities;

interface ModelDerivedAgentClass {
  routingCapabilities: readonly RoutingCapabilityId[];
  modelPolicy:
    | { mode: 'fixed'; modelRef: string }
    | { mode: 'auto'; allowedModelRefs: readonly string[] };
}

interface ModelDerivedModel {
  providerRef: string;
  capabilities: readonly string[];
  enabled: boolean;
}

export function deriveAgentClassRoutingCapabilities(
  agentClass: ModelDerivedAgentClass,
  models: Readonly<Record<string, ModelDerivedModel>>,
  providers?: Readonly<Record<string, { enabled: boolean }>>,
): RoutingCapabilityId[] {
  const modelRefs = agentClass.modelPolicy.mode === 'fixed'
    ? [agentClass.modelPolicy.modelRef]
    : agentClass.modelPolicy.allowedModelRefs;
  const modelCapabilities = modelRefs.flatMap(modelRef => {
    const model = models[modelRef];
    if (!model || !model.enabled || providers?.[model.providerRef]?.enabled === false) return [];
    return model.capabilities;
  });
  const derived = Object.entries(ROUTING_CAPABILITY_REGISTRY)
    .filter(([, definition]) => (
      definition.requiredModelCapabilities.length > 0
      && definition.requiredModelCapabilities.every(
        capability => modelCapabilities.includes(capability),
      )
    ))
    .map(([capability]) => capability as RoutingCapabilityId);
  return [...new Set([...agentClass.routingCapabilities, ...derived])]
    .sort((left, right) => left.localeCompare(right));
}

export function requiredModelCapabilitiesForRoutingCapabilities(
  routingCapabilities: readonly RoutingCapabilityId[],
): string[] {
  return [...new Set(routingCapabilities.flatMap(
    modelRequirementsForRoutingCapability,
  ))].sort((left, right) => left.localeCompare(right));
}

export interface PlannerRoutingCapabilityDefinition {
  id: RoutingCapabilityId;
  deliveryContract: string;
}

export interface ConfigurationCatalogAgentClass {
  id: string;
  routingCapabilities: RoutingCapabilityId[];
  capabilityPreferences: Array<{
    capabilityId: RoutingCapabilityId;
    disposition: 'preferred' | 'allowed' | 'avoid';
  }>;
  modelCapabilities?: Record<string, ModelCapability[]>;
  profileFingerprint: string;
  modelPolicy:
    | { mode: 'fixed'; modelRef: string }
    | {
        mode: 'auto';
        allowedModelRefs: string[];
        defaultModelRef?: string;
        fallback?: {
          enabled: boolean;
          order: string[];
        };
      };
}

export interface ConfigurationRoutingCatalog {
  version: 2;
  configurationRevision: string;
  capabilities: PlannerRoutingCapabilityDefinition[];
  agentClasses: ConfigurationCatalogAgentClass[];
}

export function deriveRecoverySafety(
  requiredCapabilities: readonly string[],
): RoutingCapabilityDefinition['recoverySafety'] {
  let result: RoutingCapabilityDefinition['recoverySafety'] = 'read_only';
  for (const capability of requiredCapabilities) {
    const definition: RoutingCapabilityDefinition | undefined = ROUTING_CAPABILITY_REGISTRY[capability as RoutingCapabilityId];
    if (!definition) return 'external_non_idempotent';
    if (definition.recoverySafety === 'external_non_idempotent') return 'external_non_idempotent';
    if (definition.recoverySafety === 'workspace_reconcilable') result = 'workspace_reconcilable';
  }
  return result;
}
