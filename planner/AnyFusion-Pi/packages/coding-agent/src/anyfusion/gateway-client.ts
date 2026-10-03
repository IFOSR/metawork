/**
 * AnyFusion Gateway 客户端（ADR-0031 第 5、8 节）。
 *
 * 原生 TUI 作为 Gateway 客户端：把原始用户输入/斜杠命令提交为版本化命令，
 * 通过独立观察游标与有界资源读取恢复展示。客户端不调用本地语义
 * AgentSession——语义工作始终由服务端 RPC 绑定到 Conversation Planner 会话。
 */

import type { ConversationTurnPage } from "./conversation-observation-protocol.ts";
import {
	GatewayObservationClient,
	type GatewayObservationPort,
	type GatewayObservedConversation,
} from "./gateway-observation-client.ts";
import type {
	ConversationSelection,
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayScope,
} from "./gateway-protocol.ts";

export interface GatewayClientDeps extends Partial<GatewayObservationPort> {
	submit(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	connect?(): Promise<void>;
	subscribe(listener: (event: GatewayEventEnvelope) => void): () => void;
	onDisconnect?(listener: () => void): () => void;
	createId?(prefix: string): string;
	/** Server hello 公布的安全能力清单（command_completion_v1 / task_view_v1 等）。 */
	getServerCapabilities?(): string[];
	getServerIdentity?(): string | null;
}

let sequenceCounter = 0;

export class GatewayClient {
	private readonly deps: GatewayClientDeps;
	private readonly listeners = new Set<(event: GatewayEventEnvelope) => void>();
	private readonly disconnectListeners = new Set<() => void>();
	private readonly createId: (prefix: string) => string;
	private readonly connectionId: string;
	private transportUnsubscribe: (() => void) | null = null;
	private disconnectUnsubscribe: (() => void) | null = null;
	private reconnecting: Promise<void> | null = null;
	private reconnectRequired = false;
	private reconnectFailure: Error | null = null;
	private observations: GatewayObservationClient | null = null;
	private resourceQueries = 0;
	private serverIdentity: string | null = null;

	constructor(deps: GatewayClientDeps) {
		this.deps = deps;
		this.createId =
			deps.createId ??
			((prefix) => {
				sequenceCounter += 1;
				return `${prefix}_${Date.now()}_${sequenceCounter}`;
			});
		this.connectionId = this.createId("tui");
		this.disconnectUnsubscribe =
			deps.onDisconnect?.(() => {
				this.reconnectRequired = true;
				this.reconnectFailure = null;
				for (const listener of this.disconnectListeners) listener();
				void this.reconnect();
			}) ?? null;
	}

	async connect(): Promise<void> {
		await this.deps.connect?.();
		const identity = this.deps.getServerIdentity?.() ?? null;
		if (this.serverIdentity !== null && identity !== this.serverIdentity) {
			this.observations?.close();
			this.observations = null;
			throw new Error("server_identity_changed");
		}
		this.serverIdentity = identity;
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

	async followConversation(
		conversationId: string,
		listener: (view: GatewayObservedConversation) => void,
	): Promise<() => void> {
		if (!this.deps.observe || !this.deps.unobserve || !this.deps.onObservation)
			throw new Error("capability_mismatch");
		this.observations ??= new GatewayObservationClient(
			{
				observe: this.deps.observe.bind(this.deps),
				unobserve: this.deps.unobserve.bind(this.deps),
				onObservation: this.deps.onObservation.bind(this.deps),
			},
			this.connectionId,
		);
		return this.observations.follow(conversationId, listener);
	}

	applyConversationPage(
		conversationId: string,
		page: ConversationTurnPage,
		atLatest = false,
		expectedEpoch?: string,
	): void {
		this.observations?.page(conversationId, page, atLatest, expectedEpoch);
	}

	async queryConversationResource(
		command: Extract<GatewayCommandEnvelope["command"], { kind: "get_conversation_resource" }>,
	): Promise<unknown> {
		if (this.resourceQueries >= 16) throw new Error("query_limit");
		this.resourceQueries++;
		let stop = () => {};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const envelope = await this.buildEnvelope(command, {
				kind: "conversation",
				selection: { mode: "attach", conversationId: command.conversationId },
			});
			let resolve!: (value: unknown) => void;
			const reply = new Promise<unknown>((done, reject) => {
				resolve = done;
				timer = setTimeout(() => reject(new Error("query_timeout")), 15_000);
				timer.unref?.();
			});
			stop = this.onEvent((event) => {
				if (event.requestId === envelope.requestId && event.kind === "conversation_resource")
					resolve((event.payload as { page: unknown }).page);
			});
			// Attach both rejection handlers immediately: receipt loss and reply timeout are independent.
			const [receipt, page] = await Promise.all([
				this.submitEnvelope(envelope).then((value) => {
					if (value.status === "rejected") {
						resolve(null);
						throw new Error(value.reason ?? "query_rejected");
					}
					return value;
				}),
				reply,
			]);
			if (receipt.status === "rejected") throw new Error(receipt.reason);
			return page;
		} finally {
			stop();
			if (timer) clearTimeout(timer);
			this.resourceQueries--;
		}
	}

	submitUserInput(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
		return this.submit(
			{ kind: "user_message", text, attachments: [] },
			{ kind: "conversation", selection: conversation },
		);
	}

	submitSlashCommand(text: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
		return this.submit({ kind: "slash_command", text }, { kind: "conversation", selection: conversation });
	}

	initializeWorkspace(text: string): Promise<GatewayCommandReceipt> {
		const path = text.replace(/^\/workspace\s+/u, "").trim();
		return this.submit({ kind: "select_workspace", path }, { kind: "workspace" });
	}

	listWorkspaceConversations(
		workspaceId: string,
		query?: string,
		cursor?: string,
		onRequest?: (requestId: string) => void,
	): Promise<GatewayCommandReceipt> {
		return this.submit(
			{
				kind: "list_workspace_conversations",
				workspaceId,
				...(cursor ? { cursor } : {}),
				...(query ? { query } : {}),
			},
			{ kind: "workspace" },
			onRequest,
		);
	}

	createConversation(workspaceId: string): Promise<GatewayCommandReceipt> {
		return this.submit({ kind: "create_conversation", workspaceId }, { kind: "workspace" });
	}

	cancelTurn(turnId: string, conversation: ConversationSelection): Promise<GatewayCommandReceipt> {
		return this.submit({ kind: "cancel_turn", turnId }, { kind: "conversation", selection: conversation });
	}

	/**
	 * 受限只读命令补全（command_completion_v1）。不传 conversationId 时为
	 * Workspace scope，只返回该范围合法的导航/只读候选。
	 */
	completeCommand(text: string, cursor?: number, conversationId?: string): Promise<GatewayCommandReceipt> {
		return this.submit(
			{
				kind: "complete_command",
				text,
				...(cursor !== undefined ? { cursor } : {}),
			},
			conversationId
				? {
						kind: "conversation",
						selection: { mode: "attach", conversationId },
					}
				: { kind: "workspace" },
		);
	}

	/** 受限只读 Task 视图查询（task_view_v1）。 */
	getTaskView(conversationId: string, turnId: string, taskId: string): Promise<GatewayCommandReceipt> {
		return this.submit(
			{ kind: "get_task_view", conversationId, turnId, taskId },
			{
				kind: "conversation",
				selection: { mode: "attach", conversationId },
			},
		);
	}

	getQueryBill(queryId: string): Promise<GatewayCommandReceipt> {
		return this.submit({ kind: "get_query_bill", queryId }, { kind: "workspace" });
	}

	getQueryBillForTurn(turnId: string): Promise<GatewayCommandReceipt> {
		return this.submit({ kind: "get_query_bill_for_turn", turnId }, { kind: "workspace" });
	}

	getTaskUsageSummary(taskId: string): Promise<GatewayCommandReceipt> {
		return this.submit({ kind: "get_task_usage_summary", taskId }, { kind: "workspace" });
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
		this.transportUnsubscribe ??= this.deps.subscribe((event) => {
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

	dispose(): void {
		this.observations?.close();
		this.observations = null;
		this.transportUnsubscribe?.();
		this.transportUnsubscribe = null;
		this.disconnectUnsubscribe?.();
		this.disconnectUnsubscribe = null;
		this.listeners.clear();
		this.disconnectListeners.clear();
	}

	private async submit(
		command: GatewayCommandEnvelope["command"],
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
		command: GatewayCommandEnvelope["command"],
		scope: GatewayScope,
	): Promise<GatewayCommandEnvelope> {
		await this.awaitReconnect();
		return {
			protocolVersion: 2,
			requestId: this.createId("req"),
			idempotencyKey: this.createId("idem"),
			connectionId: this.connectionId,
			scope,
			command,
			clientCapabilities: ["trace_v1"],
		};
	}

	/** 发送已构造的 envelope；同一 envelope 可重复发送（幂等键保证只受理一次）。 */
	async submitEnvelope(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt> {
		await this.awaitReconnect();
		return this.deps.submit(envelope);
	}

	/** 构造并提交一个 envelope，同时返回固定下来的不可变 envelope 供断线重放。 */
	async submitWithEnvelope(
		command: GatewayCommandEnvelope["command"],
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
		if (this.reconnecting) return this.reconnecting;
		this.reconnectFailure = null;
		const reconnecting = this.connect()
			.then(() => {
				this.reconnectRequired = false;
			})
			.catch((error) => {
				this.reconnectRequired = true;
				this.reconnectFailure = asError(error);
			})
			.finally(() => {
				if (this.reconnecting === reconnecting) this.reconnecting = null;
			});
		this.reconnecting = reconnecting;
		return reconnecting;
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
