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
  GatewayReplayReset,
  GatewayScope,
} from './gateway-protocol.js';

export interface GatewayClientDeps {
	submit(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	replay(conversationId: string, afterSequence?: number, connectionId?: string): Promise<GatewayReplay>;
	connect?(): Promise<void>;
  subscribe(listener: (event: GatewayEventEnvelope) => void): () => void;
  onDisconnect?(listener: () => void): () => void;
  onReplayReset?(listener: (reset: GatewayReplayReset) => void): () => void;
  createId?(prefix: string): string;
  /** Server hello 公布的安全能力清单（command_completion_v1 / task_view_v1 等）。 */
  getServerCapabilities?(): string[];
}

let sequenceCounter = 0;

export class GatewayClient {
  private readonly deps: GatewayClientDeps;
  private readonly streamSequences = new Map<string, number>();
  private readonly listeners = new Set<(event: GatewayEventEnvelope) => void>();
	private readonly disconnectListeners = new Set<() => void>();
  private readonly resetListeners = new Set<(reset: GatewayReplayReset) => void>();
  private readonly createId: (prefix: string) => string;
  private readonly connectionId: string;
  private transportUnsubscribe: (() => void) | null = null;
  private disconnectUnsubscribe: (() => void) | null = null;
  private resetUnsubscribe: (() => void) | null = null;
  private replayFlight: { conversationId: string; promise: Promise<GatewayReplay> } | null = null;
  private activeConversationId: string | null = null;
  private reconnecting: Promise<void> | null = null;
  private reconnectRequired = false;
  private reconnectFailure: Error | null = null;

	constructor(deps: GatewayClientDeps) {
    this.deps = deps;
    this.createId = deps.createId ?? (prefix => `${prefix}_${Date.now()}_${sequenceCounter += 1}`);
    this.connectionId = this.createId('tui');
    this.resetUnsubscribe = deps.onReplayReset?.(reset => {
      // This assignment deliberately permits a lower cursor after server recovery.
      this.streamSequences.set(reset.conversationId, reset.lastSequence);
      for (const listener of this.resetListeners) listener(reset);
    }) ?? null;
		this.disconnectUnsubscribe = deps.onDisconnect?.(() => {
			this.reconnectRequired = this.activeConversationId !== null;
			this.reconnectFailure = null;
			for (const listener of this.disconnectListeners) listener();
			void this.reconnect();
		}) ?? null;
	}

	connect(): Promise<void> {
		return this.deps.connect?.() ?? Promise.resolve();
	}

	get serverCapabilities(): string[] {
		return this.deps.getServerCapabilities?.() ?? [];
	}

	/** Server 是否公布指定能力（缺失时客户端明确提示升级，不静默降级）。 */
	hasServerCapability(capability: string): boolean {
		return this.serverCapabilities.includes(capability);
	}

	/** 客户端稳定的 connectionId（用于日志与诊断展示）。 */
	get clientConnectionId(): string {
		return this.connectionId;
	}

	onDisconnect(listener: () => void): () => void {
		this.disconnectListeners.add(listener);
		return () => this.disconnectListeners.delete(listener);
	}

  onReplayReset(listener: (reset: GatewayReplayReset) => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  submitUserInput(
    text: string,
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'user_message', text, attachments: [] },
      { kind: 'conversation', selection: conversation },
    );
  }

  submitSlashCommand(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'slash_command', text },
      { kind: 'conversation', selection: conversation },
    );
  }

  initializeWorkspace(text: string): Promise<GatewayCommandReceipt> {
    const path = text.replace(/^\/workspace\s+/u, '').trim();
    return this.submit({ kind: 'select_workspace', path }, { kind: 'workspace' });
  }

  listWorkspaceConversations(
    workspaceId: string,
    query?: string,
    cursor?: string,
    onRequest?: (requestId: string) => void,
  ): Promise<GatewayCommandReceipt> {
    return this.submit({
      kind: 'list_workspace_conversations',
      workspaceId,
      ...(cursor ? { cursor } : {}),
      ...(query ? { query } : {}),
    }, { kind: 'workspace' }, onRequest);
  }

  createConversation(workspaceId: string): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'create_conversation', workspaceId },
      { kind: 'workspace' },
    );
  }

  attachConversation(conversationId: string): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'attach_conversation', conversationId },
      {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
    );
  }

  submitPermissionResolution(
    requestId: string,
    resolution: 'approve' | 'deny',
    conversation: ConversationSelection,
  ): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'permission_resolution', requestId, resolution },
      { kind: 'conversation', selection: conversation },
    );
  }

  cancelTurn(turnId: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'cancel_turn', turnId },
      { kind: 'conversation', selection: conversation },
    );
  }

  getConversationHistory(
    conversationId: string,
    cursor?: string,
    limit?: number,
    onRequest?: (requestId: string) => void,
  ): Promise<GatewayCommandReceipt> {
    return this.submit(
      {
        kind: 'get_conversation_history',
        conversationId,
        ...(this.serverCapabilities.includes('history_page_fragments_v1') ? { acceptFragments: true } : {}),
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
      onRequest,
    );
  }

  /**
   * 受限只读命令补全（command_completion_v1）。不传 conversationId 时为
   * Workspace scope，只返回该范围合法的导航/只读候选。
   */
  completeCommand(
    text: string,
    cursor?: number,
    conversationId?: string,
  ): Promise<GatewayCommandReceipt> {
    return this.submit(
      {
        kind: 'complete_command',
        text,
        ...(cursor !== undefined ? { cursor } : {}),
      },
      conversationId
        ? {
            kind: 'conversation',
            selection: { mode: 'attach', conversationId },
          }
        : { kind: 'workspace' },
    );
  }

  /** 受限只读 Task 视图查询（task_view_v1）。 */
  getTaskView(
    conversationId: string,
    turnId: string,
    taskId: string,
  ): Promise<GatewayCommandReceipt> {
    return this.submit(
      { kind: 'get_task_view', conversationId, turnId, taskId },
      {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
    );
  }

  getQueryBill(queryId: string): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'get_query_bill', queryId }, { kind: 'workspace' });
  }

  getQueryBillForTurn(turnId: string): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'get_query_bill_for_turn', turnId }, { kind: 'workspace' });
  }

  getTaskUsageSummary(taskId: string): Promise<GatewayCommandReceipt> {
    return this.submit({ kind: 'get_task_usage_summary', taskId }, { kind: 'workspace' });
  }

  /**
   * 重放一个未确认的提交 envelope（断线丢 receipt 场景）：必须复用完全相同的
   * requestId / idempotencyKey / 目标与内容，不生成新 ID。
   */
  resubmitEnvelope(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt> {
    return this.awaitReconnect().then(() => this.deps.submit(envelope));
  }

  onEvent(listener: (event: GatewayEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    this.transportUnsubscribe ??= this.deps.subscribe(event => {
      this.streamSequences.set(
        event.conversationId,
        Math.max(this.streamSequences.get(event.conversationId) ?? 0, event.sequence),
      );
      if (this.activeConversationId === null && !isWorkspaceEvent(event.kind)) {
        this.activeConversationId = event.conversationId;
      }
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
      const replay = await this.replayConversation(conversationId);
      this.streamSequences.set(
        conversationId,
        Math.max(this.streamSequences.get(conversationId) ?? 0, replay.lastSequence),
      );
      if (this.activeConversationId === conversationId) {
        this.reconnectRequired = false;
        this.reconnectFailure = null;
      }
      return replay;
	    } catch (error) {
        const failure = asError(error);
        if (this.activeConversationId === conversationId) {
          this.reconnectRequired = true;
          this.reconnectFailure = failure;
        }
	      throw failure;
	    }
	  }

  get currentSequence(): number {
    return this.activeConversationId
      ? this.streamSequences.get(this.activeConversationId) ?? 0
      : 0;
  }

  dispose(): void {
    this.transportUnsubscribe?.();
    this.transportUnsubscribe = null;
    this.disconnectUnsubscribe?.();
    this.disconnectUnsubscribe = null;
    this.resetUnsubscribe?.();
    this.resetUnsubscribe = null;
    this.resetListeners.clear();
		this.listeners.clear();
		this.disconnectListeners.clear();
  }

  private async submit(
    command: GatewayCommandEnvelope['command'],
    scope: GatewayScope,
    onRequest?: (requestId: string) => void,
  ): Promise<GatewayCommandReceipt> {
    const envelope = await this.buildEnvelope(command, scope);
    // Query events can arrive synchronously during dispatch, before the receipt.
    onRequest?.(envelope.requestId);
    return this.submitEnvelope(envelope);
  }

  /**
   * 只构造不可变 envelope，不发送。控制器先持久化 envelope（进程内）再发送，
   * 以便发送后断线丢 receipt 时能重放同一 requestId/目标/内容。
   */
  async buildEnvelope(
    command: GatewayCommandEnvelope['command'],
    scope: GatewayScope,
  ): Promise<GatewayCommandEnvelope> {
    await this.awaitReconnect();
    return {
      protocolVersion: 2,
      requestId: this.createId('req'),
      idempotencyKey: this.createId('idem'),
      connectionId: this.connectionId,
      scope,
      command,
      clientCapabilities: ['trace_v1'],
    };
  }

  /** 发送已构造的 envelope；同一 envelope 可重复发送（幂等键保证只受理一次）。 */
  async submitEnvelope(
    envelope: GatewayCommandEnvelope,
  ): Promise<GatewayCommandReceipt> {
    const activeConversationId = this.activeConversationId;
    const receipt = await this.deps.submit(envelope);
    if (receipt.status !== 'rejected' && receipt.conversationId
      && this.activeConversationId === activeConversationId) {
      this.activeConversationId = receipt.conversationId;
    }
    return receipt;
  }

  /** 构造并提交一个 envelope，同时返回固定下来的不可变 envelope 供断线重放。 */
  async submitWithEnvelope(
    command: GatewayCommandEnvelope['command'],
    scope: GatewayScope,
  ): Promise<{ envelope: GatewayCommandEnvelope; receipt: GatewayCommandReceipt }> {
    const envelope = await this.buildEnvelope(command, scope);
    const receipt = await this.submitEnvelope(envelope);
    return { envelope, receipt };
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
    const replay = this.replayConversation(conversationId).then(result => {
      if (this.activeConversationId === conversationId) {
        this.streamSequences.set(
          conversationId,
          Math.max(this.streamSequences.get(conversationId) ?? 0, result.lastSequence),
        );
        this.reconnectRequired = false;
        this.reconnectFailure = null;
      }
    }).catch(error => {
      if (this.activeConversationId === conversationId) {
        this.reconnectRequired = true;
        this.reconnectFailure = asError(error);
      }
    });
    const reconnecting = replay.finally(() => {
      if (this.reconnecting === reconnecting) this.reconnecting = null;
    });
    this.reconnecting = reconnecting;
    return this.reconnecting;
  }

  private replayConversation(conversationId: string): Promise<GatewayReplay> {
    if (this.replayFlight?.conversationId === conversationId) return this.replayFlight.promise;
    const promise = Promise.resolve().then(() => this.deps.replay(
      conversationId, this.streamSequences.get(conversationId) ?? 0, this.connectionId,
    )).finally(() => {
      if (this.replayFlight?.promise === promise) this.replayFlight = null;
    });
    this.replayFlight = { conversationId, promise };
    return promise;
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isWorkspaceEvent(kind: GatewayEventEnvelope['kind']): boolean {
  return [
    'workspace_changed',
    'command_completion',
    'task_view_snapshot',
    'usage_billing_projection',
    'workspace_directory_snapshot',
    'workspace_conversation_upserted',
    'workspace_conversation_removed',
    'workspace_activity_changed',
    'workspace_availability_changed',
  ].includes(kind);
}
