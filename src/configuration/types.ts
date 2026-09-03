import type { PermissionProfileId } from '../resource/types.js';
import type {
  ConfigurationRoutingCatalog,
  ExecutorAffordanceId,
  RoutingCapabilityId,
} from '../routing/types.js';

export type ConfigurationRevisionId = string;

export type ProviderProtocol = 'openai-compatible' | 'anthropic';

export interface ProviderDefinition {
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyRef: string;
  region: string;
  enabled: boolean;
}

export type ModelCapability =
  | 'coding'
  | 'image-editing'
  | 'image-generation'
  | 'long-context'
  | 'planning'
  | 'structured-output'
  | 'tools'
  | 'vision';

export type ModelReasoningLevel = 'disabled' | 'low' | 'medium' | 'high';

export interface ModelRoutingNotes {
  summary?: string;
  strengths?: string[];
  limitations?: string[];
  preferredTaskTypes?: string[];
  avoidTaskTypes?: string[];
}

export interface ModelProfile {
  providerRef: string;
  modelId: string;
  capabilities: ModelCapability[];
  reasoning: ModelReasoningLevel;
  routingNotes?: ModelRoutingNotes;
  contextLimit?: number;
  costTier?: 'low' | 'medium' | 'high';
  latencyTier?: 'low' | 'medium' | 'high';
  qualityTier?: 'low' | 'medium' | 'high';
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
  enabled: boolean;
}

export const HARNESS_DRIVER_IDS = [
  'a2a-v1',
  'anyfusion-planner-host-v2',
  'codex-cli',
  'container-cli',
  'pi-cli',
] as const;

export type HarnessDriverId = typeof HARNESS_DRIVER_IDS[number];
export type HarnessKind = 'planner' | 'executor';

export const HARNESS_EXECUTION_PROTOCOL_IDS = [
  'workspace-image-artifact-v1',
] as const;

export type HarnessExecutionProtocolId =
  typeof HARNESS_EXECUTION_PROTOCOL_IDS[number];

interface HarnessDefinitionBase {
  kind: HarnessKind;
  driverId: HarnessDriverId;
  supportsProbe: boolean;
  supportsAbort: boolean;
  supportsContinuation: boolean;
  enabled: boolean;
}

export interface LocalProcessHarnessDefinition extends HarnessDefinitionBase {
  transport: 'local-process';
  commandRef: string;
  args: string[];
}

export interface LocalCliHarnessDefinition extends HarnessDefinitionBase {
  transport: 'local-cli';
  command: string;
  args: string[];
}

export interface ContainerHarnessDefinition extends HarnessDefinitionBase {
  transport: 'container';
  imageRef: string;
  entrypoint: string[];
}

export interface A2aHarnessDefinition extends HarnessDefinitionBase {
  transport: 'a2a';
  endpoint: string;
  authTokenRef: string;
}

export type HarnessDefinition =
  | LocalProcessHarnessDefinition
  | LocalCliHarnessDefinition
  | ContainerHarnessDefinition
  | A2aHarnessDefinition;

export type ModelPolicy =
  | { mode: 'fixed'; modelRef: string }
  | {
      mode: 'auto';
      allowedModelRefs: string[];
      defaultModelRef?: string;
      fallback?: {
        enabled: boolean;
        order: string[];
      };
      objective?: AutoModelObjective;
    };

export type AutoModelObjective = Readonly<{
  priority: 'balanced' | 'quality' | 'cost' | 'latency';
  maxCostPerTurn?: number;
  maxLatencyMs?: number;
  minimumQualityTier?: 'low' | 'medium' | 'high';
}>;

export type ExecutorManualAssertionTopic =
  | 'mission'
  | 'strength'
  | 'limitation'
  | 'preferred-task'
  | 'avoid-task'
  | 'model-contribution'
  | 'capability-policy'
  | 'delivery';

export type ExecutorCapabilityDisposition =
  | 'preferred'
  | 'allowed'
  | 'avoid'
  | 'disabled';

export interface ExecutorManualAssertion {
  topic: ExecutorManualAssertionTopic;
  text: string;
  target?: string;
  modelRef?: string;
  modelCapability?: ModelCapability;
  routingCapability?: RoutingCapabilityId;
  disposition?: ExecutorCapabilityDisposition;
}

export interface ExecutorManualUserProfile {
  sourceText: string;
  assertionsSourceFingerprint?: string;
  semanticReceipt?: string;
  assertions: ExecutorManualAssertion[];
}

export interface AgentClassDefinition {
  kind: HarnessKind;
  harnessRef: string;
  modelPolicy: ModelPolicy;
  permissionProfileRef?: string;
  routingCapabilities: RoutingCapabilityId[];
  primaryUseCases: string[];
  avoidUseCases: string[];
  plannerAffordances: ExecutorAffordanceId[];
  skills: string[];
  mcpServers: string[];
  plugins: string[];
  generatedRuntimeRef: string;
  executorManual?: ExecutorManualUserProfile;
  enabled: boolean;
}

export interface PermissionProfileParameters {
  maxAdditionalReadPartitions?: number;
  allowedPublicDomains?: string[];
}

export interface PermissionProfile {
  profileId: PermissionProfileId;
  version: 1;
  parameters: PermissionProfileParameters;
}

export interface RuntimePolicy {
  maxConcurrentAttempts?: number;
  maxConcurrentTasks?: number;
  maxConcurrentAttemptsPerTask?: number;
  schedulingAgingMs?: number;
  sameConversationQueueLimit?: number;
  attemptTimeoutMs?: number;
  probeTimeoutMs?: number;
}

export interface FeishuGatewayAccessPolicy {
  dm_policy: 'pairing' | 'allow_all' | 'allowlist';
  allowed_users: string[];
  group_policy: 'open' | 'disabled';
  require_mention: boolean;
}

export interface FeishuGatewayDeliveryPolicy {
  final_markdown_mode?: 'card' | 'post';
  fallback_mode?: 'file' | 'post';
  final_file_fallback?: boolean;
}

export interface FeishuGatewayPlatformDefinition {
  enabled: boolean;
  domain?: 'feishu' | 'lark';
  connection_mode?: 'websocket' | 'webhook';
  app_id?: string;
  app_secret_env?: string;
  event_port?: number;
  event_path?: string;
  verification_token?: string;
  encrypt_key_env?: string;
  access?: FeishuGatewayAccessPolicy;
  delivery?: FeishuGatewayDeliveryPolicy;
  home_channel?: string;
}

export interface GatewayConfig {
  enabled?: boolean;
  bindHost?: string;
  port?: number;
  platforms?: {
    feishu?: FeishuGatewayPlatformDefinition;
  };
}

export interface AnyFusionConfigurationV2 {
  schemaVersion: 2;
  providers: Record<string, ProviderDefinition>;
  models: Record<string, ModelProfile>;
  harnesses: Record<string, HarnessDefinition>;
  agentClasses: Record<string, AgentClassDefinition>;
  permissionProfiles: Record<string, PermissionProfile>;
  runtimePolicy: RuntimePolicy;
  gateway: GatewayConfig;
}

export type ConfigurationSnapshot = Readonly<{
  revisionId: ConfigurationRevisionId;
  contentHash: string;
  config: AnyFusionConfigurationV2;
}>;

export interface PlannerModelProfile {
  id: string;
  providerRef: string;
  capabilities: ModelCapability[];
  reasoning: ModelReasoningLevel;
  routingNotes?: ModelRoutingNotes;
  region: string;
  contextLimit?: number;
  costTier?: 'low' | 'medium' | 'high';
  latencyTier?: 'low' | 'medium' | 'high';
  qualityTier?: 'low' | 'medium' | 'high';
  costInputPerMillion?: number;
  costOutputPerMillion?: number;
}

export type PlannerConfigurationView = Readonly<{
  revisionId: ConfigurationRevisionId;
  contentHash: string;
  models: PlannerModelProfile[];
  planner?: Readonly<{
    harnessRef: string;
    modelPolicy: ModelPolicy;
  }>;
  routingCatalog: ConfigurationRoutingCatalog;
  executorCapabilityManuals?: PlannerExecutorCapabilityManual[];
}>;

export interface PlannerExecutorCapabilityManual {
  agentClassRef: string;
  configurationRevision: ConfigurationRevisionId;
  markdown: string;
  sourceFingerprint: string;
  routableCapabilities: RoutingCapabilityId[];
  capabilities: Array<{
    capabilityId: RoutingCapabilityId;
    support: 'supported' | 'unsupported';
    routingDisposition: ExecutorCapabilityDisposition;
    evidence: Array<{
      kind:
        | 'model-system-known'
        | 'model-provider-declared'
        | 'model-user-confirmed'
        | 'executor-affordance'
        | 'harness-support'
        | 'executor-declaration';
      modelRef?: string;
      detail: string;
    }>;
    unresolvedReasons: string[];
  }>;
  tags: {
    bestFit: string[];
    avoid: string[];
  };
}

export interface KernelAgentClassConfiguration {
  kind: HarnessKind;
  harnessRef: string;
  modelPolicy: ModelPolicy;
  permissionProfileRef: string | null;
  routingCapabilities: RoutingCapabilityId[];
  modelCapabilities?: Record<string, ModelCapability[]>;
  enabled: boolean;
  transport: HarnessDefinition['transport'];
  supportsProbe: boolean;
  supportsAbort: boolean;
  supportsContinuation: boolean;
}

export type KernelConfigurationView = Readonly<{
  revisionId: ConfigurationRevisionId;
  contentHash: string;
  agentClasses: Record<string, KernelAgentClassConfiguration>;
  models: Record<string, {
    providerRef: string;
    modelId: string;
    capabilities: ModelCapability[];
    reasoning: ModelReasoningLevel;
    contextLimit?: number;
    costTier?: 'low' | 'medium' | 'high';
    latencyTier?: 'low' | 'medium' | 'high';
    qualityTier?: 'low' | 'medium' | 'high';
    costInputPerMillion?: number;
    costOutputPerMillion?: number;
    enabled: boolean;
  }>;
  providers: Record<string, {
    enabled: boolean;
  }>;
  permissionProfiles: Record<string, PermissionProfile>;
  runtimePolicy: RuntimePolicy;
}>;

export type RuntimeConfigurationView = Readonly<{
  revisionId: ConfigurationRevisionId;
  contentHash: string;
  schemaVersion: 2;
  providers: Record<string, ProviderDefinition>;
  models: Record<string, ModelProfile>;
  harnesses: Record<string, HarnessDefinition>;
  agentClasses: Record<string, AgentClassDefinition>;
  permissionProfiles: Record<string, PermissionProfile>;
  runtimePolicy: RuntimePolicy;
  gateway: GatewayConfig;
}>;

export type RuntimePrivateConfigurationBinding = Readonly<{
  revisionId: ConfigurationRevisionId;
  bindingFingerprint: string;
  environment?: Readonly<Record<string, string>>;
}>;

export type ConfigurationServicePort = Readonly<{
  getActiveSnapshot(): Promise<ConfigurationSnapshot>;
  getSnapshot(revisionId: ConfigurationRevisionId): Promise<ConfigurationSnapshot>;
  getPlannerView(revisionId: ConfigurationRevisionId): Promise<PlannerConfigurationView>;
  getKernelView(revisionId: ConfigurationRevisionId): Promise<KernelConfigurationView>;
  getRuntimeBinding(
    revisionId: ConfigurationRevisionId,
    agentClassId: string,
    modelRef: string,
  ): Promise<RuntimePrivateConfigurationBinding>;
}>;
