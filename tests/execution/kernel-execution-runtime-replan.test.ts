import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';

/**
 * Cancellation contract for a generation replan: when the Turn that asked for
 * it goes away, the Planner callback returns `null`. The Runtime must record an
 * intended cancellation, not a failure, and must not persist a plan.
 */

function replanDecision() {
  return {
    schemaVersion: 5,
    configurationRevision: 'revision-1',
    id: 'decision-1',
    eventId: 'event-1',
    reason: 'generation is quiescent',
    action: {
      type: 'request_replan',
      taskId: 'task-1',
      generationId: 'generation-1',
      sourceRevision: 1,
    },
  };
}

async function applyReplan(runtime: KernelExecutionRuntime): Promise<unknown> {
  return (runtime as unknown as {
    applyExecutionDecision(input: unknown): Promise<unknown>;
  }).applyExecutionDecision({
    decision: replanDecision(),
    executionId: 'execution-1',
    request: { contextTaskId: 'task-1' },
    progressTracker: undefined,
    supervisorContext: undefined,
    attemptFacts: [],
    finishExecution: async () => undefined,
  });
}

function runtimeWith(replanResult: unknown) {
  const cancel = vi.fn();
  const fail = vi.fn();
  const submitPlan = vi.fn(() => true);
  const runtime = new KernelExecutionRuntime({
    callbacks: { requestReplan: async () => replanResult },
    generationReplanRepo: {
      findByGeneration: () => ({ id: 'request-1' }),
      markPlanning: () => true,
      submitPlan,
      cancel,
      fail,
    },
    maxConcurrentAttempts: 4,
  } as never);
  return { runtime, cancel, fail, submitPlan };
}

describe('KernelExecutionRuntime replan cancellation', () => {
  it('cancels the durable request instead of failing it when no plan is produced', async () => {
    const { runtime, cancel, fail, submitPlan } = runtimeWith(null);

    await expect(applyReplan(runtime)).resolves.toBeNull();

    expect(cancel).toHaveBeenCalledWith(
      'request-1',
      'cancelled while planning',
      expect.any(String),
    );
    expect(fail).not.toHaveBeenCalled();
    expect(submitPlan).not.toHaveBeenCalled();
  });

  it('still submits a produced plan with the exact quiescence token', async () => {
    const event = { type: 'plan_proposed', id: 'replan_event_decision-1' };
    const { runtime, submitPlan, cancel } = runtimeWith(event);

    await expect(applyReplan(runtime)).resolves.toBe(event);

    expect(submitPlan).toHaveBeenCalledWith(
      'request-1',
      'quiescence_decision-1',
      event,
      expect.any(String),
    );
    expect(cancel).not.toHaveBeenCalled();
  });
});
