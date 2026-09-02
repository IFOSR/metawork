import { describe, expect, it } from 'vitest';
import type {
  AgentClassDefinition,
  ModelProfile,
} from '../../src/configuration/types.js';
import {
  buildExecutorCapabilityManual,
  type ExecutorManualUserProfile,
} from '../../src/routing/executor-capability-manual.js';

function executor(
  modelPolicy: AgentClassDefinition['modelPolicy'],
  userProfile?: ExecutorManualUserProfile,
): AgentClassDefinition {
  return {
    kind: 'executor',
    harnessRef: 'codex',
    modelPolicy,
    permissionProfileRef: 'workspace-default',
    routingCapabilities: ['workspace-engineering'],
    primaryUseCases: ['repository implementation'],
    avoidUseCases: ['current public-web research'],
    plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
    skills: [],
    mcpServers: [],
    plugins: [],
    generatedRuntimeRef: 'codex',
    enabled: true,
    ...(userProfile ? { executorManual: userProfile } : {}),
  };
}

function model(
  capabilities: ModelProfile['capabilities'],
  overrides: Partial<ModelProfile> = {},
): ModelProfile {
  return {
    providerRef: 'openai',
    modelId: 'model-id',
    capabilities,
    reasoning: 'high',
    enabled: true,
    ...overrides,
  };
}

describe('Executor capability manuals', () => {
  it('uses Chinese system prose and Chinese derived tags', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor({ mode: 'fixed', modelRef: 'engineering' }),
      models: {
        engineering: model(['coding', 'tools'], {
          modelId: 'gpt-5.6-sol',
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'codex-cli' },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('# Executor：codex-engineering');
    expect(result.markdown).toContain('## 核心定位');
    expect(result.markdown).toContain('## 稳定能力');
    expect(result.markdown).toContain('## 模型配置');
    expect(result.markdown).toContain('## 适合任务');
    expect(result.markdown).toContain('## 不适合或应交接');
    expect(result.markdown).toContain('此能力由模型 `engineering` 提供');
    expect(result.tags.bestFit).toContain('代码仓库实现');
    expect(result.tags.avoid).toContain('当前公共网络研究');
  });

  it('removes image strengths when the image model leaves an Auto policy', () => {
    const agentClass = {
      ...executor({
        mode: 'auto',
        allowedModelRefs: ['engineering'],
        defaultModelRef: 'engineering',
      }),
      primaryUseCases: [
        'repository implementation',
        'image generation',
        'image editing',
      ],
    };
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'pi-agent',
      agentClass,
      models: {
        engineering: model(['coding', 'tools'], {
          modelId: 'gpt-5.6-sol',
        }),
        image: model(['image-generation', 'image-editing'], {
          modelId: 'gpt-image-2',
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).not.toContain('图片生成');
    expect(result.markdown).not.toContain('图片编辑');
    expect(result.tags.bestFit).not.toContain('图片生成');
    expect(result.tags.bestFit).not.toContain('图片编辑');
  });

  it('removes localized image use cases when the image model leaves an Auto policy', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'pi-agent',
      agentClass: {
        ...executor({
          mode: 'auto',
          allowedModelRefs: ['engineering'],
          defaultModelRef: 'engineering',
        }),
        primaryUseCases: ['代码仓库实现', '图片生成', '图片编辑'],
      },
      models: {
        engineering: model(['coding', 'tools'], {
          modelId: 'gpt-5.6-sol',
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).not.toContain('- 图片生成');
    expect(result.markdown).not.toContain('- 图片编辑');
    expect(result.tags.bestFit).not.toContain('图片生成');
    expect(result.tags.bestFit).not.toContain('图片编辑');
  });

  it('deduplicates system use cases after Chinese localization', () => {
    const agentClass = {
      ...executor({
        mode: 'auto',
        allowedModelRefs: ['engineering', 'image'],
        defaultModelRef: 'engineering',
      }),
      primaryUseCases: [
        'repository implementation',
        'image generation',
        'image editing',
      ],
    };
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass,
      models: {
        engineering: model(['coding', 'tools'], {
          modelId: 'gpt-5.6-sol',
        }),
        image: model(['image-generation', 'image-editing'], {
          modelId: 'gpt-image-2',
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'codex-cli' },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown.match(/^- 图片生成$/gmu)).toHaveLength(1);
    expect(result.markdown.match(/^- 图片编辑$/gmu)).toHaveLength(1);
    expect(result.tags.bestFit.filter(tag => tag === '图片生成')).toHaveLength(1);
    expect(result.tags.bestFit.filter(tag => tag === '图片编辑')).toHaveLength(1);
  });

  it('generates an independent manual with model-attributed capabilities', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor({ mode: 'fixed', modelRef: 'engineering' }),
      models: {
        engineering: model(['coding', 'tools'], {
          modelId: 'gpt-5.6-sol',
          qualityTier: 'high',
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.agentClassRef).toBe('codex-engineering');
    expect(result.markdown).toContain('# Executor：codex-engineering');
    expect(result.markdown).toContain('gpt-5.6-sol');
    expect(result.markdown).toContain('代码理解与实现');
    expect(result.markdown).toContain('此能力由模型 `engineering` 提供');
    expect(result.markdown).toContain('代码仓库实现');
    expect(result.sourceFingerprint).toMatch(/^sha256:/u);
    expect(result.tags.bestFit).toContain('代码仓库实现');
    expect(result.tags.avoid).toContain('当前公共网络研究');
  });

  it('distinguishes common and model-specific capabilities for Auto models', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'auto-engineering',
      agentClass: executor({
        mode: 'auto',
        allowedModelRefs: ['coding-model', 'vision-model'],
        defaultModelRef: 'coding-model',
        fallback: { enabled: true, order: ['vision-model'] },
      }),
      models: {
        'coding-model': model(['coding', 'tools'], { modelId: 'coder' }),
        'vision-model': model(['tools', 'vision'], { modelId: 'vision' }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('所有候选模型共同具备的能力');
    expect(result.markdown).toContain('工具调用');
    expect(result.markdown).not.toContain('所有候选模型共同具备的能力：\n- 代码理解与实现');
    expect(result.markdown).toContain('代码理解与实现');
    expect(result.markdown).toContain('模型 `coding-model`');
    expect(result.markdown).toContain('视觉理解');
    expect(result.markdown).toContain('模型 `vision-model`');
    expect(result.markdown).toContain('默认模型：`coding-model`');
    expect(result.markdown).toContain('回退顺序：`vision-model`');
  });

  it('lets user guidance replace conflicting generated routing prose', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          sourceText: '不要用于代码实现，优先做团队文档分析。',
          assertions: [
            {
              topic: 'avoid-task',
              text: '不要用于代码实现，优先做团队文档分析。',
              target: 'repository implementation',
            },
          ],
        },
      ),
      models: {
        engineering: model(['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('不要用于代码实现，优先做团队文档分析。');
    expect(result.markdown).not.toContain('- 代码仓库实现');
    expect(result.markdown).toContain('用户定义与系统生成内容冲突时，以用户定义为准');
  });

  it('removes workspace best-fit tags when workspace routing is disabled', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          sourceText: '不要承担工作区工程任务。',
          assertions: [{
            topic: 'capability-policy',
            text: '禁止承担工作区工程任务。',
            routingCapability: 'workspace-engineering',
            disposition: 'disabled',
          }],
        },
      ),
      models: {
        engineering: model(['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.routableCapabilities).not.toContain('workspace-engineering');
    expect(result.tags.bestFit).not.toContain('代码仓库实现');
  });

  it('keeps unrelated generated routing guidance when one user topic is overridden', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          sourceText: '更适合团队文档分析，不做视觉设计。',
          assertions: [
            { topic: 'preferred-task', text: '团队文档分析。' },
            { topic: 'avoid-task', text: '视觉设计。' },
          ],
        },
      ),
      models: {
        engineering: model(['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('团队文档分析。');
    expect(result.markdown).toContain('视觉设计。');
    expect(result.markdown).toContain('代码仓库实现');
    expect(result.markdown).toContain('路由能力：工作区工程');
  });

  it('renders user model contributions in the model-specific section', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          sourceText: 'engineering 模型负责复杂重构。',
          assertions: [{
            topic: 'model-contribution',
            text: 'engineering 模型负责复杂重构并修复测试。',
            modelRef: 'engineering',
            modelCapability: 'coding',
          }],
        },
      ),
      models: {
        engineering: model(['coding', 'tools'], {
          routingNotes: {
            preferredTaskTypes: ['大型代码重构'],
            avoidTaskTypes: ['视觉设计'],
          },
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('用户定义的模型贡献：engineering 模型负责复杂重构并修复测试。');
    expect(result.markdown).toContain('优先任务类型：大型代码重构');
    expect(result.markdown).toContain('应避免的任务类型：视觉设计');
    expect(result.tags.bestFit).toContain('大型代码重构');
    expect(result.tags.avoid).toContain('视觉设计');
  });

  it('renders the declared model capability for a user model contribution', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          sourceText: 'engineering 模型负责复杂重构。',
          assertions: [{
            topic: 'model-contribution',
            text: '负责复杂重构。',
            modelRef: 'engineering',
            modelCapability: 'coding',
          }],
        },
      ),
      models: {
        engineering: model(['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('对应代码理解与实现能力');
  });

  it('removes ambiguous generated strengths when a routing capability is disabled', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: {
        ...executor(
          { mode: 'fixed', modelRef: 'engineering' },
          {
            sourceText: '不要承担任何工作区工程任务。',
            assertions: [{
              topic: 'capability-policy',
              text: '禁止承担工作区工程任务。',
              routingCapability: 'workspace-engineering',
              disposition: 'disabled',
            }],
          },
        ),
        primaryUseCases: ['TypeScript 重构'],
      },
      models: {
        engineering: model(['coding', 'tools'], {
          routingNotes: {
            summary: '适合复杂工程任务。',
            strengths: ['大型代码重构'],
            preferredTaskTypes: ['TypeScript 重构'],
          },
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'codex-cli' },
      configurationRevision: 'revision-disabled',
    });

    expect(result.markdown).not.toContain('适合复杂工程任务。');
    expect(result.markdown).not.toContain('大型代码重构');
    expect(result.markdown).not.toContain('- TypeScript 重构');
    expect(result.tags.bestFit).not.toContain('TypeScript 重构');
    expect(result.tags.bestFit).not.toContain('大型代码重构');
    expect(result.tags.avoid).toContain('已禁用路由：工作区工程');
  });

  it('keeps unrelated engineering strengths when only image generation is disabled', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: {
        ...executor(
          {
            mode: 'auto',
            allowedModelRefs: ['engineering', 'image'],
            defaultModelRef: 'engineering',
          },
          {
            sourceText: '不要承担图片生成任务。',
            assertions: [{
              topic: 'capability-policy',
              text: '禁止承担图片生成任务。',
              routingCapability: 'image-generation',
              disposition: 'disabled',
            }],
          },
        ),
        primaryUseCases: ['TypeScript 重构', 'image generation'],
      },
      models: {
        engineering: model(['coding', 'tools'], {
          routingNotes: {
            summary: '适合复杂工程任务。',
            strengths: ['大型代码重构'],
            preferredTaskTypes: ['TypeScript 重构'],
          },
        }),
        image: model(['image-generation', 'image-editing'], {
          modelId: 'gpt-image-2',
        }),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'codex-cli' },
      configurationRevision: 'revision-image-disabled',
    });

    expect(result.markdown).toContain('适合复杂工程任务。');
    expect(result.markdown).toContain('大型代码重构');
    expect(result.tags.bestFit).toContain('TypeScript 重构');
    expect(result.tags.bestFit).not.toContain('图片生成');
  });

  it('does not mix user guidance or model facts between Executor manuals', () => {
    const first = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          sourceText: '只做代码重构。',
          assertions: [{ topic: 'preferred-task', text: '只做代码重构。' }],
        },
      ),
      models: { engineering: model(['coding'], { modelId: 'coder' }) },
      providers: { openai: { enabled: true, region: 'international' } },
      configurationRevision: 'revision-1',
    });
    const second = buildExecutorCapabilityManual({
      agentClassRef: 'pi-research',
      agentClass: {
        ...executor({ mode: 'fixed', modelRef: 'research' }),
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['research'],
        avoidUseCases: ['repository implementation'],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
      },
      models: { research: model(['tools'], { modelId: 'researcher' }) },
      providers: { openai: { enabled: true, region: 'international' } },
      configurationRevision: 'revision-1',
    });

    expect(first.markdown).toContain('只做代码重构。');
    expect(first.markdown).not.toContain('researcher');
    expect(second.markdown).toContain('researcher');
    expect(second.markdown).not.toContain('只做代码重构。');
  });

  it('changes its source fingerprint when a referenced Provider becomes unavailable', () => {
    const input = {
      agentClassRef: 'codex-engineering',
      agentClass: executor({ mode: 'fixed', modelRef: 'engineering' }),
      models: {
        engineering: model(['coding'], { modelId: 'coder' }),
      },
      configurationRevision: 'revision-1',
    } as const;

    const enabled = buildExecutorCapabilityManual({
      ...input,
      providers: {
        openai: { enabled: true, region: 'international' },
      },
    });
    const disabled = buildExecutorCapabilityManual({
      ...input,
      providers: {
        openai: { enabled: false, region: 'international' },
      },
    });

    expect(disabled.sourceFingerprint).not.toBe(enabled.sourceFingerprint);
    expect(disabled.markdown).toContain('当前没有可用模型。');
  });

  it('keeps unnormalized user text in the coherent manual without a separate user section', () => {
    const result = buildExecutorCapabilityManual({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        { sourceText: '优先处理大型 TypeScript 重构。', assertions: [] },
      ),
      models: { engineering: model(['coding', 'tools']) },
      providers: { openai: { enabled: true, region: 'international' } },
      configurationRevision: 'revision-1',
    });

    expect(result.markdown).toContain('优先处理大型 TypeScript 重构。');
    expect(result.markdown).not.toContain('## User Guidance');
  });
});
