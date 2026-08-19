import { describe, expect, it } from 'vitest';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import { ClientGateway as ClientGatewayImpl } from '../../src/gateway/client-gateway.js';
import type { GatewayEventEnvelope, GatewayEventKind } from '../../src/gateway/client-events.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { WebGatewayAdapter } from '../../src/management/web-gateway-adapter.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

const envelope: GatewayCommandEnvelope = {
  protocolVersion: 1,
  requestId: 'req_1',
  idempotencyKey: 'idem_1',
  connectionId: 'conn_1',
  conversation: { mode: 'new' },
  command: { kind: 'user_message', text: 'hello', attachments: [] },
  clientCapabilities: [],
};

function makeEvent(
  id: string,
  kind: GatewayEventKind,
  accountId = 'local-default',
  conversationId = 'conv_1',
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId: id,
    sequence: 0,
    accountId,
    conversationId,
    requestId: null,
    turnId: null,
    kind,
    payload: {},
    occurredAt: '2026-08-18T00:00:00.000Z',
  };
}

async function makeAdapter(): Promise<WebGatewayAdapter> {
  const root = await mkdtemp(join(tmpdir(), 'web-gateway-'));
  roots.push(root);

  const journal = new FileEventJournal(root);
  const subscriptions = new GatewaySubscriptions();
  const gateway: ClientGateway = new ClientGatewayImpl({
    authenticator: {
      authenticate: async input => (
        input.transport === 'web' ? { kind: 'web', id: 'web_user_1' } : null
      ),
    },
    accountResolver: {
      resolve: async principal => (
        principal.kind === 'web'
          ? { status: 'authorized', accountId: 'local-default' }
          : { status: 'denied', reason: 'not web' }
      ),
    },
    conversationResolver: {
      resolve: async (_accountId, selection) => (
        selection.mode === 'new'
          ? { status: 'created', conversationId: 'conv_1' }
          : { status: 'resolved', conversationId: 'conv_1' }
      ),
    },
    activateAccount: async () => undefined,
    submitToConversation: async (_conversationId, requestId, idempotencyKey) => ({
      requestId,
      idempotencyKey,
      status: 'accepted',
    }),
  });

  return new WebGatewayAdapter({ gateway, journal, subscriptions });
}

describe('WebGatewayAdapter', () => {
  it('routes a web command through the unified gateway', async () => {
    const adapter = await makeAdapter();
    const result = await adapter.submit(envelope);
    expect(result).toMatchObject({ status: 'accepted', conversationId: 'conv_1' });
  });

  it('replays journal events for a conversation', async () => {
    const adapter = await makeAdapter();
    await adapter.replay('local-default', 'conv_1');

    // 通过 journal 直接追加事件（模拟服务端投影）。
    const root = roots[0];
    const journal = new FileEventJournal(root);
    await journal.append(makeEvent('e1', 'turn_started'));
    await journal.append(makeEvent('e2', 'final_answer'));

    const replay = await adapter.replay('local-default', 'conv_1');
    expect(replay.deltas.map(event => event.eventId)).toEqual(['e1']);
    expect(replay.snapshot.map(event => event.eventId)).toEqual(['e2']);
  });

  it('filters subscriptions by account and conversation', () => {
    const subscriptions = new GatewaySubscriptions();
    const received: string[] = [];
    const adapter = new WebGatewayAdapter({
      gateway: null as unknown as ClientGateway,
      journal: null as never,
      subscriptions,
    });

    adapter.subscribe('local-default', 'conv_1', event => received.push(event.eventId));
    subscriptions.publish(makeEvent('e1', 'turn_started', 'local-default', 'conv_1'));
    subscriptions.publish(makeEvent('e2', 'turn_started', 'local-default', 'conv_2'));
    subscriptions.publish(makeEvent('e3', 'turn_started', 'acct-other', 'conv_1'));

    expect(received).toEqual(['e1']);
  });
});
