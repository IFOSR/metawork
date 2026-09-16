import { describe, expect, it } from 'vitest';
import { GATEWAY_EVENT_KINDS } from '../../src/gateway/client-events.js';
import {
  isKnownGatewayEventKind,
  isSupportedGatewayProtocolVersion,
} from '../../web/src/api/gateway-types.js';
import type { ServerMessage } from '../../web/src/api/types.js';

describe('web gateway contract parity', () => {
  it('recognizes every server event kind', () => {
    for (const kind of GATEWAY_EVENT_KINDS) {
      expect(isKnownGatewayEventKind(kind), `unknown web event kind: ${kind}`).toBe(true);
    }
  });

  it('rejects unknown event kinds', () => {
    expect(isKnownGatewayEventKind('not_a_kind')).toBe(false);
    expect(isKnownGatewayEventKind('')).toBe(false);
  });

  it('rejects unknown protocol versions', () => {
    expect(isSupportedGatewayProtocolVersion(2)).toBe(true);
    expect(isSupportedGatewayProtocolVersion(1)).toBe(false);
    expect(isSupportedGatewayProtocolVersion(999)).toBe(false);
    expect(isSupportedGatewayProtocolVersion('1')).toBe(false);
    expect(isSupportedGatewayProtocolVersion(undefined)).toBe(false);
  });

  it('keeps the agent readiness event in the WebSocket contract', () => {
    const message: ServerMessage = {
      type: 'agent_readiness_state',
      agents: [{
        agentId: 'pi-agent',
        required: true,
        displayName: '智能体 1',
        status: 'installed',
        version: 'pi 1.0.0',
        detail: null,
        installUrl: 'https://example.com/pi',
        checkedAt: '2026-09-16T00:00:00.000Z',
      }],
    };
    expect(message.type).toBe('agent_readiness_state');
  });
});
