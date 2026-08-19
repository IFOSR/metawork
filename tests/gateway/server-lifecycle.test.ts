import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import type { EventJournal } from '../../src/gateway/event-journal.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { encodeJsonLine } from '../../src/gateway/jsonl.js';
import type { GatewayServerMessage } from '../../src/gateway/protocol.js';
import { MetaclawGatewayServer } from '../../src/gateway/server.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('MetaclawGatewayServer lifecycle', () => {
  it('closes connection admission synchronously when stop begins', async () => {
    const fixture = await createFixture();
    await fixture.server.start();

    const stopping = fixture.server.stop();
    const socket = createConnection(fixture.socketPath);
    const outcome = await new Promise<'connected' | 'refused'>(resolve => {
      socket.once('connect', () => resolve('connected'));
      socket.once('error', () => resolve('refused'));
    });
    socket.destroy();
    await stopping;

    expect(outcome).toBe('refused');
  });

  it('reattaches to the same conversation and replays events after reconnect', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const first = await connect(fixture.socketPath);
    const hello = await first.next(message => message.type === 'hello');
    expect(hello.type).toBe('hello');
    const conversationId = hello.type === 'hello' ? hello.sessionId : '';
    first.socket.destroy();

    const appended = await fixture.journal.append({
      protocolVersion: 1,
      eventId: 'event_reconnect',
      sequence: 0,
      accountId: 'local-default',
      conversationId,
      requestId: 'req_1',
      turnId: 'turn_1',
      kind: 'conversation_snapshot',
      payload: { lines: ['replayed output'] },
      occurredAt: '2026-08-19T00:00:00.000Z',
    });

    const second = await connect(fixture.socketPath);
    await second.next(message => message.type === 'hello');
    second.socket.write(encodeJsonLine({
      type: 'attach',
      conversationId,
      resumeFromSequence: appended.sequence - 1,
    }));
    const replayed = await second.next(message => message.type === 'output');
    expect(replayed).toMatchObject({
      type: 'output',
      lines: ['replayed output'],
      event: {
        eventId: 'event_reconnect',
        sequence: 1,
        conversationId,
      },
    });

    second.socket.destroy();
    await fixture.server.stop();
  });

  it('rejects an explicit attach that fails the ownership gate', async () => {
    const authorized: string[] = [];
    const fixture = await createFixture({
      authorizeAttach: async (_accountId, conversationId) => {
        authorized.push(conversationId);
        return false;
      },
    });
    await fixture.server.start();
    const client = await connect(fixture.socketPath);
    const initial = await client.next(message => message.type === 'hello');
    const initialConversationId = initial.type === 'hello' ? initial.sessionId : '';

    client.socket.write(encodeJsonLine({
      type: 'attach',
      conversationId: 'conv_denied',
    }));

    await expect(client.next(message => message.type === 'error')).resolves.toMatchObject({
      type: 'error',
      message: 'conversation attach denied',
    });
    expect(authorized).toEqual(['conv_denied']);
    expect(client.messages()
      .filter(message => message.type === 'hello')
      .map(message => message.type === 'hello' ? message.sessionId : ''))
      .toEqual([initialConversationId]);

    client.socket.destroy();
    await fixture.server.stop();
  });

  it('fences an older replay when a newer attach completes first', async () => {
    let releaseOld!: () => void;
    let markOldReplayStarted!: () => void;
    const oldGate = new Promise<void>(resolve => {
      releaseOld = resolve;
    });
    const oldReplayStarted = new Promise<void>(resolve => {
      markOldReplayStarted = resolve;
    });
    const journal = replayJournal(async conversationId => {
      if (conversationId === 'conv_old') {
        markOldReplayStarted();
        await oldGate;
        return replayWith(outputEvent('event_old', 'conv_old', ['old replay']));
      }
      if (conversationId === 'conv_new') {
        return replayWith(outputEvent('event_new', 'conv_new', ['new replay']));
      }
      return emptyReplay();
    });
    const fixture = await createFixture({ journal });
    await fixture.server.start();
    const client = await connect(fixture.socketPath);
    await client.next(message => message.type === 'hello');

    client.socket.write(encodeJsonLine({ type: 'attach', conversationId: 'conv_old' }));
    await oldReplayStarted;
    client.socket.write(encodeJsonLine({ type: 'attach', conversationId: 'conv_new' }));

    await expect(client.next(message => (
      message.type === 'hello' && message.sessionId === 'conv_new'
    ))).resolves.toMatchObject({ type: 'hello', sessionId: 'conv_new' });
    releaseOld();
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(client.messages().some(message => (
      message.type === 'output' && message.event.conversationId === 'conv_old'
    ))).toBe(false);
    expect(client.messages().filter(message => (
      message.type === 'hello' && message.sessionId === 'conv_old'
    ))).toHaveLength(0);

    client.socket.destroy();
    await fixture.server.stop();
  });

  it('replays a terminal snapshot exactly once when snapshot and deltas overlap', async () => {
    const terminal = finalEvent('event_final', 'conv_terminal', ['final answer']);
    const journal = replayJournal(async conversationId => (
      conversationId === 'conv_terminal'
        ? { lastSequence: 1, snapshot: [terminal], deltas: [terminal] }
        : emptyReplay()
    ));
    const fixture = await createFixture({ journal });
    await fixture.server.start();
    const client = await connect(fixture.socketPath);
    await client.next(message => message.type === 'hello');

    client.socket.write(encodeJsonLine({
      type: 'attach',
      conversationId: 'conv_terminal',
    }));
    await client.next(message => (
      message.type === 'hello' && message.sessionId === 'conv_terminal'
    ));

    expect(client.messages().filter(message => (
      message.type === 'output' && message.lines.join('\n') === 'final answer'
    ))).toHaveLength(1);

    client.socket.destroy();
    await fixture.server.stop();
  });

  it('streams non-terminal trace events and returns a command receipt', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const client = await connect(fixture.socketPath);
    const hello = await client.next(message => message.type === 'hello');
    const conversationId = hello.type === 'hello' ? hello.sessionId : '';

    const traceEvent: GatewayEventEnvelope = {
      protocolVersion: 1,
      eventId: 'event_trace',
      sequence: 1,
      accountId: 'local-default',
      conversationId,
      requestId: 'req_trace',
      turnId: 'turn_trace',
      kind: 'trace_delta',
      payload: { events: [{ phase: 'planner', message: 'Planner parsed intent' }] },
      occurredAt: '2026-08-19T00:00:00.000Z',
    };
    fixture.subscriptions.publish(traceEvent);
    await expect(client.next(message => (
      message.type === 'event' && message.event.eventId === 'event_trace'
    ))).resolves.toMatchObject({
      type: 'event',
      event: { kind: 'trace_delta' },
    });

    client.socket.write(encodeJsonLine({
      type: 'command',
      envelope: {
        protocolVersion: 1,
        requestId: 'req_command',
        idempotencyKey: 'idem_command',
        connectionId: 'native_tui',
        conversation: { mode: 'attach', conversationId },
        command: { kind: 'user_message', text: 'hello', attachments: [] },
        clientCapabilities: ['trace_v1'],
      },
    }));
    await expect(client.next(message => (
      message.type === 'receipt' && message.receipt.requestId === 'req_command'
    ))).resolves.toMatchObject({
      type: 'receipt',
      receipt: {
        requestId: 'req_command',
        status: 'accepted',
      },
    });

    client.socket.destroy();
    await fixture.server.stop();
  });

  it('closes only the offending socket for malformed JSON and keeps serving', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const malformed = await connect(fixture.socketPath);
    await malformed.next(message => message.type === 'hello');

    malformed.socket.write('{"type":}\n');
    await expect(malformed.next(message => message.type === 'error')).resolves.toMatchObject({
      type: 'error',
      message: expect.stringContaining('invalid JSON line'),
    });
    await new Promise<void>(resolve => malformed.socket.once('close', () => resolve()));

    const healthy = await connect(fixture.socketPath);
    await expect(healthy.next(message => message.type === 'hello')).resolves.toMatchObject({
      type: 'hello',
    });

    healthy.socket.destroy();
    await fixture.server.stop();
  });

  it('attaches and detaches the runtime client lifecycle with the socket', async () => {
    const lifecycle: string[] = [];
    const fixture = await createFixture({
      attachClient: async (_accountId, conversationId) => {
        lifecycle.push(`attach:${conversationId}`);
        return () => lifecycle.push(`detach:${conversationId}`);
      },
    });
    await fixture.server.start();
    const client = await connect(fixture.socketPath);
    const hello = await client.next(message => message.type === 'hello');
    const conversationId = hello.type === 'hello' ? hello.sessionId : '';

    client.socket.destroy();
    await new Promise<void>(resolve => client.socket.once('close', () => resolve()));
    await waitFor(() => lifecycle.length === 2);

    expect(lifecycle).toEqual([
      `attach:${conversationId}`,
      `detach:${conversationId}`,
    ]);
    await fixture.server.stop();
  });
});

async function createFixture(options: {
  authorizeAttach?: (accountId: string, conversationId: string) => Promise<boolean>;
  journal?: EventJournal;
  attachClient?: (accountId: string, conversationId: string) => Promise<() => void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-gateway-server-'));
  roots.push(root);
  const socketPath = join(root, 'gateway.sock');
  const journal = options.journal ?? new FileEventJournal(join(root, 'journal'));
  const subscriptions = new GatewaySubscriptions();
  const gateway = {
    handle: async (envelope: { requestId: string; idempotencyKey: string }) => ({
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'accepted',
      conversationId: 'conv_1',
    }),
  } as unknown as ClientGateway;
  return {
    socketPath,
    journal,
    subscriptions,
    server: new MetaclawGatewayServer({
      socketPath,
      gateway,
      journal,
      subscriptions,
      authorizeAttach: options.authorizeAttach ?? (async () => true),
      attachClient: options.attachClient,
    }),
  };
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
      if (index >= 0) {
        waiters.splice(index, 1)[0]!.resolve(message);
      } else {
        queued.push(message);
      }
    }
  });
  return {
    socket,
    next(predicate) {
      const index = queued.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
      return new Promise(resolve => waiters.push({ predicate, resolve }));
    },
    messages: () => [...received],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function replayJournal(
  replay: (conversationId: string) => Promise<GatewayReplay>,
): EventJournal {
  return {
    append: async event => event,
    replay: async (_accountId, conversationId) => replay(conversationId),
  };
}

function emptyReplay(): GatewayReplay {
  return { lastSequence: 0, snapshot: [], deltas: [] };
}

function replayWith(event: GatewayEventEnvelope): GatewayReplay {
  return { lastSequence: event.sequence, snapshot: [], deltas: [event] };
}

function outputEvent(
  eventId: string,
  conversationId: string,
  lines: string[],
): GatewayEventEnvelope {
  return {
    protocolVersion: 1,
    eventId,
    sequence: 1,
    accountId: 'local-default',
    conversationId,
    requestId: 'req_1',
    turnId: 'turn_1',
    kind: 'conversation_snapshot',
    payload: { lines },
    occurredAt: '2026-08-19T00:00:00.000Z',
  };
}

function finalEvent(
  eventId: string,
  conversationId: string,
  lines: string[],
): GatewayEventEnvelope {
  return {
    ...outputEvent(eventId, conversationId, lines),
    kind: 'final_answer',
  };
}
