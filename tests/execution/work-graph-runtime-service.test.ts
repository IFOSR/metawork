import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Task } from '../../src/core/types.js';
import { WorkGraphRuntimeService } from '../../src/execution/work-graph-runtime-service.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
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

function plan(taskId: string): PlanningAgentPlan {
  return {
    id: 'plan_1', schemaVersion: 3, action: 'plan_work_graph', confidence: 0.9,
    reason: 'execute', clarificationQuestion: null, response: { directReply: null },
    task: {
      binding: 'reference', taskId, control: 'none', scope: null, title: 'Task', goal: 'Do work',
      includeRecentConversationContext: false, priority: { level: 'normal', reason: 'test priority' },
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: {
      reason: 'approved plan',
      subtasks: [{
        id: 'execute', title: 'Execute', goal: 'Do work', dependsOn: [],
        requiredCapabilities: ['workspace-engineering'], preferredAgentClassList: ['codex-cli'],
        expectedOutput: 'patch', acceptance: ['run the unit tests'], riskLevel: 'low',
      }],
    },
    source: 'codex-planner',
  };
}

describe('WorkGraphRuntimeService', () => {
  it('applies and round-trips only a Kernel-approved v3 graph', () => {
    const db = createDb();
    const taskRecord = task();
    new TaskRepo(db).insert(taskRecord);
    const repo = new SubtaskRepo(db);
    const result = new WorkGraphRuntimeService(repo, new TaskEventRepo(db)).apply({
      task: taskRecord, userPrompt: 'ignored by graph materialization', approvedPlan: plan(taskRecord.id),
    });

    expect(result).toMatchObject({ outcome: 'applied' });
    if (result.outcome !== 'applied') return;
    expect(result.subtasks[0]).toMatchObject({
      id: `${taskRecord.id}_execute`, requiredCapabilities: ['workspace-engineering'],
      preferredAgentClassList: ['codex-cli'], expectedOutput: 'patch', acceptance: ['run the unit tests'],
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
      task: taskRecord, userPrompt: 'just do it', approvedPlan: null,
    })).toEqual({ outcome: 'not_executable', reason: 'missing_graph' });
    expect(repo.listByTask(taskRecord.id)).toEqual([]);
  });

  it('recovers an existing v3 graph only when no new graph is supplied', () => {
    const db = createDb();
    const taskRecord = task('task_recover');
    new TaskRepo(db).insert(taskRecord);
    const repo = new SubtaskRepo(db);
    const service = new WorkGraphRuntimeService(repo, new TaskEventRepo(db));
    expect(service.apply({ task: taskRecord, userPrompt: 'apply', approvedPlan: plan(taskRecord.id) })).toMatchObject({ outcome: 'applied' });
    repo.updateStatus(`${taskRecord.id}_execute`, 'running', { error: 'previous timeout' });

    const result = service.apply({ task: taskRecord, userPrompt: 'resume', approvedPlan: null });
    expect(result).toMatchObject({ outcome: 'recovered' });
    expect(repo.findById(`${taskRecord.id}_execute`)).toMatchObject({ status: 'ready', error: 'previous timeout' });
  });

  it('defensively rejects a new approved graph when a v3 graph already exists', () => {
    const db = createDb();
    const taskRecord = task('task_conflict');
    new TaskRepo(db).insert(taskRecord);
    const service = new WorkGraphRuntimeService(new SubtaskRepo(db), new TaskEventRepo(db));
    service.apply({ task: taskRecord, userPrompt: 'apply', approvedPlan: plan(taskRecord.id) });

    expect(service.apply({ task: taskRecord, userPrompt: 'replace', approvedPlan: plan(taskRecord.id) })).toEqual({
      outcome: 'not_executable', reason: 'graph_already_exists',
    });
  });
});
