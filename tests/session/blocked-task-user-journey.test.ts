import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import type { NotificationService } from '../../src/notifications/types.js';
import { stubPlanningAgent, workGraphPlan, taskControlPlan } from '../support/planning-agent-plans.js';

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
      reminder_enabled: true,
      reminder_throttle: 3600,
      top_k_preferences: 5,
      blocked_recheck_enabled: true,
      blocked_recheck_interval: 5,
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

describe('blocked task user journey', () => {
  it('lets the user inspect a fail-closed attempt but does not retry unknown work through /task unblock', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests-blocked-user-journey');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    const notifier: NotificationService = {
      notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined),
      notifyTaskCompleted: vi.fn().mockResolvedValue(undefined),
    };
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error: '执行器网络连接失败，请检查网络或代理配置',
          exitCode: 1,
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '阻塞解除后已完成用户旅程验收报告',
          exitCode: 0,
          durationMs: 120,
        }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      resolveTaskPriority: vi.fn().mockResolvedValue({ priority: 'normal', reason: '默认优先级' }),
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_blocked_user_journey',
      contextRecaller,
      llmBridge,
      notifier,
      availableExecutorCommands: new Set(['codex']),
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '整理 blocked 任务用户旅程验收报告', executor: 'codex-cli', matchedBoundary: ['general'] }),
        taskControlPlan({ control: 'status_query', scope: 'blocked' }),
      ),
    });

    session.initialize();
    await session.submit('整理 blocked 任务用户旅程验收报告', { awaitAsyncWork: true });

    const blockedTask = taskRepo.findByStatus('blocked')[0];
    expect(blockedTask).toBeTruthy();
    expect(blockedTask.dependencies[0]?.description).toBe('unknown requires explicit recovery');
    let output = session.getSnapshot().output.join('\n');
    expect(output).toContain('Execution blocked: unknown requires explicit recovery');

    await session.submit('当前有没有被阻塞的任务？', { awaitAsyncWork: true });
    output = session.getSnapshot().output.join('\n');
    expect(output).toContain('当前有 1 个阻塞任务');
    expect(output).toContain(`#${blockedTask.id} [BLOCKED] ${blockedTask.title}`);
    expect(output).toContain(`建议动作：/task unblock ${blockedTask.id}，或直接补充材料/说明后让我继续`);

    await session.submit(`/task unblock ${blockedTask.id}`, { awaitAsyncWork: true });

    expect(taskRepo.findById(blockedTask.id)?.status).toBe('blocked');
    expect(executor.execute).toHaveBeenCalledTimes(1);

    output = session.getSnapshot().output.join('\n');
    expect(output).toContain(`任务 #${blockedTask.id} 已提交恢复请求`);
    expect(output).toContain('no ready Subtask while work remains');
    expect(output).not.toContain('阻塞解除后已完成用户旅程验收报告');
    expect(notifier.notifyTaskCompleted).not.toHaveBeenCalled();
  });
});
