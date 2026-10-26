import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServerStateReconciler } from '../../src/server/server-lifecycle-maintenance.js';
import type { TaskStateReconcilerReport } from '../../src/execution/task-state-reconciler.js';

afterEach(() => vi.useRealTimers());

function report(input: Partial<TaskStateReconcilerReport> = {}): TaskStateReconcilerReport {
  return {
    ok: true,
    lines: ['task state is consistent; nothing to reconcile'],
    changes: [],
    changed: false,
    closedDispatchItems: 0,
    releasedSlots: 0,
    retainedSlots: 0,
    retainedSlotResidue: [],
    closedScheduleEntries: 0,
    ...input,
  };
}

describe('Server state reconciliation lifecycle', () => {
  it('runs once at startup and then on its interval, staying silent when idle', async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => report());
    const print = vi.fn();
    const reconciler = await startServerStateReconciler({ reconcile, print, intervalMs: 1_000 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(print).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect(print).not.toHaveBeenCalled();
    reconciler.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });

  it('prints the changes it made and reports a failing pass without stopping the loop', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reconcile = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('database is locked');
      return calls === 1
        ? report({ changes: ['released stale conversation slot in conv_1'], changed: true, releasedSlots: 1 })
        : report();
    });
    const print = vi.fn();
    const onError = vi.fn();
    const reconciler = await startServerStateReconciler({ reconcile, print, onError, intervalMs: 1_000 });
    expect(print).toHaveBeenCalledWith('released stale conversation slot in conv_1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(3);
    reconciler.stop();
  });
});
