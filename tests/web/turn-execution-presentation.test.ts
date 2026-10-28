import { describe, expect, it } from 'vitest';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import { formatExecutionDuration } from '../../web/src/execution-duration';
import { turnExecutionPresentation } from '../../web/src/turn-execution-presentation';

function turn(overrides: Partial<ConversationTurnProjection> = {}): ConversationTurnProjection {
  return {
    id: 'turn_1',
    sessionId: 'session_1',
    userInput: '启动刚才的网站',
    status: 'completed',
    startedAt: '2026-10-28T06:34:22.485Z',
    completedAt: '2026-10-28T06:34:34.272Z',
    taskId: null,
    traceEvents: [],
    executionTimeline: null,
    artifacts: [],
    deliveryStatus: null,
    finalAnswer: null,
    ...overrides,
  } as unknown as ConversationTurnProjection;
}

function timeline(
  status: string,
  subtasks: Array<{
    id: string;
    status: string;
    attempts?: Array<Record<string, unknown>>;
  }>,
): ConversationTurnProjection['executionTimeline'] {
  return {
    taskId: 'task_site',
    title: 'AI radar',
    status,
    statusLabel: status,
    stateVersion: 1,
    reasonCode: 'none',
    explanation: '',
    stages: [{ phase: 'execution', status: 'running', subtasks }],
  } as unknown as ConversationTurnProjection['executionTimeline'];
}

describe('Turn execution presentation', () => {
  it('labels a Planner-only Turn as planning, never as a completed Task', () => {
    const presentation = turnExecutionPresentation(turn());
    expect(presentation).toMatchObject({
      phase: 'planning',
      taskId: null,
      executionStarted: false,
      executionDurationMs: null,
    });
    expect(presentation.label).toBe('已完成规划，未启动执行');
    // The Turn's own elapsed time is measured, but it is planning time.
    expect(presentation.turnDurationMs).toBe(11_787);
    expect(presentation.planningDurationMs).toBe(11_787);
  });

  it('keeps a completed Turn that owns a Task out of the planner-only label', () => {
    const presentation = turnExecutionPresentation(turn({ taskId: 'task_site' }));
    expect(presentation.phase).toBe('completed');
    expect(presentation.label).toBe('已完成');
  });

  it('reports a queued Task without inventing execution or a duration', () => {
    const presentation = turnExecutionPresentation(turn({
      status: 'running',
      completedAt: null,
      taskId: 'task_site',
      executionTimeline: timeline('queued', [{ id: 'sub_1', status: 'ready', attempts: [] }]),
    }));
    expect(presentation.phase).toBe('queued');
    expect(presentation.label).toBe('已排队，尚未执行');
    expect(presentation.executionStarted).toBe(false);
    expect(presentation.executionDurationMs).toBeNull();
  });

  it('uses the measured execution window once an Attempt actually ran', () => {
    const presentation = turnExecutionPresentation(turn({
      status: 'running',
      completedAt: null,
      taskId: 'task_site',
      executionTimeline: timeline('running', [{
        id: 'sub_1',
        status: 'running',
        attempts: [{
          attemptId: 'a1',
          attemptKind: 'primary',
          attemptOrdinal: 1,
          attemptLabel: '主执行',
          displayStatus: '执行中',
          result: 'running',
          startedAt: '2026-10-28T06:34:22.000Z',
          executionStartedAt: '2026-10-28T06:34:30.000Z',
        }],
      }]),
    }), Date.parse('2026-10-28T06:34:40.000Z'));
    expect(presentation.phase).toBe('executing');
    expect(presentation.executionStarted).toBe(true);
    expect(presentation.executionDurationMs).toBe(10_000);
    expect(presentation.planningDurationMs).toBeNull();
  });

  it('does not report zero seconds when nothing was measured', () => {
    expect(formatExecutionDuration({
      executionStartedAt: null,
      updatedAt: '2026-10-28T06:34:34.272Z',
      running: false,
      nowMs: Date.parse('2026-10-28T06:40:00.000Z'),
    })).toBe('');
  });

  it('reports a real sub-second execution as less than one second', () => {
    expect(formatExecutionDuration({
      executionStartedAt: '2026-10-28T06:34:34.000Z',
      executionCompletedAt: '2026-10-28T06:34:34.225Z',
      running: false,
      nowMs: Date.parse('2026-10-28T06:40:00.000Z'),
    })).toBe('<1s');
  });
});
