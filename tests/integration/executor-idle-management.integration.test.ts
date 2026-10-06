import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { FileConfigurationRepository } from '../../src/configuration/file-configuration-repository.js';
import { ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';
import { ConfigurationRuntimeCoordinator } from '../../src/configuration/configuration-runtime-coordinator.js';
import { AgentRuntimeRenderer } from '../../src/configuration/agent-runtime-renderer.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { createProductionRuntimeBindings } from '../../src/configuration/production-runtime-bindings.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { CodexCliDriver } from '../../src/executor/codex-cli-driver.js';
import { PiCliDriver } from '../../src/executor/pi-cli-driver.js';
import type { ExecutorConfigurationChange } from '../../src/configuration/executor-configuration.js';
import { validateEnabledModelPrices } from '../../src/configuration/enabled-model-price-validation.js';

describe('idle executor lifecycle across configuration consumers', () => {
  it('saves an unpriced model and a new agent as one draft, validating only at final activation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-batch-activation-'));
    try {
      const gate = new ConfigurationActivationGate(() => ({
        activeTaskId: null, plannerTurnActive: false, activeAttemptCount: 0,
        activeLeaseCount: 0, publicationPending: false, recoveryInProgress: false,
      }));
      const service = new ConfigurationService({
        repository: new FileConfigurationRepository(join(root, 'config')), activationGate: gate,
        probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initial = service.createDraft(buildStagedLegacyConfiguration({ testMode: true }).snapshot.config, null);
      expect(service.validateDraft(initial.revisionId).ok).toBe(true);
      service.compileDraft(initial.revisionId);
      await service.probeDraft(initial.revisionId);
      await service.activateDraft(initial.revisionId, null);
      const active = await service.getActiveSnapshot();
      let activations = 0;
      const coordinator = new ConfigurationRuntimeCoordinator({
        service, gate, initialSnapshot: active, validateActivationConfig: validateEnabledModelPrices,
        onActivated: () => { activations++; },
      });
      const config = structuredClone(active.config);
      config.models['new-model'] = { ...Object.values(config.models)[0]!, modelId: 'deepseek-flash' };
      delete config.models['new-model'].costInputPerMillion;
      delete config.models['new-model'].costOutputPerMillion;
      const fields = { displayName: '日常秘书', modelPolicy: { mode: 'fixed' as const, modelRef: 'new-model' },
        manualSourceText: '回答日常问题。', enabled: true };
      const created = await service.prepareExecutorDraft({ operation: 'create', tool: 'pi', fields }, active.revisionId, config);
      const edited = await service.prepareExecutorDraft({ operation: 'update', agentClassRef: created.createdAgentClassRef!,
        fields: { ...fields, displayName: '日常助手' } }, active.revisionId, created.config);
      expect((await service.getActiveSnapshot()).revisionId).toBe(active.revisionId);
      expect(activations).toBe(0);
      expect(await coordinator.activate({ config: edited.config, expectedRevisionId: active.revisionId }))
        .toMatchObject({ ok: false, code: 'invalid_configuration', issues: expect.arrayContaining([
          expect.stringContaining('costInputPerMillion'), expect.stringContaining('costOutputPerMillion'),
        ]) });
      expect((await service.getActiveSnapshot()).config.agentClasses[created.createdAgentClassRef!]).toBeUndefined();
      edited.config.models['new-model']!.costInputPerMillion = 1;
      edited.config.models['new-model']!.costOutputPerMillion = 2;
      expect(await coordinator.activate({ config: edited.config, expectedRevisionId: active.revisionId }))
        .toMatchObject({ ok: true, classification: 'hot' });
      expect(activations).toBe(1);
      expect((await service.getActiveSnapshot()).config.agentClasses[created.createdAgentClassRef!])
        .toMatchObject({ displayName: '日常助手', harnessRef: 'pi-cli', modelPolicy: fields.modelPolicy });
    } finally {
      await writable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
  it('activates CRUD and same-tool bindings without recreating consumers, and preserves deletion on reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-idle-lifecycle-'));
    try {
      let planning = false;
      const gate = new ConfigurationActivationGate(() => ({
        activeTaskId: null, plannerTurnActive: planning, activeAttemptCount: 0,
        activeLeaseCount: 0, publicationPending: false, recoveryInProgress: false,
      }));
      const repository = new FileConfigurationRepository(join(root, 'config'));
      const renderer = new AgentRuntimeRenderer(join(root, 'generated'));
      const service = new ConfigurationService({
        repository, renderer, activationGate: gate, probe: async () => ({ ok: true }),
      });
      await service.initialize();
      const initialConfig = buildStagedLegacyConfiguration({ testMode: true }).snapshot.config;
      const firstModel = Object.keys(initialConfig.models)[0]!;
      initialConfig.models.alternate = { ...initialConfig.models[firstModel]!, modelId: 'gpt-alternate' };
      const draft = service.createDraft(initialConfig, null);
      expect(service.validateDraft(draft.revisionId).ok).toBe(true);
      service.compileDraft(draft.revisionId);
      await service.probeDraft(draft.revisionId);
      await service.activateDraft(draft.revisionId, null);
      let active = await service.getActiveSnapshot();
      const classes = new AgentClassService({ getAgentClasses: () => active.config.agentClasses });
      const bindings = createProductionRuntimeBindings({
        snapshot: active,
        secretStore: { get: async () => 'test-secret', put: async () => undefined, delete: async () => undefined },
      });
      const coordinator = new ConfigurationRuntimeCoordinator({
        service, gate, initialSnapshot: active,
        onActivated: ({ snapshot }) => { active = snapshot; bindings.updateSnapshot(snapshot); },
      });
      const mutate = async (change: ExecutorConfigurationChange) => {
        const prepared = await service.prepareExecutorDraft(change, active.revisionId);
        const config = prepared.config;
        const result = await coordinator.activate({ config, expectedRevisionId: prepared.baseRevisionId });
        expect(result).toMatchObject({ ok: true });
        expect(await renderer.currentRevisionId()).toBe(active.revisionId);
        expect((await repository.getActiveSnapshot()).revisionId).toBe(active.revisionId);
        return prepared.createdAgentClassRef!;
      };
      const refs: string[] = [];
      for (const tool of ['pi', 'codex'] as const) {
        for (const modelRef of [firstModel, 'alternate']) {
          refs.push(await mutate({
            operation: 'create', tool, fields: {
              displayName: `${tool} ${modelRef}`, modelPolicy: { mode: 'fixed', modelRef },
              manualSourceText: '', enabled: true,
            },
          }));
        }
      }
      for (const ref of refs) {
        const agent = active.config.agentClasses[ref]!;
        const modelRef = agent.modelPolicy.mode === 'fixed' ? agent.modelPolicy.modelRef : '';
        const model = active.config.models[modelRef]!;
        const binding = await bindings.getRuntimeBinding({
          agentClassRef: ref, harnessRef: agent.harnessRef, modelRef,
          providerRef: model.providerRef, permissionProfileRef: agent.permissionProfileRef!,
          configurationRevision: active.revisionId,
        });
        expect(binding.environment.OPENAI_MODEL).toBe(model.modelId);
        expect(classes.hasExecutorAgentClass(ref)).toBe(true);
        const driver = agent.harnessRef === 'pi-cli' ? new PiCliDriver() : new CodexCliDriver();
        const launch = driver.buildLaunch({
          prompt: 'test', cwd: root, runtimeHomePath: join(root, ref),
          providerRef: model.providerRef, modelId: model.modelId,
        });
        expect(launch.args.join(' ')).toContain(model.modelId);
      }
      await mutate({ operation: 'disable', agentClassRef: refs[0]! });
      expect(classes.hasExecutorAgentClass(refs[0]!)).toBe(false);
      await mutate({ operation: 'enable', agentClassRef: refs[0]! });
      expect(classes.hasExecutorAgentClass(refs[0]!)).toBe(true);
      planning = true;
      await expect(service.prepareExecutorDraft({ operation: 'remove', agentClassRef: refs[0] }))
        .resolves.toMatchObject({ baseRevisionId: active.revisionId });
      expect(await coordinator.activate({ config: active.config, expectedRevisionId: active.revisionId }))
        .toMatchObject({ ok: false, code: 'runtime_busy' });
      planning = false;
      for (const ref of classes.listExecutorAgentClassNames()) {
        await mutate({ operation: 'remove', agentClassRef: ref });
      }
      expect(classes.listExecutorAgentClassNames()).toEqual([]);
      expect(coordinator.getPlannerView().routingCatalog.agentClasses).toEqual([]);
      const reloaded = await new FileConfigurationRepository(join(root, 'config')).getActiveSnapshot();
      expect(Object.keys(reloaded.config.agentClasses)).toEqual(['planner']);
    } finally {
      await writable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writable(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory()) {
    await chmod(path, 0o755);
    for (const entry of await readdir(path)) await writable(join(path, entry));
  } else await chmod(path, 0o644);
}
