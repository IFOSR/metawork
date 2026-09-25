/**
 * 从退役 Ink 测试迁移的领域回归（统一 TUI 设计 §13.3 规则 2）。
 *
 * 原 `tests/tui/resume-bundle-integration.test.ts` 与
 * `tests/tui/unblock-scheduling.test.ts` 通过 Ink 应用驱动同一批领域服务；
 * 这里改为在 Application Shell（`MetaclawSession`）边界断言同样的领域事实：
 * 恢复/解除阻塞时传入的是持久化的任务级执行上下文，且不注入未声明的资源。
 */

import { afterEach, describe, expect, it } from 'vitest';
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
import { stubPlanningAgent, taskControlPlan } from '../support/planning-agent-plans.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  databases.push(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: { max_concurrent_attempts: 4, reminder_enabled: true, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: true },
  };
}

async function waitFor(assertion: () => void, attempts = 900): Promise<void> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

describe('persisted task execution context on resume', () => {
  it('passes the persisted task-scoped context when resuming a parked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({ title: '行业分析', goal: '完成分析摘要' });
    seedPersistedWorkGraph(db, parkedTask.id, parkedTask.title);
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被高优任务抢占', {
      done: ['报告 A 已完成'],
      pending: ['报告 B 待分析'],
      nextStep: '继续分析报告 B',
      pauseReason: '被高优任务抢占',
    });
    taskRepo.update(parkedTask.id, { lastInterruptionReason: '被任务 #task_high 抢占' });

    const attemptExecutionBackend = new FakeAttemptExecutionBackend(() => ({ body: '恢复完成' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptExecutionBackend,
      db,
      config: createConfig(),
      sessionId: 'sess_resume_context',
      contextRecaller,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'resume_task', taskId: parkedTask.id }),
      ),
    });

    session.initialize();
    await session.submit('继续刚才的行业分析', { awaitAsyncWork: true });

    await waitFor(() => {
      expect(attemptExecutionBackend.create).toHaveBeenCalled();
      const executionCall = attemptExecutionBackend.create.mock.calls
        .find(call => call[0].taskId === parkedTask.id);
      const prompt = executionCall?.[0].args.at(-1);
      expect(prompt).toContain('Background goal: 完成分析摘要');
      // 已完成的材料不重复注入上下文。
      expect(prompt).not.toContain('报告 A 已完成');
    });
    await session.dispose();
  });

  it('persists newly provided resources without injecting undeclared resources into context', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '起诉书草稿', goal: '补齐起诉材料' });
    seedPersistedWorkGraph(db, blockedTask.id, blockedTask.title);
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '等待客户补充证据文件',
      status: 'waiting',
    });

    const attemptExecutionBackend = new FakeAttemptExecutionBackend(() => ({ body: '已恢复处理' }));
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      attemptExecutionBackend,
      db,
      config: createConfig(),
      sessionId: 'sess_unblock_resources',
      contextRecaller,
    });

    session.initialize();
    await session.submit(`/task unblock ${blockedTask.id} /tmp/evidence-v3.pdf`, { awaitAsyncWork: true });

    let executionPrompt: string | null = null;
    await waitFor(() => {
      expect(attemptExecutionBackend.create).toHaveBeenCalled();
      const executionCall = attemptExecutionBackend.create.mock.calls
        .find(call => call[0].taskId === blockedTask.id);
      executionPrompt = executionCall?.[0].args.at(-1) ?? null;
      expect(executionPrompt).toBeTruthy();
    });
    expect(executionPrompt).not.toContain('/tmp/evidence-v3.pdf');
    expect(taskRepo.findById(blockedTask.id)?.resources).toContain('/tmp/evidence-v3.pdf');
    await session.dispose();
  });
});
