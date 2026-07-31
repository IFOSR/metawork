import { describe, expect, it } from 'vitest';
import { isPlannerHostRequest } from '../../src/tui-bridge/planner-host-protocol.js';

describe('AnyFusionPlannerHostProtocol v1', () => {
  it('accepts a correlated v1 proposal and rejects drift', () => {
    expect(isPlannerHostRequest({
      protocolVersion: 1,
      type: 'proposal_submit',
      requestId: 'request-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      userInput: 'create task',
      plan: {},
    })).toBe(true);
    expect(isPlannerHostRequest({ protocolVersion: 2, type: 'ping', requestId: 'request-2' })).toBe(false);
    expect(isPlannerHostRequest({ protocolVersion: 1, type: 'planner_stop', requestId: 'legacy' })).toBe(false);
  });
});
