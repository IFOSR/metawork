import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAccountRuntimeComposition } from '../../src/account/account-runtime-composition.js';
import type { AccountKernelCoordinator } from '../../src/account/account-kernel-coordinator.js';
import { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import { buildStagedLegacyConfiguration } from '../../src/configuration/staged-legacy-configuration.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { buildDefaultResourceClaims } from '../../src/resource/index.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { builtinCodexAgentClass } from '../support/builtin-agent-classes.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('AccountStartupRecoveryService production composition', () => {
  it('recovers the account Kernel coordinator before exposing the Runtime', async () => {
    let recoverCalls = 0;
    const coordinator: AccountKernelCoordinator = {
      submit: async () => ({ decisions: [], quiescent: true, pendingRecovery: 0 }),
      recover: async () => {
        recoverCalls += 1;
        return {
          decisions: [],
          quiescent: true,
          pendingRecovery: 0,
          reconciledProcessingEvents: 0,
          applicationCounts: {
            pending: 0,
            applying: 0,
            applied: 0,
            uncertain: 0,
            failed: 0,
          },
        };
      },
    };
    const fixture = createFixture('kernel-coordinator', coordinator);

    await fixture.composition.accountRuntime.initialize();

    expect(recoverCalls).toBe(1);
  });

  it('quarantines the account and preserves its claim when backend inspection fails', async () => {
    const fixture = createFixture('backend-failure');
    const task = createRunningTask(fixture, 'Preserve backend ownership');
    new AgentClassRepo(fixture.db).upsert(builtinCodexAgentClass());
    const workUnits = new WorkUnitRepo(fixture.db);
    workUnits.upsert(claimedWorkUnit(task.id, `${task.id}_execute`, 'attempt-backend-failure'));
    fixture.backend.listManaged.mockRejectedValue(new Error('backend unavailable'));
    const registry = new RuntimeRegistry({
      factory: { create: () => fixture.composition.accountRuntime },
    });

    await expect(registry.getOrActivate({
      accountId: 'local-default',
      authorized: true,
    })).rejects.toThrow('backend unavailable');

    expect(registry.getIfLoaded('local-default')).toBeNull();
    expect(workUnits.findById('executor-attempt-backend-failure')).toMatchObject({
      state: 'running',
      claimedTaskId: task.id,
      claimedSubtaskId: `${task.id}_execute`,
      claimedAttemptId: 'attempt-backend-failure',
    });
  });

  it('does not release a claim or lease before terminal facts are sealed', async () => {
    const fixture = createFixture('terminal-seal');
    const task = createRunningTask(fixture, 'Preserve terminal ownership');
    const subtaskRepo = new SubtaskRepo(fixture.db);
    const subtask = subtaskRepo.listActiveByTask(task.id)[0]!;
    subtaskRepo.updateStatus(subtask.id, 'running');
    new AgentClassRepo(fixture.db).upsert(builtinCodexAgentClass());

    const attemptId = 'attempt-terminal-seal';
    const workUnitId = `executor-${attemptId}`;
    const workUnits = new WorkUnitRepo(fixture.db);
    workUnits.upsert(claimedWorkUnit(task.id, subtask.id, attemptId));
    const binding = subtask.executorBindings[0]!;
    const bindingFingerprint = authorizedExecutorBindingFingerprint(binding);
    const resourceGrant = buildDefaultResourceClaims({
      workspaceId: `workspace-${task.id}-${subtask.generationId}-${subtask.id}`,
      sourceMountId: `source-${task.id}`,
      inputsMountId: `inputs-${task.id}`,
      handoffsMountId: `handoffs-${task.id}`,
      gitMetadataMountId: `git-${task.id}`,
    });
    seedDispatch(fixture.db, {
      taskId: task.id,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId,
      binding,
      bindingFingerprint,
      resourceGrant,
      sessionId: 'conversation-origin',
    });
    const leaseRepo = new SqliteResourceLeaseRepository(fixture.db);
    new ResourceLeaseService(leaseRepo).claim({
      taskId: task.id,
      generationId: subtask.generationId,
      subtaskId: subtask.id,
      attemptId,
      workUnitId,
      claims: resourceGrant,
      leaseToken: 'lease-terminal-seal',
      now: '2099-01-01T00:00:00.000Z',
    });
    fixture.db.exec(`
      CREATE TRIGGER reject_account_recovery_terminal_receipt
      BEFORE INSERT ON executor_attempt_receipts
      WHEN NEW.attempt_id = 'attempt-terminal-seal'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal seal failure');
      END
    `);

    await expect(fixture.composition.accountRuntime.initialize())
      .rejects.toThrow('injected terminal seal failure');

    expect(workUnits.findById(workUnitId)).toMatchObject({
      state: 'running',
      claimedAttemptId: attemptId,
    });
    expect(leaseRepo.findActive('2026-08-19T00:00:00.000Z'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ attemptId, releasedAt: null }),
      ]));
    expect(new KernelDispatchItemRepo(fixture.db).find(attemptId)?.status).toBe('running');
  });

  it('quarantines a running Task that has no authorized dispatch identity', async () => {
    const fixture = createFixture('missing-dispatch');
    const task = createRunningTask(fixture, 'Missing authorized dispatch');

    await expect(fixture.composition.accountRuntime.initialize())
      .rejects.toThrow(`startup recovery cannot resolve Conversation origin for Task ${task.id}`);
  });
});

function createFixture(name: string, coordinator?: AccountKernelCoordinator) {
  const root = mkdtempSync(join(tmpdir(), `anyfusion-account-recovery-${name}-`));
  roots.push(root);
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskEngine = new TaskEngine(new TaskRepo(db), join(root, 'snapshots'));
  const backend = new FakeAttemptExecutionBackend();
  const staged = buildStagedLegacyConfiguration({ testMode: true });
  const composition = buildAccountRuntimeComposition({
    accountId: 'local-default',
    db,
    taskEngine,
    memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
    orchestration: new OrchestrationEngine(taskEngine),
    contextRecaller: new ContextRecaller(db),
    notifier: { notifyTaskCompleted: async () => undefined },
    workspaceRoot: join(root, 'workspaces'),
    attemptsRoot: join(root, 'attempts'),
    sourceRoot: root,
    sessionId: 'bootstrap-session',
    stagedConfiguration: staged,
    plannerBinding: staged.plannerBinding,
    plannerBindingFingerprint: staged.plannerBindingFingerprint,
    getRuntimeBinding: binding => ({
      revisionId: binding.configurationRevision,
      bindingFingerprint: authorizedExecutorBindingFingerprint(binding),
      environment: {},
    }),
    attemptExecutionBackend: backend,
    getConfigurationRevision: () => staged.snapshot.revisionId,
    ...(coordinator ? { buildKernelCoordinator: () => coordinator } : {}),
  });
  return { root, db, taskEngine, backend, composition };
}

function createRunningTask(
  fixture: ReturnType<typeof createFixture>,
  goal: string,
) {
  const task = fixture.taskEngine.create({ title: goal, goal });
  seedPersistedWorkGraph(fixture.db, task.id, goal);
  fixture.taskEngine.transition(task.id, 'ready');
  fixture.taskEngine.transition(task.id, 'running');
  return task;
}

function claimedWorkUnit(taskId: string, subtaskId: string, attemptId: string) {
  return {
    id: `executor-${attemptId}`,
    agentClassName: 'codex-cli',
    agentClassKind: 'executor' as const,
    state: 'running' as const,
    claimedTaskId: taskId,
    claimedSubtaskId: subtaskId,
    claimedAttemptId: attemptId,
    heartbeatAt: '2099-01-01T00:00:00.000Z',
    leaseExpiresAt: '2099-01-01T00:10:00.000Z',
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  };
}

function seedDispatch(
  db: Database.Database,
  input: {
    taskId: string;
    generationId: string;
    subtaskId: string;
    attemptId: string;
    workUnitId: string;
    binding: ReturnType<SubtaskRepo['findById']>['executorBindings'][number];
    bindingFingerprint: string;
    resourceGrant: ReturnType<typeof buildDefaultResourceClaims>;
    sessionId: string;
  },
): void {
  const now = '2026-08-19T00:00:00.000Z';
  const decision = {
    schemaVersion: 5 as const,
    configurationRevision: input.binding.configurationRevision,
    id: `decision-${input.attemptId}`,
    eventId: `event-${input.attemptId}`,
    reason: 'persisted authorized attempt',
    action: {
      type: 'dispatch_batch' as const,
      taskId: input.taskId,
      items: [{
        order: 0,
        subtaskId: input.subtaskId,
        attemptId: input.attemptId,
        authorizedBinding: input.binding,
        bindingFingerprint: input.bindingFingerprint,
        attemptKind: 'fallback' as const,
        sourceAttemptId: 'attempt-primary',
        recoveryMode: 'recovery_packet' as const,
        attemptPayload: null,
        defaultResourceGrant: input.resourceGrant,
      }],
    },
  };
  const dispatch = new KernelDispatchItemRepo(db);
  dispatch.insertBatch(decision, {
    generationId: input.generationId,
    configurationRevision: input.binding.configurationRevision,
    attempts: {
      [input.attemptId]: {
        authorizedBinding: input.binding,
        bindingFingerprint: input.bindingFingerprint,
      },
    },
  }, now);
  dispatch.claimPending(input.attemptId, now);
  dispatch.markRunning(input.attemptId, input.workUnitId, now);
  db.prepare(`
    INSERT INTO kernel_decisions (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    ) VALUES (?, 5, ?, 'dispatch_requested', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decision.id,
    decision.eventId,
    decision.eventId,
    input.sessionId,
    input.taskId,
    input.subtaskId,
    input.attemptId,
    JSON.stringify({
      schemaVersion: 5,
      configurationRevision: input.binding.configurationRevision,
      type: 'dispatch_requested',
      id: decision.eventId,
      correlationId: decision.eventId,
      causationId: null,
      occurredAt: now,
      sessionId: input.sessionId,
      taskId: input.taskId,
      reason: 'fixture',
    }),
    JSON.stringify({ schemaVersion: 5, type: 'invalid', reason: 'fixture' }),
    JSON.stringify(decision),
    decision.action.type,
    decision.reason,
    decision.configurationRevision,
    JSON.stringify([input.binding]),
    JSON.stringify([input.bindingFingerprint]),
    now,
  );
}
