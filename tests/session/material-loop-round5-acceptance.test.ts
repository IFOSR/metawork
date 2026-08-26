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
import { runSessionInputs } from '../support/scripted-session-test-helper.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
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

describe('Round 5 material loop acceptance', () => {
  it('keeps multiple attached materials visible in the task view through the scripted flow', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const attemptExecutionBackend = new FakeAttemptExecutionBackend(() => ({
      body: 'Phoenix 周报结论：主线推进稳定，风险集中在联调和测试数据。',
    }));
    const result = await runSessionInputs({
      inputs: [
        '整理 Phoenix 项目的周报，输出一个简短结论',
        '/task attach {{last_task_id}} fixture-a.md fixture-b.md',
        '/task show {{last_task_id}}',
      ],
      session: new MetaclawSession({
        taskEngine,
        memoryEngine,
        orchestration,
        attemptExecutionBackend,
        db,
        config: createConfig(),
        sessionId: 'sess_round5_materials',
        contextRecaller,
        planningAgent: stubPlanningAgent(
          workGraphPlan({ goal: '整理 Phoenix 项目的周报，输出一个简短结论' }),
        ),
      }),
    });

    const output = result.output.join('\n');
    expect(output).toContain('已关联 2 个文件到任务');
    expect(output).toContain('关联材料: fixture-a.md, fixture-b.md');
  });
});
