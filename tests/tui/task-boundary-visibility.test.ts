import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/app.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import { stubPlanningAgent, directReplyPlan, workGraphPlan } from '../support/planning-agent-plans.js';

const inputCapture = vi.hoisted(() => ({
  handler: undefined as undefined | ((input: string, key: Record<string, boolean>) => Promise<void> | void),
}));

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');
  return {
    ...actual,
    useInput: (handler: (input: string, key: Record<string, boolean>) => Promise<void> | void) => {
      inputCapture.handler = handler;
    },
  };
});

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

function flushUpdates() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function typeAndSubmit(text: string) {
  await inputCapture.handler?.(text, {});
  await flushUpdates();

  await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
  await flushUpdates();
  await flushUpdates();
}

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App task-boundary visibility', () => {
  it('creates a conversation-derived follow-up without exposing the planner boundary reason', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    let parkedTaskId = '';

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '三点结论：1. 强模型减少脚手架；2. 任务状态仍需系统层管理；3. 调度和恢复最难被替代。',
        exitCode: 0,
        durationMs: 90,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_task_boundary_visibility_followup',
        contextRecaller,
        executorFactory: () => executor,
        planningAgent: stubPlanningAgent(
          directReplyPlan({ reason: '普通讨论' }),
          workGraphPlan({
            goal: '把刚才那段回答整理成三点结论',
            title: '把刚才那段回答整理成三点结论',
            includeRecentConversationContext: true,
            matchedBoundary: ['conversation_follow_up'],
            overrides: { reason: '按当前对话创建跟进任务' },
          }),
        ),
      }),
    );

    const parkedTask = taskEngine.create({
      title: '旧的 memory 调研任务',
      goal: '继续完善 memory 方向的开源项目对比',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户手动暂停', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '用户手动暂停',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '用户手动暂停',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });
    parkedTaskId = parkedTask.id;

    await typeAndSubmit('未来随着基座模型的能力越来越强，是否还需要 harness');
    await typeAndSubmit('把刚才那段回答整理成三点结论');

    expect(app.lastFrame()).toContain('【Executor: codex-cli｜派发准备】');
    expect(app.lastFrame()).not.toContain('按当前对话创建跟进任务');
    expect(app.lastFrame()).not.toContain(`关联到任务 #${parkedTaskId}`);

    app.unmount();
    app.cleanup();
  });

  it('keeps a short continuation in conversation mode without exposing the planner reason', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({
      title: '旧的 memory 调研任务',
      goal: '继续完善 memory 方向的开源项目对比',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '用户手动暂停', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '用户手动暂停',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '用户手动暂停',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '最容易被替代的是通用 prompt 编排，最难被替代的是调度、状态与恢复。',
        exitCode: 0,
        durationMs: 90,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_task_boundary_visibility_conversation',
        contextRecaller,
        executorFactory: () => executor,
        planningAgent: stubPlanningAgent(
          directReplyPlan({ reason: '普通讨论' }),
          directReplyPlan({ reason: '延续当前对话，不恢复旧任务' }),
        ),
      }),
    );

    await typeAndSubmit('未来随着基座模型的能力越来越强，是否还需要 harness');
    await typeAndSubmit('可以，继续');

    expect(app.lastFrame()).toContain('这是一条测试直接回答');
    expect(app.lastFrame()).not.toContain('延续当前对话，不恢复旧任务');
    expect(app.lastFrame()).not.toContain(`关联到任务 #${parkedTask.id}`);

    app.unmount();
    app.cleanup();
  });
});
