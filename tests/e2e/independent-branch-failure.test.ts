import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';

describe('Kernel independent branch end-to-end control loop', () => {
  it('finishes an independent branch after another branch has a configuration failure', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-kernel-capacity');
    const attemptExecutionBackend = new FakeAttemptExecutionBackend((_input, index) => index === 0
      ? { exitCode: 1, rawOutput: 'configuration invalid: test adapter binding' }
      : { body: 'independent branch completed' });
    const plan = workGraphPlan({ goal: 'independent branches', deliveryKind: 'report' });
    const first = plan.workGraph!.subtasks[0]!;
    plan.workGraph!.subtasks = [first, { ...first, id: 'independent', title: 'Independent branch', goal: 'finish independent work' }];
    const config: Config = {
      version: 1,
      executor: { command: 'codex', timeout: 60_000 },
      orchestration: {
        reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5,
        blocked_recheck_enabled: true, blocked_recheck_interval: 5,
        max_concurrent_attempts: 4,
      },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    };
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      attemptExecutionBackend,
      db,
      config,
      sessionId: 'session_capacity',
      contextRecaller: new ContextRecaller(db),
      planningAgent: stubPlanningAgent(plan),
      getRuntimeBinding: async binding => ({
        revisionId: binding.configurationRevision,
        bindingFingerprint: 'test-fingerprint',
        environment: {
          OPENAI_BASE_URL: 'https://test.invalid/v1',
          OPENAI_API_KEY: 'sk-test',
          OPENAI_MODEL: 'test-model',
        },
      }),
    });
    session.initialize({ resumeStartupTasks: false, showDashboard: false });
    db.prepare('DELETE FROM work_units').run();

    await session.submit('run after capacity recovers', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    expect(attemptExecutionBackend.create).toHaveBeenCalledTimes(2);
    const rows = db.prepare('SELECT title, status FROM subtasks WHERE task_id = ? ORDER BY title').all(task.id);
    expect(rows.filter(row => (row as { status: string }).status === 'done')).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM subtasks WHERE task_id = ? AND status = 'blocked'").get(task.id)).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM retry_wakes WHERE task_id = ?").get(task.id)).toEqual({ n: 0 });
    await session.maybeReviewTaskPoolOnTimer();
    expect(attemptExecutionBackend.create).toHaveBeenCalledTimes(2);
    db.close();
  });
});
