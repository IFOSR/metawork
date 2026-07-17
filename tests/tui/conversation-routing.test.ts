import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { render } from 'ink-testing-library';
import { App } from '../../src/tui/app.js';
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
import { stubPlanningAgent, directReplyPlan, workGraphPlan } from '../support/planning-agent-plans.js';
import { completionResponse } from '../support/completion-response.js';

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

describe('App conversation routing', () => {
  it('handles simple conversation without creating a task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '你好，我在。',
        exitCode: 0,
        durationMs: 50,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_conversation_routing',
        contextRecaller,
        llmBridge,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: '普通问候' })),
      }),
    );

    for (const char of 'hi') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    expect(executor.execute).not.toHaveBeenCalled();
    expect(taskRepo.findAll()).toHaveLength(0);
    expect(app.lastFrame()).toContain('【MetaClaw｜理解用户请求】');
    expect(app.lastFrame()).toContain('这是一条测试直接回答');
    expect(app.lastFrame()).not.toContain('正在分析目标、上下文与可执行边界');
    expect(app.lastFrame()).not.toContain('已识别普通对话');
    expect(app.lastFrame()).not.toContain('执行策略：直接回答，不创建任务');
    expect(app.lastFrame()).not.toContain('PlanningAgent:');
    expect(app.lastFrame()).not.toContain('PolicyKernel:');

    app.unmount();
    app.cleanup();
  });

  it('renders a visible paragraph break before a new user turn after prior transcript output', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockResolvedValueOnce({
          success: true,
          output: '第一轮回复',
          exitCode: 0,
          durationMs: 50,
        })
        .mockResolvedValueOnce({
          success: true,
          output: '第二轮回复',
          exitCode: 0,
          durationMs: 50,
        }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_visible_user_turn_break',
        contextRecaller,
        llmBridge,
        planningAgent: stubPlanningAgent(directReplyPlan({ reason: '普通对话' })),
      }),
    );

    for (const char of '你在忙啥') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    for (const char of '状态是 running 吗') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }

    expect(app.lastFrame()).toContain('当前输入');
    expect(app.lastFrame()).toMatch(/这是一条测试直接回答[\s\S]*当前输入[\s\S]*> 状态是 running 吗/);

    app.unmount();
    app.cleanup();
  });

  it('prefers the current conversation focus for short continuation prompts instead of resuming an old parked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const parkedTask = taskEngine.create({
      title: 'agent memory 开源调研',
      goal: '调研 agent memory 的设计与开源方案',
    });
    taskEngine.transition(parkedTask.id, 'ready');
    taskEngine.transition(parkedTask.id, 'running');
    taskEngine.park(parkedTask.id, '被更高优先级任务抢占', {
      done: ['已整理 memory 分类'],
      pending: ['继续补齐开源项目对比'],
      nextStep: '继续完善方案对比',
      pauseReason: '被更高优先级任务抢占',
    });
    taskRepo.update(parkedTask.id, {
      lastInterruptionReason: '被更高优先级任务抢占：插入紧急任务',
      summary: '已整理 memory 分类',
      prioritySignals: {
        ...parkedTask.prioritySignals,
        isReady: false,
      },
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '最容易被替代的是通用 prompt 编排，最难被替代的是调度、状态与恢复。',
        exitCode: 0,
        durationMs: 90,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_conversation_focus',
        contextRecaller,
        llmBridge,
        executorFactory: () => executor,
        planningAgent: stubPlanningAgent(
          directReplyPlan({ reason: '普通讨论' }),
          workGraphPlan({ goal: '可以，继续', includeRecentConversationContext: true, overrides: { reason: '按当前对话创建跟进任务' } }),
        ),
      }),
    );

    await typeAndSubmit('未来最容易被基座模型替代的模块是什么');
    await typeAndSubmit('可以，继续');

    expect(executor.execute).toHaveBeenCalled();
    expect(app.lastFrame()).toContain('最容易被替代的是通用 prompt 编排');
    expect(app.lastFrame()).not.toContain(`关联到任务 #${parkedTask.id}`);
    expect(taskRepo.findById(parkedTask.id)?.status).toBe('parked');

    app.unmount();
    app.cleanup();
  });

  it('creates a new durable follow-up task from the current conversation instead of resuming an old parked task', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);
    let parkedTaskId = '';

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '三点结论：1. 强模型减少脚手架；2. 任务状态仍需系统层管理；3. 调度和恢复最难被替代。',
        exitCode: 0,
        durationMs: 90,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const llmBridge = {
      rankInteractions: vi.fn().mockResolvedValue([]),
    } as unknown as LlmBridge;

    const app = render(
      React.createElement(App, {
        taskEngine,
        memoryEngine,
        orchestration,
        executor,
        db,
        config: createConfig(),
        sessionId: 'sess_conversation_followup_task',
        contextRecaller,
        llmBridge,
        executorFactory: () => executor,
        planningAgent: stubPlanningAgent(
          directReplyPlan({ reason: '普通讨论' }),
          workGraphPlan({
            goal: '把刚才那段回答整理成三点结论',
            title: '把刚才那段回答整理成三点结论',
            includeRecentConversationContext: true,
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

    expect(executor.execute).toHaveBeenCalled();
    const followUpCall = (executor.execute as ReturnType<typeof vi.fn>).mock.calls
      .map(call => call[0])
      .find(input => input.context.taskBackground.title.includes('把刚才那段回答整理成三点结论'));
    expect(followUpCall).toBeDefined();
    expect(followUpCall!.context.taskBackground.id).not.toBe(parkedTaskId);
    expect(JSON.stringify(followUpCall!.context)).not.toContain('未来随着基座模型');
    expect(taskRepo.findById(parkedTaskId)?.status).toBe('parked');
    expect(app.lastFrame()).not.toContain(`关联到任务 #${parkedTaskId}`);

    app.unmount();
    app.cleanup();
  });
});
