import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import {
  resolveTaskViewTurnAssociation,
} from '../../src/gateway/task-view-association.js';

function traceEvent(
  turnId: string,
  taskId: string,
  conversationId = 'conv_1',
): GatewayEventEnvelope {
  return {
    protocolVersion: 2,
    eventId: `trace_${turnId}`,
    sequence: 1,
    accountId: 'local-default',
    conversationId,
    requestId: 'req_1',
    turnId,
    kind: 'trace_delta',
    payload: {
      turnId,
      taskId,
      status: 'completed',
      events: [{ id: 'progress_1', sequence: 1, summary: '已完成' }],
    },
    occurredAt: '2026-09-24T00:00:00.000Z',
  };
}

describe('task view turn association', () => {
  it('does not invent a completion timestamp for a running trace', () => {
    const trace = traceEvent('turn_1', 'task_1');
    expect(resolveTaskViewTurnAssociation({
      accountId: 'local-default', conversationId: 'conv_1', turnId: 'turn_1', taskId: 'task_1',
      replayEvents: [{ ...trace, payload: { ...trace.payload as object, status: 'running', completedAt: null } }],
    })).toMatchObject({ status: 'matched', completedAt: null });
  });

  it('recovers a historical association from a trace delta without presentation data', () => {
    expect(resolveTaskViewTurnAssociation({
      accountId: 'local-default',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      taskId: 'task_1',
      replayEvents: [traceEvent('turn_1', 'task_1')],
    })).toEqual({
      status: 'matched',
      startedAt: '2026-09-24T00:00:00.000Z',
      completedAt: '2026-09-24T00:00:00.000Z',
      progressSummary: '已完成',
    });
  });

  it('does not accept a task from a different turn or conversation', () => {
    expect(resolveTaskViewTurnAssociation({
      accountId: 'local-default',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      taskId: 'task_2',
      replayEvents: [traceEvent('turn_1', 'task_1')],
    }).status).toBe('mismatch');

    expect(resolveTaskViewTurnAssociation({
      accountId: 'local-default',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      taskId: 'task_1',
      replayEvents: [traceEvent('turn_1', 'task_1', 'conv_other')],
    }).status).toBe('not_found');
  });

  it('fails closed when the journal has no exact association', () => {
    expect(resolveTaskViewTurnAssociation({
      accountId: 'local-default',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      taskId: 'task_1',
      replayEvents: [traceEvent('turn_2', 'task_1')],
    }).status).toBe('not_found');
  });
});
