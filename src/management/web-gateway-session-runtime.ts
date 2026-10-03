import { nanoid } from 'nanoid';
import { measureNavigationStage, measureNavigationStageSync } from '../utils/navigation-diagnostics.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type {
  InteractionTraceEvent,
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
import { workspaceEventStreamId } from '../gateway/workspace-event-stream.js';

export interface WebGatewaySessionRuntimeDeps {
  readonly accountId: string;
  readonly catalog: WebSessionRuntimeCatalog;
  readonly gateway: WebGatewayAdapter;
  /** Canonical point read; billing must not depend on a former Web presentation writer. */
  readonly readBillingTurnFacts?: (conversationId: string, turnId: string) => Promise<{
    userInput: string;
    traceEvents?: ConversationTurn['traceEvents'];
  } | null>;
  /** 会话附件存储；提供后用户消息可携带附件并自动增强 Planner 提示。 */
  readonly attachments?: GatewayAttachmentStore;
  /** Read-only durable execution projection used to rebuild a turn after reconnect. */
  readonly projectExecutionTimeline?: (taskId: string) => ExecutionTimeline | null;
  readonly projectExecutionTimelines?: (taskIds: readonly string[]) => ReadonlyMap<string, ExecutionTimeline | null>;
  /** Explicit account/Task authorization for billing detail projections. */
  readonly authorizeTask?: (accountId: string, taskId: string) => boolean;
  /** Account-scoped historical Task catalog used by the billing page. */
  readonly listAccountTasks?: (accountId: string) => readonly {
    id: string;
    title: string;
  }[];
  /** Read-only published artifact projection used to rebuild completed turns. */
  readonly projectTaskArtifacts?: (taskId: string) => ArtifactProjection[];
  readonly projectTasksArtifacts?: (taskIds: readonly string[]) => ReadonlyMap<string, ArtifactProjection[]>;
  /** Read-only durable Query -> Task association used to rebuild legacy Turns. */
  readonly resolveTaskIdForTurn?: (turnId: string) => string | null;
  readonly resolveTaskIdsForTurns?: (turnIds: readonly string[]) => ReadonlyMap<string, string | null>;
  /** Read-only billing projection shared with the other Gateway surfaces. */
  readonly billing?: BillQueryService;
  readonly normalizeTurnPresentation?: (turn: ConversationTurn) => ConversationTurn;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

class WebGatewayClientSession {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private readonly workspaces = new Map<string, ConversationWorkspaceProjection | null>();
  private workspaceUnsubscribe: (() => void) | null = null;
  private _activeSessionId: string | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private activeWorkspaceId: string | null = null;
  private navigationQueue: Promise<void> = Promise.resolve();

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
    this.workspaceUnsubscribe?.();
    this.workspaceUnsubscribe = null;
    this._activeSessionId = null;
    this.workspaces.clear();
    this.deps.gateway.closeConnection?.(this.connectionId);
    this.disposePromise = this.navigationQueue;

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
    return (await this.listSessionPage({ query })).items;
  }

  async listSessionPage(request: { query?: string; cursor?: string } = {}) {
    if (!this.activeWorkspaceId) return { items: [], nextCursor: null };
    const query = request.query ?? '';
    const input = {
      workspaceId: this.activeWorkspaceId,
      principalId: WEB_WORKSPACE_PRINCIPAL,
      activeConversationId: this._activeSessionId,
      ...(query.trim() ? { query } : {}),
    };
    const page = this.deps.catalog.listPage
      ? await this.deps.catalog.listPage({ ...input, cursor: request.cursor })
      : { items: query.trim()
          ? await this.deps.catalog.search(input)
          : await this.deps.catalog.list(input), nextCursor: null };
    // A directory is a summary, not permission to hydrate every Conversation.
    // Workspace binding comes from the directory; detailed workspace facts are
    // populated only by an authorized attachment.
    return {
      ...page,
      items: page.items.map(session => ({
        ...structuredClone(session),
        workspace: this.workspaces.get(session.id) ?? null,
      })),
    };
  }
  async readSession(sessionId: string, cursor?: string): Promise<WebSessionRecordProjection | null> {
    if (sessionId !== this._activeSessionId) return null;
    const record = await measureNavigationStage('record_read', () => this.deps.catalog.readPage
      ? this.deps.catalog.readPage(sessionId, this._activeSessionId, { cursor })
      : this.deps.catalog.read(sessionId, this._activeSessionId));
    if (!record) return null;
    return this.projectRecord(measureNavigationStageSync(
      'history_enrichment', () => this.enrichRecord(record), record.turns.length,
    ));
  }

  async readBrowsableSession(sessionId: string, cursor?: string): Promise<WebSessionRecordProjection | null> {
    if (!this.activeWorkspaceId) return null;
    const workspaceId = await this.deps.catalog.workspaceIdForConversation(sessionId);
    if (!workspaceId || workspaceId !== this.activeWorkspaceId) return null;
    const record = await measureNavigationStage(
      'record_browse_read', () => this.deps.catalog.readPage
        ? this.deps.catalog.readPage(sessionId, this._activeSessionId, { cursor })
        : this.deps.catalog.read(sessionId, this._activeSessionId),
    );
    if (!record) return null;
    return this.projectRecord(measureNavigationStageSync(
      'history_browse_enrichment', () => this.enrichRecord(record), record.turns.length,
    ));
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
      const turn = await (this.deps.readBillingTurnFacts ?? this.deps.catalog.readTurn?.bind(this.deps.catalog))?.(bill.conversationId, bill.turnId).catch(() => null) ?? null;
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
      const turn = await (this.deps.readBillingTurnFacts ?? this.deps.catalog.readTurn?.bind(this.deps.catalog))?.(bill.conversationId, bill.turnId).catch(() => null) ?? null;
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
    const metadata = await this.deps.catalog.readMetadata?.(receipt.conversationId);
    const created = metadata
      ? { version: 1 as const, session: { ...metadata, active: true }, turns: [], historyCursor: null }
      : await this.deps.catalog.read(receipt.conversationId);
    if (!created) throw new Error('created_conversation_unavailable');
    const activation = await this.activateSessionNow(created.session.id, created);
    return {
      session: await this.projectRecord(created),
      activation,
    };
  }

  async activateSession(sessionId: string, expectedWorkspaceId?: string): Promise<WebSessionActivationResult> {
    return this.enqueueNavigation(() => this.activateSessionNow(sessionId, undefined, expectedWorkspaceId));
  }

  private async activateSessionNow(
    sessionId: string, created?: WebSessionRecord, expectedWorkspaceId?: string,
  ): Promise<WebSessionActivationResult> {
    const metadata = created ? created.session : await this.deps.catalog.readMetadata?.(sessionId);
    const fallback = !created && !this.deps.catalog.readMetadata ? await this.deps.catalog.read(sessionId) : null;
    const target = metadata ?? fallback?.session;
    if (!target || target.archived) {
      return { state: 'activation_blocked', sessionId, reason: 'session_unavailable' };
    }
    const workspaceId = 'workspaceId' in target && typeof target.workspaceId === 'string'
      ? target.workspaceId : await this.deps.catalog.workspaceIdForConversation(sessionId);
    if (!workspaceId || (expectedWorkspaceId !== undefined && workspaceId !== expectedWorkspaceId)) {
      return { state: 'activation_blocked', sessionId, reason: 'session_unavailable' };
    }
    this.activeWorkspaceId = workspaceId;
    this.deps.gateway.restoreWorkspace?.(this.connectionId, workspaceId);
    this.followWorkspace(workspaceId);
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    this._activeSessionId = sessionId;
    this.emit({ type: 'active_session_changed', sessionId });
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
    this.emit({
      type: 'workspace_conversation_changed', workspaceId: this.activeWorkspaceId,
      conversationId: sessionId, removed: true,
    });
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
      const page = await this.listSessionPage();
      this.emit({
        type: 'session_catalog',
        activeSessionId: this._activeSessionId,
        sessions: page.items, nextCursor: page.nextCursor,
      });
    }
    return { deleted };
  }

  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getReplayEvents(): WebSessionRuntimeEvent[] {
    return [];
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
      if (receipt.directory) {
        const { workspace, page } = receipt.directory;
        const conversations = page.items.map(item => ({
          id: item.conversationId, workspaceId: item.workspaceId,
          title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt,
          archived: item.archived, preview: item.preview, activity: item.activity,
          active: item.conversationId === this._activeSessionId,
          workspace: this.workspaces.get(item.conversationId) ?? null,
        }));
        this.emit({
          type: 'workspace_directory', activeWorkspaceId: workspace.id,
          activeSessionId: this._activeSessionId, sessions: conversations,
          nextCursor: page.nextCursor,
        });
        return {
          status: 'accepted', workspace, conversations, nextCursor: page.nextCursor,
          projectionVersion: page.projectionVersion,
        };
      }
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
    const id = await this.deps.catalog.workspaceIdForConversation(sessionId);
    const entry = id ? (await this.deps.catalog.listWorkspaces(WEB_WORKSPACE_PRINCIPAL)).find(item => item.id === id) : null;
    const workspace = entry ? { path: entry.canonicalPath, selectedAt: entry.updatedAt } : null;
    this.workspaces.set(sessionId, workspace);
    while (this.workspaces.size > 32) this.workspaces.delete(this.workspaces.keys().next().value!);
    return workspace;
  }

  private followWorkspace(workspaceId: string): void {
    this.workspaceUnsubscribe?.();
    this.workspaceUnsubscribe = this.deps.gateway.subscribe(
      this.deps.accountId,
      workspaceEventStreamId(workspaceId),
      event => {
        if (this.disposed || this.activeWorkspaceId !== workspaceId) return;
        const payload = asRecord(event.payload);
        if (event.kind === 'workspace_activity_changed') {
          const conversationId = stringValue(payload.conversationId);
          const activity = asRecord(payload.activity);
          if (!conversationId || !['idle', 'planning', 'queued', 'executing', 'waiting', 'blocked'].includes(String(activity.state))
            || typeof activity.updatedAt !== 'string') return;
          this.emit({
            type: 'workspace_conversation_changed', workspaceId, conversationId,
            changes: { activity: {
              state: activity.state as WebSessionDirectoryMetadata['activity']['state'],
              taskId: stringValue(activity.taskId), updatedAt: activity.updatedAt,
            } },
          });
          return;
        }
        if (event.kind === 'workspace_conversation_removed') {
          const conversationId = stringValue(payload.conversationId);
          if (conversationId) this.emit({
            type: 'workspace_conversation_changed', workspaceId, conversationId, removed: true,
          });
          return;
        }
        if (event.kind === 'workspace_conversation_upserted') {
          const item = asRecord(payload.conversation);
          const conversationId = stringValue(item.conversationId);
          if (conversationId && typeof item.title === 'string') {
            this.emit({
              type: 'workspace_conversation_changed', workspaceId, conversationId,
              changes: {
                id: conversationId, workspaceId, title: item.title,
                createdAt: String(item.createdAt ?? ''), updatedAt: String(item.updatedAt ?? ''),
                archived: item.archived === true, active: conversationId === this._activeSessionId,
                preview: String(item.preview ?? ''), workspace: this.workspaces.get(conversationId) ?? null,
                activity: item.activity as WebSessionDirectoryMetadata['activity'],
              },
            });
          }
          return;
        }
        if (![
          'workspace_directory_snapshot',
          'workspace_availability_changed',
        ].includes(event.kind)) return;
        void this.emitWorkspaceDirectory(workspaceId);
      },
    );
  }

  private async emitWorkspaceDirectory(workspaceId: string): Promise<void> {
    if (this.disposed || this.activeWorkspaceId !== workspaceId) return;
    const page = await this.listSessionPage();
    if (this.disposed || this.activeWorkspaceId !== workspaceId) return;
    this.emit({
      type: 'workspace_directory',
      activeWorkspaceId: workspaceId,
      activeSessionId: this._activeSessionId,
      sessions: page.items, nextCursor: page.nextCursor,
    });
  }

  private enrichRecord(record: WebSessionRecord) {
    const unresolved = record.turns.filter(turn => !turn.taskId && !turn.executionTimeline?.taskId).map(turn => turn.id);
    const resolved = this.deps.resolveTaskIdsForTurns?.(unresolved);
    const taskIds = record.turns.map(turn => (
      turn.taskId
      ?? turn.executionTimeline?.taskId
      ?? (resolved ? resolved.get(turn.id) : this.deps.resolveTaskIdForTurn?.(turn.id))
      ?? inferTaskId(turn.userInput)
    ));
    const latestTurnByTask = new Map<string, number>();
    taskIds.forEach((taskId, index) => {
      if (taskId) latestTurnByTask.set(taskId, index);
    });
    const timelineByTask = new Map<string, ExecutionTimeline | null>();
    const artifactsByTask = new Map<string, ArtifactProjection[]>();
    const ids = [...latestTurnByTask.keys()];
    const timelines = this.deps.projectExecutionTimelines?.(ids);
    const artifacts = this.deps.projectTasksArtifacts?.(ids);
    const billing = this.deps.billing?.forHistoryPage?.(
      this.deps.accountId, record.turns.map(turn => turn.id), ids,
    ) ?? this.deps.billing;
    for (const [taskId, index] of latestTurnByTask) {
      if (timelines) timelineByTask.set(taskId,
        timelineForTask(timelines.get(taskId), taskId)
        ?? timelineForTask(record.turns[index]!.executionTimeline, taskId));
      if (artifacts) artifactsByTask.set(taskId, artifacts.get(taskId) ?? []);
    }
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
          billing,
        );
      }),
    };
  }

  private enrichTurn(
    turn: ConversationTurn,
    taskId: string | null,
    hydrateDurableFacts: boolean,
    timelineByTask: Map<string, ExecutionTimeline | null>,
    artifactsByTask: Map<string, ArtifactProjection[]>,
    billingService: BillQueryService | undefined,
  ): import('./web-session-types.js').ConversationTurnProjection {
    const billing = this.projectBillingForTurn(turn.id, taskId, isSystemCommandTurn(turn), false, billingService);
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

  private projectBillingForTurn(
    turnId: string,
    taskId: string | null,
    systemCommand = false,
    liveTurn = false,
    billing = this.deps.billing,
  ): {
    queryBill: QueryBillProjection | null;
    taskUsageSummary: TaskUsageSummary | null;
    turnBilling: TurnBillUserView | null;
  } {
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
    } else {
      // Legacy presentation records can misclassify a real AI Turn as a
      // system command. A durable Query is stronger evidence than that
      // presentation hint; retain its billing projection, while suppressing
      // the card for commands that have no Query fact.
      try {
        const durableBilling = billing.getTurnBillUserView(this.deps.accountId, turnId, {
          liveFallback: liveTurn,
        });
        if (durableBilling?.queryId) turnBilling = durableBilling;
      } catch {
        // A command without a durable Query remains intentionally silent.
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

  private emit(event: WebSessionRuntimeEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
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

  listSessionPage(clientId: string, input: { query?: string; cursor?: string } = {}) {
    return this.client(clientId).listSessionPage(input);
  }

  readSession(clientId: string, sessionId: string, cursor?: string): Promise<WebSessionRecordProjection | null> {
    return this.client(clientId).readSession(sessionId, cursor);
  }

  readBrowsableSession(clientId: string, sessionId: string, cursor?: string): Promise<WebSessionRecordProjection | null> {
    return this.client(clientId).readBrowsableSession(sessionId, cursor);
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

  activateSession(clientId: string, sessionId: string, expectedWorkspaceId?: string): Promise<WebSessionActivationResult> {
    return this.client(clientId).activateSession(sessionId, expectedWorkspaceId);
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
