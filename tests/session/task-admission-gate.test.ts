import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types.js';
import { TaskAdmissionGate } from '../../src/session/task-admission-gate.js';

function runningTask(id = 'task_running'): Task {
  return {
    id,
    title: 'active task',
    goal: 'do active work',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: {
      dueAt: null,
      isReady: true,
      progressRatio: 0,
      blocksOthers: false,
      idleHours: 0,
    },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
  };
}

describe('TaskAdmissionGate', () => {
  it('blocks execution preparation for a different top-level task', () => {
    const gate = new TaskAdmissionGate();
    const result = gate.evaluateExecution({
      taskId: 'task_other',
      runningTask: runningTask('task_active'),
    });

    expect(result.allowed).toBe(false);
    expect(result.lines.join('\n')).toContain('#task_active');
    expect(result.lines.join('\n')).toContain('#task_other');
  });

  it('allows execution preparation for the same active task', () => {
    const gate = new TaskAdmissionGate();

    expect(gate.evaluateExecution({
      taskId: 'task_active',
      runningTask: runningTask('task_active'),
    }).allowed).toBe(true);
  });
});
