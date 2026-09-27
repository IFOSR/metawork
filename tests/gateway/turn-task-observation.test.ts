import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import {
  observeTurnTaskTrace, traceObservationTurnIds, type TurnTaskObservation,
} from '../../src/gateway/turn-task-observation.js';
import { resolveTaskViewTurnAssociation } from '../../src/gateway/task-view-association.js';

const scope = { accountId: 'local-default', conversationId: 'conv_one', turnId: 'turn_one' };
function trace(sequence: number, payload: unknown, overrides: Partial<GatewayEventEnvelope> = {}): GatewayEventEnvelope {
  return {
    protocolVersion: 2, eventId: `trace_${sequence}`, sequence, ...scope,
    requestId: null, kind: 'trace_delta', payload, occurredAt: `time_${sequence}`, ...overrides,
  };
}
function fold(events: GatewayEventEnvelope[]) {
  return events.reduce<TurnTaskObservation | null>((previous, event) => (
    observeTurnTaskTrace(scope, previous, event)
  ), null);
}

// Frozen pre-index resolver rules: keep the equivalence oracle independent of
// the new fold used by both indexed reads and explicit audit/recovery callers.
function replayReference(input: Parameters<typeof resolveTaskViewTurnAssociation>[0]) {
  const record = (value: unknown): Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  );
  const traces = (input.replayEvents ?? []).filter(event => (
    event.accountId === input.accountId && event.conversationId === input.conversationId
    && event.kind === 'trace_delta'
    && (event.turnId === input.turnId || record(event.payload).turnId === input.turnId)
  ));
  const ids = new Set(traces.map(event => record(event.payload).taskId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0));
  for (const id of [input.queryTaskId, input.liveTaskId, input.presentationTaskId]) if (id) ids.add(id);
  if (ids.size > 1) return { status: 'mismatch' };
  if (!ids.size) return { status: 'not_found' };
  if (!ids.has(input.taskId)) return { status: 'mismatch' };
  const last = traces.at(-1);
  const payload = record(last?.payload);
  const items = Array.isArray(payload.events) ? payload.events : [];
  return {
    status: 'matched',
    startedAt: traces[0]?.occurredAt ?? null,
    completedAt: typeof payload.completedAt === 'string' ? payload.completedAt
      : ['completed', 'failed', 'blocked', 'cancelled'].includes(String(payload.status)) ? last?.occurredAt ?? null : null,
    progressSummary: items.map(record).reverse().map(item => item.summary)
      .find((summary): summary is string => typeof summary === 'string' && summary.length > 0) ?? null,
  };
}

describe('Turn Task observation fold', () => {
  it('retains only observation fields even when the identity comes from a larger request', () => {
    const event = trace(1, { taskId: 'task_1', events: [{ summary: 'safe progress', details: 'not retained' }] });
    const request = { ...scope, replayEvents: [event], requestId: 'not retained' };
    expect(observeTurnTaskTrace(request, null, event)).toEqual({
      ...scope, taskIds: ['task_1'], firstTraceAt: 'time_1', latestTraceAt: 'time_1',
      completedAt: null, progressSummary: 'safe progress',
    });
  });

  it('keeps only two distinct Task IDs and never forgets ambiguity', () => {
    const observation = fold(Array.from({ length: 100 }, (_, n) => trace(n, { taskId: `task_${n}` })))!;
    expect(observation.taskIds).toEqual(['task_0', 'task_1']);
    expect(observation.firstTraceAt).toBe('time_0');
    expect(observation.latestTraceAt).toBe('time_99');
    const next = observeTurnTaskTrace(scope, Object.freeze(observation), trace(100, { taskId: 'task_0' }))!;
    expect(next.taskIds).toEqual(['task_0', 'task_1']);
    expect(resolveTaskViewTurnAssociation({ ...scope, taskId: 'task_99', traceObservation: next }))
      .toEqual({ status: 'mismatch' });
    expect(JSON.stringify(next).length).toBeLessThan(350);
  });

  it('preserves envelope OR payload Turn identity, without double-folding a shared identity', () => {
    const event = trace(1, { turnId: 'payload_turn', taskId: 'task_1' });
    expect(traceObservationTurnIds(event)).toEqual(['turn_one', 'payload_turn']);
    expect(observeTurnTaskTrace({ ...scope, turnId: 'payload_turn' }, null, event)?.taskIds).toEqual(['task_1']);
    expect(traceObservationTurnIds(trace(2, { turnId: 'turn_one' }))).toEqual(['turn_one']);
    expect(traceObservationTurnIds(trace(3, { turnId: 'payload_turn' }, { turnId: null }))).toEqual(['payload_turn']);
    expect(traceObservationTurnIds(trace(4, {}, { kind: 'turn_started' }))).toEqual([]);
  });

  it('ignores unrelated identities and non-trace payloads', () => {
    expect(fold([
      trace(1, { taskId: 'task_1' }, { accountId: 'other' }),
      trace(2, { taskId: 'task_1' }, { conversationId: 'conv_other' }),
      trace(3, { taskId: 'task_1' }, { turnId: 'turn_other' }),
      trace(4, { taskId: 'task_1' }, { kind: 'execution_delta' }),
    ])).toBeNull();
    const foreign = fold([trace(1, { taskId: 'task_1' })])!;
    for (const identity of [{ accountId: 'other' }, { conversationId: 'other' }, { turnId: 'other' }]) {
      expect(resolveTaskViewTurnAssociation({
        ...scope, ...identity, taskId: 'task_1', traceObservation: foreign,
      })).toEqual({ status: 'not_found' });
    }
  });

  it('uses first/latest trace order, including taskless traces and clearing absent latest progress', () => {
    const first = trace(1, { events: [{ summary: 'intake' }] }, { occurredAt: 'later_wall_clock' });
    const terminal = trace(2, {
      taskId: 'task_1', status: 'completed', completedAt: 'explicit_completion',
      events: [{ summary: 'first' }, { summary: 'last nonempty' }, { summary: '' }, null],
    }, { occurredAt: 'earlier_wall_clock' });
    const observation = fold([first, terminal])!;
    expect(observation).toMatchObject({
      firstTraceAt: 'later_wall_clock', latestTraceAt: 'earlier_wall_clock',
      completedAt: 'explicit_completion', progressSummary: 'last nonempty',
    });
    expect(resolveTaskViewTurnAssociation({ ...scope, taskId: 'task_1', traceObservation: observation }))
      .toEqual({
        status: 'matched', startedAt: 'later_wall_clock',
        completedAt: 'explicit_completion', progressSummary: 'last nonempty',
      });
    const next = observeTurnTaskTrace(scope, observation, trace(3, { status: 'running', taskId: '' }))!;
    expect(next).toMatchObject({ taskIds: ['task_1'], completedAt: null, progressSummary: null });
    expect(observation.completedAt).toBe('explicit_completion');
  });

  it.each(['completed', 'failed', 'blocked', 'cancelled'])('uses latest event time for %s without an explicit completion', status => {
    const observation = fold([trace(1, { taskId: 'task_1', status })]);
    expect(observation?.completedAt).toBe('time_1');
  });

  it('matches replay evidence across every prefix and all external evidence conflicts', () => {
    const events = [
      trace(1, { events: [{ summary: 'intake' }] }),
      trace(2, { taskId: 'task_1', status: 'running', events: [{ summary: 'working' }] }),
      trace(3, { taskId: 'task_1', status: 'completed', completedAt: 'done', events: [{ summary: 'finished' }] }),
      trace(4, { turnId: 'turn_one', status: 'running' }, { turnId: null }),
      trace(5, { taskId: 'task_2' }),
      trace(6, { taskId: 'task_3' }),
    ];
    for (let n = 0; n <= events.length; n += 1) {
      const replayEvents = events.slice(0, n);
      for (const taskId of ['task_1', 'task_2', 'unknown']) {
        for (const external of [{}, { queryTaskId: 'task_1' }, { liveTaskId: 'task_2' }, { presentationTaskId: 'task_1' }]) {
          const expected = replayReference({ ...scope, taskId, ...external, replayEvents });
          expect(resolveTaskViewTurnAssociation({
            ...scope, taskId, ...external, traceObservation: fold(replayEvents),
          })).toEqual(expected);
          expect(resolveTaskViewTurnAssociation({ ...scope, taskId, ...external, replayEvents })).toEqual(expected);
        }
      }
    }
  });
});
