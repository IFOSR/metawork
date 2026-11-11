import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  PlanningDetailPanel,
  planningDetailFacts,
} from '../../web/src/components/PlanningDetailPanel';
import type { InteractionTraceEvent } from '../../web/src/api/types';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

function event(input: Partial<InteractionTraceEvent> & { sequence: number; kind: string; occurredAt: string }): InteractionTraceEvent {
  return {
    id: `event_${input.sequence}`,
    phase: 'planning',
    actor: 'planner',
    title: input.kind,
    summary: '',
    details: {},
    ...input,
  } as InteractionTraceEvent;
}

const trace: InteractionTraceEvent[] = [
  event({ sequence: 1, kind: 'planner_started', occurredAt: '2026-11-11T12:00:00.000Z' }),
  event({ sequence: 2, kind: 'planner_tool_started', occurredAt: '2026-11-11T12:00:02.000Z',
    details: { toolName: 'read_metawork_context', argumentFields: ['method'] } }),
  event({ sequence: 3, kind: 'planner_tool_completed', occurredAt: '2026-11-11T12:00:03.500Z',
    details: { toolName: 'read_metawork_context', status: 'completed', resultFields: ['sessionId'] } }),
  event({ sequence: 4, kind: 'planning_proposal_completed', occurredAt: '2026-11-11T12:00:20.000Z',
    details: { planId: 'plan_1', outcome: 'task_authorized' } }),
];

describe('planning detail projection', () => {
  it('derives steps, tool calls and elapsed time without exposing values', () => {
    const facts = planningDetailFacts(trace);
    expect(facts.events).toHaveLength(4);
    expect(facts.toolCalls).toEqual([{
      sequence: 1,
      name: 'read_metawork_context',
      status: 'completed',
      argumentFields: ['method'],
      resultFields: ['sessionId'],
    }]);
    expect(facts.outcome).toBe('提案已提交');
    expect(facts.elapsedMs).toBe(20_000);
  });

  it('renders a compact inline timeline and ignores execution events', () => {
    const html = renderToStaticMarkup(createElement(PlanningDetailPanel, {
      events: [...trace,
        event({ sequence: 9, kind: 'executor_progress', phase: 'execution', occurredAt: '2026-11-11T12:00:30.000Z' })],
    }));
    expect(html).toContain('规划过程');
    expect(html).toContain('提案已提交');
    expect(html).toContain('read_metawork_context');
    expect(html).toContain('参数 method');
    expect(html).toContain('20s');
    expect(html).not.toContain('executor_progress');
  });
});
