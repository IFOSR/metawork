import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { LivePlanningPanel, plannerActivity } from '../../web/src/components/LivePlanningPanel';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import type { InteractionTraceEvent } from '../../web/src/api/types';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

function event(input: Partial<InteractionTraceEvent> & {
  sequence: number;
  kind: string;
  phase: InteractionTraceEvent['phase'];
  occurredAt: string;
}): InteractionTraceEvent {
  return {
    id: `event_${input.sequence}`,
    actor: input.phase === 'planning' ? 'planner' : 'executor',
    status: 'running',
    title: input.kind,
    summary: '',
    details: {},
    ...input,
  } as InteractionTraceEvent;
}

function turn(events: InteractionTraceEvent[], status: ConversationTurnProjection['status'] = 'running'): ConversationTurnProjection {
  return {
    id: 'turn_planning',
    sessionId: 'conv_1',
    userInput: '机差有什么影响啊?',
    status,
    finalAnswer: null,
    taskId: null,
    startedAt: '2026-09-18T13:00:00.000Z',
    completedAt: null,
    traceEvents: events,
    executionTimeline: null,
    artifactRefs: [],
    artifacts: [],
  } as unknown as ConversationTurnProjection;
}

describe('planner activity projection', () => {
  it('reports the planning phase while the Planner is still working', () => {
    const activity = plannerActivity(turn([
      event({ sequence: 1, kind: 'query_received', phase: 'intake', occurredAt: '2026-09-18T13:00:00.000Z' }),
      event({ sequence: 2, kind: 'planner_started', phase: 'planning', occurredAt: '2026-09-18T13:00:00.100Z' }),
      event({ sequence: 3, kind: 'planner_process_started', phase: 'planning', occurredAt: '2026-09-18T13:00:00.300Z' }),
      event({ sequence: 4, kind: 'planner_model_stream_started', phase: 'planning', occurredAt: '2026-09-18T13:00:02.000Z' }),
    ]));

    expect(activity).toMatchObject({
      state: 'running',
      stepKey: 'planner_model_stream_started',
      toolCalls: 0,
    });
    expect(activity?.stepLabel).toContain('模型');
  });

  it('counts Planner tool calls and names the latest one', () => {
    const activity = plannerActivity(turn([
      event({ sequence: 1, kind: 'planner_started', phase: 'planning', occurredAt: '2026-09-18T13:00:00.000Z' }),
      event({
        sequence: 2,
        kind: 'planner_tool_started',
        phase: 'planning',
        occurredAt: '2026-09-18T13:00:01.000Z',
        details: { toolName: 'get_planning_context' },
      }),
      event({
        sequence: 3,
        kind: 'planner_tool_completed',
        phase: 'planning',
        occurredAt: '2026-09-18T13:00:01.400Z',
        details: { toolName: 'get_planning_context' },
      }),
    ]));

    expect(activity).toMatchObject({ toolCalls: 1, lastToolName: 'get_planning_context' });
  });

  it('stops claiming the planning phase once execution has taken over', () => {
    const activity = plannerActivity(turn([
      event({ sequence: 1, kind: 'planner_started', phase: 'planning', occurredAt: '2026-09-18T13:00:00.000Z' }),
      event({ sequence: 2, kind: 'planner_agent_completed', phase: 'planning', occurredAt: '2026-09-18T13:00:03.000Z' }),
      event({ sequence: 3, kind: 'executor_dispatch_started', phase: 'execution', occurredAt: '2026-09-18T13:00:04.000Z' }),
    ]));

    expect(activity).toBeNull();
  });

  it('keeps a ready state between the plan and the first executor event', () => {
    const activity = plannerActivity(turn([
      event({ sequence: 1, kind: 'planner_started', phase: 'planning', occurredAt: '2026-09-18T13:00:00.000Z' }),
      event({ sequence: 2, kind: 'planner_agent_completed', phase: 'planning', occurredAt: '2026-09-18T13:00:03.000Z' }),
    ]));

    expect(activity).toMatchObject({ state: 'ready' });
  });
});

describe('LivePlanningPanel', () => {
  it('renders a live card with the current planning step and elapsed time', () => {
    const html = renderToStaticMarkup(createElement(LivePlanningPanel, {
      turn: turn([
        event({ sequence: 1, kind: 'planner_started', phase: 'planning', occurredAt: new Date(Date.now() - 5_000).toISOString() }),
        event({
          sequence: 2,
          kind: 'planner_tool_started',
          phase: 'planning',
          occurredAt: new Date(Date.now() - 1_000).toISOString(),
          details: { toolName: 'get_planning_context' },
        }),
      ]),
    }));

    expect(html).toContain('PLANNING');
    expect(html).toContain('规划中');
    expect(html).toContain('get_planning_context');
    expect(html).toMatch(/\d+s/);
  });

  it('renders nothing once the turn is completed and execution started', () => {
    const html = renderToStaticMarkup(createElement(LivePlanningPanel, {
      turn: turn([
        event({ sequence: 1, kind: 'planner_started', phase: 'planning', occurredAt: '2026-09-18T13:00:00.000Z' }),
        event({ sequence: 2, kind: 'executor_dispatch_started', phase: 'execution', occurredAt: '2026-09-18T13:00:04.000Z' }),
      ], 'completed'),
    }));

    expect(html).toBe('');
  });
});
