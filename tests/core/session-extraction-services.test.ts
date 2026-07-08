import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'path';
import { tmpdir } from 'os';
import { runMigrations } from '../../src/storage/migrations.js';
import { SessionPersistenceService } from '../../src/session/session-persistence-service.js';
import { MemoryCaptureService } from '../../src/memory/memory-capture-service.js';
import { TaskResumePlanner } from '../../src/task/task-resume-planner.js';
import { taskControlPlan } from '../support/planning-agent-plans.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { MemoryAuditEventRepo } from '../../src/storage/memory-audit-event-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { ConversationRuntimeService } from '../../src/execution/conversation-runtime-service.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { ExecutorRouteDecision } from '../../src/core/executor-router.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createRuntime(db: Database.Database) {
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, resolve(tmpdir(), `metaclaw-session-extraction-${Date.now()}`));
  const orchestration = new OrchestrationEngine(taskEngine);
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const taskRuntimeService = new TaskRuntimeService({ taskEngine, taskRepo, orchestration });
  return { taskRepo, taskEngine, taskRuntimeService };
}

describe('session extraction services', () => {
  it('persists interactions and route event results outside MetaclawSession', () => {
    const db = createTestDb();
    const service = new SessionPersistenceService(db);
    const decision: ExecutorRouteDecision = {
      selectedExecutor: 'codex-cli',
      action: 'auto_dispatch',
      candidates: [],
      primaryIntent: 'repo_execution',
      matchedBoundary: ['repo_execution'],
      rejected: [],
      reason: 'test route',
      confidence: 0.9,
    };

    service.recordInteraction({
      taskId: 'task_1',
      sessionId: 'session_1',
      userInput: 'build it',
      systemOutput: 'done',
      executorUsed: 'codex-cli',
    });
    const routeEventId = service.recordRouteEvent({
      taskId: 'task_1',
      userInput: 'build it',
      decision,
    });
    service.markRouteEventResult(routeEventId, 'success');

    const interaction = db.prepare('SELECT task_id, session_id, user_input, system_output, executor_used FROM interactions').get() as Record<string, string>;
    expect(interaction).toMatchObject({
      task_id: 'task_1',
      session_id: 'session_1',
      user_input: 'build it',
      system_output: 'done',
      executor_used: 'codex-cli',
    });
    const routeEvent = db.prepare('SELECT id, result FROM executor_route_events').get() as Record<string, string>;
    expect(routeEvent.id).toBe(routeEventId);
    expect(routeEvent.result).toBe('success');
  });

  it('captures high-confidence preferences, audits auto-capture, and emits notification candidates', () => {
    const db = createTestDb();
    const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
    const notifier = { notifyTaskCompleted: vi.fn(), notifyMemoryCandidate: vi.fn().mockResolvedValue(undefined) };
    const service = new MemoryCaptureService({
      db,
      memoryEngine,
      notifier,
      deliveryService: {
        deliverMemoryCandidate: vi.fn((notificationService, input) => {
          void notificationService.notifyMemoryCandidate(input);
        }),
      },
    });

    const lowRisk = service.captureHighConfidencePreferences('偏好：以后报告默认先给结论再给证据', 'session:test');
    const highRisk = service.captureHighConfidencePreferences('偏好：以后凡是报告都自动发给客户', 'session:test');

    expect(lowRisk.lines.join('\n')).toContain('已自动记录偏好');
    expect(memoryEngine.list().map(pref => pref.content)).toContain('以后报告默认先给结论再给证据');
    expect(new MemoryAuditEventRepo(db).findByAction('auto_capture')).toHaveLength(1);
    expect(highRisk.lines.join('\n')).toContain('高风险偏好不会静默写入');
    expect(notifier.notifyMemoryCandidate).toHaveBeenCalledTimes(1);
  });

  it('resumes a planner-pinned parked task and forks a referenced done task without session branching', () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const parked = taskEngine.create({ title: 'parked', goal: 'parked' });
    taskEngine.transition(parked.id, 'ready');
    taskEngine.transition(parked.id, 'running');
    taskEngine.park(parked.id, 'pause', {
      done: [],
      pending: ['continue'],
      nextStep: 'continue',
      pauseReason: 'pause',
    });
    // The planner already selected the parked task by taskId; runtime only
    // executes the deterministic resume (no keyword/session-pointer guessing).
    const resume = planner.planReferencedTask({
      userInput: `继续任务 ${parked.id}`,
      referencedTask: taskRuntimeService.findTask(parked.id)!,
      plan: taskControlPlan({ control: 'resume_task', taskId: parked.id, reason: 'resume parked' }),
    });
    expect(resume.action).toBe('execute_existing');
    expect(resume.action === 'execute_existing' ? resume.executionMode : null).toBe('resume-parked');

    const doneTask = taskEngine.create({ title: 'done', goal: 'done' });
    taskEngine.transition(doneTask.id, 'ready');
    taskEngine.transition(doneTask.id, 'running');
    const done = taskEngine.transition(doneTask.id, 'done');
    expect(planner.planReferencedTask({
      userInput: '基于它继续做',
      referencedTask: done,
      plan: taskControlPlan({ control: 'resume_task', taskId: done.id, reason: 'reference' }),
    }).action).toBe('fork_follow_up');
  });

  it.each([
    { control: 'recover_blocked' as const, reason: 'explicit blocked resume' },
    { control: 'resume_task' as const, reason: 'resume the blocked task' },
  ])('unblocks a planner-pinned blocked task on $control with material extraction', ({ control, reason }) => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const blocked = taskEngine.create({ title: 'blocked', goal: 'blocked' });
    taskEngine.transition(blocked.id, 'ready');
    taskEngine.transition(blocked.id, 'running');
    taskEngine.block(blocked.id, {
      taskId: blocked.id,
      type: 'manual',
      description: '等待材料',
      status: 'waiting',
    });
    const blockedSnapshot = taskRuntimeService.findTask(blocked.id);
    expect(blockedSnapshot?.status).toBe('blocked');

    const recovery = planner.planReferencedTask({
      userInput: `材料已补充，可以继续 ${blocked.id}`,
      referencedTask: blockedSnapshot!,
      plan: taskControlPlan({ control, taskId: blocked.id, reason }),
    });
    expect(recovery.action).toBe('unblock_and_execute');
    expect(recovery.action === 'unblock_and_execute'
      ? recovery.observeResumeIntent
      : null).toBe(true);
  });

  it('reports a running planner-pinned task as already executing instead of re-queueing it', () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const task = taskEngine.create({ title: 'running', goal: 'running' });
    taskEngine.transition(task.id, 'ready');
    const running = taskEngine.transition(task.id, 'running');

    const result = planner.planReferencedTask({
      userInput: `恢复任务 ${task.id}`,
      referencedTask: running,
      plan: taskControlPlan({ control: 'resume_task', taskId: task.id, reason: 'resume running' }),
    });

    expect(result.action).toBe('message');
    expect(result.action === 'message' ? result.lines.join('\n') : '').toContain('已在执行中');
  });

  it('surfaces an error for a blocked task with no waiting dependency instead of force-unblocking it', () => {
    const db = createTestDb();
    const { taskEngine, taskRuntimeService } = createRuntime(db);
    const planner = new TaskResumePlanner({ taskRuntimeService });

    const task = taskEngine.create({ title: 'blocked-no-dep', goal: 'blocked-no-dep' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    // Blocked but with no *waiting* dependency to clear (already-resolved dep):
    // a resume has nothing to unblock, so it must not silently push the task on.
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'resolved out-of-band',
      status: 'resolved',
    });
    const blocked = taskRuntimeService.findTask(task.id)!;
    expect(blocked.status).toBe('blocked');

    const result = planner.planReferencedTask({
      userInput: `网络好了，继续 ${task.id}`,
      referencedTask: blocked,
      plan: taskControlPlan({ control: 'recover_blocked', taskId: task.id, reason: 'resume blocked' }),
    });

    expect(result.action).toBe('message');
    expect(result.action === 'message' ? result.lines.join('\n') : '').toContain('错误');
  });

  it('runs normal conversation through a core runtime service and persists successful turns', async () => {
    const db = createTestDb();
    const conversationHistory = [{
      taskId: '',
      sessionId: 'session_1',
      userInput: '上一轮',
      systemOutput: '上一轮回复',
      createdAt: '2026-06-24T00:00:00.000Z',
      source: 'session' as const,
    }];
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue(conversationHistory),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const appendOutput = vi.fn();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '你好，我在。',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
      appendOutput,
    });

    const result = await service.run({
      sessionId: 'session_1',
      userInput: 'hi',
    });

    expect(result).toEqual({
      success: true,
      lines: ['你好，我在。'],
      focus: { kind: 'conversation', taskId: null },
    });
    expect(memoryContextService.recallConversationContext).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userInput: 'hi',
    });
    expect(appendOutput).toHaveBeenCalledWith(
      '【MetaClaw｜召回会话上下文】',
      '→ MetaClaw：正在召回与本次问答相关的最近对话',
    );
    expect(appendOutput).toHaveBeenCalledWith(
      '→ MetaClaw：已召回 1 条相关会话上下文',
      '→ MetaClaw：会把召回上下文注入给 Executor，保持连续问答衔接',
      '【Executor: codex-cli｜回答生成】',
      '→ Executor: codex-cli 正在基于当前问题和会话上下文生成回答',
    );
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      preferences: [],
      userPrompt: 'hi',
      conversationHistory,
      task: expect.objectContaining({
        id: expect.stringMatching(/^conv_/u),
        title: '普通对话',
        goal: 'hi',
        status: 'running',
      }),
    }));
    expect(persistenceService.recordInteraction).toHaveBeenCalledWith({
      taskId: null,
      sessionId: 'session_1',
      userInput: 'hi',
      systemOutput: '你好，我在。',
      executorUsed: 'codex-cli',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 });
  });

  it('does not persist failed or exceptional conversation turns', async () => {
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue([]),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          output: '',
          error: 'LLM failed',
          exitCode: 1,
          durationMs: 10,
        })
        .mockRejectedValueOnce(new Error('process crashed')),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
    });

    await expect(service.run({
      sessionId: 'session_1',
      userInput: '第一次',
    })).resolves.toEqual({
      success: false,
      lines: ['✗ 对话失败: LLM failed'],
      focus: null,
    });
    await expect(service.run({
      sessionId: 'session_1',
      userInput: '第二次',
    })).resolves.toEqual({
      success: false,
      lines: ['✗ 对话异常: process crashed'],
      focus: null,
    });
    expect(persistenceService.recordInteraction).not.toHaveBeenCalled();
  });

  it('shows when a conversation answer has no recalled context', async () => {
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue([]),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const appendOutput = vi.fn();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '这是一个新的回答。',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
      appendOutput,
    });

    await service.run({
      sessionId: 'session_1',
      userInput: '新问题',
    });

    expect(appendOutput).toHaveBeenCalledWith(
      '→ MetaClaw：没有召回到相关会话上下文，将按全新问题回答',
      '【Executor: codex-cli｜回答生成】',
      '→ Executor: codex-cli 正在基于当前问题生成回答',
    );
  });

  it('injects recent context for half-answer continuation replies so the executor can resolve the semantic topic', async () => {
    const recentContext = [{
      taskId: null,
      sessionId: 'session_1',
      userInput: 'MetaClaw 调度任务时为什么要明确展示 Executor？',
      systemOutput: '刚才解释到：第一，用户需要知道当前由哪个 Executor 处理；第二，里程碑要区分 MetaClaw 和 Executor。',
      createdAt: '2026-06-24T00:00:00.000Z',
      source: 'session' as const,
    }];
    const memoryContextService = {
      recallConversationContext: vi.fn().mockResolvedValue(recentContext),
    };
    const persistenceService = {
      recordInteraction: vi.fn(),
    };
    const appendOutput = vi.fn();
    const executor: ExecutorAdapter = {
      name: 'codex-cli',
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: '继续刚才的问题：第三，展示上下文召回依据可以降低用户困惑。',
        exitCode: 0,
        durationMs: 10,
      }),
      isAvailable: vi.fn().mockResolvedValue(true),
      abort: vi.fn(),
    };
    const service = new ConversationRuntimeService({
      executor,
      memoryContextService,
      persistenceService,
      appendOutput,
    });

    await service.run({
      sessionId: 'session_1',
      userInput: '这个问题你怎么回答了一半？继续完成。',
    });

    expect(memoryContextService.recallConversationContext).toHaveBeenCalledWith({
      sessionId: 'session_1',
      userInput: '这个问题你怎么回答了一半？继续完成。',
    });
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      conversationHistory: recentContext,
    }));
    expect(appendOutput).toHaveBeenCalledWith(
      '→ MetaClaw：已召回 1 条相关会话上下文',
      '→ MetaClaw：会把召回上下文注入给 Executor，保持连续问答衔接',
      '【Executor: codex-cli｜回答生成】',
      '→ Executor: codex-cli 正在基于当前问题和会话上下文生成回答',
    );
  });
});
