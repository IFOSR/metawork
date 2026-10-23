import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { TaskStateChangeRepo } from '../../src/storage/task-state-change-repo.js';
import { createSqliteTaskLifecyclePort } from '../../src/storage/task-lifecycle-port-adapter.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskStateProjectionOutbox } from '../../src/storage/task-state-change-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { EMPTY_TASK_STATE_DETAIL } from '../../src/task/task-state.js';

describe('TaskRuntimeService Task Domain facade', () => {
  let service: TaskRuntimeService;
  let repo: TaskRepo;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    repo = new TaskRepo(db);
    const stateChanges = new TaskStateChangeRepo(db);
    const taskEngine = new TaskEngine({
      taskRepo: repo,
      snapshotDir: resolve(tmpdir(), 'metaclaw-task-runtime-tests'),
      stateChanges,
    });
    const lifecyclePort = createSqliteTaskLifecyclePort(db, {
      taskRepo: repo,
      subtaskRepo: new SubtaskRepo(db),
      stateChanges,
      projectionOutbox: new TaskStateProjectionOutbox(db),
      workGraphRevisionRepo: new WorkGraphRevisionRepo(db),
    });
    service = new TaskRuntimeService({ taskEngine, taskRepo: repo, lifecyclePort });
  });

  it('creates a Task directly in the queued state', () => {
    const created = service.createTask({ id: 'task_fixed', title: 'Task', goal: 'Goal' });
    expect(created.id).toBe('task_fixed');
    expect(created.status).toBe('queued');
    expect(created.stateVersion).toBe(1);
  });

  it('has exactly one lifecycle entry: applyTaskChange', () => {
    const task = service.createTask({ title: 'Task', goal: 'Goal' });
    const result = service.applyTaskChange({
      taskId: task.id,
      decisionId: 'decision_1',
      operationKey: 'dispatch:1',
      expectedVersion: 1,
      generationId: null,
      graphRevision: null,
      to: 'running',
      detail: EMPTY_TASK_STATE_DETAIL,
      actor: 'kernel-execution-runtime',
      reason: 'authorized dispatch',
    });
    expect(result.task.status).toBe('running');
    expect(result.task.stateVersion).toBe(2);
    // The old scattered transitions are gone.
    expect('transitionTask' in service).toBe(false);
    expect('blockTask' in service).toBe(false);
    expect('unblockTask' in service).toBe(false);
    expect('parkTask' in service).toBe(false);
    expect('resumeParkedTask' in service).toBe(false);
  });

  it('keeps metadata updates away from lifecycle fields', () => {
    const task = service.createTask({ title: 'Task', goal: 'Goal' });
    expect(service.updateTask(task.id, { summary: 'progress' })!.summary).toBe('progress');
    expect(service.updateTask(task.id, { summary: 'progress' })!.stateVersion).toBe(1);
  });

  it('contains no generic command switch or queue/preemption interface', () => {
    expect('execute' in service).toBe(false);
    expect('preemptCurrentTask' in service).toBe(false);
    expect('getNextSchedulableTask' in service).toBe(false);
  });
});
