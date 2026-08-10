import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { createDefaultCommandCatalog } from '../../src/commands/command-tree.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';

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

describe('Round 4 task view acceptance', () => {
  it('surfaces a readable task workspace after completion instead of forcing users to parse only transcript logs', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptExecutionBackend = new FakeAttemptExecutionBackend(() => ({
      body: 'Phoenix 周报结论：本周主线推进稳定，当前风险集中在跨团队依赖与下周交付节点。',
    }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptExecutionBackend,
      db,
      config: createConfig(),
      sessionId: 'sess_round4_task_view',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '整理 Phoenix 项目的周报，输出一个简短结论' }),
      ),
    });

    session.initialize();
    await session.submit('整理 Phoenix 项目的周报，输出一个简短结论', { awaitAsyncWork: true });

    const completedTask = taskRepo.findByStatus('done')[0];
    expect(completedTask).toBeDefined();

    const detail = await createDefaultCommandCatalog().execute(`/task show ${completedTask.id}`, {
      taskEngine,
      memoryEngine,
      orchestration,
      activeExecutions: null,
      taskControl: null,
      readServices: null,
      currentTaskId: null,
      db,
      config: createConfig(),
    });

    expect(detail.content).toContain('任务视图');
    expect(detail.content).toContain('最新结果摘要');
    expect(detail.content).toContain('Phoenix 周报结论');
    expect(detail.content).toContain('最新下一步');
  });
});
