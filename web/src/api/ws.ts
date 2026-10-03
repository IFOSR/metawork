import type {
  ClientMessage,
  ServerMessage,
  ConfigurationRuntimeState,
  AgentReadiness,
} from './types';
import type {
  ConversationWorkspaceProjection,
  WebSessionMetadata,
} from './session-types';
import { ConversationEntityStore } from '../observation/conversation-store';
import { ObservationManager } from '../observation/observation-manager';
import type { ConversationObservationFrame } from '../../../src/gateway/conversation-observation-contract';

export type ConversationCommand =
  | { kind: 'user_message'; text: string; attachments: Array<{ attachmentId: string; kind: string }> }
  | { kind: 'slash_command'; text: string }
  | { kind: 'cancel_turn'; turnId: string }
  | { kind: 'cancel_task'; taskId: string; expectedExecutionGeneration: string }
  | { kind: 'get_pending_interactions'; conversationId: string }
  | { kind: 'get_task_view'; conversationId: string; turnId: string; taskId: string }
  | { kind: 'get_query_bill_for_turn'; turnId: string }
  | { kind: 'get_query_bill'; queryId: string }
  | { kind: 'permission_resolution_v2'; requestId: string; requestRevision: string;
      expectedExecutionGeneration: string; resolution: 'approve' | 'deny' };

export interface WsHandlers {
  onCommandResult?: (result: { targetConversationId: string; status: string; reason?: string }) => void;
  onReceipt?: (receipt: { requestId: string; status: string; conversationId?: string | null }) => void;
  onHello?: (sessionId: string | null) => void;
  onAgentReadinessState?: (agents: AgentReadiness[]) => void;
  onSessionCatalog?: (activeSessionId: string, sessions: WebSessionMetadata[], nextCursor?: string | null) => void;
  onWorkspaceConversationChanged?: (
    event: Extract<ServerMessage, { type: 'workspace_conversation_changed' }>,
  ) => void;
  onWorkspaceDirectory?: (
    activeWorkspaceId: string,
    activeSessionId: string | null,
    sessions: WebSessionMetadata[],
    nextCursor?: string | null,
  ) => void;
  onActiveSessionChanged?: (sessionId: string) => void;
  onWorkspaceChanged?: (
    sessionId: string,
    workspace: ConversationWorkspaceProjection | null,
  ) => void;
  onOutput?: (lines: string[], from: number) => void;
  onConfigurationRuntimeState?: (state: ConfigurationRuntimeState) => void;
  onError?: (message: string, detail?: {
    requestId?: string;
    code?: string;
    agentId?: string;
    admissionRejected?: boolean;
  }) => void;
  onUnauthorized?: () => void;
  onStatusChange?: (connected: boolean) => void;
}

export class WsClient {
  readonly conversations = new ConversationEntityStore();
  readonly observations = new ObservationManager(this.conversations, message => this.sendMessage(message));
  private readonly queries = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
  private readonly controls = new Map<string, { accepted(): void; resolve(value: { status: string; reason?: string }): void;
    reject(error: Error): void; timer: number }>();
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private diagnosticInFlight = false;
  private identity: string | null = null;
  private readonly unconfirmedInputs = new Map<string, string>();
  private inputRetryTimer: number | null = null;

  constructor(private readonly handlers: WsHandlers) {
    this.conversations.onRevoked(conversationId => {
      for (const [id, serialized] of this.unconfirmedInputs) {
        const message = JSON.parse(serialized);
        if (message.envelope.scope.selection.conversationId === conversationId) this.unconfirmedInputs.delete(id);
      }
    });
  }

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {};

    socket.onmessage = (event) => {
      if (this.socket !== socket || this.closedByUser) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      if ((message as { type: string }).type === 'gateway_reply') {
        const { event } = message as unknown as { event: { requestId: string; kind: string; payload: unknown } };
        if (event.kind === 'command_result') {
          const control = this.controls.get(event.requestId);
          if (control) {
            window.clearTimeout(control.timer); this.controls.delete(event.requestId);
            control.resolve(event.payload as { status: string; reason?: string });
          }
          this.handlers.onCommandResult?.(event.payload as { targetConversationId: string; status: string; reason?: string });
          return;
        }
        const query = this.queries.get(event.requestId);
        if (query) { window.clearTimeout(query.timer); this.queries.delete(event.requestId); query.resolve(event.payload); }
        return;
      }
      if ((message as { type: string }).type === 'receipt') {
        const { receipt } = message as unknown as { receipt: { requestId: string; status?: string; reason?: string; message?: string; code?: string } };
        this.unconfirmedInputs.delete(receipt.requestId);
        if (receipt.status === 'accepted' || receipt.status === 'duplicate') {
          this.controls.get(receipt.requestId)?.accepted();
          this.handlers.onReceipt?.({ ...receipt, status: receipt.status });
        }
        else {
          const control = this.controls.get(receipt.requestId);
          if (control) {
            window.clearTimeout(control.timer); this.controls.delete(receipt.requestId);
            control.reject(new Error(receipt.reason ?? receipt.message ?? 'command_rejected'));
          }
          const query = this.queries.get(receipt.requestId);
          if (query) { window.clearTimeout(query.timer); this.queries.delete(receipt.requestId); query.reject(new Error(receipt.reason ?? receipt.message ?? 'query_rejected')); }
          else this.handlers.onError?.(receipt.reason ?? receipt.message ?? '命令未被接受', { requestId: receipt.requestId, code: receipt.code, admissionRejected: true });
        }
        return;
      }
      if ((message as { type: string }).type === 'observation') {
        void this.observations.consume((message as unknown as { frame: ConversationObservationFrame }).frame);
        return;
      }
      switch (message.type) {
        case 'hello':
          if (!['conversation_observation_v1', 'conversation_resources_v1', 'multi_client_control_v1']
            .every(capability => message.capabilities?.includes(capability))) {
            this.handlers.onError?.('客户端与 Server 版本不匹配，请同步升级后重新打开。', { code: 'capability_mismatch' });
            this.close(); return;
          }
          if (!message.identity || typeof message.identity.serverId !== 'string' || !message.identity.serverId
            || typeof message.identity.accountId !== 'string' || !message.identity.accountId) {
            this.handlers.onError?.('Server 未提供账户身份，请同步升级后重新打开。', { code: 'server_identity_missing' });
            this.close(); return;
          }
          {
            const identity = JSON.stringify([message.identity.serverId, message.identity.accountId]);
            if (this.identity !== null && this.identity !== identity) {
              this.close();
              this.handlers.onUnauthorized?.(); return;
            }
            this.identity = identity;
          }
          this.observations.connection(true);
          this.handlers.onStatusChange?.(true);
          this.handlers.onHello?.(message.sessionId);
          this.retryUnconfirmedInputs();
          break;
        case 'agent_readiness_state':
          this.handlers.onAgentReadinessState?.(message.agents);
          break;
        case 'session_catalog':
          this.handlers.onSessionCatalog?.(message.activeSessionId, message.sessions, message.nextCursor);
          break;
        case 'workspace_directory':
          this.handlers.onWorkspaceDirectory?.(
            message.activeWorkspaceId,
            message.activeSessionId,
            message.sessions,
            message.nextCursor,
          );
          break;
        case 'workspace_conversation_changed':
          this.handlers.onWorkspaceConversationChanged?.(message);
          break;
        case 'active_session_changed':
          this.handlers.onActiveSessionChanged?.(message.sessionId);
          break;
        case 'workspace_changed':
          this.handlers.onWorkspaceChanged?.(message.sessionId, message.workspace);
          break;
        case 'output':
          this.handlers.onOutput?.(message.lines, message.from);
          break;
        case 'configuration_runtime_state':
          this.handlers.onConfigurationRuntimeState?.(message.state);
          break;
        case 'error':
          if (message.message === 'unauthorized') {
            this.rejectAuthentication();
            break;
          }
          if (message.requestId || message.code || message.agentId) {
            this.handlers.onError?.(message.message, {
              ...(message.requestId ? { requestId: message.requestId } : {}),
              ...(message.code ? { code: message.code } : {}),
              ...(message.agentId ? { agentId: message.agentId } : {}),
            });
          } else {
            this.handlers.onError?.(message.message);
          }
          break;
      }
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.clearInputRetry();
      this.cancelQueries();
      if (this.socket === socket) this.socket = null;
      this.handlers.onStatusChange?.(false);
      this.observations.connection(false);
      if (!this.closedByUser) {
        void this.reportConnectionFailure().then(() => this.reconnectIfAuthorized());
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  close(): void {
    this.clearInputRetry();
    this.unconfirmedInputs.clear();
    this.cancelQueries();
    this.observations.close();
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'close' } satisfies ClientMessage));
      }
      this.socket.close();
      this.socket = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1500);
  }

  query<T>(conversationId: string, command: Extract<ConversationCommand, { kind: 'get_task_view' | 'get_query_bill_for_turn' | 'get_query_bill' }>): Promise<T> {
    if (this.queries.size >= 16) return Promise.reject(new Error('query_limit'));
    const id = `query_${crypto.randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.queries.delete(id); reject(new Error('query_timeout')); }, 15_000);
      this.queries.set(id, { resolve: value => resolve(value as T), reject, timer });
      if (!this.sendCommand(conversationId, command, id)) {
        window.clearTimeout(timer); this.queries.delete(id); reject(new Error('disconnected'));
      }
    });
  }

  private cancelQueries(): void {
    for (const query of this.queries.values()) { window.clearTimeout(query.timer); query.reject(new Error('disconnected')); }
    this.queries.clear();
    for (const control of this.controls.values()) { window.clearTimeout(control.timer); control.reject(new Error('command_status_unknown')); }
    this.controls.clear();
  }

  control(conversationId: string,
    command: Extract<ConversationCommand, { kind: 'cancel_task' | 'permission_resolution_v2' }>,
    accepted: () => void): Promise<{ status: string; reason?: string }> {
    if (this.controls.size >= 16) return Promise.reject(new Error('command_limit'));
    const requestId = `control_${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.controls.delete(requestId); reject(new Error('command_status_unknown'));
      }, 15_000);
      this.controls.set(requestId, { accepted, resolve, reject, timer });
      if (!this.sendCommand(conversationId, command, requestId)) {
        window.clearTimeout(timer); this.controls.delete(requestId); reject(new Error('disconnected'));
      }
    });
  }

  sendCommand(conversationId: string, command: ConversationCommand, requestId = `req_${crypto.randomUUID()}`): string | null {
    const input = command.kind === 'user_message' || command.kind === 'slash_command';
    if (input && this.unconfirmedInputs.size >= 64) return null;
    const message = { type: 'command', envelope: {
      protocolVersion: 2, requestId, idempotencyKey: requestId, connectionId: 'web',
      scope: { kind: 'conversation', selection: { mode: 'attach', conversationId } },
      command, clientCapabilities: ['conversation_observation_v1'],
    } };
    if (!this.sendMessage(message)) return null;
    if (input) {
      // Freeze the original target, payload and idempotency key. Retrying this
      // envelope asks the durable admission ledger for the same submission.
      this.unconfirmedInputs.set(requestId, JSON.stringify(message));
      this.scheduleInputRetry();
    }
    return requestId;
  }

  private clearInputRetry(): void {
    if (this.inputRetryTimer !== null) window.clearTimeout(this.inputRetryTimer);
    this.inputRetryTimer = null;
  }

  private scheduleInputRetry(): void {
    if (!this.unconfirmedInputs.size || this.inputRetryTimer !== null || this.closedByUser) return;
    this.inputRetryTimer = window.setTimeout(() => {
      this.inputRetryTimer = null;
      this.retryUnconfirmedInputs();
    }, 15_000);
  }

  private retryUnconfirmedInputs(): void {
    if (this.closedByUser || this.identity === null || this.socket?.readyState !== WebSocket.OPEN) return;
    for (const serialized of this.unconfirmedInputs.values()) this.socket.send(serialized);
    this.scheduleInputRetry();
  }

  private sendMessage(message: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }

  private async reconnectIfAuthorized(): Promise<void> {
    if (this.closedByUser) return;
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
      });
      if (response.status === 401) {
        this.rejectAuthentication();
        return;
      }
    } catch {
      // A stopped/restarting local server is retryable; only an explicit 401 logs out.
    }
    this.scheduleReconnect();
  }

  private async reportConnectionFailure(): Promise<void> {
    if (this.diagnosticInFlight) return;
    this.diagnosticInFlight = true;
    try {
      const response = await fetch('/api/ws/diagnostics', {
        credentials: 'same-origin',
      });
      const body = await response.json().catch(() => null) as {
        message?: string;
      } | null;
      if (response.status === 401) {
        this.rejectAuthentication();
        return;
      }
      if (body?.message && !response.ok) {
        this.handlers.onError?.(body.message);
      }
    } catch {
      // A stopped/restarting local server is retryable and has no diagnostic response.
    } finally {
      this.diagnosticInFlight = false;
    }
  }

  private rejectAuthentication(): void {
    this.clearInputRetry();
    this.unconfirmedInputs.clear();
    this.observations.close();
    this.cancelQueries();
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.handlers.onUnauthorized?.();
    this.socket?.close();
  }
}
