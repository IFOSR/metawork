import { describe, expect, it } from 'vitest';
import { createReconcilerLogReporter, formatDuration } from '../../src/server/reconciler-log.js';
import type { TaskStateReconcilerReport } from '../../src/execution/task-state-reconciler.js';

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

describe('reconciler background logging', () => {
  it('prints nothing for a periodic no-op pass', () => {
    const reporter = createReconcilerLogReporter();
    expect(reporter.report(report(), 1_000)).toEqual([]);
    expect(reporter.report(report(), 61_000)).toEqual([]);
    expect(reporter.report(report(), 121_000)).toEqual([]);
  });

  it('prints the state a pass actually changed', () => {
    const reporter = createReconcilerLogReporter();
    expect(reporter.report(report({
      changes: ['released stale conversation slot in conv_1'],
      changed: true,
      releasedSlots: 1,
    }), 1_000)).toEqual(['released stale conversation slot in conv_1']);
  });

  it('logs a retained slot on appearance, stays quiet, then reports its duration on change', () => {
    const reporter = createReconcilerLogReporter();
    const retained = report({
      retainedSlots: 1,
      retainedSlotResidue: [{ conversationId: 'conv_1', taskId: 'task_1', residue: ['kernel_application'] }],
    });
    expect(reporter.report(retained, 1_000)).toEqual([
      'retained conversation slot in conv_1 (retained, blocked for 0s): task task_1 still owns kernel_application',
    ]);
    // Same state a minute later prints nothing: the line was the whole noise.
    expect(reporter.report(retained, 61_000)).toEqual([]);
    // A residue change is a state change and carries how long it has been blocked.
    expect(reporter.report(report({
      retainedSlots: 1,
      retainedSlotResidue: [{
        conversationId: 'conv_1', taskId: 'task_1', residue: ['kernel_application', 'publication'],
      }],
    }), 121_000)).toEqual([
      'retained conversation slot in conv_1 (changed, blocked for 2m): '
      + 'task task_1 still owns kernel_application, publication',
    ]);
  });

  it('announces the release of a previously retained slot', () => {
    const reporter = createReconcilerLogReporter();
    reporter.report(report({
      retainedSlots: 1,
      retainedSlotResidue: [{ conversationId: 'conv_1', taskId: 'task_1', residue: ['kernel_application'] }],
    }), 1_000);
    expect(reporter.report(report(), 91_000)).toEqual([
      'released previously retained conversation slot in conv_1: task task_1 stayed blocked for 1m30s',
    ]);
    expect(reporter.retained()).toEqual([]);
  });

  it('re-logs a long block at most once per heartbeat', () => {
    const reporter = createReconcilerLogReporter({ heartbeatMs: 600_000 });
    const retained = report({
      retainedSlots: 1,
      retainedSlotResidue: [{ conversationId: 'conv_1', taskId: 'task_1', residue: ['kernel_application'] }],
    });
    expect(reporter.report(retained, 0)).toHaveLength(1);
    expect(reporter.report(retained, 300_000)).toEqual([]);
    expect(reporter.report(retained, 600_000)).toEqual([
      'retained conversation slot in conv_1 (still_blocked, blocked for 10m): '
      + 'task task_1 still owns kernel_application',
    ]);
  });

  it('formats bounded durations', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(90_000_000)).toBe('1d1h');
  });
});
