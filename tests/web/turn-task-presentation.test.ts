import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { LiveExecutionPanel } from '../../web/src/components/LiveExecutionPanel';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import { projectTurnForPresentation } from '../../web/src/turn-task-presentation';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

describe('Turn Task presentation', () => {
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
