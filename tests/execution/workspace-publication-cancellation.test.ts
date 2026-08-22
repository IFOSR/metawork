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
        taskEngine,
        taskRepo: new TaskRepo(db),
      });
      const task = taskEngine.create({
        id: 'task-publication-reference',
        title: 'Publication reference',
        goal: 'Publish an authorized result reference',
      });
      taskEngine.transition(task.id, 'ready');
      taskEngine.transition(task.id, 'running');
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

  it('keeps an observed integration commit as audit only when cancellation wins before publication', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-cancel');
    const taskRuntime = new TaskRuntimeService({
      taskEngine,
      taskRepo: new TaskRepo(db),
    });
    const task = taskEngine.create({
      id: 'task-publication-cancel',
      title: 'Publication cancellation',
      goal: 'Do not publish after cancellation',
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
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
    });
    Object.defineProperty(worker, 'git', {
      value: {
        ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
        describeCandidate: vi.fn().mockResolvedValue({
          changedPaths: [],
          filePolicy: {},
        }),
        mergeCandidate: vi.fn(async () => {
          publications.requestCancellation({
            taskId: task.id,
            generationId: 'generation-publication-cancel',
            subtaskIds: ['subtask-publication-cancel'],
            decisionId: 'decision-cancel-race',
            now,
          });
          taskEngine.cancel(task.id, 'cancel during merge');
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
      status: 'cancelled',
      integrationCommit: null,
      observedIntegrationCommit: 'observed-integration-commit',
    });
    expect(subtasks.findById('subtask-publication-cancel')).toMatchObject({
      status: 'awaiting_integration',
      result: '',
      artifacts: [],
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM subtask_handoffs').get()).toEqual({
      count: 0,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('emits merge conflict identity from the persisted source attempt receipt', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const taskEngine = new TaskEngine(new TaskRepo(db), '/tmp/publication-conflict');
    const taskRuntime = new TaskRuntimeService({
      taskEngine,
      taskRepo: new TaskRepo(db),
    });
    const task = taskEngine.create({
      id: 'task-publication-conflict',
      title: 'Publication conflict',
      goal: 'Preserve source attempt binding',
    });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
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
        ensure: vi.fn().mockResolvedValue({ id: 'integration-workspace' }),
        describeCandidate: vi.fn().mockResolvedValue({
          changedPaths: [],
          filePolicy: {},
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

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      type: 'conflicted',
      event: {
        configurationRevision: authorizedBinding.configurationRevision,
        authorizedBinding,
        bindingFingerprint: 'binding-fingerprint-source',
      },
    });
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
