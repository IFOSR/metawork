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
} from './types.js';
import { HARNESS_DRIVER_CATALOG } from './harness-driver-catalog.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

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
    z.enum([
      'coding',
      'image-editing',
      'image-generation',
      'long-context',
      'planning',
      'structured-output',
      'tools',
      'vision',
    ]),
    'Model capability',
    16,
  ),
  reasoning: z.enum(['disabled', 'low', 'medium', 'high']),
  routingNotes: z.object({
    summary: NonEmptyTextSchema.optional(),
    strengths: uniqueArray(NonEmptyTextSchema, 'model strength', 32).default([]),
    limitations: uniqueArray(NonEmptyTextSchema, 'model limitation', 32).default([]),
    preferredTaskTypes: uniqueArray(NonEmptyTextSchema, 'preferred model task type', 32).default([]),
    avoidTaskTypes: uniqueArray(NonEmptyTextSchema, 'avoided model task type', 32).default([]),
  }).strict().optional(),
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
  executorManual: z.object({
    sourceText: z.string().trim().max(8_000),
    assertionsSourceFingerprint: z.string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    semanticReceipt: z.string()
      .regex(/^manual_[a-f0-9-]{36}$/u)
      .optional(),
    assertions: z.array(z.object({
      topic: z.enum([
        'mission',
        'strength',
        'limitation',
        'preferred-task',
        'avoid-task',
        'model-contribution',
        'capability-policy',
        'delivery',
      ]),
      text: NonEmptyTextSchema,
      target: z.string().trim().min(1).max(200).optional(),
      modelRef: ReferenceIdSchema.optional(),
      modelCapability: z.enum([
        'coding',
        'image-editing',
        'image-generation',
        'long-context',
        'planning',
        'structured-output',
        'tools',
        'vision',
      ]).optional(),
      routingCapability: z.enum(ROUTING_CAPABILITY_IDS).optional(),
      disposition: z.enum([
        'preferred',
        'allowed',
        'avoid',
        'disabled',
      ]).optional(),
    }).strict()).max(64),
  }).strict().superRefine((manual, context) => {
    if (manual.sourceText.length === 0 && manual.assertions.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertions'],
        message: 'Executor manual assertions require non-empty sourceText',
      });
    }
  }).optional(),
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
  maxConcurrentTasks: z.number().int().min(1).max(8).default(2),
  maxConcurrentAttempts: z.number().int().min(1).max(32).default(4),
  maxConcurrentAttemptsPerTask: z.number().int().min(1).max(32).default(2),
  schedulingAgingMs: z.number().int().min(0).max(86_400_000).default(300_000),
  sameConversationQueueLimit: z.number().int().min(0).max(32).default(8),
  attemptTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional(),
  probeTimeoutMs: z.number().int().min(1_000).max(300_000).optional(),
}).strict().superRefine((policy, context) => {
  if (policy.maxConcurrentAttemptsPerTask > policy.maxConcurrentAttempts) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxConcurrentAttemptsPerTask'],
      message: 'maxConcurrentAttemptsPerTask must not exceed maxConcurrentAttempts',
    });
  }
});

const GatewayConfigSchema = z.object({
  enabled: z.boolean().optional(),
  bindHost: z.string().trim().min(1).max(253).refine(
    value => !value.includes('/') && !value.includes('\\') && !value.includes('@'),
    'bindHost must be a host name or IP address',
  ).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
}).strict();

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
    const driver = HARNESS_DRIVER_CATALOG[harness.driverId];
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
      && (
        driver.transport !== 'local-cli'
        || !('command' in driver)
        || driver.command !== harness.command
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harnesses', harnessRef, 'command'],
        message:
          `Harness driver ${harness.driverId} requires registered command ${
            'command' in driver ? driver.command : '(unsupported)'
          }`,
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

    const manual = agentClass.executorManual;
    if (!manual) continue;
    if (agentClass.kind !== 'executor') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentClasses', agentClassRef, 'executorManual'],
        message: 'Planner AgentClass must not define executorManual',
      });
      continue;
    }
    if (redactSensitiveText(manual.sourceText) !== manual.sourceText) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agentClasses', agentClassRef, 'executorManual', 'sourceText'],
        message: 'Executor manual guidance must not contain credential-like content',
      });
    }
    for (const [assertionIndex, assertion] of manual.assertions.entries()) {
      if (redactSensitiveText(assertion.text) !== assertion.text) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agentClasses', agentClassRef, 'executorManual', 'assertions', assertionIndex, 'text'],
          message: 'Executor manual assertions must not contain credential-like content',
        });
      }
      if (assertion.topic === 'capability-policy') {
        if (!assertion.routingCapability || !assertion.disposition) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['agentClasses', agentClassRef, 'executorManual', 'assertions', assertionIndex],
            message:
              'Executor capability-policy assertions require routingCapability and disposition',
          });
        }
      } else if (assertion.routingCapability || assertion.disposition) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agentClasses', agentClassRef, 'executorManual', 'assertions', assertionIndex],
          message:
            'routingCapability and disposition are valid only for capability-policy assertions',
        });
      }
    }
  }
}) as z.ZodType<AnyFusionConfigurationV2>;

export function parseAnyFusionConfigurationV2(value: unknown): AnyFusionConfigurationV2 {
  return AnyFusionConfigurationV2Schema.parse(value);
}
