import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import { KernelExecutorStatusProjector } from '../../src/execution/kernel-executor-status-projector.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';

describe('Kernel capacity control loop', () => {
  it('classifies an Executor image probe failure as a local blocker instead of capacity wait', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-kernel-capacity');
    const attemptExecutionBackend = new FakeAttemptExecutionBackend(() => ({ body: 'capacity recovered' }));
    attemptExecutionBackend.resolveImage.mockImplementation(async () => {
      throw new Error('image unavailable');
    });
    const plan = workGraphPlan({ goal: 'run after capacity recovers', deliveryKind: 'report' });
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
        orchestration: new OrchestrationEngine(taskEngine),
      attemptExecutionBackend,
      db,
      config,
      sessionId: 'session_capacity',
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
    expect(task.status).toBe('needs_action');
    expect(attemptExecutionBackend.create).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT action FROM kernel_decisions WHERE task_id = ? ORDER BY rowid`).all(task.id))
      .toEqual(expect.arrayContaining([{ action: 'block_work' }]));
    expect(new KernelExecutorStatusProjector(new KernelExecutorStatusRepo(db)).list('revision-test')
      .find(item => item.agentClassName === 'codex-cli')).toMatchObject({
      classHealth: 'error',
      recentAttempts: [expect.objectContaining({
        failure: expect.objectContaining({ code: 'executor_image_probe_failed' }),
      })],
    });

    expect(attemptExecutionBackend.create).not.toHaveBeenCalled();
  });
});
