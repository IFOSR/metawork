import { describe, expect, it } from 'vitest';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { createV31RepositoryDb } from './v31-repository-fixture.js';

describe('SubtaskRepo', () => {
  it('preserves existing error when updateStatus is called without an error change', () => {
    const db = createV31RepositoryDb();
    const now = '2026-07-02T00:00:00.000Z';
    db.prepare(`
      INSERT INTO work_graph_revisions (
        id, task_id, revision, generation_id, proposal_source,
        automatic_replan, status, configuration_revision, created_at, updated_at
      ) VALUES (
        'graph_1', 'task_1', 1, 'generation_1', 'initial',
        0, 'active', 'revision_31', ?, ?
      )
    `).run(now, now);
    const repo = new SubtaskRepo(db);
    repo.upsert({
      id: 'subtask_1',
      taskId: 'task_1',
      graphRevision: 1,
      generationId: 'generation_1',
      title: 'Subtask',
      goal: 'Do work',
      status: 'blocked',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [{
        agentClassRef: 'codex-engineering',
        harnessRef: 'codex-cli',
        providerRef: 'openai',
        modelRef: 'engineering-model',
        permissionProfileRef: 'workspace-default',
        configurationRevision: 'revision_31',
      }],
      deliveryKind: 'report',
      acceptance: [{ key: 'done', description: 'done', requiredEvidence: [] }],
      riskLevel: 'medium',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: 'executor timeout',
      createdAt: now,
      updatedAt: now,
    });

    repo.updateStatus('subtask_1', 'running');

    expect(repo.findById('subtask_1')).toMatchObject({
      status: 'running',
      error: 'executor timeout',
    });

    repo.updateStatus('subtask_1', 'ready', { error: null });
    expect(repo.findById('subtask_1')).toMatchObject({
      status: 'ready',
      error: null,
    });
  });
});
