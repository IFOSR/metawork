import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayEventKind } from '../../src/gateway/client-events.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';

function makeEvent(
  id: string,
  kind: GatewayEventKind,
  accountId = 'local-default',
  conversationId = 'conv_1',
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: id,
    sequence: 1,
    accountId,
    conversationId,
    requestId: null,
    turnId: null,
    kind,
    payload: {},
    occurredAt: '2026-08-18T00:00:00.000Z',
  };
}

describe('GatewaySubscriptions', () => {
  it('filters by account', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      listener: event => received.push(event.eventId),
    });

    subscriptions.publish(makeEvent('e1', 'turn_started', 'local-default', 'conv_1'));
    subscriptions.publish(makeEvent('e2', 'turn_started', 'acct-other', 'conv_1'));

    expect(received).toEqual(['e1']);
  });

  it('filters by conversation when one is specified', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      listener: event => received.push(event.eventId),
    });

    subscriptions.publish(makeEvent('e1', 'turn_started', 'local-default', 'conv_1'));
    subscriptions.publish(makeEvent('e2', 'turn_started', 'local-default', 'conv_2'));

    expect(received).toEqual(['e1']);
  });

  it('unsubscribes', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    const unsubscribe = subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      listener: event => received.push(event.eventId),
    });

    unsubscribe();
    subscriptions.publish(makeEvent('e1', 'turn_started'));

    expect(received).toEqual([]);
  });

  it('isolates a faulty listener from the durable publisher and other subscribers', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      listener: () => {
        throw new Error('client disconnected');
      },
    });
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      listener: event => received.push(event.eventId),
    });

    expect(() => subscriptions.publish(makeEvent('e1', 'final_answer'))).not.toThrow();
    expect(received).toEqual(['e1']);
  });
});
