import { describe, expect, it, vi } from 'vitest';
import type { ControlDecision, ControlEvent } from '../../src/control/control-contracts.js';
import { ControlApplicationInterruptedError } from '../../src/control/control-workflow.js';
import { TaskControlWorkflow } from '../../src/execution/task-control-workflow.js';

function event(id = 'event-1'): ControlEvent {
  return {
    schemaVersion: 5,
    configurationRevision: 'revision-1',
    type: 'dispatch_requested',
    id,
    correlationId: id,
    causationId: null,
    occurredAt: '2026-11-10T00:00:00.000Z',
    sessionId: 'session-1',
    taskId: 'task-1',
    reason: 'test',
  } as ControlEvent;
}

function decisionFor(input: ControlEvent, action: ControlDecision['action'] = {
  type: 'no_op',
}): ControlDecision {
  return {
    schemaVersion: 5,
    configurationRevision: input.configurationRevision,
    id: `decision-${input.id}`,
    eventId: input.id,
    action,
    reason: 'test',
  };
}

describe('TaskControlWorkflow contract and interruption handling', () => {
  it('drains an event submitted while an empty recovery drain is completing', async () => {
    const apply = vi.fn(async () => null);
    const workflow = new TaskControlWorkflow({ kernel: { decide: input => decisionFor(input) },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply }, clock: { now: () => 'now' } });
    const recovering = workflow.recover();
    await Promise.resolve();
    const submitted = workflow.submit(event());
    await recovering;
    expect(await submitted).toMatchObject({ decisions: [decisionFor(event())], quiescent: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('records an interrupted application as pending recovery', async () => {
    const recordUncertain = vi.fn();
    const workflow = new TaskControlWorkflow({
      kernel: { decide: input => decisionFor(input) },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply: async () => { throw new ControlApplicationInterruptedError(); } },
      clock: { now: () => '2026-11-10T00:00:00.000Z' },
      acceptedEventTypes: ['dispatch_requested'],
      acceptedActions: ['no_op'],
      recordUncertain,
    });

    const result = await workflow.submit(event());

    expect(result).toMatchObject({ pendingRecovery: 1, quiescent: true });
    expect(recordUncertain).toHaveBeenCalledTimes(1);
    expect(recordUncertain.mock.calls[0]?.[0]).toMatchObject({
      operation: { id: 'decision-event-1' },
      taskId: 'task-1',
      error: expect.any(ControlApplicationInterruptedError),
    });
  });

  it.each([new ControlApplicationInterruptedError(), new Error('IO failed')])(
    'keeps immediate retries and recovery visibly uncertain without repeating effects (%s)', async error => {
      const apply = vi.fn(async () => { throw error; });
      const recordUncertain = vi.fn();
      const workflow = new TaskControlWorkflow({
        kernel: { decide: input => decisionFor(input) },
        buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
        runtime: { apply }, clock: { now: () => 'now' }, recordUncertain,
      });
      await workflow.submit(event());
      expect(await workflow.submit(event())).toMatchObject({ decisions: [], pendingRecovery: 1 });
      expect(await workflow.recover()).toMatchObject({ pendingRecovery: 1, applicationCounts: { uncertain: 1 } });
      expect(apply).toHaveBeenCalledTimes(1);
      expect(recordUncertain).toHaveBeenCalledTimes(1);
    },
  );

  it('allows retry after snapshot failure before applying effects', async () => {
    const apply = vi.fn(async () => null);
    const buildSnapshot = vi.fn().mockImplementationOnce(() => { throw new Error('snapshot failed'); })
      .mockReturnValue({ schemaVersion: 5, type: 'dispatch' });
    const workflow = new TaskControlWorkflow({ kernel: { decide: input => decisionFor(input) },
      buildSnapshot, runtime: { apply }, clock: { now: () => 'now' } });
    await expect(workflow.submit(event())).rejects.toThrow('snapshot failed');
    expect(await workflow.submit(event())).toMatchObject({ pendingRecovery: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('shares the pending result with a concurrent caller for the same event', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.fn(async () => { await waiting; return null; });
    const workflow = new TaskControlWorkflow({ kernel: { decide: input => decisionFor(input) },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply }, clock: { now: () => 'now' } });
    const first = workflow.submit(event());
    const second = workflow.submit(event());
    release();
    const results = await Promise.all([first, second]);
    expect(results[1]).toEqual(results[0]);
    expect(results[1]!.decisions).toHaveLength(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not evict an uncertain event when the settled-event cache fills', async () => {
    const apply = vi.fn(async (decision: ControlDecision) => {
      if (decision.eventId === 'event-1') throw new ControlApplicationInterruptedError();
      return null;
    });
    const workflow = new TaskControlWorkflow({ kernel: { decide: input => decisionFor(input) },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply }, clock: { now: () => 'now' }, recordUncertain: vi.fn() });
    await workflow.submit(event());
    for (let index = 0; index < 520; index += 1) await workflow.submit(event(`settled-${index}`));
    expect(await workflow.submit(event())).toMatchObject({ pendingRecovery: 1, decisions: [] });
    expect(apply).toHaveBeenCalledTimes(521);
  });

  it('retains the uncertainty fence when recording recovery fails', async () => {
    const apply = vi.fn(async () => { throw new ControlApplicationInterruptedError(); });
    const workflow = new TaskControlWorkflow({ kernel: { decide: input => decisionFor(input) },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply }, clock: { now: () => 'now' },
      recordUncertain: () => { throw new Error('recovery write failed'); } });
    await expect(workflow.submit(event())).rejects.toThrow('recovery write failed');
    expect(await workflow.submit(event())).toMatchObject({ pendingRecovery: 1 });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('rejects event types outside the workflow allowlist before deciding', async () => {
    const decide = vi.fn(() => decisionFor(event()));
    const workflow = new TaskControlWorkflow({
      kernel: { decide },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply: async () => null },
      clock: { now: () => '2026-11-10T00:00:00.000Z' },
      acceptedEventTypes: ['timer_tick'],
    });

    await expect(workflow.submit(event())).rejects.toMatchObject({ code: 'event_type_not_allowed' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('rejects decisions outside the workflow action allowlist before applying', async () => {
    const apply = vi.fn(async () => null);
    const workflow = new TaskControlWorkflow({
      kernel: { decide: input => decisionFor(input, { type: 'block_work', taskId: 'task-1' }) },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' }) as never,
      runtime: { apply },
      clock: { now: () => '2026-11-10T00:00:00.000Z' },
      acceptedEventTypes: ['dispatch_requested'],
      acceptedActions: ['no_op'],
    });

    await expect(workflow.submit(event())).rejects.toMatchObject({ code: 'action_not_allowed' });
    expect(apply).not.toHaveBeenCalled();
  });
});
