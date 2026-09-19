/**
 * 受控执行助手候选配置构造器（ADR-0028 §6，ADR-0033 2026-09-19 修正案）。
 *
 * 用户只提供产品字段（名称、Pi/Codex、模型策略、既有权限方案、职责说明、
 * 启用状态）；Harness、Driver、命令、能力声明等底层字段由服务端从受控模板
 * 补齐。该模块是纯函数构造：不写磁盘、不接触运行时 Repository，候选配置
 * 经 ConfigurationService 的既有校验/编译/探测/激活流程生效。
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  AgentClassDefinition,
  AnyFusionConfigurationV2,
  ConfigurationSnapshot,
  ModelPolicy,
} from './types.js';
import type { ExecutorAffordanceId, RoutingCapabilityId } from '../routing/types.js';
import { validateExecutorManualSourceText } from './configuration-service.js';

export type ExecutorToolId = 'pi' | 'codex';

export interface ExecutorEditableFields {
  displayName: string;
  modelPolicy: ModelPolicy;
  permissionProfileRef: string;
  manualSourceText: string;
  enabled: boolean;
}

export type ExecutorConfigurationChange =
  | { operation: 'create'; tool: ExecutorToolId; fields: ExecutorEditableFields }
  | { operation: 'update'; agentClassRef: string; fields: ExecutorEditableFields }
  | { operation: 'enable'; agentClassRef: string }
  | { operation: 'disable'; agentClassRef: string }
  | { operation: 'remove'; agentClassRef: string };

export type ExecutorConfigurationErrorCode =
  | 'invalid_configuration'
  | 'unsupported_change'
  | 'tool_unavailable';

/** 可恢复的执行助手配置错误；message 使用中文面向用户。 */
export class ExecutorConfigurationError extends Error {
  constructor(
    readonly code: ExecutorConfigurationErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ExecutorConfigurationError';
  }
}

export interface ExecutorConfigurationCandidate {
  baseRevisionId: string;
  change: ExecutorConfigurationChange;
  /** create 操作生成的新助手内部 ID。 */
  createdAgentClassRef?: string;
  /** 完整候选配置，交由既有校验与激活流程处理。 */
  config: AnyFusionConfigurationV2;
  /** 面向用户的安全变更摘要（不含命令、路径、凭据）。 */
  summary: string[];
}

const ReferenceIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);

const ModelPolicyInputSchema = z.union([
  z.object({
    mode: z.literal('fixed'),
    modelRef: ReferenceIdSchema,
  }).strict(),
  z.object({
    mode: z.literal('auto'),
    allowedModelRefs: z.array(ReferenceIdSchema).min(1).max(64),
    defaultModelRef: ReferenceIdSchema.optional(),
    fallback: z.object({
      enabled: z.boolean(),
      order: z.array(ReferenceIdSchema).max(64),
    }).strict().optional(),
  }).strict(),
]);

const ExecutorEditableFieldsSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  modelPolicy: ModelPolicyInputSchema,
  permissionProfileRef: ReferenceIdSchema,
  manualSourceText: z.string().trim().max(8_000),
  enabled: z.boolean(),
}).strict();

/** 输入只含受控用户字段；额外字段一律拒绝，不能夹带 Harness/Driver/能力注入。 */
export const ExecutorConfigurationChangeSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('create'),
    tool: z.enum(['pi', 'codex']),
    fields: ExecutorEditableFieldsSchema,
  }).strict(),
  z.object({
    operation: z.literal('update'),
    agentClassRef: ReferenceIdSchema,
    fields: ExecutorEditableFieldsSchema,
  }).strict(),
  z.object({
    operation: z.literal('enable'),
    agentClassRef: ReferenceIdSchema,
  }).strict(),
  z.object({
    operation: z.literal('disable'),
    agentClassRef: ReferenceIdSchema,
  }).strict(),
  z.object({
    operation: z.literal('remove'),
    agentClassRef: ReferenceIdSchema,
  }).strict(),
]);

export function parseExecutorConfigurationChange(value: unknown): ExecutorConfigurationChange {
  const parsed = ExecutorConfigurationChangeSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ExecutorConfigurationError(
      'invalid_configuration',
      `执行助手配置输入无效：${issue ? `${issue.path.join('.')} ${issue.message}` : '未知字段'}`,
      issue?.path.join('.'),
    );
  }
  return parsed.data;
}

const TOOL_DRIVER_IDS: Record<ExecutorToolId, 'pi-cli' | 'codex-cli'> = {
  pi: 'pi-cli',
  codex: 'codex-cli',
};

const TOOL_LABELS: Record<ExecutorToolId, string> = {
  pi: 'Pi',
  codex: 'Codex CLI',
};

/**
 * 沿配置引用解析可复用的执行工具入口：按真实 driverId 选择 executor Harness，
 * 不按配置键名推断。同类型多个入口时仅接受键名与驱动一致的明确模板，
 * 否则报歧义错误。
 */
export function resolveExecutorToolHarness(
  config: AnyFusionConfigurationV2,
  tool: ExecutorToolId,
): string {
  const driverId = TOOL_DRIVER_IDS[tool];
  const matches = Object.entries(config.harnesses)
    .filter(([, harness]) => harness.kind === 'executor' && harness.driverId === driverId)
    .map(([ref]) => ref)
    .sort();
  if (matches.length === 0) {
    throw new ExecutorConfigurationError(
      'tool_unavailable',
      `执行工具 ${TOOL_LABELS[tool]} 尚未安装或初始化，请先完成工具配置。`,
      'tool',
    );
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.includes(driverId)) return driverId;
  throw new ExecutorConfigurationError(
    'invalid_configuration',
    `执行工具 ${TOOL_LABELS[tool]} 存在多个入口配置，无法确定模板，请联系管理员。`,
    'tool',
  );
}

/** 受控能力模板：按既有权限方案派生，不从用户说明文字中自由发明。 */
function controlledExecutorTemplate(permissionProfileRef: string): {
  routingCapabilities: RoutingCapabilityId[];
  plannerAffordances: ExecutorAffordanceId[];
  primaryUseCases: string[];
  avoidUseCases: string[];
} {
  if (permissionProfileRef === 'public-web-research') {
    return {
      routingCapabilities: ['current-web-research'],
      plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
      primaryUseCases: ['current public-web research', 'source verification'],
      avoidUseCases: ['repository modification and engineering verification'],
    };
  }
  return {
    routingCapabilities: ['workspace-engineering', 'document-processing'],
    plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
    primaryUseCases: [
      'repository implementation',
      'tests',
      'engineering documentation',
    ],
    avoidUseCases: [],
  };
}

function assertModelPolicyReferences(
  config: AnyFusionConfigurationV2,
  modelPolicy: ModelPolicy,
): void {
  const referenced = modelPolicy.mode === 'fixed'
    ? [modelPolicy.modelRef]
    : [
        ...modelPolicy.allowedModelRefs,
        ...(modelPolicy.defaultModelRef ? [modelPolicy.defaultModelRef] : []),
        ...(modelPolicy.fallback?.order ?? []),
      ];
  for (const modelRef of new Set(referenced)) {
    if (!config.models[modelRef]) {
      throw new ExecutorConfigurationError(
        'invalid_configuration',
        `模型 ${modelRef} 不存在，请先在模型服务中配置该模型。`,
        'modelPolicy',
      );
    }
  }
}

function assertEditableFields(
  config: AnyFusionConfigurationV2,
  fields: ExecutorEditableFields,
): void {
  if (!config.permissionProfiles[fields.permissionProfileRef]) {
    throw new ExecutorConfigurationError(
      'invalid_configuration',
      `权限方案 ${fields.permissionProfileRef} 不存在，请从既有权限方案中选择。`,
      'permissionProfileRef',
    );
  }
  assertModelPolicyReferences(config, fields.modelPolicy);
  try {
    validateExecutorManualSourceText(fields.manualSourceText);
  } catch (error) {
    throw new ExecutorConfigurationError(
      'invalid_configuration',
      `职责说明无效：${(error as Error).message}`,
      'manualSourceText',
    );
  }
}

function requireExecutorAgentClass(
  config: AnyFusionConfigurationV2,
  agentClassRef: string,
): AgentClassDefinition {
  const agentClass = config.agentClasses[agentClassRef];
  if (!agentClass) {
    throw new ExecutorConfigurationError(
      'invalid_configuration',
      `执行助手 ${agentClassRef} 不存在，请刷新后重试。`,
      'agentClassRef',
    );
  }
  if (agentClass.kind !== 'executor') {
    throw new ExecutorConfigurationError(
      'unsupported_change',
      '不能通过执行助手管理修改规划助手。',
      'agentClassRef',
    );
  }
  return agentClass;
}

/**
 * 基于当前生效配置构造一次执行助手变更的候选配置。
 * 纯函数：不修改 base，不读写磁盘。
 */
export function buildExecutorConfigurationCandidate(
  base: ConfigurationSnapshot,
  rawChange: ExecutorConfigurationChange,
  createAgentClassRef: () => string = () => `executor-${randomUUID()}`,
): ExecutorConfigurationCandidate {
  const change = rawChange;
  const config = structuredClone(base.config);
  const summary: string[] = [];
  let createdAgentClassRef: string | undefined;

  switch (change.operation) {
    case 'create': {
      assertEditableFields(config, change.fields);
      const harnessRef = resolveExecutorToolHarness(config, change.tool);
      const agentClassRef = createAgentClassRef();
      if (config.agentClasses[agentClassRef]) {
        throw new ExecutorConfigurationError(
          'invalid_configuration',
          '内部 ID 冲突，请重试。',
        );
      }
      const template = controlledExecutorTemplate(change.fields.permissionProfileRef);
      const definition: AgentClassDefinition = {
        displayName: change.fields.displayName,
        kind: 'executor',
        harnessRef,
        modelPolicy: structuredClone(change.fields.modelPolicy),
        permissionProfileRef: change.fields.permissionProfileRef,
        routingCapabilities: template.routingCapabilities,
        primaryUseCases: template.primaryUseCases,
        avoidUseCases: template.avoidUseCases,
        plannerAffordances: template.plannerAffordances,
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: agentClassRef,
        executorManual: {
          sourceText: change.fields.manualSourceText,
          assertions: [],
        },
        enabled: change.fields.enabled,
      };
      config.agentClasses[agentClassRef] = definition;
      createdAgentClassRef = agentClassRef;
      summary.push(
        `新增执行助手“${change.fields.displayName}”（${TOOL_LABELS[change.tool]}，`
        + `${change.fields.enabled ? '启用' : '停用'}）。`,
      );
      break;
    }
    case 'update': {
      const existing = requireExecutorAgentClass(config, change.agentClassRef);
      assertEditableFields(config, change.fields);
      config.agentClasses[change.agentClassRef] = {
        ...existing,
        displayName: change.fields.displayName,
        modelPolicy: structuredClone(change.fields.modelPolicy),
        permissionProfileRef: change.fields.permissionProfileRef,
        routingCapabilities: controlledExecutorTemplate(
          change.fields.permissionProfileRef,
        ).routingCapabilities,
        plannerAffordances: controlledExecutorTemplate(
          change.fields.permissionProfileRef,
        ).plannerAffordances,
        executorManual: {
          // 语义断言只能经既有回执流程写入；普通编辑保留已有断言。
          ...(existing.executorManual ?? { assertions: [] }),
          sourceText: change.fields.manualSourceText,
          ...(existing.executorManual?.sourceText !== change.fields.manualSourceText
            ? {
                assertions: [],
                assertionsSourceFingerprint: undefined,
                semanticReceipt: undefined,
              }
            : {}),
        },
        enabled: change.fields.enabled,
      };
      summary.push(`更新执行助手“${change.fields.displayName}”。`);
      break;
    }
    case 'enable':
    case 'disable': {
      const existing = requireExecutorAgentClass(config, change.agentClassRef);
      const enabled = change.operation === 'enable';
      if (existing.enabled !== enabled) {
        config.agentClasses[change.agentClassRef] = { ...existing, enabled };
      }
      summary.push(
        `${enabled ? '启用' : '停用'}执行助手“${existing.displayName ?? change.agentClassRef}”。`,
      );
      break;
    }
    case 'remove': {
      const existing = requireExecutorAgentClass(config, change.agentClassRef);
      delete config.agentClasses[change.agentClassRef];
      summary.push(
        `删除执行助手“${existing.displayName ?? change.agentClassRef}”；历史工作和文件保留。`,
      );
      break;
    }
  }

  return {
    baseRevisionId: base.revisionId,
    change,
    ...(createdAgentClassRef ? { createdAgentClassRef } : {}),
    config,
    summary,
  };
}
