import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSubtaskLifecyclePort,
  createTaskLifecyclePort,
  createTaskLifecycleTransitionPort,
  type InvalidLifecycleTransitionError,
  type TaskLifecycleTransitionRecord,
} from '../../src/task/task-lifecycle-transition-port.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture(name: string) {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, `/tmp/metawork-transition-port/${name}`);
  const taskRuntimeService = new TaskRuntimeService({ taskEngine, taskRepo });
  const subtaskRepo = new SubtaskRepo(db);
  const transitions: TaskLifecycleTransitionRecord[] = [];
  const port = createTaskLifecycleTransitionPort({
    taskRuntimeService,
    subtaskRepo,
    onTransition: record => transitions.push(record),
  });
  return { db, taskRepo, taskEngine, taskRuntimeService, subtaskRepo, port, transitions };
}

function taskWithGraph(
  fixture: ReturnType<typeof fixture>,
  id = 'task_lifecycle',
) {
  const task = fixture.taskEngine.create({
    id,
    title: 'Lifecycle task',
    goal: 'Exercise the transition port',
  });
  seedPersistedWorkGraph(fixture.db, id, task.goal);
  return task;
}

describe('Task lifecycle transition port', () => {
  it('records one auditable owner for every strategic Task transition', () => {
    const fx = fixture('task-owner');
    taskWithGraph(fx);

    fx.port.transitionTask({
      taskId: 'task_lifecycle',
      to: 'ready',
      actor: 'task-domain',
      reason: 'admitted',
    });
    fx.port.transitionTask({
      taskId: 'task_lifecycle',
      to: 'running',
      actor: 'kernel-execution-runtime',
      reason: 'authorized dispatch',
    });
    fx.port.blockTask({
      taskId: 'task_lifecycle',
      dependency: {
        taskId: 'task_lifecycle',
        type: 'manual',
        description: 'needs a human',
        status: 'waiting',
      },
      actor: 'kernel-execution-runtime',
      reason: 'no runnable Subtask',
    });

    expect(fx.transitions.map(record => [record.from, record.to, record.actor])).toEqual([
      ['queued', 'queued', 'task-domain'],
      ['queued', 'executing', 'kernel-execution-runtime'],
      ['executing', 'blocked', 'kernel-execution-runtime'],
    ]);
  });

  it('rejects a cross-layer transition out of a terminal lifecycle', () => {
    const fx = fixture('terminal');
    taskWithGraph(fx);
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'ready', actor: 'task-domain', reason: 'admitted' });
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'running', actor: 'task-domain', reason: 'start' });
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'done', actor: 'kernel-execution-runtime', reason: 'complete' });

    expect(() => fx.port.transitionTask({
      taskId: 'task_lifecycle',
      to: 'running',
      actor: 'kernel-execution-runtime',
      reason: 'illegal restart',
    })).toThrow(/rejected cross-layer lifecycle transition completed -> executing/u);
    try {
      fx.port.transitionTask({
        taskId: 'task_lifecycle',
        to: 'running',
        actor: 'kernel-execution-runtime',
        reason: 'illegal restart',
      });
    } catch (error) {
      expect((error as InvalidLifecycleTransitionError).code).toBe('invalid_task_transition');
      expect((error as InvalidLifecycleTransitionError).actor).toBe('kernel-execution-runtime');
    }
    expect(fx.transitions.filter(record => record.to === 'completed')).toHaveLength(1);
  });

  it('lets the Kernel clear a blocker without re-entering execution', () => {
    const fx = fixture('unblock');
    taskWithGraph(fx);
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'ready', actor: 'task-domain', reason: 'admitted' });
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'running', actor: 'task-domain', reason: 'start' });
    fx.port.blockTask({
      taskId: 'task_lifecycle',
      dependency: { taskId: 'task_lifecycle', type: 'manual', description: 'blocker', status: 'waiting' },
      actor: 'kernel-execution-runtime',
      reason: 'blocked',
    });
    fx.port.unblockTask({
      taskId: 'task_lifecycle',
      actor: 'kernel-execution-runtime',
      reason: 'resolved',
    });
    expect(fx.taskRepo.findById('task_lifecycle')?.status).toBe('ready');
    expect(fx.transitions.at(-1)).toMatchObject({ from: 'blocked', to: 'queued' });
  });

  it('treats a replayed cancellation as idempotent, not invalid', () => {
    const fx = fixture('cancel-replay');
    taskWithGraph(fx);
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'ready', actor: 'task-domain', reason: 'admitted' });
    fx.port.cancelTask({ taskId: 'task_lifecycle', reason: 'user cancelled', actor: 'task-cancellation-coordinator' });
    expect(() => fx.port.cancelTask({
      taskId: 'task_lifecycle',
      reason: 'user cancelled again',
      actor: 'task-cancellation-coordinator',
    })).not.toThrow();
    expect(fx.transitions.filter(record => record.to === 'cancelled')).toHaveLength(1);
  });

  it('treats a replayed block as a no-op, not a transition', () => {
    const fx = fixture('block-replay');
    taskWithGraph(fx);
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'ready', actor: 'task-domain', reason: 'admitted' });
    fx.port.transitionTask({ taskId: 'task_lifecycle', to: 'running', actor: 'task-domain', reason: 'start' });
    const dependency = {
      taskId: 'task_lifecycle',
      type: 'manual' as const,
      description: 'blocker',
      status: 'waiting' as const,
    };
    fx.port.blockTask({ taskId: 'task_lifecycle', dependency, actor: 'kernel-execution-runtime', reason: 'a' });
    fx.port.blockTask({ taskId: 'task_lifecycle', dependency, actor: 'kernel-execution-runtime', reason: 'b' });
    expect(fx.transitions.filter(record => record.to === 'blocked')).toHaveLength(1);
  });

  it('rejects a Subtask write that would reopen a terminal node', () => {
    const fx = fixture('subtask');
    taskWithGraph(fx);
    const subtaskId = 'task_lifecycle_execute';
    fx.port.transitionSubtask({
      subtaskId,
      to: 'running',
      actor: 'subtask-attempt-runner',
      reason: 'attempt claimed',
    });
    fx.port.transitionSubtask({
      subtaskId,
      to: 'done',
      actor: 'workspace-publication-worker',
      reason: 'publication integrated',
    });
    expect(() => fx.port.transitionSubtask({
      subtaskId,
      to: 'running',
      actor: 'subtask-attempt-runner',
      reason: 'illegal reopen',
    })).toThrow(/rejected cross-layer lifecycle transition completed -> executing/u);
    expect(fx.subtaskRepo.findById(subtaskId)?.status).toBe('done');
  });

  it('keeps the Subtask port independent of the Task repository', () => {
    const fx = fixture('split');
    taskWithGraph(fx);
    const subtaskPort = createSubtaskLifecyclePort({ subtaskRepo: fx.subtaskRepo });
    const taskPort = createTaskLifecyclePort({ taskRuntimeService: fx.taskRuntimeService });
    subtaskPort.transitionSubtask({
      subtaskId: 'task_lifecycle_execute',
      to: 'blocked',
      actor: 'work-graph-runtime-service',
      reason: 'dependency materialization failed',
    });
    expect(taskPort.listTransitions()).toEqual([]);
    expect(subtaskPort.listTransitions()).toHaveLength(1);
  });
});
