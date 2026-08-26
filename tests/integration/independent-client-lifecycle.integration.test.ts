import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { encodeJsonLine } from '../../src/gateway/jsonl.js';
import type { GatewayServerMessage } from '../../src/gateway/protocol.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('independent client lifecycle integration', () => {
  it('keeps Server and the second Client alive when the first Client exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metawork-independent-clients-'));
    roots.push(root);
    const socketPath = join(root, 'gateway.sock');
    const subscriptions = new GatewaySubscriptions();
    const journal = new FileEventJournal(join(root, 'events'));
    const workspaces = new Map<string, string>();
    const submitted: GatewayCommandEnvelope[] = [];

    const gateway = {
      handle: async (envelope: GatewayCommandEnvelope) => {
        submitted.push(envelope);
        const conversationId = envelope.conversation.mode === 'attach'
          ? envelope.conversation.conversationId
          : 'unknown';
        if (envelope.command.kind === 'slash_command'
          && envelope.command.text.startsWith('/workspace ')) {
          const workspace = envelope.command.text.slice('/workspace '.length).trim();
          workspaces.set(conversationId, workspace);
          publishSnapshot(conversationId, `workspace:${workspace}`);
        } else if (envelope.command.kind === 'user_message') {
          if (!workspaces.has(conversationId)) {
            return {
              requestId: envelope.requestId,
              idempotencyKey: envelope.idempotencyKey,
              status: 'rejected' as const,
              reason: 'workspace_required',
              conversationId,
            };
          }
          publishSnapshot(conversationId, `answer:${envelope.command.text}`);
        }
        return {
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          conversationId,
        };
      },
    } as unknown as ClientGateway;

    function publishSnapshot(conversationId: string, line: string): void {
      subscriptions.publish({
        protocolVersion: 1,
        eventId: `event_${conversationId}_${Date.now()}_${Math.random()}`,
        sequence: 0,
        accountId: 'local-default',
        conversationId,
        requestId: null,
        turnId: null,
        kind: 'conversation_snapshot',
        payload: { lines: [line], from: 0 },
        occurredAt: new Date().toISOString(),
      });
    }

    const server = new MetaclawGatewayServer({
      socketPath,
      gateway,
      journal,
      subscriptions,
      authorizeAttach: async () => true,
    });
    await server.start();

    const clientA = await connect(socketPath);
    const clientB = await connect(socketPath);
    const helloA = await clientA.next(message => message.type === 'hello');
    const helloB = await clientB.next(message => message.type === 'hello');
    const conversationA = helloA.type === 'hello' ? helloA.sessionId : '';
    const conversationB = helloB.type === 'hello' ? helloB.sessionId : '';

    expect(conversationA).not.toBe(conversationB);

    clientA.socket.write(input('A', conversationA, '/workspace /tmp/workspace-a'));
    clientB.socket.write(input('B', conversationB, '/workspace /tmp/workspace-b'));
    await clientA.next(message => message.type === 'output');
    await clientB.next(message => message.type === 'output');

    clientA.socket.write(input('A-task', conversationA, 'run task A'));
    clientB.socket.write(input('B-task', conversationB, 'run task B'));
    await clientA.next(message => message.type === 'output');
    await clientB.next(message => message.type === 'output');
    expect(workspaces).toEqual(new Map([
      [conversationA, '/tmp/workspace-a'],
      [conversationB, '/tmp/workspace-b'],
    ]));

    clientA.socket.destroy();
    await waitForClose(clientA.socket);

    clientB.socket.write(input('B-after-a-exit', conversationB, 'run task B again'));
    await clientB.next(message => message.type === 'output');
    expect(submitted.at(-1)?.conversation).toEqual({
      mode: 'attach',
      conversationId: conversationB,
    });

    clientB.socket.destroy();
    await waitForClose(clientB.socket);

    const clientC = await connect(socketPath);
    await expect(clientC.next(message => message.type === 'hello')).resolves.toMatchObject({
      type: 'hello',
    });
    clientC.socket.destroy();
    await waitForClose(clientC.socket);
    await server.stop();
  });

  function input(requestId: string, conversationId: string, text: string): string {
    return encodeJsonLine({
      type: 'input',
      requestId,
      idempotencyKey: `idem_${requestId}`,
      conversationId,
      text,
    });
  }
});

async function connect(socketPath: string): Promise<{
  socket: Socket;
  next(predicate: (message: GatewayServerMessage) => boolean): Promise<GatewayServerMessage>;
}> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const queued: GatewayServerMessage[] = [];
  const waiters: Array<{
    predicate: (message: GatewayServerMessage) => boolean;
    resolve: (message: GatewayServerMessage) => void;
  }> = [];
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as GatewayServerMessage;
      const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
      if (waiterIndex >= 0) {
        waiters.splice(waiterIndex, 1)[0]!.resolve(message);
      } else {
        queued.push(message);
      }
    }
  });
  return {
    socket,
    next(predicate) {
      const queuedIndex = queued.findIndex(predicate);
      if (queuedIndex >= 0) return Promise.resolve(queued.splice(queuedIndex, 1)[0]!);
      return new Promise(resolve => waiters.push({ predicate, resolve }));
    },
  };
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>(resolve => socket.once('close', () => resolve()));
}
