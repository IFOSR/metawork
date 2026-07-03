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
import type { Config } from '../../src/core/types.js';
import type { ExecutorAdapter } from '../../src/executor/adapter.js';
import type { LlmBridge } from '../../src/core/llm-bridge.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';

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
    schemaVersion: 1,
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

function createSession(sessionId: string, planningPlan: PlanningAgentPlan) {
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
    planningAgent: { plan: vi.fn().mockResolvedValue(planningPlan) },
    availableExecutorCommands: new Set(['codex']),
  });
  session.initialize({ resumeStartupTasks: false });
  return { db, session, taskRepo, executor, planningDecisionRepo: new PlanningDecisionRepo(db), sessionId };
}

// Behavior-first coverage of the PlanningAgent -> PolicyKernel -> Runtime seam.
// Rather than grepping the session source for symbol names, these assert the
// observable side effects the seam is responsible for: a persisted
// planning_decisions audit row for every turn, plus the task/executor outcome.
describe('natural-language planning/kernel path', () => {
  it('authorizes a durable task, dispatches the executor, and audits the decision', async () => {
    const harness = createSession('sess_durable', plan());

    await harness.session.submit('实现一个普通功能', { awaitAsyncWork: true });

    expect(harness.taskRepo.findAll()).toHaveLength(1);
    expect(harness.executor.execute).toHaveBeenCalledTimes(1);

    const audits = harness.planningDecisionRepo.listBySession('sess_durable');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision.runtimeAction).toBe('plan_work_graph');
    expect(['accept', 'rewrite']).toContain(audits[0]!.outcome);
    // The decision is audited before createAndPrepareTask runs, so a fresh
    // durable task (binding 'new') is recorded with no taskId — it is bound to
    // the created task only afterwards.
    expect(audits[0]!.taskId).toBeNull();
  });

  it('handles a direct reply without creating a task and audits it', async () => {
    const harness = createSession('sess_direct', plan({
      action: 'direct_reply',
      reason: '普通对话',
      task: {
        binding: 'none',
        taskId: null,
        control: 'none',
        scope: null,
        title: null,
        goal: null,
        includeRecentConversationContext: false,
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
    const audits = harness.planningDecisionRepo.listBySession('sess_direct');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.decision.runtimeAction).toBe('direct_reply');
    expect(audits[0]!.outcome).toBe('accept');
    expect(audits[0]!.taskId).toBeNull();
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
    const audits = harness.planningDecisionRepo.listBySession('sess_clarify');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.outcome).toBe('clarify');
    expect(audits[0]!.decision.runtimeAction).toBe('clarification');
  });
});
