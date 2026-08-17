import { describe, expect, it } from 'vitest';
import type { ExecutionTimeline } from '../../src/management/execution-projector.js';
import type { InteractionTraceEvent } from '../../src/management/interaction-trace.js';
import {
  MAX_WEB_SESSION_EVENTS_PER_TURN,
  MAX_WEB_SESSION_TURNS,
  WEB_SESSION_FORMAT_VERSION,
  boundConversationTraceEvents,
  boundWebSessionTurns,
  type ConversationTurn,
  type WebSessionActivationResult,
  type WebSessionMetadata,
  type WebSessionRecord,
} from '../../src/management/web-session-types.js';

const traceEvent: InteractionTraceEvent = {
  id: 'event_1',
  sequence: 1,
  occurredAt: '2026-08-17T08:00:01.000Z',
  phase: 'planning',
  actor: 'planner',
  kind: 'planner_process_started',
  status: 'completed',
  title: 'Planner started',
  summary: 'Started the isolated Planner process.',
  details: { command: 'planner' },
};

const timeline: ExecutionTimeline = {
  taskId: 'task_1',
  title: 'Summarize AI news',
  status: 'done',
  stages: [
    { phase: 'planning', status: 'done' },
    { phase: 'authorization', status: 'done' },
    { phase: 'execution', status: 'done' },
    { phase: 'verification', status: 'done' },
    { phase: 'delivery', status: 'done' },
  ],
};

function makeTurn(index: number): ConversationTurn {
  return {
    id: `turn_${index}`,
    sessionId: 'session_1',
    userInput: `request ${index}`,
    status: 'completed',
    finalAnswer: `answer ${index}`,
    taskId: 'task_1',
    startedAt: '2026-08-17T08:00:00.000Z',
    completedAt: '2026-08-17T08:00:05.000Z',
    traceEvents: [{ ...traceEvent, id: `event_${index}`, sequence: index }],
    executionTimeline: timeline,
    artifactRefs: ['report.md'],
  };
}

describe('Web session workspace contracts', () => {
  it('keeps stable session metadata separate from runtime authority', () => {
    const metadata: WebSessionMetadata = {
      id: 'session_1',
      title: 'AI news',
      createdAt: '2026-08-17T08:00:00.000Z',
      updatedAt: '2026-08-17T08:00:05.000Z',
      active: true,
      archived: false,
    };

    expect(metadata).toEqual(expect.objectContaining({
      id: 'session_1',
      title: 'AI news',
      active: true,
    }));
  });

  it('represents one terminal conversation turn with safe projections', () => {
    const turn = makeTurn(1);

    expect(turn).toMatchObject({
      userInput: 'request 1',
      status: 'completed',
      finalAnswer: 'answer 1',
      taskId: 'task_1',
      executionTimeline: timeline,
    });
    expect(turn.traceEvents).toEqual([traceEvent]);
  });

  it.each<WebSessionActivationResult>([
    { state: 'active', sessionId: 'session_1' },
    { state: 'browsable', sessionId: 'session_2' },
    {
      state: 'activation_blocked',
      sessionId: 'session_3',
      reason: 'planner_turn_active',
    },
  ])('uses an explicit activation state: $state', result => {
    expect(['active', 'browsable', 'activation_blocked']).toContain(result.state);
  });

  it('versions persisted session records', () => {
    const record: WebSessionRecord = {
      version: WEB_SESSION_FORMAT_VERSION,
      session: {
        id: 'session_1',
        title: 'AI news',
        createdAt: '2026-08-17T08:00:00.000Z',
        updatedAt: '2026-08-17T08:00:05.000Z',
        active: true,
        archived: false,
      },
      turns: [makeTurn(1)],
    };

    expect(record.version).toBe(1);
    expect(record.turns).toHaveLength(1);
  });

  it('retains only the newest bounded turns and trace events', () => {
    const turns = Array.from(
      { length: MAX_WEB_SESSION_TURNS + 2 },
      (_, index) => makeTurn(index + 1),
    );
    const events = Array.from(
      { length: MAX_WEB_SESSION_EVENTS_PER_TURN + 2 },
      (_, index) => ({ ...traceEvent, id: `event_${index + 1}`, sequence: index + 1 }),
    );

    expect(boundWebSessionTurns(turns)).toHaveLength(MAX_WEB_SESSION_TURNS);
    expect(boundWebSessionTurns(turns)[0]?.id).toBe('turn_3');
    expect(boundConversationTraceEvents(events)).toHaveLength(
      MAX_WEB_SESSION_EVENTS_PER_TURN,
    );
    expect(boundConversationTraceEvents(events)[0]?.id).toBe('event_3');
  });
});
