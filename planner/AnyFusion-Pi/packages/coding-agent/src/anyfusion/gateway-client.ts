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
  subscribe(listener: (event: GatewayEventEnvelope) => void): () => void;
  createId?(prefix: string): string;
}

let sequenceCounter = 0;

export class GatewayClient {
  private lastSequence = 0;
  private readonly listeners = new Set<(event: GatewayEventEnvelope) => void>();
  private readonly createId: (prefix: string) => string;

  constructor(private readonly deps: GatewayClientDeps) {
    this.createId = deps.createId ?? (prefix => `${prefix}_${Date.now()}_${sequenceCounter += 1}`);
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

  onEvent(listener: (event: GatewayEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    const unsubscribe = this.deps.subscribe(event => {
      this.lastSequence = Math.max(this.lastSequence, event.sequence);
      for (const item of this.listeners) item(event);
    });
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  }

  async resume(conversationId: string): Promise<GatewayReplay> {
    const replay = await this.deps.replay(conversationId, this.lastSequence);
    this.lastSequence = Math.max(this.lastSequence, replay.lastSequence);
    return replay;
  }

  get currentSequence(): number {
    return this.lastSequence;
  }

  private submit(
    command: GatewayCommandEnvelope['command'],
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    const requestId = this.createId('req');
    const idempotencyKey = this.createId('idem');
    return this.deps.submit({
      protocolVersion: 1,
      requestId,
      idempotencyKey,
      connectionId: 'tui',
      conversation,
      command,
      clientCapabilities: ['trace_v1'],
    });
  }
}
