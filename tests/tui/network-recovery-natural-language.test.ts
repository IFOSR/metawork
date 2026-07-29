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
import { stubPlanningAgent, taskControlPlan } from '../support/planning-agent-plans.js';
import { seedPersistedWorkGraph } from '../support/persisted-work-graph.js';
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

afterEach(() => {
  inputCapture.handler = undefined;
});

describe('App network recovery natural-language control', () => {
  it('unblocks and resumes a network-blocked task from natural language input', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-os-tests');
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const orchestration = new OrchestrationEngine(taskEngine);
    const contextRecaller = new ContextRecaller(db);

    const blockedTask = taskEngine.create({ title: '调研 memory', goal: '继续整理 memory 框架' });
    seedPersistedWorkGraph(db, blockedTask.id, blockedTask.title);
    taskEngine.transition(blockedTask.id, 'ready');
    taskEngine.transition(blockedTask.id, 'running');
    taskEngine.block(blockedTask.id, {
      taskId: blockedTask.id,
      type: 'manual',
      description: '执行器网络连接失败，请检查网络或代理配置',
      status: 'waiting',
    });

    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockImplementation(async input => { const result = {
        success: true,
        output: '已恢复执行',
        exitCode: 0,
        durationMs: 400,
      }; return { ...result, output: completionResponse(input, result.output, result.artifacts ?? []) }; }),
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
        sessionId: 'sess_network_nl_recovery',
        contextRecaller,
        planningAgent: stubPlanningAgent(
          taskControlPlan({ control: 'recover_blocked', taskId: blockedTask.id, scope: null }),
        ),
      }),
    );

    for (const char of '网络恢复了，继续刚才那个任务') {
      await inputCapture.handler?.(char, {});
      await flushUpdates();
    }
    await (inputCapture.handler?.('', { return: true }) ?? Promise.resolve());
    await flushUpdates();
    await flushUpdates();

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].context.taskBackground.id).toBe(blockedTask.id);
    expect(app.lastFrame()).toContain('阻塞已解除，任务重新具备执行条件');

    app.unmount();
    app.cleanup();
  });
});
