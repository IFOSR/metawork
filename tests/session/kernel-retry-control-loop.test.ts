import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import { completionResponse } from '../support/completion-response.js';
import { stubPlanningAgent, workGraphPlan } from '../support/planning-agent-plans.js';

describe('Kernel durable retry control loop', () => {
  it('drains a persisted retry wake into one native continuation and completion', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-kernel-retry');
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      supportsContinuation: true,
      execute: vi.fn()
        .mockImplementationOnce(async input => {
          input.recovery?.onContinuationToken?.('codex-thread-1');
          return {
            success: false,
            output: '',
            error: 'network unavailable',
            failure: { kind: 'network', scope: 'agent_class', code: 'network_failure', summary: 'network unavailable' },
            exitCode: 1,
            durationMs: 1,
          };
        })
        .mockImplementationOnce(async input => ({
          success: true,
          output: completionResponse(input, 'continued successfully', []),
          exitCode: 0,
          durationMs: 1,
        })),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const config: Config = {
      version: 1,
      executor: { command: 'codex', timeout: 60_000 },
      orchestration: {
        max_concurrent_attempts: 4,
        reminder_enabled: false,
        reminder_throttle: 3_600,
        top_k_preferences: 5,
        blocked_recheck_enabled: true,
        blocked_recheck_interval: 5,
      },
      ui: { language: 'zh-CN', dashboard_on_start: false },
    };
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine: new MemoryEngine(new PreferenceRepo(db)),
      orchestration: new OrchestrationEngine(taskEngine),
      executor,
      executorFactory: () => executor,
      db,
      config,
      sessionId: 'session_retry',
      contextRecaller: new ContextRecaller(db),
      planningAgent: stubPlanningAgent(workGraphPlan({ goal: 'continue after a transient network failure' })),
      availableExecutorCommands: new Set(['codex']),
    });
    session.initialize({ resumeStartupTasks: false, showDashboard: false });

    await session.submit('continue after a transient network failure', { awaitAsyncWork: true });

    const [task] = taskRepo.findAll();
    expect(task.status).toBe('blocked');
    expect(task.dependencies[0]).toMatchObject({ type: 'kernel_retry', status: 'waiting' });
    expect(db.prepare(`SELECT action FROM kernel_decisions WHERE task_id = ? ORDER BY rowid`).all(task.id))
      .toEqual(expect.arrayContaining([{ action: 'wait_for_retry' }]));

    db.prepare(`
      UPDATE kernel_events SET available_at = '2000-01-01T00:00:00.000Z'
      WHERE task_id = ? AND event_type = 'timer_tick' AND status = 'pending'
    `).run(task.id);
    const handled = await session.maybeReviewTaskPoolOnTimer();

    expect(handled).toBe(true);
    expect(taskRepo.findById(task.id)?.status).toBe('done');
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executor.execute).mock.calls[1]?.[0].recovery).toMatchObject({
      mode: 'native_session',
      continuationToken: 'codex-thread-1',
    });
    expect(db.prepare(`
      SELECT attempt_kind, source_attempt_id FROM executor_attempt_receipts
      WHERE task_id = ? ORDER BY completed_at, attempt_id
    `).all(task.id)).toEqual([
      { attempt_kind: 'primary', source_attempt_id: null },
      expect.objectContaining({ attempt_kind: 'continuation', source_attempt_id: expect.any(String) }),
    ]);
  });
});
