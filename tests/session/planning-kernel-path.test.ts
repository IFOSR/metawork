import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { PreferenceRepo } from '../../src/storage/preference-repo.js';
import { ObservationRepo } from '../../src/storage/observation-repo.js';
import { PlanningDecisionRepo } from '../../src/storage/planning-decision-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { MemoryEngine } from '../../src/memory/memory-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { ContextRecaller } from '../../src/memory/context-recaller.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { PolicyKernel } from '../../src/kernel/policy-kernel.js';
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import type { PlanningAgentPlan, PlanningContext } from '../../src/planning/planning-types.js';

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: { reminder_enabled: false, reminder_throttle: 3600, top_k_preferences: 5 },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

function plan(overrides: Partial<PlanningAgentPlan> = {}): PlanningAgentPlan {
  return {
    id: 'plan_test',
    schemaVersion: 2,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'planner 直接产出工作图',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'new',
      taskId: null,
      control: 'none',
      scope: null,
      title: '普通功能',
      goal: '实现一个普通功能',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'test priority' },
    },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'codex-cli',
      candidateExecutors: ['codex-cli'],
      requiresVerification: false,
      canModifyFiles: true,
      requiresExternalGateway: false,
      capabilityClass: 'code_edit',
      matchedBoundary: [],
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: {
      reason: 'single executor work graph',
      subtasks: [{
        id: 'subtask_execute',
        title: '实现一个普通功能',
        goal: '实现一个普通功能',
        dependsOn: [],
        requiredAgentClassKind: 'executor',
        agentClassHint: 'codex-cli',
        candidateAgentClasses: ['codex-cli'],
        expectedOutput: 'patch',
        acceptance: ['List changed files and provide test command output or explain why tests were not run.'],
        riskLevel: 'low',
      }],
    },
    source: 'codex-planner',
    ...overrides,
  };
}

function createSession(
  sessionId: string,
  planningPlan: PlanningAgentPlan | ((context: PlanningContext) => PlanningAgentPlan | Promise<PlanningAgentPlan>),
) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, `/tmp/metaclaw-planning-kernel-path/${sessionId}`);
  const memoryEngine = new MemoryEngine(new PreferenceRepo(db), new ObservationRepo(db));
  const executor: ExecutorAdapter = {
    name: 'codex-cli',
    execute: vi.fn().mockResolvedValue({ success: true, output: 'done', exitCode: 0, durationMs: 10 }),
    isAvailable: vi.fn().mockResolvedValue(true),
    abort: vi.fn(),
  };
  const llmBridge = {
    resolveRoute: vi.fn(),
    resolveIntent: vi.fn(),
    rankInteractions: vi.fn().mockResolvedValue([]),
  } as unknown as LlmBridge;
  const session = new MetaclawSession({
    taskEngine,
    memoryEngine,
    orchestration: new OrchestrationEngine(taskEngine),
    executor,
    db,
    config: createConfig(),
    sessionId,
    contextRecaller: new ContextRecaller(db),
    llmBridge,
    planningAgent: {
      plan: typeof planningPlan === 'function'
        ? vi.fn().mockImplementation(planningPlan)
        : vi.fn().mockResolvedValue(planningPlan),
    },
    availableExecutorCommands: new Set(['codex']),
  });
  session.initialize({ resumeStartupTasks: false });
  return { db, session, taskRepo, memoryEngine, executor, planningDecisionRepo: new PlanningDecisionRepo(db), sessionId };
}

// Behavior-first coverage of the PlanningAgent -> PolicyKernel -> Runtime seam.
// Rather than grepping the session source for symbol names, these assert the
// observable side effects the seam is responsible for: a persisted
// planning_decisions audit row for every turn, plus the task/executor outcome.
describe('natural-language planning/kernel path', () => {
  it('uses confirmed global memory in a direct reply', async () => {
    const harness = createSession('sess_direct_memory', context => plan({
      action: 'direct_reply',
      reason: '回答用户的名字',
      response: {
        directReply: JSON.stringify(context).includes('我的名字是咸蛋超人')
          ? '你的名字是咸蛋超人。'
          : '我不知道你的名字。',
      },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
      execution: {
        mode: 'none',
        complexity: 'simple',
        selectedExecutor: null,
        candidateExecutors: [],
        requiresVerification: false,
        canModifyFiles: false,
        requiresExternalGateway: false,
        capabilityClass: 'conversation',
        matchedBoundary: [],
      },
      workGraph: null,
    }));
    harness.memoryEngine.addManual({
      content: '我的名字是咸蛋超人',
      scope: 'global',
      type: 'identity',
    });

    await harness.session.submit('我的名字是什么？', { awaitAsyncWork: true });

    expect(harness.session.getSnapshot().output.join('\n')).toContain('你的名字是咸蛋超人。');
  });

  it('does not expose an unconfirmed global memory to a direct reply', async () => {
    const harness = createSession('sess_direct_pending_memory', context => plan({
      action: 'direct_reply',
      reason: '回答是否存在未确认记忆',
      response: {
        directReply: JSON.stringify(context).includes('未确认的秘密')
          ? '泄露了未确认记忆。'
          : '没有使用未确认记忆。',
      },
      task: {
        binding: 'none', taskId: null, control: 'none', scope: null,
        title: null, goal: null, includeRecentConversationContext: false, priority: null,
      },
      execution: {
        mode: 'none', complexity: 'simple', selectedExecutor: null, candidateExecutors: [],
        requiresVerification: false, canModifyFiles: false, requiresExternalGateway: false,
        capabilityClass: 'conversation', matchedBoundary: [],
      },
      workGraph: null,
    }));
    const pending = harness.memoryEngine.addManual({
      content: '未确认的秘密',
      scope: 'global',
      type: 'identity',
    });
    harness.memoryEngine.update(pending.id, { status: 'pending' });

    await harness.session.submit('你知道什么？', { awaitAsyncWork: true });

    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('没有使用未确认记忆。');
    expect(output).not.toContain('泄露了未确认记忆。');
  });

  it('recalls persisted conversation history in the next direct reply', async () => {
    let turn = 0;
    const harness = createSession('sess_direct_history', context => {
      turn += 1;
      const recalledFirstReply = JSON.stringify(context).includes('暗号是青鸟');
      return plan({
        action: 'direct_reply',
        reason: '延续当前对话',
        response: {
          directReply: turn === 1
            ? '好的，暗号是青鸟。'
            : recalledFirstReply
              ? '你刚才的暗号是青鸟。'
              : '我没有找到刚才的暗号。',
        },
        task: {
          binding: 'none',
          taskId: null,
          control: 'none',
          scope: null,
          title: null,
          goal: null,
          includeRecentConversationContext: false,
          priority: null,
        },
        execution: {
          mode: 'none',
          complexity: 'simple',
          selectedExecutor: null,
          candidateExecutors: [],
          requiresVerification: false,
          canModifyFiles: false,
          requiresExternalGateway: false,
          capabilityClass: 'conversation',
          matchedBoundary: [],
        },
        workGraph: null,
      });
    });

    await harness.session.submit('请记住，暗号是青鸟。', { awaitAsyncWork: true });
    await harness.session.submit('我刚才说的暗号是什么？', { awaitAsyncWork: true });

    expect(harness.session.getSnapshot().output.join('\n')).toContain('你刚才的暗号是青鸟。');
  });

  it('authorizes a durable task, dispatches the executor, and audits the decision', async () => {
    const harness = createSession('sess_durable', plan());

    await harness.session.submit('实现一个普通功能', { awaitAsyncWork: true });

    const [createdTask] = harness.taskRepo.findAll();
    expect(createdTask).toBeDefined();
    expect(harness.executor.execute).toHaveBeenCalledTimes(1);

    const audits = harness.planningDecisionRepo.listBySession('sess_durable');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision.runtimeAction).toBe('plan_work_graph');
    expect(['accept', 'rewrite']).toContain(audits[0]!.outcome);
    expect(audits[0]!.taskId).toBe(createdTask!.id);
  });

  it('handles a direct reply without creating a task and audits it', async () => {
    const harness = createSession('sess_direct', plan({
      action: 'direct_reply',
      reason: '普通对话',
      response: { directReply: '你好，我是 MetaClaw。' },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
      execution: {
        mode: 'none',
        complexity: 'simple',
        selectedExecutor: null,
        candidateExecutors: [],
        requiresVerification: false,
        canModifyFiles: false,
        requiresExternalGateway: false,
        capabilityClass: 'conversation',
        matchedBoundary: [],
      },
      workGraph: null,
    }));

    await harness.session.submit('你好呀', { awaitAsyncWork: true });

    expect(harness.taskRepo.findAll()).toHaveLength(0);
    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot().output.join('\n')).toContain('你好，我是 MetaClaw。');
    const audits = harness.planningDecisionRepo.listBySession('sess_direct');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision.runtimeAction).toBe('direct_reply');
    expect(audits[0]!.outcome).toBe('accept');
    expect(audits[0]!.taskId).toBeNull();
  });

  it('short-circuits the kernel decide() round-trip for a direct reply while still auditing', async () => {
    // A direct_reply is a read-only answer the planner already produced and
    // validated; the session authorizes it directly instead of running the full
    // authorization round-trip. Behavior (audit + delivery) must be unchanged.
    const decideSpy = vi.spyOn(PolicyKernel.prototype, 'decide');
    const harness = createSession('sess_shortcircuit', plan({
      action: 'direct_reply',
      reason: '普通对话',
      response: { directReply: '今天是星期四。' },
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
        priority: null,
      },
      execution: {
        mode: 'none',
        complexity: 'simple',
        selectedExecutor: null,
        candidateExecutors: [],
        requiresVerification: false,
        canModifyFiles: false,
        requiresExternalGateway: false,
        capabilityClass: 'conversation',
        matchedBoundary: [],
      },
      workGraph: null,
    }));

    await harness.session.submit('今天星期几', { awaitAsyncWork: true });

    expect(decideSpy).not.toHaveBeenCalled();
    expect(harness.executor.execute).not.toHaveBeenCalled();
    expect(harness.session.getSnapshot().output.join('\n')).toContain('今天是星期四。');
    const audits = harness.planningDecisionRepo.listBySession('sess_shortcircuit');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision.runtimeAction).toBe('direct_reply');
    expect(audits[0]!.outcome).toBe('accept');

    decideSpy.mockRestore();
  });

  it('clarifies a low-confidence state-changing turn without creating or dispatching a task', async () => {
    const harness = createSession('sess_clarify', plan({
      confidence: 0.2,
      reason: '低置信度',
      clarificationQuestion: '请明确是聊天还是创建任务。',
    }));

    await harness.session.submit('这个可能要处理一下', { awaitAsyncWork: true });

    expect(harness.taskRepo.findAll()).toHaveLength(0);
    expect(harness.executor.execute).not.toHaveBeenCalled();
    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('请明确是聊天还是创建任务。');
    expect(output).not.toContain('统一意图裁决置信度不足');
    expect(output).not.toContain('→ 输入：');
    expect(output).not.toContain('→ 判断：');
    expect(output).not.toContain('confidence=');
    const audits = harness.planningDecisionRepo.listBySession('sess_clarify');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe('clarify');
    expect(audits[0]!.decision.runtimeAction).toBe('clarification');
  });

  it('maps executor rejection to a user-safe action while preserving the audit reason', async () => {
    const rejectedPlan = plan();
    rejectedPlan.execution.selectedExecutor = 'ghost-executor';
    rejectedPlan.execution.candidateExecutors = ['ghost-executor'];
    rejectedPlan.workGraph!.subtasks[0]!.agentClassHint = 'ghost-executor';
    rejectedPlan.workGraph!.subtasks[0]!.candidateAgentClasses = ['ghost-executor'];
    const harness = createSession('sess_reject_executor', rejectedPlan);

    await harness.session.submit('交给不存在的执行器', { awaitAsyncWork: true });

    const output = harness.session.getSnapshot().output.join('\n');
    expect(output).toContain('当前没有可用的 Executor，请检查配置或注册可执行的 Executor 后重试。');
    expect(output).not.toContain('PolicyKernel rejected request');
    expect(output).not.toContain('no available executor agent class');
    const [audit] = harness.planningDecisionRepo.listBySession('sess_reject_executor');
    expect(audit?.reason).toContain('no available executor agent class');
  });
});
