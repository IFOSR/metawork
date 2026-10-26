import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import type { Config } from '../../src/core/types.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { stubPlanningAgent, workGraphPlan, taskControlPlan } from '../support/planning-agent-plans.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
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

describe('cross-session last-task continuation', () => {
  it('auto-creates a follow-up instead of asking for confirmation when the last focused task is done', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const orchestration = new OrchestrationEngine(taskEngine);

    const attemptExecutionBackend1 = new FakeAttemptExecutionBackend(() => ({ body: '智谱投资分析已完成' }));
    const session1 = new MetaclawSession({
      taskEngine,
      orchestration,
      attemptExecutionBackend: attemptExecutionBackend1,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_a',
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '智谱这家公司从现在看是否值得投资？你怎么看？' }),
      ),
    });

    session1.initialize();
    await session1.submit('智谱这家公司从现在看是否值得投资？你怎么看？', { awaitAsyncWork: true });
    await session1.submit('/exit', { awaitAsyncWork: true });

    const attemptExecutionBackend2 = new FakeAttemptExecutionBackend(() => ({ body: 'follow-up 已执行' }));
    // The planner sees session1's completed task in recentTasks and pins it by
    // taskId. Runtime then forks a follow-up from that referenced done task —
    // no session-pointer guessing, no 'last_task_continuation' control.
    const completedTaskId = taskRepo.findByStatus('succeeded')[0]!.id;
    const session2 = new MetaclawSession({
      taskEngine,
      orchestration,
      attemptExecutionBackend: attemptExecutionBackend2,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_b',
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: `继续已完成任务 ${completedTaskId} 的后续工作` }),
      ),
    });

    session2.initialize();
    await session2.submit('继续之前的任务', { awaitAsyncWork: true });

    expect(attemptExecutionBackend2.create).toHaveBeenCalledTimes(1);
    const followUpInput = attemptExecutionBackend2.create.mock.calls[0]![0];
    expect(followUpInput.taskId).not.toBe(completedTaskId);
  });

  it('resumes a planner-pinned parked task across sessions', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const orchestration = new OrchestrationEngine(taskEngine);

    const parkedTask = taskEngine.create({
      title: '历史未完成调研',
      goal: '继续历史未完成调研',
    });
    seedPersistedWorkGraph(db, parkedTask.id, parkedTask.title);
    setTaskStatus(db, parkedTask.id, 'queued');
    setTaskStatus(db, parkedTask.id, 'running');
    setTaskStatus(db, parkedTask.id, 'needs_action', withReason('等待继续'));

    const attemptExecutionBackend = new FakeAttemptExecutionBackend(() => ({ body: '历史任务已恢复' }));
    const session = new MetaclawSession({
      taskEngine,
      orchestration,
      attemptExecutionBackend,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_e',
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'resume_task', taskId: parkedTask.id }),
      ),
    });

    session.initialize();
    await session.submit('继续之前的任务', { awaitAsyncWork: true });

    expect(attemptExecutionBackend.create).toHaveBeenCalledTimes(1);
  });
});
