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
