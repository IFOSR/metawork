import { projectTaskView } from '../../src/task/task-view.js';
import { SqliteTaskActivityFacts } from '../../src/storage/task-activity-facts-repo.js';
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { clearTasks, listTasks } from '../../src/commands/task-commands.js';
import type { CommandContext } from '../../src/commands/catalog.js';
import type { Config } from '../../src/core/types.js';
import { setTaskStatus, withReason } from '../support/task-state-fixture.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: {
      command: 'codex',
      timeout: 60_000,
    },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

let db: Database.Database;

describe('task list commands', () => {
  let taskEngine: TaskEngine;
  let taskRepo: TaskRepo;
  let context: CommandContext;

  beforeEach(() => {
    db = createTestDb();
    taskRepo = new TaskRepo(db);
    taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    const orchestration = new OrchestrationEngine(taskEngine);
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));

    context = {
      taskEngine,
      memoryEngine,
      orchestration,
      taskControl: {
        taskView: (id: string) => projectTaskView(new SqliteTaskActivityFacts(db).read(taskRepo.findById(id)!, null)),
        cancelTask: async taskId => {
          setTaskStatus(db, taskId, 'cancelled');
          return {
            taskId,
            affectedSubtaskCount: 0,
            cleanupAttemptCount: 0,
          };
        },
        cancelSubtasks: async () => ({
          taskId: '',
          affectedSubtaskCount: 0,
          cleanupAttemptCount: 0,
        }),
        acceptPartialResult: async taskId => ({ taskId }),
      },
      currentTaskId: null,
      db,
      config: createConfig(),
    } as never;
  });

  it('groups tasks by running, ready, parked, blocked, and done in the default list', async () => {
    const runningTask = taskEngine.create({ title: '执行中的任务', goal: '执行中' });
    setTaskStatus(db, runningTask.id, 'queued');
    setTaskStatus(db, runningTask.id, 'running');

    const readyTask = taskEngine.create({ title: '待执行任务', goal: '待执行' });
    setTaskStatus(db, readyTask.id, 'queued');

    const parkedTask = taskEngine.create({ title: '已挂起任务', goal: '已挂起' });
    setTaskStatus(db, parkedTask.id, 'queued');
    setTaskStatus(db, parkedTask.id, 'running');
    setTaskStatus(db, parkedTask.id, 'needs_action', withReason('用户暂停'));

    const blockedTask = taskEngine.create({ title: '已阻塞任务', goal: '已阻塞' });
    setTaskStatus(db, blockedTask.id, 'queued');
    setTaskStatus(db, blockedTask.id, 'running');
    setTaskStatus(db, blockedTask.id, 'needs_action');

    const doneTask = taskEngine.create({ title: '已完成任务', goal: '已完成' });
    setTaskStatus(db, doneTask.id, 'queued');
    setTaskStatus(db, doneTask.id, 'running');
    setTaskStatus(db, doneTask.id, 'succeeded');

    const result = await listTasks({ positionals: {}, options: {} }, context);

    expect(result.content).toContain('待处理');
    expect(result.content).toContain('排队');
    expect(result.content).toContain('成功');
  });

  it('supports ready and parked filters', async () => {
    const readyTask = taskEngine.create({ title: '待执行任务', goal: '待执行' });
    setTaskStatus(db, readyTask.id, 'queued');

    const parkedTask = taskEngine.create({ title: '已挂起任务', goal: '已挂起' });
    setTaskStatus(db, parkedTask.id, 'queued');
    setTaskStatus(db, parkedTask.id, 'running');
    setTaskStatus(db, parkedTask.id, 'needs_action', withReason('用户暂停'));

    const readyResult = await listTasks({ positionals: { scope: 'ready' }, options: {} }, context);
    expect(readyResult.content).toContain(readyTask.id);
    expect(readyResult.content).not.toContain(parkedTask.id);

    const parkedResult = await listTasks({ positionals: { scope: 'parked' }, options: {} }, context);
    expect(parkedResult.content).toContain(parkedTask.id);
    expect(parkedResult.content).not.toContain(readyTask.id);
  });

  it('treats every persisted task as durable in the default task list', async () => {
    const realTask = taskEngine.create({ title: '行业调研任务', goal: '输出调研结论' });
    setTaskStatus(db, realTask.id, 'queued');
    setTaskStatus(db, realTask.id, 'running');
    setTaskStatus(db, realTask.id, 'succeeded');

    const chatterTask = taskEngine.create({ title: 'hi', goal: 'hi' });
    setTaskStatus(db, chatterTask.id, 'queued');
    setTaskStatus(db, chatterTask.id, 'running');
    setTaskStatus(db, chatterTask.id, 'succeeded');

    const result = await listTasks({ positionals: {}, options: {} }, context);

    expect(result.content).toContain(realTask.id);
    expect(result.content).toContain(chatterTask.id);
    expect(result.content).toContain('[成功] hi');
  });

  it('clears only parked tasks when requested', async () => {
    const readyTask = taskEngine.create({ title: '待执行任务', goal: '待执行' });
    setTaskStatus(db, readyTask.id, 'queued');

    const parkedTask = taskEngine.create({ title: '已挂起任务', goal: '已挂起' });
    setTaskStatus(db, parkedTask.id, 'queued');
    setTaskStatus(db, parkedTask.id, 'running');
    setTaskStatus(db, parkedTask.id, 'needs_action', withReason('用户暂停'));

    const result = await clearTasks({ positionals: { scope: 'parked' }, options: {} }, context);

    expect(result.content).toContain('已清空待处理任务：取消 1 个任务');
    expect(result.content).toContain(parkedTask.id);
    expect(taskRepo.findById(parkedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(readyTask.id)?.status).toBe('queued');
  });

  it('clears all manageable tasks and leaves completed history untouched', async () => {
    const runningTask = taskEngine.create({ title: '执行中的任务', goal: '执行中' });
    setTaskStatus(db, runningTask.id, 'queued');
    setTaskStatus(db, runningTask.id, 'running');

    const blockedTask = taskEngine.create({ title: '已阻塞任务', goal: '已阻塞' });
    setTaskStatus(db, blockedTask.id, 'queued');
    setTaskStatus(db, blockedTask.id, 'running');
    setTaskStatus(db, blockedTask.id, 'needs_action');

    const doneTask = taskEngine.create({ title: '已完成任务', goal: '已完成' });
    setTaskStatus(db, doneTask.id, 'queued');
    setTaskStatus(db, doneTask.id, 'running');
    setTaskStatus(db, doneTask.id, 'succeeded');

    const result = await clearTasks({ positionals: { scope: 'all' }, options: {} }, context);

    expect(result.content).toContain('已清空所有未完成任务：取消 2 个任务');
    expect(result.content).toContain('已中止当前执行器');
    expect(taskRepo.findById(runningTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(blockedTask.id)?.status).toBe('cancelled');
    expect(taskRepo.findById(doneTask.id)?.status).toBe('succeeded');
  });
});
