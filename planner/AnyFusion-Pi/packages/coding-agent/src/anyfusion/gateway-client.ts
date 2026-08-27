/**
 * AnyFusion Gateway 客户端（ADR-0031 第 5、8 节）。
 *
 * 原生 TUI 作为 Gateway 客户端：把原始用户输入/斜杠命令提交为版本化命令，
 * 通过游标重连回放 snapshot/delta/final 事件。客户端不调用本地语义
 * AgentSession——语义工作始终由服务端 RPC 绑定到 Conversation Planner 会话。
 */

import type {
  ConversationSelection,
  GatewayCommandEnvelope,
  GatewayCommandReceipt,
  GatewayEventEnvelope,
  GatewayReplay,
} from './gateway-protocol.js';

export interface GatewayClientDeps {
	submit(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	replay(conversationId: string, afterSequence?: number): Promise<GatewayReplay>;
	createConversation?(): Promise<string>;
  subscribe(listener: (event: GatewayEventEnvelope) => void): () => void;
  onDisconnect?(listener: () => void): () => void;
  createId?(prefix: string): string;
}

let sequenceCounter = 0;

export class GatewayClient {
  private readonly deps: GatewayClientDeps;
  private lastSequence = 0;
	private readonly listeners = new Set<(event: GatewayEventEnvelope) => void>();
	private readonly disconnectListeners = new Set<() => void>();
  private readonly createId: (prefix: string) => string;
  private transportUnsubscribe: (() => void) | null = null;
  private disconnectUnsubscribe: (() => void) | null = null;
  private activeConversationId: string | null = null;
  private reconnecting: Promise<void> | null = null;
  private reconnectRequired = false;
  private reconnectFailure: Error | null = null;

	constructor(deps: GatewayClientDeps) {
    this.deps = deps;
    this.createId = deps.createId ?? (prefix => `${prefix}_${Date.now()}_${sequenceCounter += 1}`);
		this.disconnectUnsubscribe = deps.onDisconnect?.(() => {
			this.reconnectRequired = this.activeConversationId !== null;
			this.reconnectFailure = null;
			for (const listener of this.disconnectListeners) listener();
			void this.reconnect();
		}) ?? null;
	}

	onDisconnect(listener: () => void): () => void {
		this.disconnectListeners.add(listener);
		return () => this.disconnectListeners.delete(listener);
	}

  submitUserInput(
    text: string,
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'user_message', text, attachments: [] }, conversation);
  }

  submitSlashCommand(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'slash_command', text }, conversation);
  }

  initializeWorkspace(
    text: string,
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    return this.submit({
      kind: 'slash_command',
      text,
      workspaceMutation: 'initialize_if_unset',
    }, conversation);
  }

  submitPermissionResolution(
    requestId: string,
    resolution: 'approve' | 'deny',
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'permission_resolution', requestId, resolution }, conversation);
  }

  cancelTurn(turnId: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'cancel_turn', turnId }, conversation);
  }

  onEvent(listener: (event: GatewayEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    this.transportUnsubscribe ??= this.deps.subscribe(event => {
      this.lastSequence = Math.max(this.lastSequence, event.sequence);
      this.activeConversationId = event.conversationId;
      for (const item of this.listeners) item(event);
    });
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.transportUnsubscribe?.();
        this.transportUnsubscribe = null;
      }
    };
  }

	async resume(conversationId: string): Promise<GatewayReplay> {
    this.activeConversationId = conversationId;
    try {
      const replay = await this.deps.replay(conversationId, this.lastSequence);
      this.lastSequence = Math.max(this.lastSequence, replay.lastSequence);
      this.reconnectRequired = false;
      this.reconnectFailure = null;
      return replay;
	    } catch (error) {
	      this.reconnectRequired = true;
	      this.reconnectFailure = asError(error);
	      throw this.reconnectFailure;
	    }
	  }

	createConversation(): Promise<string> {
		if (!this.deps.createConversation) {
			return Promise.reject(new Error("Gateway transport cannot create a Conversation"));
	}
		return this.deps.createConversation().then((conversationId) => {
			this.activeConversationId = conversationId;
			return conversationId;
		});
	}

  get currentSequence(): number {
    return this.lastSequence;
  }

  dispose(): void {
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = null;
    this.disconnectUnsubscribe?.();
    this.disconnectUnsubscribe = null;
		this.listeners.clear();
		this.disconnectListeners.clear();
  }

  private async submit(
    command: GatewayCommandEnvelope['command'],
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    await this.awaitReconnect();
    const requestId = this.createId('req');
    const idempotencyKey = this.createId('idem');
    const receipt = await this.deps.submit({
      protocolVersion: 1,
      requestId,
      idempotencyKey,
      connectionId: 'tui',
      conversation,
      command,
      clientCapabilities: ['trace_v1'],
    });
    if (receipt.conversationId) this.activeConversationId = receipt.conversationId;
    return receipt;
  }

  private async awaitReconnect(): Promise<void> {
    if (this.reconnecting) {
      await this.reconnecting;
      if (this.reconnectFailure) throw this.reconnectFailure;
    }
    if (this.reconnectRequired) {
      this.reconnectFailure = null;
      await this.reconnect();
      if (this.reconnectFailure) throw this.reconnectFailure;
    }
  }

  private reconnect(): Promise<void> {
    if (!this.activeConversationId) return Promise.resolve();
    if (this.reconnecting) return this.reconnecting;
    this.reconnectFailure = null;
    const conversationId = this.activeConversationId;
    const replay = this.deps.replay(
      conversationId,
      this.lastSequence,
    ).then(result => {
      if (this.activeConversationId === conversationId) {
        this.lastSequence = Math.max(this.lastSequence, result.lastSequence);
        this.reconnectRequired = false;
        this.reconnectFailure = null;
      }
    }).catch(error => {
      this.reconnectRequired = true;
      this.reconnectFailure = asError(error);
    });
    const reconnecting = replay.finally(() => {
      if (this.reconnecting === reconnecting) this.reconnecting = null;
    });
    this.reconnecting = reconnecting;
    return this.reconnecting;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
