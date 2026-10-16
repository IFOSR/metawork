import { describe, expect, it } from 'vitest';
import { collectDetailEvents } from '../../web/src/components/ExecutionDetailDrawer.js';
import type { ExecutionTimeline, InteractionTraceEvent } from '../../web/src/api/types.js';

const text = 'Executor processing cycle started';
const time = '2026-10-15T10:45:56.878Z';
function trace(sequence: number, attemptId = 'attempt-1'): InteractionTraceEvent {
  return {
    id: `progress-${sequence}`, sequence, attemptId, subtaskId: 'subtask',
    occurredAt: '2026-10-15T10:45:56.879Z', phase: 'execution', actor: 'executor',
    kind: 'executor_progress', status: 'running', title: 'Progress', summary: text,
    details: { attemptId, subtaskId: 'subtask' },
  };
}
function timeline(): ExecutionTimeline {
  return {
    taskId: 'task', title: 'PPT', status: 'running', userState: 'executing', userStateReason: '',
    stages: [{ phase: 'execution', status: 'running', subtasks: [{
      id: 'subtask', title: 'PPT', status: 'running', attempts: ['attempt-1', 'attempt-2'].map(attemptId => ({
        attemptId, attemptKind: 'primary', attemptOrdinal: 1, attemptLabel: '执行',
        displayStatus: '执行中', result: '',
        progressHistory: [{ kind: 'status', text, occurredAt: time }],
      })),
    }] }],
  };
}

describe('Executor detail progress sources', () => {
  it('shows one authoritative stream per attempt despite independent timestamp skew', () => {
    const result = collectDetailEvents([trace(1)], timeline(), 'subtask');
    expect(result).toHaveLength(2);
    expect(result.filter(event => event.attemptId === 'attempt-1')).toEqual([trace(1)]);
    expect(result.find(event => event.attemptId === 'attempt-2')?.details.durable).toBe(true);
  });

  it('preserves genuine repeated cycles, even with identical text and timestamps', () => {
    const result = collectDetailEvents([trace(1), trace(2)], timeline(), 'subtask');
    expect(result.filter(event => event.attemptId === 'attempt-1')).toEqual([trace(1), trace(2)]);
  });

  it('uses durable history until progress trace arrives, including after a reconnect', () => {
    const started = { ...trace(0), kind: 'subtask_execution_started' };
    expect(collectDetailEvents([started], timeline(), 'subtask')).toHaveLength(3);
    expect(collectDetailEvents([started, trace(1)], timeline(), 'subtask')).toHaveLength(3);
    expect(collectDetailEvents([], timeline(), 'subtask')).toHaveLength(2);
    expect(collectDetailEvents([trace(1)], timeline(), 'other-subtask')).toEqual([]);
  });

  it('recognizes the trace identity in details when the top-level field is absent', () => {
    const event = { ...trace(1), attemptId: undefined };
    expect(collectDetailEvents([event], timeline(), 'subtask')).toHaveLength(2);
  });
});
