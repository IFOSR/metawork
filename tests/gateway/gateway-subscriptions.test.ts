import { describe, expect, it } from 'vitest';
import type { GatewayEventEnvelope, GatewayEventKind } from '../../src/gateway/client-events.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import type { GatewayTurnOrigin } from '../../src/gateway/gateway-delivery-context.js';

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

const webOrigin: GatewayTurnOrigin = { connectionId: 'web_a', surface: 'web' };
const tuiOrigin: GatewayTurnOrigin = { connectionId: 'tui_b', surface: 'tui' };

describe('GatewaySubscriptions', () => {
  it('delivers a targeted detailed event only to the matching origin connection', () => {
    const subscriptions = new GatewaySubscriptions();
    const webEvents: string[] = [];
    const tuiEvents: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: webOrigin.connectionId,
      listener: event => webEvents.push(event.eventId),
    });
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: tuiOrigin.connectionId,
      listener: event => tuiEvents.push(event.eventId),
    });

    subscriptions.publish(makeEvent('web-turn', 'turn_started'), webOrigin);
    subscriptions.publish(makeEvent('tui-turn', 'trace_delta'), tuiOrigin);

    expect(webEvents).toEqual(['web-turn']);
    expect(tuiEvents).toEqual(['tui-turn']);
  });

  it('does not broadcast an untargeted detailed event to attached clients', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: webOrigin.connectionId,
      listener: event => received.push(event.eventId),
    });

    subscriptions.publish(makeEvent('history-only', 'final_answer'));

    expect(received).toEqual([]);
  });

  it('keeps untargeted Workspace summary events available to their stream subscribers', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'workspace_ws_1',
      listener: event => received.push(event.eventId),
    });

    subscriptions.publish(makeEvent(
      'workspace-activity',
      'workspace_activity_changed',
      'local-default',
      'workspace_ws_1',
    ));

    expect(received).toEqual(['workspace-activity']);
  });

  it('filters targeted events by account and conversation as well as origin', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: webOrigin.connectionId,
      listener: event => received.push(event.eventId),
    });

    subscriptions.publish(makeEvent('wrong-account', 'turn_started', 'other'), webOrigin);
    subscriptions.publish(makeEvent('wrong-conversation', 'turn_started', 'local-default', 'conv_2'), webOrigin);
    subscriptions.publish(makeEvent('wrong-origin', 'turn_started'), tuiOrigin);

    expect(received).toEqual([]);
  });

  it('unsubscribes', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    const unsubscribe = subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      liveConnectionId: webOrigin.connectionId,
      listener: event => received.push(event.eventId),
    });

    unsubscribe();
    subscriptions.publish(makeEvent('e1', 'turn_started'), webOrigin);

    expect(received).toEqual([]);
  });

  it('isolates a faulty listener from the durable publisher and other subscribers', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      liveConnectionId: webOrigin.connectionId,
      listener: () => {
        throw new Error('client disconnected');
      },
    });
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: null,
      liveConnectionId: webOrigin.connectionId,
      listener: event => received.push(event.eventId),
    });

    expect(() => subscriptions.publish(makeEvent('e1', 'final_answer'), webOrigin)).not.toThrow();
    expect(received).toEqual(['e1']);
  });
});
