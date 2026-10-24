import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  createTaskReason,
  evaluateTaskState,
  isTaskStatusTransitionAllowed,
  isTerminalTaskStatus,
  normalizeTaskStateDetail,
  NO_TASK_CLEANUP,
  type TaskEvaluationFacts,
  type TaskPendingAction,
  type TaskRequiredWorkFact,
} from '../../src/task/task-state.js';
import {
  isSubtaskTransitionAllowed,
  toAttemptLifecycleState,
  toAttemptOutcome,
  toSubtaskLifecycleState,
} from '../../src/task/task-lifecycle.js';

const at = '2026-10-22T00:00:00.000Z';

function facts(overrides: Partial<TaskEvaluationFacts> = {}): TaskEvaluationFacts {
  return {
    taskId: 'task_1',
    currentStatus: 'queued',
    cancelFence: false,
    requiredWork: [],
    pendingActions: [],
    runnableWork: false,
    activeOperation: null,
    boundedRecovery: null,
    slot: 'none',
    capacityWaiting: false,
    cleanup: NO_TASK_CLEANUP,
    failureReason: null,
    anomaly: null,
    observedAt: at,
    ...overrides,
  };
}

function work(
  key: string,
  state: TaskRequiredWorkFact['state'],
  reason: TaskRequiredWorkFact['reason'] = null,
): TaskRequiredWorkFact {
  return { key, kind: 'execution', label: key, state, reason };
}

function action(kind: TaskPendingAction['kind'] = 'accept_result'): TaskPendingAction {
  return {
    actionId: `action:${kind}`,
    kind,
    label: kind,
    reason: createTaskReason(
      kind === 'accept_result' ? 'result_acceptance_required' : 'input_required',
      'needs the user',
    ),
    result: null,
  };
}

describe('six-state Task contract', () => {
  it('defines exactly the six states and one terminal set', () => {
    expect([...TASK_STATUSES]).toEqual([
      'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled',
    ]);
    expect(isTerminalTaskStatus('succeeded')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('queued')).toBe(false);
    expect(isTerminalTaskStatus('running')).toBe(false);
    expect(isTerminalTaskStatus('needs_action')).toBe(false);
  });

  it('keeps the one transition table', () => {
    expect(isTaskStatusTransitionAllowed('queued', 'running')).toBe(true);
    expect(isTaskStatusTransitionAllowed('queued', 'failed')).toBe(true);
    expect(isTaskStatusTransitionAllowed('running', 'queued')).toBe(true);
    expect(isTaskStatusTransitionAllowed('running', 'succeeded')).toBe(true);
    expect(isTaskStatusTransitionAllowed('needs_action', 'queued')).toBe(true);
    expect(isTaskStatusTransitionAllowed('needs_action', 'succeeded')).toBe(false);
    expect(isTaskStatusTransitionAllowed('succeeded', 'running')).toBe(false);
    expect(isTaskStatusTransitionAllowed('failed', 'queued')).toBe(false);
    expect(isTaskStatusTransitionAllowed('cancelled', 'needs_action')).toBe(false);
    // Same-state submission is the reason/cleanup update path.
    expect(isTaskStatusTransitionAllowed('running', 'running')).toBe(true);
  });

  it('maps Subtask status to node lifecycle without reusing Attempt vocabulary', () => {
    expect(toSubtaskLifecycleState('ready')).toBe('pending');
    expect(toSubtaskLifecycleState('running')).toBe('executing');
    expect(toSubtaskLifecycleState('awaiting_integration')).toBe('awaiting_completion');
    expect(toSubtaskLifecycleState('awaiting_decision')).toBe('awaiting_completion');
    expect(toSubtaskLifecycleState('blocked')).toBe('blocked');
    expect(toSubtaskLifecycleState('done')).toBe('completed');
    expect(toSubtaskLifecycleState('cancelled')).toBe('cancelled');
    expect(isSubtaskTransitionAllowed('executing', 'awaiting_completion')).toBe(true);
    expect(isSubtaskTransitionAllowed('completed', 'executing')).toBe(false);
  });

  it('separates Attempt protocol state from Attempt outcome', () => {
    expect(toAttemptLifecycleState('pending_launch')).toBe('authorized');
    expect(toAttemptLifecycleState('launching')).toBe('launched');
    expect(toAttemptLifecycleState('running')).toBe('running');
    expect(toAttemptLifecycleState('cancelling')).toBe('settling');
    expect(toAttemptLifecycleState('terminal')).toBe('settled');
    expect(toAttemptLifecycleState('uncertain')).toBe('settled');

    expect(toAttemptOutcome({ terminalState: 'completed', failure: null })).toBe('succeeded');
    expect(toAttemptOutcome({ terminalState: 'heartbeat_lost', failure: null })).toBe('heartbeat_lost');
    expect(toAttemptOutcome({ terminalState: 'cancelled_or_stale', failure: null })).toBe('cancelled');
    expect(toAttemptOutcome({
      terminalState: 'executor_failed',
      failure: { kind: 'heartbeat_lost', scope: 'agent_class', code: 'x', summary: 'lost' },
    })).toBe('heartbeat_lost');
    expect(toAttemptOutcome({
      terminalState: 'executor_failed',
      failure: { kind: 'task_failed', scope: 'attempt', code: 'x', summary: 'failed' },
    })).toBe('failed');
    expect(toAttemptOutcome({ terminalState: null, failure: null })).toBeNull();
  });
});

describe('evaluateTaskState summary order', () => {
  it('1. keeps a terminal conclusion and only records cleanup', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'failed',
      requiredWork: [work('execution:a', 'completed')],
      cleanup: { state: 'pending', objects: ['dispatch'], reason: 'stopping' },
      failureReason: createTaskReason('port_in_use', '端口已被占用'),
    }));
    expect(evaluation.status).toBe('failed');
    expect(evaluation.detail.reason.code).toBe('port_in_use');
    expect(evaluation.detail.cleanup.state).toBe('pending');
  });

  it('2. a committed cancellation fence wins over a completion claim', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      cancelFence: true,
      requiredWork: [work('execution:a', 'completed')],
    }));
    expect(evaluation.status).toBe('cancelled');
    expect(evaluation.detail.reason.code).toBe('user_cancelled');
  });

  it('3. an active operation makes the Task running', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      activeOperation: { phase: 'executing', reason: null },
      requiredWork: [work('execution:a', 'running')],
    }));
    expect(evaluation.status).toBe('running');
    expect(evaluation.detail.phase).toBe('executing');
  });

  it('3b. an armed bounded retry keeps the Task running', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      boundedRecovery: { nextWakeAt: '2026-10-22T00:05:00.000Z', reason: null },
    }));
    expect(evaluation.status).toBe('running');
    expect(evaluation.detail.phase).toBe('retrying');
    expect(evaluation.detail.nextWakeAt).toBe('2026-10-22T00:05:00.000Z');
  });

  it('4. required work that definitively failed fails the Task and keeps the reason', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      requiredWork: [
        work('execution:a', 'completed'),
        work('service', 'failed', createTaskReason('port_in_use', '端口已被占用')),
      ],
    }));
    expect(evaluation.status).toBe('failed');
    expect(evaluation.detail.reason.code).toBe('port_in_use');
  });

  it('5. a pending user action stops the Task in needs_action', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      pendingActions: [action('accept_result')],
      requiredWork: [work('execution:a', 'waiting_for_user')],
    }));
    expect(evaluation.status).toBe('needs_action');
    expect(evaluation.detail.pendingActions).toHaveLength(1);
  });

  it('5b. runnable work keeps the Task moving while another branch waits for the user', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      pendingActions: [action('accept_result')],
      runnableWork: true,
      slot: 'held',
    }));
    expect(evaluation.status).toBe('running');
  });

  it('6. all required work complete means succeeded', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      requiredWork: [work('execution:a', 'completed'), work('service', 'completed')],
    }));
    expect(evaluation.status).toBe('succeeded');
  });

  it('7. ready work that only lacks a slot is queued', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      requiredWork: [work('execution:a', 'pending')],
      runnableWork: true,
    }));
    expect(evaluation.status).toBe('queued');
    expect(evaluation.detail.reason.code).toBe('waiting_for_capacity');
  });

  it('7b. a capacity wait is queued, not running, even while the slot is held', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'running',
      requiredWork: [work('execution:a', 'pending')],
      runnableWork: true,
      slot: 'held',
      capacityWaiting: true,
    }));
    expect(evaluation.status).toBe('queued');
  });

  it('8. nothing to do and nothing known is an explicit anomaly, never running', () => {
    const evaluation = evaluateTaskState(facts({ currentStatus: 'running' }));
    expect(evaluation.status).toBe('needs_action');
    expect(evaluation.detail.reason.code).toBe('no_authorized_driver');
  });

  it('8b. a proven dead end fails instead of waiting forever', () => {
    const evaluation = evaluateTaskState(facts({
      currentStatus: 'queued',
      anomaly: createTaskReason('requirements_incomplete', '要求无法完成'),
    }));
    expect(evaluation.status).toBe('failed');
  });

  it('bounds and sanitizes persisted detail', () => {
    const detail = normalizeTaskStateDetail({
      reason: {
        code: 'port_in_use',
        message: 'x'.repeat(5000),
        evidenceRefs: Array.from({ length: 50 }, (_unused, index) => `e${index}`),
      },
      unresolved: Array(50).fill({ code: 'execution_failed', message: 'a' }),
      phase: 'not_a_phase',
      pendingActions: Array(50).fill({ actionId: 'a', kind: 'accept_result', label: 'l', reason: { code: 'input_required' } }),
      requiredWork: Array(50).fill({ key: 'k', kind: 'execution', label: 'l', state: 'pending' }),
      cleanup: {
        state: 'pending',
        objects: Array.from({ length: 50 }, (_unused, index) => `o${index}`),
        reason: 'r',
      },
      nextWakeAt: '2026-10-22T00:05:00.000Z',
    });
    expect(detail.reason.message.length).toBeLessThanOrEqual(320);
    expect(detail.reason.evidenceRefs).toHaveLength(8);
    expect(detail.unresolved).toHaveLength(8);
    expect(detail.pendingActions).toHaveLength(8);
    expect(detail.requiredWork).toHaveLength(24);
    expect(detail.cleanup.objects).toHaveLength(12);
    expect(detail.phase).toBeNull();
  });
});
