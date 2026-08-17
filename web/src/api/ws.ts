import type {
  ClientMessage,
  ExecutionTimeline,
  InteractionTrace,
  InteractionTraceEvent,
  ServerMessage,
} from './types';

export interface WsHandlers {
  onHello?: (sessionId: string) => void;
  onOutput?: (lines: string[], from: number) => void;
  onExecution?: (taskId: string, timeline: ExecutionTimeline) => void;
  onTraceSnapshot?: (trace: InteractionTrace) => void;
  onTraceDelta?: (turnId: string, fromSequence: number, events: InteractionTraceEvent[]) => void;
  onError?: (message: string) => void;
  onUnauthorized?: () => void;
  onStatusChange?: (connected: boolean) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closedByUser = false;

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
        case 'output':
          this.handlers.onOutput?.(message.lines, message.from);
          break;
        case 'execution':
          this.handlers.onExecution?.(message.taskId, message.timeline);
          break;
        case 'trace_snapshot':
          this.handlers.onTraceSnapshot?.(message.trace);
          break;
        case 'trace_delta':
          this.handlers.onTraceDelta?.(message.turnId, message.fromSequence, message.events);
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
        void this.reconnectIfAuthorized();
      }
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  sendInput(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: 'input', text } satisfies ClientMessage));
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
