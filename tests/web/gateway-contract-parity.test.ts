import { describe, expect, it } from 'vitest';
import { GATEWAY_EVENT_KINDS } from '../../src/gateway/client-events.js';
import {
  isKnownGatewayEventKind,
  isSupportedGatewayProtocolVersion,
} from '../../web/src/api/gateway-types.js';

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
});
