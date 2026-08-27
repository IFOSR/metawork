import { chmodSync, existsSync, unlinkSync } from 'fs';
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
import { workspaceEventStreamId } from './workspace-event-stream.js';

interface GatewayServerDeps {
  socketPath: string;
  gateway: ClientGateway;
  journal: EventJournal;
  subscriptions: GatewaySubscriptions;
  authorizeAttach(accountId: string, conversationId: string): Promise<boolean>;
  attachClient?(accountId: string, conversationId: string): Promise<() => void>;
  resolveConversationWorkspaceId?(
    accountId: string,
    conversationId: string,
  ): Promise<string | null>;
  activateConnectionWorkspace?(connectionId: string, workspaceId: string): void;
  publishWorkspaceSnapshot?(workspaceId: string): Promise<void>;
  closeConnection?(connectionId: string): void;
  registerWebLaunch?(
    input: { workspaceHint: string; conversationId?: string },
  ): Promise<{ token: string; expiresAt: string }>;
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
    chmodSync(this.deps.socketPath, 0o600);
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
    const socketConnectionId = `connection_${nanoid(10)}`;
    let conversationId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let workspaceUnsubscribe: (() => void) | null = null;
    let activeWorkspaceId: string | null = null;
    let latestAttachRequest = 0;
    let latestWorkspaceRequest = 0;
    let activeAttachment: { readonly token: object; detachClient(): void } | null = null;
    const clientConnectionIds = new Set<string>();

    const send = (message: GatewayServerMessage) => {
      if (!socket.destroyed) socket.write(encodeJsonLine(message));
    };
    const attachWorkspace = async (workspaceId: string, workspaceRequest: number) => {
      if (activeWorkspaceId === workspaceId && workspaceUnsubscribe) return;
      const channelId = workspaceEventStreamId(workspaceId);
      const buffered: GatewayEventEnvelope[] = [];
      const deliveredEventIds = new Set<string>();
      let replaying = true;
      const sendWorkspaceEvent = (event: GatewayEventEnvelope) => {
        if (deliveredEventIds.has(event.eventId)) return;
        deliveredEventIds.add(event.eventId);
        this.sendEvent(send, event);
      };
      const nextUnsubscribe = this.deps.subscriptions.subscribe({
        accountId,
        conversationId: channelId,
        listener: event => {
          if (replaying) buffered.push(event);
          else sendWorkspaceEvent(event);
        },
      });
      let replay: GatewayReplay;
      try {
        replay = await this.deps.journal.replay(accountId, channelId, 0);
      } catch (error) {
        nextUnsubscribe();
        throw error;
      }
      if (workspaceRequest !== latestWorkspaceRequest) {
        nextUnsubscribe();
        return;
      }
      workspaceUnsubscribe?.();
      workspaceUnsubscribe = nextUnsubscribe;
      activeWorkspaceId = workspaceId;
      for (const event of orderedUniqueReplayEvents(replay)) sendWorkspaceEvent(event);
      replaying = false;
      for (const event of orderedUniqueEvents(buffered)) {
        if (event.sequence > replay.lastSequence) sendWorkspaceEvent(event);
      }
    };
    const attach = async (
      connectionId: string,
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

      clientConnectionIds.add(connectionId);
      const workspaceId = await this.deps.resolveConversationWorkspaceId?.(
        accountId,
        nextConversationId,
      ) ?? null;
      if (request !== latestAttachRequest) return;
      if (workspaceId) {
        const workspaceRequest = latestWorkspaceRequest += 1;
        this.deps.activateConnectionWorkspace?.(connectionId, workspaceId);
        await attachWorkspace(workspaceId, workspaceRequest);
        if (
          request !== latestAttachRequest
          || workspaceRequest !== latestWorkspaceRequest
        ) return;
        await this.deps.publishWorkspaceSnapshot?.(workspaceId);
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
      send({ type: 'hello', sessionId: nextConversationId, attached: true });
    };

    send({ type: 'hello', sessionId: socketConnectionId, attached: false });
    const cleanup = () => {
      latestAttachRequest += 1;
      activeAttachment?.detachClient();
      activeAttachment = null;
      unsubscribe?.();
      unsubscribe = null;
      workspaceUnsubscribe?.();
      workspaceUnsubscribe = null;
      for (const connectionId of clientConnectionIds) {
        this.deps.closeConnection?.(connectionId);
      }
      clientConnectionIds.clear();
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
        void attach(
          message.connectionId,
          message.conversationId,
          message.resumeFromSequence,
        ).catch(error => {
          send({ type: 'error', message: (error as Error).message });
        });
        return;
      }
      if (message.type === 'register_web_launch') {
        if (!this.deps.registerWebLaunch) {
          send({ type: 'error', message: 'Web launch registration is unavailable' });
          return;
        }
        void this.deps.registerWebLaunch({
          workspaceHint: message.workspaceHint,
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        }).then(launch => {
          send({
            type: 'web_launch_registered',
            token: launch.token,
            expiresAt: launch.expiresAt,
          });
        }).catch(error => {
          send({ type: 'error', message: (error as Error).message });
        });
        return;
      }
      if (message.type === 'command') {
        const envelope = message.envelope;
        clientConnectionIds.add(envelope.connectionId);
        void this.deps.gateway.handle(envelope, 'local').then(receipt => {
          if ('kind' in receipt) {
            send({ type: 'error', message: receipt.message, requestId: envelope.requestId });
            return;
          }
          const sendReceipt = async () => {
            if (receipt.status === 'accepted' && receipt.workspaceId) {
              const workspaceRequest = latestWorkspaceRequest += 1;
              await attachWorkspace(receipt.workspaceId, workspaceRequest);
            }
            send({ type: 'receipt', receipt });
          };
          return sendReceipt();
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
      if (!selectedConversationId) {
        send({ type: 'error', message: 'conversation_required' });
        return;
      }
      const command: GatewayCommand = message.text.startsWith('/')
        ? { kind: 'slash_command', text: message.text }
        : { kind: 'user_message', text: message.text, attachments: [] };
      void this.deps.gateway.handle({
        protocolVersion: 2,
        requestId: message.requestId ?? `req_${nanoid(12)}`,
        idempotencyKey: message.idempotencyKey ?? `idem_${nanoid(12)}`,
        connectionId: `unix_${nanoid(8)}`,
        scope: {
          kind: 'conversation',
          selection: { mode: 'attach', conversationId: selectedConversationId },
        },
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
