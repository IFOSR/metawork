import { describe, expect, it } from 'vitest';
import {
  isTaskTransitionAllowed,
  isTerminalTaskLifecycle,
  toAttemptLifecycleState,
  toAttemptOutcome,
  toSubtaskLifecycleState,
  toTaskLifecycleState,
} from '../../src/task/task-lifecycle.js';

describe('canonical Task lifecycle', () => {
  it('maps every persisted Task status to exactly one lifecycle state', () => {
    expect(toTaskLifecycleState('created')).toBe('queued');
    expect(toTaskLifecycleState('ready')).toBe('queued');
    expect(toTaskLifecycleState('running')).toBe('executing');
    expect(toTaskLifecycleState('parked')).toBe('coordinating');
    expect(toTaskLifecycleState('blocked')).toBe('blocked');
    expect(toTaskLifecycleState('done')).toBe('completed');
    expect(toTaskLifecycleState('archived')).toBe('completed');
    expect(toTaskLifecycleState('cancelled')).toBe('cancelled');
  });

  it('maps Subtask status to node lifecycle without reusing Attempt vocabulary', () => {
    expect(toSubtaskLifecycleState('ready')).toBe('pending');
    expect(toSubtaskLifecycleState('running')).toBe('executing');
    expect(toSubtaskLifecycleState('awaiting_integration')).toBe('awaiting_completion');
    expect(toSubtaskLifecycleState('awaiting_decision')).toBe('awaiting_completion');
    expect(toSubtaskLifecycleState('blocked')).toBe('blocked');
    expect(toSubtaskLifecycleState('done')).toBe('completed');
    expect(toSubtaskLifecycleState('cancelled')).toBe('cancelled');
  });

  it('separates Attempt protocol state from Attempt outcome', () => {
    expect(toAttemptLifecycleState('pending_launch')).toBe('authorized');
    expect(toAttemptLifecycleState('launching')).toBe('launched');
    expect(toAttemptLifecycleState('running')).toBe('running');
    expect(toAttemptLifecycleState('cancelling')).toBe('settling');
    expect(toAttemptLifecycleState('terminal')).toBe('settled');
    expect(toAttemptLifecycleState('uncertain')).toBe('settled');

    expect(toAttemptOutcome({ terminalState: 'completed', failure: null })).toBe('succeeded');
    expect(toAttemptOutcome({
      terminalState: 'heartbeat_lost',
      failure: null,
    })).toBe('heartbeat_lost');
    expect(toAttemptOutcome({
      terminalState: 'cancelled_or_stale',
      failure: null,
    })).toBe('cancelled');
    expect(toAttemptOutcome({
      terminalState: 'executor_failed',
      failure: { kind: 'heartbeat_lost', scope: 'agent_class', code: 'x', summary: 'lost' },
    })).toBe('heartbeat_lost');
    expect(toAttemptOutcome({
      terminalState: 'executor_failed',
      failure: { kind: 'executor_error', scope: 'agent_class', code: 'x', summary: 'failed' },
    })).toBe('failed');
    expect(toAttemptOutcome({ terminalState: null, failure: null })).toBeNull();
  });

  it('rejects cross-layer Task transitions and allows valid ones', () => {
    expect(isTaskTransitionAllowed('executing', 'coordinating')).toBe(true);
    expect(isTaskTransitionAllowed('blocked', 'executing')).toBe(true);
    expect(isTaskTransitionAllowed('completed', 'executing')).toBe(false);
    expect(isTaskTransitionAllowed('cancelled', 'blocked')).toBe(false);
    expect(isTaskTransitionAllowed('executing', 'executing')).toBe(true);
  });

  it('identifies terminal lifecycle states', () => {
    expect(isTerminalTaskLifecycle('completed')).toBe(true);
    expect(isTerminalTaskLifecycle('failed')).toBe(true);
    expect(isTerminalTaskLifecycle('cancelled')).toBe(true);
    expect(isTerminalTaskLifecycle('coordinating')).toBe(false);
  });
});
