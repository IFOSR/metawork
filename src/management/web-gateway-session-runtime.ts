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
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import type { WebLaunchContextInput } from './web-launch-context.js';

const MAX_ATTACHMENTS_PER_MESSAGE = 32;
const MAX_ENRICHMENT_BYTES = 16 * 1024;
const EXCERPT_MAX_LINES = 64;
const WEB_WORKSPACE_PRINCIPAL = 'web:local-web-user';

function formatByteSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function buildTextExcerpt(bytes: Buffer, maxBytes: number): string | null {
  const text = bytes.toString('utf8');
  if (!text.trim()) return null;
  const lines = text.split('\n').slice(0, EXCERPT_MAX_LINES);
  let excerpt = lines.join('\n');
  while (Buffer.byteLength(excerpt, 'utf8') > maxBytes && excerpt.length > 0) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
  }
  return excerpt.length < text.length ? `${excerpt}\n…（已截断）` : excerpt;
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
  /** Read-only published artifact projection used to rebuild completed turns. */
  readonly projectTaskArtifacts?: (taskId: string) => ArtifactProjection[];
  readonly normalizeTurnPresentation?: (turn: ConversationTurn) => ConversationTurn;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

class WebGatewayClientSession {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private readonly pendingInputs = new Map<string, string>();
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

  async initializeClient(context: WebLaunchContextInput | null): Promise<WorkspaceInitializationResult> {
    await this.initialize();
    if (!context) return { status: 'not_requested' };
    if (context.conversationId) {
      const workspaceId = await this.deps.catalog.workspaceIdForConversation(context.conversationId);
      if (!workspaceId) return { status: 'failed', reason: 'conversation_workspace_unavailable' };
      this.activeWorkspaceId = workspaceId;
      this.deps.gateway.restoreWorkspace?.(this.connectionId, workspaceId);
      this.followWorkspace(workspaceId);
      await this.attach(context.conversationId);
      return { status: 'not_requested' };
    }
    return this.initializeWorkspace(context.workspaceHint);
  }

  getState(): { activeWorkspaceId: string | null; activeSessionId: string | null } {
    return { activeWorkspaceId: this.activeWorkspaceId, activeSessionId: this._activeSessionId };
  }

  listWorkspaces() {
    return this.deps.catalog.listWorkspaces(WEB_WORKSPACE_PRINCIPAL);
  }

  selectWorkspace(path: string): Promise<WorkspaceInitializationResult> {
    return this.initializeWorkspace(path);
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
    this.workspaces.clear();
    this.deps.gateway.closeConnection?.(this.connectionId);
    this.disposePromise = Promise.allSettled([...this.pendingAttaches]).then(() => undefined);
    return this.disposePromise;
  }

  async submit(
    text: string,
    attachments: Array<{ attachmentId: string; kind: string }> = [],
  ): Promise<void> {
    const requestId = this.id('req');
    const effectiveText = await this.enrichWithAttachments(text, attachments);
    this.pendingInputs.set(requestId, text);
    const command: GatewayCommand = effectiveText.startsWith('/')
      ? { kind: 'slash_command', text: effectiveText }
      : { kind: 'user_message', text: effectiveText, attachments };
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 2,
      requestId,
      idempotencyKey: this.id('idem'),
      connectionId: this.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: this.activeSessionId },
      },
      command,
      clientCapabilities: ['trace_v1'],
    });
    if ('kind' in receipt || receipt.status === 'rejected') {
      this.pendingInputs.delete(requestId);
      throw new Error('kind' in receipt ? receipt.message : receipt.reason ?? 'Gateway rejected the command');
    }
  }

  /** 将已上传附件解析为 Planner 提示增强块；无附件或未配置存储时返回原文。 */
  private async enrichWithAttachments(
    text: string,
    attachments: Array<{ attachmentId: string; kind: string }>,
  ): Promise<string> {
    const store = this.deps.attachments;
    if (!store || attachments.length === 0) return text;
    const sections: string[] = [];
    let budget = MAX_ENRICHMENT_BYTES;
    for (const reference of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      const resolved = await store.readAttachment(this.activeSessionId, reference.attachmentId);
      if (!resolved) continue;
      const { metadata } = resolved;
      const sizeLabel = formatByteSize(metadata.size);
      const header = `${sections.length + 1}. ${metadata.name} (${metadata.mime}, ${sizeLabel}) — 路径: ${resolved.path}`;
      let section = header;
      if (metadata.kind === 'text') {
        const excerpt = buildTextExcerpt(resolved.bytes, Math.max(1_000, budget));
        if (excerpt) section = `${header}\n   文本摘录（前 64 行）:\n${excerpt}`;
      }
      // 图片：内容已随消息以多模态 images 通道原生提供给 Planner；
      // 此处保留路径，供 Executor 在工作区读取原图。
      sections.push(section);
      budget -= Buffer.byteLength(section, 'utf8');
      if (budget <= 0) break;
    }
    if (sections.length === 0) return text;
    return [
      text,
      '---',
      `[附件] ${sections.length} 个文件随本消息提交；请结合以下内容理解意图，并让 Executor 通过上述路径读取完整原文：`,
      ...sections,
    ].join('\n');
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

  async createSession(): Promise<WebSessionCreationResult> {
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
      throw new Error('kind' in receipt ? receipt.message : receipt.reason ?? 'conversation_create_failed');
    }
    const created = await this.deps.catalog.read(receipt.conversationId);
    if (!created) throw new Error('created_conversation_unavailable');
    const activation = await this.activateSession(created.session.id);
    const workspaceInitialization = { status: 'not_requested' as const };
    return {
      session: await this.readSession(created.session.id)
        ?? await this.projectRecord(created),
      activation,
      workspaceInitialization,
    };
  }

  async activateSession(sessionId: string): Promise<WebSessionActivationResult> {
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
    await this.attach(sessionId);
    this.emit({ type: 'active_session_changed', sessionId });
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

  private attach(sessionId: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Web Gateway runtime is disposed'));
    const generation = this.attachGeneration += 1;
    const attachment = this.attachOnce(sessionId, generation);
    this.pendingAttaches.add(attachment);
    return attachment.finally(() => {
      this.pendingAttaches.delete(attachment);
    });
  }

  private async attachOnce(sessionId: string, generation: number): Promise<void> {
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
      this.turnStates.set(turn.id, {
        id: turn.id,
        sessionId: turn.sessionId,
        requestId: null,
        userInput: turn.userInput,
        status: turn.status,
        finalAnswer: turn.finalAnswer,
        taskId: turn.taskId ?? inferTaskId(turn.userInput),
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        traceEvents: structuredClone(turn.traceEvents),
        executionTimeline: structuredClone(turn.executionTimeline),
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
  }

  private consume(event: GatewayEventEnvelope, replay: boolean): void {
    const workspaceEvent = this.consumeWorkspaceEvent(event);
    if (workspaceEvent) {
      if (replay) this.replayEvents.push(workspaceEvent);
      else this.emit(workspaceEvent);
    }
    const userInput = event.requestId ? this.pendingInputs.get(event.requestId) : undefined;
    const state = this.rememberTurnEvent(event, userInput);
    const presentationEvent = event.kind === 'trace_delta' && state
      ? traceEventWithNormalizedPresentation(event, state.traceEvents)
      : event;
    const resultEvent = this.consumeResultEvent(event);
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
    const execution = this.projectExecutionFromEvent(event);
    if (execution) {
      if (replay) this.replayEvents.push(execution);
      else this.emit(execution);
    }
    if (event.kind === 'final_answer' && event.requestId) {
      this.pendingInputs.delete(event.requestId);
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

  private async projectRecord(record: WebSessionRecord): Promise<WebSessionRecordProjection> {
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
    };
    if (userInput && !state.userInput) state.userInput = userInput;
    state.taskId ??= inferTaskId(state.userInput);
    if (event.kind === 'turn_started') {
      state.requestId = event.requestId;
      state.startedAt = event.occurredAt;
    }
    if (event.kind === 'trace_delta') {
      const payload = asRecord(event.payload);
      const traceEvents = Array.isArray(payload.events)
        ? payload.events.filter(isInteractionTraceEvent)
        : [];
      const byId = new Map(state.traceEvents.map(item => [item.id, item]));
      for (const item of traceEvents) {
        byId.set(item.id, item);
        state.taskId = item.taskId ?? stringValue(item.details.taskId) ?? state.taskId;
      }
      state.traceEvents = [...byId.values()].sort(compareTraceEvents);
    }
    if (event.kind === 'final_answer') {
      state.status = 'completed';
      state.completedAt = event.occurredAt;
      const payload = asRecord(event.payload);
      state.finalAnswer = arrayStringValue(payload.lines)?.join('\n')
        ?? state.finalAnswer;
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
    const timeline = this.deps.projectExecutionTimeline(taskId);
    if (!timeline) return null;
    state.executionTimeline = structuredClone(timeline);
    const eventPayload = { type: 'execution', taskId, timeline } as const;
    return eventPayload;
  }

  private async persistTerminalTurn(
    event: GatewayEventEnvelope,
    finalLines: string[],
  ): Promise<void> {
    if (!event.turnId || this.persistedTurnIds.has(event.turnId)) return;
    const state = this.turnStates.get(event.turnId);
    if (!state || !state.userInput) return;
    this.persistedTurnIds.add(event.turnId);
    const finalAnswer = finalLines.length > 0
      ? finalLines.join('\n')
      : state.finalAnswer ?? '';
    const status = state.status === 'failed'
      ? 'failed'
      : state.status === 'blocked' ? 'blocked' : 'completed';
    const taskId = state.taskId ?? inferTaskId(state.userInput);
    const executionTimeline = taskId
      ? this.deps.projectExecutionTimeline?.(taskId) ?? state.executionTimeline
      : state.executionTimeline;
    const artifacts = taskId
      ? this.deps.projectTaskArtifacts?.(taskId) ?? []
      : [];
    const appended = await this.deps.catalog.appendTurn(event.conversationId, {
      id: state.id,
      sessionId: event.conversationId,
      userInput: state.userInput,
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

  private enrichRecord(record: WebSessionRecord): WebSessionRecord {
    const taskIds = record.turns.map(turn => turn.taskId ?? inferTaskId(turn.userInput));
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

  private enrichTurn(
    turn: ConversationTurn,
    taskId: string | null,
    hydrateDurableFacts: boolean,
    timelineByTask: Map<string, ExecutionTimeline | null>,
    artifactsByTask: Map<string, ArtifactProjection[]>,
  ): ConversationTurn {
    if (!taskId) return structuredClone(turn);
    if (!hydrateDurableFacts) {
      return {
        ...structuredClone(turn),
        taskId,
      };
    }
    if (!timelineByTask.has(taskId)) {
      timelineByTask.set(
        taskId,
        this.deps.projectExecutionTimeline?.(taskId) ?? turn.executionTimeline,
      );
    }
    if (!artifactsByTask.has(taskId)) {
      artifactsByTask.set(
        taskId,
        this.deps.projectTaskArtifacts?.(taskId) ?? [],
      );
    }
    const executionTimeline = timelineByTask.get(taskId) ?? turn.executionTimeline;
    const projectedArtifacts = artifactsByTask.get(taskId) ?? [];
    const artifacts = mergeArtifacts(turn.artifacts, projectedArtifacts);
    const artifactRefs = [...new Set([
      ...turn.artifactRefs,
      ...artifacts.map(artifact => artifact.relativePath),
    ])];
    return {
      ...structuredClone(turn),
      taskId,
      executionTimeline: executionTimeline ? structuredClone(executionTimeline) : null,
      artifactRefs,
      artifacts,
    };
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
      artifacts: [],
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

  async initializeClient(
    clientId: string,
    context: WebLaunchContextInput | null,
  ): Promise<WorkspaceInitializationResult> {
    return this.client(clientId).initializeClient(context);
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
  normalizedEvents: InteractionTraceEvent[],
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
      events: normalizedEvents.filter(item => ids.has(item.id)),
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
    const payload = event.payload as { turnId?: string; events?: InteractionTraceEvent[] };
    return {
      type: 'trace_delta',
      turnId: payload.turnId ?? event.turnId ?? 'turn_unknown',
      fromSequence: payload.events?.[0]?.sequence ?? 0,
      events: payload.events ?? [],
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
    const payload = event.payload as { lines?: string[] };
    if (!event.requestId || !event.turnId) return null;
    return {
      type: 'final_answer',
      requestId: event.requestId,
      turnId: event.turnId,
      lines: payload.lines && payload.lines.length > 0
        ? payload.lines
        : completedResult?.split('\n') ?? [],
      completedAt: event.occurredAt,
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
