import type {
  ClientMessage,
  ExecutionTimeline,
  InteractionTrace,
  InteractionTraceEvent,
  ServerMessage,
  ConfigurationRuntimeState,
} from './types';
import type {
  ArtifactProjection,
  ConversationWorkspaceProjection,
  ConversationTurnProjection,
  WebSessionMetadata,
} from './session-types';

export interface WsHandlers {
  onHello?: (sessionId: string | null) => void;
  onSessionCatalog?: (activeSessionId: string, sessions: WebSessionMetadata[]) => void;
  onWorkspaceDirectory?: (
    activeWorkspaceId: string,
    activeSessionId: string | null,
    sessions: WebSessionMetadata[],
  ) => void;
  onActiveSessionChanged?: (sessionId: string) => void;
  onWorkspaceChanged?: (
    sessionId: string,
    workspace: ConversationWorkspaceProjection | null,
  ) => void;
  onConversationSnapshot?: (turn: ConversationTurnProjection) => void;
  onTurnStarted?: (
    requestId: string,
    turnId: string,
    userInput: string,
    startedAt: string,
    interactionKind?: 'system_command' | 'ai_turn',
  ) => void;
  onFinalAnswer?: (
    requestId: string,
    turnId: string,
    lines: string[],
    completedAt: string,
    backgroundWorkPending?: boolean,
  ) => void;
  onTerminalError?: (
    requestId: string,
    turnId: string,
    message: string,
    completedAt: string,
  ) => void;
  onResultDeliveryAvailable?: (
    requestId: string,
    turnId: string,
    resultId: string,
    certification: 'certified' | 'uncertified',
  ) => void;
  onResultChunk?: (
    requestId: string,
    turnId: string,
    resultId: string,
    offset: number,
    chunk: string,
  ) => void;
  onResultCompleted?: (
    requestId: string,
    turnId: string,
    resultId: string,
    content: string,
    certification: 'certified' | 'uncertified',
  ) => void;
  onOutput?: (lines: string[], from: number) => void;
  onExecution?: (taskId: string, timeline: ExecutionTimeline) => void;
  onArtifacts?: (turnId: string, taskId: string, artifacts: ArtifactProjection[]) => void;
  onTraceSnapshot?: (trace: InteractionTrace) => void;
  onTraceDelta?: (
    turnId: string,
    fromSequence: number,
    events: InteractionTraceEvent[],
    status?: InteractionTraceStatus,
    completedAt?: string | null,
  ) => void;
  onConfigurationRuntimeState?: (state: ConfigurationRuntimeState) => void;
  onError?: (message: string) => void;
  onUnauthorized?: () => void;
  onStatusChange?: (connected: boolean) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private diagnosticInFlight = false;

  constructor(private readonly handlers: WsHandlers) {}

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {};

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'hello':
          this.handlers.onStatusChange?.(true);
          this.handlers.onHello?.(message.sessionId);
          break;
        case 'session_catalog':
          this.handlers.onSessionCatalog?.(message.activeSessionId, message.sessions);
          break;
        case 'workspace_directory':
          this.handlers.onWorkspaceDirectory?.(
            message.activeWorkspaceId,
            message.activeSessionId,
            message.sessions,
          );
          break;
        case 'active_session_changed':
          this.handlers.onActiveSessionChanged?.(message.sessionId);
          break;
        case 'workspace_changed':
          this.handlers.onWorkspaceChanged?.(message.sessionId, message.workspace);
          break;
        case 'conversation_snapshot':
          this.handlers.onConversationSnapshot?.(message.turn);
          break;
        case 'turn_started':
          this.handlers.onTurnStarted?.(
            message.requestId,
            message.turnId,
            message.userInput,
            message.startedAt,
            message.interactionKind,
          );
          break;
        case 'final_answer':
          this.handlers.onFinalAnswer?.(
            message.requestId,
            message.turnId,
            message.lines,
            message.completedAt,
            message.backgroundWorkPending,
          );
          break;
        case 'terminal_error':
          this.handlers.onTerminalError?.(
            message.requestId,
            message.turnId,
            message.message,
            message.completedAt,
          );
          break;
        case 'result_delivery_available':
          this.handlers.onResultDeliveryAvailable?.(
            message.requestId,
            message.turnId,
            message.resultId,
            message.certification,
          );
          break;
        case 'result_chunk':
          this.handlers.onResultChunk?.(
            message.requestId,
            message.turnId,
            message.resultId,
            message.offset,
            message.chunk,
          );
          break;
        case 'result_completed':
          this.handlers.onResultCompleted?.(
            message.requestId,
            message.turnId,
            message.resultId,
            message.content,
            message.certification,
          );
          break;
        case 'output':
          this.handlers.onOutput?.(message.lines, message.from);
          break;
        case 'execution':
          this.handlers.onExecution?.(message.taskId, message.timeline);
          break;
        case 'artifacts':
          this.handlers.onArtifacts?.(message.turnId, message.taskId, message.artifacts);
          break;
        case 'trace_snapshot':
          this.handlers.onTraceSnapshot?.(message.trace);
          break;
        case 'trace_delta':
          this.handlers.onTraceDelta?.(
            message.turnId,
            message.fromSequence,
            message.events,
            message.status,
            message.completedAt,
          );
          break;
        case 'configuration_runtime_state':
          this.handlers.onConfigurationRuntimeState?.(message.state);
          break;
        case 'error':
          if (message.message === 'unauthorized') {
            this.rejectAuthentication();
            break;
          }
          this.handlers.onError?.(message.message);
          break;
      }
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.handlers.onStatusChange?.(false);
      if (!this.closedByUser) {
        void this.reportConnectionFailure().then(() => this.reconnectIfAuthorized());
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  sendInput(text: string, attachments?: Array<{ attachmentId: string }>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: 'input', text, attachments } satisfies ClientMessage));
    return true;
  }

  close(): void {
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

  private async reconnectIfAuthorized(): Promise<void> {
    if (this.closedByUser) return;
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
      });
      if (response.status === 401) {
        this.closedByUser = true;
        this.handlers.onUnauthorized?.();
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
        this.closedByUser = true;
        this.handlers.onUnauthorized?.();
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
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.handlers.onUnauthorized?.();
    this.socket?.close();
  }
}
