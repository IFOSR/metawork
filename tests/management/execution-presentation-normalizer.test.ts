import { describe, expect, it } from 'vitest';
import {
  normalizeExecutionPresentation,
} from '../../src/management/execution-presentation-normalizer.js';
import type { ConversationTurn } from '../../src/management/web-session-types.js';

describe('normalizeExecutionPresentation', () => {
  it('maps proposal trace events to the canonical runtime Subtask without title guessing', () => {
    const normalized = normalizeExecutionPresentation(turn(), new Map([
      ['research', 'task_1_r1_research'],
      ['research-copy', 'task_1_r1_research-copy'],
    ]));

    expect(normalized.traceEvents.map(event => event.subtaskId)).toEqual([
      'task_1_r1_research',
      'task_1_r1_research',
    ]);
    expect(normalized.traceEvents.map(event => event.details.subtaskId)).toEqual([
      'task_1_r1_research',
      'task_1_r1_research',
    ]);
    expect(normalized.executionTimeline?.stages[0]?.subtasks?.map(subtask => subtask.id))
      .toEqual(['task_1_r1_research']);
  });

  it('does not merge two Subtasks that happen to share a title', () => {
    const input = turn();
    input.traceEvents.push({
      ...input.traceEvents[0]!,
      id: 'routing-copy',
      subtaskId: 'research-copy',
      details: { ...input.traceEvents[0]!.details, subtaskId: 'research-copy' },
    });

    const normalized = normalizeExecutionPresentation(input, new Map([
      ['research', 'task_1_r1_research'],
      ['research-copy', 'task_1_r1_research-copy'],
    ]));

    expect(new Set(normalized.traceEvents.map(event => event.subtaskId))).toEqual(new Set([
      'task_1_r1_research',
      'task_1_r1_research-copy',
    ]));
  });
});

function turn(): ConversationTurn {
  return {
    id: 'turn_1',
    sessionId: 'session_1',
    userInput: '分析智谱下跌',
    status: 'completed',
    finalAnswer: '完成',
    taskId: 'task_1',
    startedAt: '2026-08-25T08:00:00.000Z',
    completedAt: '2026-08-25T08:01:00.000Z',
    traceEvents: [
      {
        id: 'routing',
        sequence: 1,
        occurredAt: '2026-08-25T08:00:01.000Z',
        phase: 'routing',
        actor: 'kernel',
        kind: 'executor_routed',
        status: 'completed',
        title: '路由',
        summary: '已路由',
        subtaskId: 'research',
        details: { subtaskId: 'research', subtaskTitle: '研究原因' },
      },
      {
        id: 'execution',
        sequence: 2,
        occurredAt: '2026-08-25T08:00:02.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'running',
        title: '执行',
        summary: '处理中',
        subtaskId: 'task_1_r1_research',
        details: { subtaskId: 'task_1_r1_research', subtaskTitle: '研究原因' },
      },
    ],
    executionTimeline: {
      taskId: 'task_1',
      title: '分析智谱下跌',
      status: 'done',
      stages: [{
        phase: 'execution',
        status: 'done',
        subtasks: [{
          id: 'task_1_r1_research',
          title: '研究原因',
          status: 'done',
          attempts: [],
        }],
      }],
    },
    artifactRefs: [],
    artifacts: [],
  };
}
