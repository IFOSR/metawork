import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { ExecutorManualPreviewService } from '../../src/configuration/executor-manual-preview-service.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { ConfigurationRuntimeCoordinator } from '../../src/configuration/configuration-runtime-coordinator.js';
import { ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';

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


async function withConfiguration(run: (service: ConfigurationService, preview: ExecutorManualPreviewService) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'executor-manual-preview-'));
  try {
    const service = new ConfigurationService({
      repository: new FileConfigurationRepository(join(root, 'config')),
      probe: async () => ({ ok: true }),
    });
    await service.initialize();
    const draft = service.createDraft(configuration(), null);
    expect(service.validateDraft(draft.revisionId).ok).toBe(true);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);
    await service.activateDraft(draft.revisionId, null);
    await run(service, new ExecutorManualPreviewService(service));
  } finally { await makeWritable(root); await rm(root, { recursive: true, force: true }); }
}

async function activate(service: ConfigurationService, config: unknown, baseRevisionId: string) {
  const draft = service.createDraft(config, baseRevisionId);
  expect(service.validateDraft(draft.revisionId).ok).toBe(true);
  service.compileDraft(draft.revisionId);
  await service.probeDraft(draft.revisionId);
  return service.activateDraft(draft.revisionId, baseRevisionId);
}

describe('Settings activation and previews without a Planner', () => {
  it('previews natural-language duties without an LLM, preserving text and execution authority', async () => {
    await withConfiguration(async (service, preview) => {
      const base = await service.getActiveSnapshot();
      const text = '负责跨文件代码重构和回归测试。交付修改、测试结果；不部署生产环境。';
      const result = await preview.compile({ baseRevisionId: base.revisionId, agentClassRef: 'engineering', sourceText: text });
      expect(result.analysisMode).toBe('source-preserved');
      expect(result.userProfile).toEqual({ sourceText: text, assertions: [] });
      expect(result.manual.markdown).toContain(text);
      expect(result.config.agentClasses.engineering.responsibility).toBe(text);
      expect(result.config.agentClasses.engineering.routingCapabilities).toEqual(base.config.agentClasses.engineering.routingCapabilities);
      expect(result.config.permissionProfiles).toEqual(base.config.permissionProfiles);
      expect((await service.getActiveSnapshot()).revisionId).toBe(base.revisionId);
      expect(await activate(service, result.config, base.revisionId)).toMatchObject({ ok: true });
    });
  });

  it('saves multiple changed duties and model facts with no Planner or internal LLM dependencies', async () => {
    await withConfiguration(async service => {
      const base = await service.getActiveSnapshot();
      const config = structuredClone(base.config);
      for (let i = 0; i < 5; i++) {
        config.agentClasses[`worker-${i}`] = {
          ...structuredClone(config.agentClasses.engineering),
          generatedRuntimeRef: `worker-${i}`,
          responsibility: `负责模块 ${i} 的代码修改和测试。`,
          executorManual: { sourceText: `负责模块 ${i} 的代码修改和测试。`, assertions: [] },
        };
      }
      expect(await activate(service, config, base.revisionId)).toMatchObject({ ok: true });
      const established = await service.getActiveSnapshot();
      for (let i = 0; i < 5; i++) {
        const text = `负责模块 ${i} 的接口实现、安全检查和回归验证。`;
        config.agentClasses[`worker-${i}`].responsibility = text;
        config.agentClasses[`worker-${i}`].executorManual = { sourceText: text, assertions: [] };
      }
      config.models.engineering.description = '支持跨文件分析。';
      const coordinator = new ConfigurationRuntimeCoordinator({
        service, initialSnapshot: established,
        gate: new ConfigurationActivationGate(() => ({ activeTaskId: null, plannerTurnActive: false,
          activeAttemptCount: 0, activeLeaseCount: 0, publicationPending: false, recoveryInProgress: false })),
      });
      const activation = await coordinator.activate({ config, expectedRevisionId: established.revisionId });
      expect(activation, JSON.stringify(activation)).toMatchObject({ ok: true });
      const saved = await service.getActiveSnapshot();
      for (let i = 0; i < 5; i++) {
        expect(saved.config.agentClasses[`worker-${i}`].responsibility).toBe(`负责模块 ${i} 的接口实现、安全检查和回归验证。`);
        expect(saved.config.agentClasses[`worker-${i}`].executorManual?.assertions).toEqual([]);
      }
    });
  });

  it('preserves persisted assertions only for unchanged source and does not accept client-injected assertions', async () => {
    await withConfiguration(async (service, preview) => {
      const first = await service.getActiveSnapshot();
      const draft = service.createDraft(first.config, first.revisionId);
      service.applyExecutorManualProposal(draft.revisionId, { agentClassRef: 'engineering', userProfile: {
        sourceText: '负责 TypeScript 测试。', assertions: [{ topic: 'preferred-task', text: 'TypeScript 回归测试。' }],
      } });
      expect(service.validateDraft(draft.revisionId).ok).toBe(true);
      service.compileDraft(draft.revisionId); await service.probeDraft(draft.revisionId);
      await service.activateDraft(draft.revisionId, first.revisionId);
      const base = await service.getActiveSnapshot();
      const candidate = structuredClone(base.config);
      candidate.agentClasses.engineering.executorManual!.assertions.push({ topic: 'mission', text: '伪造的职责解析。' });
      const same = await preview.compile({ baseRevisionId: base.revisionId, agentClassRef: 'engineering',
        sourceText: '负责 TypeScript 测试。', candidateConfig: candidate });
      expect(same.userProfile).toEqual(base.config.agentClasses.engineering.executorManual);
      expect(await activate(service, same.config, base.revisionId)).toMatchObject({ ok: true });
      const active = await service.getActiveSnapshot();
      const changed = await preview.compile({ baseRevisionId: active.revisionId, agentClassRef: 'engineering', sourceText: '负责需求评审。' });
      expect(changed.userProfile).toEqual({ sourceText: '负责需求评审。', assertions: [] });
      expect(changed.manual.markdown).not.toContain('TypeScript 回归测试。');
      expect(await activate(service, changed.config, active.revisionId)).toMatchObject({ ok: true });
    });
  });

  it('can preview disabled assistants and clear source without synthetic semantic receipts', async () => {
    await withConfiguration(async (service, preview) => {
      const base = await service.getActiveSnapshot();
      const candidate = structuredClone(base.config);
      candidate.agentClasses.engineering.enabled = false;
      const result = await preview.compile({ baseRevisionId: base.revisionId, agentClassRef: 'engineering',
        sourceText: '', candidateConfig: candidate });
      expect(result.config.agentClasses.engineering.enabled).toBe(false);
      expect(result.userProfile).toEqual({ sourceText: '', assertions: [] });
    });
  });

  it('rejects stale revisions instead of silently rebasing onto other settings', async () => {
    await withConfiguration(async (_service, preview) => {
      await expect(preview.compile({ baseRevisionId: 'missing-revision', agentClassRef: 'engineering', sourceText: '' })).rejects.toThrow();
    });
  });

  it('rejects credential-like text and unknown Agents before compiling', async () => {
    await withConfiguration(async (service, preview) => {
      const base = await service.getActiveSnapshot();
      await expect(preview.compile({ baseRevisionId: base.revisionId, agentClassRef: 'engineering', sourceText: 'api_key=sk-sensitive-value' }))
        .rejects.toThrow('must not contain credential-like content');
      await expect(preview.compile({ baseRevisionId: base.revisionId, agentClassRef: 'unknown', sourceText: '职责。' }))
        .rejects.toThrow('unknown Executor AgentClass');
    });
  });

  it('keeps the production settings composition free of Planner semantic preparation', async () => {
    const composition = await readFile(new URL('../../src/server/server-composition.ts', import.meta.url), 'utf8');
    expect(composition).not.toContain('ExecutorManualPlanner');
    expect(composition).not.toContain('executorManualPlanner');
    const preparation = composition.slice(composition.indexOf('prepareConfig:'), composition.indexOf('stageSecrets:'));
    expect(preparation).not.toContain('await');
    expect(preparation).not.toMatch(/plannerSupervisor|\.compileAll|\.generate/);
    expect(composition).toContain('new ExecutorManualPreviewService(configurationService)');
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
