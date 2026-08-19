import { existsSync, unlinkSync } from 'fs';
import { createServer, type Server, type Socket } from 'net';
import { nanoid } from 'nanoid';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import type { ClientGateway } from './client-gateway.js';
import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';
import type { GatewayCommand } from './client-protocol.js';
import type { EventJournal } from './event-journal.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import {
  parseGatewayClientMessage,
  type GatewayServerMessage,
} from './protocol.js';

interface GatewayServerDeps {
  socketPath: string;
  gateway: ClientGateway;
  journal: EventJournal;
  subscriptions: GatewaySubscriptions;
  authorizeAttach(accountId: string, conversationId: string): Promise<boolean>;
  attachClient?(accountId: string, conversationId: string): Promise<() => void>;
  onConversationCreated?(accountId: string, conversationId: string): void;
  accountId?: string;
}

export class MetaclawGatewayServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private stopping = false;

  constructor(private readonly deps: GatewayServerDeps) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.stopping = false;
    if (existsSync(this.deps.socketPath)) unlinkSync(this.deps.socketPath);
    this.server = createServer(socket => {
      if (this.stopping) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      this.handleConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.stopping = true;
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await closed;
    if (existsSync(this.deps.socketPath)) unlinkSync(this.deps.socketPath);
  }

  private handleConnection(socket: Socket): void {
    const accountId = this.deps.accountId ?? LOCAL_DEFAULT_ACCOUNT_ID;
    let conversationId = `conv_gateway_${nanoid(10)}`;
    let unsubscribe: (() => void) | null = null;
    let latestAttachRequest = 0;
    let activeAttachment: { readonly token: object; detachClient(): void } | null = null;
    this.deps.onConversationCreated?.(accountId, conversationId);

    const send = (message: GatewayServerMessage) => {
      if (!socket.destroyed) socket.write(encodeJsonLine(message));
    };
    const attach = async (
      nextConversationId: string,
      resumeFromSequence = 0,
      authorize = true,
    ) => {
      const request = latestAttachRequest += 1;
      if (authorize && !await this.deps.authorizeAttach(accountId, nextConversationId)) {
        if (request === latestAttachRequest) {
          throw new Error('conversation attach denied');
        }
        return;
      }
      if (request !== latestAttachRequest) return;

      const token = {};
      const detachClient = await this.deps.attachClient?.(accountId, nextConversationId)
        ?? (() => undefined);
      if (request !== latestAttachRequest) {
        detachClient();
        return;
      }
      const buffered: GatewayEventEnvelope[] = [];
      const deliveredEventIds = new Set<string>();
      let replaying = true;
      const sendAttachedEvent = (event: GatewayEventEnvelope) => {
        if (deliveredEventIds.has(event.eventId)) return;
        deliveredEventIds.add(event.eventId);
        this.sendEvent(send, event);
      };
      const nextUnsubscribe = this.deps.subscriptions.subscribe({
        accountId,
        conversationId: nextConversationId,
        listener: event => {
          if (replaying) buffered.push(event);
          else sendAttachedEvent(event);
        },
      });
      activeAttachment?.detachClient();
      unsubscribe?.();
      unsubscribe = nextUnsubscribe;
      conversationId = nextConversationId;
      activeAttachment = { token, detachClient };

      let replay: GatewayReplay;
      try {
        replay = await this.deps.journal.replay(
          accountId,
          nextConversationId,
          resumeFromSequence,
        );
      } catch (error) {
        if (activeAttachment?.token === token) {
          nextUnsubscribe();
          unsubscribe = null;
          activeAttachment.detachClient();
          activeAttachment = null;
        }
        throw error;
      }
      if (activeAttachment?.token !== token) {
        nextUnsubscribe();
        detachClient();
        return;
      }

      for (const event of orderedUniqueReplayEvents(replay)) sendAttachedEvent(event);
      replaying = false;
      for (const event of orderedUniqueEvents(buffered)) {
        if (event.sequence > replay.lastSequence) sendAttachedEvent(event);
      }
      send({ type: 'hello', sessionId: nextConversationId });
    };

    void attach(conversationId, 0, false).catch(error => {
      send({ type: 'error', message: (error as Error).message });
    });
    const cleanup = () => {
      latestAttachRequest += 1;
      activeAttachment?.detachClient();
      activeAttachment = null;
      unsubscribe?.();
      unsubscribe = null;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    const parse = createJsonLineParser<unknown>(input => {
      const message = parseGatewayClientMessage(input);
      if (!message) {
        send({ type: 'error', message: 'invalid Gateway client message' });
        return;
      }
      if (message.type === 'close') {
        socket.end(encodeJsonLine({ type: 'exit' } satisfies GatewayServerMessage));
        return;
      }
      if (message.type === 'attach') {
        void attach(message.conversationId, message.resumeFromSequence).catch(error => {
          send({ type: 'error', message: (error as Error).message });
        });
        return;
      }
      if (message.type === 'command') {
        const envelope = message.envelope;
        void this.deps.gateway.handle(envelope, 'local').then(receipt => {
          if ('kind' in receipt) {
            send({ type: 'error', message: receipt.message, requestId: envelope.requestId });
            return;
          }
          send({ type: 'receipt', receipt });
        }).catch(error => {
          send({
            type: 'error',
            message: (error as Error).message,
            requestId: envelope.requestId,
          });
        });
        return;
      }
      if (message.type !== 'input') return;
      const selectedConversationId = message.conversationId ?? conversationId;
      const command: GatewayCommand = message.text.startsWith('/')
        ? { kind: 'slash_command', text: message.text }
        : { kind: 'user_message', text: message.text, attachments: [] };
      void this.deps.gateway.handle({
        protocolVersion: 1,
        requestId: message.requestId ?? `req_${nanoid(12)}`,
        idempotencyKey: message.idempotencyKey ?? `idem_${nanoid(12)}`,
        connectionId: `unix_${nanoid(8)}`,
        conversation: { mode: 'attach', conversationId: selectedConversationId },
        command,
        clientCapabilities: ['trace_v1'],
      }, 'local').then(receipt => {
        if ('kind' in receipt || receipt.status === 'rejected') {
          send({
            type: 'error',
            message: 'kind' in receipt ? receipt.message : receipt.reason ?? 'Gateway rejected input',
          });
        }
      }).catch(error => {
        send({ type: 'error', message: (error as Error).message });
      });
    }, {
      onError: error => {
        if (!socket.destroyed) {
          socket.end(encodeJsonLine({
            type: 'error',
            message: error.message,
          } satisfies GatewayServerMessage));
        }
      },
    });
    socket.on('data', parse);
  }

  private sendEvent(
    send: (message: GatewayServerMessage) => void,
    event: GatewayEventEnvelope,
  ): void {
    send({ type: 'event', event });
    if (event.kind === 'conversation_snapshot' || event.kind === 'final_answer') {
      const projection = event.payload as { lines?: string[] };
      if (projection.lines?.length) {
        send({ type: 'output', lines: projection.lines, event });
      }
    } else if (event.kind === 'terminal_error') {
      const error = event.payload as { message?: string };
      send({
        type: 'error',
        message: error.message ?? 'Gateway execution failed',
        event,
      });
    }
  }
}

function orderedUniqueReplayEvents(replay: GatewayReplay): GatewayEventEnvelope[] {
  return orderedUniqueEvents([...replay.snapshot, ...replay.deltas]);
}

function orderedUniqueEvents(events: GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    .filter(event => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}
