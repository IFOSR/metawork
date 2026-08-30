import { describe, expect, it, vi } from 'vitest';
import {
  ConfigurationRuntimeCoordinator,
  type ConfigurationRuntimeEvent,
} from '../../src/configuration/configuration-runtime-coordinator.js';
import { ConfigurationActivationGate } from '../../src/configuration/configuration-activation-gate.js';
import { ConfigurationService } from '../../src/configuration/configuration-service.js';
import { resolvePlannerRuntimeEnvironment } from '../../src/configuration/runtime-private-binding-resolver.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { ensureActiveConfigurationRevision } from '../../src/storage/active-configuration-revision.js';

function snapshot(revisionId: string, config: Record<string, unknown>) {
  const base = {
    schemaVersion: 2,
    providers: { p: { protocol: 'openai-compatible', baseUrl: 'old', apiKeyRef: 'file-secret:p', region: 'international', enabled: true } },
    models: { m: { providerRef: 'p', modelId: 'm', capabilities: ['coding', 'planning', 'structured-output', 'tools'], reasoning: 'medium', enabled: true } },
    harnesses: {
      planner: { kind: 'planner', transport: 'local-process', commandRef: 'release:planner', args: [], driverId: 'anyfusion-planner-host-v2', supportsProbe: true, supportsAbort: true, supportsContinuation: true, enabled: true },
      h: { kind: 'executor', transport: 'local-cli', command: 'codex', args: [], driverId: 'codex-cli', supportsProbe: true, supportsAbort: true, supportsContinuation: true, enabled: true },
    },
    agentClasses: {
      planner: { kind: 'planner', harnessRef: 'planner', modelPolicy: { mode: 'fixed', modelRef: 'm' }, routingCapabilities: [], primaryUseCases: [], avoidUseCases: [], plannerAffordances: [], skills: [], mcpServers: [], plugins: [], generatedRuntimeRef: 'planner', enabled: true },
      executor: { kind: 'executor', harnessRef: 'h', modelPolicy: { mode: 'fixed', modelRef: 'm' }, permissionProfileRef: 'workspace', routingCapabilities: ['workspace-engineering'], primaryUseCases: [], avoidUseCases: [], plannerAffordances: ['workspace-read-write', 'workspace-command-validation'], skills: [], mcpServers: [], plugins: [], generatedRuntimeRef: 'executor', enabled: true },
    },
    permissionProfiles: { workspace: { profileId: 'workspace-engineering', version: 1, parameters: {} } },
    runtimePolicy: {
      maxConcurrentTasks: 2,
      maxConcurrentAttempts: 4,
      maxConcurrentAttemptsPerTask: 2,
      schedulingAgingMs: 300_000,
      sameConversationQueueLimit: 8,
    },
    gateway: {},
  };
  return {
    revisionId,
    contentHash: `hash-${revisionId}`,
    config: {
      ...base,
      ...config,
      providers: { ...base.providers, ...(config.providers as object | undefined) },
      models: { ...base.models, ...(config.models as object | undefined) },
      harnesses: { ...base.harnesses, ...(config.harnesses as object | undefined) },
    },
  } as never;
}

function fakeService(initial: ReturnType<typeof snapshot>, next: ReturnType<typeof snapshot>) {
  let active = initial;
  return {
    getActiveSnapshot: async () => active,
    createDraft: () => ({ revisionId: next.revisionId, baseRevisionId: initial.revisionId }),
    validateDraft: () => ({ ok: true as const, config: next.config }),
    compileDraft: () => ({ contentHash: next.contentHash, files: {} }),
    probeDraft: async () => ({ ok: true as const }),
    activateDraft: async () => {
      active = next;
      return { ok: true as const, snapshot: next };
    },
  };
}

describe('ConfigurationRuntimeCoordinator', () => {
  it('atomically updates live views for a hot activation and publishes audit events', async () => {
    const before = snapshot('revision-1', { providers: { p: { baseUrl: 'https://old.example/v1' } } });
    const after = snapshot('revision-2', { providers: { p: { baseUrl: 'https://new.example/v1' } } });
    const events: ConfigurationRuntimeEvent[] = [];
    const service = fakeService(before, after);
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      publish: event => events.push(event),
    });

    const result = await coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-1',
    });

    expect(result).toMatchObject({ ok: true, snapshot: { revisionId: 'revision-2' }, classification: 'hot' });
    expect(coordinator.getState()).toMatchObject({
      activeRevisionId: 'revision-2',
      runtimeRevisionId: 'revision-2',
      activationAllowed: true,
      restartRequired: false,
    });
    expect(events.map(event => event.type)).toEqual([
      'configuration_runtime_state',
      'configuration_activated',
    ]);
  });

  it('rejects restart-required changes without switching the live revision', async () => {
    const before = snapshot('revision-1', { harnesses: { h: { command: 'old' } } });
    const after = snapshot('revision-2', { harnesses: { h: { command: 'new' } } });
    const service = fakeService(before, after);
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
    });

    await expect(coordinator.activate({ config: after.config, expectedRevisionId: 'revision-1' }))
      .resolves.toMatchObject({ ok: false, code: 'restart_required', restartPaths: ['harnesses.h.command'] });
    expect(coordinator.getState().activeRevisionId).toBe('revision-1');
  });

  it('does not deadlock when ConfigurationService owns the activation mutex', async () => {
    const before = snapshot('revision-1', {});
    const after = structuredClone(before) as ReturnType<typeof snapshot>;
    after.revisionId = 'revision-2';
    after.contentHash = 'hash-revision-2';
    after.config.providers.p.baseUrl = 'https://new.example/v1';
    let active = before;
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    }));
    const service = new ConfigurationService({
      repository: {
        initialize: async () => undefined,
        recover: async () => ({ status: 'active' as const }),
        getActiveSnapshot: async () => active,
        readSnapshot: async () => after,
        writeRevision: async () => undefined,
        activateRevision: async () => { active = after; },
      } as never,
      probe: async () => ({ ok: true }),
      activationGate: gate,
      createRevisionId: () => 'revision-2',
    });
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate,
      initialSnapshot: before,
    });

    const result = await coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-1',
    });
    expect(result).toMatchObject({ ok: true, snapshot: { revisionId: 'revision-2' } });
  });

  it('holds the activation gate across validation and probing', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {
      providers: {
        p: {
          ...before.config.providers.p,
          baseUrl: 'https://new.example/v1',
        },
      },
    });
    let probeStarted!: () => void;
    let releaseProbe!: () => void;
    const probeReady = new Promise<void>(resolve => { probeStarted = resolve; });
    const probeRelease = new Promise<void>(resolve => { releaseProbe = resolve; });
    const service = {
      ...fakeService(before, after),
      probeDraft: async () => {
        probeStarted();
        await probeRelease;
        return { ok: true as const };
      },
    };
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    }));
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate,
      initialSnapshot: before,
    });

    const first = coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-1',
    });
    await probeReady;

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-1',
    })).resolves.toMatchObject({ ok: false, code: 'runtime_busy' });

    releaseProbe();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('does not persist activation secrets when validation or probing fails', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {
      providers: { p: { baseUrl: 'https://new.example/v1' } },
    });
    const prepared: string[] = [];
    const service = {
      ...fakeService(before, after),
      validateDraft: () => ({ ok: false as const, issues: [{ path: 'providers.p', message: 'invalid' }] }),
    };
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      prepareConfig: ({ secrets }) => {
        prepared.push(...Object.keys(secrets));
        return after.config;
      },
    });

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: 'revision-1',
      secrets: { p: 'should-not-be-written' },
    })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_configuration',
      issues: ['providers.p: invalid'],
    });
    expect(prepared).toEqual([]);
  });

  it('passes the activated revision to Planner binding refresh consumers', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {
      providers: {
        p: {
          ...before.config.providers.p,
          baseUrl: 'https://new.example/v1',
        },
      },
    });
    const plannerBinding = {
      agentClassRef: 'planner',
      harnessRef: 'planner',
      providerRef: 'p',
      modelRef: 'm',
      permissionProfileRef: null,
      configurationRevision: after.revisionId,
    };
    const secretStore = {
      get: async () => 'planner-secret',
      put: async () => undefined,
      delete: async () => undefined,
    };
    let resolvedRevision: string | undefined;
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: fakeService(before, after) as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      onActivated: async ({ runtime }) => {
        const environment = await resolvePlannerRuntimeEnvironment({
          configuration: runtime,
          plannerBinding,
          secretStore,
        });
        resolvedRevision = runtime.revisionId;
        expect(environment.OPENAI_BASE_URL).toBe('https://new.example/v1');
      },
    });

    const result = await coordinator.activate({
      config: after.config,
      expectedRevisionId: before.revisionId,
    });
    expect(result).toMatchObject({ ok: true });
    expect(resolvedRevision).toBe(after.revisionId);
  });

  it('registers the activated revision before revision-keyed Kernel writes', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {});
    const db = new Database(':memory:');
    runMigrations(db);
    ensureActiveConfigurationRevision(db, {
      revisionId: before.revisionId,
      contentHash: before.contentHash,
    });
    let registered = false;
    const service = {
      ...fakeService(before, after),
      activateDraft: async () => {
        expect(registered).toBe(true);
        return { ok: true as const, snapshot: after };
      },
    };
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      registerRevision: snapshot => {
        ensureActiveConfigurationRevision(db, {
          revisionId: snapshot.revisionId,
          contentHash: snapshot.contentHash,
        });
        registered = true;
      },
    });

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: before.revisionId,
    })).resolves.toMatchObject({ ok: true });

    expect(() => db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, causation_id,
        session_id, task_id, subtask_id, attempt_id, event_json,
        available_at, status, configuration_revision, created_at, updated_at
      ) VALUES (?, 5, 'plan_proposed', ?, NULL, ?, NULL, NULL, NULL, ?, ?, 'pending', ?, ?, ?)
    `).run(
      'event-revision-2',
      'correlation-revision-2',
      'session-revision-2',
      '{}',
      '2026-08-24T00:00:00.000Z',
      after.revisionId,
      '2026-08-24T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z',
    )).not.toThrow();
    db.close();
  });

  it('rolls back staged secrets when the candidate probe fails', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {
      providers: { p: { baseUrl: 'https://new.example/v1' } },
    });
    const rollback = vi.fn(async () => undefined);
    const service = {
      ...fakeService(before, after),
      probeDraft: async () => ({ ok: false as const, issues: ['provider probe failed'] }),
    };
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      stageSecrets: async () => rollback,
    });

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: before.revisionId,
      secrets: { p: 'candidate-secret' },
    })).resolves.toMatchObject({
      ok: false,
      code: 'probe_failed',
    });
    expect(rollback).toHaveBeenCalledOnce();
    expect(coordinator.getState().activeRevisionId).toBe(before.revisionId);
  });

  it('restores the pointer, live snapshot, and staged secrets when consumer refresh fails', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {
      providers: { p: { baseUrl: 'https://new.example/v1' } },
    });
    let active = before;
    let secretsRestored = false;
    const rollback = vi.fn(async () => {
      secretsRestored = true;
    });
    const restoreActiveSnapshot = vi.fn(async () => {
      active = before;
      return before;
    });
    const failureRecovery = vi.fn(async () => {
      expect(secretsRestored).toBe(true);
    });
    const service = {
      ...fakeService(before, after),
      getActiveSnapshot: async () => active,
      activateDraft: async () => {
        active = after;
        return { ok: true as const, snapshot: after };
      },
      restoreActiveSnapshot,
    };
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      stageSecrets: async () => rollback,
      onActivated: async () => {
        throw new Error('Planner refresh failed');
      },
      onActivationFailed: failureRecovery,
    });

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: before.revisionId,
      secrets: { p: 'candidate-secret' },
    })).resolves.toMatchObject({
      ok: false,
      code: 'activation_failed',
      activeRevisionId: before.revisionId,
    });
    expect(restoreActiveSnapshot).toHaveBeenCalledWith(
      before.revisionId,
      after.revisionId,
    );
    expect(failureRecovery).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
    expect(active.revisionId).toBe(before.revisionId);
    expect(coordinator.getState().activeRevisionId).toBe(before.revisionId);
  });

  it('restores staged secrets even when pointer rollback fails', async () => {
    const before = snapshot('revision-1', {});
    const after = snapshot('revision-2', {
      providers: { p: { baseUrl: 'https://new.example/v1' } },
    });
    const rollback = vi.fn(async () => undefined);
    const service = {
      ...fakeService(before, after),
      restoreActiveSnapshot: async () => {
        throw new Error('pointer rollback failed');
      },
    };
    const coordinator = new ConfigurationRuntimeCoordinator({
      service: service as never,
      gate: new ConfigurationActivationGate(() => ({
        activeTaskId: null,
        plannerTurnActive: false,
        activeAttemptCount: 0,
        activeLeaseCount: 0,
        publicationPending: false,
        recoveryInProgress: false,
      })),
      initialSnapshot: before,
      stageSecrets: async () => rollback,
      onActivated: async () => {
        throw new Error('Planner refresh failed');
      },
    });

    await expect(coordinator.activate({
      config: after.config,
      expectedRevisionId: before.revisionId,
      secrets: { p: 'candidate-secret' },
    })).rejects.toThrow('pointer rollback failed');
    expect(rollback).toHaveBeenCalledOnce();
  });
});
