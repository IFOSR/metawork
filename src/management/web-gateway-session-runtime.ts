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
import { turnStatusFromTimeline } from './web-conversation-projector.js';

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
  /** 会话附件存储；提供后用户消息可携带附件并自动增强 Planner 提示。 */
  readonly attachments?: GatewayAttachmentStore;
  /** Read-only durable execution projection used to rebuild a turn after reconnect. */
  readonly projectExecutionTimeline?: (taskId: string) => ExecutionTimeline | null;
  readonly projectExecutionTimelines?: (taskIds: readonly string[]) => ReadonlyMap<string, ExecutionTimeline | null>;
  /** Read-only published artifact projection used to rebuild completed turns. */
  readonly projectTaskArtifacts?: (taskId: string) => ArtifactProjection[];
  readonly projectTasksArtifacts?: (taskIds: readonly string[]) => ReadonlyMap<string, ArtifactProjection[]>;
  /** Read-only durable Query -> Task association used to rebuild legacy Turns. */
  readonly resolveTaskIdForTurn?: (turnId: string) => string | null;
  readonly resolveTaskIdsForTurns?: (turnIds: readonly string[]) => ReadonlyMap<string, string | null>;
  readonly normalizeTurnPresentation?: (turn: ConversationTurn) => ConversationTurn;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

class WebGatewayClientSession {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private readonly workspaces = new Map<string, ConversationWorkspaceProjection | null>();
  private workspaceUnsubscribe: (() => void) | null = null;
  /** The conversation currently opened by this client. It is never an
   * execution owner and is never used as an implicit command target. */
  private _currentSessionId: string | null = null;
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

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    await this.deps.catalog.initialize();
  }

  getState(): { activeWorkspaceId: string | null; currentSessionId: string | null } {
    return { activeWorkspaceId: this.activeWorkspaceId, currentSessionId: this._currentSessionId };
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
    this._currentSessionId = null;
    this.workspaces.clear();
    this.deps.gateway.closeConnection?.(this.connectionId);
    this.disposePromise = this.navigationQueue;

    return this.disposePromise;
  }

  async submit(
    conversationId: string,
    text: string,
    attachments: Array<{ attachmentId: string; kind: string }> = [],
    requestId?: string,
  ): Promise<void> {
    const targetSessionId = await this.authorizeConversation(conversationId);
    const effectiveRequestId = requestId ?? this.id('req');
    // Enforce the per-message attachment budget before the turn is admitted so
    // a rejected message never consumes Planner/Kernel work.
    if (attachments.length > 0) await this.assertAttachmentBudget(conversationId, attachments);
    const command: GatewayCommand = text.startsWith('/')
      ? { kind: 'slash_command', text }
      : { kind: 'user_message', text, attachments };
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 2,
      requestId: effectiveRequestId,
      idempotencyKey: effectiveRequestId,
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
    conversationId: string,
    attachments: Array<{ attachmentId: string; kind: string }>,
  ): Promise<void> {
    const store = this.deps.attachments;
    const targetConversationId = conversationId;
    const countViolation = evaluateAttachmentCount(attachments.length);
    if (countViolation) {
      throw new WebGatewayAdmissionError(countViolation.code, undefined, countViolation.message);
    }
    if (!store) return;
    const entries: AttachmentBudgetEntry[] = [];
    for (const reference of attachments) {
      const metadata = store.readAttachmentMetadata
        ? await store.readAttachmentMetadata(targetConversationId, reference.attachmentId)
        : (await store.readAttachment(targetConversationId, reference.attachmentId))?.metadata;
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
  async cancelTurn(conversationId: string, turnId: string): Promise<void> {
    if (!turnId.trim()) throw new Error('turn_required');
    const targetSessionId = await this.authorizeConversation(conversationId);
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
    const requestedWorkspaceId = this.activeWorkspaceId;
    if (!requestedWorkspaceId) return null;
    const workspaceId = await this.deps.catalog.workspaceIdForConversation(sessionId);
    if (!workspaceId || workspaceId !== requestedWorkspaceId) return null;
    const record = await measureNavigationStage('record_read', () => this.deps.catalog.readPage
      ? this.deps.catalog.readPage(sessionId, { cursor })
      : this.deps.catalog.read(sessionId));
    if (!record || record.session.archived) return null;
    return this.projectRecord(measureNavigationStageSync(
      'history_enrichment', () => this.enrichRecord(record), record.turns.length,
    ));
  }

  async readBrowsableSession(sessionId: string, cursor?: string): Promise<WebSessionRecordProjection | null> {
    const requestedWorkspaceId = this.activeWorkspaceId;
    if (!requestedWorkspaceId) return null;
    const workspaceId = await this.deps.catalog.workspaceIdForConversation(sessionId);
    if (!workspaceId || workspaceId !== requestedWorkspaceId) return null;
    const record = await measureNavigationStage(
      'record_browse_read', () => this.deps.catalog.readPage
        ? this.deps.catalog.readPage(sessionId, { cursor })
        : this.deps.catalog.read(sessionId),
    );
    if (!record || record.session.archived) return null;
    return this.projectRecord(measureNavigationStageSync(
      'history_browse_enrichment', () => this.enrichRecord(record), record.turns.length,
    ));
  }

  private async authorizeConversation(conversationId: string): Promise<string> {
    const requestedWorkspaceId = this.activeWorkspaceId;
    if (!conversationId.trim() || !requestedWorkspaceId) throw new Error('conversation_required');
    const workspaceId = await this.deps.catalog.workspaceIdForConversation(conversationId);
    if (!workspaceId || workspaceId !== requestedWorkspaceId) throw new Error('conversation_denied');
    return conversationId;
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
      ? { version: 1 as const, session: metadata, turns: [], historyCursor: null }
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
    this._currentSessionId = sessionId;
    this.emit({ type: 'current_session_changed', sessionId });
    return { state: 'active', sessionId };
  }

  async deleteSession(sessionId: string): Promise<'deleted' | 'deletion_pending' | 'not_found' | 'running'> {
    // The directory row may outlive the client's in-memory navigation state
    // (for example after a reconnect or while another tab switches
    // Workspace). Resolve the target from the durable conversation binding so
    // deletion does not depend on whichever Workspace this client happens to
    // have selected at the moment.
    const workspaceId = await this.deps.catalog.workspaceIdForConversation(sessionId);
    if (!workspaceId) return 'not_found';
    // Activity is read directly from the durable conversation projection. Do
    // not rebuild the whole Workspace directory on a delete click.
    const activity = await this.deps.catalog.readActivity(sessionId);
    if (activity && activity.state !== 'idle') {
      return 'running';
    }
    let deletion: 'completed' | 'pending';
    try {
      deletion = this.deps.catalog.delete
        ? await this.deps.catalog.delete(sessionId, workspaceId, WEB_WORKSPACE_PRINCIPAL)
        : await this.deps.catalog.archive(sessionId, workspaceId, WEB_WORKSPACE_PRINCIPAL).then(() => 'completed');
    } catch (error) {
      if ((error as Error).message === 'workspace_busy') return 'running';
      throw error;
    }
    // A stale directory row can still have a metadata index entry after its
    // canonical record was removed. The requested end state is already true
    // in that case, so make DELETE idempotent and let the client remove the
    // stale row.
    this.emit({
      type: 'workspace_conversation_changed', workspaceId,
      conversationId: sessionId, removed: true,
    });
    if (this._currentSessionId === sessionId) {
      this._currentSessionId = null;
    }
    return deletion === 'pending' ? 'deletion_pending' : 'deleted';
  }

  async clearAllSessions(): Promise<{ deleted: number; deletedIds: string[]; skipped: number }> {
    const workspaceId = this.activeWorkspaceId;
    if (!workspaceId) return { deleted: 0, deletedIds: [], skipped: 0 };
    // Enumerate only for this explicitly requested bulk action. Every target
    // goes through the same admission and removal event as a single delete.
    const sessions = await this.deps.catalog.list({ workspaceId, principalId: WEB_WORKSPACE_PRINCIPAL });
    const deletedIds: string[] = [];
    let skipped = 0;
    for (const session of sessions) {
      const outcome = await this.deleteSession(session.id);
      if (outcome === 'running') skipped += 1;
      else deletedIds.push(session.id);
    }
    return { deleted: deletedIds.length, deletedIds, skipped };
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
      if (this.activeWorkspaceId !== receipt.workspaceId) this._currentSessionId = null;
      this.activeWorkspaceId = receipt.workspaceId;
      this.followWorkspace(receipt.workspaceId);
      if (receipt.directory) {
        const { workspace, page } = receipt.directory;
        const conversations = page.items.map(item => ({
          id: item.conversationId, workspaceId: item.workspaceId,
          title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt,
          archived: item.archived, preview: item.preview, activity: item.activity,
          workspace: this.workspaces.get(item.conversationId) ?? null,
        }));
        this.emit({
          type: 'workspace_directory', activeWorkspaceId: workspace.id,
          currentSessionId: this._currentSessionId, sessions: conversations,
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
                archived: item.archived === true,
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
      currentSessionId: this._currentSessionId,
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
  ): import('./web-session-types.js').ConversationTurnProjection {
    if (!taskId) {
      return {
        ...structuredClone(turn),
        traceEvents: filterTraceEventsForTask(turn.traceEvents, null),
      };
    }
    if (!hydrateDurableFacts) {
      const executionTimeline = timelineForTask(turn.executionTimeline, taskId);
      return {
        ...structuredClone(turn),
        taskId,
        traceEvents: filterTraceEventsForTask(turn.traceEvents, taskId),
        executionTimeline: executionTimeline ? structuredClone(executionTimeline) : null,
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

  cancelTurn(clientId: string, conversationId: string, turnId: string): Promise<void> {
    return this.client(clientId).cancelTurn(conversationId, turnId);
  }

  submit(
    clientId: string,
    conversationId: string,
    text: string,
    attachments?: Array<{ attachmentId: string; kind: string }>,
    requestId?: string,
  ): Promise<void> {
    return this.client(clientId).submit(conversationId, text, attachments, requestId);
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

  createSession(clientId: string): Promise<WebSessionCreationResult> {
    return this.client(clientId).createSession();
  }

  activateSession(clientId: string, sessionId: string, expectedWorkspaceId?: string): Promise<WebSessionActivationResult> {
    return this.client(clientId).activateSession(sessionId, expectedWorkspaceId);
  }

  deleteSession(
    clientId: string,
    sessionId: string,
  ): Promise<'deleted' | 'deletion_pending' | 'not_found' | 'running'> {
    return this.client(clientId).deleteSession(sessionId);
  }

  clearAllSessions(clientId: string): Promise<{ deleted: number; deletedIds: string[]; skipped: number }> {
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
