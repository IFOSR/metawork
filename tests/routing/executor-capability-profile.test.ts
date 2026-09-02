import { describe, expect, it } from 'vitest';
import type {
  AgentClassDefinition,
  ModelProfile,
} from '../../src/configuration/types.js';
import {
  compileExecutorCapabilityProfile,
} from '../../src/routing/executor-capability-profile.js';

function executor(
  modelPolicy: AgentClassDefinition['modelPolicy'],
  overrides: Partial<AgentClassDefinition> = {},
): AgentClassDefinition {
  return {
    kind: 'executor',
    harnessRef: 'pi-cli',
    modelPolicy,
    permissionProfileRef: 'workspace-default',
    routingCapabilities: ['workspace-engineering'],
    primaryUseCases: ['repository implementation'],
    avoidUseCases: [],
    plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
    skills: [],
    mcpServers: [],
    plugins: [],
    generatedRuntimeRef: 'pi-agent',
    enabled: true,
    ...overrides,
  };
}

function model(
  modelId: string,
  capabilities: ModelProfile['capabilities'],
): ModelProfile {
  return {
    providerRef: 'openai',
    modelId,
    capabilities,
    reasoning: 'medium',
    enabled: true,
  };
}

describe('Executor capability profile', () => {
  it('compiles model-backed image capabilities and evidence into one routable profile', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'pi-agent',
      agentClass: executor({
        mode: 'auto',
        allowedModelRefs: ['engineering', 'image'],
        defaultModelRef: 'engineering',
      }),
      models: {
        engineering: model('gpt-5.6-sol', ['coding', 'tools']),
        image: model('gpt-image-2', ['vision']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'pi-cli' },
      configurationRevision: 'revision-1',
    });

    expect(profile.routableCapabilities).toEqual([
      'image-editing',
      'image-generation',
      'workspace-engineering',
    ]);
    expect(profile.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capabilityId: 'image-generation',
        support: 'supported',
        routingDisposition: 'allowed',
        evidence: expect.arrayContaining([
          expect.objectContaining({
            kind: 'model-system-known',
            modelRef: 'image',
          }),
          expect.objectContaining({
            kind: 'harness-support',
            detail: expect.stringContaining('workspace-image-artifact-v1'),
          }),
        ]),
      }),
    ]));
    expect(profile.manual.sourceFingerprint).toBe(profile.sourceFingerprint);
  });

  it('keeps a user image intent visible but non-routable after the supporting model is removed', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'pi-agent',
      agentClass: executor(
        {
          mode: 'fixed',
          modelRef: 'engineering',
        },
        {
          executorManual: {
            sourceText: 'pi-agent 负责图片生成。',
            assertions: [{
              topic: 'capability-policy',
              text: '优先承担图片生成任务。',
              routingCapability: 'image-generation',
              disposition: 'preferred',
            }],
          },
        },
      ),
      models: {
        engineering: model('gpt-5.6-sol', ['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-2',
    });

    expect(profile.routableCapabilities).not.toContain('image-generation');
    expect(profile.capabilities).toContainEqual(expect.objectContaining({
      capabilityId: 'image-generation',
      support: 'unsupported',
      routingDisposition: 'preferred',
      unresolvedReasons: expect.arrayContaining([
        expect.stringContaining('没有可用模型'),
      ]),
    }));
    expect(profile.manual.markdown).toContain('## 当前未满足');
    expect(profile.manual.markdown).toContain('图片生成');
  });

  it('removes an explicitly disabled capability from the routable projection', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'codex-engineering',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          executorManual: {
            sourceText: '不要把工作区工程任务交给这个 Executor。',
            assertions: [{
              topic: 'capability-policy',
              text: '禁止承担工作区工程任务。',
              routingCapability: 'workspace-engineering',
              disposition: 'disabled',
            }],
          },
        },
      ),
      models: {
        engineering: model('gpt-5.6-sol', ['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-3',
    });

    expect(profile.routableCapabilities).not.toContain('workspace-engineering');
    expect(profile.capabilities).toContainEqual(expect.objectContaining({
      capabilityId: 'workspace-engineering',
      support: 'supported',
      routingDisposition: 'disabled',
    }));
    expect(profile.manual.markdown).toContain('已禁用路由');
  });

  it('accepts a user-confirmed registered capability for an allowed custom model', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'pi-agent',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'custom-image' },
        {
          executorManual: {
            sourceText: 'custom-image 支持图片生成。',
            assertions: [{
              topic: 'model-contribution',
              text: 'custom-image 支持图片生成。',
              modelRef: 'custom-image',
              modelCapability: 'image-generation',
            }],
          },
        },
      ),
      models: {
        'custom-image': model('custom-image-v2', ['vision']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'pi-cli' },
      configurationRevision: 'revision-4',
    });

    expect(profile.routableCapabilities).toContain('image-generation');
    expect(profile.modelCapabilities['custom-image']).toContain('image-generation');
    expect(profile.capabilities).toContainEqual(expect.objectContaining({
      capabilityId: 'image-generation',
      support: 'supported',
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: 'model-user-confirmed',
          modelRef: 'custom-image',
        }),
      ]),
    }));
    expect(profile.manual.markdown).toContain('用户确认');
  });

  it('keeps a removed model contribution as unresolved intent', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'pi-agent',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          executorManual: {
            sourceText: 'custom-image 负责图片生成。',
            assertions: [{
              topic: 'model-contribution',
              text: 'custom-image 负责图片生成。',
              modelRef: 'custom-image',
              modelCapability: 'image-generation',
            }],
          },
        },
      ),
      models: {
        engineering: model('gpt-5.6-sol', ['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      configurationRevision: 'revision-5',
    });

    expect(profile.routableCapabilities).not.toContain('image-generation');
    expect(profile.capabilities).toContainEqual(expect.objectContaining({
      capabilityId: 'image-generation',
      support: 'unsupported',
    }));
  });

  it('requires a code-declared Harness driver for image execution', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'custom-executor',
      agentClass: {
        ...executor({ mode: 'fixed', modelRef: 'image' }),
        harnessRef: 'custom-container',
      },
      models: {
        image: model('gpt-image-2', ['vision']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'container-cli' },
      configurationRevision: 'revision-6',
    });

    expect(profile.routableCapabilities).not.toContain('image-generation');
    expect(profile.capabilities).toContainEqual(expect.objectContaining({
      capabilityId: 'image-generation',
      unresolvedReasons: expect.arrayContaining([
        expect.stringContaining('Harness'),
      ]),
    }));
  });

  it('does not infer Harness support from a Harness reference name', () => {
    const profile = compileExecutorCapabilityProfile({
      agentClassRef: 'custom-executor',
      agentClass: {
        ...executor({ mode: 'fixed', modelRef: 'image' }),
        harnessRef: 'codex-compatible-container',
      },
      models: {
        image: model('gpt-image-2', ['vision']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'container-cli' },
      configurationRevision: 'revision-7',
    });

    expect(profile.routableCapabilities).not.toContain('image-generation');
  });

  it('keeps the profile fingerprint stable across equivalent semantic receipts', () => {
    const build = (semanticReceipt: string) => compileExecutorCapabilityProfile({
      agentClassRef: 'pi-agent',
      agentClass: executor(
        { mode: 'fixed', modelRef: 'engineering' },
        {
          executorManual: {
            sourceText: '优先承担代码重构。',
            assertionsSourceFingerprint:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            semanticReceipt,
            assertions: [{
              topic: 'preferred-task',
              text: '优先承担代码重构。',
            }],
          },
        },
      ),
      models: {
        engineering: model('gpt-5.6-sol', ['coding', 'tools']),
      },
      providers: {
        openai: { enabled: true, region: 'international' },
      },
      harness: { driverId: 'pi-cli' },
      configurationRevision: 'revision-stable',
    });

    expect(build('manual_11111111-1111-1111-1111-111111111111').sourceFingerprint)
      .toBe(build('manual_22222222-2222-2222-2222-222222222222').sourceFingerprint);
  });
});
