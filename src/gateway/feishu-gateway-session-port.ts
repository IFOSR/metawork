import type { SessionSnapshot } from '../session/session-types.js';
import type {
  FeishuGatewayActionValue,
  FeishuGatewayDelivery,
  FeishuGatewayReply,
  FeishuSessionPort,
} from '../integrations/feishu-app.js';
import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';
import type { EventJournal } from './event-journal.js';
import type { FeishuGatewayAdapter } from './feishu-gateway-adapter.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import { ResultStreamAssembler } from './result-stream-assembler.js';
import { workspaceEventStreamId } from './workspace-event-stream.js';
import {
  formatFeishuWorkspaceConfirmation,
  formatFeishuWorkspaceRequired,
} from './feishu-events.js';

export interface FeishuGatewaySessionPortDeps {
  readonly accountId: string;
  readonly tenantKey: string;
  readonly adapter: FeishuGatewayAdapter;
  readonly journal: EventJournal;
  readonly subscriptions: GatewaySubscriptions;
  readonly timeoutMs?: number;
  readonly onSystemMessage?: (...lines: string[]) => void;
  readonly runtimePaths?: FeishuSessionPort['runtimePaths'];
}

export class FeishuGatewaySessionPort implements FeishuSessionPort {
  private readonly workspaceConfirmationCursors = new Map<
    string,
    { sequence: number; eventId: string }
  >();
  private readonly deliveryListeners = new Set<(delivery: FeishuGatewayDelivery) => void>();
  private readonly activeRequestIds = new Set<string>();
  private readonly liveAttachments = new Map<string, {
    conversationId: string;
    unsubscribe: () => void;
  }>();

  constructor(private readonly deps: FeishuGatewaySessionPortDeps) {}

  get runtimePaths(): FeishuSessionPort['runtimePaths'] {
    return this.deps.runtimePaths;
  }

  appendSystemMessage(...lines: string[]): void {
    this.deps.onSystemMessage?.(...lines);
  }

  subscribe(_listener: (snapshot: SessionSnapshot) => void): () => void {
    return () => undefined;
  }

  getSnapshot(): SessionSnapshot {
    return {
      output: [],
      currentTaskId: null,
      currentTask: null,
      runtimeState: {
        runningTaskId: null,
        runningExecutorName: null,
        readyTaskIds: [],
        blockedTaskIds: [],
        parkedTaskIds: [],
        lastEvent: null,
      },
      plannerState: { status: 'idle' },
      latestGuidance: null,
    };
  }

  async submit(_text: string): Promise<{ exitRequested: boolean }> {
    throw new Error('Feishu production input must use submitGatewayMessage');
  }

  async submitGatewayMessage(input: {
    senderId: string;
    chatId: string;
    threadId?: string;
    chatType?: 'dm' | 'group' | 'unknown';
    text: string;
    requestId: string;
    onProgress: (text: string) => void;
  }): Promise<string[] | FeishuGatewayReply> {
    this.activeRequestIds.add(input.requestId);
    try {
      return await this.submitGatewayMessageOpen(input);
    } finally {
      this.activeRequestIds.delete(input.requestId);
    }
  }

  private async submitGatewayMessageOpen(input: {
    senderId: string;
    chatId: string;
    threadId?: string;
    chatType?: 'dm' | 'group' | 'unknown';
    text: string;
    requestId: string;
    onProgress: (text: string) => void;
  }): Promise<string[] | FeishuGatewayReply> {
    const receipt = await this.deps.adapter.handleMessage(
      { tenantKey: this.deps.tenantKey, userId: input.senderId },
      {
        chatId: input.chatId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      input.text,
      input.requestId,
      `feishu:${input.requestId}`,
    );
    if ('kind' in receipt) throw new Error(receipt.message);
    if (receipt.status === 'rejected') {
      if (receipt.reason === 'workspace_required') {
        return [formatFeishuWorkspaceRequired()];
      }
      throw new Error(receipt.reason ?? 'Feishu Gateway command was rejected');
    }
    const routed = receipt as typeof receipt & {
      routeKind?: string;
      workspaceId?: string | null;
      projectionRequestId?: string;
      projectionStreamId?: string;
      connectionId?: string;
    };
    const connectionId = routed.connectionId
      ?? `feishu:${input.chatId}:${input.threadId ?? ''}`;
    if (routed.routeKind === 'workspace_directory' && routed.workspaceId) {
      if (/^\/workspace(?:\s|$)/u.test(input.text.trim())) {
        this.clearLiveAttachment(connectionId);
      }
      return this.workspaceDirectoryReply(
        routed.workspaceId,
        input.threadId,
        input.chatType,
        routed.projectionStreamId,
        routed.projectionRequestId,
      );
    }
    if (routed.routeKind === 'conversation_attached' && routed.workspaceId) {
      if (!receipt.conversationId) throw new Error('conversation_required');
      this.ensureLiveAttachment(connectionId, receipt.conversationId, {
        senderId: input.senderId,
        chatId: input.chatId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.chatType ? { chatType: input.chatType } : {}),
      });
      return this.attachReply(
        routed.workspaceId,
        receipt.conversationId,
        routed.projectionRequestId,
        input.threadId,
        input.chatType,
      );
    }
    if (routed.routeKind === 'conversation_history') {
      if (!receipt.conversationId) throw new Error('conversation_required');
      this.ensureLiveAttachment(connectionId, receipt.conversationId, {
        senderId: input.senderId,
        chatId: input.chatId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.chatType ? { chatType: input.chatType } : {}),
      });
      return this.historyReply(
        receipt.conversationId,
        historyLimitFromText(input.text),
        routed.projectionRequestId ?? receipt.requestId,
        input.threadId,
        input.chatType,
      );
    }
    if (!receipt.conversationId) {
      throw new Error(receipt.reason ?? 'Feishu Gateway command did not select a Conversation');
    }
    const conversationId = receipt.conversationId;
    this.ensureLiveAttachment(connectionId, conversationId, {
      senderId: input.senderId,
      chatId: input.chatId,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.chatType ? { chatType: input.chatType } : {}),
    });
    const terminal = this.waitForTerminal(conversationId, input.requestId, input.onProgress);
    const replay = await this.deps.journal.replay(this.deps.accountId, conversationId);
    const replayEvents = orderedUniqueReplayEvents(replay);
    const latestWorkspaceEvent = replayEvents.filter(isWorkspaceProjectionEvent).at(-1);
    if (latestWorkspaceEvent) terminal.consume(latestWorkspaceEvent);
    for (const event of replayEvents) {
      if (isWorkspaceProjectionEvent(event)) continue;
      const result = terminal.consume(event);
      if (result) return result;
    }
    return terminal.promise;
  }

  async submitGatewayAction(input: {
    senderId: string;
    chatId: string;
    threadId?: string;
    action: FeishuGatewayActionValue;
    requestId: string;
  }): Promise<FeishuGatewayReply> {
    const receipt = await this.deps.adapter.handleCardAction(
      { tenantKey: this.deps.tenantKey, userId: input.senderId },
      {
        chatId: input.chatId,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      input.action,
      input.requestId,
      `feishu:${input.requestId}`,
    );
    if ('kind' in receipt || receipt.status === 'rejected') {
      throw new Error('kind' in receipt
        ? receipt.message
        : receipt.reason ?? 'Feishu Gateway card action was rejected');
    }
    const routed = receipt as typeof receipt & {
      routeKind?: string;
      workspaceId?: string | null;
      projectionRequestId?: string;
      projectionStreamId?: string;
    };
    if (routed.routeKind === 'workspace_directory' && routed.workspaceId) {
      return this.workspaceDirectoryReply(
        routed.workspaceId,
        input.threadId,
        input.action.chatType,
        routed.projectionStreamId,
        routed.projectionRequestId,
      );
    }
    if (routed.routeKind === 'conversation_history' && receipt.conversationId) {
      return this.historyReply(
        receipt.conversationId,
        input.action.limit,
        routed.projectionRequestId ?? receipt.requestId,
        input.threadId,
        input.action.chatType,
      );
    }
    throw new Error('Unsupported Feishu Gateway card action response');
  }

  private async workspaceDirectoryReply(
    workspaceId: string,
    threadId?: string,
    chatType?: 'dm' | 'group' | 'unknown',
    projectionStreamId?: string,
    projectionRequestId?: string,
  ): Promise<FeishuGatewayReply> {
    const replay = await this.deps.journal.replay(
      this.deps.accountId,
      projectionStreamId ?? workspaceEventStreamId(workspaceId),
    );
    const projection = projectWorkspaceDirectory(replay, projectionRequestId);
    if (!projection) throw new Error('workspace_directory_unavailable');
    const lines = [
      `# Workspace: ${projection.workspace.displayName}`,
      `路径：${projection.workspace.canonicalPath}`,
      ...projection.items.map((item, index) => {
        const task = item.activity.taskId ? ` · Task ${item.activity.taskId}` : '';
        return `${index + 1}. ${item.title} [${item.activity.state}]${task} · ${item.conversationId}`;
      }),
    ];
    return {
      lines,
      ...(projection.nextCursor
        ? {
            actions: [{
              label: '下一页',
              value: {
                kind: 'workspace_conversations' as const,
                cursor: projection.nextCursor,
                ...(threadId ? { threadId } : {}),
                ...(chatType ? { chatType } : {}),
              },
            }],
          }
        : {}),
    };
  }

  private async attachReply(
    workspaceId: string,
    conversationId: string,
    projectionRequestId?: string,
    threadId?: string,
    chatType?: 'dm' | 'group' | 'unknown',
  ): Promise<FeishuGatewayReply> {
    const [workspaceReplay, conversationReplay] = await Promise.all([
      this.deps.journal.replay(
        this.deps.accountId,
        workspaceEventStreamId(workspaceId),
      ),
      this.deps.journal.replay(this.deps.accountId, conversationId),
    ]);
    const projection = projectWorkspaceDirectory(workspaceReplay);
    const summary = projection?.items.find(item => item.conversationId === conversationId);
    if (!summary) throw new Error('conversation_summary_unavailable');
    const page = latestHistoryPage(conversationReplay, projectionRequestId);
    return {
      lines: [
        `# ${summary.title}`,
        `状态：${summary.activity.state}`,
        ...(summary.activity.taskId ? [`当前 Task：${summary.activity.taskId}`] : []),
        '最近对话：',
        ...formatHistoryTurns(page?.turns.slice(0, 3) ?? []),
      ],
      ...(page?.nextCursor
        ? {
            actions: [{
              label: '更早记录',
              value: {
                kind: 'conversation_history' as const,
                cursor: page.nextCursor,
                limit: 3,
                ...(threadId ? { threadId } : {}),
                ...(chatType ? { chatType } : {}),
              },
            }],
          }
        : {}),
    };
  }

  private async historyReply(
    conversationId: string,
    limit = 10,
    projectionRequestId?: string,
    threadId?: string,
    chatType?: 'dm' | 'group' | 'unknown',
  ): Promise<FeishuGatewayReply> {
    const replay = await this.deps.journal.replay(this.deps.accountId, conversationId);
    const page = latestHistoryPage(replay, projectionRequestId);
    if (!page) throw new Error('conversation_history_unavailable');
    const actions: NonNullable<FeishuGatewayReply['actions']> = [];
    if (page.previousCursor) {
      actions.push({
        label: '上一页',
        value: {
          kind: 'conversation_history',
          cursor: page.previousCursor,
          limit,
          ...(threadId ? { threadId } : {}),
          ...(chatType ? { chatType } : {}),
        },
      });
    }
    if (page.nextCursor) {
      actions.push({
        label: '下一页',
        value: {
          kind: 'conversation_history',
          cursor: page.nextCursor,
          limit,
          ...(threadId ? { threadId } : {}),
          ...(chatType ? { chatType } : {}),
        },
      });
    }
    return {
      lines: ['# Conversation History', ...formatHistoryTurns(page.turns)],
      ...(actions.length > 0 ? { actions } : {}),
    };
  }

  subscribeGatewayDelivery(
    listener: (delivery: FeishuGatewayDelivery) => void,
  ): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  private ensureLiveAttachment(
    connectionId: string,
    conversationId: string,
    target: {
      senderId: string;
      chatId: string;
      threadId?: string;
      chatType?: 'dm' | 'group' | 'unknown';
    },
  ): void {
    const existing = this.liveAttachments.get(connectionId);
    if (existing?.conversationId === conversationId) return;
    existing?.unsubscribe();
    const resultAssembler = new ResultStreamAssembler();
    const unsubscribe = this.deps.subscriptions.subscribe({
      accountId: this.deps.accountId,
      conversationId,
      listener: event => {
        if (event.requestId && this.activeRequestIds.has(event.requestId)) return;
        if (
          event.kind === 'result_delivery_available'
          || event.kind === 'result_chunk'
          || event.kind === 'result_completed'
        ) {
          try {
            resultAssembler.consume(event);
          } catch {
            return;
          }
          return;
        }
        if (event.kind === 'trace_delta') {
          const lines = traceProgressLines(event);
          if (lines.length > 0) {
            this.emitDelivery({
              ...target,
              kind: 'progress',
              reply: { lines },
            });
          }
          return;
        }
        if (event.kind === 'terminal_error') {
          const payload = asRecord(event.payload);
          const message = stringValue(payload?.message) ?? 'Gateway execution failed';
          this.emitDelivery({
            ...target,
            kind: 'final',
            reply: { lines: [`任务失败：${message}`] },
          });
          return;
        }
        if (event.kind !== 'final_answer') return;
        const payload = asRecord(event.payload);
        const resultId = stringValue(payload?.resultId);
        const completed = resultId ? resultAssembler.find(resultId) : null;
        const lines = completed
          ? completed.content.split('\n')
          : Array.isArray(payload?.lines)
            ? payload.lines.filter((line): line is string => typeof line === 'string')
            : [];
        this.emitDelivery({
          ...target,
          kind: 'final',
          reply: { lines },
        });
      },
    });
    this.liveAttachments.set(connectionId, { conversationId, unsubscribe });
  }

  private clearLiveAttachment(connectionId: string): void {
    this.liveAttachments.get(connectionId)?.unsubscribe();
    this.liveAttachments.delete(connectionId);
  }

  private emitDelivery(delivery: FeishuGatewayDelivery): void {
    for (const listener of this.deliveryListeners) listener(delivery);
  }

  private waitForTerminal(
    conversationId: string,
    requestId: string,
    onProgress: (text: string) => void,
  ): {
    promise: Promise<string[]>;
    consume(event: GatewayEventEnvelope): string[] | null;
  } {
    let unsubscribe: (() => void) | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;
    const seenEventIds = new Set<string>();
    const resultAssembler = new ResultStreamAssembler();
    const pendingProgress = new Map<string, string>();
    let progressFlushTimer: NodeJS.Timeout | null = null;
    let resolvePromise!: (lines: string[]) => void;
    let rejectPromise!: (error: Error) => void;
    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = null;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (progressFlushTimer) clearTimeout(progressFlushTimer);
      progressFlushTimer = null;
    };
    const flushProgress = () => {
      if (pendingProgress.size === 0) return;
      const text = [...pendingProgress.values()].join('\n');
      pendingProgress.clear();
      onProgress(text);
    };
    const queueProgress = (key: string, text: string, immediate: boolean) => {
      if (!text.trim()) return;
      pendingProgress.set(key, text.slice(0, 500));
      if (immediate) {
        flushProgress();
        return;
      }
      if (progressFlushTimer) return;
      progressFlushTimer = setTimeout(() => {
        progressFlushTimer = null;
        flushProgress();
      }, 250);
      progressFlushTimer.unref?.();
    };
    const consume = (event: GatewayEventEnvelope): string[] | null => {
      if (settled) return null;
      if (seenEventIds.has(event.eventId)) return null;
      seenEventIds.add(event.eventId);
      if (isWorkspaceProjectionEvent(event)) {
        this.confirmWorkspace(event, onProgress);
        return null;
      }
      if (event.requestId !== requestId) return null;
      if (
        event.kind === 'result_delivery_available'
        || event.kind === 'result_chunk'
        || event.kind === 'result_completed'
      ) {
        try {
          resultAssembler.consume(event);
        } catch (error) {
          settled = true;
          cleanup();
          rejectPromise(error as Error);
        }
        return null;
      }
      if (event.kind === 'trace_delta') {
        const payload = event.payload as {
          events?: Array<{
            id?: string;
            kind?: string;
            title?: string;
            summary?: string;
            subtaskId?: string | null;
            details?: { subtaskId?: string };
          }>;
        };
        for (const item of payload.events ?? []) {
          const text = [item.title, item.summary].filter(Boolean).join('：');
          const terminal = Boolean(item.kind && (
            item.kind.includes('blocked')
            || item.kind.includes('failed')
            || item.kind.includes('publication')
            || item.kind.includes('delivery_completed')
            || item.kind.includes('result_observed')
          ));
          const key = item.subtaskId
            ?? item.details?.subtaskId
            ?? item.kind
            ?? item.id
            ?? 'execution';
          queueProgress(key, text, terminal);
        }
      }
      if (event.kind === 'terminal_error') {
        flushProgress();
        const message = (event.payload as { message?: string }).message
          ?? 'Gateway execution failed';
        settled = true;
        cleanup();
        if (/workspace_required|workspace (?:is )?not (?:selected|set)/iu.test(message)) {
          const lines = [formatFeishuWorkspaceRequired()];
          resolvePromise(lines);
          return lines;
        }
        rejectPromise(new Error(message));
        return null;
      }
      if (event.kind === 'final_answer') {
        flushProgress();
        const payload = event.payload as { lines?: string[]; resultId?: string };
        const completed = payload.resultId
          ? resultAssembler.find(payload.resultId)
          : null;
        const lines = completed ? completed.content.split('\n') : payload.lines ?? [];
        settled = true;
        cleanup();
        resolvePromise(lines);
        return lines;
      }
      return null;
    };
    const promise = new Promise<string[]>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    unsubscribe = this.deps.subscriptions.subscribe({
      accountId: this.deps.accountId,
      conversationId,
      listener: consume,
    });
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error('Timed out waiting for Feishu Gateway final event'));
    }, this.deps.timeoutMs ?? 2 * 60 * 60 * 1000);
    timeout.unref?.();
    return { promise, consume };
  }

  private confirmWorkspace(
    event: GatewayEventEnvelope,
    onProgress: (text: string) => void,
  ): void {
    const path = workspacePathFromEvent(event);
    if (!path) return;
    const cursor = this.workspaceConfirmationCursors.get(event.conversationId);
    if (
      cursor
      && (
        event.sequence < cursor.sequence
        || (event.sequence === cursor.sequence && event.eventId <= cursor.eventId)
      )
    ) {
      return;
    }
    this.workspaceConfirmationCursors.set(event.conversationId, {
      sequence: event.sequence,
      eventId: event.eventId,
    });
    onProgress(formatFeishuWorkspaceConfirmation(path));
  }
}

function orderedUniqueReplayEvents(replay: GatewayReplay): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return [...replay.snapshot, ...replay.deltas]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    .filter(event => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}

function isWorkspaceProjectionEvent(event: GatewayEventEnvelope): boolean {
  if (event.kind !== 'conversation_snapshot' && event.kind !== 'workspace_changed') {
    return false;
  }
  return typeof event.payload === 'object'
    && event.payload !== null
    && 'workspace' in event.payload;
}

function workspacePathFromEvent(event: GatewayEventEnvelope): string | null {
  if (!isWorkspaceProjectionEvent(event)) return null;
  const payload = event.payload as {
    workspace?: { path?: unknown } | null;
  };
  return typeof payload.workspace?.path === 'string' && payload.workspace.path.length > 0
    ? payload.workspace.path
    : null;
}

function traceProgressLines(event: GatewayEventEnvelope): string[] {
  const payload = asRecord(event.payload);
  if (!Array.isArray(payload?.events)) return [];
  return payload.events.flatMap(item => {
    const record = asRecord(item);
    const text = [
      stringValue(record?.title),
      stringValue(record?.summary),
    ].filter((value): value is string => value !== null).join('：');
    return text ? [text.slice(0, 500)] : [];
  });
}

interface FeishuWorkspaceConversation {
  conversationId: string;
  title: string;
  activity: {
    state: string;
    taskId: string | null;
  };
}

interface FeishuWorkspaceDirectoryProjection {
  workspace: {
    displayName: string;
    canonicalPath: string;
  };
  items: FeishuWorkspaceConversation[];
  nextCursor: string | null;
}

function projectWorkspaceDirectory(
  replay: GatewayReplay,
  requestId?: string,
): FeishuWorkspaceDirectoryProjection | null {
  let projection: FeishuWorkspaceDirectoryProjection | null = null;
  for (const event of orderedUniqueReplayEvents(replay)) {
    if (requestId && event.requestId !== requestId) continue;
    if (event.kind === 'workspace_directory_snapshot') {
      const payload = asRecord(event.payload);
      const page = parseWorkspaceDirectoryPage(payload?.page);
      const workspace = parseWorkspaceSummary(payload?.workspace);
      if (workspace && page) {
        projection = { workspace, ...page };
      } else if (projection && page) {
        projection = {
          workspace: projection.workspace,
          ...page,
        };
      }
      continue;
    }
    if (!projection) continue;
    const payload = asRecord(event.payload);
    if (event.kind === 'workspace_conversation_upserted') {
      const conversation = parseWorkspaceConversation(payload?.conversation);
      if (!conversation) continue;
      projection.items = [
        conversation,
        ...projection.items.filter(item => item.conversationId !== conversation.conversationId),
      ];
      continue;
    }
    if (event.kind === 'workspace_conversation_removed') {
      const conversationId = stringValue(payload?.conversationId);
      if (conversationId) {
        projection.items = projection.items.filter(
          item => item.conversationId !== conversationId,
        );
      }
      continue;
    }
    if (event.kind === 'workspace_activity_changed') {
      const conversationId = stringValue(payload?.conversationId);
      const activity = parseActivity(payload?.activity);
      if (!conversationId || !activity) continue;
      projection.items = projection.items.map(item => (
        item.conversationId === conversationId ? { ...item, activity } : item
      ));
    }
  }
  return projection;
}

function parseWorkspaceSummary(
  value: unknown,
): FeishuWorkspaceDirectoryProjection['workspace'] | null {
  const workspace = asRecord(value);
  if (
    !workspace
    || !stringValue(workspace.displayName)
    || !stringValue(workspace.canonicalPath)
  ) {
    return null;
  }
  return {
    displayName: stringValue(workspace.displayName)!,
    canonicalPath: stringValue(workspace.canonicalPath)!,
  };
}

function parseWorkspaceDirectoryPage(
  value: unknown,
): Pick<FeishuWorkspaceDirectoryProjection, 'items' | 'nextCursor'> | null {
  const page = asRecord(value);
  if (!page || !Array.isArray(page.items)) return null;
  return {
    items: page.items.map(parseWorkspaceConversation).filter(
      (item): item is FeishuWorkspaceConversation => item !== null,
    ),
    nextCursor: stringValue(page.nextCursor),
  };
}

function parseWorkspaceConversation(value: unknown): FeishuWorkspaceConversation | null {
  const record = asRecord(value);
  const activity = parseActivity(record?.activity);
  const conversationId = stringValue(record?.conversationId);
  const title = stringValue(record?.title);
  return record && activity && conversationId && title
    ? { conversationId, title, activity }
    : null;
}

function parseActivity(value: unknown): FeishuWorkspaceConversation['activity'] | null {
  const record = asRecord(value);
  const state = stringValue(record?.state);
  if (!record || !state) return null;
  return {
    state,
    taskId: stringValue(record.taskId),
  };
}

interface FeishuHistoryPage {
  turns: Array<{
    userInput: string;
    finalAnswer: string | null;
  }>;
  previousCursor: string | null;
  nextCursor: string | null;
}

function latestHistoryPage(
  replay: GatewayReplay,
  requestId?: string,
): FeishuHistoryPage | null {
  const events = orderedUniqueReplayEvents(replay).reverse();
  const selected = requestId
    ? events.find(event => (
        event.kind === 'conversation_history_page'
        && event.requestId === requestId
      ))
    : undefined;
  const candidates = selected
    ? [selected]
    : events;
  for (const event of candidates) {
    if (event.kind !== 'conversation_history_page') continue;
    const payload = asRecord(event.payload);
    if (!payload || !Array.isArray(payload.turns)) continue;
    return {
      turns: payload.turns.map(turn => {
        const record = asRecord(turn);
        const userInput = stringValue(record?.userInput);
        if (!userInput) return null;
        return {
          userInput,
          finalAnswer: stringValue(record?.finalAnswer),
        };
      }).filter((turn): turn is FeishuHistoryPage['turns'][number] => turn !== null),
      previousCursor: stringValue(payload.previousCursor),
      nextCursor: stringValue(payload.nextCursor),
    };
  }
  return null;
}

function formatHistoryTurns(turns: FeishuHistoryPage['turns']): string[] {
  return turns.flatMap(turn => [
    `用户：${turn.userInput}`,
    ...(turn.finalAnswer ? [`MetaWork：${turn.finalAnswer}`] : []),
  ]);
}

function historyLimitFromText(text: string): number {
  const raw = /^\/history(?:\s+(\S+))?$/u.exec(text.trim())?.[1];
  const parsed = raw === undefined ? 10 : Number(raw);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : 10;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
