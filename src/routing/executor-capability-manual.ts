import type {
  AgentClassDefinition,
  ModelCapability,
} from '../configuration/types.js';
import type {
  ExecutorManualAssertionTopic,
  PlannerExecutorCapabilityManual,
} from '../configuration/types.js';
import {
  ROUTING_CAPABILITY_REGISTRY,
  type RoutingCapabilityId,
} from './types.js';
import {
  compileExecutorCapabilityProfileCore,
  type EffectiveExecutorModel,
  type ExecutorCapabilityProfileInput,
} from './executor-capability-profile-core.js';

const MAX_MANUAL_BYTES = 24_000;
const ROUTING_CAPABILITY_LABELS: Record<RoutingCapabilityId, string> = {
  'current-web-research': '当前公共网络研究',
  'image-editing': '图片编辑',
  'image-generation': '图片生成',
  'workspace-engineering': '工作区工程',
};
const MODEL_CAPABILITY_LABELS: Record<ModelCapability, string> = {
  coding: '代码理解与实现',
  'image-editing': '图片编辑',
  'image-generation': '图片生成',
  'long-context': '长上下文',
  planning: '规划',
  'structured-output': '结构化输出',
  tools: '工具调用',
  vision: '视觉理解',
};
const SYSTEM_TEXT_TRANSLATIONS: Readonly<Record<string, string>> = {
  'repository implementation': '代码仓库实现',
  implementation: '任务实现',
  research: '研究分析',
  tests: '测试实现与修复',
  'engineering documentation': '工程文档',
  'image generation': '图片生成',
  'image editing': '图片编辑',
  'current public-web research': '当前公共网络研究',
  'current public-web research requiring source-backed delivery': '需要来源支撑的当前公共网络研究',
  'source verification': '来源核验',
  'local artifacts': '本地产物交付',
  'repository modification and engineering verification': '代码仓库修改与工程验证',
};

export type ExecutorCapabilityManualInput = ExecutorCapabilityProfileInput;

export type { ExecutorManualAssertion, ExecutorManualUserProfile } from '../configuration/types.js';

export function buildExecutorCapabilityManual(
  input: ExecutorCapabilityManualInput,
): PlannerExecutorCapabilityManual {
  if (input.agentClass.kind !== 'executor') {
    throw new Error(`capability manual requires an Executor AgentClass: ${input.agentClassRef}`);
  }

  const profile = compileExecutorCapabilityProfileCore(input);
  const models = profile.effectiveModels;
  const userProfile = input.agentClass.executorManual;

  const markdown = renderManual(
    input,
    models,
    profile.routableCapabilities,
    profile.capabilities,
    userProfile,
    profile.sourceFingerprint,
  );
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MANUAL_BYTES) {
    throw new Error(
      `Executor capability manual exceeds ${MAX_MANUAL_BYTES}-byte limit: ${input.agentClassRef}`,
    );
  }
  return {
    agentClassRef: input.agentClassRef,
    configurationRevision: input.configurationRevision,
    sourceFingerprint: profile.sourceFingerprint,
    routableCapabilities: profile.routableCapabilities,
    capabilities: profile.capabilities,
    markdown,
    tags: {
      bestFit: toTags(renderBestFit(
        input.agentClass,
        models,
        profile.capabilities,
        userProfile?.assertions ?? [],
      )),
      avoid: toTags([
        ...renderAvoid(input.agentClass, models, userProfile?.assertions ?? []),
        ...renderAvoidedCapabilities(profile.capabilities),
        ...renderDisabledCapabilities(profile.capabilities),
      ]),
    },
  };
}

function renderManual(
  input: ExecutorCapabilityManualInput,
  models: EffectiveExecutorModel[],
  routingCapabilities: RoutingCapabilityId[],
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
  userProfile: AgentClassDefinition['executorManual'],
  sourceFingerprint: string,
): string {
  const { agentClass } = input;
  const assertions = userProfile?.assertions ?? [];
  const userTopics = new Set(assertions.map(assertion => assertion.topic));
  const lines = [
    '---',
    `name: metawork-executor-${input.agentClassRef}`,
    'kind: executor-capability-manual',
    'schemaVersion: 1',
    `agentClassRef: ${input.agentClassRef}`,
    `configurationRevision: ${input.configurationRevision}`,
    `sourceFingerprint: ${sourceFingerprint}`,
    '---',
    '',
    `# Executor：${input.agentClassRef}`,
    '',
    '## 核心定位',
    ...renderMission(routingCapabilities, assertions, userTopics),
    ...(userProfile?.sourceText.trim() && assertions.length === 0
      ? [`- 用户定义：${userProfile.sourceText.trim()}`]
      : []),
    '',
    '## 稳定能力',
    ...renderReliableCapabilities(agentClass, models, routingCapabilities),
    '',
    '## 模型配置',
    ...renderModelProfile(agentClass, models, capabilities, assertions),
    '',
    '## 适合任务',
    ...renderBestFit(agentClass, models, capabilities, assertions),
    '',
    '## 不适合或应交接',
    ...renderAvoid(agentClass, models, assertions),
    ...renderAvoidedCapabilities(capabilities),
    ...renderDisabledCapabilities(capabilities),
    '',
    '## 当前未满足',
    ...renderUnresolvedCapabilities(capabilities),
    '',
    '## 交付方式',
    ...renderDelivery(agentClass, assertions, userTopics),
    '',
    '## 路由说明',
    '- 每个 Subtask 应聚焦于一个边界清晰、可独立验收的交付目标。',
    '- 本说明书是 Planner 的权威语义路由依据，结构化路由投影由同一能力画像生成。',
    '- Kernel 仍负责具体模型、权限、健康与执行绑定授权。',
    '- 用户定义与系统生成内容冲突时，以用户定义为准。',
  ];

  return `${lines.join('\n')}\n`;
}

function renderMission(
  routingCapabilities: readonly RoutingCapabilityId[],
  assertions: NonNullable<AgentClassDefinition['executorManual']>['assertions'],
  userTopics: ReadonlySet<string>,
): string[] {
  const userMission = assertions.filter(assertion => assertion.topic === 'mission');
  if (userMission.length > 0) return userMission.map(assertion => `- ${assertion.text}`);
  if (userTopics.has('mission')) return [];
  return routingCapabilities.map(capability => (
    `- ${ROUTING_CAPABILITY_REGISTRY[capability].deliveryContract}`
  ));
}

function renderReliableCapabilities(
  agentClass: AgentClassDefinition,
  models: EffectiveExecutorModel[],
  routingCapabilities: readonly RoutingCapabilityId[],
): string[] {
  const lines = [
    ...routingCapabilities.map(capability => (
      `- 路由能力：${ROUTING_CAPABILITY_LABELS[capability]}（\`${capability}\`）`
    )),
    ...agentClass.plannerAffordances.map(affordance => `- Planner 可用能力：\`${affordance}\``),
  ];
  const common = intersectCapabilities(models.map(entry => entry.model.capabilities));
  if (models.length > 1) {
    lines.push('', '所有候选模型共同具备的能力：');
    lines.push(...common.map(capability => `- ${MODEL_CAPABILITY_LABELS[capability]}`));
  } else if (models.length === 1) {
    lines.push('', '当前模型具备的能力：');
    lines.push(...common.map(capability => `- ${MODEL_CAPABILITY_LABELS[capability]}`));
  } else {
    lines.push('', '- 当前没有可用模型。');
  }
  return lines;
}

function renderModelProfile(
  agentClass: AgentClassDefinition,
  models: EffectiveExecutorModel[],
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
  assertions: NonNullable<AgentClassDefinition['executorManual']>['assertions'],
): string[] {
  if (models.length === 0) return ['- 当前没有可用模型。'];

  const lines: string[] = [];
  const defaultModelRef = agentClass.modelPolicy.mode === 'auto'
    ? agentClass.modelPolicy.defaultModelRef
    : undefined;
  const fallbackRefs = agentClass.modelPolicy.mode === 'auto'
    ? agentClass.modelPolicy.fallback?.order ?? []
    : [];

  for (const { modelRef, model, capabilitySources } of models) {
    const role = agentClass.modelPolicy.mode === 'fixed'
      ? '固定'
      : modelRef === defaultModelRef
        ? '默认'
        : fallbackRefs.includes(modelRef)
          ? '回退'
          : '候选';
    lines.push(`- \`${modelRef}\`（${model.modelId}），策略角色：${role}`);
    if (
      model.routingNotes?.summary
      && isGeneratedPositiveAllowed(model.routingNotes.summary, capabilities)
    ) {
      lines.push(`  - ${model.routingNotes.summary}`);
    }
    const strengths = (model.routingNotes?.strengths ?? [])
      .filter(value => isGeneratedPositiveAllowed(value, capabilities));
    if (strengths.length > 0) {
      lines.push(`  - 优势：${strengths.join('；')}`);
    }
    if (model.routingNotes?.limitations?.length) {
      lines.push(`  - 局限：${model.routingNotes.limitations.join('；')}`);
    }
    const preferredTaskTypes = (model.routingNotes?.preferredTaskTypes ?? [])
      .filter(value => isGeneratedPositiveAllowed(value, capabilities));
    if (preferredTaskTypes.length > 0) {
      lines.push(`  - 优先任务类型：${preferredTaskTypes.join('；')}`);
    }
    if (model.routingNotes?.avoidTaskTypes?.length) {
      lines.push(`  - 应避免的任务类型：${model.routingNotes.avoidTaskTypes.join('；')}`);
    }
    for (const capability of model.capabilities) {
      const source = capabilitySources[capability] === 'model-user-confirmed'
        ? '，用户确认'
        : '';
      lines.push(
        `  - ${MODEL_CAPABILITY_LABELS[capability]}：此能力由模型 \`${modelRef}\` 提供${source}。`,
      );
    }
    for (const assertion of assertions.filter(assertion => (
      assertion.topic === 'model-contribution'
      && (!assertion.modelRef || assertion.modelRef === modelRef)
    ))) {
      const capability = assertion.modelCapability
        ? `（对应${MODEL_CAPABILITY_LABELS[assertion.modelCapability]}能力）`
        : '';
      lines.push(`  - 用户定义的模型贡献：${assertion.text}${capability}`);
    }
    if (model.contextLimit) lines.push(`  - 上下文上限：${model.contextLimit}`);
    lines.push(
      `  - 推理等级：${translateTier(model.reasoning)}；质量：${translateTier(model.qualityTier)}；`
      + `延迟：${translateTier(model.latencyTier)}；成本：${translateTier(model.costTier)}`,
    );
  }

  if (agentClass.modelPolicy.mode === 'auto') {
    if (defaultModelRef) lines.push(`- Auto 默认模型：\`${defaultModelRef}\`。`);
    if (fallbackRefs.length > 0) {
      lines.push(`- Auto 回退顺序：${fallbackRefs.map(ref => `\`${ref}\``).join('、')}。`);
    }
  }
  return lines;
}

function renderBestFit(
  agentClass: AgentClassDefinition,
  models: EffectiveExecutorModel[],
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
  assertions: NonNullable<AgentClassDefinition['executorManual']>['assertions'],
): string[] {
  const user = assertions.filter(assertion => (
    assertion.topic === 'strength' || assertion.topic === 'preferred-task'
  ));
  const positiveCapabilities = capabilities
    .filter(capability => (
      capability.support === 'supported'
      && (
        capability.routingDisposition === 'preferred'
        || capability.routingDisposition === 'allowed'
      )
    ))
    .map(capability => capability.capabilityId);
  const generatedSemantics = [
    ...agentClass.primaryUseCases.filter(
      useCase => (
        isSupportedUseCase(useCase, positiveCapabilities)
        && isGeneratedPositiveAllowed(useCase, capabilities)
      ),
    ),
    ...models.flatMap(({ model }) => [
      ...(model.routingNotes?.strengths ?? []),
      ...(model.routingNotes?.preferredTaskTypes ?? []),
    ]).filter(value => isGeneratedPositiveAllowed(value, capabilities)),
  ];
  const system = [
    ...generatedSemantics,
    ...positiveCapabilities
      .filter(capability => capability === 'image-generation' || capability === 'image-editing')
      .map(capability => ROUTING_CAPABILITY_LABELS[capability]),
  ]
    .filter(useCase => !hasMatchingAssertion(assertions, useCase, ['limitation', 'avoid-task']))
    .filter(useCase => !hasMatchingAssertion(assertions, useCase, ['strength', 'preferred-task']))
    .map(translateSystemText)
    .filter((useCase, index, useCases) => useCases.indexOf(useCase) === index)
    .map(useCase => `- ${useCase}`);
  return [...system, ...user.map(assertion => `- ${assertion.text}`)];
}

function renderAvoid(
  agentClass: AgentClassDefinition,
  models: EffectiveExecutorModel[],
  assertions: NonNullable<AgentClassDefinition['executorManual']>['assertions'],
): string[] {
  const user = assertions.filter(assertion => (
    assertion.topic === 'limitation' || assertion.topic === 'avoid-task'
  ));
  const system = [
    ...agentClass.avoidUseCases,
    ...models.flatMap(({ model }) => [
      ...(model.routingNotes?.limitations ?? []),
      ...(model.routingNotes?.avoidTaskTypes ?? []),
    ]),
  ]
    .filter(useCase => !hasMatchingAssertion(assertions, useCase, ['limitation', 'avoid-task']))
    .filter(useCase => !hasMatchingAssertion(assertions, useCase, ['strength', 'preferred-task']))
    .map(translateSystemText)
    .filter((useCase, index, useCases) => useCases.indexOf(useCase) === index)
    .map(useCase => `- ${useCase}`);
  return [...system, ...user.map(assertion => `- ${assertion.text}`)];
}

function toTags(lines: readonly string[]): string[] {
  return [...new Set(lines
    .map(line => line.replace(/^- /u, '').trim())
    .filter(Boolean))];
}

function hasMatchingAssertion(
  assertions: NonNullable<AgentClassDefinition['executorManual']>['assertions'],
  generatedTarget: string,
  topics: readonly ExecutorManualAssertionTopic[],
): boolean {
  const normalizedTarget = normalizeTarget(generatedTarget);
  return assertions.some(assertion => (
    topics.includes(assertion.topic)
    && Boolean(assertion.target)
    && normalizeTarget(assertion.target!) === normalizedTarget
  ));
}

function normalizeTarget(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}

function renderDelivery(
  agentClass: AgentClassDefinition,
  assertions: NonNullable<AgentClassDefinition['executorManual']>['assertions'],
  userTopics: ReadonlySet<string>,
): string[] {
  const user = assertions.filter(assertion => assertion.topic === 'delivery');
  if (user.length > 0) return user.map(assertion => `- ${assertion.text}`);
  if (userTopics.has('delivery')) return [];
  return [
    '- `edit`：Subtask 需要修改工作区或生成文件产物时使用。',
    '- `report`：Subtask 只需要交付只读分析或回答时使用。',
    `- Harness：\`${agentClass.harnessRef}\`。`,
    `- Skills：${agentClass.skills.length > 0 ? agentClass.skills.join('、') : '未声明'}。`,
    `- MCP Servers：${agentClass.mcpServers.length > 0 ? agentClass.mcpServers.join('、') : '未声明'}。`,
    `- Plugins：${agentClass.plugins.length > 0 ? agentClass.plugins.join('、') : '未声明'}。`,
  ];
}

function renderDisabledCapabilities(
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
): string[] {
  return capabilities
    .filter(capability => (
      capability.support === 'supported'
      && capability.routingDisposition === 'disabled'
    ))
    .map(capability => (
      `- 已禁用路由：${ROUTING_CAPABILITY_LABELS[capability.capabilityId]}`
    ));
}

function renderAvoidedCapabilities(
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
): string[] {
  return capabilities
    .filter(capability => (
      capability.support === 'supported'
      && capability.routingDisposition === 'avoid'
    ))
    .map(capability => (
      `- 应避免路由：${ROUTING_CAPABILITY_LABELS[capability.capabilityId]}`
    ));
}

function isGeneratedPositiveAllowed(
  value: string,
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
): boolean {
  const restricted = new Set(capabilities.filter(capability => (
    capability.support === 'unsupported'
    || capability.routingDisposition === 'avoid'
    || capability.routingDisposition === 'disabled'
  )).map(capability => capability.capabilityId));
  if (restricted.size === 0) return true;
  return inferredSemanticCapabilities(value).every(capability => !restricted.has(capability));
}

function inferredSemanticCapabilities(value: string): RoutingCapabilityId[] {
  const normalized = normalizeTarget(value);
  return (Object.entries(ROUTING_CAPABILITY_SEMANTIC_PATTERNS) as Array<
    [RoutingCapabilityId, readonly RegExp[]]
  >)
    .filter(([, patterns]) => patterns.some(pattern => pattern.test(normalized)))
    .map(([capability]) => capability);
}

const ROUTING_CAPABILITY_SEMANTIC_PATTERNS: Readonly<
  Record<RoutingCapabilityId, readonly RegExp[]>
> = {
  'current-web-research': [
    /\b(?:browse|public web|research|search|source verification|web)\b/iu,
    /(?:公共网络|来源核验|搜索|检索|研究)/u,
  ],
  'image-editing': [
    /\bimage edit(?:ing)?\b/iu,
    /图片编辑/u,
  ],
  'image-generation': [
    /\bimage generation\b/iu,
    /图片生成/u,
  ],
  'workspace-engineering': [
    /\b(?:code|coding|engineering|implementation|monorepo|refactor|repository|test|typescript)\b/iu,
    /(?:代码|仓库|工程|实现|重构|测试)/u,
  ],
};

function renderUnresolvedCapabilities(
  capabilities: PlannerExecutorCapabilityManual['capabilities'],
): string[] {
  const lines = capabilities
    .filter(capability => capability.support === 'unsupported')
    .flatMap(capability => capability.unresolvedReasons.map(reason => (
      `- ${ROUTING_CAPABILITY_LABELS[capability.capabilityId]}：${reason}`
    )));
  return lines.length > 0 ? lines : ['- 无。'];
}

function isSupportedUseCase(
  useCase: string,
  routingCapabilities: readonly RoutingCapabilityId[],
): boolean {
  return inferredSemanticCapabilities(useCase)
    .every(capability => routingCapabilities.includes(capability));
}

function translateSystemText(value: string): string {
  return SYSTEM_TEXT_TRANSLATIONS[normalizeTarget(value)] ?? value;
}

function translateTier(value: string | undefined): string {
  if (!value) return '未指定';
  return {
    disabled: '关闭',
    low: '低',
    medium: '中',
    high: '高',
  }[value] ?? value;
}

function intersectCapabilities(
  capabilityLists: readonly ModelCapability[][],
): ModelCapability[] {
  if (capabilityLists.length === 0) return [];
  const [first, ...rest] = capabilityLists;
  return [...new Set(first)]
    .filter(capability => rest.every(list => list.includes(capability)))
    .sort();
}
