import { createConnection, type Socket } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import type { GatewayEventEnvelope, GatewayReplay } from '../../src/gateway/client-events.js';
import { clientConnectionEventStreamId } from '../../src/gateway/client-connection-event-stream.js';
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
    await first.next(message => message.type === 'hello');
    const conversationId = 'conv_reconnect';
    first.socket.destroy();

    const appended = await fixture.journal.append({
      protocolVersion: 2,
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
      connectionId: 'native_tui',
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
      connectionId: 'native_tui',
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

    client.socket.write(encodeJsonLine({
      type: 'attach',
      connectionId: 'native_tui',
      conversationId: 'conv_old',
    }));
    await oldReplayStarted;
    client.socket.write(encodeJsonLine({
      type: 'attach',
      connectionId: 'native_tui',
      conversationId: 'conv_new',
    }));

    await expect(client.next(message => (
      message.type === 'hello' && message.sessionId === 'conv_new'
    ))).resolves.toMatchObject({
      type: 'hello',
      sessionId: 'conv_new',
      attached: true,
    });
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
      connectionId: 'native_tui',
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
    await client.next(message => message.type === 'hello');
    const conversationId = 'conv_stream';
    client.socket.write(encodeJsonLine({
      type: 'attach',
      connectionId: 'native_tui',
      conversationId,
    }));
    await client.next(message => (
      message.type === 'hello'
      && message.attached
      && message.sessionId === conversationId
    ));

    const traceEvent: GatewayEventEnvelope = {
      protocolVersion: 2,
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
        protocolVersion: 2,
        requestId: 'req_command',
        idempotencyKey: 'idem_command',
        connectionId: 'native_tui',
        scope: {
          kind: 'conversation',
          selection: { mode: 'attach', conversationId },
        },
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

  it('delivers filtered Workspace query results only to the requesting connection', async () => {
    let subscriptions: GatewaySubscriptions;
    const fixture = await createFixture({
      handleGateway: async envelope => {
        if (envelope.command.kind === 'list_workspace_conversations') {
          subscriptions.publish({
            protocolVersion: 2,
            eventId: `event_${envelope.requestId}`,
            sequence: 1,
            accountId: 'local-default',
            conversationId: clientConnectionEventStreamId(envelope.connectionId),
            requestId: envelope.requestId,
            turnId: null,
            kind: 'workspace_directory_snapshot',
            payload: {
              workspaceId: envelope.command.workspaceId,
              page: { items: [], nextCursor: null },
            },
            occurredAt: '2026-08-28T00:00:00.000Z',
          });
        }
        return {
          requestId: envelope.requestId,
          idempotencyKey: envelope.idempotencyKey,
          status: 'accepted' as const,
          conversationId: null,
          workspaceId: 'workspace_repo',
        };
      },
    });
    subscriptions = fixture.subscriptions;
    await fixture.server.start();
    const first = await connect(fixture.socketPath);
    const second = await connect(fixture.socketPath);
    await first.next(message => message.type === 'hello');
    await second.next(message => message.type === 'hello');

    first.socket.write(encodeJsonLine({
      type: 'command',
      envelope: {
        protocolVersion: 2,
        requestId: 'req_list_first',
        idempotencyKey: 'idem_list_first',
        connectionId: 'client_first',
        scope: { kind: 'workspace' },
        command: {
          kind: 'list_workspace_conversations',
          workspaceId: 'workspace_repo',
          query: 'only-first',
        },
        clientCapabilities: [],
      },
    }));

    await first.next(message => (
      message.type === 'receipt' && message.receipt.requestId === 'req_list_first'
    ));
    await waitFor(() => first.messages().some(message => (
      message.type === 'event' && message.event.requestId === 'req_list_first'
    )));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(second.messages().some(message => (
      message.type === 'event' && message.event.requestId === 'req_list_first'
    ))).toBe(false);

    first.socket.destroy();
    second.socket.destroy();
    await fixture.server.stop();
  });

  it('binds one unique Client connection ID to each socket', async () => {
    const fixture = await createFixture();
    await fixture.server.start();
    const first = await connect(fixture.socketPath);
    const second = await connect(fixture.socketPath);
    await first.next(message => message.type === 'hello');
    await second.next(message => message.type === 'hello');

    first.socket.write(encodeJsonLine(workspaceCommandEnvelope(
      'req_first',
      'shared_connection',
    )));
    await first.next(message => (
      message.type === 'receipt' && message.receipt.requestId === 'req_first'
    ));

    second.socket.write(encodeJsonLine(workspaceCommandEnvelope(
      'req_collision',
      'shared_connection',
    )));
    await waitFor(() => second.messages().some(message => (
      (message.type === 'error' && message.requestId === 'req_collision')
      || (message.type === 'receipt' && message.receipt.requestId === 'req_collision')
    )));
    expect(second.messages()).toContainEqual(expect.objectContaining({
      type: 'error',
      requestId: 'req_collision',
      message: 'connection_id_in_use',
    }));

    first.socket.write(encodeJsonLine(workspaceCommandEnvelope(
      'req_changed',
      'different_connection',
    )));
    await waitFor(() => first.messages().some(message => (
      (message.type === 'error' && message.requestId === 'req_changed')
      || (message.type === 'receipt' && message.receipt.requestId === 'req_changed')
    )));
    expect(first.messages()).toContainEqual(expect.objectContaining({
      type: 'error',
      requestId: 'req_changed',
      message: 'connection_id_locked',
    }));

    first.socket.destroy();
    second.socket.destroy();
    await fixture.server.stop();
  });

  it('does not let an old socket cleanup clear a reclaimed connection ID', async () => {
    const closedConnections: string[] = [];
    const fixture = await createFixture({
      closeConnection: connectionId => closedConnections.push(connectionId),
    });
    await fixture.server.start();
    const first = await connect(fixture.socketPath);
    await first.next(message => message.type === 'hello');
    first.socket.write(encodeJsonLine(workspaceCommandEnvelope(
      'req_first_reclaim',
      'reclaimable_connection',
    )));
    await first.next(message => (
      message.type === 'receipt' && message.receipt.requestId === 'req_first_reclaim'
    ));

    first.socket.destroy();
    await waitFor(() => closedConnections.length === 1);
    expect(closedConnections).toEqual(['reclaimable_connection']);

    const second = await connect(fixture.socketPath);
    await second.next(message => message.type === 'hello');
    second.socket.write(encodeJsonLine(workspaceCommandEnvelope(
      'req_second_reclaim',
      'reclaimable_connection',
    )));
    await second.next(message => (
      message.type === 'receipt' && message.receipt.requestId === 'req_second_reclaim'
    ));
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(closedConnections).toEqual(['reclaimable_connection']);
    second.socket.destroy();
    await waitFor(() => closedConnections.length === 2);
    expect(closedConnections).toEqual([
      'reclaimable_connection',
      'reclaimable_connection',
    ]);
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
    await client.next(message => message.type === 'hello');
    const conversationId = 'conv_lifecycle';
    client.socket.write(encodeJsonLine({
      type: 'attach',
      connectionId: 'native_tui',
      conversationId,
    }));
    await client.next(message => (
      message.type === 'hello'
      && message.attached
      && message.sessionId === conversationId
    ));

    client.socket.destroy();
    await new Promise<void>(resolve => client.socket.once('close', () => resolve()));
    await waitFor(() => lifecycle.length === 2);

    expect(lifecycle).toEqual([
      `attach:${conversationId}`,
      `detach:${conversationId}`,
    ]);
    await fixture.server.stop();
  });

  it('registers Web launch context only through the mode-0600 local socket', async () => {
    const registrations: Array<{ workspaceHint: string; conversationId?: string }> = [];
    const fixture = await createFixture({
      registerWebLaunch: async input => {
        registrations.push(input);
        return {
          token: 'opaque-token',
          expiresAt: '2026-08-27T08:01:00.000Z',
        };
      },
    });
    await fixture.server.start();
    const socketMode = (await stat(fixture.socketPath)).mode & 0o777;
    const client = await connect(fixture.socketPath);

    client.socket.write(encodeJsonLine({
      type: 'register_web_launch',
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    }));

    await expect(client.next(message => message.type === 'web_launch_registered'))
      .resolves.toEqual({
        type: 'web_launch_registered',
        token: 'opaque-token',
        expiresAt: '2026-08-27T08:01:00.000Z',
      });
    expect(socketMode).toBe(0o600);
    expect(registrations).toEqual([{
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    }]);

    client.socket.destroy();
    await fixture.server.stop();
  });
});

async function createFixture(options: {
  authorizeAttach?: (accountId: string, conversationId: string) => Promise<boolean>;
  journal?: EventJournal;
  attachClient?: (accountId: string, conversationId: string) => Promise<() => void>;
  registerWebLaunch?: (
    input: { workspaceHint: string; conversationId?: string },
  ) => Promise<{ token: string; expiresAt: string }>;
  handleGateway?: (
    envelope: GatewayCommandEnvelope,
  ) => Promise<{
    requestId: string;
    idempotencyKey: string;
    status: 'accepted' | 'duplicate' | 'rejected';
    conversationId: string | null;
    workspaceId?: string | null;
    reason?: string;
  }>;
  closeConnection?: (connectionId: string) => void;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'anyfusion-gateway-server-'));
  roots.push(root);
  const socketPath = join(root, 'gateway.sock');
  const journal = options.journal ?? new FileEventJournal(join(root, 'journal'));
  const subscriptions = new GatewaySubscriptions();
  const gateway = {
    handle: options.handleGateway ?? (async (envelope: GatewayCommandEnvelope) => ({
      requestId: envelope.requestId,
      idempotencyKey: envelope.idempotencyKey,
      status: 'accepted' as const,
      conversationId: 'conv_1',
    })),
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
      registerWebLaunch: options.registerWebLaunch,
      closeConnection: options.closeConnection,
    }),
  };
}

function workspaceCommandEnvelope(
  requestId: string,
  connectionId: string,
): {
  type: 'command';
  envelope: GatewayCommandEnvelope;
} {
  return {
    type: 'command',
    envelope: {
      protocolVersion: 2,
      requestId,
      idempotencyKey: `idem_${requestId}`,
      connectionId,
      scope: { kind: 'workspace' },
      command: {
        kind: 'list_workspace_conversations',
        workspaceId: 'workspace_repo',
      },
      clientCapabilities: [],
    },
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
    protocolVersion: 2,
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
