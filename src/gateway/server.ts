import { DESKTOP_SESSION_CAPABILITY, type DesktopSessionGrant } from './desktop-session-contract.js';
import { chmodSync, existsSync, unlinkSync } from 'fs';
import { createServer } from 'net';
import type { Duplex } from 'node:stream';
import { loadWindowsPipes, WindowsPipeServer, WindowsPipeStream } from '../platform/windows-pipe.js';
import { nanoid } from 'nanoid';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import type { ClientGateway } from './client-gateway.js';
import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';
import {
  GATEWAY_SERVER_CAPABILITIES,
  type GatewayCommand,
} from './client-protocol.js';
import type { EventJournal } from './event-journal.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import { createJsonLineParser, encodeJsonLine } from './jsonl.js';
import { clientConnectionEventStreamId } from './client-connection-event-stream.js';
import {
  parseGatewayClientMessage,
  type GatewayServerMessage,
} from './protocol.js';
import { workspaceEventStreamId } from './workspace-event-stream.js';
import { isNamedPipePath } from '../platform/local-endpoint.js';
import { MAX_CONNECTION_OBSERVATIONS, type ConversationObservationService, type ConversationObservationHandle } from './conversation-observation.js';

interface GatewayServerDeps {
  socketPath: string;
  windowsPipeModulePath?: string;
  /** Authorizes one OS-owner lifecycle request; returned action runs after acknowledgement flush. */
  prepareServerStop?(input: { nonce: string; pid: number; startedAt: string }): () => void;
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
  publishWorkspaceSnapshot?(workspaceId: string, connectionId: string): Promise<void>;
  closeConnection?(connectionId: string): void;
  registerWebLaunch?(
    input: { workspaceHint: string; conversationId?: string },
  ): Promise<{ token: string; expiresAt: string }>;
  registerDesktopSession?(nonce: string, accountId: string): DesktopSessionGrant;
  accountId?: string;
  observation?: ConversationObservationService;
}

interface LocalGatewayListener {
  listen(path: string, callback: () => void): unknown;
  close(callback: (error?: Error) => void): unknown;
  once(event: 'error', callback: (error: Error) => void): unknown;
  off(event: 'error', callback: (error: Error) => void): unknown;
}

export class MetaclawGatewayServer {
  private server: LocalGatewayListener | null = null;
  private readonly sockets = new Set<Duplex>();
  private readonly connectionOwners = new Map<string, Duplex>();
  private stopping = false;

  constructor(private readonly deps: GatewayServerDeps) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.stopping = false;
    if (!isNamedPipePath(this.deps.socketPath) && existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
    const connected = (socket: Duplex) => {
      if (this.stopping) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      this.handleConnection(socket);
    };
    if (this.deps.windowsPipeModulePath) {
      if (!isNamedPipePath(this.deps.socketPath)) throw new Error('Windows Gateway requires a named pipe');
      const server = new WindowsPipeServer(loadWindowsPipes(this.deps.windowsPipeModulePath));
      server.on('connection', connected);
      this.server = server;
    } else this.server = createServer(connected);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.deps.socketPath, () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    if (!isNamedPipePath(this.deps.socketPath)) chmodSync(this.deps.socketPath, 0o600);
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
    this.connectionOwners.clear();
    if (!isNamedPipePath(this.deps.socketPath) && existsSync(this.deps.socketPath)) {
      unlinkSync(this.deps.socketPath);
    }
  }

  private handleConnection(socket: Duplex): void {
    const accountId = this.deps.accountId ?? LOCAL_DEFAULT_ACCOUNT_ID;
    // Node net named pipes do not establish the Desktop OS-user principal.
    // Only the native adapter supplies OS-verified same-user connections.
    const registerDesktopSession = isNamedPipePath(this.deps.socketPath) && !(socket instanceof WindowsPipeStream)
      ? undefined : this.deps.registerDesktopSession;
    const socketConnectionId = `connection_${nanoid(10)}`;
    let conversationId: string | null = null;
    let unsubscribe: (() => void) | null = null;
    let workspaceUnsubscribe: (() => void) | null = null;
    let activeWorkspaceId: string | null = null;
    let latestAttachRequest = 0;
    let latestWorkspaceRequest = 0;
    let activeAttachment: { readonly token: object; detachClient(): void } | null = null;
    let boundConnectionId: string | null = null;
    let connectionUnsubscribe: (() => void) | null = null;
    const observations = new Map<string, { token: object; handle?: ConversationObservationHandle }>();

    const send = (message: GatewayServerMessage) => {
      if (!socket.destroyed) socket.write(encodeJsonLine(message));
    };
    const bindClientConnection = (
      connectionId: string,
    ): 'connection_id_in_use' | 'connection_id_locked' | null => {
      if (boundConnectionId) {
        return boundConnectionId === connectionId ? null : 'connection_id_locked';
      }
      const owner = this.connectionOwners.get(connectionId);
      if (owner && owner !== socket && !owner.destroyed) return 'connection_id_in_use';
      if (owner?.destroyed) this.connectionOwners.delete(connectionId);
      boundConnectionId = connectionId;
      this.connectionOwners.set(connectionId, socket);
      connectionUnsubscribe = this.deps.subscriptions.subscribe({
        accountId,
        conversationId: clientConnectionEventStreamId(connectionId),
        listener: event => this.sendEvent(send, event),
      });
      return null;
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
        replay = this.deps.journal.snapshot
          ? await this.deps.journal.snapshot(accountId, channelId)
          : await this.deps.journal.replay(accountId, channelId, 0);
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
      acceptCursorReset = false,
    ) => {
      const request = latestAttachRequest += 1;
      if (authorize && !await this.deps.authorizeAttach(accountId, nextConversationId)) {
        if (request === latestAttachRequest) {
          throw new Error('conversation attach denied');
        }
        return;
      }
      if (request !== latestAttachRequest) return;

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
        await this.deps.publishWorkspaceSnapshot?.(workspaceId, connectionId);
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
        liveConnectionId: connectionId,
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
        replay = resumeFromSequence === 0 && this.deps.journal.snapshot
          ? await this.deps.journal.snapshot(accountId, nextConversationId)
          : this.deps.journal.resume
            ? await this.deps.journal.resume(accountId, nextConversationId, resumeFromSequence)
            : await this.deps.journal.replay(accountId, nextConversationId, resumeFromSequence);
        if (replay.cursorReset && !acceptCursorReset) throw new Error('gateway_cursor_reset_required');
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

      if (replay.cursorReset) {
        send({
          type: 'replay_reset', conversationId: nextConversationId, lastSequence: replay.lastSequence,
          reason: replay.cursorReset.reason, snapshotVersion: 1,
        });
      }
      for (const event of orderedUniqueReplayEvents(replay)) sendAttachedEvent(event);
      replaying = false;
      for (const event of orderedUniqueEvents(buffered)) {
        if (event.sequence > replay.lastSequence) sendAttachedEvent(event);
      }
      send({
        type: 'hello',
        sessionId: nextConversationId,
        attached: true,
        capabilities: [...GATEWAY_SERVER_CAPABILITIES, ...(registerDesktopSession ? [DESKTOP_SESSION_CAPABILITY] : [])],
        lastSequence: replay.lastSequence,
      });
    };

    send({
      type: 'hello',
      sessionId: socketConnectionId,
      identity: this.deps.observation?.identity,
      attached: false,
      capabilities: [...GATEWAY_SERVER_CAPABILITIES, ...(registerDesktopSession ? [DESKTOP_SESSION_CAPABILITY] : [])],
    });
    const cleanup = () => {
      for (const observation of observations.values()) observation.handle?.close();
      observations.clear();
      latestAttachRequest += 1;
      activeAttachment?.detachClient();
      activeAttachment = null;
      unsubscribe?.();
      unsubscribe = null;
      workspaceUnsubscribe?.();
      workspaceUnsubscribe = null;
      connectionUnsubscribe?.();
      connectionUnsubscribe = null;
      if (boundConnectionId) {
        if (this.connectionOwners.get(boundConnectionId) === socket) {
          this.connectionOwners.delete(boundConnectionId);
          this.deps.closeConnection?.(boundConnectionId);
        }
        boundConnectionId = null;
      }
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
      if (message.type === 'unobserve') {
        observations.get(message.observationId)?.handle?.close();
        observations.delete(message.observationId);
        return;
      }
      if (message.type === 'observe') {
        const connectionError = bindClientConnection(message.connectionId);
        if (connectionError || !this.deps.observation) {
          send({ type: 'error', message: connectionError ?? 'observation_unavailable' }); return;
        }
        if (!observations.has(message.observationId) && observations.size >= MAX_CONNECTION_OBSERVATIONS) {
          send({ type: 'error', message: 'observation_limit' }); return;
        }
        observations.get(message.observationId)?.handle?.close();
        const entry: { token: object; handle?: ConversationObservationHandle } = { token: {} };
        observations.set(message.observationId, entry);
        void this.deps.observation.open({
          accountId, conversationId: message.conversationId, observationId: message.observationId, cursor: message.cursor,
          send: frame => {
            if (socket.destroyed || observations.get(message.observationId) !== entry) return false;
            if (socket.writableLength > 512 * 1024) { socket.destroy(); return false; }
            socket.write(encodeJsonLine({ type: 'observation', frame } satisfies GatewayServerMessage));
            return true;
          },
        }).then(handle => {
          if (socket.destroyed || observations.get(message.observationId) !== entry) handle.close();
          else entry.handle = handle;
        }).catch(error => {
          if (observations.get(message.observationId) !== entry) return;
          observations.delete(message.observationId);
          send({ type: 'observation', frame: { kind: 'closed', observationId: message.observationId,
            conversationId: message.conversationId, reason: (error as Error).message === 'conversation_denied'
              ? 'authorization_revoked' : 'read_unavailable' } });
        });
        return;
      }
      if (message.type === 'attach') {
        const connectionError = bindClientConnection(message.connectionId);
        if (connectionError) {
          send({ type: 'error', message: connectionError });
          return;
        }
        void attach(
          message.connectionId,
          message.conversationId,
          message.resumeFromSequence,
          true,
          message.acceptCursorReset,
        ).catch(error => {
          send({ type: 'error', message: (error as Error).message });
        });
        return;
      }
      if (message.type === 'register_desktop_session') {
        try {
          const grant = registerDesktopSession?.(message.nonce, accountId);
          if (!grant) throw new Error('Desktop session is unavailable');
          send({ type: 'desktop_session_registered', grant });
        } catch {
          send({ type: 'error', message: 'Desktop session is unavailable' });
        }
        return;
      }
      if (message.type === 'request_server_stop') {
        try {
          if (!(socket instanceof WindowsPipeStream) || !this.deps.prepareServerStop) throw new Error('unavailable');
          const stop = this.deps.prepareServerStop(message);
          socket.write(encodeJsonLine({ type: 'server_stop_accepted', nonce: message.nonce } satisfies GatewayServerMessage),
            () => stop());
        } catch { send({ type: 'error', message: 'Server lifecycle control is unavailable' }); }
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
        const connectionError = bindClientConnection(envelope.connectionId);
        if (connectionError) {
          send({
            type: 'error',
            message: connectionError,
            requestId: envelope.requestId,
          });
          return;
        }
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
      const connectionId = boundConnectionId ?? socketConnectionId;
      const connectionError = bindClientConnection(connectionId);
      if (connectionError) {
        send({ type: 'error', message: connectionError, requestId: message.requestId });
        return;
      }
      void this.deps.gateway.handle({
        protocolVersion: 2,
        requestId: message.requestId ?? `req_${nanoid(12)}`,
        idempotencyKey: message.idempotencyKey ?? `idem_${nanoid(12)}`,
        connectionId,
        scope: {
          kind: 'conversation',
          selection: { mode: 'attach', conversationId: selectedConversationId },
        },
        command,
        clientCapabilities: ['trace_v1'],
      }, 'local').then(receipt => {
        if ('kind' in receipt || receipt.status === 'rejected') {
          const rejected = 'kind' in receipt ? null : receipt;
          send({
            type: 'error',
            message: 'kind' in receipt ? receipt.message : receipt.reason ?? 'Gateway rejected input',
            requestId: message.requestId,
            ...(rejected?.code ? { code: rejected.code } : {}),
            ...(rejected?.agentId ? { agentId: rejected.agentId } : {}),
          });
        }
      }).catch(error => {
        send({
          type: 'error',
          message: (error as Error).message,
          requestId: message.requestId,
        });
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
