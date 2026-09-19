import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildExecutorConfigurationCandidate,
  ExecutorConfigurationError,
  parseExecutorConfigurationChange,
  resolveExecutorToolHarness,
  projectExecutorManagement,
} from '../../src/configuration/executor-configuration.js';
import {
  ConfigurationService,
  validateExecutorManualSourceText,
} from '../../src/configuration/configuration-service.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';
import { parseAnyFusionConfigurationV2 } from '../../src/configuration/schema.js';
import type {
  AnyFusionConfigurationV2,
  ConfigurationSnapshot,
} from '../../src/configuration/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeImmutableTree));
});

async function removeImmutableTree(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return;
  if (stat.isDirectory()) {
    await chmod(path, 0o755).catch(() => undefined);
    for (const entry of await readdir(path)) {
      await removeImmutableTree(join(path, entry));
    }
  } else {
    await chmod(path, 0o644).catch(() => undefined);
  }
  await rm(path, { recursive: true, force: true });
}

function baseConfiguration(): AnyFusionConfigurationV2 {
  return parseAnyFusionConfigurationV2({
    schemaVersion: 2,
    providers: {
      openai: {
        protocol: 'openai-compatible',
        baseUrl: 'https://api.example.com/v1',
        apiKeyRef: 'file-secret:metawork/providers/openai',
        region: 'international',
        enabled: true,
      },
    },
    models: {
      'planner-model': {
        providerRef: 'openai',
        modelId: 'planner-model',
        capabilities: ['planning', 'structured-output', 'tools'],
        reasoning: 'high',
        enabled: true,
      },
      'executor-model': {
        providerRef: 'openai',
        modelId: 'executor-model',
        capabilities: ['coding', 'structured-output', 'tools'],
        reasoning: 'medium',
        enabled: true,
      },
      'alt-model': {
        providerRef: 'openai',
        modelId: 'alt-model',
        capabilities: ['coding', 'tools'],
        reasoning: 'low',
        enabled: true,
      },
    },
    harnesses: {
      'anyfusion-planner': {
        kind: 'planner',
        transport: 'local-process',
        commandRef: 'release:planner',
        args: [],
        driverId: 'anyfusion-planner-host-v2',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'pi-cli': {
        kind: 'executor',
        transport: 'local-cli',
        command: 'pi',
        args: [],
        driverId: 'pi-cli',
        supportsProbe: true,
        supportsAbort: true,
        supportsContinuation: true,
        enabled: true,
      },
      'my-codex-tool': {
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
      planner: {
        kind: 'planner',
        harnessRef: 'anyfusion-planner',
        modelPolicy: { mode: 'fixed', modelRef: 'planner-model' },
        routingCapabilities: [],
        primaryUseCases: [],
        avoidUseCases: [],
        plannerAffordances: [],
        skills: ['metaclaw-planner'],
        mcpServers: ['metaclaw-planner'],
        plugins: [],
        generatedRuntimeRef: 'planner',
        enabled: true,
      },
      'pi-agent': {
        displayName: '研究助手',
        kind: 'executor',
        harnessRef: 'pi-cli',
        modelPolicy: { mode: 'fixed', modelRef: 'executor-model' },
        permissionProfileRef: 'public-web-research',
        routingCapabilities: ['current-web-research'],
        primaryUseCases: ['current public-web research'],
        avoidUseCases: [],
        plannerAffordances: ['public-web-search', 'public-web-fetch', 'source-citation'],
        skills: [],
        mcpServers: [],
        plugins: [],
        generatedRuntimeRef: 'pi-agent',
        enabled: true,
      },
    },
    permissionProfiles: {
      'workspace-engineering': {
        profileId: 'workspace-engineering',
        version: 1,
        parameters: { maxAdditionalReadPartitions: 8 },
      },
      'public-web-research': {
        profileId: 'public-web-research',
        version: 1,
        parameters: {},
      },
    },
    runtimePolicy: {},
    gateway: {},
  });
}

function baseSnapshot(config: AnyFusionConfigurationV2 = baseConfiguration()): ConfigurationSnapshot {
  return { revisionId: 'revision-base', contentHash: 'hash-base', config };
}

function editableFields(overrides: Record<string, unknown> = {}) {
  return {
    displayName: '开发助手',
    modelPolicy: { mode: 'fixed', modelRef: 'executor-model' },
    permissionProfileRef: 'workspace-engineering',
    manualSourceText: '优先负责代码修改和测试。',
    enabled: true,
    ...overrides,
  };
}

describe('parseExecutorConfigurationChange', () => {
  it('preserves the full existing Auto objective when editing', () => {
    const modelPolicy = {
      mode: 'auto',
      allowedModelRefs: ['executor-model'],
      objective: { priority: 'cost', maxCostPerTurn: 2, maxLatencyMs: 1000, minimumQualityTier: 'high' },
    };
    const parsed = parseExecutorConfigurationChange({
      operation: 'update', agentClassRef: 'pi-agent', fields: editableFields({ modelPolicy }),
    });
    expect(parsed).toMatchObject({ fields: { modelPolicy } });
  });

  it('rejects extra fields and harness/driver/command injection', () => {
    expect(() => parseExecutorConfigurationChange({
      operation: 'create',
      tool: 'pi',
      fields: editableFields(),
      harnessRef: 'evil',
    })).toThrow(ExecutorConfigurationError);
    expect(() => parseExecutorConfigurationChange({
      operation: 'create',
      tool: 'pi',
      fields: { ...editableFields(), command: 'rm -rf /' },
    })).toThrow(ExecutorConfigurationError);
    expect(() => parseExecutorConfigurationChange({
      operation: 'create',
      tool: 'pi',
      fields: { ...editableFields(), routingCapabilities: ['image-generation'] },
    })).toThrow(ExecutorConfigurationError);
    expect(() => parseExecutorConfigurationChange({
      operation: 'create',
      tool: 'docker',
      fields: editableFields(),
    })).toThrow(ExecutorConfigurationError);
  });
});

describe('resolveExecutorToolHarness', () => {
  it('projects model choices from real tools, including Auto compatibility', () => {
    const base = baseSnapshot();
    const view = projectExecutorManagement(base);
    expect(view.tools.find(tool => tool.id === 'codex')?.models.find(model => model.ref === 'alt-model'))
      .toMatchObject({ fixedAllowed: true, autoAllowed: false });
    expect(view.tools.find(tool => tool.id === 'pi')?.models.find(model => model.ref === 'alt-model'))
      .toMatchObject({ fixedAllowed: true, autoAllowed: true });
    expect(view.executors[0]).toMatchObject({ agentClassRef: 'pi-agent', tool: 'pi', enabled: true });
  });

  it('resolves by real driverId, not by harness key name', () => {
    const config = baseConfiguration();
    expect(resolveExecutorToolHarness(config, 'codex')).toBe('my-codex-tool');
    expect(resolveExecutorToolHarness(config, 'pi')).toBe('pi-cli');
  });

  it('fails closed when the tool has no reusable harness', () => {
    const config = baseConfiguration();
    delete config.harnesses['pi-cli'];
    expect(() => resolveExecutorToolHarness(config, 'pi')).toThrow(
      expect.objectContaining({ code: 'tool_unavailable' }),
    );
  });

  it('reports ambiguity unless the driver-named template exists', () => {
    const config = baseConfiguration();
    config.harnesses['pi-secondary'] = { ...config.harnesses['pi-cli']! };
    expect(resolveExecutorToolHarness(config, 'pi')).toBe('pi-cli');
    delete config.harnesses['pi-cli'];
    config.harnesses['pi-tertiary'] = { ...config.harnesses['pi-secondary']! };
    expect(() => resolveExecutorToolHarness(config, 'pi')).toThrow(
      expect.objectContaining({ code: 'invalid_configuration' }),
    );
  });
});

describe('buildExecutorConfigurationCandidate', () => {
  it('preserves routing facts on a name-only edit with an aliased permission profile', () => {
    const base = baseSnapshot();
    base.config.permissionProfiles.research = base.config.permissionProfiles['public-web-research']!;
    const existing = base.config.agentClasses['pi-agent']!;
    existing.permissionProfileRef = 'research';
    const candidate = buildExecutorConfigurationCandidate(base, {
      operation: 'update', agentClassRef: 'pi-agent',
      fields: editableFields({ permissionProfileRef: 'research', displayName: 'New name' }),
    });
    expect(candidate.config.agentClasses['pi-agent']!.routingCapabilities).toEqual(existing.routingCapabilities);
    expect(candidate.config.agentClasses['pi-agent']!.plannerAffordances).toEqual(existing.plannerAffordances);
  });

  it('derives creation and permission changes from the actual profile, not its ref', () => {
    const base = baseSnapshot();
    base.config.permissionProfiles.research = base.config.permissionProfiles['public-web-research']!;
    const candidate = buildExecutorConfigurationCandidate(base, {
      operation: 'create', tool: 'pi', fields: editableFields({ permissionProfileRef: 'research' }),
    });
    expect(candidate.config.agentClasses[candidate.createdAgentClassRef!]!.routingCapabilities)
      .toEqual(['current-web-research']);
  });

  it('creates an executor with server-filled controlled fields', () => {
    let ids = 0;
    const candidate = buildExecutorConfigurationCandidate(
      baseSnapshot(),
      { operation: 'create', tool: 'codex', fields: editableFields() },
      () => `executor-test-${ids++}`,
    );

    expect(candidate.createdAgentClassRef).toBe('executor-test-0');
    const created = candidate.config.agentClasses['executor-test-0']!;
    expect(created).toMatchObject({
      displayName: '开发助手',
      kind: 'executor',
      harnessRef: 'my-codex-tool',
      permissionProfileRef: 'workspace-engineering',
      routingCapabilities: ['workspace-engineering', 'document-processing'],
      plannerAffordances: ['workspace-read-write', 'workspace-command-validation'],
      skills: [],
      mcpServers: [],
      plugins: [],
      generatedRuntimeRef: 'executor-test-0',
      enabled: true,
    });
    expect(created.executorManual).toEqual({
      sourceText: '优先负责代码修改和测试。',
      assertions: [],
    });
    // 候选配置本身必须通过完整 Schema 校验。
    expect(() => parseAnyFusionConfigurationV2(candidate.config)).not.toThrow();
    expect(candidate.summary[0]).toContain('开发助手');
  });

  it('does not touch other agentClasses, models, providers or the Planner', () => {
    const base = baseSnapshot();
    const candidate = buildExecutorConfigurationCandidate(base, {
      operation: 'create',
      tool: 'pi',
      fields: editableFields({ displayName: '第二个助手' }),
    });
    const created = candidate.createdAgentClassRef!;
    for (const [ref, definition] of Object.entries(candidate.config.agentClasses)) {
      if (ref === created) continue;
      expect(definition).toEqual(base.config.agentClasses[ref]);
    }
    expect(candidate.config.models).toEqual(base.config.models);
    expect(candidate.config.providers).toEqual(base.config.providers);
    expect(candidate.config.harnesses).toEqual(base.config.harnesses);
    expect(candidate.config.agentClasses.planner).toEqual(base.config.agentClasses.planner);
  });

  it('allows duplicate display names but never duplicate internal IDs', () => {
    const base = baseSnapshot();
    const first = buildExecutorConfigurationCandidate(base, {
      operation: 'create',
      tool: 'pi',
      fields: editableFields({ displayName: '研究助手' }),
    });
    const recreated = buildExecutorConfigurationCandidate(
      { ...base, config: first.config },
      { operation: 'create', tool: 'pi', fields: editableFields({ displayName: '研究助手' }) },
    );
    expect(recreated.createdAgentClassRef).not.toBe(first.createdAgentClassRef);
  });

  it('rejects model and permission references that do not exist', () => {
    expect(() => buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'create',
      tool: 'pi',
      fields: editableFields({ modelPolicy: { mode: 'fixed', modelRef: 'missing-model' } }),
    })).toThrow(expect.objectContaining({ code: 'invalid_configuration', field: 'modelPolicy' }));
    expect(() => buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'create',
      tool: 'pi',
      fields: editableFields({ permissionProfileRef: 'missing-profile' }),
    })).toThrow(expect.objectContaining({
      code: 'invalid_configuration',
      field: 'permissionProfileRef',
    }));
  });

  it('rejects credential-like manual source text', () => {
    expect(() => validateExecutorManualSourceText('sk-0123456789abcdef0123456789abcdef'))
      .toThrow();
    expect(() => buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'create',
      tool: 'pi',
      fields: editableFields({
        manualSourceText: 'sk-0123456789abcdef0123456789abcdef',
      }),
    })).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });

  it('updates editable fields but never the harness binding', () => {
    const candidate = buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'update',
      agentClassRef: 'pi-agent',
      fields: editableFields({
        displayName: '改名助手',
        modelPolicy: { mode: 'auto', allowedModelRefs: ['executor-model', 'alt-model'] },
        manualSourceText: '优先负责代码修改和测试。',
      }),
    });
    const updated = candidate.config.agentClasses['pi-agent']!;
    expect(updated.displayName).toBe('改名助手');
    expect(updated.modelPolicy).toEqual({
      mode: 'auto',
      allowedModelRefs: ['executor-model', 'alt-model'],
    });
    expect(updated.harnessRef).toBe('pi-cli');
    expect(updated.generatedRuntimeRef).toBe('pi-agent');
    expect(() => parseAnyFusionConfigurationV2(candidate.config)).not.toThrow();
  });

  it('clears stale semantic assertions when the manual source text changes', () => {
    const base = baseSnapshot();
    base.config.agentClasses['pi-agent']!.executorManual = {
      sourceText: '旧说明',
      assertionsSourceFingerprint:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      assertions: [{ topic: 'mission', text: '旧断言' }],
    };
    const unchanged = buildExecutorConfigurationCandidate(base, {
      operation: 'update',
      agentClassRef: 'pi-agent',
      fields: editableFields({ manualSourceText: '旧说明' }),
    });
    expect(unchanged.config.agentClasses['pi-agent']!.executorManual?.assertions)
      .toEqual([{ topic: 'mission', text: '旧断言' }]);

    const changed = buildExecutorConfigurationCandidate(base, {
      operation: 'update',
      agentClassRef: 'pi-agent',
      fields: editableFields({ manualSourceText: '新说明' }),
    });
    expect(changed.config.agentClasses['pi-agent']!.executorManual).toMatchObject({
      sourceText: '新说明',
      assertions: [],
    });
    expect(changed.config.agentClasses['pi-agent']!.executorManual?.semanticReceipt)
      .toBeUndefined();
  });

  it('rejects operations targeting the Planner or an unknown assistant', () => {
    for (const operation of ['update', 'enable', 'disable', 'remove'] as const) {
      const change = operation === 'update'
        ? { operation, agentClassRef: 'planner', fields: editableFields() } as const
        : { operation, agentClassRef: 'planner' } as const;
      expect(() => buildExecutorConfigurationCandidate(baseSnapshot(), change)).toThrow(
        expect.objectContaining({ code: 'unsupported_change' }),
      );
    }
    expect(() => buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'remove',
      agentClassRef: 'missing-assistant',
    })).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });

  it('enables, disables and removes executors, including the last one', () => {
    const disabled = buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'disable',
      agentClassRef: 'pi-agent',
    });
    expect(disabled.config.agentClasses['pi-agent']!.enabled).toBe(false);

    const enabled = buildExecutorConfigurationCandidate(disabled.config
      ? { ...disabled, config: disabled.config }
      : disabled, {
        operation: 'enable',
        agentClassRef: 'pi-agent',
      });
    expect(enabled.config.agentClasses['pi-agent']!.enabled).toBe(true);

    const removed = buildExecutorConfigurationCandidate(baseSnapshot(), {
      operation: 'remove',
      agentClassRef: 'pi-agent',
    });
    expect(removed.config.agentClasses['pi-agent']).toBeUndefined();
    // 删除最后一个助手仍然合法；Planner 与工具配置保留。
    expect(removed.config.harnesses['pi-cli']).toBeDefined();
    expect(removed.config.agentClasses.planner).toBeDefined();
    expect(() => parseAnyFusionConfigurationV2(removed.config)).not.toThrow();
  });
});

describe('ConfigurationService.prepareExecutorDraft', () => {
  async function serviceFixture(gate?: ConfigurationActivationGate) {
    const root = await mkdtemp(join(tmpdir(), 'metawork-executor-config-'));
    roots.push(root);
    const repository = new FileConfigurationRepository(join(root, 'config'));
    const ids = ['revision-base', 'revision-draft-1', 'revision-draft-2', 'revision-draft-3'];
    const probe = vi.fn(async () => ({ ok: true as const }));
    const service = new ConfigurationService({
      repository,
      createRevisionId: () => ids.shift()!,
      probe,
      ...(gate ? { activationGate: gate } : {}),
    });
    await service.initialize();
    const draft = service.createDraft(baseConfiguration(), null);
    service.validateDraft(draft.revisionId);
    service.compileDraft(draft.revisionId);
    await service.probeDraft(draft.revisionId);
    const activated = await service.activateDraft(draft.revisionId, null);
    expect(activated).toMatchObject({ ok: true });
    return { service, probe };
  }

  it('prepares a validated draft that activates through the existing flow', async () => {
    const { service, probe } = await serviceFixture();

    const prepared = await service.prepareExecutorDraft({
      operation: 'create',
      tool: 'pi',
      fields: editableFields(),
    });
    expect(prepared.baseRevisionId).toBe('revision-base');
    expect(prepared.createdAgentClassRef).toMatch(/^executor-/u);
    expect(prepared.summary[0]).toContain('新增执行助手');

    service.compileDraft(prepared.revisionId);
    await service.probeDraft(prepared.revisionId);
    const activated = await service.activateDraft(prepared.revisionId, 'revision-base');
    expect(activated).toMatchObject({ ok: true });
    if (activated.ok) {
      expect(activated.snapshot.config.agentClasses[prepared.createdAgentClassRef!])
        .toMatchObject({ displayName: '开发助手', harnessRef: 'pi-cli' });
    }
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid candidates without leaving a draft behind', async () => {
    const { service } = await serviceFixture();
    await expect(service.prepareExecutorDraft({
      operation: 'create',
      tool: 'pi',
      fields: editableFields({ modelPolicy: { mode: 'fixed', modelRef: 'missing-model' } }),
    })).rejects.toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
  });

  it('refuses to prepare while the account is not idle', async () => {
    const facts = {
      activeTaskId: null as string | null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    };
    const gate = new ConfigurationActivationGate(() => facts);
    const { service } = await serviceFixture(gate);
    facts.activeTaskId = 'task-1';
    await expect(service.prepareExecutorDraft({
      operation: 'remove',
      agentClassRef: 'pi-agent',
    })).rejects.toThrow(expect.objectContaining({ code: 'runtime_busy' }));
  });
});
