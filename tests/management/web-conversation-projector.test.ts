import { describe, expect, it } from 'vitest';
import type { ExecutionTimeline } from '../../src/management/execution-projector.js';
import type { InteractionTrace } from '../../src/management/interaction-trace.js';
import {
  WebConversationProjector,
  type WebConversationProjectionStore,
} from '../../src/management/web-conversation-projector.js';
import type {
  ConversationTurn,
  ConversationTurnProjection,
} from '../../src/management/web-session-types.js';

function makeTrace(
  status: InteractionTrace['status'],
  events: InteractionTrace['events'],
): InteractionTrace {
  return {
    sessionId: 'session_1',
    turnId: 'turn_1',
    taskId: 'task_1',
    status,
    startedAt: '2026-08-17T08:00:00.000Z',
    completedAt: status === 'running' ? null : '2026-08-17T08:00:05.000Z',
    events,
  };
}

const queryEvent = {
  id: 'event_query',
  sequence: 1,
  occurredAt: '2026-08-17T08:00:00.000Z',
  phase: 'intake' as const,
  actor: 'user' as const,
  kind: 'query_received',
  status: 'completed' as const,
  title: 'User query received',
  summary: 'Show the complete execution flow',
  details: {},
};

const plannerEvent = {
  id: 'event_planner',
  sequence: 2,
  occurredAt: '2026-08-17T08:00:01.000Z',
  phase: 'planning' as const,
  actor: 'planner' as const,
  kind: 'planner_started',
  status: 'running' as const,
  title: 'Planner started',
  summary: 'Planner is preparing a proposal.',
  details: {},
};

const kernelEvent = {
  id: 'event_kernel',
  sequence: 3,
  occurredAt: '2026-08-17T08:00:02.000Z',
  phase: 'authorization' as const,
  actor: 'kernel' as const,
  kind: 'kernel_decision',
  status: 'completed' as const,
  title: 'Kernel authorized',
  summary: 'The proposal passed policy checks.',
  details: {},
};

const timeline: ExecutionTimeline = {
  taskId: 'task_1',
  title: 'Execution flow',
  status: 'running',
  stages: [
    { phase: 'planning', status: 'done' },
    { phase: 'authorization', status: 'done' },
    { phase: 'execution', status: 'running' },
    { phase: 'verification', status: 'pending' },
    { phase: 'delivery', status: 'pending' },
  ],
};

function makeProjector() {
  const persisted: ConversationTurn[] = [];
  const store: WebConversationProjectionStore = {
    async appendTurn(_sessionId, turn) {
      persisted.push(structuredClone(turn));
      return null;
    },
  };
  const projector = new WebConversationProjector({
    sessionId: 'session_1',
    store,
    createTurnId: () => 'turn_pending',
    now: () => '2026-08-17T08:00:06.000Z',
  });
  return { projector, persisted };
}

describe('WebConversationProjector', () => {
  it('streams one ordered turn and persists its sanitized terminal projection', async () => {
    const { projector, persisted } = makeProjector();
    const updates: ConversationTurnProjection[] = [];
    projector.subscribe(turn => {
      if (turn) updates.push(turn);
    });

    projector.beginTurn({
      userInput: 'Show the complete execution flow',
      outputFrom: 10,
    });
    await projector.applyTrace(makeTrace('running', [queryEvent, plannerEvent]));
    await projector.applyTrace(makeTrace('running', [
      queryEvent,
      plannerEvent,
      kernelEvent,
    ]));
    await projector.applyTimeline(timeline);
    projector.applyOutput(['', '> Show the complete execution flow', 'Final answer'], 10);
    await projector.finishSubmission();

    expect(persisted).toEqual([]);
    expect(projector.getSnapshot()).toMatchObject({
      id: 'turn_1',
      sessionId: 'session_1',
      userInput: 'Show the complete execution flow',
      status: 'running',
      finalAnswer: 'Final answer',
      taskId: 'task_1',
      executionTimeline: timeline,
    });
    expect(projector.getSnapshot()?.traceEvents.map(event => event.id)).toEqual([
      'event_query',
      'event_planner',
      'event_kernel',
    ]);

    await projector.applyTrace(makeTrace('completed', [
      queryEvent,
      plannerEvent,
      kernelEvent,
      {
        id: 'event_delivery',
        sequence: 4,
        occurredAt: '2026-08-17T08:00:05.000Z',
        phase: 'delivery',
        actor: 'runtime',
        kind: 'delivery_completed',
        status: 'completed',
        title: 'Response delivered',
        summary: 'Final answer',
        details: {},
      },
    ]));

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: 'turn_1',
      status: 'completed',
      finalAnswer: 'Final answer',
      completedAt: '2026-08-17T08:00:05.000Z',
    });
    expect(updates.length).toBeGreaterThanOrEqual(5);
  });

  it('waits for submission completion when the terminal trace arrives first', async () => {
    const { projector, persisted } = makeProjector();
    projector.beginTurn({ userInput: 'Direct answer', outputFrom: 0 });
    await projector.applyTrace(makeTrace('completed', [queryEvent]));

    expect(persisted).toEqual([]);

    projector.applyOutput(['Direct final answer'], 0);
    await projector.finishSubmission();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.finalAnswer).toBe('Direct final answer');
  });

  it('uses terminal execution state for authorized background tasks', async () => {
    const { projector, persisted } = makeProjector();
    projector.beginTurn({ userInput: 'Run the task', outputFrom: 0 });
    await projector.applyTrace(makeTrace('running', [queryEvent, kernelEvent]));
    await projector.finishSubmission();

    await projector.applyTimeline({
      ...timeline,
      status: 'done',
      stages: timeline.stages.map(stage => ({ ...stage, status: 'done' })),
    });

    expect(projector.getSnapshot()?.status).toBe('completed');
    expect(persisted).toHaveLength(1);
  });

  it('preserves a safe visible diagnostic when submission fails', async () => {
    const { projector, persisted } = makeProjector();
    projector.beginTurn({ userInput: 'Fail safely', outputFrom: 0 });

    await projector.failSubmission(new Error('provider token=secret-value timed out'));

    expect(projector.getSnapshot()).toMatchObject({
      status: 'failed',
      finalAnswer: expect.stringContaining('[REDACTED]'),
    });
    expect(persisted).toHaveLength(1);
  });
});
