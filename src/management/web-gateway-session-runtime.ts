import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { GatewayEventEnvelope, GatewayReplay } from '../gateway/client-events.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type {
  InteractionTraceEvent,
  InteractionTraceStatus,
} from './interaction-trace.js';
import type { ExecutionTimeline } from './execution-projector.js';
import type { WebGatewayAdapter } from './web-gateway-adapter.js';
import type {
  WebSessionActivationResult,
  WebSessionCreationResult,
  ConversationWorkspaceProjection,
  ConversationTurn,
  WebSessionDirectoryMetadata,
  WebSessionDirectoryMetadataProjection,
  WebSessionMetadata,
  WebSessionMetadataProjection,
  WebSessionRecord,
  WebSessionRecordProjection,
  WorkspaceInitializationResult,
} from './web-session-types.js';
import type { GatewayAttachmentStore } from '../gateway/attachment-store-port.js';
import {
  evaluateAttachmentBudget,
  evaluateAttachmentCount,
  type AttachmentBudgetEntry,
} from '../gateway/attachment-budget.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import type {
  BillQueryService,
  QueryBillProjection,
  TaskUsageSummary,
  TurnBillUserView,
} from '../billing/bill-query-service.js';
import type {
  BillingRecordPageView,
  BillingRecordView,
  BillingStatusFilter,
  BillingTaskView,
  TaskBillingDetailView,
} from './web-session-types.js';
import { turnStatusFromTimeline } from './web-conversation-projector.js';

function isSystemCommandTurn(turn: ConversationTurn): boolean {
  return turn.interactionKind === 'system_command' || turn.userInput.trim().startsWith('/');
}

/** 账单页请求摘要：单行、截断，只作为展示摘要，不含原始 Prompt 全文。 */
function singleLineSummary(userInput: string, limit = 80): string | null {
  const collapsed = userInput.replace(/\s+/gu, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

const WEB_WORKSPACE_PRINCIPAL = 'web:local-web-user';

export class WebGatewayAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly agentId?: string,
    message = code,
  ) {
    super(message);
    this.name = 'WebGatewayAdmissionError';
  }
}

function formatByteSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

import type {
  WebSessionRuntimeCatalog,
  WebSessionRuntimeEvent,
} from './web-session-runtime-types.js';

export interface WebGatewaySessionRuntimeDeps {
  readonly accountId: string;
  readonly catalog: WebSessionRuntimeCatalog;
  readonly gateway: WebGatewayAdapter;
  /** 会话附件存储；提供后用户消息可携带附件并自动增强 Planner 提示。 */
  readonly attachments?: GatewayAttachmentStore;
  /** Read-only durable execution projection used to rebuild a turn after reconnect. */
  readonly projectExecutionTimeline?: (taskId: string) => ExecutionTimeline | null;
  /** Explicit account/Task authorization for billing detail projections. */
  readonly authorizeTask?: (accountId: string, taskId: string) => boolean;
  /** Account-scoped historical Task catalog used by the billing page. */
  readonly listAccountTasks?: (accountId: string) => readonly {
    id: string;
    title: string;
  }[];
  /** Read-only published artifact projection used to rebuild completed turns. */
  readonly projectTaskArtifacts?: (taskId: string) => ArtifactProjection[];
  /** Read-only billing projection shared with the other Gateway surfaces. */
  readonly billing?: BillQueryService;
  readonly normalizeTurnPresentation?: (turn: ConversationTurn) => ConversationTurn;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

class WebGatewayClientSession {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private readonly pendingInputs = new Map<string, string>();
  /** turn id → richness of what was persisted (skip re-persist without new information). */
  private readonly persistedTurns = new Map<string, {
    status: string;
    traceCount: number;
    answerLength: number;
  }>();
  private readonly resultAssemblies = new Map<string, ResultAssembly>();
  private readonly completedResults = new Map<string, string>();
  private readonly turnStates = new Map<string, RuntimeTurnState>();
  private readonly persistedTurnIds = new Set<string>();
  private readonly workspaces = new Map<string, ConversationWorkspaceProjection | null>();
  private unsubscribe: (() => void) | null = null;
  private workspaceUnsubscribe: (() => void) | null = null;
  private detachClient: (() => void) | null = null;
  private replayEvents: WebSessionRuntimeEvent[] = [];
  private _activeSessionId: string | null = null;
  private attachGeneration = 0;
  private readonly pendingAttaches = new Set<Promise<void>>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private activeWorkspaceId: string | null = null;
  private navigationQueue: Promise<void> = Promise.resolve();
  private readonly billingRefreshTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(
    private readonly deps: WebGatewaySessionRuntimeDeps,
    private readonly clientId: string,
  ) {}

  private get connectionId(): string {
    return `web:${this.clientId}`;
  }

  get activeSessionId(): string {
    if (!this._activeSessionId) throw new Error('Web Gateway runtime is not initialized');
    return this._activeSessionId;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    await this.deps.catalog.initialize();
  }

  getState(): { activeWorkspaceId: string | null; activeSessionId: string | null } {
    return { activeWorkspaceId: this.activeWorkspaceId, activeSessionId: this._activeSessionId };
  }

  listWorkspaces() {
    return this.deps.catalog.listWorkspaces(WEB_WORKSPACE_PRINCIPAL);
  }

  selectWorkspace(path: string): Promise<WorkspaceInitializationResult> {
    return this.enqueueNavigation(() => this.initializeWorkspace(path));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.attachGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.workspaceUnsubscribe?.();
    this.workspaceUnsubscribe = null;
    this.detachClient?.();
    this.detachClient = null;
    this._activeSessionId = null;
    this.replayEvents = [];
    this.pendingInputs.clear();
    this.resultAssemblies.clear();
    this.completedResults.clear();
    this.turnStates.clear();
    this.persistedTurnIds.clear();
    this.persistedTurns.clear();
    this.workspaces.clear();
    for (const timers of this.billingRefreshTimers.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.billingRefreshTimers.clear();
    this.deps.gateway.closeConnection?.(this.connectionId);
    this.disposePromise = Promise.allSettled([...this.pendingAttaches]).then(() => undefined);
    return this.disposePromise;
  }

  async submit(
    text: string,
    attachments: Array<{ attachmentId: string; kind: string }> = [],
    requestId?: string,
  ): Promise<void> {
    const targetSessionId = this.activeSessionId;
    const effectiveRequestId = requestId ?? this.id('req');
    // Enforce the per-message attachment budget before the turn is admitted so
    // a rejected message never consumes Planner/Kernel work.
    if (attachments.length > 0) await this.assertAttachmentBudget(attachments);
    this.pendingInputs.set(effectiveRequestId, text);
    const command: GatewayCommand = text.startsWith('/')
      ? { kind: 'slash_command', text }
      : { kind: 'user_message', text, attachments };
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 2,
      requestId: effectiveRequestId,
      idempotencyKey: this.id('idem'),
      connectionId: this.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: targetSessionId },
      },
      command,
      clientCapabilities: ['trace_v1'],
    });
    if ('kind' in receipt || receipt.status === 'rejected') {
      this.pendingInputs.delete(effectiveRequestId);
      if ('kind' in receipt) throw new Error(receipt.message);
      if (receipt.code === 'required_agent_unavailable') {
        throw new WebGatewayAdmissionError(receipt.code, receipt.agentId);
      }
      throw new Error(receipt.reason ?? 'Gateway rejected the command');
    }
  }

  /**
   * Resolves the admitted attachment set and enforces the per-message budget.
   * Metadata comes from the same store the upload endpoint wrote to, so a
   * stale or foreign reference fails closed instead of entering Planner.
   */
  private async assertAttachmentBudget(
    attachments: Array<{ attachmentId: string; kind: string }>,
  ): Promise<void> {
    const store = this.deps.attachments;
    const conversationId = this.activeSessionId;
    const countViolation = evaluateAttachmentCount(attachments.length);
    if (countViolation) {
      throw new WebGatewayAdmissionError(countViolation.code, undefined, countViolation.message);
    }
    if (!store || !conversationId) return;
    const entries: AttachmentBudgetEntry[] = [];
    for (const reference of attachments) {
      const metadata = store.readAttachmentMetadata
        ? await store.readAttachmentMetadata(conversationId, reference.attachmentId)
        : (await store.readAttachment(conversationId, reference.attachmentId))?.metadata;
      if (!metadata || metadata.status !== 'available') {
        throw new WebGatewayAdmissionError(
          'attachment_unavailable',
          undefined,
          '附件不存在或已不可用，请重新上传后再发送。',
        );
      }
      entries.push({ name: metadata.name, size: metadata.size });
    }
    const violation = evaluateAttachmentBudget(entries);
    if (violation) throw new WebGatewayAdmissionError(violation.code, undefined, violation.message);
  }

  /**
   * Turn cancellation from a Client. The command goes through the ordinary
   * Gateway admission path so the Application Shell owns the latch and the
   * Planner abort.
   */
  async cancelTurn(turnId: string): Promise<void> {
    const targetSessionId = this.activeSessionId;
    if (!targetSessionId) return;
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 2,
      requestId: this.id('req'),
      idempotencyKey: this.id('idem'),
      connectionId: this.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: targetSessionId },
      },
      command: { kind: 'cancel_turn', turnId },
      clientCapabilities: ['trace_v1'],
    });
    if ('kind' in receipt) throw new Error(receipt.message);
    if (receipt.status === 'rejected') {
      throw new Error(receipt.reason ?? 'Gateway rejected cancellation');
    }
  }

  async listSessions(query = ''): Promise<WebSessionDirectoryMetadataProjection[]> {
    if (!this.activeWorkspaceId) return [];
    const input = {
      workspaceId: this.activeWorkspaceId,
      principalId: WEB_WORKSPACE_PRINCIPAL,
      activeConversationId: this._activeSessionId,
      ...(query.trim() ? { query } : {}),
    };
    const sessions = query.trim()
      ? await this.deps.catalog.search(input)
      : await this.deps.catalog.list(input);
    return Promise.all(sessions.map(session => this.projectMetadata(session)));
  }
  async readSession(sessionId: string): Promise<WebSessionRecordProjection | null> {
    if (sessionId !== this._activeSessionId) return null;
    const record = await this.deps.catalog.read(sessionId, this._activeSessionId);
    if (!record) return null;
    return this.projectRecord(this.enrichRecord(record));
  }

  async listBillingRecords(input: {
    readonly cursor?: string;
    readonly filter?: BillingStatusFilter;
    readonly limit?: number;
  } = {}): Promise<BillingRecordPageView> {
    const billing = this.deps.billing;
    if (!billing) return { items: [], nextCursor: null };
    const limit = input.limit ?? 20;
    const page = billing.listQueryBillsPage
      ? billing.listQueryBillsPage({
        accountId: this.deps.accountId,
        limit,
        ...(input.filter && input.filter !== 'all' ? { filter: input.filter } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      })
      : {
        items: billing.listQueryBills({ accountId: this.deps.accountId, limit }),
        nextCursor: null as string | null,
      };
    const filter = input.filter ?? 'all';
    const filtered = page.items.filter(bill => filter === 'all' || bill.userStatus === filter);
    const summaries = new Map<string, string | null>();
    const taskTitles = new Map<string, string | null>();
    const routing = new Map<string, {
      providerDisplayName: string | null;
      modelDisplayName: string | null;
    }>();
    const items: BillingRecordView[] = [];
    for (const bill of filtered) {
      items.push({
        bill,
        requestSummary: await this.billingRequestSummary(bill, summaries),
        taskTitle: await this.billingTaskTitle(bill.taskId, taskTitles),
        ...(await this.billingRoutingFacts(bill, routing)),
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  async listBillingTasks(): Promise<readonly BillingTaskView[]> {
    const billing = this.deps.billing;
    const tasks = this.deps.listAccountTasks?.(this.deps.accountId) ?? [];
    return tasks.map(task => ({
      taskId: task.id,
      taskTitle: task.title,
      queryCount: billing?.listQueryBillsForTask(this.deps.accountId, task.id).length ?? 0,
    }));
  }

  async getTaskBillingDetail(taskId: string): Promise<TaskBillingDetailView | null> {
    const billing = this.deps.billing;
    if (!billing) return null;
    if (this.deps.authorizeTask) {
      try {
        if (!this.deps.authorizeTask(this.deps.accountId, taskId)) return null;
      } catch {
        return null;
      }
    }
    const bills = billing.listQueryBillsForTask(this.deps.accountId, taskId);
    if (!this.deps.authorizeTask && bills.length === 0) return null;
    const summaries = new Map<string, string | null>();
    const routing = new Map<string, {
      providerDisplayName: string | null;
      modelDisplayName: string | null;
    }>();
    const items: BillingRecordView[] = [];
    for (const bill of bills) {
      items.push({
        bill,
        requestSummary: await this.billingRequestSummary(bill, summaries),
        taskTitle: null,
        ...(await this.billingRoutingFacts(bill, routing)),
      });
    }
    return {
      taskId,
      taskTitle: await this.billingTaskTitle(taskId, new Map()),
      items,
    };
  }

  private async billingRoutingFacts(
    bill: QueryBillProjection,
    cache: Map<string, { providerDisplayName: string | null; modelDisplayName: string | null }>,
  ): Promise<{ providerDisplayName: string | null; modelDisplayName: string | null }> {
    const key = `${bill.conversationId ?? ''}:${bill.turnId ?? ''}`;
    const cached = cache.get(key);
    if (cached) return cached;
    let result: {
      providerDisplayName: string | null;
      modelDisplayName: string | null;
    } = { providerDisplayName: null, modelDisplayName: null };
    if (bill.conversationId && bill.turnId) {
      const record = await this.deps.catalog.read(bill.conversationId).catch(() => null);
      const turn = record?.turns.find(candidate => candidate.id === bill.turnId) ?? null;
      for (const event of [...(turn?.traceEvents ?? [])].reverse()) {
        const details = event.details as Record<string, unknown> | undefined;
        if (!details) continue;
        const provider = details.providerDisplayName;
        const model = details.modelDisplayName;
        if (typeof provider === 'string' || typeof model === 'string') {
          result = {
            providerDisplayName: typeof provider === 'string' ? provider : null,
            modelDisplayName: typeof model === 'string' ? model : null,
          };
          break;
        }
      }
    }
    cache.set(key, result);
    return result;
  }

  /** 请求摘要只取会话目录中的 userInput 单行截断；不含 Prompt 原文全文。 */
  private async billingRequestSummary(
    bill: QueryBillProjection,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    const key = `${bill.conversationId ?? ''}:${bill.turnId ?? ''}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    let summary: string | null = null;
    if (bill.conversationId && bill.turnId) {
      const record = await this.deps.catalog.read(bill.conversationId).catch(() => null);
      const turn = record?.turns.find(candidate => candidate.id === bill.turnId) ?? null;
      summary = turn ? singleLineSummary(turn.userInput) : null;
    }
    cache.set(key, summary);
    return summary;
  }

  private async billingTaskTitle(
    taskId: string | null,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    if (!taskId) return null;
    if (cache.has(taskId)) return cache.get(taskId) ?? null;
    let title: string | null = null;
    try {
      title = this.deps.projectExecutionTimeline?.(taskId)?.title ?? null;
    } catch {
      title = null;
    }
    cache.set(taskId, title);
    return title;
  }

  async createSession(): Promise<WebSessionCreationResult> {
    return this.enqueueNavigation(() => this.createSessionNow());
  }

  private async createSessionNow(): Promise<WebSessionCreationResult> {
    if (!this.activeWorkspaceId) throw new Error('workspace_required');
    const requestId = this.id('req');
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 2,
      requestId,
      idempotencyKey: this.id('idem'),
      connectionId: this.connectionId,
      scope: { kind: 'workspace' },
      command: { kind: 'create_conversation', workspaceId: this.activeWorkspaceId },
      clientCapabilities: ['trace_v1'],
    });
    if ('kind' in receipt || receipt.status === 'rejected' || !receipt.conversationId) {
      if ('kind' in receipt) throw new Error(receipt.message);
      if (receipt.code === 'required_agent_unavailable') {
        throw new WebGatewayAdmissionError(receipt.code, receipt.agentId);
      }
      throw new Error(receipt.reason ?? 'conversation_create_failed');
    }
    const created = await this.deps.catalog.read(receipt.conversationId);
    if (!created) throw new Error('created_conversation_unavailable');
    const activation = await this.activateSessionNow(created.session.id);
    return {
      session: await this.readSession(created.session.id)
        ?? await this.projectRecord(created),
      activation,
    };
  }

  async activateSession(sessionId: string): Promise<WebSessionActivationResult> {
    return this.enqueueNavigation(() => this.activateSessionNow(sessionId));
  }

  private async activateSessionNow(sessionId: string): Promise<WebSessionActivationResult> {
    const target = await this.deps.catalog.read(sessionId);
    if (!target || target.session.archived) {
      return { state: 'activation_blocked', sessionId, reason: 'session_unavailable' };
    }
    const workspaceId = await this.deps.catalog.workspaceIdForConversation(sessionId);
    if (!workspaceId) {
      return { state: 'activation_blocked', sessionId, reason: 'session_unavailable' };
    }
    this.activeWorkspaceId = workspaceId;
    this.deps.gateway.restoreWorkspace?.(this.connectionId, workspaceId);
    this.followWorkspace(workspaceId);
    await this.attach(sessionId, true);
    this.emit({
      type: 'session_catalog',
      activeSessionId: sessionId,
      sessions: await this.listSessions(),
    });
    return { state: 'active', sessionId };
  }

  async deleteSession(sessionId: string): Promise<'deleted' | 'not_found' | 'active'> {
    if (sessionId === this._activeSessionId) return 'active';
    if (!this.activeWorkspaceId) return 'not_found';
    const deleted = await this.deps.catalog.archive(
      sessionId,
      this.activeWorkspaceId,
      WEB_WORKSPACE_PRINCIPAL,
    );
    if (!deleted) return 'not_found';
    if (this._activeSessionId) {
      this.emit({
        type: 'session_catalog',
        activeSessionId: this._activeSessionId,
        sessions: await this.listSessions(),
      });
    }
    return 'deleted';
  }

  async clearAllSessions(): Promise<{ deleted: number }> {
    const deleted = this.activeWorkspaceId
      ? await this.deps.catalog.clearWorkspace(
          this.activeWorkspaceId,
          WEB_WORKSPACE_PRINCIPAL,
          this._activeSessionId ?? undefined,
        )
      : 0;
    if (this._activeSessionId) {
      this.emit({
        type: 'session_catalog',
        activeSessionId: this._activeSessionId,
        sessions: await this.listSessions(),
      });
    }
    return { deleted };
  }

  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getReplayEvents(): WebSessionRuntimeEvent[] {
    return structuredClone(this.replayEvents);
  }

  private attach(sessionId: string, announceActive = false): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Web Gateway runtime is disposed'));
    const generation = this.attachGeneration += 1;
    const attachment = this.attachOnce(sessionId, generation, announceActive);
    this.pendingAttaches.add(attachment);
    return attachment.finally(() => {
      this.pendingAttaches.delete(attachment);
    });
  }

  private async attachOnce(
    sessionId: string,
    generation: number,
    announceActive: boolean,
  ): Promise<void> {
    const detachClient = await this.deps.gateway.attachClient(this.deps.accountId, sessionId);
    const detachOnce = once(detachClient);
    if (this.disposed) {
      detachOnce();
      throw new Error('Web Gateway runtime is disposed');
    }
    if (generation !== this.attachGeneration) {
      detachOnce();
      return;
    }
    this.unsubscribe?.();
    this.detachClient?.();
    this._activeSessionId = sessionId;
    this.replayEvents = [];
    this.resultAssemblies.clear();
    this.completedResults.clear();
    this.turnStates.clear();
    const existingRecord = await this.deps.catalog.read(sessionId, sessionId);
    for (const turn of existingRecord?.turns ?? []) {
      this.persistedTurnIds.add(turn.id);
      this.persistedTurns.set(turn.id, {
        status: turn.status,
        traceCount: turn.traceEvents.length,
        answerLength: turn.finalAnswer?.length ?? 0,
      });
      const taskId = turn.taskId
        ?? turn.executionTimeline?.taskId
        ?? inferTaskId(turn.userInput);
      const executionTimeline = timelineForTask(turn.executionTimeline, taskId);
      this.turnStates.set(turn.id, {
        id: turn.id,
        sessionId: turn.sessionId,
        requestId: null,
        userInput: turn.userInput,
        status: turn.status,
        finalAnswer: turn.finalAnswer,
        taskId,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        traceEvents: filterTraceEventsForTask(turn.traceEvents, taskId),
        executionTimeline: executionTimeline ? structuredClone(executionTimeline) : null,
        interactionKind: turn.interactionKind ?? interactionKindForInput(turn.userInput),
        backgroundWorkPending: false,
        artifacts: structuredClone(turn.artifacts ?? []),
      });
    }
    const buffered: GatewayEventEnvelope[] = [];
    let replaying = true;
    const unsubscribe = this.deps.gateway.subscribe(
      this.deps.accountId,
      sessionId,
      event => {
        if (this.disposed || generation !== this.attachGeneration) return;
        if (replaying) buffered.push(event);
        else this.consume(event, false);
      },
      this.connectionId,
    );
    const unsubscribeOnce = once(unsubscribe);
    this.unsubscribe = unsubscribeOnce;
    this.detachClient = detachOnce;

    let replay: GatewayReplay;
    try {
      replay = await this.deps.gateway.replay(this.deps.accountId, sessionId);
    } catch (error) {
      if (generation === this.attachGeneration) {
        unsubscribeOnce();
        this.unsubscribe = null;
        detachOnce();
        this.detachClient = null;
      }
      throw error;
    }
    if (this.disposed) {
      unsubscribeOnce();
      detachOnce();
      throw new Error('Web Gateway runtime is disposed');
    }
    if (generation !== this.attachGeneration) {
      unsubscribeOnce();
      detachOnce();
      return;
    }

    const seen = new Set<string>();
    for (const event of orderedUniqueReplayEvents(replay)) {
      seen.add(event.eventId);
      this.consume(event, true);
    }
    for (const event of orderedUniqueEvents(buffered)) {
      if (event.sequence <= replay.lastSequence || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      this.consume(event, true);
    }
    if (!this.workspaces.has(sessionId)) this.workspaces.set(sessionId, null);
    replaying = false;
    if (announceActive) this.emit({ type: 'active_session_changed', sessionId });
    this.emitInFlightTurns(sessionId);
  }

  /** 重新 attach 后，把该会话里仍未落库（仍在执行）的 turn 重新下发为实时事件，
   *  避免会话切换时运行中的 turn 从界面里消失。 */
  private emitInFlightTurns(sessionId: string): void {
    for (const state of this.turnStates.values()) {
      if (
        state.sessionId !== sessionId
        || state.status !== 'running'
        || !state.userInput.trim()
        || this.persistedTurnIds.has(state.id)
      ) continue;
      this.emit({
        type: 'turn_started',
        requestId: state.requestId ?? '',
        turnId: state.id,
        userInput: state.userInput,
        startedAt: state.startedAt,
        ...(state.interactionKind === 'system_command'
          ? { interactionKind: 'system_command' as const }
          : {}),
      });
      this.emit({
        type: 'trace_delta',
        turnId: state.id,
        fromSequence: state.traceEvents[0]?.sequence ?? 0,
        events: state.traceEvents,
        status: state.status,
        ...(state.completedAt !== null ? { completedAt: state.completedAt } : {}),
      });
      if (state.taskId && state.executionTimeline) {
        this.emit({
          type: 'execution',
          turnId: state.id,
          taskId: state.taskId,
          timeline: state.executionTimeline,
        });
      }
      if (state.taskId && state.artifacts.length > 0) {
        this.emit({
          type: 'artifacts',
          turnId: state.id,
          taskId: state.taskId,
          artifacts: state.artifacts,
        });
      }
    }
  }

  private consume(event: GatewayEventEnvelope, replay: boolean): void {
    const workspaceEvent = this.consumeWorkspaceEvent(event);
    if (workspaceEvent) {
      if (replay) this.replayEvents.push(workspaceEvent);
      else this.emit(workspaceEvent);
    }
    const userInput = event.requestId ? this.pendingInputs.get(event.requestId) : undefined;
    const state = this.rememberTurnEvent(event, userInput);
    const billing = state ? this.projectBilling(state) : null;
    const artifacts = state ? this.projectArtifactsFromState(state) : null;
    if (artifacts) {
      if (replay) this.replayEvents.push(artifacts);
      else this.emit(artifacts);
    }
    const presentationEvent = event.kind === 'trace_delta' && state
      ? traceEventWithNormalizedPresentation(event, state)
      : event;
    const resultEvent = this.consumeResultEvent(event);
    if (resultEvent?.type === 'result_completed' && state) {
      // final_answer intentionally carries no duplicate body for streamed
      // results. Promote the verified assembly into the Turn state before the
      // terminal snapshot is persisted.
      state.finalAnswer = resultEvent.content;
      this.turnStates.set(state.id, state);
    }
    if (resultEvent) {
      if (replay) this.replayEvents.push(resultEvent);
      else this.emit(resultEvent);
    }
    const mapped = mapGatewayEvent(
      presentationEvent,
      userInput,
      resultIdFromPayload(event.payload)
        ? this.completedResults.get(resultIdFromPayload(event.payload)!) ?? null
        : null,
    );
    if (mapped) {
      if (replay) this.replayEvents.push(mapped);
      else this.emit(mapped);
    }
    if (billing && state && (billing.queryBill || billing.taskUsageSummary)
      && (event.kind === 'turn_started' || event.kind === 'final_answer'
      || event.kind === 'terminal_error' || event.kind === 'trace_delta')) {
      const billingEvent: WebSessionRuntimeEvent = {
        type: 'billing',
        turnId: state!.id,
        queryBill: billing.queryBill,
        taskUsageSummary: billing.taskUsageSummary,
        turnBilling: billing.turnBilling,
      };
      if (replay) this.replayEvents.push(billingEvent);
      else this.emit(billingEvent);
    }
    if (!replay && state && (
      event.kind === 'final_answer' || event.kind === 'terminal_error'
      || (event.kind === 'trace_delta' && state.taskId && state.status !== 'running')
    )) {
      this.scheduleBillingRefresh(state.id, state.taskId);
    }
    const execution = this.projectExecutionFromEvent(event);
    if (execution) {
      if (replay) this.replayEvents.push(execution);
      else this.emit(execution);
    }
    if (
      event.kind === 'trace_delta'
      && state
      && state.backgroundWorkPending
      && state.status !== 'running'
      && event.requestId
    ) {
      void this.persistTerminalTurn(event, []);
    }
    if (event.kind === 'final_answer' && event.requestId) {
      this.pendingInputs.delete(event.requestId);
      // Persist a compatibility snapshot even while the public projection is
      // running, so durable Task facts can rehydrate this exact turn later.
      void this.persistTerminalTurn(event, mapped?.type === 'final_answer' ? mapped.lines : []);
    }
    if (event.kind === 'terminal_error' && event.requestId) {
      this.pendingInputs.delete(event.requestId);
      void this.persistTerminalTurn(event, []);
    }
  }

  private consumeWorkspaceEvent(event: GatewayEventEnvelope): WebSessionRuntimeEvent | null {
    if (event.kind !== 'conversation_snapshot' && event.kind !== 'workspace_changed') {
      return null;
    }
    const payload = asRecord(event.payload);
    if (!('workspace' in payload)) return null;
    const workspace = workspaceProjection(payload.workspace);
    this.workspaces.set(event.conversationId, workspace);
    return {
      type: 'workspace_changed',
      sessionId: event.conversationId,
      workspace,
    };
  }

  private async initializeWorkspace(workspaceHint: string): Promise<WorkspaceInitializationResult> {
    try {
      const requestId = this.id('req');
      const receipt = await this.deps.gateway.submit({
        protocolVersion: 2,
        requestId,
        idempotencyKey: this.id('idem'),
        connectionId: this.connectionId,
        scope: { kind: 'workspace' },
        command: { kind: 'select_workspace', path: workspaceHint },
        clientCapabilities: ['trace_v1'],
      });
      if ('kind' in receipt || receipt.status === 'rejected') {
        return {
          status: 'failed',
          reason: 'kind' in receipt
            ? receipt.message
            : receipt.reason ?? 'Gateway rejected Workspace initialization',
        };
      }
      if (!receipt.workspaceId) return { status: 'failed', reason: 'workspace_identity_missing' };
      this.activeWorkspaceId = receipt.workspaceId;
      this.followWorkspace(receipt.workspaceId);
      await this.emitWorkspaceDirectory(receipt.workspaceId);
      return { status: 'accepted' };
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private enqueueNavigation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.navigationQueue.then(operation, operation);
    this.navigationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async projectMetadata(
    metadata: WebSessionDirectoryMetadata,
  ): Promise<WebSessionDirectoryMetadataProjection>;
  private async projectMetadata(
    metadata: WebSessionMetadata,
  ): Promise<WebSessionMetadataProjection>;
  private async projectMetadata(
    metadata: WebSessionMetadata | WebSessionDirectoryMetadata,
  ): Promise<WebSessionMetadataProjection | WebSessionDirectoryMetadataProjection> {
    return {
      ...structuredClone(metadata),
      workspaceId: 'workspaceId' in metadata
        ? metadata.workspaceId
        : await this.deps.catalog.workspaceIdForConversation(metadata.id),
      workspace: await this.workspaceFor(metadata.id),
    };
  }

  private async projectRecord(
    record: WebSessionRecord | (
      Omit<WebSessionRecord, 'turns'>
      & { turns: import('./web-session-types.js').ConversationTurnProjection[] }
    ),
  ): Promise<WebSessionRecordProjection> {
    return {
      ...structuredClone(record),
      session: await this.projectMetadata(record.session),
    };
  }

  private async workspaceFor(
    sessionId: string,
  ): Promise<ConversationWorkspaceProjection | null> {
    if (this.workspaces.has(sessionId)) return this.workspaces.get(sessionId) ?? null;
    const replay = await this.deps.gateway.replay(this.deps.accountId, sessionId);
    let workspace: ConversationWorkspaceProjection | null = null;
    for (const event of orderedUniqueReplayEvents(replay)) {
      if (event.kind !== 'conversation_snapshot' && event.kind !== 'workspace_changed') continue;
      const payload = asRecord(event.payload);
      if ('workspace' in payload) workspace = workspaceProjection(payload.workspace);
    }
    this.workspaces.set(sessionId, workspace);
    return workspace;
  }

  private followWorkspace(workspaceId: string): void {
    this.workspaceUnsubscribe?.();
    this.workspaceUnsubscribe = this.deps.gateway.subscribe(
      this.deps.accountId,
      `workspace:${workspaceId}`,
      event => {
        if (this.disposed || this.activeWorkspaceId !== workspaceId) return;
        if (![
          'workspace_directory_snapshot',
          'workspace_conversation_upserted',
          'workspace_conversation_removed',
          'workspace_activity_changed',
          'workspace_availability_changed',
        ].includes(event.kind)) return;
        void this.emitWorkspaceDirectory(workspaceId);
      },
    );
  }

  private async emitWorkspaceDirectory(workspaceId: string): Promise<void> {
    if (this.disposed || this.activeWorkspaceId !== workspaceId) return;
    const sessions = await this.listSessions();
    if (this.disposed || this.activeWorkspaceId !== workspaceId) return;
    this.emit({
      type: 'workspace_directory',
      activeWorkspaceId: workspaceId,
      activeSessionId: this._activeSessionId,
      sessions,
    });
  }

  private rememberTurnEvent(
    event: GatewayEventEnvelope,
    userInput?: string,
  ): RuntimeTurnState | null {
    const turnId = event.turnId;
    if (!turnId) return null;
    const existing = this.turnStates.get(turnId);
    // Journal retention can leave result metadata after a Turn's context has
    // expired. Such fragments are not evidence of a new running interaction.
    if (!existing && [
      'result_delivery_available', 'result_chunk', 'result_completed', 'delivery_status',
    ].includes(event.kind)) return null;
    const state = existing ?? {
      id: turnId,
      sessionId: event.conversationId,
      requestId: event.requestId,
      userInput: userInput ?? '',
      status: 'running' as const,
      finalAnswer: null,
      taskId: null,
      startedAt: event.occurredAt,
      completedAt: null,
      traceEvents: [],
      executionTimeline: null,
      interactionKind: interactionKindForEvent(event),
      backgroundWorkPending: false,
      artifacts: [],
    };
    if (userInput && !state.userInput) state.userInput = userInput;
    state.taskId ??= inferTaskId(state.userInput);
    if (event.kind === 'turn_started') {
      state.requestId = event.requestId;
      state.startedAt = event.occurredAt;
      state.interactionKind = interactionKindForEvent(event);
    }
    if (event.kind === 'trace_delta') {
      const payload = asRecord(event.payload);
      const traceEvents = Array.isArray(payload.events)
        ? payload.events.filter(isInteractionTraceEvent)
        : [];
      // A replay has no browser-local pending input. Only the actual intake
      // can supply it; arbitrary progress fragments must not become blank turns.
      if (!state.userInput.trim()) {
        const query = traceEvents.find(item => item.kind === 'query_received'
          && item.actor === 'user' && item.phase === 'intake' && item.summary.trim());
        if (query) {
          state.userInput = query.summary;
          state.interactionKind = interactionKindForInput(query.summary);
        }
      }
      const payloadTaskId = stringValue(payload.taskId);
      state.taskId ??= payloadTaskId;
      const byId = new Map(state.traceEvents.map(item => [item.id, item]));
      let foreignEventCount = 0;
      for (const item of traceEvents) {
        const itemTaskId = traceEventTaskId(item);
        if (itemTaskId && (!state.taskId || itemTaskId !== state.taskId)) {
          foreignEventCount += 1;
          continue;
        }
        byId.set(item.id, item);
      }
      state.traceEvents = [...byId.values()].sort(compareTraceEvents);
      const traceMatchesTask = (
        !payloadTaskId
        || !state.taskId
        || payloadTaskId === state.taskId
      ) && (
        foreignEventCount === 0
        || Boolean(payloadTaskId && state.taskId && payloadTaskId === state.taskId)
      );
      const traceStatus = payload.status;
      if (
        traceMatchesTask
        && isInteractionTraceStatus(traceStatus)
        && canAdvanceTurnStatus(state.status, traceStatus)
      ) {
        state.status = traceStatus;
        state.completedAt = traceStatus === 'running' ? null : event.occurredAt;
      }
    }
    if (event.kind === 'final_answer') {
      const payload = asRecord(event.payload);
      state.backgroundWorkPending = payload.backgroundWorkPending === true;
      const lines = arrayStringValue(payload.lines);
      if (lines && lines.length > 0) state.finalAnswer = lines.join('\n');
      if (!state.backgroundWorkPending) {
        // The answer closes the turn, but never downgrades a terminal trace
        // status (blocked/failed/cancelled) observed before the answer arrived.
        if (state.status === 'running') {
          state.status = 'completed';
        }
        state.completedAt ??= event.occurredAt;
      }
    } else if (event.kind === 'terminal_error') {
      state.status = 'failed';
      state.completedAt = event.occurredAt;
      state.finalAnswer = stringValue(asRecord(event.payload).message) ?? state.finalAnswer;
    }
    const normalizedState = this.normalizeRuntimeState(state);
    this.turnStates.set(turnId, normalizedState);
    return normalizedState;
  }

  private projectExecutionFromEvent(event: GatewayEventEnvelope): WebSessionRuntimeEvent | null {
    if (event.kind !== 'trace_delta' || !this.deps.projectExecutionTimeline || !event.turnId) {
      return null;
    }
    const state = this.turnStates.get(event.turnId);
    const taskId = state?.taskId ?? null;
    if (!state || !taskId) return null;
    const timeline = timelineForTask(this.deps.projectExecutionTimeline(taskId), taskId);
    if (!timeline) return null;
    state.executionTimeline = structuredClone(timeline);
    const eventPayload = {
      type: 'execution',
      turnId: event.turnId,
      taskId,
      timeline,
    } as const;
    return eventPayload;
  }

  private async persistTerminalTurn(
    event: GatewayEventEnvelope,
    finalLines: string[],
  ): Promise<void> {
    if (!event.turnId) return;
    const state = this.turnStates.get(event.turnId);
    if (!state || !state.userInput) return;
    const finalAnswer = finalLines.length > 0
      ? finalLines.join('\n')
      : state.finalAnswer ?? '';
    const richness = {
      status: state.status,
      traceCount: state.traceEvents.length,
      answerLength: finalAnswer.length,
    };
    const previous = this.persistedTurns.get(event.turnId);
    if (
      previous
      && previous.status === richness.status
      && previous.traceCount >= richness.traceCount
      && previous.answerLength >= richness.answerLength
    ) return;
    const status = state.status === 'failed'
      ? 'failed'
      : state.status === 'blocked' ? 'blocked' : 'completed';
    const taskId = state.taskId ?? inferTaskId(state.userInput);
    const executionTimeline = taskId
      ? timelineForTask(this.deps.projectExecutionTimeline?.(taskId) ?? null, taskId)
        ?? timelineForTask(state.executionTimeline, taskId)
      : null;
    const artifacts = taskId
      ? mergeArtifacts(
        state.artifacts,
        this.deps.projectTaskArtifacts?.(taskId) ?? [],
      )
      : state.artifacts;
    this.persistedTurns.set(event.turnId, richness);
    this.persistedTurnIds.add(event.turnId);
    const appended = await this.deps.catalog.appendTurn(event.conversationId, {
      id: state.id,
      sessionId: event.conversationId,
      userInput: state.userInput,
      interactionKind: state.interactionKind,
      status,
      finalAnswer,
      taskId,
      startedAt: state.startedAt,
      completedAt: state.completedAt ?? event.occurredAt,
      traceEvents: state.traceEvents,
      executionTimeline,
      artifactRefs: artifacts.map(artifact => artifact.relativePath),
      artifacts,
    });
    if (!appended || this.disposed || !this._activeSessionId) return;
    const sessions = await this.listSessions();
    if (this.disposed || !this._activeSessionId) return;
    this.emit({
      type: 'session_catalog',
      activeSessionId: this._activeSessionId,
      sessions,
    });
  }

  private enrichRecord(record: WebSessionRecord) {
    const taskIds = record.turns.map(turn => (
      turn.taskId
      ?? turn.executionTimeline?.taskId
      ?? inferTaskId(turn.userInput)
    ));
    const latestTurnByTask = new Map<string, number>();
    taskIds.forEach((taskId, index) => {
      if (taskId) latestTurnByTask.set(taskId, index);
    });
    const timelineByTask = new Map<string, ExecutionTimeline | null>();
    const artifactsByTask = new Map<string, ArtifactProjection[]>();
    return {
      ...structuredClone(record),
      turns: record.turns.map((turn, index) => {
        const taskId = taskIds[index];
        const hydrateDurableFacts = Boolean(
          taskId && latestTurnByTask.get(taskId) === index,
        );
        return this.enrichTurn(
          turn,
          taskId,
          hydrateDurableFacts,
          timelineByTask,
          artifactsByTask,
        );
      }),
    };
  }

  private projectArtifactsFromState(
    state: RuntimeTurnState,
  ): WebSessionRuntimeEvent | null {
    if (!state.taskId || !this.deps.projectTaskArtifacts) return null;
    let projected: ArtifactProjection[];
    try {
      projected = this.deps.projectTaskArtifacts(state.taskId);
    } catch {
      return null;
    }
    const artifacts = mergeArtifacts(state.artifacts, projected);
    if (artifactListsEqual(state.artifacts, artifacts)) return null;
    state.artifacts = artifacts;
    return {
      type: 'artifacts',
      turnId: state.id,
      taskId: state.taskId,
      artifacts,
    };
  }

  private enrichTurn(
    turn: ConversationTurn,
    taskId: string | null,
    hydrateDurableFacts: boolean,
    timelineByTask: Map<string, ExecutionTimeline | null>,
    artifactsByTask: Map<string, ArtifactProjection[]>,
  ): import('./web-session-types.js').ConversationTurnProjection {
    const billing = this.projectBillingForTurn(turn.id, taskId, isSystemCommandTurn(turn));
    if (!taskId) {
      return {
        ...structuredClone(turn),
        traceEvents: filterTraceEventsForTask(turn.traceEvents, null),
        queryBill: billing.queryBill,
        taskUsageSummary: billing.taskUsageSummary,
        turnBilling: billing.turnBilling,
      };
    }
    if (!hydrateDurableFacts) {
      const executionTimeline = timelineForTask(turn.executionTimeline, taskId);
      return {
        ...structuredClone(turn),
        taskId,
        traceEvents: filterTraceEventsForTask(turn.traceEvents, taskId),
        executionTimeline: executionTimeline ? structuredClone(executionTimeline) : null,
        queryBill: billing.queryBill,
        taskUsageSummary: billing.taskUsageSummary,
        turnBilling: billing.turnBilling,
      };
    }
    if (!timelineByTask.has(taskId)) {
      const projectedTimeline = this.deps.projectExecutionTimeline?.(taskId) ?? null;
      timelineByTask.set(
        taskId,
        timelineForTask(projectedTimeline, taskId)
          ?? timelineForTask(turn.executionTimeline, taskId),
      );
    }
    if (!artifactsByTask.has(taskId)) {
      artifactsByTask.set(
        taskId,
        this.deps.projectTaskArtifacts?.(taskId) ?? [],
      );
    }
    const executionTimeline = timelineByTask.get(taskId) ?? null;
    const projectedArtifacts = artifactsByTask.get(taskId) ?? [];
    const artifacts = mergeArtifacts(turn.artifacts, projectedArtifacts);
    const artifactRefs = [...new Set([
      ...turn.artifactRefs,
      ...artifacts.map(artifact => artifact.relativePath),
    ])];
    const projectedStatus = executionTimeline
      ? turnStatusFromTimeline(executionTimeline)
      : null;
    return {
      ...structuredClone(turn),
      status: projectedStatus ?? turn.status,
      completedAt: projectedStatus === 'running' ? null : turn.completedAt,
      taskId,
      traceEvents: filterTraceEventsForTask(turn.traceEvents, taskId),
      executionTimeline: executionTimeline ? structuredClone(executionTimeline) : null,
      artifactRefs,
      artifacts,
      queryBill: billing.queryBill,
      taskUsageSummary: billing.taskUsageSummary,
      turnBilling: billing.turnBilling,
    };
  }

  private projectBilling(state: RuntimeTurnState): {
    queryBill: QueryBillProjection | null;
    taskUsageSummary: TaskUsageSummary | null;
    turnBilling: TurnBillUserView | null;
  } {
    return this.projectBillingForTurn(state.id, state.taskId, false, true);
  }

  private projectBillingForTurn(
    turnId: string,
    taskId: string | null,
    systemCommand = false,
    liveTurn = false,
  ): {
    queryBill: QueryBillProjection | null;
    taskUsageSummary: TaskUsageSummary | null;
    turnBilling: TurnBillUserView | null;
  } {
    const billing = this.deps.billing;
    if (!billing) {
      if (systemCommand) return { queryBill: null, taskUsageSummary: null, turnBilling: null };
      const projectedAt = this.deps.now?.() ?? new Date().toISOString();
      return {
        queryBill: null,
        taskUsageSummary: null,
        turnBilling: {
          turnId,
          queryId: null,
          conversationId: null,
          taskId,
          userStatus: 'unconfirmed',
          headline: '费用暂时无法确认',
          amountMicroCoin: null,
          amountIsFinal: false,
          diagnosticCode: 'missing_billing_projection',
          diagnosticMessage: '账单事实存在，但页面投影暂时不可用',
          observedUsageCount: 0,
          missingCategories: [],
          usageBreakdown: [],
          stageBreakdown: [],
          billId: null,
          finalizedAt: null,
          projectedAt,
        },
      };
    }
    // 系统命令 Turn 不产生账单卡（账单简化设计 §3.1）。
    const queryBill = billing.getQueryBillForTurn(this.deps.accountId, turnId);
    let turnBilling: TurnBillUserView | null = null;
    if (!systemCommand) {
      try {
        turnBilling = billing.getTurnBillUserView(this.deps.accountId, turnId, {
          liveFallback: liveTurn,
        });
      } catch {
        // 投影失败也必须给用户明确原因，不得静默空白（账单简化设计 §5）。
        turnBilling = {
          turnId,
          queryId: queryBill?.queryId ?? null,
          conversationId: queryBill?.conversationId ?? null,
          taskId,
          userStatus: 'unconfirmed',
          headline: '费用暂时无法确认',
          amountMicroCoin: null,
          amountIsFinal: false,
          diagnosticCode: 'missing_billing_projection',
          diagnosticMessage: '账单事实存在，但页面投影暂时不可用',
          observedUsageCount: 0,
          missingCategories: [],
          usageBreakdown: [],
          stageBreakdown: [],
          billId: queryBill?.billId ?? null,
          finalizedAt: null,
          projectedAt: this.deps.now?.() ?? new Date().toISOString(),
        };
      }
    }
    return {
      queryBill,
      taskUsageSummary: taskId
        ? billing.getTaskUsageSummaryForAccount(this.deps.accountId, taskId)
        : null,
      turnBilling,
    };
  }

  private scheduleBillingRefresh(turnId: string, taskId: string | null): void {
    if (!this.deps.billing || this.billingRefreshTimers.has(turnId)) return;
    const delays = [250, 1_000, 3_000, 10_000];
    const timers: ReturnType<typeof setTimeout>[] = [];
    delays.forEach((delay, index) => {
      const timer = setTimeout(() => {
        const billing = this.projectBillingForTurn(turnId, taskId, false, true);
        // 最后一次刷新无论如何都发布：账单卡必须出现，没有金额时给出原因。
        const finalTick = index === delays.length - 1;
        if (finalTick || billing.queryBill || billing.turnBilling || billing.taskUsageSummary) {
          this.emit({
            type: 'billing',
            turnId,
            queryBill: billing.queryBill,
            taskUsageSummary: billing.taskUsageSummary,
            turnBilling: billing.turnBilling,
          });
        }
        if (finalTick) this.billingRefreshTimers.delete(turnId);
      }, delay);
      timers.push(timer);
    });
    for (const timer of timers) timer.unref?.();
    this.billingRefreshTimers.set(turnId, timers);
  }

  private consumeResultEvent(event: GatewayEventEnvelope): WebSessionRuntimeEvent | null {
    if (!event.requestId || !event.turnId) return null;
    const payload = asRecord(event.payload);
    const resultId = stringValue(payload.resultId);
    if (!resultId) return null;
    if (event.kind === 'result_delivery_available') {
      const metadata = resultMetadata(payload);
      if (!metadata) return null;
      this.resultAssemblies.set(resultId, { ...metadata, chunks: new Map() });
      return {
        type: 'result_delivery_available',
        requestId: event.requestId,
        turnId: event.turnId,
        resultId,
        ...metadata,
      };
    }
    if (event.kind === 'result_chunk') {
      const offset = nonNegativeInteger(payload.offset);
      const chunk = stringValue(payload.chunk);
      if (offset === null || chunk === null) return null;
      const assembly = this.resultAssemblies.get(resultId);
      if (assembly) assembly.chunks.set(offset, chunk);
      return {
        type: 'result_chunk',
        requestId: event.requestId,
        turnId: event.turnId,
        resultId,
        offset,
        chunk,
      };
    }
    if (event.kind === 'result_completed') {
      const metadata = resultMetadata(payload);
      const assembly = this.resultAssemblies.get(resultId);
      if (!metadata || !assembly) return null;
      const content = [...assembly.chunks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, chunk]) => chunk)
        .join('');
      const bytes = Buffer.from(content, 'utf8');
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (bytes.byteLength !== metadata.byteLength || hash !== metadata.contentHash) {
        return null;
      }
      this.completedResults.set(resultId, content);
      return {
        type: 'result_completed',
        requestId: event.requestId,
        turnId: event.turnId,
        resultId,
        content,
        ...metadata,
      };
    }
    return null;
  }

  private emit(event: WebSessionRuntimeEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  private normalizeRuntimeState(state: RuntimeTurnState): RuntimeTurnState {
    if (!this.deps.normalizeTurnPresentation) return state;
    const normalized = this.deps.normalizeTurnPresentation({
      id: state.id,
      sessionId: state.sessionId,
      userInput: state.userInput,
      status: state.status === 'running' ? 'completed' : state.status,
      finalAnswer: state.finalAnswer,
      taskId: state.taskId,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      traceEvents: state.traceEvents,
      executionTimeline: state.executionTimeline,
      artifactRefs: [],
      artifacts: state.artifacts,
    });
    return {
      ...state,
      taskId: normalized.taskId,
      traceEvents: normalized.traceEvents,
      executionTimeline: normalized.executionTimeline,
    };
  }

  private id(prefix: string): string {
    return this.deps.createId?.(prefix) ?? `${prefix}_${nanoid(12)}`;
  }
}

export class WebGatewaySessionRuntime {
  private readonly clients = new Map<string, WebGatewayClientSession>();
  private initialized = false;
  private disposed = false;

  constructor(private readonly deps: WebGatewaySessionRuntimeDeps) {}

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    if (this.initialized) return;
    await this.deps.catalog.initialize();
    this.initialized = true;
  }

  async closeClient(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
    await client.dispose();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(client => client.dispose()));
  }

  getClientState(clientId: string) {
    return this.client(clientId).getState();
  }

  listWorkspaces(clientId: string) {
    return this.client(clientId).listWorkspaces();
  }

  selectWorkspace(clientId: string, path: string): Promise<WorkspaceInitializationResult> {
    return this.client(clientId).selectWorkspace(path);
  }

  cancelTurn(clientId: string, turnId: string): Promise<void> {
    return this.client(clientId).cancelTurn(turnId);
  }

  submit(
    clientId: string,
    text: string,
    attachments?: Array<{ attachmentId: string; kind: string }>,
  ): Promise<void> {
    return this.client(clientId).submit(text, attachments);
  }

  listSessions(clientId: string, query?: string): Promise<WebSessionDirectoryMetadataProjection[]> {
    return this.client(clientId).listSessions(query);
  }

  readSession(clientId: string, sessionId: string): Promise<WebSessionRecordProjection | null> {
    return this.client(clientId).readSession(sessionId);
  }

  listBillingRecords(
    clientId: string,
    input: {
      readonly cursor?: string;
      readonly filter?: BillingStatusFilter;
      readonly limit?: number;
    } = {},
  ): Promise<BillingRecordPageView> {
    return this.client(clientId).listBillingRecords(input);
  }

  listBillingTasks(clientId: string): Promise<readonly BillingTaskView[]> {
    return this.client(clientId).listBillingTasks();
  }

  getTaskBillingDetail(clientId: string, taskId: string): Promise<TaskBillingDetailView | null> {
    return this.client(clientId).getTaskBillingDetail(taskId);
  }

  createSession(clientId: string): Promise<WebSessionCreationResult> {
    return this.client(clientId).createSession();
  }

  activateSession(clientId: string, sessionId: string): Promise<WebSessionActivationResult> {
    return this.client(clientId).activateSession(sessionId);
  }

  deleteSession(
    clientId: string,
    sessionId: string,
  ): Promise<'deleted' | 'not_found' | 'active'> {
    return this.client(clientId).deleteSession(sessionId);
  }

  clearAllSessions(clientId: string): Promise<{ deleted: number }> {
    return this.client(clientId).clearAllSessions();
  }

  subscribe(
    clientId: string,
    listener: (event: WebSessionRuntimeEvent) => void,
  ): () => void {
    return this.client(clientId).subscribe(listener);
  }

  getReplayEvents(clientId: string): WebSessionRuntimeEvent[] {
    return this.client(clientId).getReplayEvents();
  }

  private client(clientId: string): WebGatewayClientSession {
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    const existing = this.clients.get(clientId);
    if (existing) return existing;
    const created = new WebGatewayClientSession(this.deps, clientId);
    this.clients.set(clientId, created);
    return created;
  }
}

function traceEventWithNormalizedPresentation(
  event: GatewayEventEnvelope,
  state: RuntimeTurnState,
): GatewayEventEnvelope {
  const payload = asRecord(event.payload);
  const incoming = Array.isArray(payload.events)
    ? payload.events.filter(isInteractionTraceEvent)
    : [];
  const ids = new Set(incoming.map(item => item.id));
  return {
    ...event,
    payload: {
      ...payload,
      status: state.status,
      completedAt: state.completedAt,
      events: state.traceEvents.filter(item => ids.has(item.id)),
    },
  };
}

function once(operation: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    operation();
  };
}

function orderedUniqueReplayEvents(replay: GatewayReplay): GatewayEventEnvelope[] {
  return orderedUniqueEvents([...replay.snapshot, ...replay.deltas]);
}

function orderedUniqueEvents(events: GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    .filter(event => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}

function mapGatewayEvent(
  event: GatewayEventEnvelope,
  userInput?: string,
  completedResult: string | null = null,
): WebSessionRuntimeEvent | null {
  if (event.kind === 'turn_started') {
    if (!event.requestId || !event.turnId || !userInput) return null;
    return {
      type: 'turn_started',
      requestId: event.requestId,
      turnId: event.turnId,
      userInput,
      startedAt: event.occurredAt,
      ...(interactionKindForEvent(event) === 'system_command'
        ? { interactionKind: 'system_command' as const }
        : {}),
    };
  }
  if (event.kind === 'conversation_snapshot') {
    const payload = event.payload as { from?: number; lines?: string[] };
    return {
      type: 'output',
      from: payload.from ?? 0,
      lines: payload.lines ?? [],
    };
  }
  if (event.kind === 'trace_delta') {
    const payload = event.payload as {
      turnId?: string;
      events?: InteractionTraceEvent[];
      status?: unknown;
      completedAt?: string | null;
    };
    return {
      type: 'trace_delta',
      turnId: payload.turnId ?? event.turnId ?? 'turn_unknown',
      fromSequence: payload.events?.[0]?.sequence ?? 0,
      events: payload.events ?? [],
      ...(isInteractionTraceStatus(payload.status) ? { status: payload.status } : {}),
      ...(typeof payload.completedAt === 'string' || payload.completedAt === null
        ? { completedAt: payload.completedAt }
        : {}),
    };
  }
  if (event.kind === 'terminal_error') {
    const payload = event.payload as { message?: string };
    if (!event.requestId || !event.turnId) return null;
    return {
      type: 'terminal_error',
      requestId: event.requestId,
      turnId: event.turnId,
      message: payload.message ?? 'Gateway execution failed',
      completedAt: event.occurredAt,
    };
  }
  if (event.kind === 'final_answer') {
    const payload = event.payload as {
      lines?: string[];
      backgroundWorkPending?: boolean;
    };
    if (!event.requestId || !event.turnId) return null;
    return {
      type: 'final_answer',
      requestId: event.requestId,
      turnId: event.turnId,
      lines: payload.lines && payload.lines.length > 0
        ? payload.lines
        : completedResult?.split('\n') ?? [],
      completedAt: event.occurredAt,
      ...(payload.backgroundWorkPending === true
        ? { backgroundWorkPending: true }
        : {}),
    };
  }
  return null;
}

interface ResultAssembly {
  contentHash: string;
  byteLength: number;
  completeness: 'complete' | 'partial' | 'incomplete';
  certification: 'certified' | 'uncertified';
  chunks: Map<number, string>;
}

function resultMetadata(payload: Record<string, unknown>): Omit<ResultAssembly, 'chunks'> | null {
  const contentHash = stringValue(payload.contentHash);
  const byteLength = nonNegativeInteger(payload.byteLength);
  const completeness = payload.completeness;
  const certification = payload.certification;
  if (
    !contentHash
    || byteLength === null
    || !['complete', 'partial', 'incomplete'].includes(String(completeness))
    || !['certified', 'uncertified'].includes(String(certification))
  ) {
    return null;
  }
  return {
    contentHash,
    byteLength,
    completeness: completeness as ResultAssembly['completeness'],
    certification: certification as ResultAssembly['certification'],
  };
}

function resultIdFromPayload(payload: unknown): string | null {
  return stringValue(asRecord(payload).resultId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function workspaceProjection(value: unknown): ConversationWorkspaceProjection | null {
  const workspace = asRecord(value);
  const path = stringValue(workspace.path);
  const selectedAt = stringValue(workspace.selectedAt);
  return path && selectedAt ? { path, selectedAt } : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

interface RuntimeTurnState {
  id: string;
  sessionId: string;
  requestId: string | null;
  userInput: string;
  status: InteractionTraceStatus;
  finalAnswer: string | null;
  taskId: string | null;
  startedAt: string;
  completedAt: string | null;
  traceEvents: InteractionTraceEvent[];
  executionTimeline: ExecutionTimeline | null;
  interactionKind: 'system_command' | 'ai_turn';
  backgroundWorkPending: boolean;
  artifacts: ArtifactProjection[];
}

function interactionKindForEvent(
  event: GatewayEventEnvelope,
): 'system_command' | 'ai_turn' {
  return asRecord(event.payload).commandKind === 'user_message'
    ? 'ai_turn'
    : 'system_command';
}

function interactionKindForInput(input: string): 'system_command' | 'ai_turn' {
  return input.trim().startsWith('/') ? 'system_command' : 'ai_turn';
}

function isInteractionTraceStatus(value: unknown): value is InteractionTraceStatus {
  return value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'blocked'
    || value === 'cancelled';
}

function canAdvanceTurnStatus(
  current: InteractionTraceStatus,
  incoming: InteractionTraceStatus,
): boolean {
  if (current === 'cancelled') return incoming === 'cancelled';
  return current === 'running' || incoming !== 'running';
}

function isInteractionTraceEvent(value: unknown): value is InteractionTraceEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string'
    && typeof event.sequence === 'number'
    && typeof event.kind === 'string'
    && typeof event.title === 'string'
    && typeof event.summary === 'string'
    && typeof event.details === 'object'
    && event.details !== null;
}

function compareTraceEvents(
  left: InteractionTraceEvent,
  right: InteractionTraceEvent,
): number {
  return left.sequence - right.sequence
    || left.occurredAt.localeCompare(right.occurredAt)
    || left.id.localeCompare(right.id);
}

function traceEventTaskId(event: InteractionTraceEvent): string | null {
  return event.taskId ?? stringValue(event.details.taskId);
}

function filterTraceEventsForTask(
  events: InteractionTraceEvent[],
  taskId: string | null,
): InteractionTraceEvent[] {
  return events
    .filter(event => {
      const eventTaskId = traceEventTaskId(event);
      return !eventTaskId || eventTaskId === taskId;
    })
    .map(event => structuredClone(event));
}

function timelineForTask(
  timeline: ExecutionTimeline | null | undefined,
  taskId: string | null,
): ExecutionTimeline | null {
  return timeline && taskId && timeline.taskId === taskId ? timeline : null;
}

function arrayStringValue(value: unknown): string[] | null {
  return Array.isArray(value)
    && value.every(item => typeof item === 'string')
    ? value as string[]
    : null;
}

function inferTaskId(userInput: string): string | null {
  const match = /^\/task\s+(?:resume|unblock|recover)\s+([A-Za-z0-9_.:-]+)(?:\s|$)/iu.exec(
    userInput.trim(),
  );
  return match?.[1] ?? null;
}

function mergeArtifacts(
  current: ArtifactProjection[],
  projected: ArtifactProjection[],
): ArtifactProjection[] {
  const byId = new Map<string, ArtifactProjection>();
  for (const artifact of [...current, ...projected]) {
    byId.set(artifact.artifactId, structuredClone(artifact));
  }
  return [...byId.values()].sort(
    (left, right) => left.publishedAt.localeCompare(right.publishedAt)
      || left.artifactId.localeCompare(right.artifactId),
  );
}

function artifactListsEqual(
  left: ArtifactProjection[],
  right: ArtifactProjection[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((artifact, index) => (
    JSON.stringify(artifact) === JSON.stringify(right[index])
  ));
}
