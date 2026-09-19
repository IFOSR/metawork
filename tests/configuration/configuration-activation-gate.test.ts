import { describe, expect, it } from 'vitest';
import {
  ConfigurationActivationBlockedError,
  ConfigurationActivationGate,
} from '../../src/configuration/configuration-activation-gate.js';

describe('ConfigurationActivationGate', () => {
  it('allows activation while clients are connected but no work is active', () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    }));

    expect(gate.getStatus()).toMatchObject({
      status: 'idle',
      activationAllowed: true,
      blockingReasons: [],
    });
  });

  it('blocks activation with structured reasons for Planner and Executor activity', async () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: 'task-1',
      plannerTurnActive: true,
      activeAttemptCount: 2,
      activeLeaseCount: 1,
      publicationPending: true,
      recoveryInProgress: false,
    }));

    const status = gate.getStatus();
    expect(status.status).toBe('busy');
    expect(status.activationAllowed).toBe(false);
    expect(status.blockingReasons.map(reason => reason.code)).toEqual([
      'planner_turn_active',
      'task_running',
      'executor_attempt_active',
      'resource_lease_active',
      'publication_pending',
    ]);
    await expect(gate.withActivation(async () => undefined))
      .rejects.toThrow(ConfigurationActivationBlockedError);
  });

  it('blocks activation while continuable unfinished tasks remain', () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
      unfinishedWork: {
        count: 2,
        items: [
          { taskId: 'task-1', status: 'parked', conversationId: 'conv-1' },
          { taskId: 'task-2', status: 'blocked', conversationId: 'conv-2' },
        ],
      },
    }));

    const status = gate.getStatus();
    expect(status.status).toBe('busy');
    expect(status.activationAllowed).toBe(false);
    expect(status.blockingReasons.map(reason => reason.code)).toEqual(['unfinished_task']);
    expect(status.blockingReasons[0]).toMatchObject({ code: 'unfinished_task', count: 2 });
  });

  it('blocks activation while accepted work requests are still pending', () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
      pendingWorkRequestCount: 1,
    }));

    const status = gate.getStatus();
    expect(status.activationAllowed).toBe(false);
    expect(status.blockingReasons.map(reason => reason.code)).toEqual(['work_request_pending']);
  });

  it('allows activation when only terminal tasks and idle connections exist', () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
      unfinishedWork: { count: 0, items: [] },
      pendingWorkRequestCount: 0,
    }));

    expect(gate.getStatus()).toMatchObject({ status: 'idle', activationAllowed: true });
  });

  it('exposes whether a configuration transaction is in progress', async () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    }));
    expect(gate.isActivationInProgress()).toBe(false);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = gate.withActivation(async () => hold);
    await Promise.resolve();
    expect(gate.isActivationInProgress()).toBe(true);
    release();
    await first;
    expect(gate.isActivationInProgress()).toBe(false);
  });

  it('serializes activation and exposes activation_in_progress to concurrent callers', async () => {
    const gate = new ConfigurationActivationGate(() => ({
      activeTaskId: null,
      plannerTurnActive: false,
      activeAttemptCount: 0,
      activeLeaseCount: 0,
      publicationPending: false,
      recoveryInProgress: false,
    }));
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = gate.withActivation(async () => hold);
    await Promise.resolve();
    expect(gate.getStatus()).toMatchObject({ status: 'activating', activationAllowed: false });
    await expect(gate.withActivation(async () => undefined))
      .rejects.toThrow(ConfigurationActivationBlockedError);
    release();
    await first;
    expect(gate.getStatus().status).toBe('idle');
  });
});
