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
	ConversationActivityView,
	ConversationTurnPage,
} from "../../anyfusion/conversation-observation-protocol.ts";
import type { GatewayObservedConversation } from "../../anyfusion/gateway-observation-client.ts";
import type {
	GatewayCommand,
	GatewayCommandEnvelope,
	GatewayCommandReceipt,
	GatewayEventEnvelope,
	GatewayScope,
} from "../../anyfusion/gateway-protocol.ts";
import type { MetaWorkHistoryStatus } from "./components/conversation-panel.ts";
import type {
	MetaWorkClientState,
	MetaWorkCompletionState,
	MetaWorkPermissionProjection,
	MetaWorkTurnProjection,
} from "./model.ts";
import { emptyMetaWorkClientState } from "./model.ts";
import { applyObservedConversation } from "./observation-projection.ts";
import { asRecord, normalizeCompletion, normalizeTaskView, sanitizeDisplayText } from "./protocol-adapter.ts";
import {
	applyCompletionResponse,
	markPendingSubmissionsUncertain,
	pushClientNotice,
	queueSubmission,
	reduceGatewayEvent,
	reduceReceipt,
	requestCompletion,
	selectConversation,
	selectTurn,
	setConnectionState,
	setDraft,
} from "./reducer.ts";
import { type TaskOverviewRow, type TaskOverviewState, WorkspaceTaskOverview } from "./task-overview.ts";

/** Gateway 客户端窄端口：控制器只依赖这个契约，便于测试与依赖审计。 */
export interface MetaWorkTuiGatewayPort {
	followConversation(id: string, listener: (view: GatewayObservedConversation) => void): Promise<() => void>;
	applyConversationPage(id: string, page: ConversationTurnPage, atLatest?: boolean, expectedEpoch?: string): void;
	queryConversationResource(command: Extract<GatewayCommand, { kind: "get_conversation_resource" }>): Promise<unknown>;
	connect?(): Promise<void>;
	onEvent(listener: (event: GatewayEventEnvelope) => void): () => void;
	onDisconnect?(listener: () => void): () => void;
	createConversation(workspaceId: string): Promise<GatewayCommandReceipt>;
	listWorkspaceConversations(
		workspaceId: string,
		query?: string,
		cursor?: string,
		onRequest?: (requestId: string) => void,
	): Promise<GatewayCommandReceipt>;
	completeCommand(text: string, cursor?: number, conversationId?: string): Promise<GatewayCommandReceipt>;
	getTaskView(conversationId: string, turnId: string, taskId: string): Promise<GatewayCommandReceipt>;
	getQueryBill?(queryId: string): Promise<GatewayCommandReceipt>;
	getQueryBillForTurn?(turnId: string): Promise<GatewayCommandReceipt>;
	getTaskUsageSummary?(taskId: string): Promise<GatewayCommandReceipt>;
	/** 只构造不可变 envelope，不发送。 */
	buildEnvelope(command: GatewayCommand, scope: GatewayScope): Promise<GatewayCommandEnvelope>;
	/** 发送已构造的 envelope。 */
	submitEnvelope(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	resubmitEnvelope(envelope: GatewayCommandEnvelope): Promise<GatewayCommandReceipt>;
	initializeWorkspace(text: string): Promise<GatewayCommandReceipt>;
	readonly serverCapabilities?: readonly string[];
	dispose?(): void;
}

export interface MetaWorkTuiViewState {
	readonly taskOverview: TaskOverviewState;
	readonly reader?: { readonly id: number; readonly title: string; readonly text: string } | null;
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

interface DirectoryRequest {
	readonly version: number;
	readonly workspaceId: string;
	readonly query: string;
	readonly cursor: string | null;
	requestId: string | null;
}

const DEFAULT_COMPLETION_DEBOUNCE_MS = 150;
const DEFAULT_COMPLETION_TIMEOUT_MS = 4_000;

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
	private historyGeneration = 0;
	private directoryLoading = false;
	private directoryRequest = 0;
	private directoryResponse: DirectoryRequest | null = null;
	private historyUnavailable = false;
	private capabilitiesMissing: readonly string[] = [];
	private taskPanelOpen = false;
	private readonly taskOverview: WorkspaceTaskOverview;
	private directoryPollTimer: ReturnType<typeof setTimeout> | null = null;
	private helpOpen = false;
	private permissionPanelOpen = false;
	private permissionRequestId: string | null = null;
	/** 只有曾成功连接过才把断线视为可恢复的重连。 */
	private hasBeenReady = false;
	private recoveryGeneration = 0;
	private readonly reconnectNotices = new WeakSet<MetaWorkClientState["notices"][number]>();
	private disposed = false;
	private conversationSelectorOpen = false;
	private taskRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private billingRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private billingRetryCount = 0;
	private readonly taskQueries = new Map<string, Promise<void>>();
	private readonly dirtyTaskQueries = new Set<string>();
	private permissionSubmitting = false;
	private observationRelease: (() => void) | null = null;
	private readonly observedActivity = new Map<string, ConversationActivityView>();
	private readonly observedEpochs = new Map<string, string>();
	private readonly reviewedPermissionDetails = new Set<string>();
	private readonly reviewedRanges = new Map<string, number>();
	private reader: { id: number; title: string; text: string } | null = null;
	private readerSequence = 0;
	private taskNavigation = 0;
	private overviewWorkspaceId: string | null = null;

	constructor(deps: MetaWorkTuiControllerDeps) {
		this.deps = deps;
		this.taskOverview = new WorkspaceTaskOverview(
			async (id, cursor) => {
				return (await deps.gateway.queryConversationResource({
					kind: "get_conversation_resource",
					conversationId: id,
					resource: "activity",
					...(cursor ? { cursor } : {}),
				})) as ConversationActivityView;
			},
			() => this.emit(),
		);
	}

	getView(): MetaWorkTuiViewState {
		const conversationId = this.state.selectedConversationId;
		const conversation = conversationId ? this.state.conversations[conversationId] : undefined;
		const turns = conversation
			? conversation.turnOrder
					.map((turnId) => conversation.turns[turnId])
					.filter((turn): turn is MetaWorkTurnProjection => turn !== undefined)
			: [];
		const selectedTurnId = conversationId ? (this.state.ui.selectedTurnIds[conversationId] ?? null) : null;
		const selectedTurn =
			selectedTurnId && conversation ? (conversation.turns[selectedTurnId] ?? null) : (turns.at(-1) ?? null);
		const expandedIds = conversationId ? this.expandedTurnIds() : [];
		return {
			taskOverview: this.taskOverview.state(),
			reader: this.reader,
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
			permission: this.pendingPermission(),
			capabilitiesMissing: this.capabilitiesMissing,
			taskPanelOpen: this.taskPanelOpen,
			helpOpen: this.helpOpen,
			permissionPanelOpen: this.permissionPanelOpen,
			conversationSelectorOpen: this.conversationSelectorOpen,
		};
	}

	async start(): Promise<void> {
		this.eventUnsubscribe = this.deps.gateway.onEvent((event) => this.handleEvent(event));
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
			(capability) => !(this.deps.gateway.serverCapabilities ?? []).includes(capability),
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
			this.operation = receipt.status === "rejected" ? `Workspace 选择被拒绝：${receipt.reason ?? "unknown"}` : null;
		}
		const conversationId = this.deps.conversationId?.trim();
		if (conversationId) {
			await this.attachConversation(conversationId, false);
			// Restore the bound Workspace independently of observing or activating execution.
			const generation = this.state.navigationGeneration;
			try {
				const metadata = asRecord(
					await this.deps.gateway.queryConversationResource({
						kind: "get_conversation_resource",
						conversationId,
						resource: "metadata",
					}),
				);
				if (!this.isCurrentHistoryScope(conversationId, generation)) return;
				const workspace = asRecord(metadata?.workspace);
				if (
					metadata?.id === conversationId &&
					workspace &&
					workspace.id === metadata.workspaceId &&
					typeof workspace.path === "string" &&
					typeof workspace.id === "string" &&
					typeof workspace.displayName === "string"
				) {
					this.state = {
						...this.state,
						activeWorkspace: {
							id: workspace.id,
							path: workspace.path,
							displayName: workspace.displayName,
							availability: workspace.availability === "available" ? "available" : "unavailable",
						},
					};
				}
			} catch (error) {
				if (this.isCurrentHistoryScope(conversationId, generation))
					this.operation = `Workspace 读取失败：${formatClientError(error)}`;
			}
		} else if (this.state.activeWorkspace?.id) {
			await this.openConversationSelector();
		}
		this.emit();
		this.syncTaskOverview();
		if (this.state.activeWorkspace && !this.conversationSelectorOpen) void this.refreshConversationDirectory();
		this.directoryPollTimer = setInterval(() => {
			if (
				this.state.connection !== "ready" ||
				this.conversationSelectorOpen ||
				this.directoryLoading ||
				this.directoryResponse
			)
				return;
			// Preserve explicitly loaded directory pages; workspace events update their summaries.
			if (this.state.conversationSummaries.length > 50) return;
			void this.refreshConversationDirectory(undefined, true).catch(() => undefined);
		}, 10_000);
		this.directoryPollTimer.unref?.();
	}

	stop(): void {
		this.taskOverview.clear();
		if (this.directoryPollTimer) clearInterval(this.directoryPollTimer);
		this.directoryPollTimer = null;
		this.observationRelease?.();
		this.observationRelease = null;
		this.observedActivity.clear();
		this.observedEpochs.clear();
		this.disposed = true;
		this.cancelPendingCompletion(null);
		if (this.taskRefreshTimer) clearTimeout(this.taskRefreshTimer);
		this.taskRefreshTimer = null;
		this.clearBillingRetry();
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
		if (this.state.selectedConversationId) {
			const conversationId = this.state.selectedConversationId;
			const readGeneration = this.state.navigationGeneration;
			const control = /^\/(approve|deny|stop-task)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/u.exec(text);
			if (control) {
				const command: GatewayCommand =
					control[1] === "stop-task"
						? { kind: "cancel_task", taskId: control[2]!, expectedExecutionGeneration: control[3]! }
						: {
								kind: "permission_resolution_v2",
								requestId: control[2]!,
								requestRevision: control[3]!,
								expectedExecutionGeneration: control[4] ?? "",
								resolution: control[1] === "approve" ? "approve" : "deny",
							};
				await this.submitControl(conversationId, command);
				return;
			}
			const activity = /^\/(tasks|pending)(?:\s+(\S+))?$/u.exec(text);
			if (activity) {
				const view = (await this.deps.gateway.queryConversationResource({
					kind: "get_conversation_resource",
					conversationId,
					resource: "activity",
					...(activity[2]
						? activity[1] === "tasks"
							? { cursor: activity[2] }
							: { pendingCursor: activity[2] }
						: {}),
				})) as ConversationActivityView;
				if (!this.isCurrentHistoryScope(conversationId, readGeneration)) return;
				this.observedActivity.set(conversationId, view);
				const lines =
					activity[1] === "tasks"
						? view.tasks.map(
								(task) =>
									`${task.title}: ${task.explanation}\n${
										task.canCancel ? `/stop-task ${task.taskId} ${task.executionGeneration}` : ""
									}`,
							)
						: view.pendingInteractions.map(
								(request) =>
									`${request.operation}\n${request.resource}\n${request.reason}\n/approve ${request.requestId} ${request.requestRevision} ${request.generationId}\n/deny ${request.requestId} ${request.requestRevision} ${request.generationId}`,
							);
				const cursor = activity[1] === "tasks" ? view.nextCursor : view.pendingNextCursor;
				if (cursor) lines.push(`下一页：/${activity[1]} ${cursor}`);
				this.reader = {
					id: ++this.readerSequence,
					title: activity[1] === "tasks" ? "活动任务" : "待审批请求",
					text: sanitizeDisplayText(lines.join("\n") || "当前没有待处理事项。"),
				};
				this.emit();
				return;
			}
			const read = /^\/read\s+([a-f0-9]{64})(?:\s+(\d+))?$/u.exec(text);
			if (read) {
				const part = (await this.deps.gateway.queryConversationResource({
					kind: "get_conversation_resource",
					conversationId,
					resource: "content",
					hash: read[1]!,
					offset: Number(read[2] ?? 0),
				})) as { text: string; nextOffset: number; byteLength: number } | null;
				if (!this.isCurrentHistoryScope(conversationId, readGeneration)) return;
				const key = `${conversationId}:${read[1]}`;
				const offset = Number(read[2] ?? 0);
				if (part && (offset === 0 || this.reviewedRanges.get(key) === offset)) {
					this.reviewedRanges.set(key, part.nextOffset);
					if (part.nextOffset >= part.byteLength) this.reviewedPermissionDetails.add(read[1]!);
				}
				while (this.reviewedRanges.size > 32) this.reviewedRanges.delete(this.reviewedRanges.keys().next().value!);
				while (this.reviewedPermissionDetails.size > 32)
					this.reviewedPermissionDetails.delete(this.reviewedPermissionDetails.values().next().value!);
				this.reader = {
					id: ++this.readerSequence,
					title: "完整正文 · 分段阅读",
					text: sanitizeDisplayText(
						part
							? `${part.text}${
									part.nextOffset < part.byteLength ? `\n继续阅读：/read ${read[1]} ${part.nextOffset}` : ""
								}`
							: "正文尚不可用。",
					),
				};
				this.emit();
				return;
			}
			if (text === "/latest") {
				await this.loadHistory(conversationId);
				return;
			}
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
		const navigationGeneration = this.state.navigationGeneration;
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
			if (this.state.navigationGeneration === navigationGeneration) {
				this.operation = receipt.status === "rejected" ? `提交被拒绝：${receipt.reason ?? "unknown"}` : null;
			}
			conversationCreated = receipt.conversationId;
		} catch (error) {
			// 发送失败/没有 receipt：标为受理状态待确认，不谎称"发送失败"。
			this.state = markPendingSubmissionsUncertain(this.state);
			if (this.state.navigationGeneration === navigationGeneration) {
				this.operation = `受理状态待确认：${formatClientError(error)}`;
			}
		} finally {
			this.submitting = false;
			this.emit();
		}
		try {
			if (this.disposed || this.state.navigationGeneration !== navigationGeneration) return;
			if (conversationCreated && conversationCreated !== this.state.selectedConversationId) {
				await this.attachConversation(conversationCreated, false);
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
		this.reader = null;
		this.operation = "正在切换 Conversation";
		this.emit();
		const generation = this.state.navigationGeneration + 1;
		this.cancelPendingCompletion(null);
		this.state = { ...selectConversation(this.state, conversationId), navigationGeneration: generation };
		this.historyUnavailable = false;
		this.historyLoading = false;
		try {
			this.observationRelease?.();
			this.observationRelease = null;
			this.emit();
			const release = await this.deps.gateway.followConversation(conversationId, (view) =>
				this.applyObservation(view, generation),
			);
			if (!this.isCurrentHistoryScope(conversationId, generation)) {
				release();
				return;
			}
			this.observationRelease = release;
			this.conversationSelectorOpen = false;
			this.operation = null;
			if (this.state.connection === "reconnecting" || this.state.connection === "closed") this.finishRecovery();
			return;
		} finally {
			if (this.isCurrentHistoryScope(conversationId, generation)) {
				this.navigationPending = false;
				this.emit();
			}
		}
	}

	private applyObservation(view: GatewayObservedConversation, generation: number): void {
		if (!this.isCurrentHistoryScope(view.conversationId, generation)) return;
		if (view.error === "authorization_revoked") {
			const id = view.conversationId;
			const conversations = { ...this.state.conversations };
			delete conversations[id];
			const drafts = { ...this.state.ui.drafts };
			delete drafts[id];
			const selectedTurnIds = { ...this.state.ui.selectedTurnIds };
			delete selectedTurnIds[id];
			this.state = {
				...this.state,
				conversations,
				ui: { ...this.state.ui, drafts, selectedTurnIds },
				selectedConversationId: null,
				navigationGeneration: this.state.navigationGeneration + 1,
				pendingSubmissions: Object.fromEntries(
					Object.entries(this.state.pendingSubmissions).filter(([, pending]) => {
						const scope = pending.envelope.scope;
						return !(
							scope.kind === "conversation" &&
							scope.selection.mode === "attach" &&
							scope.selection.conversationId === id
						);
					}),
				),
				completions: {},
				completionRequests: {},
				conversationSummaries: this.state.conversationSummaries.filter((item) => item.conversationId !== id),
			};
			this.observedActivity.delete(id);
			this.syncTaskOverview();
			this.observedEpochs.delete(id);
			this.reviewedPermissionDetails.clear();
			this.reviewedRanges.clear();
			delete this.expandedByConversation[id];
			this.reader = null;
			this.permissionPanelOpen = false;
			this.permissionRequestId = null;
			this.cancelPendingCompletion(null);
			this.completionBuffer.clear();
			this.operation = "该会话的访问权限已撤销。";
			this.historyLoading = false;
			this.navigationPending = false;
			this.emit();
			return;
		}
		if (view.cursor) this.observedEpochs.set(view.conversationId, view.cursor.epoch);
		else this.observedEpochs.delete(view.conversationId);
		while (this.observedEpochs.size > 8) this.observedEpochs.delete(this.observedEpochs.keys().next().value!);
		this.observedActivity.delete(view.conversationId);
		this.observedActivity.set(view.conversationId, view.activity);
		while (this.observedActivity.size > 8) this.observedActivity.delete(this.observedActivity.keys().next().value!);
		this.state = applyObservedConversation(this.state, view);
		this.operation = view.error;
		this.taskOverview.observe(view.conversationId, view.activity);
		this.scheduleTaskRefresh();
		this.syncFromEvents();
		this.emit();
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

	async refreshConversationDirectory(query?: string, quiet = false): Promise<void> {
		const workspaceId = this.state.activeWorkspace?.id;
		if (!workspaceId) return;
		const request = ++this.directoryRequest;
		const response: DirectoryRequest = {
			version: request,
			workspaceId,
			query: query ?? "",
			cursor: null,
			requestId: null,
		};
		this.directoryResponse = response;
		this.directoryLoading = false;
		this.state = { ...this.state, conversationDirectoryQuery: query ?? "", conversationDirectoryCursor: null };
		if (!quiet) this.operation = "正在加载 Conversation 目录";
		this.emit();
		try {
			const receipt = await this.deps.gateway.listWorkspaceConversations(
				workspaceId,
				query,
				undefined,
				(requestId) => {
					response.requestId = requestId;
				},
			);
			if (this.isCurrentDirectoryRequest(response) && receipt.status === "rejected") {
				this.directoryResponse = null;
				this.operation = `目录加载失败：${receipt.reason ?? "unknown"}`;
				return;
			}
		} catch (error) {
			if (this.isCurrentDirectoryRequest(response)) {
				this.directoryResponse = null;
				this.operation = `目录加载失败：${formatClientError(error)}`;
			}
		} finally {
			if (this.isCurrentDirectoryRequest(response)) {
				if (!quiet && !this.operation?.startsWith("目录加载失败")) this.operation = null;
				this.emit();
			}
		}
	}

	async loadMoreConversations(): Promise<void> {
		const workspaceId = this.state.activeWorkspace?.id;
		const cursor = this.state.conversationDirectoryCursor;
		if (!workspaceId || !cursor || this.directoryLoading) return;
		const query = this.state.conversationDirectoryQuery || undefined;
		const request = ++this.directoryRequest;
		const response: DirectoryRequest = {
			version: request,
			workspaceId,
			query: query ?? "",
			cursor,
			requestId: null,
		};
		this.directoryResponse = response;
		this.directoryLoading = true;
		try {
			const receipt = await this.deps.gateway.listWorkspaceConversations(workspaceId, query, cursor, (requestId) => {
				response.requestId = requestId;
			});
			if (!this.isCurrentDirectoryRequest(response)) return;
			if (receipt.status === "rejected" && receipt.reason === "stale_directory_cursor") {
				await this.refreshConversationDirectory(query);
			} else if (receipt.status === "rejected") {
				this.directoryResponse = null;
				this.operation = `目录加载失败：${receipt.reason ?? "unknown"}`;
			}
		} catch (error) {
			if (this.isCurrentDirectoryRequest(response)) {
				this.directoryResponse = null;
				this.operation = `目录加载失败：${formatClientError(error)}`;
			}
		} finally {
			if (this.isCurrentDirectoryRequest(response)) {
				this.directoryLoading = false;
				this.emit();
			}
		}
	}

	private isCurrentDirectoryRequest(request: DirectoryRequest): boolean {
		return (
			!this.disposed &&
			request.version === this.directoryRequest &&
			request.workspaceId === this.state.activeWorkspace?.id
		);
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
		const generation = this.state.navigationGeneration;
		const historyGeneration = this.historyGeneration;
		const before = this.state.conversations[conversationId]?.turnOrder ?? [];
		if (this.state.conversations[conversationId]?.historyExhausted) return;
		try {
			await this.loadHistory(conversationId, true);
			if (!this.isCurrentHistoryScope(conversationId, generation, historyGeneration)) return;
			const order = this.state.conversations[conversationId]?.turnOrder ?? [];
			const added = order.filter((id) => !before.includes(id));
			if (added.length > 0 && this.state.selectedConversationId === conversationId) {
				this.state = selectTurn(this.state, conversationId, added.at(-1)!);
				this.scheduleTaskRefresh();
			}
		} finally {
			if (this.isCurrentHistoryScope(conversationId, generation, historyGeneration)) this.emit();
		}
	}

	private async loadHistory(conversationId: string, older = false): Promise<void> {
		const generation = this.state.navigationGeneration;
		const historyGeneration = this.historyGeneration;
		if (!this.isCurrentHistoryScope(conversationId, generation)) return;
		if (this.historyLoading) return;
		const epoch = this.observedEpochs.get(conversationId);
		const beforeTurnId = older ? this.state.conversations[conversationId]?.turnOrder[0] : undefined;
		this.historyLoading = true;
		this.emit();
		try {
			const page = (await this.deps.gateway.queryConversationResource({
				kind: "get_conversation_resource",
				conversationId,
				resource: "turns",
				...(beforeTurnId ? { beforeTurnId } : {}),
			})) as ConversationTurnPage;
			if (this.isCurrentHistoryScope(conversationId, generation, historyGeneration))
				this.deps.gateway.applyConversationPage(conversationId, page, !older, epoch);
		} catch (error) {
			if (this.isCurrentHistoryScope(conversationId, generation)) this.operation = formatClientError(error);
		} finally {
			if (this.isCurrentHistoryScope(conversationId, generation)) {
				this.historyLoading = false;
				this.emit();
			}
		}
		return;
	}

	private isCurrentHistoryScope(conversationId: string, generation: number, historyGeneration?: number): boolean {
		return (
			!this.disposed &&
			this.state.selectedConversationId === conversationId &&
			this.state.navigationGeneration === generation &&
			(historyGeneration === undefined || historyGeneration === this.historyGeneration)
		);
	}

	/** 选择 Turn（F7/F8）。到新进展时不会隐式改变选中项。 */
	selectAdjacentTurn(delta: -1 | 1): void {
		this.taskNavigation++;
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		const conversation = this.state.conversations[conversationId];
		if (!conversation || conversation.turnOrder.length === 0) return;
		const selected = this.state.ui.selectedTurnIds[conversationId];
		const currentIndex = selected ? conversation.turnOrder.indexOf(selected) : conversation.turnOrder.length - 1;
		const nextIndex = Math.max(0, Math.min(conversation.turnOrder.length - 1, currentIndex + delta));
		const turnId = conversation.turnOrder[nextIndex];
		if (!turnId) return;
		this.state = selectTurn(this.state, conversationId, turnId);
		this.scheduleTaskRefresh();
		this.emit();
	}

	selectTurnById(turnId: string): void {
		this.taskNavigation++;
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

	closeReader(): void {
		this.reader = null;
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
			.map((turnId) => conversation.turns[turnId])
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
		const pending = this.observedActivity
			.get(conversationId)
			?.pendingInteractions.find((request) => request.requestId === requestId);
		if (!pending) {
			this.operation = "权限请求已失效，请重新查询 /pending。";
			this.emit();
			return;
		}
		if (
			resolution === "approve" &&
			pending.detailsRef &&
			!this.reviewedPermissionDetails.has(pending.detailsRef.hash)
		) {
			this.operation = `请先查看完整申请：/read ${pending.detailsRef.hash} 0`;
			this.emit();
			return;
		}
		this.permissionSubmitting = true;
		try {
			await this.submitControl(conversationId, {
				kind: "permission_resolution_v2",
				requestId,
				requestRevision: pending.requestRevision,
				expectedExecutionGeneration: pending.generationId,
				resolution,
			});
			if (this.state.selectedConversationId === conversationId) this.permissionPanelOpen = false;
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
		if (
			this.disposed ||
			version !== this.completionSeq ||
			scopeKey !== (this.state.selectedConversationId ?? "workspace")
		)
			return null;
		const pending: PendingCompletion = {
			version,
			scopeKey,
			requestId: null,
			resolve: () => undefined,
			timer: null,
		};
		const promise = new Promise<MetaWorkCompletionState | null>((resolve) => {
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

	private syncTaskOverview(): void {
		const workspaceId = this.state.activeWorkspace?.id ?? null;
		if (this.overviewWorkspaceId !== workspaceId) {
			this.taskOverview.clear();
			this.overviewWorkspaceId = workspaceId;
		}
		if (this.state.connection !== "ready") return;
		if (!this.state.conversationDirectoryQuery)
			this.taskOverview.update(this.state.activeWorkspace?.id ?? null, this.state.conversationSummaries);
	}

	async loadMoreTasks(conversationId: string): Promise<void> {
		await this.taskOverview.loadMore(conversationId);
	}
	async firstTasks(conversationId: string): Promise<void> {
		await this.taskOverview.first(conversationId);
	}

	/** Explicit navigation only: locate the Task's own Turn even outside the recent window. */
	async openOverviewTask(row: TaskOverviewRow): Promise<void> {
		const navigation = ++this.taskNavigation;
		if (
			!this.taskOverview
				.state()
				.rows.some((item) => item.conversationId === row.conversationId && item.taskId === row.taskId)
		)
			return;
		if (this.state.selectedConversationId !== row.conversationId) await this.attachConversation(row.conversationId);
		const generation = this.state.navigationGeneration;
		if (navigation !== this.taskNavigation || !this.isCurrentHistoryScope(row.conversationId, generation)) return;
		const deadline = Date.now() + 5_000;
		while (!this.observedEpochs.has(row.conversationId) && Date.now() < deadline) {
			await sleep(25);
			if (navigation !== this.taskNavigation || !this.isCurrentHistoryScope(row.conversationId, generation)) return;
		}
		if (!this.observedEpochs.has(row.conversationId)) throw new Error("正在读取会话，请稍后重试。");
		const epoch = this.observedEpochs.get(row.conversationId);
		const page = (await this.deps.gateway.queryConversationResource({
			kind: "get_conversation_resource",
			conversationId: row.conversationId,
			resource: "locate",
			taskId: row.taskId,
		})) as ConversationTurnPage;
		if (
			navigation !== this.taskNavigation ||
			!this.isCurrentHistoryScope(row.conversationId, generation) ||
			epoch !== this.observedEpochs.get(row.conversationId)
		)
			return;
		const turn = page.turns.find((item) => item.taskId === row.taskId);
		if (!turn) throw new Error("该任务的对话记录尚未就绪，请稍后重试。");
		this.deps.gateway.applyConversationPage(row.conversationId, page, false, epoch);
		this.selectTurnById(turn.id);
		this.taskPanelOpen = false;
		this.emit();
	}

	/** Task 视图：只读查询，不启动 Planner、不创建 Turn。 */
	async openTaskPanel(): Promise<void> {
		this.taskPanelOpen = true;
		this.emit();
		if (this.taskRefreshTimer) clearTimeout(this.taskRefreshTimer);
		this.taskRefreshTimer = null;
		await Promise.all([
			this.refreshSelectedTask(),
			this.refreshSelectedBilling(),
			this.state.conversationSummaries.length && !this.state.conversationDirectoryQuery
				? Promise.resolve()
				: this.refreshConversationDirectory(),
		]);
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
		try {
			await query;
		} finally {
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
		const permission = this.pendingPermission();
		this.permissionPanelOpen = permission?.status === "pending";
		this.permissionRequestId = permission?.requestId ?? null;
		if (!permission) this.operation = "当前没有待审批。使用 /pending 查询更多。";
		this.emit();
		return;
	}

	toggleExpanded(): void {
		const turn = this.getView().selectedTurn;
		if (!turn) return;
		const conversationId = this.state.selectedConversationId;
		if (!conversationId) return;
		const current = this.expandedTurnIds();
		const next = current.includes(turn.id) ? current.filter((id) => id !== turn.id) : [...current, turn.id];
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
		if (event.kind === "command_result") {
			const payload = asRecord(event.payload);
			this.state = pushClientNotice(
				this.state,
				payload?.status === "failed" ? "error" : "info",
				payload?.status === "failed" ? `操作未完成：${String(payload.reason)}` : "操作已处理。",
			);
			this.emit();
			return;
		}
		if (event.kind === "conversation_resource" || event.kind === "pending_interactions") return;
		// Conversation content has one writer: the observation projection. Query replies
		// and directory events remain on the connection-specific event channel.
		if (
			[
				"conversation_history_page",
				"conversation_snapshot",
				"turn_started",
				"trace_snapshot",
				"trace_delta",
				"execution_snapshot",
				"execution_delta",
				"permission_request",
				"final_answer",
				"result_delivery_available",
				"result_chunk",
				"result_completed",
				"delivery_status",
				"terminal_error",
			].includes(event.kind)
		)
			return;
		if (event.kind === "workspace_directory_snapshot") {
			const payload = asRecord(event.payload);
			if (payload && "requestedCursor" in payload) {
				const request = this.directoryResponse;
				if (
					!request ||
					!request.requestId ||
					request.requestId !== event.requestId ||
					!this.isCurrentDirectoryRequest(request) ||
					payload.workspaceId !== request.workspaceId ||
					(payload.query ?? "") !== request.query ||
					payload.requestedCursor !== request.cursor
				)
					return;
				this.directoryResponse = null;
			} else {
				this.directoryRequest += 1;
				this.directoryResponse = null;
				this.directoryLoading = false;
			}
		}
		if (event.kind === "command_completion") {
			const payload = asRecord(event.payload);
			const completion = payload ? normalizeCompletion(payload) : null;
			const pending = this.pendingCompletion;
			const matches = Boolean(completion && pending?.requestId && pending.requestId === completion.requestId);
			this.state = reduceGatewayEvent(this.state, event);
			if (completion) {
				if (matches && pending) {
					const applied = this.state.completions[pending.scopeKey];
					this.finishCompletion(pending, applied?.inputVersion === pending.version ? applied : null);
				} else {
					this.bufferCompletion(event);
				}
			}
			this.emit();
			return;
		}
		this.state = reduceGatewayEvent(this.state, event);
		if (event.kind.startsWith("workspace_")) this.syncTaskOverview();
		if (event.kind === "task_view_snapshot") {
			const payload = asRecord(event.payload);
			const view = payload ? normalizeTaskView(payload) : null;
			const turn = view ? this.state.conversations[view.targetConversationId]?.turns[view.turnId] : null;
			if (
				view &&
				turn?.taskId === view.taskId &&
				view.asOfSequence < (turn.lastTaskSequence ?? turn.startedAtSequence)
			) {
				this.scheduleTaskRefresh();
			}
		} else if (
			[
				"trace_delta",
				"execution_delta",
				"permission_request",
				"final_answer",
				"result_completed",
				"delivery_status",
				"terminal_error",
				"conversation_history_page",
			].includes(event.kind)
		) {
			this.scheduleTaskRefresh();
		}
		this.syncFromEvents();
		this.emit();
	}

	private syncFromEvents(): void {
		// 取消结果只在权威 Turn 状态到达后展示。
		if (this.cancelTurnId) {
			const conversationId = this.state.selectedConversationId;
			const turn = conversationId ? this.state.conversations[conversationId]?.turns[this.cancelTurnId] : undefined;
			if (turn && turn.status !== "running") {
				this.cancelResult = `取消结果：${turn.status}`;
				this.cancelling = false;
				this.cancelTurnId = null;
			}
		}
		// 权限面板跟随权威事实：请求已解决/过期则关闭面板。
		const permission = this.pendingPermission();
		if (this.permissionPanelOpen && this.permissionRequestId) {
			if (!permission || permission.requestId !== this.permissionRequestId || permission.status !== "pending") {
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
		this.taskOverview.clear();
		// 发送后断线且没有 receipt：标为受理状态待确认，只能重放同一 envelope。
		this.state = markPendingSubmissionsUncertain(this.state);
		this.emit();
		void this.recover();
	}

	private async recover(): Promise<void> {
		if (this.disposed) return;
		const recoveryGeneration = ++this.recoveryGeneration;
		try {
			await this.deps.gateway.connect?.();
		} catch (error) {
			if (!this.isCurrentRecovery(recoveryGeneration)) return;
			if (error instanceof Error && error.message === "server_identity_changed") {
				this.purgeIdentity();
			}
			this.state = setConnectionState(this.state, "closed");
			this.state = pushClientNotice(
				this.state,
				"error",
				`重连失败：${formatClientError(error)}。请确认 Server 正在运行。`,
			);
			const notice = this.state.notices.at(-1);
			if (notice) this.reconnectNotices.add(notice);
			this.emit();
			return;
		}
		if (!this.isCurrentRecovery(recoveryGeneration)) return;
		this.capabilitiesMissing = (this.deps.requiredCapabilities ?? []).filter(
			(capability) => !(this.deps.gateway.serverCapabilities ?? []).includes(capability),
		);
		if (this.capabilitiesMissing.length) {
			this.purgeIdentity();
			this.state = setConnectionState(this.state, "incompatible");
			this.emit();
			return;
		}
		const conversationId = this.state.selectedConversationId;
		const generation = this.state.navigationGeneration;
		if (conversationId) {
			try {
				this.observationRelease?.();
				this.observationRelease = null;
				const release = await this.deps.gateway.followConversation(conversationId, (view) =>
					this.applyObservation(view, generation),
				);
				if (
					!this.isCurrentRecovery(recoveryGeneration) ||
					!this.isCurrentHistoryScope(conversationId, generation)
				) {
					release();
					return;
				}
				this.observationRelease = release;
			} catch {
				if (this.isCurrentRecovery(recoveryGeneration)) this.emit();
				return;
			}
		}
		const uncertain = Object.values(this.state.pendingSubmissions)
			.filter((submission) => submission.state === "uncertain")
			.sort((left, right) => left.queuedAt - right.queuedAt);
		for (const submission of uncertain) {
			if (!this.isCurrentRecovery(recoveryGeneration)) return;
			try {
				const receipt = await this.deps.gateway.resubmitEnvelope(submission.envelope);
				this.state = reduceReceipt(this.state, receipt);
			} catch {
				// 仍不确定：保留待确认状态，不谎称发送失败，不自动新建消息。
				if (this.isCurrentRecovery(recoveryGeneration)) this.emit();
				return;
			}
		}
		if (!this.isCurrentRecovery(recoveryGeneration)) return;
		if (!this.isCurrentRecovery(recoveryGeneration) || this.state.navigationGeneration !== generation) return;
		this.finishRecovery();
		this.emit();
	}

	private isCurrentRecovery(generation: number): boolean {
		return !this.disposed && this.recoveryGeneration === generation;
	}

	private purgeIdentity(): void {
		this.taskOverview.clear();
		this.observationRelease?.();
		this.observationRelease = null;
		const generation = this.state.navigationGeneration + 1;
		this.state = { ...emptyMetaWorkClientState(), navigationGeneration: generation };
		this.observedActivity.clear();
		this.observedEpochs.clear();
		this.reader = null;
		this.reviewedPermissionDetails.clear();
		this.reviewedRanges.clear();
		this.expandedByConversation = {};
		this.cancelPendingCompletion(null);
		this.completionBuffer.clear();
		this.completionSeq++;
		this.directoryRequest++;
		this.directoryResponse = null;
		this.historyGeneration++;
		this.permissionPanelOpen = false;
		this.permissionRequestId = null;
		this.cancelTurnId = null;
		this.cancelResult = null;
		this.cancelling = false;
		this.taskQueries.clear();
		this.dirtyTaskQueries.clear();
		this.clearBillingRetry();
		if (this.taskRefreshTimer) clearTimeout(this.taskRefreshTimer);
		this.taskRefreshTimer = null;
		this.operation = null;
	}

	private finishRecovery(): void {
		this.syncTaskOverview();
		this.recoveryGeneration += 1;
		// Clear only our transient transport notices, never newer query/business errors.
		this.state = {
			...setConnectionState(this.state, "ready"),
			notices: this.state.notices.filter((notice) => !this.reconnectNotices.has(notice)),
		};
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
		const pending = Object.values(this.state.pendingSubmissions).find(
			(submission) => submission.state === "uncertain" || submission.state === "awaiting_receipt",
		);
		if (!pending) return null;
		return pending.state === "uncertain" ? `${pending.requestId}（待确认）` : pending.requestId;
	}

	private workspaceConversationIds(): Set<string> {
		return new Set(this.state.conversationSummaries.map((item) => item.conversationId));
	}

	private pendingPermission(): MetaWorkPermissionProjection | null {
		const conversationId = this.state.selectedConversationId;
		const request = conversationId ? this.observedActivity.get(conversationId)?.pendingInteractions[0] : undefined;
		if (request)
			return {
				requestId: request.requestId,
				requestRevision: request.requestRevision,
				generationId: request.generationId,
				status: "pending",
				summary: `${request.operation}\n${request.resource}\n${request.reason}\n范围：${request.scope}`,
				detailsRef: request.detailsRef,
			};

		return null;
	}

	private async submitControl(conversationId: string, command: GatewayCommand): Promise<void> {
		if (command.kind === "permission_resolution_v2" && command.resolution === "approve") {
			const pending = this.observedActivity
				.get(conversationId)
				?.pendingInteractions.find((request) => request.requestId === command.requestId);
			if (pending?.detailsRef && !this.reviewedPermissionDetails.has(pending.detailsRef.hash)) {
				this.operation = `请先查看完整申请：/read ${pending.detailsRef.hash} 0`;
				this.emit();
				return;
			}
		}
		const envelope = await this.deps.gateway.buildEnvelope(command, {
			kind: "conversation",
			selection: { mode: "attach", conversationId },
		});
		this.state = queueSubmission(this.state, envelope, this.now());
		this.emit();
		try {
			this.state = reduceReceipt(this.state, await this.deps.gateway.submitEnvelope(envelope));
		} catch (error) {
			this.state = markPendingSubmissionsUncertain(this.state);
			throw error;
		} finally {
			this.emit();
		}
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

	private finishCompletion(pending: PendingCompletion, value: MetaWorkCompletionState | null): void {
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
	return new Promise((resolve) => setTimeout(resolve, ms));
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
