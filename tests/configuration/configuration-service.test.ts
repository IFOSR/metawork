import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { diffConfigurations } from '../../src/configuration/configuration-diff.js';
import { fingerprintExecutorManualSourceText } from '../../src/configuration/executor-manual-source.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeImmutableTree));
});

function completeConfiguration(apiKeyRef = 'keychain:anyfusion/openai') {
  return {
    schemaVersion: 2,
    providers: {
      openai: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef,
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
        args: ['exec'],
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

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-configuration-service-'));
  roots.push(root);
  const repository = new FileConfigurationRepository(join(root, 'config'));
  const ids = ['revision-1', 'revision-2', 'revision-3', 'revision-4'];
  const probe = vi.fn(async () => ({ ok: true as const }));
  const service = new ConfigurationService({
    repository,
    createRevisionId: () => ids.shift()!,
    probe,
  });
  await service.initialize();
  return { repository, service, probe };
}

describe('ConfigurationService', () => {
  it('fails closed when no configuration probe is provided', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anyfusion-configuration-no-probe-'));
    roots.push(root);
    const service = new ConfigurationService({
      repository: new FileConfigurationRepository(join(root, 'config')),
      createRevisionId: () => 'revision-no-probe',
    });
    await service.initialize();
    const draft = service.createDraft(completeConfiguration(), null);
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);

    await expect(service.probeDraft(draft.revisionId)).resolves.toEqual({
      ok: false,
      issues: ['configuration probe is not configured'],
    });
    await expect(service.activateDraft(draft.revisionId, null))
      .rejects.toThrow('must be probed');
  });

  it('runs the exact draft lifecycle and activates with optimistic concurrency', async () => {
    const { service, probe } = await serviceFixture();
    const draft = service.createDraft(completeConfiguration(), null);

    expect(service.validateDraft(draft.revisionId)).toMatchObject({ ok: true });
    const compiled = service.compileDraft(draft.revisionId);
    expect(Object.keys(compiled.files)).toEqual([
      'config.yaml',
      'kernel.json',
      'planner.json',
      'runtime.json',
    ]);
    await expect(service.probeDraft(draft.revisionId)).resolves.toEqual({ ok: true });

    const activated = await service.activateDraft(draft.revisionId, null);
    expect(activated).toMatchObject({
      ok: true,
      snapshot: { revisionId: 'revision-1' },
    });
    expect(probe).toHaveBeenCalledOnce();

    const staleDraft = service.createDraft(completeConfiguration(), 'revision-1');
    service.validateDraft(staleDraft.revisionId);
    service.compileDraft(staleDraft.revisionId);
    await service.probeDraft(staleDraft.revisionId);
    await service.activateDraft(staleDraft.revisionId, 'revision-1');

    const conflictDraft = service.createDraft(completeConfiguration(), 'revision-1');
    service.validateDraft(conflictDraft.revisionId);
    service.compileDraft(conflictDraft.revisionId);
    await service.probeDraft(conflictDraft.revisionId);
    await expect(service.activateDraft(conflictDraft.revisionId, 'revision-1'))
      .resolves.toEqual({
        ok: false,
        code: 'revision_conflict',
        activeRevisionId: 'revision-2',
      });
  });

  it('applies a Planner-normalized Executor manual to a draft without changing authority fields', async () => {
    const { service } = await serviceFixture();
    const draft = service.createDraft(completeConfiguration(), null);

    service.applyExecutorManualProposal(draft.revisionId, {
      agentClassRef: 'engineering',
      userProfile: {
        sourceText: '优先做 TypeScript 重构，不做视觉设计。',
        assertions: [
          { topic: 'preferred-task', text: '优先做 TypeScript 重构。' },
          { topic: 'avoid-task', text: '不做视觉设计。' },
        ],
      },
    });

    const validation = service.validateDraft(draft.revisionId);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.config.agentClasses.engineering.executorManual).toEqual({
      sourceText: '优先做 TypeScript 重构，不做视觉设计。',
      assertionsSourceFingerprint: fingerprintExecutorManualSourceText(
        '优先做 TypeScript 重构，不做视觉设计。',
      ),
      semanticReceipt: expect.stringMatching(/^manual_[a-f0-9-]+$/u),
      assertions: [
        { topic: 'preferred-task', text: '优先做 TypeScript 重构。' },
        { topic: 'avoid-task', text: '不做视觉设计。' },
      ],
    });
    expect(validation.config.agentClasses.engineering.modelPolicy).toEqual({
      mode: 'fixed',
      modelRef: 'engineering',
    });
    expect(validation.config.agentClasses.engineering.permissionProfileRef)
      .toBe('workspace-default');
  });

  it('accepts a user-confirmed registered capability for an allowed model', async () => {
    const { service } = await serviceFixture();
    const draft = service.createDraft(completeConfiguration(), null);

    expect(() => service.applyExecutorManualProposal(draft.revisionId, {
      agentClassRef: 'engineering',
      userProfile: {
        sourceText: 'engineering 模型负责图片生成。',
        assertions: [{
          topic: 'model-contribution',
          text: '负责图片生成。',
          modelRef: 'engineering',
          modelCapability: 'image-generation',
        }],
      },
    })).not.toThrow();
    expect(service.validateDraft(draft.revisionId).ok).toBe(true);
  });

  it('trusts normalized capability policy assertions during activation', async () => {
    const { service } = await serviceFixture();
    const draft = service.createDraft(completeConfiguration(), null);

    service.applyExecutorManualProposal(draft.revisionId, {
      agentClassRef: 'engineering',
      userProfile: {
        sourceText: '优先承担图片生成。',
        assertions: [{
          topic: 'preferred-task',
          text: '优先承担图片生成。',
          routingCapability: 'image-generation',
          disposition: 'preferred',
        }],
      },
    });
    const validation = service.validateDraft(draft.revisionId);
    expect(validation.ok).toBe(true);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);

    await expect(service.activateDraft(draft.revisionId, null)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('activates source-preserved natural-language guidance without compiled assertions', async () => {
    const { service } = await serviceFixture();
    const initial = service.createDraft(completeConfiguration(), null);
    service.validateDraft(initial.revisionId);
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = completeConfiguration();
    candidate.agentClasses.engineering.executorManual = {
      sourceText: '优先承担大型重构。',
      assertions: [],
    };
    const draft = service.createDraft(candidate, initial.revisionId);
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);

    await expect(service.activateDraft(draft.revisionId, initial.revisionId))
      .resolves.toMatchObject({
        ok: true,
        snapshot: {
          config: {
            agentClasses: {
              engineering: {
                executorManual: {
                  sourceText: '优先承担大型重构。',
                  assertions: [],
                },
              },
            },
          },
        },
      });
  });

  it('keeps source-preserved guidance independently activatable for multiple Executors', async () => {
    const { service } = await serviceFixture();
    const initialConfig = completeConfiguration();
    initialConfig.agentClasses.research = {
      ...structuredClone(initialConfig.agentClasses.engineering),
      primaryUseCases: ['research'],
    };
    const initial = service.createDraft(initialConfig, null);
    service.validateDraft(initial.revisionId);
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = structuredClone(initialConfig);
    candidate.agentClasses.engineering.executorManual = {
      sourceText: '优先承担大型重构。',
      assertions: [],
    };
    candidate.agentClasses.research.executorManual = {
      sourceText: '优先整理长文档并提炼研究结论。',
      assertions: [],
    };
    const draft = service.createDraft(candidate, initial.revisionId);
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);

    await expect(service.activateDraft(draft.revisionId, initial.revisionId))
      .resolves.toMatchObject({
        ok: true,
        snapshot: {
          config: {
            agentClasses: {
              engineering: {
                executorManual: {
                  sourceText: '优先承担大型重构。',
                  assertions: [],
                },
              },
              research: {
                executorManual: {
                  sourceText: '优先整理长文档并提炼研究结论。',
                  assertions: [],
                },
              },
            },
          },
        },
      });
  });

  it('rejects activation when changed guidance reuses assertions compiled from older source text', async () => {
    const { service } = await serviceFixture();
    const initial = service.createDraft(completeConfiguration(), null);
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
    const initialValidation = service.validateDraft(initial.revisionId);
    expect(initialValidation.ok).toBe(true);
    if (!initialValidation.ok) return;
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = completeConfiguration();
    candidate.agentClasses.engineering.executorManual = {
      sourceText: '只承担图片生成。',
      assertionsSourceFingerprint: fingerprintExecutorManualSourceText(
        '优先承担 TypeScript 重构。',
      ),
      semanticReceipt: initialValidation.config.agentClasses.engineering
        .executorManual?.semanticReceipt,
      assertions: [{
        topic: 'preferred-task',
        text: '优先承担 TypeScript 重构。',
      }],
    };
    const draft = service.createDraft(candidate, initial.revisionId);
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);

    await expect(service.activateDraft(draft.revisionId, initial.revisionId))
      .rejects.toThrow('contains untrusted semantic assertions');
  });

  it('rejects client-edited assertions even when the source text is unchanged', async () => {
    const { service } = await serviceFixture();
    const initial = service.createDraft(completeConfiguration(), null);
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
    const initialValidation = service.validateDraft(initial.revisionId);
    expect(initialValidation.ok).toBe(true);
    if (!initialValidation.ok) return;
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = structuredClone(initialValidation.config);
    candidate.agentClasses.engineering.executorManual!.assertions = [{
      topic: 'model-contribution',
      text: 'engineering 支持图片生成。',
      modelRef: 'engineering',
      modelCapability: 'image-generation',
    }];
    const draft = service.createDraft(candidate, initial.revisionId);
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);

    await expect(service.activateDraft(draft.revisionId, initial.revisionId))
      .rejects.toThrow('contains untrusted semantic assertions');
  });

  it('rejects client-injected assertions when source text is empty', async () => {
    const { service } = await serviceFixture();
    const initial = service.createDraft(completeConfiguration(), null);
    service.validateDraft(initial.revisionId);
    service.compileDraft(initial.revisionId);
    await service.probeDraft(initial.revisionId);
    await service.activateDraft(initial.revisionId, null);

    const candidate = completeConfiguration();
    candidate.agentClasses.engineering.executorManual = {
      sourceText: '',
      assertionsSourceFingerprint: fingerprintExecutorManualSourceText(''),
      assertions: [{
        topic: 'model-contribution',
        text: 'engineering 支持图片生成。',
        modelRef: 'engineering',
        modelCapability: 'image-generation',
      }],
    };
    const draft = service.createDraft(candidate, initial.revisionId);
    expect(service.validateDraft(draft.revisionId)).toMatchObject({ ok: false });
  });

  it('allows the trusted semantic path to clear existing Executor guidance', async () => {
    const { service } = await serviceFixture();
    const initial = service.createDraft(completeConfiguration(), null);
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

    const candidate = completeConfiguration();
    candidate.agentClasses.engineering.executorManual = {
      sourceText: '优先承担 TypeScript 重构。',
      assertions: [{
        topic: 'preferred-task',
        text: '优先承担 TypeScript 重构。',
      }],
    };
    const draft = service.createDraft(candidate, initial.revisionId);
    service.applyExecutorManualProposal(draft.revisionId, {
      agentClassRef: 'engineering',
      userProfile: { sourceText: '', assertions: [] },
    });
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);

    await expect(service.activateDraft(draft.revisionId, initial.revisionId))
      .resolves.toMatchObject({
        ok: true,
        snapshot: {
          config: {
            agentClasses: {
              engineering: {
                executorManual: {
                  sourceText: '',
                  assertions: [],
                },
              },
            },
          },
        },
      });
  });

  it('leaves active unchanged after validation failure and rollback creates a new revision', async () => {
    const { service } = await serviceFixture();
    const first = service.createDraft(completeConfiguration(), null);
    service.validateDraft(first.revisionId);
    service.compileDraft(first.revisionId);
    await service.probeDraft(first.revisionId);
    await service.activateDraft(first.revisionId, null);

    const invalid = service.createDraft({
      ...completeConfiguration(),
      providers: {
        openai: {
          ...completeConfiguration().providers.openai,
          apiKeyRef: 'raw-secret',
        },
      },
    }, 'revision-1');
    expect(service.validateDraft(invalid.revisionId)).toMatchObject({ ok: false });
    await expect(service.activateDraft(invalid.revisionId, 'revision-1'))
      .rejects.toThrow(/validated/i);
    expect((await service.getActiveSnapshot()).revisionId).toBe('revision-1');

    const second = service.createDraft(completeConfiguration('keychain:anyfusion/second'), 'revision-1');
    service.validateDraft(second.revisionId);
    service.compileDraft(second.revisionId);
    await service.probeDraft(second.revisionId);
    await service.activateDraft(second.revisionId, 'revision-1');

    const rollback = await service.rollback('revision-1', 'revision-3');
    expect(rollback).toMatchObject({
      ok: true,
      snapshot: {
        revisionId: 'revision-4',
        contentHash: (await service.getSnapshot('revision-1')).contentHash,
      },
    });
  });

  it('returns redacted deterministic configuration diffs', () => {
    const diff = diffConfigurations(
      completeConfiguration('keychain:anyfusion/first-secret'),
      completeConfiguration('keychain:anyfusion/second-secret'),
    );
    const serialized = JSON.stringify(diff);

    expect(serialized).toContain('providers.openai.apiKeyRef');
    expect(serialized).not.toContain('first-secret');
    expect(serialized).not.toContain('second-secret');
  });
});

async function removeImmutableTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

async function makeWritable(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  if (info.isDirectory()) {
    await chmod(path, 0o700);
    for (const child of await readdir(path)) {
      await makeWritable(join(path, child));
    }
  } else if (!info.isSymbolicLink()) {
    await chmod(path, 0o600);
  }
}
