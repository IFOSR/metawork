import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Task } from '../../src/core/types.js';
import { WorkGraphRuntimeService } from '../../src/execution/work-graph-runtime-service.js';
import type { WorkGraphProposal } from '../../src/work-graph/types.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';

const now = '2026-07-16T00:00:00.000Z';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function task(id = 'task_1'): Task {
  return {
    id, title: 'Task', goal: 'Do work', status: 'running', summary: '', snapshots: [],
    resources: [], artifacts: [], dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [], lastSchedulingReason: '', lastInterruptionReason: '', interruptionCount: 0,
    createdAt: now, updatedAt: now,
  };
}

function graph(_taskId: string): WorkGraphProposal {
  return {
      reason: 'authorized graph',
      subtasks: [{
        id: 'execute', title: 'Execute', goal: 'Do work', dependencies: [], contextRefs: [],
        requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
        expectedOutput: 'patch', acceptance: [{ key: 'tests', description: 'run the unit tests', requiredEvidence: ['test result'] }], riskLevel: 'low',
      }],
  };
}

describe('WorkGraphRuntimeService', () => {
  it('applies and round-trips only a Kernel-approved v4 graph', () => {
    const db = createDb();
    const taskRecord = task();
    new TaskRepo(db).insert(taskRecord);
    const repo = new SubtaskRepo(db);
    const result = new WorkGraphRuntimeService(repo, new TaskEventRepo(db)).apply({
      task: taskRecord, userPrompt: 'ignored by graph materialization', authorizedWorkGraph: graph(taskRecord.id),
    });

    expect(result).toMatchObject({ outcome: 'applied' });
    if (result.outcome !== 'applied') return;
    expect(result.subtasks[0]).toMatchObject({
      id: `${taskRecord.id}_execute`, requiredCapabilities: ['workspace-engineering'],
      preferredAgentClassList: ['codex-cli'], expectedOutput: 'patch',
      acceptance: [{ key: 'tests', description: 'run the unit tests', requiredEvidence: ['test result'] }],
    });
    expect(repo.listByTask(taskRecord.id)[0]).toMatchObject({
      requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
    });
  });

  it('returns missing_graph and never synthesizes a fallback', () => {
    const db = createDb();
    const taskRecord = task('task_missing');
    new TaskRepo(db).insert(taskRecord);
    const repo = new SubtaskRepo(db);

    expect(new WorkGraphRuntimeService(repo, new TaskEventRepo(db)).apply({
      task: taskRecord, userPrompt: 'just do it', authorizedWorkGraph: null,
    })).toEqual({ outcome: 'not_executable', reason: 'missing_graph' });
    expect(repo.listByTask(taskRecord.id)).toEqual([]);
  });

  it('keeps a stale running v4 node blocked instead of implicitly retrying it', () => {
    const db = createDb();
    const taskRecord = task('task_recover');
    new TaskRepo(db).insert(taskRecord);
    const repo = new SubtaskRepo(db);
    const service = new WorkGraphRuntimeService(repo, new TaskEventRepo(db));
    expect(service.apply({ task: taskRecord, userPrompt: 'apply', authorizedWorkGraph: graph(taskRecord.id) })).toMatchObject({ outcome: 'applied' });
    repo.updateStatus(`${taskRecord.id}_execute`, 'running', { error: 'previous timeout' });

    const result = service.apply({ task: taskRecord, userPrompt: 'resume', authorizedWorkGraph: null });
    expect(result).toMatchObject({ outcome: 'recovered' });
    expect(repo.findById(`${taskRecord.id}_execute`)).toMatchObject({ status: 'blocked', error: 'previous timeout' });
  });

  it('defensively rejects a new approved graph when a v4 graph already exists', () => {
    const db = createDb();
    const taskRecord = task('task_conflict');
    new TaskRepo(db).insert(taskRecord);
    const service = new WorkGraphRuntimeService(new SubtaskRepo(db), new TaskEventRepo(db));
    service.apply({ task: taskRecord, userPrompt: 'apply', authorizedWorkGraph: graph(taskRecord.id) });

    expect(service.apply({ task: taskRecord, userPrompt: 'replace', authorizedWorkGraph: graph(taskRecord.id) })).toEqual({
      outcome: 'not_executable', reason: 'graph_already_exists',
    });
  });
});
