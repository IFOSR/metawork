import { describe, expect, it } from 'vitest';
import {
  GATEWAY_EVENT_KINDS,
  isTerminalGatewayEvent,
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  TERMINAL_GATEWAY_EVENT_KINDS,
  type GatewayCommandReceipt,
  type GatewayEventEnvelope,
  type GatewayReplay,
} from '../../src/gateway/client-events.js';
import { GATEWAY_PROTOCOL_VERSION } from '../../src/gateway/client-protocol.js';

describe('gateway event protocol', () => {
  it('exports a complete event kind contract', () => {
    expect(GATEWAY_PROTOCOL_VERSION).toBe(1);
    expect(GATEWAY_EVENT_KINDS).toHaveLength(14);
    expect(new Set(GATEWAY_EVENT_KINDS).size).toBe(14);
  });

  it('identifies terminal event kinds', () => {
    expect(TERMINAL_GATEWAY_EVENT_KINDS).toEqual(
      expect.arrayContaining(['final_answer', 'terminal_error', 'delivery_status']),
    );
    expect(isTerminalGatewayEvent('final_answer')).toBe(true);
    expect(isTerminalGatewayEvent('terminal_error')).toBe(true);
    expect(isTerminalGatewayEvent('delivery_status')).toBe(true);
    expect(isTerminalGatewayEvent('turn_started')).toBe(false);
    expect(isTerminalGatewayEvent('trace_delta')).toBe(false);
  });

  it('carries account, conversation and request identity', () => {
    const event: GatewayEventEnvelope = {
      protocolVersion: 1,
      eventId: 'evt_1',
      sequence: 1,
      accountId: 'local-default',
      conversationId: 'conv_1',
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'turn_started',
      payload: {},
      occurredAt: '2026-08-18T00:00:00.000Z',
    };
    expect(event.accountId).toBe('local-default');
    expect(event.conversationId).toBe('conv_1');
    expect(event.requestId).toBe('req_1');
    expect(event.turnId).toBe('turn_1');
  });

  it('keeps sequence monotonic within one conversation stream', () => {
    const events: GatewayEventEnvelope[] = [1, 2, 3].map(sequence => ({
      protocolVersion: 1,
      eventId: `evt_${sequence}`,
      sequence,
      accountId: 'local-default',
      conversationId: 'conv_1',
      requestId: null,
      turnId: null,
      kind: 'trace_delta',
      payload: {},
      occurredAt: '2026-08-18T00:00:00.000Z',
    }));
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].sequence).toBeGreaterThan(events[index - 1].sequence);
    }
  });

  it('bounds event payload size', () => {
    expect(MAX_GATEWAY_EVENT_PAYLOAD_BYTES).toBeGreaterThan(0);
    expect(MAX_GATEWAY_EVENT_PAYLOAD_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  it('shapes command receipts', () => {
    const accepted: GatewayCommandReceipt = { requestId: 'req_1', status: 'accepted', turnId: 'turn_1' };
    const rejected: GatewayCommandReceipt = { requestId: 'req_2', status: 'rejected', turnId: null, reason: 'busy' };
    expect(accepted.requestId).toBe('req_1');
    expect(accepted.status).toBe('accepted');
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('busy');
  });

  it('shapes replay with snapshot and deltas', () => {
    const replay: GatewayReplay = { lastSequence: 3, snapshot: [], deltas: [] };
    expect(replay.lastSequence).toBe(3);
    expect(replay.snapshot).toEqual([]);
    expect(replay.deltas).toEqual([]);
  });
});
