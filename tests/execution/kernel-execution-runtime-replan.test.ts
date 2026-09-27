import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';

/**
 * The Runtime owns only the durable scheduling postcondition. The account
 * scoped Planner Worker owns the later Planner turn and proposal submission.
 */

function replanDecision() {
  return {
    schemaVersion: 5,
    configurationRevision: 'revision-1',
    id: 'decision-1',
    eventId: 'event-1',
    reason: 'generation is quiescent',
    action: {
      type: 'schedule_replan',
      taskId: 'task-1',
      generationId: 'generation-1',
      sourceRevision: 1,
      replanJobId: 'request-1',
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

function runtimeWith(scheduleResult = true) {
  const scheduleForPlanner = vi.fn(() => scheduleResult);
  const runtime = new KernelExecutionRuntime({
    callbacks: {},
    generationReplanRepo: {
      scheduleForPlanner,
    },
    maxConcurrentAttempts: 4,
  } as never);
  return { runtime, scheduleForPlanner };
}

describe('KernelExecutionRuntime durable replan scheduling', () => {
  it('schedules the Job with the Decision-derived quiescence token', async () => {
    const { runtime, scheduleForPlanner } = runtimeWith();
    await expect(applyReplan(runtime)).resolves.toBeNull();
    expect(scheduleForPlanner).toHaveBeenCalledWith(
      'request-1',
      'quiescence_decision-1',
      expect.any(String),
    );
  });

  it('does not invoke a foreground Planner callback', async () => {
    const requestReplan = vi.fn();
    const { runtime } = runtimeWith();
    (runtime as unknown as { deps: { callbacks: { requestReplan: typeof requestReplan } } })
      .deps.callbacks.requestReplan = requestReplan;
    await applyReplan(runtime);
    expect(requestReplan).not.toHaveBeenCalled();
  });

  it('fails closed when the Job cannot be scheduled', async () => {
    const { runtime, scheduleForPlanner } = runtimeWith(false);
    await expect(applyReplan(runtime)).rejects.toThrow(
      'generation replan job could not be durably scheduled',
    );
    expect(scheduleForPlanner).toHaveBeenCalledTimes(1);
  });
});
