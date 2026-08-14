import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { SqliteAttemptExecutionRepository } from '../../src/storage/attempt-execution-backend-repo.js';
import { SqliteWorkspaceRepository } from '../../src/storage/workspace-repo.js';
import { TaskCancellationCoordinator } from '../../src/execution/task-cancellation-coordinator.js';
import { seedAgentClasses } from '../support/seed-agent-classes.js';
import type { KernelDecision } from '../../src/kernel/control-kernel.js';
import type { AttemptExecutionBackend, AttemptExecutionRecord } from '../../src/execution/attempt-execution-backend.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';

const authorizedBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-cli',
  providerRef: 'openai',
  modelRef: 'gpt-5-codex',
  permissionProfileRef: 'workspace-engineering',
  configurationRevision: 'configuration_revision_1',
};

describe('TaskCancellationCoordinator', () => {
  it('commits the Task fence first, then drains every attempt, publication, WorkUnit, lease, and execution backend', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    seedConfigurationRevision(db);
    seedAgentClasses(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-task-cancel');
    const taskRuntime = new TaskRuntimeService({ taskEngine, taskRepo });
    const task = taskEngine.create({ id: 'task-cancel', title: 'Cancel', goal: 'Cancel safely' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    const revisions = new WorkGraphRevisionRepo(db);
    revisions.activate({
      id: 'revision-cancel-1',
      taskId: task.id,
      revision: 1,
      generationId: 'generation-cancel-1',
      configurationRevision: authorizedBinding.configurationRevision,
      authorizedDecisionId: null,
      proposalSource: 'initial',
      automaticReplan: false,
      createdAt: now,
      updatedAt: now,
    });
    const subtasks = new SubtaskRepo(db);
    for (const [id, status] of [
      ['done', 'done'],
      ['left', 'running'],
      ['right', 'running'],
      ['pending', 'ready'],
      ['publishing', 'awaiting_integration'],
    ] as const) {
      subtasks.upsert(subtask(task.id, id, status));
    }

    const dispatch = new KernelDispatchItemRepo(db);
    dispatch.insertBatch(
      dispatchDecision(task.id),
      dispatchBindingContext(['left', 'right', 'pending']),
      now,
    );
    const workUnits = new WorkUnitRepo(db);
    for (const suffix of ['left', 'right']) {
      workUnits.upsert({
        id: `wu-${suffix}`,
        agentClassName: 'codex-cli',
        agentClassKind: 'executor',
        state: 'running',
        claimedTaskId: task.id,
        claimedSubtaskId: suffix,
        claimedAttemptId: `attempt-${suffix}`,
        heartbeatAt: now,
        leaseExpiresAt: '2026-07-28T00:01:00.000Z',
        createdAt: now,
        updatedAt: now,
      });
      dispatch.claimPending(`attempt-${suffix}`, now);
      dispatch.markRunning(`attempt-${suffix}`, `wu-${suffix}`, now);
      dispatch.markBackendExecution(`attempt-${suffix}`, `container-${suffix}`, now);
    }

    const leases = new ResourceLeaseService(new SqliteResourceLeaseRepository(db));
    for (const suffix of ['left', 'right']) {
      leases.claim({
        taskId: task.id,
        generationId: 'generation-cancel-1',
        subtaskId: suffix,
        attemptId: `attempt-${suffix}`,
        workUnitId: `wu-${suffix}`,
        leaseToken: `token-${suffix}`,
        claims: [{
          partition: {
            kind: 'path',
            mountId: 'source-task-cancel',
            normalizedRelativePath: suffix,
          },
          access: 'write',
        }],
        now,
      });
    }

    const publications = new WorkspacePublicationRepo(db);
    publications.insertCandidate({
      id: 'publication-cancel',
      taskId: task.id,
      generationId: 'generation-cancel-1',
      subtaskId: 'publishing',
      sourceAttemptId: 'attempt-publishing',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate',
      completion: {
        body: 'candidate',
        artifacts: [],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 3,
      },
      topologyLayer: 0,
      firstDispatchOrder: 4,
      createdAt: now,
    });
    publications.markApplying('publication-cancel', now);

    const executionRepo = new SqliteAttemptExecutionRepository(db);
    const workspaceRepo = new SqliteWorkspaceRepository(db);
    const executionState = new Map<string, AttemptExecutionRecord>();
    for (const suffix of ['left', 'right']) {
      workspaceRepo.upsert({
        id: `workspace-${suffix}`,
        taskId: task.id,
        generationId: 'generation-cancel-1',
        subtaskId: suffix,
        kind: 'git',
        rootUri: `/tmp/workspace-${suffix}`,
        baseline: {},
        managedRepositoryUri: '/tmp/repository.git',
        managedBranch: `subtask/${suffix}`,
        headCommit: null,
        currentCheckpointId: null,
        status: 'active',
        cleanupAfter: null,
        createdAt: now,
        updatedAt: now,
      });
      executionRepo.create({
        attemptId: `attempt-${suffix}`,
        taskId: task.id,
        generationId: 'generation-cancel-1',
        subtaskId: suffix,
        workUnitId: `wu-${suffix}`,
        workspaceId: `workspace-${suffix}`,
        containerId: `container-${suffix}`,
        imageRef: 'metaclaw/codex',
        imageId: 'sha256:test',
        status: 'running',
        leaseToken: `token-${suffix}`,
        labels: {},
        exitCode: null,
        resultCollectedAt: null,
        cleanupStatus: null,
        cleanupError: null,
        createdAt: now,
        updatedAt: now,
      });
      executionState.set(`container-${suffix}`, {
        containerId: `container-${suffix}`,
        imageId: 'sha256:test',
        status: 'running',
        exitCode: null,
        labels: {},
      });
    }
    const backend: AttemptExecutionBackend = {
      resolveImage: vi.fn(),
      create: vi.fn(),
      start: vi.fn(),
      wait: vi.fn(),
      logs: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      listManaged: vi.fn(),
      stop: vi.fn(async containerId => {
        executionState.set(containerId, {
          ...executionState.get(containerId)!,
          status: 'exited',
          exitCode: 137,
        });
      }),
      inspect: vi.fn(async containerId => executionState.get(containerId) ?? null),
      remove: vi.fn(async containerId => { executionState.delete(containerId); }),
    } as AttemptExecutionBackend;
    const abortAttempt = vi.fn().mockReturnValue(true);
    const coordinator = new TaskCancellationCoordinator({
      db,
      taskRuntimeService: taskRuntime,
      subtaskRepo: subtasks,
      taskEventRepo: new TaskEventRepo(db),
      workGraphRevisionRepo: revisions,
      dispatchItemRepo: dispatch,
      publicationRepo: publications,
      generationReplanRepo: new GenerationReplanRequestRepo(db),
      resourceLeaseService: leases,
      workUnitClaimService: new WorkUnitClaimService(workUnits),
      activeExecutions: { abortAttempt, abortTask: vi.fn() },
      attemptExecutionBackend: backend,
      attemptExecutionRepository: executionRepo,
    });
    const decision: KernelDecision = {
      schemaVersion: 5,
      id: 'decision-task-cancel',
      eventId: 'event-task-cancel',
      reason: 'user requested cancellation',
      configurationRevision: authorizedBinding.configurationRevision,
      action: {
        type: 'cancel_task',
        taskId: task.id,
        generationId: 'generation-cancel-1',
      },
    };

    const receipt = coordinator.apply(decision as Parameters<typeof coordinator.apply>[0]);

    expect(taskRepo.findById(task.id)?.status).toBe('cancelled');
    expect(subtasks.findById('done')?.status).toBe('done');
    expect(receipt.cleanupAttemptIds).toEqual(['attempt-left', 'attempt-right']);
    expect(dispatch.find('attempt-pending')?.status).toBe('cancelled');
    expect(dispatch.find('attempt-left')?.status).toBe('cancelling');
    expect(publications.find('publication-cancel')?.status).toBe('cancelling');
    expect(abortAttempt).toHaveBeenCalledTimes(2);

    await coordinator.recover(task.id);

    expect(dispatch.find('attempt-left')?.status).toBe('cancelled');
    expect(dispatch.find('attempt-right')?.status).toBe('cancelled');
    expect(publications.find('publication-cancel')?.status).toBe('cancelled');
    expect(workUnits.findById('wu-left')?.claimedAttemptId).toBeNull();
    expect(new SqliteResourceLeaseRepository(db).findActive(now)).toEqual([]);
    expect(executionRepo.listActive()).toEqual([]);
    expect(coordinator.completionBlockedReasons(task.id, 'generation-cancel-1')).toEqual([]);
  });

  it('cancels an atomic downstream closure while leaving an independent sibling dispatch untouched', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    seedConfigurationRevision(db);
    seedAgentClasses(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-subtask-cancel');
    const taskRuntime = new TaskRuntimeService({ taskEngine, taskRepo });
    const task = taskEngine.create({
      id: 'task-subtask-cancel',
      title: 'Cancel one branch',
      goal: 'Keep the sibling alive',
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    const revisions = new WorkGraphRevisionRepo(db);
    revisions.activate({
      id: 'revision-subtask-cancel',
      taskId: task.id,
      revision: 1,
      generationId: 'generation-cancel-1',
      configurationRevision: authorizedBinding.configurationRevision,
      authorizedDecisionId: null,
      proposalSource: 'initial',
      automaticReplan: false,
      createdAt: now,
      updatedAt: now,
    });
    const subtasks = new SubtaskRepo(db);
    subtasks.upsert(subtask(task.id, 'root', 'running'));
    subtasks.upsert({
      ...subtask(task.id, 'downstream', 'ready'),
      dependencies: [{
        fromSubtaskId: 'root',
        requiredHandoff: [{ key: 'root-result', type: 'text' as const }],
      }],
    });
    subtasks.upsert(subtask(task.id, 'sibling', 'running'));
    const dispatch = new KernelDispatchItemRepo(db);
    dispatch.insertBatch({
      schemaVersion: 5,
      id: 'decision-subtask-dispatch',
      eventId: 'event-subtask-dispatch',
      reason: 'test',
      configurationRevision: authorizedBinding.configurationRevision,
      action: {
        type: 'dispatch_batch',
        taskId: task.id,
        items: ['root', 'sibling'].map((id, order) => ({
          subtaskId: id,
          agentClassName: 'codex-cli',
          authorizedBinding,
          bindingFingerprint: `sha256:${id}`,
          attemptId: `attempt-${id}`,
          attemptKind: 'primary' as const,
          sourceAttemptId: null,
          recoveryMode: 'fresh' as const,
          defaultResourceGrant: [],
          order,
          attemptPayload: null,
        })),
      },
    }, dispatchBindingContext(['root', 'sibling']), now);
    const abortAttempt = vi.fn();
    const coordinator = new TaskCancellationCoordinator({
      db,
      taskRuntimeService: taskRuntime,
      subtaskRepo: subtasks,
      taskEventRepo: new TaskEventRepo(db),
      workGraphRevisionRepo: revisions,
      dispatchItemRepo: dispatch,
      publicationRepo: new WorkspacePublicationRepo(db),
      generationReplanRepo: new GenerationReplanRequestRepo(db),
      resourceLeaseService: new ResourceLeaseService(new SqliteResourceLeaseRepository(db)),
      workUnitClaimService: new WorkUnitClaimService(new WorkUnitRepo(db)),
      activeExecutions: { abortAttempt, abortTask: vi.fn() },
      attemptExecutionBackend: {} as AttemptExecutionBackend,
      attemptExecutionRepository: new SqliteAttemptExecutionRepository(db),
    });

    expect(coordinator.buildSnapshot(task.id).subtasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'root',
        executorBindings: [authorizedBinding],
      }),
      expect.objectContaining({
        id: 'downstream',
        executorBindings: [authorizedBinding],
      }),
      expect.objectContaining({
        id: 'sibling',
        executorBindings: [authorizedBinding],
      }),
    ]));

    coordinator.apply({
      schemaVersion: 5,
      id: 'decision-subtask-cancel',
      eventId: 'event-subtask-cancel',
      reason: 'cancel root branch',
      action: {
        type: 'cancel_subtasks',
        taskId: task.id,
        generationId: 'generation-cancel-1',
        graphRevision: 1,
        subtaskIds: ['downstream', 'root'],
        expectedStatuses: [
          { subtaskId: 'downstream', status: 'ready' },
          { subtaskId: 'root', status: 'running' },
        ],
      },
    });

    expect(subtasks.findById('root')?.status).toBe('cancelled');
    expect(subtasks.findById('downstream')?.status).toBe('cancelled');
    expect(subtasks.findById('sibling')?.status).toBe('running');
    expect(dispatch.find('attempt-root')?.status).toBe('cancelled');
    expect(dispatch.find('attempt-sibling')?.status).toBe('pending_launch');
    expect(taskRepo.findById(task.id)?.status).toBe('running');
    expect(abortAttempt).not.toHaveBeenCalled();
  });
});

const now = '2026-07-28T00:00:00.000Z';

function seedConfigurationRevision(db: Database.Database): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', ?)
  `).run(
    authorizedBinding.configurationRevision,
    'sha256:test-configuration',
    now,
  );
}

function dispatchBindingContext(ids: string[]) {
  return {
    generationId: 'generation-cancel-1',
    configurationRevision: authorizedBinding.configurationRevision,
    attempts: Object.fromEntries(ids.map(id => [
      `attempt-${id}`,
      {
        authorizedBinding,
        bindingFingerprint: `sha256:${id}`,
      },
    ])),
  };
}

function subtask(
  taskId: string,
  id: string,
  status: 'ready' | 'running' | 'awaiting_integration' | 'done',
) {
  return {
    id,
    taskId,
    graphRevision: 1,
    generationId: 'generation-cancel-1',
    title: id,
    goal: id,
    status,
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'] as const,
    executorBindings: [authorizedBinding],
    deliveryKind: 'report' as const,
    acceptance: [],
    riskLevel: 'low' as const,
    result: status === 'done' ? 'done' : '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: status === 'done' ? 2 : null },
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

function dispatchDecision(taskId: string): KernelDecision & {
  action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
} {
  return {
    schemaVersion: 5,
    id: 'decision-dispatch-cancel',
    eventId: 'event-dispatch-cancel',
    reason: 'test',
    configurationRevision: authorizedBinding.configurationRevision,
    action: {
      type: 'dispatch_batch',
      taskId,
      items: ['left', 'right', 'pending'].map((id, order) => ({
        subtaskId: id,
        agentClassName: 'codex-cli',
        authorizedBinding,
        bindingFingerprint: `sha256:${id}`,
        attemptId: `attempt-${id}`,
        attemptKind: 'primary' as const,
        sourceAttemptId: null,
        recoveryMode: 'fresh' as const,
        defaultResourceGrant: [],
        order,
        attemptPayload: null,
      })),
    },
  };
}