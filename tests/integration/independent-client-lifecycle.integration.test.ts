import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import type { GatewayEventKind } from '../../src/gateway/client-events.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { encodeJsonLine } from '../../src/gateway/jsonl.js';
import type { GatewayServerMessage } from '../../src/gateway/protocol.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';
import { workspaceEventStreamId } from '../../src/gateway/workspace-event-stream.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('independent client lifecycle integration', () => {
  it('opens a Workspace home without creating or attaching a Conversation', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const client = await connect(fixture.socketPath);

    await expect(client.next(message => message.type === 'hello')).resolves.toMatchObject({
      type: 'hello',
      attached: false,
    });
    expect(fixture.attached).toEqual([]);

    client.socket.write(command('select-a', 'tui_a', {
      scope: { kind: 'workspace' },
      command: { kind: 'select_workspace', path: '/repo-a' },
    }));

    await expect(client.next(message => (
      message.type === 'event'
      && message.event.kind === 'workspace_directory_snapshot'
    ))).resolves.toMatchObject({
      event: {
        conversationId: workspaceEventStreamId('workspace_repo'),
        payload: {
          workspaceId: 'workspace_repo',
          page: { items: [] },
        },
      },
    });
    await expect(client.next(receiptFor('select-a'))).resolves.toMatchObject({
      receipt: {
        status: 'accepted',
        workspaceId: 'workspace_repo',
        conversationId: null,
      },
    });
    expect(fixture.attached).toEqual([]);

    client.socket.destroy();
    await fixture.server.stop();
  });

  it('shares one Workspace directory while keeping details attach-scoped', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const clientA = await connect(fixture.socketPath);
    const clientB = await connect(fixture.socketPath);
    await Promise.all([
      clientA.next(message => message.type === 'hello'),
      clientB.next(message => message.type === 'hello'),
    ]);

    for (const [client, requestId, connectionId] of [
      [clientA, 'select-a', 'tui_a'],
      [clientB, 'select-b', 'tui_b'],
    ] as const) {
      client.socket.write(command(requestId, connectionId, {
        scope: { kind: 'workspace' },
        command: { kind: 'select_workspace', path: '/repo-a' },
      }));
      await client.next(receiptFor(requestId));
    }

    clientA.socket.write(command('create-a', 'tui_a', {
      scope: { kind: 'workspace' },
      command: { kind: 'create_conversation', workspaceId: 'workspace_repo' },
    }));
    await expect(clientA.next(receiptFor('create-a'))).resolves.toMatchObject({
      receipt: {
        status: 'accepted',
        conversationId: 'conv_shared',
        workspaceId: 'workspace_repo',
      },
    });
    await expect(clientB.next(message => (
      message.type === 'event'
      && message.event.kind === 'workspace_conversation_upserted'
    ))).resolves.toMatchObject({
      event: {
        payload: {
          conversation: {
            conversationId: 'conv_shared',
            title: 'Shared task',
          },
        },
      },
    });

    clientA.socket.write(attach('tui_a', 'conv_shared'));
    await clientA.next(attachedTo('conv_shared'));
    await fixture.publish('conv_shared', 'final_answer', { lines: ['private result'] });
    await clientA.next(message => (
      message.type === 'output' && message.lines.includes('private result')
    ));
    expect(clientB.messages().some(message => (
      message.type === 'output' && message.lines.includes('private result')
    ))).toBe(false);

    clientB.socket.write(attach('tui_b', 'conv_shared'));
    await expect(clientB.next(message => (
      message.type === 'output' && message.lines.includes('private result')
    ))).resolves.toMatchObject({
      event: { conversationId: 'conv_shared' },
    });
    await clientB.next(attachedTo('conv_shared'));

    clientA.socket.destroy();
    clientB.socket.destroy();
    await fixture.server.stop();
  });

  it('keeps the Server and a second attached Client alive when the first exits', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const clientA = await connect(fixture.socketPath);
    const clientB = await connect(fixture.socketPath);
    await Promise.all([
      clientA.next(message => message.type === 'hello'),
      clientB.next(message => message.type === 'hello'),
    ]);
    clientA.socket.write(attach('tui_a', 'conv_a'));
    clientB.socket.write(attach('tui_b', 'conv_b'));
    await Promise.all([
      clientA.next(attachedTo('conv_a')),
      clientB.next(attachedTo('conv_b')),
    ]);

    clientA.socket.destroy();
    await waitForClose(clientA.socket);
    await fixture.publish('conv_b', 'final_answer', { lines: ['client B remains live'] });
    await expect(clientB.next(message => (
      message.type === 'output' && message.lines.includes('client B remains live')
    ))).resolves.toMatchObject({
      event: { conversationId: 'conv_b' },
    });

    clientB.socket.destroy();
    await fixture.server.stop();
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'metawork-independent-clients-'));
  roots.push(root);
  const socketPath = join(root, 'gateway.sock');
  const journal = new FileEventJournal(join(root, 'events'));
  const subscriptions = new GatewaySubscriptions();
  const attached: string[] = [];

  const publish = async (
    conversationId: string,
    kind: GatewayEventKind,
    payload: unknown,
  ) => {
    const event = await journal.append({
      protocolVersion: 2,
      eventId: `event_${Date.now()}_${Math.random()}`,
      sequence: 0,
      accountId: 'local-default',
      conversationId,
      requestId: null,
      turnId: null,
      kind,
      payload,
      occurredAt: new Date().toISOString(),
    });
    subscriptions.publish(event);
  };

  const gateway = {
    handle: async (envelope: GatewayCommandEnvelope) => {
      if (envelope.command.kind === 'select_workspace') {
        await publish(workspaceEventStreamId('workspace_repo'), 'workspace_directory_snapshot', {
          workspaceId: 'workspace_repo',
          workspace: {
            id: 'workspace_repo',
            displayName: 'repo-a',
            canonicalPath: '/repo-a',
            availability: 'available',
          },
          page: { items: [], nextCursor: null },
        });
        return receipt(envelope, null, 'workspace_repo');
      }
      if (envelope.command.kind === 'create_conversation') {
        await publish(workspaceEventStreamId('workspace_repo'), 'workspace_conversation_upserted', {
          workspaceId: 'workspace_repo',
          conversation: {
            conversationId: 'conv_shared',
            workspaceId: 'workspace_repo',
            title: 'Shared task',
            preview: 'Shared task',
            updatedAt: '2026-08-28T00:00:00.000Z',
            activity: {
              state: 'idle',
              taskId: null,
              updatedAt: '2026-08-28T00:00:00.000Z',
            },
          },
        });
        return receipt(envelope, 'conv_shared', 'workspace_repo');
      }
      const conversationId = envelope.scope.kind === 'conversation'
        && envelope.scope.selection.mode === 'attach'
        ? envelope.scope.selection.conversationId
        : null;
      return receipt(envelope, conversationId, null);
    },
  } as unknown as ClientGateway;

  const server = new MetaclawGatewayServer({
    socketPath,
    gateway,
    journal,
    subscriptions,
    authorizeAttach: async () => true,
    attachClient: async (_accountId, conversationId) => {
      attached.push(conversationId);
      return () => undefined;
    },
  });
  return { socketPath, server, attached, publish };
}

function receipt(
  envelope: GatewayCommandEnvelope,
  conversationId: string | null,
  workspaceId: string | null,
) {
  return {
    requestId: envelope.requestId,
    idempotencyKey: envelope.idempotencyKey,
    status: 'accepted' as const,
    conversationId,
    workspaceId,
  };
}

function command(
  requestId: string,
  connectionId: string,
  input: Pick<GatewayCommandEnvelope, 'scope' | 'command'>,
): string {
  return encodeJsonLine({
    type: 'command',
    envelope: {
      protocolVersion: 2,
      requestId,
      idempotencyKey: `idem_${requestId}`,
      connectionId,
      scope: input.scope,
      command: input.command,
      clientCapabilities: ['trace_v1'],
    },
  });
}

function attach(connectionId: string, conversationId: string): string {
  return encodeJsonLine({
    type: 'attach',
    connectionId,
    conversationId,
    resumeFromSequence: 0,
  });
}

function receiptFor(requestId: string) {
  return (message: GatewayServerMessage) => (
    message.type === 'receipt' && message.receipt.requestId === requestId
  );
}

function attachedTo(conversationId: string) {
  return (message: GatewayServerMessage) => (
    message.type === 'hello'
    && message.attached
    && message.sessionId === conversationId
  );
}

async function connect(socketPath: string): Promise<{
  socket: Socket;
  next(predicate: (message: GatewayServerMessage) => boolean): Promise<GatewayServerMessage>;
  messages(): GatewayServerMessage[];
}> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const queued: GatewayServerMessage[] = [];
  const received: GatewayServerMessage[] = [];
  const waiters: Array<{
    predicate: (message: GatewayServerMessage) => boolean;
    resolve: (message: GatewayServerMessage) => void;
  }> = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      const message = JSON.parse(raw) as GatewayServerMessage;
      received.push(message);
      const index = waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) waiters.splice(index, 1)[0]!.resolve(message);
      else queued.push(message);
    }
  });
  return {
    socket,
    next(predicate) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Gateway message timeout; received=${JSON.stringify(received)}`));
        }, 1_000);
        waiters.push({
          predicate,
          resolve: message => {
            clearTimeout(timer);
            resolve(message);
          },
        });
      });
    },
    messages: () => [...received],
  };
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise(resolve => socket.once('close', resolve));
}
