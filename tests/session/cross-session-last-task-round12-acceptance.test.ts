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
import { stubPlanningAgent, workGraphPlan, taskControlPlan } from '../support/planning-agent-plans.js';
import { seedPersistedV3WorkGraph } from '../support/persisted-work-graph.js';
import { completionResponse } from '../support/completion-response.js';

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
    },
    ui: {
      language: 'zh-CN',
      dashboard_on_start: true,
    },
  };
}

function createDurableRouteBridge(overrides: Partial<LlmBridge> = {}) {
  return {
    resolveRoute: vi.fn().mockResolvedValue({
      route: 'durable_task',
      reason: '明确任务',
    }),
    resolveIntent: vi.fn().mockResolvedValue({
      type: 'new',
      taskId: null,
      reason: '新任务',
    }),
    rankInteractions: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as LlmBridge;
}

describe('cross-session last-task continuation', () => {
  it('auto-creates a follow-up instead of asking for confirmation when the last focused task is done', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor1: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '智谱投资分析已完成',
        exitCode: 0,
        durationMs: 100,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const session1 = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor: executor1,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_a',
      contextRecaller,
      llmBridge: createDurableRouteBridge(),
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: '智谱这家公司从现在看是否值得投资？你怎么看？' }),
      ),
      availableExecutorCommands: new Set(['codex']),
    });

    session1.initialize();
    await session1.submit('智谱这家公司从现在看是否值得投资？你怎么看？', { awaitAsyncWork: true });
    await session1.submit('/exit', { awaitAsyncWork: true });

    const executor2: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: 'follow-up 已执行',
        exitCode: 0,
        durationMs: 100,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge2 = createDurableRouteBridge();
    // The planner sees session1's completed task in recentTasks and pins it by
    // taskId. Runtime then forks a follow-up from that referenced done task —
    // no session-pointer guessing, no 'last_task_continuation' control.
    const completedTaskId = taskRepo.findByStatus('done')[0]!.id;
    const session2 = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor: executor2,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_b',
      contextRecaller,
      llmBridge: llmBridge2,
      planningAgent: stubPlanningAgent(
        workGraphPlan({ goal: `继续已完成任务 ${completedTaskId} 的后续工作` }),
      ),
      availableExecutorCommands: new Set(['codex']),
    });

    session2.initialize();
    await session2.submit('继续之前的任务', { awaitAsyncWork: true });

    expect(executor2.execute).toHaveBeenCalledTimes(1);
    const followUpInput = (executor2.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(followUpInput.context.taskBackground.id).not.toBe(completedTaskId);
  });

  it('resumes a planner-pinned parked task across sessions', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({
      title: '历史未完成调研',
      goal: '继续历史未完成调研',
    });
    seedPersistedV3WorkGraph(db, parkedTask.id, parkedTask.title);
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '等待继续', {
      done: ['已整理框架'],
      pending: ['继续补齐数据'],
      nextStep: '继续补齐数据',
      pauseReason: '等待继续',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '历史任务已恢复',
        exitCode: 0,
        durationMs: 100,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = createDurableRouteBridge();
    const session = new MetaclawSession({
      taskEngine,
      memoryEngine,
      orchestration,
      executor,
      db,
      config: createConfig(),
      sessionId: 'sess_round12_e',
      contextRecaller,
      llmBridge,
      planningAgent: stubPlanningAgent(
        taskControlPlan({ control: 'resume_task', taskId: parkedTask.id }),
      ),
      availableExecutorCommands: new Set(['codex']),
    });

    session.initialize();
    await session.submit('继续之前的任务', { awaitAsyncWork: true });

    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
