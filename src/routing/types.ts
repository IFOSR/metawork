export const ROUTING_CAPABILITY_IDS = [
  'current-web-research',
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
  recoverySafety: 'read_only' | 'workspace_reconcilable' | 'external_non_idempotent';
}

export const ROUTING_CAPABILITY_REGISTRY = {
  'current-web-research': {
    deliveryContract:
      'Research current public-web information, preserve traceable sources, and deliver source-backed findings.',
    requiredAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
    recoverySafety: 'read_only',
  },
  'workspace-engineering': {
    deliveryContract:
      'Understand, modify, and verify code or text files in a controlled workspace and deliver the resulting changes or artifacts.',
    requiredAffordances: ['workspace-read-write', 'workspace-command-validation'],
    recoverySafety: 'workspace_reconcilable',
  },
} as const satisfies Record<RoutingCapabilityId, RoutingCapabilityDefinition>;

export interface PlannerRoutingCapabilityDefinition {
  id: RoutingCapabilityId;
  deliveryContract: string;
}

export interface ConfigurationCatalogAgentClass {
  id: string;
  routingCapabilities: RoutingCapabilityId[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  affordances: ExecutorAffordanceId[];
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
