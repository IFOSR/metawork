import { describe, expect, it } from 'vitest';
import { ControlKernel, type KernelEvent, type KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { getPlannerExecutorCatalog } from '../../src/executor/builtin-executor-catalog.js';
import { workGraphPlan } from '../support/planning-agent-plans.js';

const event: KernelEvent = {
  schemaVersion: 2,
  type: 'plan_proposed',
  id: 'event_plan_1',
  correlationId: 'request_1',
  causationId: null,
  occurredAt: '2026-07-20T00:00:00.000Z',
  sessionId: 'session_1',
  generationId: 'generation_event_plan_1',
  proposalSource: 'initial',
  targetGraphRevision: 1,
  proposal: {
    id: 'plan_1',
    schemaVersion: 5,
    action: 'direct_reply',
    confidence: 0.9,
    reason: 'answer directly',
    clarificationQuestion: null,
    response: { directReply: 'Hello' },
    task: {
      binding: 'none', taskId: null, control: 'none', scope: null, title: null, goal: null,
      includeRecentConversationContext: false, priority: null,
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: null,
    source: 'codex-planner',
  },
};

const snapshot: KernelSnapshot = {
  schemaVersion: 2,
  type: 'plan_admission',
  tasks: [],
  runningTaskId: null,
  executorCatalog: getPlannerExecutorCatalog(),
  executorStatuses: [],
  v5WorkGraphTaskIds: [],
  eligibleContextRefKeys: [],
};

describe('ControlKernel', () => {
  it('produces one deterministic action for a planning event', () => {
    const kernel = new ControlKernel();

    const first = kernel.decide(event, snapshot);
    const second = kernel.decide(event, snapshot);

    expect(first).toEqual(second);
    expect(first).toEqual({
      schemaVersion: 2,
      id: 'decision_event_plan_1',
      eventId: 'event_plan_1',
      action: { type: 'deliver_direct_reply', response: 'Hello' },
      reason: 'direct reply authorized',
    });
  });

  it('authorizes a replan as the next revision of the same generation', () => {
    const proposal = workGraphPlan({
      goal: 'Finish remaining work',
      overrides: {
        task: {
          binding: 'reference', taskId: 'task_1', control: 'none', scope: null,
          title: 'Task', goal: 'Finish remaining work', includeRecentConversationContext: false,
          priority: { level: 'normal', reason: 'automatic replan' },
        },
      },
    });
    proposal.workGraph!.subtasks[0]!.contextRefs = [];
    const replanEvent: KernelEvent = {
      ...event,
      id: 'event_replan_1',
      taskId: 'task_1',
      proposal,
      generationId: 'generation_1',
      proposalSource: 'replan',
      targetGraphRevision: 2,
    };
    const replanSnapshot: KernelSnapshot = {
      ...snapshot,
      tasks: [{ id: 'task_1', status: 'running' }],
      runningTaskId: 'task_1',
      v5WorkGraphTaskIds: ['task_1'],
    };

    expect(new ControlKernel().decide(replanEvent, replanSnapshot).action).toMatchObject({
      type: 'authorize_task_plan', taskId: 'task_1', generationId: 'generation_1',
      graphRevision: 2, proposalSource: 'replan',
    });
  });

  it('selects one ready Subtask and the first authorized AgentClass', () => {
    const decision = new ControlKernel().decide(runtimeEvent({ type: 'dispatch_requested', reason: 'start' }), dispatchSnapshot());
    expect(decision.action).toMatchObject({
      type: 'dispatch_attempt', taskId: 'task_1', subtaskId: 'subtask_1', agentClassName: 'codex-cli', attemptKind: 'primary',
    });
  });

  it('tries remaining AgentClasses in order, then waits for capacity', () => {
    const kernel = new ControlKernel();
    const failed = runtimeEvent({
      type: 'capacity_signal', agentClassName: 'codex-cli', available: false, cycleId: 'cycle_1', attemptKind: 'primary',
    });
    expect(kernel.decide(failed, dispatchSnapshot()).action).toEqual({
      type: 'probe_capacity', taskId: 'task_1', subtaskId: 'subtask_1', agentClassName: 'pi-agent',
    });
    expect(kernel.decide(failed, dispatchSnapshot(['pi-agent'])).action).toEqual({
      type: 'wait_for_capacity', taskId: 'task_1', subtaskId: 'subtask_1',
    });
  });

  it('skips a class during derived cooldown and makes it eligible as the next serial probe after cooldown', () => {
    const failures = [0, 1, 2].map(index => ({
      completedAt: `2026-07-20T00:0${2 - index}:00.000Z`,
      outcome: 'failed' as const,
      failure: { kind: 'network' as const, scope: 'agent_class' as const, code: 'network_failed', summary: 'network failed' },
    }));
    const cooling = dispatchSnapshot();
    cooling.executorStatuses = [{
      agentClassName: 'codex-cli', classHealth: 'healthy', recentAttempts: failures,
      updatedAt: '2026-07-20T00:02:00.000Z',
    }];

    expect(new ControlKernel().decide(runtimeEvent({
      type: 'dispatch_requested', reason: 'cooldown dispatch', occurredAt: '2026-07-20T00:03:00.000Z',
    }), cooling).action).toMatchObject({ type: 'dispatch_attempt', agentClassName: 'pi-agent' });
    expect(new ControlKernel().decide(runtimeEvent({
      type: 'dispatch_requested', reason: 'probe dispatch', occurredAt: '2026-07-20T00:07:00.000Z',
    }), cooling).action).toMatchObject({ type: 'dispatch_attempt', agentClassName: 'codex-cli' });
  });

  it('blocks failures, continues successes, and completes an exhausted graph', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(runtimeEvent({
      type: 'execution_outcome', terminalKind: 'failed', attemptId: 'attempt_1', agentClassName: 'codex-cli',
      attemptKind: 'primary', sourceAttemptId: null,
      failure: { kind: 'unknown', scope: 'attempt', code: 'executor_failed', summary: 'executor failed' },
    }), dispatchSnapshot([], 'awaiting_decision')).action).toEqual({
      type: 'block_work', taskId: 'task_1', subtaskId: 'subtask_1',
    });
    expect(kernel.decide(runtimeEvent({
      type: 'execution_outcome', terminalKind: 'completed', attemptId: 'attempt_1', agentClassName: 'codex-cli',
      attemptKind: 'primary', sourceAttemptId: null, failure: null,
    }), dispatchSnapshot([], 'done')).action).toEqual({ type: 'complete_task', taskId: 'task_1' });
  });

  it('waits once for preferred infrastructure recovery, then falls back exactly once per remaining class', () => {
    const kernel = new ControlKernel();
    const firstFailure = executionFailure('attempt_1', 'codex-cli', 'primary', 'network');
    const firstSnapshot = dispatchSnapshot([], 'awaiting_decision');
    firstSnapshot.attempts = [attemptFact(firstFailure)];

    expect(kernel.decide(firstFailure, firstSnapshot).action).toEqual({
      type: 'wait_for_retry',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      resumeAt: '2026-07-20T00:00:05.000Z',
      agentClassName: 'codex-cli',
      sourceAttemptId: 'attempt_1',
    });

    const continuedFailure = executionFailure('attempt_2', 'codex-cli', 'continuation', 'network', 'attempt_1');
    const continuedSnapshot = dispatchSnapshot([], 'awaiting_decision');
    continuedSnapshot.attempts = [attemptFact(continuedFailure), attemptFact(firstFailure)];
    expect(kernel.decide(continuedFailure, continuedSnapshot).action).toMatchObject({
      type: 'dispatch_attempt',
      agentClassName: 'pi-agent',
      attemptKind: 'fallback',
      sourceAttemptId: 'attempt_2',
      recoveryMode: 'recovery_packet',
    });
  });

  it('falls back immediately for task failure and requests only one automatic replan per generation', () => {
    const kernel = new ControlKernel();
    const taskFailure = executionFailure('attempt_1', 'codex-cli', 'primary', 'task_failed');
    const fallbackSnapshot = dispatchSnapshot([], 'awaiting_decision');
    fallbackSnapshot.attempts = [attemptFact(taskFailure)];
    expect(kernel.decide(taskFailure, fallbackSnapshot).action).toMatchObject({
      type: 'dispatch_attempt', agentClassName: 'pi-agent', attemptKind: 'fallback',
    });

    const fallbackFailure = executionFailure('attempt_2', 'pi-agent', 'fallback', 'task_failed', 'attempt_1');
    const exhausted = dispatchSnapshot([], 'awaiting_decision');
    exhausted.attempts = [attemptFact(fallbackFailure), attemptFact(taskFailure)];
    expect(kernel.decide(fallbackFailure, exhausted).action).toEqual({
      type: 'request_replan', taskId: 'task_1', generationId: 'generation_task_1_1', sourceRevision: 1,
    });
    exhausted.automaticReplansUsed = 1;
    expect(kernel.decide(fallbackFailure, exhausted).action).toEqual({ type: 'park_for_replan', taskId: 'task_1' });
  });

  it('authorizes exactly one response-only correction and then fails closed', () => {
    const kernel = new ControlKernel();
    const first = runtimeEvent({
      type: 'handoff_contract_failed', attemptId: 'attempt_1', workUnitId: 'wu_1', agentClassName: 'codex-cli',
      contract: { schemaVersion: 2 }, violations: [{ code: 'missing', path: '$.handoffs', message: 'required' }],
      receiptCount: 1, responseBytes: 100,
    });
    expect(kernel.decide(first, dispatchSnapshot([], 'awaiting_decision')).action).toMatchObject({
      type: 'dispatch_attempt', agentClassName: 'codex-cli', attemptKind: 'contract_correction',
    });
    expect(kernel.decide({ ...first, id: 'contract_2', receiptCount: 2 }, dispatchSnapshot([], 'awaiting_decision')).action).toEqual({
      type: 'block_work', taskId: 'task_1', subtaskId: 'subtask_1',
    });
  });

  it('only probes a capacity block after the configured timer interval', () => {
    const kernel = new ControlKernel();
    const timer = runtimeEvent({
      type: 'timer_tick', occurredAt: '2026-07-20T00:01:00.000Z', wakeKind: 'capacity',
      sourceDecisionId: 'decision_capacity', scheduledFor: '2026-07-20T00:01:00.000Z', retry: null,
    });
    const timerSnapshot: KernelSnapshot = {
      schemaVersion: 2, type: 'timer', capacityBlockedAt: '2026-07-20T00:00:00.000Z', recheckAfterMs: 60_000,
      capacityAgentClasses: ['codex-cli'], executorStatuses: [],
      nativeContinuationAgentClasses: ['codex-cli'],
    };
    expect(kernel.decide(timer, timerSnapshot).action).toEqual({
      type: 'probe_capacity', taskId: 'task_1', subtaskId: 'subtask_1', agentClassName: 'codex-cli',
    });
    expect(kernel.decide({ ...timer, id: 'timer_early', occurredAt: '2026-07-20T00:00:59.999Z' }, timerSnapshot).action).toEqual({ type: 'no_op' });
  });

  it('rejects an execution request for a second active Task and fails closed on mismatched facts', () => {
    const kernel = new ControlKernel();
    expect(kernel.decide(runtimeEvent({ type: 'dispatch_requested', reason: 'start' }), {
      ...dispatchSnapshot(), runningTaskId: 'task_other',
    }).action).toEqual({ type: 'block_work', taskId: 'task_1', subtaskId: 'subtask_1' });
    expect(kernel.decide(runtimeEvent({ type: 'dispatch_requested', reason: 'start' }), {
      schemaVersion: 2, type: 'invalid', reason: 'corrupt snapshot',
    }).action.type).toBe('block_work');
  });
});

function runtimeEvent<T extends Omit<KernelEvent, keyof import('../../src/kernel/control-kernel.js').KernelEventEnvelope | 'schemaVersion' | 'id' | 'correlationId' | 'causationId' | 'occurredAt' | 'sessionId'>>(
  value: T,
): KernelEvent {
  return {
    schemaVersion: 2,
    id: `event_${value.type}`,
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: '2026-07-20T00:00:00.000Z',
    sessionId: 'session_1',
    taskId: 'task_1',
    subtaskId: 'subtask_1',
    ...value,
  } as KernelEvent;
}

function dispatchSnapshot(
  attemptedAgentClasses: string[] = [],
  status: 'ready' | 'awaiting_decision' | 'done' = 'ready',
): Extract<KernelSnapshot, { type: 'dispatch' }> {
  return {
    schemaVersion: 2,
    type: 'dispatch',
    task: { id: 'task_1', status: 'running' },
    runningTaskId: 'task_1',
    graphState: 'ready',
    subtasks: [{
      id: 'subtask_1', taskId: 'task_1', status,
      preferredAgentClassList: ['codex-cli', 'pi-agent'],
    }],
    readyFrontier: status === 'ready' ? ['subtask_1'] : [],
    attemptedAgentClasses,
    executorStatuses: [],
    correctionSupportedAgentClasses: ['codex-cli'],
    nativeContinuationAgentClasses: ['codex-cli'],
    attempts: [],
    generationId: 'generation_task_1_1',
    graphRevision: 1,
    automaticReplansUsed: 0,
    recoverySafety: 'workspace_reconcilable',
    automaticRecoveryAllowed: true,
  };
}

function executionFailure(
  attemptId: string,
  agentClassName: string,
  attemptKind: 'primary' | 'continuation' | 'fallback',
  kind: 'network' | 'task_failed',
  sourceAttemptId: string | null = null,
): Extract<KernelEvent, { type: 'execution_outcome' }> {
  return runtimeEvent({
    type: 'execution_outcome', terminalKind: 'failed', attemptId, agentClassName, attemptKind, sourceAttemptId,
    failure: {
      kind,
      scope: kind === 'task_failed' ? 'task' : 'agent_class',
      code: `${kind}_failure`,
      summary: `${kind} failure`,
    },
  }) as Extract<KernelEvent, { type: 'execution_outcome' }>;
}

function attemptFact(event: Extract<KernelEvent, { type: 'execution_outcome' }>) {
  return {
    attemptId: event.attemptId!,
    agentClassName: event.agentClassName,
    attemptKind: event.attemptKind,
    sourceAttemptId: event.sourceAttemptId,
    terminalKind: event.terminalKind,
    failure: event.failure,
    completedAt: event.occurredAt,
  };
}
