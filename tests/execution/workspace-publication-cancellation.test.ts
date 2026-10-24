import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { WorkspacePublicationWorker } from '../../src/execution/workspace-publication-worker.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { ResultObjectRepo } from '../../src/storage/result-object-repo.js';
import { SubtaskHandoffRepo } from '../../src/storage/subtask-handoff-repo.js';
import { pathToFileURL } from 'node:url';
import { setTaskStatus, recordingTaskLifecyclePort } from '../support/task-state-fixture.js';

const configurationRevision = 'configuration-revision-publication';
const publicationBinding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-cli',
  providerRef: 'openai',
  modelRef: 'gpt-5-codex',
  permissionProfileRef: 'workspace-engineering',
  configurationRevision,
};

describe('WorkspacePublicationWorker cancellation fence', () => {
  it('publishes one edge-scoped ResultReference without copying the upstream body', async () => {
    const resultRoot = mkdtempSync(join(tmpdir(), 'metawork-publication-results-'));
    try {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-result-reference');
      const taskRuntime = new TaskRuntimeService({
      lifecyclePort: recordingTaskLifecyclePort().port,
        taskEngine,
        taskRepo: new TaskRepo(db),
      });
      const task = taskEngine.create({
        id: 'task-publication-reference',
        title: 'Publication reference',
        goal: 'Publish an authorized result reference',
      });
      setTaskStatus(db, task.id, 'queued');
      setTaskStatus(db, task.id, 'running');
      insertConfigurationRevision(db, configurationRevision);
      activateGraphRevision(
        db,
        task.id,
        'generation-publication-reference',
        configurationRevision,
      );
      const subtasks = new SubtaskRepo(db);
      subtasks.upsert({
        id: 'source-publication-reference',
        taskId: task.id,
        graphRevision: 1,
        generationId: 'generation-publication-reference',
        title: 'Source',
        goal: 'Produce the upstream result',
        status: 'awaiting_integration',
        dependencies: [],
        contextRefs: [],
        requiredCapabilities: ['workspace-engineering'],
        executorBindings: [publicationBinding],
        deliveryKind: 'report',
        acceptance: [],
        riskLevel: 'low',
        result: '',
        artifacts: [],
        verification: { warnings: [], completionSchemaVersion: null },
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      subtasks.upsert({
        id: 'target-publication-reference',
        taskId: task.id,
        graphRevision: 1,
        generationId: 'generation-publication-reference',
        title: 'Target',
        goal: 'Consume the upstream result',
        status: 'ready',
        dependencies: [{
          fromSubtaskId: 'source-publication-reference',
          requiredItems: [{ key: 'summary', type: 'text', description: 'Upstream summary' }],
        }],
        contextRefs: [],
        requiredCapabilities: ['workspace-engineering'],
        executorBindings: [publicationBinding],
        deliveryKind: 'report',
        acceptance: [],
        riskLevel: 'low',
        result: '',
        artifacts: [],
        verification: { warnings: [], completionSchemaVersion: null },
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      const fullBody = `complete upstream body ${'x'.repeat(20_000)}`;
      const result = new ResultObjectRepo(db, resultRoot).putObject({
        resultId: 'result-source-safe',
        accountId: 'local-default',
        taskId: task.id,
        generationId: 'generation-publication-reference',
        sourceSubtaskId: 'source-publication-reference',
        attemptId: 'attempt-source-reference',
        kind: 'safe_projection',
        mediaType: 'text/markdown',
        content: fullBody,
        completeness: 'complete',
        retentionClass: 'task',
      });
      const publications = new WorkspacePublicationRepo(db);
      publications.insertCandidate({
        id: 'publication-result-reference',
        taskId: task.id,
        generationId: 'generation-publication-reference',
        subtaskId: 'source-publication-reference',
        sourceAttemptId: 'attempt-source-reference',
        agentClassName: 'codex-cli',
        candidateCommit: 'candidate-commit',
        completion: {
          body: fullBody,
          artifacts: [],
          warnings: [],
          handoffs: [{
            toSubtaskId: 'target-publication-reference',
            items: [{ key: 'summary', type: 'text', value: fullBody }],
          }],
          completionSchemaVersion: 4,
        },
        topologyLayer: 0,
        firstDispatchOrder: 0,
        createdAt: now,
      });
      const worker = new WorkspacePublicationWorker({
        db,
        sessionId: 'session-publication-reference',
        accountId: 'local-default',
        resultRoot,
        sourceRoot: '/tmp/source',
        workspaceStore: { rootPath: '/tmp/workspace-publication-test' } as never,
        workspaceRepository: {
          findByIdentity: vi.fn().mockReturnValue(null),
        } as never,
        subtaskRepo: subtasks,
        attemptReceiptRepo: {
          findByAttemptId: vi.fn().mockReturnValue({
            attemptId: 'attempt-source-reference',
            taskId: task.id,
            subtaskId: 'source-publication-reference',
            generationId: 'generation-publication-reference',
            workUnitId: 'work-unit-source',
            configurationRevision,
            authorizedBinding: publicationBinding,
            bindingFingerprint: 'binding-fingerprint-publication',
            parsing: {
              resultObjects: {
                rawOutputId: 'result-source-raw',
                businessResultId: 'result-source-business',
                safeProjectionId: result.resultId,
              },
            },
          }),
        } as never,
        resourceLeaseService: {
          claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
          release: vi.fn(),
        } as never,
        dispatchItemRepo: {
          listByTask: vi.fn().mockReturnValue([]),
        } as never,
        taskRuntimeService: taskRuntime,
      });
      Object.defineProperty(worker, 'git', {
        value: {
          ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
          describeCandidate: vi.fn().mockResolvedValue({
            changedPaths: [],
            filePolicy: {},
          }),
          mergeCandidate: vi.fn().mockResolvedValue({
            type: 'integrated',
            baseCommit: 'base',
            oursCommit: 'ours',
            theirsCommit: 'theirs',
            integrationCommit: 'integration-commit',
            filePolicy: {},
          }),
        },
      });

      const outcomes = await worker.drain(task.id, 'generation-publication-reference');

      expect(outcomes).toEqual([expect.objectContaining({
        type: 'integrated',
        resultId: result.resultId,
      })]);
      const handoff = new SubtaskHandoffRepo(db).listIncoming(
        task.id,
        'target-publication-reference',
      )[0]!;
      expect(handoff.resultReference).toMatchObject({
        resultId: result.resultId,
        sourceSubtaskId: 'source-publication-reference',
        targetSubtaskId: 'target-publication-reference',
        requiredItems: ['summary'],
        contentHash: result.contentHash,
        byteLength: result.byteLength,
      });
      expect(handoff.items).toEqual([expect.objectContaining({
        key: 'summary',
        type: 'result_reference',
        referenceId: handoff.resultReference!.referenceId,
      })]);
      const stored = db.prepare(`
        SELECT items_json FROM subtask_handoffs
        WHERE task_id = ? AND to_subtask_id = ?
      `).get(task.id, 'target-publication-reference') as { items_json: string };
      expect(stored.items_json).not.toContain(fullBody);
      expect(db.prepare('SELECT COUNT(*) AS count FROM result_references').get())
        .toEqual({ count: 1 });
    } finally {
      rmSync(resultRoot, { recursive: true, force: true });
    }
  });

  it('does not let a stale dispatch order deadlock recovered publications', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-recovery-order');
    const taskRuntime = new TaskRuntimeService({ lifecyclePort: recordingTaskLifecyclePort().port, taskEngine, taskRepo: new TaskRepo(db) });
    const task = taskEngine.create({
      id: 'task-publication-recovery-order',
      title: 'Recovered publication order',
      goal: 'Publish recovered branches',
    });
    setTaskStatus(db, task.id, 'queued');
    setTaskStatus(db, task.id, 'running');
    insertConfigurationRevision(db, configurationRevision);
    activateGraphRevision(db, task.id, 'generation-publication-recovery-order', configurationRevision);
    const subtasks = new SubtaskRepo(db);
    subtasks.upsert({
      id: 'recovered-stale',
      taskId: task.id,
      graphRevision: 1,
      generationId: 'generation-publication-recovery-order',
      title: 'Superseded publication',
      goal: 'Must not block the replacement revision',
      status: 'cancelled',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [publicationBinding],
      deliveryKind: 'report',
      acceptance: [],
      riskLevel: 'low',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: 'superseded by graph revision 2',
      createdAt: now,
      updatedAt: now,
    });
    for (const [id, status] of [
      ['recovered-early', 'awaiting_integration' as const],
      ['recovered-late', 'awaiting_integration' as const],
    ] as const) {
      subtasks.upsert({
        id,
        taskId: task.id,
        graphRevision: 1,
        generationId: 'generation-publication-recovery-order',
        title: id,
        goal: 'Publish branch',
        status,
        dependencies: [],
        contextRefs: [],
        requiredCapabilities: ['workspace-engineering'],
        executorBindings: [publicationBinding],
        deliveryKind: 'report',
        acceptance: [],
        riskLevel: 'low',
        result: '',
        artifacts: [],
        verification: { warnings: [], completionSchemaVersion: null },
        error: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    const userWorkspaceRoot = mkdtempSync(join(tmpdir(), 'metawork-publication-user-workspace-'));
    const publications = new WorkspacePublicationRepo(db);
    publications.insertCandidate({
      id: 'publication-recovered-stale',
      taskId: task.id,
      generationId: 'generation-publication-recovery-order',
      subtaskId: 'recovered-stale',
      sourceAttemptId: 'attempt-recovered-stale',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate-recovered-stale',
      completion: {
        body: 'superseded result',
        artifacts: [],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 4,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    db.prepare(`UPDATE workspace_publications SET status = 'parked' WHERE id = ?`)
      .run('publication-recovered-stale');
    for (const [subtaskId, attemptId, order] of [
      ['recovered-early', 'attempt-recovered-early', 10],
      ['recovered-late', 'attempt-recovered-late', 11],
    ] as const) {
      publications.insertCandidate({
        id: `publication-${subtaskId}`,
        taskId: task.id,
        generationId: 'generation-publication-recovery-order',
        subtaskId,
        sourceAttemptId: attemptId,
        agentClassName: 'codex-cli',
        candidateCommit: `candidate-${subtaskId}`,
        completion: {
          body: `${subtaskId} result`,
          artifacts: [],
          warnings: [],
          handoffs: [],
          completionSchemaVersion: 4,
        },
        topologyLayer: 0,
        firstDispatchOrder: order,
        createdAt: now,
      });
    }
    const worker = new WorkspacePublicationWorker({
      db,
      sessionId: 'session-publication-recovery-order',
      accountId: 'local-default',
      resultRoot: '/tmp/publication-recovery-order-results',
      sourceRoot: '/tmp/source',
      workspaceStore: { rootPath: '/tmp/workspace-publication-recovery-order' } as never,
      workspaceRepository: { findByIdentity: vi.fn().mockReturnValue(null) } as never,
      subtaskRepo: subtasks,
      attemptReceiptRepo: {
        findByAttemptId: vi.fn((attemptId: string) => ({
          attemptId,
          taskId: task.id,
          subtaskId: attemptId.replace('attempt-', ''),
          generationId: 'generation-publication-recovery-order',
          workUnitId: `work-${attemptId}`,
          configurationRevision,
          authorizedBinding: publicationBinding,
          bindingFingerprint: `binding-${attemptId}`,
        })),
      } as never,
      resourceLeaseService: {
        claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
        release: vi.fn(),
      } as never,
      // The old attempt for recovered-early had batch order 0. It is terminal
      // and has already been replaced by the publication at order 10.
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([{
          subtaskId: 'recovered-early',
          generationId: 'generation-publication-recovery-order',
          batchOrder: 0,
          status: 'uncertain',
        }]),
      } as never,
      taskRuntimeService: taskRuntime,
    });
    Object.defineProperty(worker, 'git', {
      value: {
        withCommitSnapshot: async (workspace: { filesPath: string }, _commit: string, read: (root: string) => Promise<unknown>) => read(workspace.filesPath),
        ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
        describeCandidate: vi.fn().mockResolvedValue({ changedPaths: [], filePolicy: {} }),
        mergeCandidate: vi.fn().mockResolvedValue({
          type: 'integrated',
          baseCommit: 'base',
          oursCommit: 'ours',
          theirsCommit: 'theirs',
          integrationCommit: 'integration-commit',
          filePolicy: {},
        }),
      },
    });

    const outcomes = await worker.drain(task.id, 'generation-publication-recovery-order');

    expect(outcomes.map(outcome => outcome.type)).toEqual(['integrated', 'integrated']);
    expect(publications.find('publication-recovered-stale')?.status).toBe('cancelled');
    expect(publications.find('publication-recovered-early')?.status).toBe('integrated');
    expect(publications.find('publication-recovered-late')?.status).toBe('integrated');
  });

  it.each(['merge', 'delivery'] as const)('does not finish or release handoffs when cancellation wins during %s', async stage => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-cancel');
    const taskRuntime = new TaskRuntimeService({
      lifecyclePort: recordingTaskLifecyclePort().port,
      taskEngine,
      taskRepo: new TaskRepo(db),
    });
    const task = taskEngine.create({
      id: 'task-publication-cancel',
      title: 'Publication cancellation',
      goal: 'Do not publish after cancellation',
    });
    setTaskStatus(db, task.id, 'queued');
    setTaskStatus(db, task.id, 'running');
    insertConfigurationRevision(db, configurationRevision);
    activateGraphRevision(
      db,
      task.id,
      'generation-publication-cancel',
      configurationRevision,
    );
    const subtasks = new SubtaskRepo(db);
    subtasks.upsert({
      id: 'subtask-publication-cancel',
      taskId: task.id,
      graphRevision: 1,
      generationId: 'generation-publication-cancel',
      title: 'Candidate',
      goal: 'Publish candidate',
      status: 'awaiting_integration',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [publicationBinding],
      deliveryKind: 'report',
      acceptance: [],
      riskLevel: 'low',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const userWorkspaceRoot = mkdtempSync(join(tmpdir(), 'metawork-publication-user-workspace-'));
    const publications = new WorkspacePublicationRepo(db);
    publications.insertCandidate({
      id: 'publication-cancel-race',
      taskId: task.id,
      generationId: 'generation-publication-cancel',
      subtaskId: 'subtask-publication-cancel',
      sourceAttemptId: 'attempt-source',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate-commit',
      completion: {
        body: 'must not become visible',
        artifacts: ['result.md'],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 3,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    const release = vi.fn();
    const cancel = () => {
      publications.requestCancellation({ taskId: task.id, generationId: 'generation-publication-cancel',
        subtaskIds: ['subtask-publication-cancel'], decisionId: 'decision-cancel-race', now });
      setTaskStatus(db, task.id, 'cancelled');
    };
    const worker = new WorkspacePublicationWorker({
      db,
      sessionId: 'session-publication-cancel',
      resultRoot: '/tmp/workspace-publication-cancel-results',
      sourceRoot: '/tmp/source',
      workspaceStore: { rootPath: '/tmp/workspace-publication-test' } as never,
      workspaceRepository: {
        findByIdentity: vi.fn().mockReturnValue(null),
      } as never,
      subtaskRepo: subtasks,
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue({
          attemptId: 'attempt-source',
          taskId: task.id,
          subtaskId: 'subtask-publication-cancel',
          generationId: 'generation-publication-cancel',
          workUnitId: 'work-unit-source',
          configurationRevision,
          authorizedBinding: publicationBinding,
          bindingFingerprint: 'binding-fingerprint-publication',
        }),
      } as never,
      resourceLeaseService: {
        claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
        release,
      } as never,
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([]),
      } as never,
      taskRuntimeService: taskRuntime,
      // Delivery writes into the user Workspace, so a real root is required.
      resolveUserWorkspaceRoot: async () => userWorkspaceRoot,
      userArtifactPublication: { publishIntegratedArtifacts: vi.fn(async () => {
        cancel();
        return { projections: [], failures: [] };
      }) } as never,
    });
    Object.defineProperty(worker, 'git', {
      value: {
        withCommitSnapshot: async (workspace: { filesPath: string }, _commit: string, read: (root: string) => Promise<unknown>) => read(workspace.filesPath),
        ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
        describeCandidate: vi.fn().mockResolvedValue({
          changedPaths: [],
          filePolicy: {},
        }),
        mergeCandidate: vi.fn(async () => {
          if (stage === 'merge') cancel();
          return {
            type: 'integrated',
            baseCommit: 'base',
            oursCommit: 'ours',
            theirsCommit: 'theirs',
            integrationCommit: 'observed-integration-commit',
            filePolicy: {},
          };
        }),
      },
    });

    const outcomes = await worker.drain(task.id, 'generation-publication-cancel');

    expect(outcomes).toEqual([{
      type: 'cancelled',
      publicationId: 'publication-cancel-race',
      taskId: task.id,
      subtaskId: 'subtask-publication-cancel',
      observedIntegrationCommit: 'observed-integration-commit',
    }]);
    expect(publications.find('publication-cancel-race')).toMatchObject({
      status: stage === 'merge' ? 'cancelled' : 'integrated',
      integrationCommit: stage === 'merge' ? null : 'observed-integration-commit',
    });
    expect(subtasks.findById('subtask-publication-cancel')).toMatchObject({
      status: 'awaiting_integration',
      result: '',
      artifacts: [],
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({
      count: 0,
    });
    // The integration lease is always released. A delivery lease only exists
    // when the merge reached the delivery stage.
    expect(release.mock.calls.length).toBe(stage === 'merge' ? 1 : 2);
  });

  it('emits merge conflict identity from the persisted source attempt receipt', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-conflict');
    const taskRuntime = new TaskRuntimeService({
      lifecyclePort: recordingTaskLifecyclePort().port,
      taskEngine,
      taskRepo: new TaskRepo(db),
    });
    const task = taskEngine.create({
      id: 'task-publication-conflict',
      title: 'Publication conflict',
      goal: 'Preserve source attempt binding',
    });
    setTaskStatus(db, task.id, 'queued');
    setTaskStatus(db, task.id, 'running');
    const sourceConfigurationRevision = 'configuration-revision-source';
    insertConfigurationRevision(db, sourceConfigurationRevision);
    activateGraphRevision(
      db,
      task.id,
      'generation-publication-conflict',
      sourceConfigurationRevision,
    );
    const subtasks = new SubtaskRepo(db);
    subtasks.upsert({
      id: 'subtask-publication-conflict',
      taskId: task.id,
      graphRevision: 1,
      generationId: 'generation-publication-conflict',
      title: 'Candidate',
      goal: 'Publish candidate',
      status: 'awaiting_integration',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [{
        ...publicationBinding,
        configurationRevision: sourceConfigurationRevision,
      }],
      deliveryKind: 'report',
      acceptance: [],
      riskLevel: 'low',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const publications = new WorkspacePublicationRepo(db);
    publications.insertCandidate({
      id: 'publication-conflict',
      taskId: task.id,
      generationId: 'generation-publication-conflict',
      subtaskId: 'subtask-publication-conflict',
      sourceAttemptId: 'attempt-source',
      agentClassName: 'stale-publication-agent-class',
      candidateCommit: 'candidate-commit',
      completion: {
        body: 'candidate output',
        artifacts: [],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 3,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    const authorizedBinding: AuthorizedExecutorBinding = {
      agentClassRef: 'codex-cli',
      harnessRef: 'codex-cli',
      providerRef: 'openai',
      modelRef: 'gpt-5-codex',
      permissionProfileRef: 'workspace-engineering',
      configurationRevision: sourceConfigurationRevision,
    };
    const worker = new WorkspacePublicationWorker({
      db,
      sessionId: 'session-publication-conflict',
      resultRoot: '/tmp/workspace-publication-conflict-results',
      sourceRoot: '/tmp/source',
      workspaceStore: { rootPath: '/tmp/workspace-publication-test' } as never,
      workspaceRepository: {
        findByIdentity: vi.fn().mockReturnValue(null),
      } as never,
      subtaskRepo: subtasks,
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue({
          attemptId: 'attempt-source',
          taskId: task.id,
          subtaskId: 'subtask-publication-conflict',
          generationId: 'generation-publication-conflict',
          workUnitId: 'work-unit-source',
          configurationRevision: authorizedBinding.configurationRevision,
          authorizedBinding,
          bindingFingerprint: 'binding-fingerprint-source',
        }),
      } as never,
      resourceLeaseService: {
        claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
        release: vi.fn(),
      } as never,
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([]),
      } as never,
      taskRuntimeService: taskRuntime,
    });
    Object.defineProperty(worker, 'git', {
      value: {
        withCommitSnapshot: async (workspace: { filesPath: string }, _commit: string, read: (root: string) => Promise<unknown>) => read(workspace.filesPath),
        ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
        describeCandidate: vi.fn().mockResolvedValue({
          baseCommit: 'base',
          oursCommit: 'ours',
          theirsCommit: 'theirs',
          changedPaths: ['src/conflict.ts'],
          filePolicy: { 'src/conflict.ts': 'text' },
        }),
        mergeCandidate: vi.fn().mockResolvedValue({
          type: 'conflicted',
          baseCommit: 'base',
          oursCommit: 'ours',
          theirsCommit: 'theirs',
          conflictPaths: ['src/conflict.ts'],
          filePolicy: { 'src/conflict.ts': 'text' },
        }),
      },
    });

    const outcomes = await worker.drain(task.id, 'generation-publication-conflict');
    const replayed = await worker.drain(task.id, 'generation-publication-conflict');

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      type: 'conflicted',
      event: {
        configurationRevision: authorizedBinding.configurationRevision,
        authorizedBinding,
        bindingFingerprint: 'binding-fingerprint-source',
      },
    });
    expect(replayed).toEqual(outcomes);
  });

  it('requeues a persisted conflict when only legacy baseline drift caused it', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-stale-conflict');
    const taskRuntime = new TaskRuntimeService({
      lifecyclePort: recordingTaskLifecyclePort().port,
      taskEngine,
      taskRepo: new TaskRepo(db),
    });
    const task = taskEngine.create({
      id: 'task-publication-stale-conflict',
      title: 'Publication stale conflict',
      goal: 'Publish only the candidate delta',
    });
    setTaskStatus(db, task.id, 'queued');
    setTaskStatus(db, task.id, 'running');
    insertConfigurationRevision(db, configurationRevision);
    activateGraphRevision(
      db,
      task.id,
      'generation-publication-stale-conflict',
      configurationRevision,
    );
    const subtasks = new SubtaskRepo(db);
    subtasks.upsert({
      id: 'subtask-publication-stale-conflict',
      taskId: task.id,
      graphRevision: 1,
      generationId: 'generation-publication-stale-conflict',
      title: 'Candidate',
      goal: 'Publish the report artifact',
      status: 'awaiting_integration',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [publicationBinding],
      deliveryKind: 'report',
      acceptance: [],
      riskLevel: 'low',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    const publications = new WorkspacePublicationRepo(db);
    const sourceWorkspaceRoot = '/managed/source-workspace';
    const artifactPath = `${sourceWorkspaceRoot}/files/reports/result.html`;
    publications.insertCandidate({
      id: 'publication-stale-conflict',
      taskId: task.id,
      generationId: 'generation-publication-stale-conflict',
      subtaskId: 'subtask-publication-stale-conflict',
      sourceAttemptId: 'attempt-stale-conflict-source',
      agentClassName: 'codex-cli',
      candidateCommit: 'candidate-commit',
      completion: {
        body: 'candidate output',
        artifacts: [artifactPath],
        warnings: [],
        handoffs: [],
        completionSchemaVersion: 4,
      },
      topologyLayer: 0,
      firstDispatchOrder: 0,
      createdAt: now,
    });
    const publishIntegratedArtifacts = vi.fn().mockResolvedValue({
      projections: [],
      failures: [],
      taskDirectory: '/user/metaclaw-tasks/report',
    });
    const userWorkspaceRoot = mkdtempSync(join(tmpdir(), 'metawork-publication-user-workspace-'));
    const worker = new WorkspacePublicationWorker({
      db,
      sessionId: 'session-publication-stale-conflict',
      resultRoot: '/tmp/workspace-publication-stale-conflict-results',
      sourceRoot: '/tmp/source',
      workspaceStore: { rootPath: '/tmp/workspace-publication-test' } as never,
      workspaceRepository: {
        upsert: vi.fn(record => record),
        findByIdentity: vi.fn().mockImplementation((
          _taskId: string,
          _generationId: string,
          subtaskId: string,
        ) => subtaskId === 'subtask-publication-stale-conflict' ? {
          rootUri: pathToFileURL(sourceWorkspaceRoot).href,
        } : null),
      } as never,
      subtaskRepo: subtasks,
      attemptReceiptRepo: {
        findByAttemptId: vi.fn().mockReturnValue({
          attemptId: 'attempt-stale-conflict-source',
          taskId: task.id,
          subtaskId: 'subtask-publication-stale-conflict',
          generationId: 'generation-publication-stale-conflict',
          workUnitId: 'work-unit-source',
          configurationRevision,
          authorizedBinding: publicationBinding,
          bindingFingerprint: 'binding-fingerprint-publication',
        }),
      } as never,
      resourceLeaseService: {
        claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
        release: vi.fn(),
      } as never,
      dispatchItemRepo: {
        listByTask: vi.fn().mockReturnValue([]),
      } as never,
      taskRuntimeService: taskRuntime,
      // Delivery writes into the user Workspace, so a real root is required.
      resolveUserWorkspaceRoot: async () => userWorkspaceRoot,
      userArtifactPublication: {
        publishIntegratedArtifacts,
      } as never,
    });
    Object.defineProperty(worker, 'git', {
      value: {
        withCommitSnapshot: async (workspace: { filesPath: string }, _commit: string, read: (root: string) => Promise<unknown>) => read(workspace.filesPath),
        ensure: vi.fn().mockResolvedValue({
          id: 'integration-workspace',
          rootPath: '/managed/integration-workspace',
          filesPath: '/managed/integration-workspace/files',
        }),
        describeCandidate: vi.fn().mockResolvedValue({
          baseCommit: 'candidate-parent',
          oursCommit: 'ours',
          theirsCommit: 'candidate-commit',
          changedPaths: ['reports/result.html'],
          filePolicy: { 'reports/result.html': 'text' },
        }),
        mergeCandidate: vi.fn()
          .mockResolvedValueOnce({
            type: 'conflicted',
            baseCommit: 'legacy-merge-base',
            oursCommit: 'ours',
            theirsCommit: 'candidate-commit',
            conflictPaths: ['src/unrelated.ts'],
            filePolicy: { 'src/unrelated.ts': 'text' },
          })
          .mockResolvedValueOnce({
            type: 'integrated',
            baseCommit: 'candidate-parent',
            oursCommit: 'ours',
            theirsCommit: 'candidate-commit',
            integrationCommit: 'integration-commit',
            changedPaths: ['reports/result.html'],
            filePolicy: { 'reports/result.html': 'text' },
          }),
      },
    });

    const conflicted = await worker.drain(task.id, 'generation-publication-stale-conflict');
    publications.recordRepairAttempt('publication-stale-conflict', now);
    publications.recordRepairAttempt('publication-stale-conflict', now);
    publications.recordRepairAttempt('publication-stale-conflict', now);
    publications.incrementConflictReplan('publication-stale-conflict', now);
    publications.markParkedForConflictReplan('publication-stale-conflict', now);
    const recovered = await worker.drain(task.id, 'generation-publication-stale-conflict');
    await worker.drain(task.id, 'generation-publication-stale-conflict');

    expect(conflicted).toEqual([expect.objectContaining({ type: 'conflicted' })]);
    expect(recovered).toEqual([expect.objectContaining({
      type: 'integrated',
      integrationCommit: 'integration-commit',
    })]);
    expect(publications.find('publication-stale-conflict')).toMatchObject({
      status: 'integrated',
      repairAttemptsUsed: 0,
      conflictReplansUsed: 0,
      conflictChainId: null,
    });
    expect(subtasks.findById('subtask-publication-stale-conflict')).toMatchObject({
      status: 'done',
      artifacts: [artifactPath],
    });
    expect(publishIntegratedArtifacts).toHaveBeenCalledTimes(1);
    expect(publishIntegratedArtifacts).toHaveBeenLastCalledWith(expect.objectContaining({
      integratedWorkspaceRoot: '/managed/integration-workspace/files',
      sources: [{ sourceRelativePath: 'reports/result.html' }],
    }));
  });
});

describe('WorkspacePublicationWorker edge-authoritative handoffs', () => {
  it.each(['text', 'artifact'] as const)('materializes only text from the safe body when an undeclared edge requires %s', async requiredType => {
    const resultRoot = mkdtempSync(join(tmpdir(), 'metawork-publication-synth-'));
    try {
      const db = new Database(':memory:');
      db.pragma('foreign_keys = ON');
      runMigrations(db);
      const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-synth');
      const taskRuntime = new TaskRuntimeService({
      lifecyclePort: recordingTaskLifecyclePort().port,
        taskEngine,
        taskRepo: new TaskRepo(db),
      });
      const task = taskEngine.create({
        id: 'task-publication-synth',
        title: 'Synthesized handoff',
        goal: 'Materialize edge handoffs without declarations',
      });
      setTaskStatus(db, task.id, 'queued');
      setTaskStatus(db, task.id, 'running');
      insertConfigurationRevision(db, configurationRevision);
      activateGraphRevision(db, task.id, 'generation-synth', configurationRevision);
      const subtasks = new SubtaskRepo(db);
      const base = {
        taskId: task.id,
        graphRevision: 1,
        generationId: 'generation-synth',
        contextRefs: [],
        requiredCapabilities: ['workspace-engineering'],
        executorBindings: [publicationBinding],
        deliveryKind: 'report' as const,
        acceptance: [],
        riskLevel: 'low' as const,
        result: '',
        artifacts: [],
        verification: { warnings: [], completionSchemaVersion: null },
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      subtasks.upsert({
        ...base,
        id: 'source-synth',
        title: 'Research',
        goal: 'Produce the upstream result',
        status: 'awaiting_integration',
        dependencies: [],
      });
      subtasks.upsert({
        ...base,
        id: 'target-synth',
        title: 'Write report',
        goal: 'Consume the upstream result',
        status: 'ready',
        dependencies: [{
          fromSubtaskId: 'source-synth',
          requiredItems: [{ key: 'findings', type: requiredType, description: 'Research findings' }],
        }],
      });
      const result = new ResultObjectRepo(db, resultRoot).putObject({
        resultId: 'result-synth-safe',
        accountId: 'local-default',
        taskId: task.id,
        generationId: 'generation-synth',
        sourceSubtaskId: 'source-synth',
        attemptId: 'attempt-synth',
        kind: 'safe_projection',
        mediaType: 'text/markdown',
        content: 'research findings body',
        completeness: 'complete',
        retentionClass: 'task',
      });
      const publications = new WorkspacePublicationRepo(db);
      publications.insertCandidate({
        id: 'publication-synth',
        taskId: task.id,
        generationId: 'generation-synth',
        subtaskId: 'source-synth',
        sourceAttemptId: 'attempt-synth',
        agentClassName: 'codex-cli',
        candidateCommit: 'candidate-commit',
        completion: {
          body: 'research findings body',
          artifacts: [],
          warnings: [],
          handoffs: [],
          completionSchemaVersion: 4,
        },
        topologyLayer: 0,
        firstDispatchOrder: 0,
        createdAt: now,
      });
      const worker = new WorkspacePublicationWorker({
        db,
        sessionId: 'session-synth',
        accountId: 'local-default',
        resultRoot,
        sourceRoot: '/tmp/source',
        workspaceStore: { rootPath: '/tmp/workspace-publication-synth' } as never,
        workspaceRepository: { findByIdentity: vi.fn().mockReturnValue(null) } as never,
        subtaskRepo: subtasks,
        attemptReceiptRepo: {
          findByAttemptId: vi.fn().mockReturnValue({
            attemptId: 'attempt-synth',
            taskId: task.id,
            subtaskId: 'source-synth',
            generationId: 'generation-synth',
            workUnitId: 'work-unit-synth',
            configurationRevision,
            authorizedBinding: publicationBinding,
            bindingFingerprint: 'binding-fingerprint-synth',
            parsing: {
              resultObjects: {
                rawOutputId: 'result-synth-raw',
                businessResultId: 'result-synth-business',
                safeProjectionId: result.resultId,
              },
            },
          }),
        } as never,
        resourceLeaseService: {
          claim: vi.fn().mockReturnValue({ type: 'claimed', leases: [] }),
          release: vi.fn(),
        } as never,
        dispatchItemRepo: { listByTask: vi.fn().mockReturnValue([]) } as never,
        taskRuntimeService: taskRuntime,
      });
      Object.defineProperty(worker, 'git', {
        value: {
          ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
          describeCandidate: vi.fn().mockResolvedValue({ changedPaths: [], filePolicy: {} }),
          mergeCandidate: vi.fn().mockResolvedValue({
            type: 'integrated',
            baseCommit: 'base',
            oursCommit: 'ours',
            theirsCommit: 'theirs',
            integrationCommit: 'integration-commit',
            filePolicy: {},
          }),
        },
      });

      const outcomes = await worker.drain(task.id, 'generation-synth');

      if (requiredType === 'artifact') {
        expect(outcomes).toEqual([expect.objectContaining({ type: 'delivery_failed' })]);
        expect(publications.delivery('publication-synth')).toMatchObject({ status: 'failed',
          failures: [{ sourceRelativePath: '', reason: expect.stringContaining('Missing declared artifact handoff') }] });
        expect(new SubtaskHandoffRepo(db).listIncoming(task.id, 'target-synth')).toEqual([]);
        expect(subtasks.findById('source-synth')?.status).toBe('awaiting_integration');
        db.close();
        return;
      }
      expect(outcomes).toEqual([expect.objectContaining({ type: 'integrated' })]);
      const handoff = new SubtaskHandoffRepo(db).listIncoming(task.id, 'target-synth')[0];
      expect(handoff).toBeDefined();
      expect(handoff!.resultReference).toMatchObject({
        resultId: result.resultId,
        sourceSubtaskId: 'source-synth',
        targetSubtaskId: 'target-synth',
        contentHash: result.contentHash,
        byteLength: result.byteLength,
      });
      // The edge's declared needs are all satisfied by the single result reference.
      expect(handoff!.items).toEqual([expect.objectContaining({
        key: 'findings',
        type: 'result_reference',
        referenceId: handoff!.resultReference!.referenceId,
      })]);
    } finally {
      rmSync(resultRoot, { recursive: true, force: true });
    }
  });
});

const now = '2026-07-28T00:00:00.000Z';

function insertConfigurationRevision(
  db: Database.Database,
  revisionId: string,
): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', ?)
  `).run(revisionId, `sha256:${revisionId}`, now);
}

function activateGraphRevision(
  db: Database.Database,
  taskId: string,
  generationId: string,
  revisionId: string,
): void {
  new WorkGraphRevisionRepo(db).activate({
    id: `graph-${taskId}-1`,
    taskId,
    revision: 1,
    generationId,
    configurationRevision: revisionId,
    authorizedDecisionId: null,
    proposalSource: 'initial',
    automaticReplan: false,
    createdAt: now,
    updatedAt: now,
  });
}
