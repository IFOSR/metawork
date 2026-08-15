import type { ClientMessage, ExecutionTimeline, ServerMessage } from './types';

export interface WsHandlers {
  onHello?: (sessionId: string) => void;
  onOutput?: (lines: string[]) => void;
  onExecution?: (taskId: string, timeline: ExecutionTimeline) => void;
  onError?: (message: string) => void;
  onStatusChange?: (connected: boolean) => void;
}

export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private closedByUser = false;

  constructor(
    private readonly token: string,
    private readonly handlers: WsHandlers,
  ) {}

  connect(): void {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      // 首条消息鉴权；未鉴权前 Server 拒绝其他一切消息。
      socket.send(JSON.stringify({ type: 'auth', token: this.token } satisfies ClientMessage));
    };

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
          this.handlers.onOutput?.(message.lines);
          break;
        case 'execution':
          this.handlers.onExecution?.(message.taskId, message.timeline);
          break;
        case 'error':
          this.handlers.onError?.(message.message);
          break;
      }
    };

    socket.onclose = () => {
      this.handlers.onStatusChange?.(false);
      if (!this.closedByUser) {
        this.scheduleReconnect();
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
      this.socket.send(JSON.stringify({ type: 'close' } satisfies ClientMessage));
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
}
