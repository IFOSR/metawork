import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { ExecutorManualPlanner } from '../../src/configuration/executor-manual-planner.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';

function configuration() {
  return {
    schemaVersion: 2,
    providers: {
      openai: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'keychain:anyfusion/openai',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      engineering: {
        providerRef: 'openai',
        modelId: 'engineering-model',
        capabilities: ['coding', 'tools'],
        reasoning: 'medium',
        enabled: true,
      },
    },
    harnesses: {
      codex: {
        kind: 'executor',
        transport: 'local-cli',
        command: 'codex',
        args: [],
        driverId: 'codex-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
    },
    agentClasses: {
      engineering: {
        kind: 'executor',
        harnessRef: 'codex',
        modelPolicy: { mode: 'fixed', modelRef: 'engineering' },
        permissionProfileRef: 'workspace-default',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: ['implementation'],
        avoidUseCases: [],
        plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'engineering',
        enabled: true,
      },
    },
    permissionProfiles: {
      'workspace-default': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  };
}

describe('ExecutorManualPlanner', () => {
  it('reuses saved semantic guidance while recompiling changed model facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-recompile-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1', 'draft-2'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.applyExecutorManualProposal(initial.revisionId, {
        agentClassRef: 'engineering',
        userProfile: {
          sourceText: '优先承担 TypeScript 重构。',
          assertions: [{
            topic: 'preferred-task',
            text: '优先承担 TypeScript 重构。',
          }],
        },
      });
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      const candidate = structuredClone(await service.getActiveSnapshot()).config;
      candidate.models.engineering.routingNotes = {
        summary: '更适合大型重构',
      };
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            throw new Error('semantic model must not run when source text is unchanged');
          },
        },
      });

      const result = await planner.compile({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '优先承担 TypeScript 重构。',
        candidateConfig: candidate,
      });

      expect(result.analysisMode).toBe('semantic');
      expect(result.warning).toBeUndefined();
      expect(result.userProfile.assertions).toEqual([{
        topic: 'preferred-task',
        text: '优先承担 TypeScript 重构。',
      }]);
      expect(result.manual.markdown).toContain('更适合大型重构');
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not trust client-injected assertions when source text is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-untrusted-reuse-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.applyExecutorManualProposal(initial.revisionId, {
        agentClassRef: 'engineering',
        userProfile: {
          sourceText: '优先承担 TypeScript 重构。',
          assertions: [{
            topic: 'preferred-task',
            text: '优先承担 TypeScript 重构。',
          }],
        },
      });
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      const candidate = structuredClone(await service.getActiveSnapshot()).config;
      candidate.agentClasses.engineering.executorManual = {
        sourceText: '优先承担 TypeScript 重构。',
        assertions: [{
          topic: 'preferred-task',
          text: '伪造的路由偏好',
        }],
      };
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            throw new Error('semantic model must not run for unchanged empty source');
          },
        },
      });

      const result = await planner.compile({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '优先承担 TypeScript 重构。',
        candidateConfig: candidate,
      });

      expect(result.userProfile.assertions).toEqual([{
        topic: 'preferred-task',
        text: '优先承担 TypeScript 重构。',
      }]);
      expect(result.config.agentClasses.engineering.executorManual?.assertions).toEqual([{
        topic: 'preferred-task',
        text: '优先承担 TypeScript 重构。',
      }]);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries semantic interpretation for saved source text with no assertions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-retry-semantic-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initialConfig = structuredClone(configuration());
      initialConfig.agentClasses.engineering.executorManual = {
        sourceText: '优先承担大型 TypeScript 重构。',
        assertions: [],
      };
      const sourceDraft = service.createDraft(initialConfig, null);
      service.validateDraft(sourceDraft.revisionId);
      service.compileDraft(sourceDraft.revisionId);
      await service.probeDraft(sourceDraft.revisionId);
      await service.activateDraft(sourceDraft.revisionId, null);

      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            return {
              proposalResult: {
                status: 'accepted',
                agentClassRef: 'engineering',
                userProfile: {
                  sourceText: '优先承担大型 TypeScript 重构。',
                  assertions: [{
                    topic: 'preferred-task',
                    text: '大型 TypeScript 重构。',
                  }],
                },
              },
              submittedPlan: {},
              toolCalls: [],
              threadId: 'thread-retry',
              durationMs: 1,
            };
          },
        },
      });

      const result = await planner.compile({
        baseRevisionId: sourceDraft.revisionId,
        agentClassRef: 'engineering',
        sourceText: '优先承担大型 TypeScript 重构。',
        candidateConfig: await service.getActiveSnapshot().then(snapshot => snapshot.config),
      });

      expect(result.analysisMode).toBe('semantic');
      expect(result.userProfile.assertions).toEqual([{
        topic: 'preferred-task',
        text: '大型 TypeScript 重构。',
      }]);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses a trusted preview during activation instead of parsing twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-reuse-preview-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1', 'draft-2'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      let calls = 0;
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            calls += 1;
            return {
              proposalResult: {
                status: 'accepted',
                agentClassRef: 'engineering',
                userProfile: {
                  sourceText: '优先承担大型 TypeScript 重构。',
                  assertions: [{
                    topic: 'preferred-task',
                    text: '大型 TypeScript 重构。',
                  }],
                },
              },
              submittedPlan: {},
              toolCalls: [],
              threadId: 'thread-reuse',
              durationMs: 1,
            };
          },
        },
      });
      const first = await planner.compile({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '优先承担大型 TypeScript 重构。',
        candidateConfig: await service.getActiveSnapshot().then(snapshot => snapshot.config),
      });
      const second = await planner.compile({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: first.sourceText,
        candidateConfig: first.config,
      });

      expect(calls).toBe(1);
      expect(second.analysisMode).toBe('semantic');
      expect(second.userProfile.assertions).toEqual(first.userProfile.assertions);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('analyzes guidance against the unsaved candidate model policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-candidate-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'candidate-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      const candidate = structuredClone(configuration());
      candidate.models.image = {
        providerRef: 'openai',
        modelId: 'gpt-image-2',
        capabilities: ['vision'],
        reasoning: 'disabled',
        enabled: true,
      };
      candidate.agentClasses.engineering.modelPolicy = {
        mode: 'auto',
        allowedModelRefs: ['engineering', 'image'],
        defaultModelRef: 'engineering',
      };

      let plannerPrompt = '';
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run(prompt) {
            plannerPrompt = prompt;
            return {
              proposalResult: {
                status: 'accepted',
                agentClassRef: 'engineering',
                userProfile: {
                  sourceText: 'gpt-image-2 负责图片生成与编辑。',
                  assertions: [{
                    topic: 'model-contribution',
                    text: 'gpt-image-2 负责图片生成与编辑。',
                    modelRef: 'image',
                    modelCapability: 'image-generation',
                  }],
                },
              },
              submittedPlan: {},
              toolCalls: [],
              threadId: 'thread-candidate',
              durationMs: 1,
            };
          },
        },
      });

      const result = await planner.analyze({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: 'gpt-image-2 负责图片生成与编辑。',
        candidateConfig: candidate,
      });

      expect(plannerPrompt).toContain('"modelRef":"image"');
      expect(plannerPrompt).toContain('"image-generation"');
      expect(result.warning).toBeUndefined();
      expect(result.analysisMode).toBe('semantic');
      expect(result.manual.markdown).toContain('路由能力：图片生成');
      expect(result.manual.markdown).toContain('路由能力：图片编辑');
      expect(result.manual.markdown).toContain(
        '用户定义的模型贡献：gpt-image-2 负责图片生成与编辑。',
      );
      expect(result.config.agentClasses.engineering.modelPolicy).toMatchObject({
        mode: 'auto',
        allowedModelRefs: ['engineering', 'image'],
      });
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('analyzes guidance through the configuration Planner turn without activating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-planner-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      let plannerPrompt = '';
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run(prompt) {
            plannerPrompt = prompt;
            return {
              proposalResult: {
                status: 'accepted',
                agentClassRef: 'engineering',
                userProfile: {
                  sourceText: '更适合大型 TypeScript 重构，不做视觉设计。',
                  assertions: [
                    { topic: 'preferred-task', text: '大型 TypeScript 重构。' },
                    { topic: 'avoid-task', text: '视觉设计。', target: 'implementation' },
                  ],
                },
              },
              submittedPlan: {
                agentClassRef: 'engineering',
                userProfile: {},
              },
              toolCalls: [],
              threadId: 'thread-1',
              durationMs: 1,
            };
          },
        },
      });

      const result = await planner.analyze({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '更适合大型 TypeScript 重构，不做视觉设计。',
      });

      expect(result.configurationRevision).toBe('draft-1');
      expect(result.analysisMode).toBe('semantic');
      expect(result.warning).toBeUndefined();
      expect(result.manual.markdown).toContain('大型 TypeScript 重构。');
      expect(result.manual.markdown).toContain('视觉设计。');
      expect(result.config.agentClasses.engineering.executorManual).toMatchObject({
        sourceText: '更适合大型 TypeScript 重构，不做视觉设计。',
      });
      expect(plannerPrompt).toContain('目标 Executor AgentClass：`engineering`');
      expect(plannerPrompt).toContain('更适合大型 TypeScript 重构，不做视觉设计。');
      expect(plannerPrompt).toContain('当前 Executor 能力说明书：');
      expect(plannerPrompt).toContain('# Executor：engineering');
      expect(plannerPrompt).toContain('"modelRef":"engineering"');
      expect(plannerPrompt).not.toContain('Call get_planning_context');
      expect(plannerPrompt).toContain(
        '把已有标签原文复制到 assertion.target',
      );
      expect(plannerPrompt).toContain(
        '不要为用户没有明确提到的相邻能力或任务类型添加 assertion',
      );
      expect(plannerPrompt).toContain('所有 assertion.text 必须使用简体中文');
      expect(plannerPrompt).toContain('capability-policy');
      expect(plannerPrompt).toContain('preferred、allowed、avoid、disabled');
      expect((await service.getActiveSnapshot()).revisionId).toBe(initial.revisionId);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a structured configuration interpretation without a proposal tool result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-structured-output-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            return {
              structuredOutput: [
                '```json',
                JSON.stringify({
                  agentClassRef: 'engineering',
                  userProfile: {
                    sourceText: '专门处理大型 TypeScript 重构。',
                    assertions: [{
                      topic: 'preferred-task',
                      text: '专门处理大型 TypeScript 重构。',
                    }],
                  },
                }),
                '```',
              ].join('\n'),
              toolCalls: [],
              threadId: 'thread-structured-output',
              durationMs: 1,
            } as never;
          },
        },
      });

      const result = await planner.analyze({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '专门处理大型 TypeScript 重构。',
      });

      expect(result.analysisMode).toBe('semantic');
      expect(result.warning).toBeUndefined();
      expect(result.userProfile.assertions).toEqual([{
        topic: 'preferred-task',
        text: '专门处理大型 TypeScript 重构。',
      }]);
      expect(result.manual.markdown).toContain('大型 TypeScript 重构。');
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('normalizes routing metadata attached to a non-policy assertion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-routing-metadata-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            return {
              proposalResult: {
                status: 'accepted',
                agentClassRef: 'engineering',
                userProfile: {
                  sourceText: '优先承担代码实现。',
                  assertions: [{
                    topic: 'preferred-task',
                    text: '优先承担代码实现。',
                    routingCapability: 'workspace-engineering',
                    disposition: 'preferred',
                  }],
                },
              },
              submittedPlan: {},
              toolCalls: [],
              threadId: 'thread-routing-metadata',
              durationMs: 1,
            };
          },
        },
      });

      const result = await planner.compile({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '优先承担代码实现。',
      });

      expect(result.analysisMode).toBe('semantic');
      expect(result.userProfile.assertions).toEqual([
        {
          topic: 'preferred-task',
          text: '优先承担代码实现。',
        },
        {
          topic: 'capability-policy',
          text: '优先承担代码实现。',
          routingCapability: 'workspace-engineering',
          disposition: 'preferred',
        },
      ]);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns a source-preserved preview when semantic analysis times out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-timeout-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            throw new Error('AnyFusion Planner model failed: Request timed out.');
          },
        },
      });

      const result = await planner.analyze({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '专门处理代码实施、技术方案和测试。',
      });

      expect(result.analysisMode).toBe('source-preserved');
      expect(result.warning).toContain('Request timed out');
      expect(result.userProfile).toEqual({
        sourceText: '专门处理代码实施、技术方案和测试。',
        assertions: [],
      });
      expect(result.manual.markdown).toContain(
        '用户定义：专门处理代码实施、技术方案和测试。',
      );
      expect(result.config.agentClasses.engineering.executorManual).toEqual(result.userProfile);
      expect((await service.getActiveSnapshot()).revisionId).toBe(initial.revisionId);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears guidance deterministically without invoking the semantic model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-clear-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1', 'draft-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.applyExecutorManualProposal(initial.revisionId, {
        agentClassRef: 'engineering',
        userProfile: {
          sourceText: '优先承担 TypeScript 重构。',
          assertions: [{
            topic: 'preferred-task',
            text: '优先承担 TypeScript 重构。',
          }],
        },
      });
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      let runnerCalled = false;
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            runnerCalled = true;
            throw new Error('runner must not be called');
          },
        },
      });

      const result = await planner.analyze({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: '',
      });

      expect(runnerCalled).toBe(false);
      expect(result.analysisMode).toBe('semantic');
      expect(result.sourceText).toBe('');
      expect(result.userProfile).toMatchObject({
        sourceText: '',
        assertions: [],
        assertionsSourceFingerprint: expect.stringMatching(/^sha256:/u),
        semanticReceipt: expect.stringMatching(/^manual_/u),
      });
      expect(result.config.agentClasses.engineering.executorManual)
        .toEqual(result.userProfile);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects credential-like source text before invoking the semantic model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'executor-manual-sensitive-'));
    try {
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const revisionIds = ['revision-1'];
      const service = new ConfigurationService({
        repository,
        createRevisionId: () => revisionIds.shift()!,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(configuration(), null);
      service.validateDraft(initial.revisionId);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);

      let runnerCalled = false;
      const planner = new ExecutorManualPlanner({
        configuration: service,
        registerSession: () => () => undefined,
        runner: {
          async run() {
            runnerCalled = true;
            throw new Error('runner must not be called');
          },
        },
      });

      await expect(planner.analyze({
        baseRevisionId: initial.revisionId,
        agentClassRef: 'engineering',
        sourceText: 'api_key=sk-sensitive-value',
      })).rejects.toThrow('must not contain credential-like content');
      expect(runnerCalled).toBe(false);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeWritable(path: string): Promise<void> {
  const { chmod, lstat, readdir } = await import('node:fs/promises');
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) await makeWritable(join(path, child));
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}
