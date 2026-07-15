import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { AgentClassService } from '../../src/executor/agent-class-service.js';

function createHarness() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  new AgentClassService({ db, defaultExecutorName: 'codex-cli' }).seedDefaults();
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-command-control');
  const abortTask = vi.fn().mockReturnValue(1);
  const context = {
    db,
    taskEngine,
    activeExecutions: { abortTask },
    executor: { name: 'codex-cli' },
  } as any;
  return { db, taskRepo, taskEngine, abortTask, context, catalog: createDefaultCommandCatalog() };
}

function createRunningTask(taskEngine: TaskEngine, suffix: string) {
  const task = taskEngine.create({ title: `任务 ${suffix}`, goal: `执行 ${suffix}` });
  taskEngine.transition(task.id, 'ready');
  taskEngine.transition(task.id, 'running');
  return task;
}

describe('canonical task control commands', () => {
  it.each([
    ['pause', 'parked', ''],
    ['block', 'blocked', ' 等待材料'],
    ['cancel', 'cancelled', ''],
    ['complete', 'done', ''],
  ] as const)('persists %s before aborting the active task', async (command, expectedStatus, tail) => {
    const harness = createHarness();
    const task = createRunningTask(harness.taskEngine, command);

    const result = await harness.catalog.execute(`/task ${command} ${task.id}${tail}`, harness.context);

    expect(result.type).toBe('text');
    expect(harness.taskRepo.findById(task.id)?.status).toBe(expectedStatus);
    expect(harness.abortTask).toHaveBeenCalledWith(task.id);
  });

  it('clears matching tasks and aborts only tasks that were running', async () => {
    const harness = createHarness();
    const running = createRunningTask(harness.taskEngine, 'running');
    const parked = createRunningTask(harness.taskEngine, 'parked');
    harness.taskEngine.park(parked.id);

    await harness.catalog.execute('/task clear all', harness.context);

    expect(harness.taskRepo.findById(running.id)?.status).toBe('cancelled');
    expect(harness.taskRepo.findById(parked.id)?.status).toBe('cancelled');
    expect(harness.abortTask).toHaveBeenCalledTimes(1);
    expect(harness.abortTask).toHaveBeenCalledWith(running.id);
  });

});
