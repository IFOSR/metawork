import { describe, expect, it } from 'vitest';
import { boundGatewayEventPayload, gatewayEventPayloadBytes, MAX_GATEWAY_EVENT_PAYLOAD_BYTES } from '../../src/gateway/client-events.js';

describe('Gateway trace payload budget', () => {
  it('bounds oversized trace deltas without splitting JSON', () => {
    const payload = { turnId: 'turn_1', events: [{ id: 'event_1', sequence: 1, kind: 'progress', summary: '中'.repeat(100_000), details: {} }] };
    const bounded = boundGatewayEventPayload(payload);
    expect(gatewayEventPayloadBytes(bounded)).toBeLessThanOrEqual(MAX_GATEWAY_EVENT_PAYLOAD_BYTES);
    expect(bounded).toMatchObject({ truncated: true });
  });

  it('keeps the framing bound when trace details contain large nested values', () => {
    const payload = {
      turnId: 'turn_1',
      events: [{
        id: 'event_1', sequence: 1, kind: 'progress',
        summary: 'safe',
        details: { nested: { data: 'x'.repeat(200_000) } },
      }],
    };
    const bounded = boundGatewayEventPayload(payload);
    expect(gatewayEventPayloadBytes(bounded)).toBeLessThanOrEqual(MAX_GATEWAY_EVENT_PAYLOAD_BYTES);
    expect(bounded).toMatchObject({ truncated: true });
  });
});
