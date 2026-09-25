/**
 * MetaWork 唯一 TUI 控制器（统一 TUI 设计 §5、§8、§11）。
 *
 * 职责：把显式用户操作映射为 Gateway 命令，协调导航、提交、取消、权限和
 * 补全，并保持 UI 生命周期。禁止：推断自然语言含义、修改 Task、直接决定业务状态。
 *
 * 业务状态只能来自 Server 事件；本控制器额外维护纯 UI 状态
 * （提交中、待确认受理、正在请求取消、面板开关、导航进行中）。
 */

import type {
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayReplay,
	GatewayScope,
	GatewayCommand,
} from "../../anyfusion/gateway-protocol.ts";
import type {
	MetaWorkClientState,
	MetaWorkCompletionState,
	MetaWorkPermissionProjection,
	MetaWorkTurnProjection,
} from "./model.ts";
import {
	emptyMetaWorkClientState,
} from "./model.ts";
import type { MetaWorkHistoryStatus } from "./components/conversation-panel.ts";
import {
	applyGatewayReplay,
	applyCompletionResponse,
	markPendingSubmissionsUncertain,
	queueSubmission,
	reduceGatewayEvent,
	reduceReceipt,
	pushClientNotice,
	requestCompletion,
	selectConversation,
	selectTurn,
	setConnectionState,
	setDraft,
} from "./reducer.ts";
import { asRecord, normalizeCompletion, normalizeTaskView, sanitizeDisplayText } from "./protocol-adapter.ts";

/** Gateway 客户端窄端口：控制器只依赖这个契约，便于测试与依赖审计。 */
export interface MetaWorkTuiGatewayPort {
	connect?(): Promise<void>;
	onEvent(listener: (event: GatewayEventEnvelope) => void): () => void;
	onDisconnect?(listener: () => void): () => void;
	resume(conversationId: string): Promise<GatewayReplay>;
	createConversation(workspaceId: string): Promise<GatewayCommandReceipt>;
	attachConversation(conversationId: string): Promise<GatewayCommandReceipt>;
	listWorkspaceConversations(
		workspaceId: string,
		query?: string,
		cursor?: string,
	): Promise<GatewayCommandReceipt>;
	getConversationHistory(
		conversationId: string,
		cursor?: string,
		limit?: number,
	): Promise<GatewayCommandReceipt>;
	completeCommand(
		text: string,
		cursor?: number,
		conversationId?: string,
	): Promise<GatewayCommandReceipt>;
	getTaskView(
		conversationId: string,
		turnId: string,
		taskId: string,
	): Promise<GatewayCommandReceipt>;
	getQueryBill?(queryId: string): Promise<GatewayCommandReceipt>;
	getQueryBillForTurn?(turnId: string): Promise<GatewayCommandReceipt>;
	getTaskUsageSummary?(taskId: string): Promise<GatewayCommandReceipt>;
	/** 只构造不可变 envelope，不发送。 */
	buildEnvelope(
		command: GatewayCommand,
		scope: GatewayScope,
	): Promise<GatewayCommandEnvelope>;
	/** 发送已构造的 envelope。 */
	submitEnvelope(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	resubmitEnvelope(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	initializeWorkspace(text: string): Promise<GatewayCommandReceipt>;
	readonly serverCapabilities?: readonly string[];
	dispose?(): void;
}

export interface MetaWorkTuiViewState {
	readonly client: MetaWorkClientState;
	readonly conversationId: string | null;
	readonly selectedTurnId: string | null;
	readonly selectedTurn: MetaWorkTurnProjection | null;
	readonly visibleTurns: readonly MetaWorkTurnProjection[];
	readonly expanded: boolean;
	readonly historyStatus: MetaWorkHistoryStatus;
	readonly navigationPending: boolean;
	readonly submitting: boolean;
	readonly awaitingReceipt: string | null;
	readonly cancelling: boolean;
	readonly cancelResult: string | null;
	readonly operation: string | null;
	readonly permission: MetaWorkPermissionProjection | null;
	readonly capabilitiesMissing: readonly string[];
	readonly taskPanelOpen: boolean;
	readonly helpOpen: boolean;
	readonly permissionPanelOpen: boolean;
	readonly conversationSelectorOpen: boolean;
}

export interface MetaWorkTuiControllerDeps {
	readonly gateway: MetaWorkTuiGatewayPort;
	readonly conversationId?: string;
	readonly workspaceHint?: string;
	readonly onExit?: () => void;
	readonly onStateChange?: (view: MetaWorkTuiViewState) => void;
	readonly now?: () => number;
	readonly requiredCapabilities?: readonly string[];
	readonly completionDebounceMs?: number;
	readonly completionTimeoutMs?: number;
	readonly historyPageSize?: number;
	readonly createId?: (prefix: string) => string;
}

interface PendingCompletion {
	readonly version: number;
	readonly scopeKey: string;
	requestId: string | null;
	resolve: (value: MetaWorkCompletionState | null) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_COMPLETION_DEBOUNCE_MS = 150;
const DEFAULT_COMPLETION_TIMEOUT_MS = 4_000;
const DEFAULT_HISTORY_PAGE_SIZE = 50;

export class MetaWorkTuiController {
	private state: MetaWorkClientState = emptyMetaWorkClientState();
	private readonly deps: MetaWorkTuiControllerDeps;
	private eventUnsubscribe: (() => void) | null = null;
	private disconnectUnsubscribe: (() => void) | null = null;
	private completionSeq = 0;
	private pendingCompletion: PendingCompletion | null = null;
	private readonly completionBuffer = new Map<string, GatewayEventEnvelope>();
	private navigationPending = false;
	private submitting = false;
	private cancelling = false;
	private cancelResult: string | null = null;
	private cancelTurnId: string | null = null;
	private operation: string | null = null;
	private historyLoading = false;
	private historyUnavailable = false;
	private capabilitiesMissing: readonly string[] = [];
	private taskPanelOpen = false;
	private helpOpen = false;
	private permissionPanelOpen = false;
	private permissionRequestId: string | null = null;
	/** 只有曾成功连接过才把断线视为可恢复的重连。 */
	private hasBeenReady = false;
	private disposed = false;
	private conversationSelectorOpen = false;
	private taskRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private billingRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private billingRetryCount = 0;
	private readonly taskQueries = new Map<string, Promise<void>>();
	private readonly dirtyTaskQueries = new Set<string>();
	private readonly taskResponseListeners = new Set<(event: GatewayEventEnvelope) => void>();
	private permissionSubmitting = false;

	constructor(deps: MetaWorkTuiControllerDeps) {
		this.deps = deps;
	}

	getView(): MetaWorkTuiViewState {
		const conversationId = this.state.selectedConversationId;
		const conversation = conversationId ? this.state.conversations[conversationId] : undefined;
		const turns = conversation
			? conversation.turnOrder
				.map(turnId => conversation.turns[turnId])
				.filter((turn): turn is MetaWorkTurnProjection => turn !== undefined)
			: [];
		const selectedTurnId = conversationId ? this.state.ui.selectedTurnIds[conversationId] ?? null : null;
		const selectedTurn = selectedTurnId && conversation
			? conversation.turns[selectedTurnId] ?? null
			: turns.at(-1) ?? null;
		const expandedIds = conversationId ? this.expandedTurnIds() : [];
		return {
			client: this.state,
			conversationId,
			selectedTurnId: selectedTurn?.id ?? null,
			selectedTurn: selectedTurn ?? null,
			visibleTurns: turns,
			expanded: selectedTurn ? expandedIds.includes(selectedTurn.id) : false,
			historyStatus: this.historyStatus(conversation),
			navigationPending: this.navigationPending,
			submitting: this.submitting,
			awaitingReceipt: this.awaitingReceipt(),
			cancelling: this.cancelling,
			cancelResult: this.cancelResult,
			operation: this.operation,
			permission: selectedTurn?.permission ?? this.pendingPermission() ?? null,
			capabilitiesMissing: this.capabilitiesMissing,
			taskPanelOpen: this.taskPanelOpen,
			helpOpen: this.helpOpen,
			permissionPanelOpen: this.permissionPanelOpen,
			conversationSelectorOpen: this.conversationSelectorOpen,
		};
	}

	async start(): Promise<void> {
		this.eventUnsubscribe = this.deps.gateway.onEvent(event => this.handleEvent(event));
		this.disconnectUnsubscribe = this.deps.gateway.onDisconnect?.(() => this.handleDisconnect()) ?? null;
		try {
			await this.deps.gateway.connect?.();
		} catch (error) {
			// 连接失败：在界面内明确提示并 fail closed，不启动本地 Agent、不打印堆栈。
			this.state = setConnectionState(this.state, "closed");
			this.state = pushClientNotice(
				this.state,
				"error",
				`无法连接 Server：${formatClientError(error)}。请先运行 metawork server start，然后按 Ctrl+C 退出并重试。`,
			);
			this.emit();
			return;
		}
		if (this.disposed) return;
		// 必需能力缺失：明确提示升级，不恢复旧 TUI、不静默丢面板。
		const required = this.deps.requiredCapabilities ?? [];
		this.capabilitiesMissing = required.filter(
			capability => !(this.deps.gateway.serverCapabilities ?? []).includes(capability),
		);
		if (this.capabilitiesMissing.length > 0) {
			this.state = setConnectionState(this.state, "incompatible");
			this.emit();
			return;
		}
		this.hasBeenReady = true;
		this.state = setConnectionState(this.state, "ready");
		const hint = this.deps.workspaceHint?.trim();
		if (hint && !this.deps.conversationId?.trim()) {
			this.operation = "正在选择 Workspace";
			this.emit();
			const receipt = await this.deps.gateway.initializeWorkspace(`/workspace ${hint}`);
			if (this.disposed) return;
			this.operation = receipt.status === "rejected"
				? `Workspace 选择被拒绝：${receipt.reason ?? "unknown"}`
				: null;
		}
		const conversationId = this.deps.conversationId?.trim();
		if (conversationId) {
			await this.attachConversation(conversationId, false);
		} else if (this.state.activeWorkspace?.id) {
			await this.openConversationSelector();
		}
		this.emit();
	}

	stop(): void {
		this.disposed = true;
		this.cancelPendingCompletion(null);
		if (this.taskRefreshTimer) clearTimeout(this.taskRefreshTimer);
		this.taskRefreshTimer = null;
		this.clearBillingRetry();
		this.taskResponseListeners.clear();
		this.eventUnsubscribe?.();
		this.eventUnsubscribe = null;
		this.disconnectUnsubscribe?.();
		this.disconnectUnsubscribe = null;
		this.deps.gateway.dispose?.();
		this.state = setConnectionState(this.state, "closed");
		this.emit();
	}

	// -----------------------------------------------------------------------
	// 提交
	// -----------------------------------------------------------------------

	/** 提交用户输入或斜杠命令；提交瞬间固定 Account/Conversation/Workspace 目标。 */
	async submit(rawText: string): Promise<void> {
		const text = rawText.trim();
		if (!text) return;
		if (text === "/exit") {
			this.deps.onExit?.();
			return;
		}
		if (text === "/cancel") {
			await this.cancelCurrentTurn();
			return;
		}
		if (/^\/workspace(?:\s|$)/u.test(text)) {
			if (!/^\/workspace\s+\S/u.test(text)) throw new Error("workspace_required");
			const receipt = await this.deps.gateway.initializeWorkspace(text);
			if (receipt.status === "rejected") throw new Error(receipt.reason ?? "workspace_denied");
			this.state = selectConversation(this.state, null);
			this.cancelPendingCompletion(null);
			await this.openConversationSelector();
			return;
		}
		if (text === "/conversations") {
			await this.openConversationSelector();
			return;
		}
		if (/^\/conversation(?:\s|$)/u.test(text)) {
			const id = text.slice("/conversation".length).trim();
			if (id === "new") await this.createConversation();
			else if (id) await this.attachConversation(id);
			else await this.openConversationSelector();
			return;
		}
		const command: GatewayCommand = text.startsWith("/")
			? { kind: "slash_command", text }
			: { kind: "user_message", text, attachments: [] };
		const scope = this.submitScope();
		const conversationId = this.state.selectedConversationId;
		this.submitting = true;
		this.operation = "正在提交";
		this.emit();
		let conversationCreated: string | null = null;
		try {
			// 先固定不可变 envelope 再发送：断线丢 receipt 时只重放同一
			// requestId / idempotencyKey / 目标与内容，不生成新 ID。
			const envelope = await this.deps.gateway.buildEnvelope(command, scope);
			this.state = queueSubmission(this.state, envelope, this.now());
			this.emit();
			const receipt = await this.deps.gateway.submitEnvelope(envelope);
			this.state = reduceReceipt(this.state, receipt);
			if (conversationId) this.state = setDraft(this.state, conversationId, "");
			this.operation = receipt.status === "rejected"
				? `提交被拒绝：${receipt.reason ?? "unknown"}`
				: null;
			conversationCreated = receipt.conversationId;
		} catch (error) {
			// 发送失败/没有 receipt：标为受理状态待确认，不谎称"发送失败"。
			this.state = markPendingSubmissionsUncertain(this.state);
			this.operation = `受理状态待确认：${formatClientError(error)}`;
		} finally {
			this.submitting = false;
			this.emit();
		}
		try {
			if (conversationCreated && conversationCreated !== this.state.selectedConversationId) {
				await this.attachConversation(conversationCreated, false);
			} else if (conversationId) {
				await this.loadHistory(conversationId);
			}
		} finally {
			this.emit();
		}
	}

	/** 提交瞬间固定的 scope；不从随后变化的选中项重新取值。 */
	private submitScope(): GatewayScope {
		const conversationId = this.state.selectedConversationId;
		if (conversationId) {
			return { kind: "conversation", selection: { mode: "attach", conversationId } };
		}
		const workspaceId = this.state.activeWorkspace?.id;
		if (workspaceId) {
			return { kind: "conversation", selection: { mode: "new", workspaceId } };
		}
		throw new Error("workspace_required");
	}

	// -----------------------------------------------------------------------
	// 导航
	// -----------------------------------------------------------------------

	async attachConversation(conversationId: string, validateWorkspace = true): Promise<void> {
		if (validateWorkspace && !this.workspaceConversationIds().has(conversationId)) {
			throw new Error("conversation_not_in_workspace");
		}
		this.navigationPending = true;
		this.operation = "正在切换 Conversation";
		this.emit();
		const previousConversationId = this.state.selectedConversationId;
		const generation = this.state.navigationGeneration + 1;
		this.cancelPendingCompletion(null);
		this.state = selectConversation(this.state, conversationId);
		try {
			const receipt = await this.deps.gateway.attachConversation(conversationId);
			if (this.state.navigationGeneration > generation) return;
			if (receipt.status === "rejected") {
				this.state = selectConversation(this.state, previousConversationId);
				this.navigationPending = false;
				this.operation = `切换失败：${receipt.reason ?? "unknown"}`;
				this.emit();
				return;
			}
			const replay = await this.deps.gateway.resume(conversationId);
			if (this.state.navigationGeneration > generation) return;
			this.state = applyGatewayReplay(this.state, conversationId, replay);
			await this.loadHistory(conversationId);
			this.conversationSelectorOpen = false;
			this.scheduleTaskRefresh();
			this.operation = null;
		} finally {
			if (this.state.navigationGeneration <= generation) {
				this.navigationPending = false;
				this.emit();
			}
		}
	}

	async openConversationSelector(): Promise<void> {
		this.conversationSelectorOpen = true;
		this.emit();
		await this.refreshConversationDirectory();
	}

	closeConversationSelector(): void {
		this.conversationSelectorOpen = false;
		this.emit();
	}

	async refreshConversationDirectory(query?: string): Promise<void> {
		const workspaceId = this.state.activeWorkspace?.id;
		if (!workspaceId) return;
		this.operation = "正在加载 Conversation 目录";
		this.emit();
		try {
			await this.deps.gateway.listWorkspaceConversations(workspaceId, query);
		} finally {
			this.operation = null;
			this.emit();
		}
	}

	async createConversation(): Promise<void> {
		const workspaceId = this.state.activeWorkspace?.id;
		if (!workspaceId) {
			this.operation = "请先选择 Workspace";
			this.emit();
			return;
		}
		const receipt = await this.deps.gateway.createConversation(workspaceId);
		if (receipt.status === "rejected") {
			this.operation = `创建失败：${receipt.reason ?? "unknown"}`;
			this.emit();
			return;
		}
		if (receipt.conversationId) await this.attachConversation(receipt.conversationId, false);
	}

	/** 加载更早的历史页；历史不可用时保留明确缺失提示，不伪造已加载全部。 */
	async loadOlderHistory(): Promise<void> {
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		const before = this.state.conversations[conversationId]?.turnOrder ?? [];
		if (this.state.conversations[conversationId]?.historyExhausted) return;
		this.historyLoading = true;
		this.emit();
		try {
			await this.loadHistory(conversationId, true);
			const order = this.state.conversations[conversationId]?.turnOrder ?? [];
			const added = order.filter(id => !before.includes(id));
			if (added.length > 0 && this.state.selectedConversationId === conversationId) {
				this.state = selectTurn(this.state, conversationId, added.at(-1)!);
				this.scheduleTaskRefresh();
			}
		} finally {
			this.historyLoading = false;
			this.emit();
		}
	}

	private async loadHistory(conversationId: string, older = false): Promise<void> {
		const conversation = this.state.conversations[conversationId];
		if (!conversation) return;
		const pageSize = this.deps.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
		const cursor = older ? conversation.historyCursor ?? undefined : undefined;
		try {
			const receipt = await this.deps.gateway.getConversationHistory(
				conversationId,
				cursor,
				pageSize,
			);
			this.historyUnavailable = receipt.status === "rejected";
		} catch {
			// 历史不可用：保留明确缺失提示，不伪造。
			this.historyUnavailable = true;
		}
	}

	/** 选择 Turn（F7/F8）。到新进展时不会隐式改变选中项。 */
	selectAdjacentTurn(delta: -1 | 1): void {
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		const conversation = this.state.conversations[conversationId];
		if (!conversation || conversation.turnOrder.length === 0) return;
		const selected = this.state.ui.selectedTurnIds[conversationId];
		const currentIndex = selected
			? conversation.turnOrder.indexOf(selected)
			: conversation.turnOrder.length - 1;
		const nextIndex = Math.max(
			0,
			Math.min(conversation.turnOrder.length - 1, currentIndex + delta),
		);
		const turnId = conversation.turnOrder[nextIndex];
		if (!turnId) return;
		this.state = selectTurn(this.state, conversationId, turnId);
		this.scheduleTaskRefresh();
		this.emit();
	}

	selectTurnById(turnId: string): void {
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		this.state = selectTurn(this.state, conversationId, turnId);
		this.scheduleTaskRefresh();
		this.emit();
	}

	setDraft(text: string): void {
		const conversationId = this.state.selectedConversationId ?? "workspace";
		this.state = setDraft(this.state, conversationId, text);
		this.emit();
	}

	// -----------------------------------------------------------------------
	// 取消（ADR-0040）
	// -----------------------------------------------------------------------

	/** 取消必须经明确的当前 Turn 操作；不使用 /task clear all，不把 receipt 当作 Executor 已退出。 */
	async cancelCurrentTurn(): Promise<void> {
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) {
			this.operation = "当前没有可取消的 Turn";
			this.emit();
			return;
		}
		const turn = this.cancelTarget(conversationId);
		if (!turn) {
			this.operation = "当前没有进行中的 Turn";
			this.emit();
			return;
		}
		this.cancelling = true;
		this.cancelTurnId = turn.id;
		this.cancelResult = null;
		this.emit();
		try {
			const envelope = await this.deps.gateway.buildEnvelope(
				{ kind: "cancel_turn", turnId: turn.id },
				{ kind: "conversation", selection: { mode: "attach", conversationId } },
			);
			this.state = queueSubmission(this.state, envelope, this.now());
			const receipt = await this.deps.gateway.submitEnvelope(envelope);
			this.state = reduceReceipt(this.state, receipt);
			if (receipt.status === "rejected") {
				this.cancelResult = `取消请求被拒绝：${receipt.reason ?? "unknown"}`;
				this.cancelling = false;
				this.cancelTurnId = null;
			}
			// 受理成功后继续显示"正在请求取消"，直到权威 Turn 状态到达。
		} finally {
			this.emit();
		}
	}

	private cancelTarget(conversationId: string): MetaWorkTurnProjection | null {
		const conversation = this.state.conversations[conversationId];
		if (!conversation) return null;
		const selectedId = this.state.ui.selectedTurnIds[conversationId];
		const selected = selectedId ? conversation.turns[selectedId] : undefined;
		if (selected && selected.status === "running") return selected;
		const running = [...conversation.turnOrder]
			.reverse()
			.map(turnId => conversation.turns[turnId])
			.find((turn): turn is MetaWorkTurnProjection => turn?.status === "running");
		return running ?? null;
	}

	// -----------------------------------------------------------------------
	// 权限（§8.5）
	// -----------------------------------------------------------------------

	async resolvePermission(requestId: string, resolution: "approve" | "deny"): Promise<void> {
		if (this.permissionSubmitting) return;
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		const turn = this.getView().selectedTurn;
		this.permissionSubmitting = true;
		try {
			const refreshed = turn?.taskId
				? await this.refreshPermissionFacts(conversationId, turn)
				: false;
			const current = this.getView().selectedTurn?.permission;
			// 已过期/已处理/历史回放的请求不能重新生效。
			if (!refreshed || this.state.selectedConversationId !== conversationId
				|| this.getView().selectedTurnId !== turn?.id
				|| !current || current.requestId !== requestId || current.status !== "pending") {
				this.operation = "权限请求已失效 · 请刷新事实";
				this.permissionPanelOpen = false;
				return;
			}
			this.operation = resolution === "approve" ? "正在提交允许决议" : "正在提交拒绝决议";
			this.emit();
			const envelope = await this.deps.gateway.buildEnvelope(
				{ kind: "permission_resolution", requestId, resolution },
				{ kind: "conversation", selection: { mode: "attach", conversationId } },
			);
			this.state = queueSubmission(this.state, envelope, this.now());
			const receipt = await this.deps.gateway.submitEnvelope(envelope);
			this.state = reduceReceipt(this.state, receipt);
			this.permissionRequestId = null;
			this.permissionPanelOpen = false;
			this.operation = receipt.status === "rejected"
				? `权限决议被拒绝：${receipt.reason ?? "unknown"}`
				: "权限决议已受理 · 等待权威状态";
			await this.refreshPermissionFacts(conversationId, turn!);
		} finally {
			this.permissionSubmitting = false;
			this.emit();
		}
	}

	// -----------------------------------------------------------------------
	// 只读查询：补全与 Task 视图
	// -----------------------------------------------------------------------

	/**
	 * 补全：每个编辑器最多一个待应用请求；旧响应不得覆盖新草稿。
	 * provider 负责约 150 ms 去抖，控制器负责版本与 scope 匹配。
	 */
	async requestCompletion(
		text: string,
		cursor: number,
		debounceMs = this.deps.completionDebounceMs ?? DEFAULT_COMPLETION_DEBOUNCE_MS,
	): Promise<MetaWorkCompletionState | null> {
		const scopeKey = this.state.selectedConversationId ?? "workspace";
		const version = this.completionSeq + 1;
		this.completionSeq = version;
		this.cancelPendingCompletion(null);
		if (debounceMs > 0) await sleep(debounceMs);
		if (this.disposed || version !== this.completionSeq
			|| scopeKey !== (this.state.selectedConversationId ?? "workspace")) return null;
		const pending: PendingCompletion = {
			version,
			scopeKey,
			requestId: null,
			resolve: () => undefined,
			timer: null,
		};
		const promise = new Promise<MetaWorkCompletionState | null>(resolve => {
			pending.resolve = resolve;
		});
		this.pendingCompletion = pending;
		try {
			const receipt = await this.deps.gateway.completeCommand(
				text,
				cursor,
				this.state.selectedConversationId ?? undefined,
			);
			if (this.pendingCompletion !== pending) return promise;
			if (receipt.status === "rejected") {
				this.finishCompletion(pending, null);
				return null;
			}
			pending.requestId = receipt.requestId;
			this.state = requestCompletion(this.state, scopeKey, receipt.requestId, version);
			const buffered = this.completionBuffer.get(receipt.requestId);
			if (buffered) {
				this.completionBuffer.delete(receipt.requestId);
				const payload = asRecord(buffered.payload);
				const completion = payload ? normalizeCompletion(payload) : null;
				if (completion) this.state = applyCompletionResponse(this.state, completion);
				const applied = this.state.completions[scopeKey];
				this.finishCompletion(pending, applied?.inputVersion === version ? applied : null);
				this.emit();
				return this.state.completions[scopeKey] ?? null;
			}
			pending.timer = setTimeout(
				() => this.finishCompletion(pending, null),
				this.deps.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS,
			);
			return promise;
		} catch {
			this.finishCompletion(pending, null);
			return null;
		}
	}

	/** Task 视图：只读查询，不启动 Planner、不创建 Turn。 */
	async openTaskPanel(): Promise<void> {
		this.taskPanelOpen = true;
		this.emit();
		if (this.taskRefreshTimer) clearTimeout(this.taskRefreshTimer);
		this.taskRefreshTimer = null;
		await Promise.all([this.refreshSelectedTask(), this.refreshSelectedBilling()]);
	}

	async toggleTaskPanel(): Promise<void> {
		if (!this.taskPanelOpen) await this.openTaskPanel();
		else {
			this.taskPanelOpen = false;
			this.emit();
		}
	}

	private scheduleTaskRefresh(): void {
		if (this.disposed || this.taskRefreshTimer) return;
		// Replay can deliver many events before a Turn has a Task. Coalesce those
		// too; each refresh sends up to three queries against the 10/sec limit.
		this.taskRefreshTimer = setTimeout(() => {
			this.taskRefreshTimer = null;
			void Promise.all([this.refreshSelectedTask(), this.refreshSelectedBilling()]);
		}, 500);
		this.taskRefreshTimer.unref?.();
	}

	private async refreshSelectedTask(): Promise<void> {
		const { conversationId, selectedTurn: turn } = this.getView();
		if (!conversationId || !turn?.taskId || this.disposed) return;
		const key = `${conversationId}:${turn.id}:${turn.taskId}`;
		const existing = this.taskQueries.get(key);
		if (existing) {
			this.dirtyTaskQueries.add(key);
			return existing;
		}
		const query = (async () => {
			try {
				const receipt = await this.deps.gateway.getTaskView(conversationId, turn.id, turn.taskId!);
				if (receipt.status === "rejected") throw new Error(receipt.reason ?? "task_view_unavailable");
			} catch (error) {
				this.state = pushClientNotice(this.state, "error", `Task 视图不可用：${formatClientError(error)}`);
				this.emit();
			}
		})();
		this.taskQueries.set(key, query);
		try { await query; } finally {
			this.taskQueries.delete(key);
			if (this.dirtyTaskQueries.delete(key)) this.scheduleTaskRefresh();
		}
	}

	private async refreshSelectedBilling(): Promise<void> {
		this.clearBillingRetry();
		const turn = this.getView().selectedTurn;
		if (!turn || this.disposed) return;
		try {
			if (!this.deps.gateway.getQueryBillForTurn) return;
			const billReceipt = await this.deps.gateway.getQueryBillForTurn(turn.id);
			if (billReceipt.status === "rejected") return;
			if (turn.taskId && this.deps.gateway.getTaskUsageSummary) {
				await this.deps.gateway.getTaskUsageSummary(turn.taskId);
			}
			// Turn 已终态但账单仍在等待计量收束（finalize 与终态事件无顺序保证）：
			// 带退避地补拉，直到拿到最终金额或达到重试上限。
			const current = this.getView().selectedTurn;
			const bill = current?.turnBill;
			const turnSettled = current && ["completed", "failed", "cancelled"].includes(current.status);
			if (bill && turnSettled && bill.userStatus === "unconfirmed" && this.billingRetryCount < 3) {
				this.billingRetryCount += 1;
				this.billingRetryTimer = setTimeout(() => {
					this.billingRetryTimer = null;
					void this.refreshSelectedBilling();
				}, 5_000);
				this.billingRetryTimer.unref?.();
			}
		} catch {
			// Billing is read-only enrichment; an unavailable projection must not
			// hide or change the authoritative Turn state.
			}
	}

	private clearBillingRetry(): void {
		if (this.billingRetryTimer) {
			clearTimeout(this.billingRetryTimer);
			this.billingRetryTimer = null;
		}
	}

	private async refreshPermissionFacts(conversationId: string, turn: MetaWorkTurnProjection): Promise<boolean> {
		if (!turn.taskId) return false;
		const responses = new Map<string, GatewayEventEnvelope>();
		let wake: (() => void) | null = null;
		let requestId: string | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const listener = (event: GatewayEventEnvelope) => {
			const payload = asRecord(event.payload);
			const view = payload ? normalizeTaskView(payload) : null;
			if (!view || view.targetConversationId !== conversationId || view.turnId !== turn.id
				|| view.taskId !== turn.taskId) return;
			responses.set(view.requestId, event);
			if (responses.size > 32) responses.delete(responses.keys().next().value!);
			if (view.requestId === requestId) wake?.();
		};
		this.taskResponseListeners.add(listener);
		try {
			const receipt = await this.deps.gateway.getTaskView(conversationId, turn.id, turn.taskId);
			if (receipt.status === "rejected") return false;
			requestId = receipt.requestId;
			if (!responses.has(requestId)) await new Promise<void>(resolve => {
				wake = resolve;
				timer = setTimeout(resolve, 4_000);
			});
			const response = responses.get(requestId);
			const payload = response ? asRecord(response.payload) : null;
			const view = payload ? normalizeTaskView(payload) : null;
			const current = this.state.conversations[conversationId]?.turns[turn.id];
			return Boolean(view && current?.taskId === turn.taskId
				&& view.asOfSequence >= (current.lastTaskSequence ?? current.startedAtSequence)
				&& view.asOfSequence >= (this.state.conversations[conversationId]?.taskViewWatermarks[turn.id] ?? 0));
		} catch {
			return false;
		} finally {
			if (timer) clearTimeout(timer);
			this.taskResponseListeners.delete(listener);
		}
	}

	toggleHelp(): void {
		this.helpOpen = !this.helpOpen;
		this.emit();
	}

	async togglePermissionPanel(): Promise<void> {
		if (this.permissionPanelOpen) {
			this.permissionPanelOpen = false;
			this.emit();
			return;
		}
		const { conversationId, selectedTurn: turn } = this.getView();
		if (!conversationId || !turn?.taskId) return;
		this.operation = "正在刷新权限状态";
		this.emit();
		const refreshed = await this.refreshPermissionFacts(conversationId, turn);
		if (this.state.selectedConversationId !== conversationId || this.getView().selectedTurnId !== turn.id) return;
		const permission = this.getView().selectedTurn?.permission;
		this.permissionPanelOpen = refreshed && permission?.status === "pending";
		this.permissionRequestId = this.permissionPanelOpen ? permission!.requestId : null;
		this.operation = this.permissionPanelOpen ? null : "权限请求已失效或无法确认 · 请刷新事实";
		this.emit();
	}

	toggleExpanded(): void {
		const turn = this.getView().selectedTurn;
		if (!turn) return;
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		const current = this.expandedTurnIds();
		const next = current.includes(turn.id)
			? current.filter(id => id !== turn.id)
			: [...current, turn.id];
		this.expandedByConversation = {
			...this.expandedByConversation,
			[conversationId]: next,
		};
		this.emit();
	}

	// -----------------------------------------------------------------------
	// 事件与恢复
	// -----------------------------------------------------------------------

	private handleEvent(event: GatewayEventEnvelope): void {
		if (this.disposed) return;
		if (event.kind === "command_completion") {
			const payload = asRecord(event.payload);
			const completion = payload ? normalizeCompletion(payload) : null;
			const pending = this.pendingCompletion;
			const matches = Boolean(
				completion && pending?.requestId && pending.requestId === completion.requestId,
			);
			this.state = reduceGatewayEvent(this.state, event);
			if (completion) {
				if (matches && pending) {
					const applied = this.state.completions[pending.scopeKey];
					this.finishCompletion(
						pending,
						applied?.inputVersion === pending.version ? applied : null,
					);
				} else {
					this.bufferCompletion(event);
				}
			}
			this.emit();
			return;
		}
		this.state = reduceGatewayEvent(this.state, event);
		if (event.kind === "task_view_snapshot") {
			for (const listener of this.taskResponseListeners) listener(event);
			const payload = asRecord(event.payload);
			const view = payload ? normalizeTaskView(payload) : null;
			const turn = view ? this.state.conversations[view.targetConversationId]?.turns[view.turnId] : null;
			if (view && turn?.taskId === view.taskId
				&& view.asOfSequence < (turn.lastTaskSequence ?? turn.startedAtSequence)) {
				this.scheduleTaskRefresh();
			}
		} else if (["trace_delta", "execution_delta", "permission_request", "final_answer",
			"result_completed", "delivery_status", "terminal_error", "conversation_history_page"].includes(event.kind)) {
			this.scheduleTaskRefresh();
		}
		this.syncFromEvents();
		this.emit();
	}

	private syncFromEvents(): void {
		// 取消结果只在权威 Turn 状态到达后展示。
		if (this.cancelTurnId) {
			const conversationId = this.state.selectedConversationId;
			const turn = conversationId
				? this.state.conversations[conversationId]?.turns[this.cancelTurnId]
				: undefined;
			if (turn && turn.status !== "running") {
				this.cancelResult = `取消结果：${turn.status}`;
				this.cancelling = false;
				this.cancelTurnId = null;
			}
		}
		// 权限面板跟随权威事实：请求已解决/过期则关闭面板。
		const permission = this.pendingPermission();
		if (this.permissionPanelOpen && this.permissionRequestId) {
			if (!permission || permission.requestId !== this.permissionRequestId
				|| permission.status !== "pending") {
				this.permissionPanelOpen = false;
				this.permissionRequestId = null;
			}
		}
	}

	private handleDisconnect(): void {
		if (this.disposed) return;
		// 从未成功连接时断线不是"重连"，保持 closed，不谎称已连接。
		if (!this.hasBeenReady) {
			this.state = setConnectionState(this.state, "closed");
			this.emit();
			return;
		}
		this.state = setConnectionState(this.state, "reconnecting");
		// 发送后断线且没有 receipt：标为受理状态待确认，只能重放同一 envelope。
		this.state = markPendingSubmissionsUncertain(this.state);
		this.emit();
		void this.recover();
	}

	private async recover(): Promise<void> {
		if (this.disposed) return;
		try {
			await this.deps.gateway.connect?.();
		} catch (error) {
			this.state = setConnectionState(this.state, "closed");
			this.state = pushClientNotice(
				this.state,
				"error",
				`重连失败：${formatClientError(error)}。请确认 Server 正在运行。`,
			);
			this.emit();
			return;
		}
		if (this.disposed) return;
		const uncertain = Object.values(this.state.pendingSubmissions)
			.filter(submission => submission.state === "uncertain")
			.sort((left, right) => left.queuedAt - right.queuedAt);
		for (const submission of uncertain) {
			try {
				const receipt = await this.deps.gateway.resubmitEnvelope(submission.envelope);
				this.state = reduceReceipt(this.state, receipt);
			} catch {
				// 仍不确定：保留待确认状态，不谎称发送失败，不自动新建消息。
				this.emit();
				return;
			}
		}
		const conversationId = this.state.selectedConversationId;
		if (conversationId) {
			try {
				const replay = await this.deps.gateway.resume(conversationId);
				this.state = applyGatewayReplay(this.state, conversationId, replay);
			} catch {
				this.emit();
				return;
			}
		}
		this.state = setConnectionState(this.state, "ready");
		this.emit();
	}

	// -----------------------------------------------------------------------
	// 辅助
	// -----------------------------------------------------------------------

	private expandedByConversation: Record<string, string[]> = {};

	private expandedTurnIds(): string[] {
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return [];
		return this.expandedByConversation[conversationId] ?? [];
	}

	private historyStatus(
		conversation: MetaWorkClientState["conversations"][string] | undefined,
	): MetaWorkHistoryStatus {
		if (this.historyUnavailable) return "unavailable";
		if (!conversation) return "unloaded";
		if (conversation.historyTurnIds.length === 0) {
			return this.historyLoading ? "loading" : "unloaded";
		}
		if (conversation.historyExhausted) return this.historyLoading ? "loading" : "exhausted";
		return "partial";
	}

	private awaitingReceipt(): string | null {
		const pending = Object.values(this.state.pendingSubmissions)
			.find(submission => submission.state === "uncertain" || submission.state === "awaiting_receipt");
		if (!pending) return null;
		return pending.state === "uncertain"
			? `${pending.requestId}（待确认）`
			: pending.requestId;
	}

	private workspaceConversationIds(): Set<string> {
		return new Set(this.state.conversationSummaries.map(item => item.conversationId));
	}

	private pendingPermission(): MetaWorkPermissionProjection | null {
		const conversationId = this.state.selectedConversationId;
		const conversation = conversationId ? this.state.conversations[conversationId] : undefined;
		if (!conversation) return null;
		for (const turnId of [...conversation.turnOrder].reverse()) {
			const permission = conversation.turns[turnId]?.permission;
			if (permission) return permission;
		}
		return null;
	}

	private bufferCompletion(event: GatewayEventEnvelope): void {
		const payload = asRecord(event.payload);
		const completion = payload ? normalizeCompletion(payload) : null;
		if (!completion) return;
		// 有界缓冲：仅保留最近若干未匹配响应。
		this.completionBuffer.set(completion.requestId, event);
		while (this.completionBuffer.size > 32) {
			const oldest = this.completionBuffer.keys().next().value;
			if (oldest === undefined) break;
			this.completionBuffer.delete(oldest);
		}
	}

	private finishCompletion(
		pending: PendingCompletion,
		value: MetaWorkCompletionState | null,
	): void {
		if (pending.timer) clearTimeout(pending.timer);
		if (this.pendingCompletion === pending) this.pendingCompletion = null;
		pending.resolve(value);
	}

	private cancelPendingCompletion(value: MetaWorkCompletionState | null): void {
		const pending = this.pendingCompletion;
		if (!pending) return;
		this.pendingCompletion = null;
		if (pending.timer) clearTimeout(pending.timer);
		pending.resolve(value);
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private emit(): void {
		this.deps.onStateChange?.(this.getView());
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatClientError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	switch (message) {
		case "workspace_required":
			return "请先使用 /workspace /absolute/path 选择 Workspace。";
		case "conversation_not_in_workspace":
			return "该 Conversation 不在当前 Workspace，请使用 /conversations 重新选择。";
		default:
			return sanitizeDisplayText(message);
	}
}
