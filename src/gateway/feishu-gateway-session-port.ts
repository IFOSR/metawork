import { feishuClientConnectionId } from './feishu-conversation-routing.js';
import { clientConnectionEventStreamId } from './client-connection-event-stream.js';
import type { CommandReceipt } from './command-admission.js';
import type { SessionSnapshot } from '../session/session-types.js';
import type {
  FeishuGatewayActionValue,
  FeishuGatewayDelivery,
  FeishuGatewayReply,
  FeishuSessionPort,
} from '../integrations/feishu-app.js';
import type { GatewayEventEnvelope } from './client-events.js';
import type { FeishuGatewayAdapter } from './feishu-gateway-adapter.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import type { BillQueryService } from '../billing/bill-query-service.js';
import { formatFeishuWorkspaceRequired } from './feishu-events.js';
import type { QueryBillProjection } from '../billing/bill-query-service.js';
import type { NotificationJob } from '../delivery/notification-routing.js';
import type { ConversationObservationService } from './conversation-observation.js';
import type { ConversationContentReference } from '../session/conversation-read-types.js';
import type { ClientActionReferences } from './client-action-reference.js';

function formatFeishuBillingSummary(bill: QueryBillProjection): string {
  const external = bill.confirmedDeductedMicroCoin !== null
    ? `已确认扣款 ${bill.confirmedDeductedMicroCoin} microCoin`
    : bill.externalState === 'received'
      ? '外部已接收，扣款待确认'
      : bill.externalState === 'rejected'
        ? '外部消费已拒绝'
        : bill.externalState === 'unknown'
          ? '外部消费状态待核对'
          : `外部消费 ${bill.externalState}`;
  const coverage = bill.coverage === 'complete'
    ? '计量完整'
    : `计量${bill.coverageNote ? `不完整：${bill.coverageNote}` : '不完整'}`;
  const payerLabels = (bill.payerSummary ?? []).map(item => {
    const payer = item.payer === 'user_direct' ? '用户直付' : item.payer === 'unknown' ? '付款方未知' : item.payer;
    const disposition = item.disposition === 'eligible' ? '计入应计' : item.disposition === 'pending' ? '待核对' : '不计入平台收费';
    return `${payer}${disposition}`;
  });
  const payer = bill.platformAbsorption ? '平台承担部分缺失成本' : null;
  return [`费用摘要：应计 ${bill.assessedMicroCoin} microCoin${bill.assessedIsFinal ? '' : '（暂计）'}`, external, coverage, ...payerLabels, payer]
    .filter((line): line is string => Boolean(line))
    .join('；');
}

export interface FeishuGatewaySessionPortDeps {
  readonly accountId: string;
  readonly tenantKey: string;
  readonly adapter: Pick<FeishuGatewayAdapter, 'handleMessage' | 'handleCardAction'>;
  readonly subscriptions: GatewaySubscriptions;
  readonly onSystemMessage?: (...lines: string[]) => void;
  /** Registered artifacts for a task (drives Feishu cloud-doc delivery). */
  readonly listTaskArtifacts?: (taskId: string) => Array<{
    displayName: string;
    publishedPath: string;
    mediaType: string;
    previewKind: string;
  }>;
  readonly runtimePaths?: FeishuSessionPort['runtimePaths'];
  /** Shared server-side billing projection; Feishu only renders its result. */
  readonly billing?: BillQueryService;
  readonly observation: Pick<ConversationObservationService, 'content'>;
  readonly actions?: ClientActionReferences;
}

export class FeishuGatewaySessionPort implements FeishuSessionPort {
  private readonly deliveryListeners = new Set<(delivery: FeishuGatewayDelivery) => void | Promise<void>>();

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
    attachments?: Array<{ path: string; name: string; kind: 'image' | 'file' }>;
    onProgress: (text: string, options?: { cardUpdateKey?: string; collapsedMarkdown?: string; terminal?: boolean }) => void;
  }): Promise<string[] | FeishuGatewayReply> {
    // Subscribe before admission: even an immediate control result cannot race past the caller.
    let resolveControl!: (event: GatewayEventEnvelope | null) => void;
    const controlResult = new Promise<GatewayEventEnvelope | null>(resolve => { resolveControl = resolve; });
    const isControl = /^\/(?:approve|deny|stop-task|stop-turn)(?:\s|$)/u.test(input.text.trim());
    const unsubscribeControl = isControl ? this.deps.subscriptions.subscribe({ accountId: this.deps.accountId,
      conversationId: clientConnectionEventStreamId(feishuClientConnectionId(this.deps.accountId,
        { chatId: input.chatId, threadId: input.threadId }, { tenantKey: this.deps.tenantKey, userId: input.senderId })), listener: event => {
        if (event.kind === 'command_result' && event.requestId === input.requestId) resolveControl(event);
      } }) : () => undefined;
    const controlTimer = isControl ? setTimeout(() => resolveControl(null), 15_000) : undefined;
    controlTimer?.unref();
    try {
    const receipt = await this.deps.adapter.handleMessage(
      { tenantKey: this.deps.tenantKey, userId: input.senderId },
      {
        chatId: input.chatId,
        chatType: input.chatType,
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      },
      input.text,
      input.requestId,
      `feishu:${input.requestId}`,
      input.attachments,
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
      replyEvents?: readonly GatewayEventEnvelope[];
      lines?: readonly string[];
      resourcePage?: unknown;
    };
    if (routed.routeKind === 'notification_route') return [...routed.lines ?? []];
    if ((routed.routeKind === 'conversation_history' || routed.routeKind === 'conversation_attached') && routed.resourcePage) {
      return this.resourceHistoryReply(routed.resourcePage, receipt.conversationId!, input.senderId, input.chatId, input.threadId, input.chatType);
    }
    if (routed.routeKind === 'conversation_control') {
      const event = await controlResult;
      const result = asRecord(event?.payload);
      return [result?.status === 'completed' ? '操作已处理；任务停止后仍需等待执行清理完成。'
        : result?.status === 'failed' ? `操作未完成：${String(result.reason)}`
          : '操作已受理，正在处理。请查看任务进度或再次查询授权状态。'];
    }
    if (routed.routeKind === 'pending_interactions') {
      const replies = routed.replyEvents ?? [];
      if (!replies.some(event => asRecord(event.payload)?.complete === true)) throw new Error('授权列表读取未完成，请重新执行 /pending');
      const requests = replies.map(event => asRecord(asRecord(event.payload)?.request)).filter(request => request !== null);
      if (!requests.length) return ['当前会话没有等待处理的授权。'];
      const nextCursor = asRecord(replies.at(-1)?.payload)?.nextCursor;
      return [...requests.flatMap(request => [
        `任务：${String(request.taskTitle)}；操作：${String(request.operation)}`,
        `资源：${String(request.resource)}；原因：${String(request.reason)}；范围：${String(request.suggestedScope)}`,
        `/approve ${String(request.permissionRequestId)} ${String(request.requestRevision)} ${String(request.generationId)} ${receipt.conversationId}`,
        `/deny ${String(request.permissionRequestId)} ${String(request.requestRevision)} ${String(request.generationId)} ${receipt.conversationId}`,
      ]), ...(typeof nextCursor === 'string' ? [`继续查看：/pending ${nextCursor}`] : [])];
    }
    if (routed.routeKind === 'workspace_directory') {
      return this.workspaceDirectoryReply(routed.replyEvents ?? [], input.threadId, input.chatType, receipt.directory);
    }
    if (!receipt.conversationId) throw new Error('conversation_required');
    if (routed.routeKind === 'conversation_history' || routed.routeKind === 'conversation_attached') {
      throw new Error('conversation_read_model_unavailable');
    }
    return ['消息已接收，进度和结果会继续发送到这里。'];
    } finally { unsubscribeControl(); if (controlTimer) clearTimeout(controlTimer); }
  }

  async submitGatewayAction(input: {
    senderId: string;
    chatId: string;
    threadId?: string;
    action: FeishuGatewayActionValue;
    requestId: string;
  }): Promise<FeishuGatewayReply> {
    if (input.action.kind === 'gateway_action') {
      let resolve!: (event: GatewayEventEnvelope | null) => void;
      const result = new Promise<GatewayEventEnvelope | null>(done => { resolve = done; });
      const stop = this.deps.subscriptions.subscribe({ accountId: this.deps.accountId, conversationId: clientConnectionEventStreamId(feishuClientConnectionId(this.deps.accountId,
        { chatId: input.chatId, threadId: input.threadId }, { tenantKey: this.deps.tenantKey, userId: input.senderId })), listener: event => {
        if (event.requestId === input.requestId && (event.kind === 'command_result' || event.kind === 'conversation_resource')) resolve(event);
      } });
      const timer = setTimeout(() => resolve(null), 15_000); timer.unref();
      try {
        const receipt = await this.deps.adapter.handleCardAction({ tenantKey: this.deps.tenantKey, userId: input.senderId },
          { chatId: input.chatId, threadId: input.threadId, chatType: input.action.chatType }, input.action, input.requestId, `feishu:${input.requestId}`);
        if ('kind' in receipt || receipt.status === 'rejected') throw new Error('kind' in receipt ? receipt.message : receipt.reason);
        const event = await result;
        const payload = asRecord(event?.payload);
        if (event?.kind === 'conversation_resource') return this.resourceHistoryReply(payload?.page,
          String(payload?.targetConversationId), input.senderId, input.chatId, input.threadId, input.action.chatType);
        return { lines: [payload?.status === 'completed' ? '操作已处理。' : payload?.status === 'failed'
          ? `操作未完成：${String(payload.reason)}` : '操作已受理，正在处理。'] };
      } finally { stop(); clearTimeout(timer); }
    }
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
      replyEvents?: readonly GatewayEventEnvelope[];
      resourcePage?: unknown;
    };
    if (routed.routeKind === 'conversation_history' && routed.resourcePage) {
      return this.resourceHistoryReply(routed.resourcePage, receipt.conversationId!, input.senderId, input.chatId, input.threadId, input.action.chatType);
    }
    if (routed.routeKind === 'workspace_directory') {
      return this.workspaceDirectoryReply(routed.replyEvents ?? [], input.threadId, input.action.chatType, receipt.directory);
    }
    throw new Error('Unsupported Feishu Gateway card action response');
  }

  private workspaceDirectoryReply(
    events: readonly GatewayEventEnvelope[],
    threadId?: string,
    chatType?: 'dm' | 'group' | 'unknown',
    directory?: CommandReceipt['directory'],
  ): FeishuGatewayReply {
    const projection = projectWorkspaceDirectory(events) ?? (directory ? { workspace: directory.workspace, ...directory.page } : null);
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

  private resourceHistoryReply(value: unknown, conversationId: string, senderId: string, chatId: string,
    threadId?: string, chatType?: 'dm' | 'group' | 'unknown'): FeishuGatewayReply {
    const page = asRecord(value);
    const turns = Array.isArray(page?.turns) ? page.turns : [];
    return { lines: ['会话历史', ...turns.flatMap(raw => {
      const turn = asRecord(raw) ?? {};
      return [String(turn.userInput ?? ''), String(turn.answer ?? ''),
        ...((turn.answerRef as { byteLength?: number } | undefined)?.byteLength
          ? [`完整正文：/read ${conversationId} ${String((turn.answerRef as { hash: string }).hash)} 0`] : [])];
    })], ...(typeof page?.nextCursor === 'string' && this.deps.actions ? { actions: [{ label: '更早的对话',
      value: { kind: 'gateway_action', cursor: this.deps.actions.issue({ accountId: this.deps.accountId,
        principalId: `feishu:${this.deps.tenantKey}:${senderId}`, conversationId, chatId, threadId: threadId ?? null,
        command: { kind: 'get_conversation_resource', conversationId, resource: 'turns', cursor: page.nextCursor } }), threadId, chatType } }] } : {}) };
  }

  subscribeGatewayDelivery(
    listener: (delivery: FeishuGatewayDelivery) => void | Promise<void>,
  ): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  /** A durable outbox only settles after the platform adapter acknowledges delivery. */
  async deliverNotification(job: NotificationJob): Promise<void> {
    if (!this.deliveryListeners.size) throw new Error('feishu_transport_unavailable');
    const payload = asRecord(job.fact.payload) ?? {};
    const destination = job.route.destination;
    let body = stringValue(payload.answer) ?? '';
    const reference = payload.answerRef as ConversationContentReference | null;
    if (reference && this.deps.observation && reference.byteLength <= 16 * 1024 * 1024) {
      // Delivery has a separate body budget; the UI never needs this full allocation.
      const chunks: string[] = []; let offset = 0;
      while (offset < reference.byteLength) {
        const part = await this.deps.observation.content(job.route.accountId, job.route.conversationId, reference.hash, offset, 65536);
        if (!part || part.nextOffset <= offset) throw new Error('notification_result_not_ready');
        chunks.push(part.text); offset = part.nextOffset;
      }
      body = chunks.join('');
    }
    const label = payload.status === 'cancelled' ? '任务已停止' : payload.status === 'failed' ? '任务执行失败'
      : job.fact.category === 'result' ? '任务结果' : '任务进行中';
    const approval = job.fact.category === 'approval' ? [
      `等待授权：${String(payload.operation)}\n资源：${String(payload.resource)}\n原因：${String(payload.reason)}\n范围：${String(payload.scope)}`,
      ...(asRecord(payload.detailsRef)?.hash ? [`请先查看完整申请：/read ${job.route.conversationId} ${String(asRecord(payload.detailsRef)!.hash)} 0`] : []),
      `/approve ${String(payload.requestId)} ${String(payload.requestRevision)} ${String(payload.generationId)} ${job.route.conversationId}`,
      `/deny ${String(payload.requestId)} ${String(payload.requestRevision)} ${String(payload.generationId)} ${job.route.conversationId}`,
    ] : [];
    const bill = job.fact.category === 'result' && typeof payload.turnId === 'string'
      ? this.deps.billing?.getQueryBillForTurn(job.route.accountId, payload.turnId) : null;
    const actions: NonNullable<FeishuGatewayReply['actions']> = [];
    const issue = (label: string, command: import('./client-protocol.js').GatewayCommand) => {
      if (!this.deps.actions) return;
      const cursor = this.deps.actions.issue({ accountId: job.route.accountId, principalId: job.route.principalId,
        conversationId: job.route.conversationId, chatId: destination.chatId, threadId: destination.threadId ?? null, command });
      actions.push({ label, value: { kind: 'gateway_action', cursor, threadId: destination.threadId, chatType: destination.chatType } });
    };
    if (job.fact.category === 'approval') for (const resolution of ['approve', 'deny'] as const) {
      if (resolution === 'approve' && payload.detailsRef) continue;
      issue(resolution === 'approve' ? '同意' : '拒绝', { kind: 'permission_resolution_v2',
        requestId: String(payload.requestId), requestRevision: String(payload.requestRevision),
        expectedExecutionGeneration: String(payload.generationId), resolution });
    }
    if (payload.canCancel === true && job.fact.taskId && typeof payload.executionGeneration === 'string') {
      // Stable command text keeps progress cards editable through the shared card machine.
      approval.push(`/stop-task ${job.fact.taskId} ${payload.executionGeneration} ${job.route.conversationId}`);
    }
    const delivery: FeishuGatewayDelivery = {
      senderId: destination.senderId, chatId: destination.chatId, threadId: destination.threadId, chatType: destination.chatType,
      kind: job.fact.category === 'result' ? 'final' : 'progress',
      reply: { lines: [`${stringValue(payload.title) ?? label} · ${job.route.conversationId}`,
        ...(stringValue(payload.explanation) ? [String(payload.explanation)] : []), ...approval, ...(body ? [body] : []),
        ...(stringValue(payload.progressSummary) ? [String(payload.progressSummary)] : []),
        ...(reference && reference.byteLength > 16 * 1024 * 1024
          ? [`结果较长，可分段读取完整正文：/read ${job.route.conversationId} ${reference.hash} 0`] : []),
        ...(bill ? [formatFeishuBillingSummary(bill)] : [])],
        ...(actions.length ? { actions } : {}),
        ...(job.fact.category === 'progress' ? { cardUpdateKey: `notification:${job.route.accountId}:${job.route.id}:${job.fact.subjectId}`,
          terminal: payload.canCancel === false } : {}),
        ...(job.fact.category === 'result' ? { artifacts: this.taskArtifactsFor(job.fact.taskId) } : {}) },
    };
    await Promise.all([...this.deliveryListeners].map(listener => listener(delivery)));
  }

  private taskArtifactsFor(taskId: string | null): Array<{
    name: string;
    path: string;
    mediaType: string;
    previewKind: string;
  }> {
    if (!taskId || !this.deps.listTaskArtifacts) return [];
    try {
      return this.deps.listTaskArtifacts(taskId).map(record => ({
        name: record.displayName,
        path: record.publishedPath,
        mediaType: record.mediaType,
        previewKind: record.previewKind,
      }));
    } catch {
      return [];
    }
  }

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

function projectWorkspaceDirectory(events: readonly GatewayEventEnvelope[]): FeishuWorkspaceDirectoryProjection | null {
  const event = [...events].reverse().find(event => event.kind === 'workspace_directory_snapshot');
  const payload = asRecord(event?.payload);
  const page = parseWorkspaceDirectoryPage(payload?.page);
  const workspace = parseWorkspaceSummary(payload?.workspace);
  return page && workspace ? { workspace, ...page } : null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
