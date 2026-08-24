import { z } from 'zod';
import { PERMISSION_PROFILE_IDS } from '../resource/types.js';
import {
  EXECUTOR_AFFORDANCE_IDS,
  ROUTING_CAPABILITY_REGISTRY,
  ROUTING_CAPABILITY_IDS,
} from '../routing/types.js';
import {
  HARNESS_DRIVER_IDS,
  type AnyFusionConfigurationV2,
  type HarnessDriverId,
  type HarnessKind,
} from './types.js';

const REFERENCE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SECRET_REFERENCE =
  /^(?:file-secret|keychain):[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const RELEASE_REFERENCE = /^release:[a-z][a-z0-9-]{0,63}$/;
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DOMAIN_NAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ReferenceIdSchema = z.string().regex(REFERENCE_ID);
const NonEmptyTextSchema = z.string().trim().min(1).max(500);

function uniqueArray<T extends z.ZodTypeAny>(
  valueSchema: T,
  label: string,
  maximum: number,
) {
  return z.array(valueSchema).max(maximum).superRefine((values, context) => {
    const seen = new Set<unknown>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `duplicate ${label} reference: ${String(value)}`,
        });
      }
      seen.add(value);
    }
  });
}

function credentialFreeHttpUrlSchema(label: string) {
  return z.url().superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must use HTTP(S)`,
      });
    }
    if (url.username || url.password || url.search || url.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must not contain credentials, query parameters, or fragments`,
      });
    }
  });
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value);
}

const CommandArgumentSchema = z.string().trim().min(1).max(500).refine(
  value => !isAbsoluteHostPath(value),
  'command arguments must not contain absolute host paths',
);

const ProviderDefinitionSchema = z.object({
  protocol: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: credentialFreeHttpUrlSchema('Provider baseUrl'),
  apiKeyRef: z.string().regex(SECRET_REFERENCE),
  region: ReferenceIdSchema,
  enabled: z.boolean(),
}).strict();

const ModelProfileSchema = z.object({
  providerRef: ReferenceIdSchema,
  modelId: z.string().trim().min(1).max(200),
  capabilities: uniqueArray(
    z.enum(['coding', 'long-context', 'planning', 'structured-output', 'tools', 'vision']),
    'Model capability',
    16,
  ),
  reasoning: z.enum(['disabled', 'low', 'medium', 'high']),
  contextLimit: z.number().int().min(1_024).max(10_000_000).optional(),
  costTier: z.enum(['low', 'medium', 'high']).optional(),
  latencyTier: z.enum(['low', 'medium', 'high']).optional(),
  qualityTier: z.enum(['low', 'medium', 'high']).optional(),
  costInputPerMillion: z.number().finite().min(0).max(1_000_000).optional(),
  costOutputPerMillion: z.number().finite().min(0).max(1_000_000).optional(),
  enabled: z.boolean(),
}).strict();

const HarnessBaseShape = {
  kind: z.enum(['planner', 'executor']),
  driverId: z.enum(HARNESS_DRIVER_IDS),
  supportsProbe: z.boolean().default(false),
  supportsAbort: z.boolean().default(false),
  supportsContinuation: z.boolean().default(false),
  enabled: z.boolean(),
};

const HarnessDefinitionSchema = z.discriminatedUnion('transport', [
  z.object({
    ...HarnessBaseShape,
    transport: z.literal('local-process'),
    commandRef: z.string().regex(RELEASE_REFERENCE),
    args: uniqueArray(CommandArgumentSchema, 'command argument', 64).default([]),
  }).strict(),
  z.object({
    ...HarnessBaseShape,
    transport: z.literal('local-cli'),
    command: z.string().regex(BARE_COMMAND),
    args: uniqueArray(CommandArgumentSchema, 'command argument', 64).default([]),
  }).strict(),
  z.object({
    ...HarnessBaseShape,
    transport: z.literal('container'),
    imageRef: z.string().trim().min(1).max(300),
    entrypoint: uniqueArray(CommandArgumentSchema, 'container entrypoint', 64).default([]),
  }).strict(),
  z.object({
    ...HarnessBaseShape,
    transport: z.literal('a2a'),
    endpoint: credentialFreeHttpUrlSchema('A2A endpoint'),
    authTokenRef: z.string().regex(SECRET_REFERENCE),
  }).strict(),
]);

const FixedModelPolicySchema = z.object({
  mode: z.literal('fixed'),
  modelRef: ReferenceIdSchema,
}).strict();

const AutoModelPolicySchema = z.object({
  mode: z.literal('auto'),
  allowedModelRefs: uniqueArray(ReferenceIdSchema, 'Model', 32).min(1),
  defaultModelRef: ReferenceIdSchema.optional(),
  fallback: z.object({
    enabled: z.boolean(),
    order: uniqueArray(ReferenceIdSchema, 'fallback Model', 32),
  }).strict().optional(),
  objective: z.object({
    priority: z.enum(['balanced', 'quality', 'cost', 'latency']),
    maxCostPerTurn: z.number().finite().min(0).max(1_000_000).optional(),
    maxLatencyMs: z.number().int().min(1).max(86_400_000).optional(),
    minimumQualityTier: z.enum(['low', 'medium', 'high']).optional(),
  }).strict().optional(),
}).strict().superRefine((policy, context) => {
  const allowed = new Set(policy.allowedModelRefs);
  if (policy.defaultModelRef && !allowed.has(policy.defaultModelRef)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultModelRef'],
      message: 'defaultModelRef must be included in allowedModelRefs',
    });
  }
  for (const [index, modelRef] of (policy.fallback?.order ?? []).entries()) {
    if (!allowed.has(modelRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fallback', 'order', index],
        message: 'fallback Model must be included in allowedModelRefs',
      });
    }
  }
  if (policy.fallback?.enabled && policy.fallback.order.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fallback', 'order'],
      message: 'enabled fallback requires at least one Model',
    });
  }
});

const ModelPolicySchema = z.union([
  FixedModelPolicySchema,
  AutoModelPolicySchema,
]);

const AgentClassDefinitionSchema = z.object({
  kind: z.enum(['planner', 'executor']),
  harnessRef: ReferenceIdSchema,
  modelPolicy: ModelPolicySchema,
  permissionProfileRef: ReferenceIdSchema.optional(),
  routingCapabilities: uniqueArray(
    z.enum(ROUTING_CAPABILITY_IDS),
    'Routing Capability',
    ROUTING_CAPABILITY_IDS.length,
  ).default([]),
  primaryUseCases: uniqueArray(NonEmptyTextSchema, 'primary use case', 32).default([]),
  avoidUseCases: uniqueArray(NonEmptyTextSchema, 'avoid use case', 32).default([]),
  plannerAffordances: uniqueArray(
    z.enum(EXECUTOR_AFFORDANCE_IDS),
    'Planner affordance',
    EXECUTOR_AFFORDANCE_IDS.length,
  ).default([]),
  skills: uniqueArray(ReferenceIdSchema, 'Skill', 64).default([]),
  mcpServers: uniqueArray(ReferenceIdSchema, 'MCP server', 64).default([]),
  plugins: uniqueArray(ReferenceIdSchema, 'Plugin', 64).default([]),
  generatedRuntimeRef: ReferenceIdSchema,
  enabled: z.boolean(),
}).strict().superRefine((agentClass, context) => {
  if (agentClass.kind === 'executor') {
    if (!agentClass.permissionProfileRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissionProfileRef'],
        message: 'Executor AgentClass requires permissionProfileRef',
      });
    }
    if (agentClass.routingCapabilities.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routingCapabilities'],
        message: 'Executor AgentClass requires at least one Routing Capability',
      });
    }
    const declaredAffordances = new Set(agentClass.plannerAffordances);
    for (const [capabilityIndex, capabilityId] of agentClass.routingCapabilities.entries()) {
      for (const requiredAffordance of ROUTING_CAPABILITY_REGISTRY[capabilityId].requiredAffordances) {
        if (!declaredAffordances.has(requiredAffordance)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['routingCapabilities', capabilityIndex],
            message:
              `Routing Capability ${capabilityId} requires Planner affordance ${requiredAffordance}`,
          });
        }
      }
    }
  } else {
    if (agentClass.modelPolicy.mode !== 'fixed') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['modelPolicy', 'mode'],
        message: 'Planner AgentClass must use a fixed model policy',
      });
    }
    if (agentClass.permissionProfileRef) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['permissionProfileRef'],
        message: 'Planner AgentClass must not define permissionProfileRef',
      });
    }
    if (agentClass.routingCapabilities.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routingCapabilities'],
        message: 'Planner AgentClass must not define Routing Capabilities',
      });
    }
    if (agentClass.plannerAffordances.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plannerAffordances'],
        message: 'Planner AgentClass must not define executor affordances',
      });
    }
  }
});

const BasePermissionParametersSchema = z.object({
  maxAdditionalReadPartitions: z.number().int().min(0).max(32).optional(),
}).strict();

const PermissionProfileSchema = z.discriminatedUnion('profileId', [
  z.object({
    profileId: z.literal(PERMISSION_PROFILE_IDS[0]),
    version: z.literal(1),
    parameters: BasePermissionParametersSchema,
  }).strict(),
  z.object({
    profileId: z.literal(PERMISSION_PROFILE_IDS[1]),
    version: z.literal(1),
    parameters: z.object({
      maxAdditionalReadPartitions: z.number().int().min(0).max(32).optional(),
      allowedPublicDomains: uniqueArray(
        z.string().toLowerCase().regex(DOMAIN_NAME),
        'public domain',
        64,
      ).optional(),
    }).strict(),
  }).strict(),
  z.object({
    profileId: z.literal(PERMISSION_PROFILE_IDS[2]),
    version: z.literal(1),
    parameters: BasePermissionParametersSchema,
  }).strict(),
]);

const RuntimePolicySchema = z.object({
  maxConcurrentAttempts: z.number().int().min(1).max(4).optional(),
  attemptTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  probeTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict();

const GatewayConfigSchema = z.object({
  enabled: z.boolean().optional(),
  bindHost: z.string().trim().min(1).max(253).refine(
    value => !value.includes('/') && !value.includes('\\') && !value.includes('@'),
    'bindHost must be a host name or IP address',
  ).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
}).strict();

const HARNESS_DRIVER_REGISTRY: Record<
  HarnessDriverId,
  Readonly<{ kind: HarnessKind; transport: string; command?: string }>
> = {
  'a2a-v1': { kind: 'executor', transport: 'a2a' },
  'anyfusion-planner-host-v2': { kind: 'planner', transport: 'local-process' },
  'codex-cli': { kind: 'executor', transport: 'local-cli', command: 'codex' },
  'container-cli': { kind: 'executor', transport: 'container' },
  'pi-cli': { kind: 'executor', transport: 'local-cli', command: 'pi' },
};

export const AnyFusionConfigurationV2Schema = z.object({
  schemaVersion: z.literal(2),
  providers: z.record(ReferenceIdSchema, ProviderDefinitionSchema),
  models: z.record(ReferenceIdSchema, ModelProfileSchema),
  harnesses: z.record(ReferenceIdSchema, HarnessDefinitionSchema),
  agentClasses: z.record(ReferenceIdSchema, AgentClassDefinitionSchema),
  permissionProfiles: z.record(ReferenceIdSchema, PermissionProfileSchema),
  runtimePolicy: RuntimePolicySchema,
  gateway: GatewayConfigSchema,
}).strict().superRefine((configuration, context) => {
  for (const [modelRef, model] of Object.entries(configuration.models)) {
    const provider = configuration.providers[model.providerRef];
    if (!provider) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', modelRef, 'providerRef'],
        message: `unknown Provider reference: ${model.providerRef}`,
      });
    } else if (model.enabled && !provider.enabled) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['models', modelRef, 'providerRef'],
        message: `enabled Model references disabled Provider: ${model.providerRef}`,
      });
    }

  }

  for (const [harnessRef, harness] of Object.entries(configuration.harnesses)) {
    const driver = HARNESS_DRIVER_REGISTRY[harness.driverId];
    if (driver.kind !== harness.kind || driver.transport !== harness.transport) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harnesses', harnessRef, 'driverId'],
        message:
          `Harness driver ${harness.driverId} does not support ${harness.kind}/${harness.transport}`,
      });
    }
    if (
      harness.transport === 'local-cli'
      && driver.command !== harness.command
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harnesses', harnessRef, 'command'],
        message:
          `Harness driver ${harness.driverId} requires registered command ${driver.command}`,
      });
    }
  }

  for (const [agentClassRef, agentClass] of Object.entries(configuration.agentClasses)) {
    const harness = configuration.harnesses[agentClass.harnessRef];
    if (!harness) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentClasses', agentClassRef, 'harnessRef'],
        message: `unknown Harness reference: ${agentClass.harnessRef}`,
      });
    } else {
      if (harness.kind !== agentClass.kind) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agentClasses', agentClassRef, 'harnessRef'],
          message:
            `${agentClass.kind} AgentClass must reference a ${agentClass.kind} Harness`,
        });
      }
      if (agentClass.enabled && !harness.enabled) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agentClasses', agentClassRef, 'harnessRef'],
          message: `enabled AgentClass references disabled Harness: ${agentClass.harnessRef}`,
        });
      }
    }

    const modelRefs = agentClass.modelPolicy.mode === 'fixed'
      ? [agentClass.modelPolicy.modelRef]
      : agentClass.modelPolicy.allowedModelRefs;
    for (const [index, modelRef] of modelRefs.entries()) {
      const model = configuration.models[modelRef];
      const path = agentClass.modelPolicy.mode === 'fixed'
        ? ['agentClasses', agentClassRef, 'modelPolicy', 'modelRef']
        : ['agentClasses', agentClassRef, 'modelPolicy', 'allowedModelRefs', index];
      if (!model) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `unknown Model reference: ${modelRef}`,
        });
      } else if (!model.enabled) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `AgentClass references disabled Model: ${modelRef}`,
        });
      }
    }

    if (
      agentClass.permissionProfileRef
      && !configuration.permissionProfiles[agentClass.permissionProfileRef]
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentClasses', agentClassRef, 'permissionProfileRef'],
        message: `unknown Permission Profile reference: ${agentClass.permissionProfileRef}`,
      });
    }
  }
}) as z.ZodType<AnyFusionConfigurationV2>;

export function parseAnyFusionConfigurationV2(value: unknown): AnyFusionConfigurationV2 {
  return AnyFusionConfigurationV2Schema.parse(value);
}
