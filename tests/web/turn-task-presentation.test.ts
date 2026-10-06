import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { collectExecutionCards, LiveExecutionPanel } from '../../web/src/components/LiveExecutionPanel';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import { projectTurnForPresentation } from '../../web/src/turn-task-presentation';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('Turn Task presentation', () => {
  it('does not announce an Executor start before an attempt exists', () => {
    const cards = collectExecutionCards([], { taskId: 't', title: 'Invoices', status: 'running', stages: [
      { phase: 'execution', status: 'running', subtasks: [
        { id: 'summarize', title: '分类统计', status: 'ready', attempts: [] },
      ] },
    ] });
    expect(cards[0].stepLabel).toContain('等待前置结果');
    expect(cards[0].stepLabel).not.toContain('已启动');
    expect(cards[0].startedAt).toBeNull();
  });

  it('does not let presentation heartbeats overwrite the time of actual progress', () => {
    const cards = collectExecutionCards([{
      id: 'heartbeat', sequence: 1, occurredAt: '2026-10-06T12:00:00Z', phase: 'execution',
      actor: 'runtime', kind: 'executor_heartbeat', status: 'running', title: 'heartbeat', summary: '',
      taskId: 't', subtaskId: 's', details: { lastProgressAt: '2026-10-06T09:00:00Z',
        activityState: 'presentation_heartbeat', operationHealth: { state: 'unknown', lastActivityAt: '2026-10-06T09:00:00Z' } },
    }], { taskId: 't', title: 'Invoices', status: 'running', stages: [
      { phase: 'execution', status: 'running', subtasks: [{ id: 's', title: '读取', status: 'running', attempts: [] }] },
    ] });
    expect(cards[0].lastProgressAt).toBe('2026-10-06T09:00:00Z');
    expect(cards[0].lastActivityAt).toBe('2026-10-06T09:00:00Z');
    expect(cards[0].healthText).toContain('状态待确认');
  });

  it('keeps the newest durable progress timestamp when trace events are older', () => {
    const cards = collectExecutionCards(
      [{
        id: 'route_old',
        sequence: 1,
        occurredAt: '2026-09-30T09:30:00.000Z',
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_routed',
        status: 'completed',
        title: 'Executor routed',
        summary: '',
        taskId: 'task_b',
        subtaskId: 'subtask_b1',
        details: {},
      }],
      {
        taskId: 'task_b',
        title: 'Task B',
        status: 'running',
        stages: [{
          phase: 'execution',
          status: 'running',
          subtasks: [{
            id: 'subtask_b1',
            title: 'Current B1',
            status: 'running',
            attempts: [{
              attemptId: 'attempt_b1',
              attemptKind: 'primary',
              attemptOrdinal: 1,
              attemptLabel: '主执行',
              displayStatus: '执行中',
              result: 'running',
              startedAt: '2026-09-30T09:00:00.000Z',
              updatedAt: '2026-09-30T10:00:00.000Z',
              progressHistory: [{
                kind: 'log',
                text: '正在执行',
                occurredAt: '2026-09-30T10:00:00.000Z',
              }],
            }],
          }],
        }],
      },
    );

    expect(cards[0]?.updatedAt).toBe('2026-09-30T10:00:00.000Z');
  });

  it('shows every current-Task Subtask but excludes a foreign Task trace card', () => {
    const turn: ConversationTurnProjection = {
      id: 'turn_b',
      sessionId: 'conv_1',
      userInput: '执行 Task B',
      status: 'completed',
      finalAnswer: 'done',
      taskId: 'task_b',
      startedAt: '2026-09-10T09:00:00.000Z',
      completedAt: '2026-09-10T09:05:00.000Z',
      traceEvents: [
        {
          id: 'task_b_progress',
          sequence: 1,
          occurredAt: '2026-09-10T09:01:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'running',
          title: 'Task B progress',
          summary: 'current',
          taskId: 'task_b',
          subtaskId: 'subtask_b1',
          details: {
            taskId: 'task_b',
            subtaskId: 'subtask_b1',
            subtaskTitle: 'Current B1',
          },
        },
        {
          id: 'task_a_progress',
          sequence: 2,
          occurredAt: '2026-09-10T08:59:00.000Z',
          phase: 'execution',
          actor: 'executor',
          kind: 'executor_progress',
          status: 'completed',
          title: 'Task A progress',
          summary: 'old',
          taskId: 'task_a',
          subtaskId: 'subtask_a',
          details: {
            taskId: 'task_a',
            subtaskId: 'subtask_a',
            subtaskTitle: 'Historical A',
          },
        },
      ],
      executionTimeline: {
        taskId: 'task_b',
        title: 'Task B',
        status: 'done',
        stages: [{
          phase: 'execution',
          status: 'done',
          subtasks: [
            {
              id: 'subtask_b1',
              title: 'Current B1',
              status: 'done',
              attempts: [],
            },
            {
              id: 'subtask_b2',
              title: 'Current B2',
              status: 'done',
              attempts: [],
            },
          ],
        }],
      },
      artifactRefs: [],
      artifacts: [],
    } as ConversationTurnProjection;

    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, { turn }));

    expect(html).toContain('Current B1');
    expect(html).toContain('Current B2');
    expect(html).not.toContain('Historical A');
  });

  it('uses the Task title when a Subtask title is an internal canonical ID', () => {
    const internalSubtaskId = 'task_plan_event_proposal_abc123_r1_shanghai-national-day';
    const turn: ConversationTurnProjection = {
      id: 'turn_title',
      sessionId: 'conv_1',
      userInput: '国庆期间我想去上海周边转一转，有什么可推荐的地方吗？',
      status: 'running',
      finalAnswer: null,
      taskId: 'task_plan_event_proposal_abc123',
      startedAt: '2026-09-30T09:00:00.000Z',
      completedAt: null,
      traceEvents: [],
      executionTimeline: {
        taskId: 'task_plan_event_proposal_abc123',
        title: '国庆上海周边旅行建议',
        status: 'running',
        stages: [{
          phase: 'execution',
          status: 'running',
          subtasks: [{
            id: internalSubtaskId,
            title: internalSubtaskId,
            status: 'running',
            attempts: [],
          }],
        }],
      },
      artifactRefs: [],
      artifacts: [],
    };

    const html = renderToStaticMarkup(createElement(LiveExecutionPanel, { turn }));

    expect(html).toContain('国庆上海周边旅行建议');
    expect(html).not.toContain(internalSubtaskId);
  });

  it('drops a mismatched historical Timeline instead of replacing the Turn Task', () => {
    const turn = {
      id: 'turn_b',
      sessionId: 'conv_1',
      userInput: '执行 Task B',
      status: 'completed',
      finalAnswer: 'done',
      taskId: 'task_b',
      startedAt: '2026-09-10T09:00:00.000Z',
      completedAt: '2026-09-10T09:05:00.000Z',
      traceEvents: [],
      executionTimeline: {
        taskId: 'task_a',
        title: 'Task A',
        status: 'done',
        stages: [],
      },
      artifactRefs: [],
      artifacts: [],
    } as ConversationTurnProjection;

    expect(projectTurnForPresentation(turn)).toMatchObject({
      taskId: 'task_b',
      executionTimeline: null,
    });
  });
});
