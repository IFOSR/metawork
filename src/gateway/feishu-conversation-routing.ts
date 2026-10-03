import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import type { GatewayEventEnvelope } from './client-events.js';
import type { ClientNavigationStore } from '../session/client-navigation-store.js';
import { createHash } from 'node:crypto';
import type { ClientGateway, ClientGatewayResult } from './client-gateway.js';
import type { GatewayCommand, GatewayCommandEnvelope } from './client-protocol.js';
import type { GatewayAttachmentStore } from './attachment-store-port.js';
import type { CommandReceipt } from './command-admission.js';
import type {
  ConversationBindingRecord,
  ConversationBindingRepository,
} from '../session/conversation-binding-repository.js';
import type {
  FeishuChannelBinding,
  FeishuSenderIdentity,
} from './feishu-gateway-adapter.js';
import { clientConnectionEventStreamId } from './client-connection-event-stream.js';
import type { NotificationRoutingService } from '../delivery/notification-routing.js';
import type { ConversationObservationService } from './conversation-observation.js';
import type { ClientActionReferences } from './client-action-reference.js';

export type FeishuConversationRouteKind =
  | 'workspace_directory'
  | 'conversation_attached'
  | 'conversation_history'
  | 'conversation_terminal'
  | 'conversation_control'
  | 'notification_route'
  | 'conversation_activity'
  | 'pending_interactions';

export interface FeishuConversationRouteReceipt extends CommandReceipt {
  readonly routeKind: FeishuConversationRouteKind;
  readonly connectionId: string;
  readonly projectionRequestId?: string;
  readonly projectionStreamId?: string;
  readonly replyEvents?: readonly GatewayEventEnvelope[];
  readonly lines?: readonly string[];
  readonly resourcePage?: unknown;
}

export type FeishuConversationRouteResult =
  | ClientGatewayResult
  | FeishuConversationRouteReceipt;

export interface FeishuConversationCardAction {
  readonly kind: 'workspace_conversations' | 'conversation_history' | 'gateway_action';
  readonly cursor: string;
  readonly limit?: number;
  readonly threadId?: string;
  readonly chatType?: 'dm' | 'group' | 'unknown';
}

export interface FeishuConversationRoutingDeps {
  readonly accountId: string;
  readonly gateway: ClientGateway;
  readonly bindings: ConversationBindingRepository;
  readonly navigation: ClientNavigationStore;
  readonly subscriptions: GatewaySubscriptions;
  readonly notifications?: NotificationRoutingService;
  readonly observation?: ConversationObservationService;
  readonly actions?: ClientActionReferences;
  readonly restoreWorkspace: (
    connectionId: string,
    workspaceId: string,
    principalId: string,
  ) => Promise<void>;
  readonly resolveConversationWorkspace: (
    accountId: string,
    conversationId: string,
    principalId: string,
  ) => Promise<string | null>;
  /** §5.5: persists message-scoped attachment bytes under the resolved Conversation. */
  readonly attachments?: GatewayAttachmentStore;
  onAttachmentSaved?(input: {
    conversationId: string;
    attachmentId: string;
    name: string;
    kind: 'image' | 'file';
  }): void;
  onAttachmentFailed?(input: {
    conversationId: string;
    chatId?: string;
    threadId?: string;
    name: string;
    kind: 'image' | 'file';
    reason: string;
  }): void;
}

export class FeishuConversationRouting {
  private readonly operations = new Map<string, Promise<void>>();

  constructor(private readonly deps: FeishuConversationRoutingDeps) {}

  routeMessage(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    text: string,
    requestId: string,
    idempotencyKey: string,
    attachments?: Array<{ path: string; name: string; kind: 'image' | 'file' }>,
  ): Promise<FeishuConversationRouteResult> {
    return this.serialize(sender, channel, () => this.routeMessageOpen(
      sender,
      channel,
      text,
      requestId,
      idempotencyKey,
      attachments,
    ));
  }

  private async routeMessageOpen(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    text: string,
    requestId: string,
    idempotencyKey: string,
    attachments?: Array<{ path: string; name: string; kind: 'image' | 'file' }>,
  ): Promise<FeishuConversationRouteResult> {
    const normalized = text.trim();
    const content = /^\/read\s+(\S+)\s+([a-f0-9]{64})\s+(\d+)$/u.exec(normalized);
    if (content && this.deps.observation) {
      const principalId = `feishu:${sender.tenantKey}:${sender.userId}`;
      const conversationId = content[1]!;
      if (!await this.deps.resolveConversationWorkspace(this.deps.accountId, conversationId, principalId)) {
        return this.rejected(requestId, idempotencyKey, 'conversation_denied');
      }
      const part = await this.deps.observation.content(this.deps.accountId, conversationId, content[2]!, Number(content[3]), 8192);
      return { requestId, idempotencyKey, status: 'accepted', conversationId,
        connectionId: feishuClientConnectionId(this.deps.accountId, channel, sender), routeKind: 'notification_route',
        lines: part ? [part.text, ...(part.nextOffset < part.byteLength
          ? [`继续阅读：/read ${conversationId} ${content[2]} ${part.nextOffset}`] : [])] : ['正文暂不可用。'] };
    }
    const follow = /^(\/follow|\/unfollow|\/following|\/tasks)(?:\s+(\S+))?$/u.exec(normalized);
    if (follow && this.deps.notifications && this.deps.observation) {
      const context = await this.bindingContext(sender, channel);
      const principalId = `feishu:${sender.tenantKey}:${sender.userId}`;
      const receipt = (lines: string[]): FeishuConversationRouteReceipt => ({ requestId, idempotencyKey,
        status: 'accepted', conversationId: context.binding?.conversationId ?? null,
        routeKind: 'notification_route', connectionId: context.connectionId, lines });
      if (follow[1] === '/unfollow') {
        if (!follow[2]) return this.rejected(requestId, idempotencyKey, 'route_id_required');
        return receipt([this.deps.notifications.unfollow(this.deps.accountId, principalId, follow[2])
          ? '已取消此处的任务通知，任务继续执行。' : '没有找到可取消的通知。']);
      }
      if (follow[1] === '/following') {
        const routes = this.deps.notifications.list(this.deps.accountId, principalId, follow[2]);
        return receipt([...routes.slice(0, 32).map(route => `${route.conversationId}：/unfollow ${route.id}`),
          ...(routes.length > 32 ? [`下一页：/following ${routes[31]!.id}`] : []),
          ...(!routes.length ? ['当前没有正在跟踪的会话。'] : [])]);
      }
      const conversationId = follow[1] === '/follow' ? follow[2] ?? context.binding?.conversationId : context.binding?.conversationId;
      if (!conversationId || !await this.deps.resolveConversationWorkspace(this.deps.accountId, conversationId, principalId)) {
        return this.rejected(requestId, idempotencyKey, 'conversation_denied');
      }
      if (follow[1] === '/tasks') {
        const page = await this.deps.observation.activity(this.deps.accountId, conversationId, follow[2]);
        return receipt([...page.tasks.map(task => `${task.title}：${task.explanation}\n${task.canCancel
          ? `/stop-task ${task.taskId} ${task.executionGeneration} ${conversationId}` : ''}`),
          ...(page.nextCursor ? [`下一页：/tasks ${page.nextCursor}`] : []),
          ...(!page.tasks.length ? ['当前会话没有活动任务。'] : [])]);
      }
      const route = await this.deps.notifications.follow({ accountId: this.deps.accountId, principalId, conversationId,
        requestId: null, taskId: null, source: 'explicit_follow', destination: { platform: 'feishu', tenantKey: sender.tenantKey,
          senderId: sender.userId, chatId: channel.chatId, ...(channel.threadId ? { threadId: channel.threadId } : {}), chatType: channel.chatType ?? 'unknown' } });
      return receipt([`已跟踪会话 ${conversationId}。切换会话或关闭其他客户端不影响这里的通知。`, `/unfollow ${route.id}`]);
    }
    const control = /^(\/pending|\/approve|\/deny|\/stop-task|\/stop-turn)(?:\s+(.*))?$/u.exec(normalized);
    if (control) {
      const context = await this.bindingContext(sender, channel);
      const args = control[2]?.trim().split(/\s+/u) ?? [];
      const targetIndex = control[1] === '/stop-task' ? 2
        : control[1] === '/approve' || control[1] === '/deny' ? 3
          : control[1] === '/stop-turn' ? 1 : 1;
      const explicitTarget = args.length === targetIndex + 1 ? args.pop() : undefined;
      const conversationId = explicitTarget ?? context.binding?.conversationId;
      if (!conversationId) return this.rejected(requestId, idempotencyKey, 'conversation_required');
      if (!await this.deps.resolveConversationWorkspace(this.deps.accountId, conversationId, context.principalId)) {
        return this.rejected(requestId, idempotencyKey, 'conversation_denied');
      }
      let command: GatewayCommand;
      if (control[1] === '/pending' && args.length <= 1) command = { kind: 'get_pending_interactions', conversationId,
        ...(args[0] ? { cursor: args[0] } : {}) };
      else if (control[1] === '/stop-turn' && args.length === 1) command = { kind: 'cancel_turn', turnId: args[0]! };
      else if (control[1] === '/stop-task' && args.length === 2) command = { kind: 'cancel_task', taskId: args[0]!, expectedExecutionGeneration: args[1]! };
      else if ((control[1] === '/approve' || control[1] === '/deny') && args.length === 3) command = {
        kind: 'permission_resolution_v2', requestId: args[0]!, requestRevision: args[1]!, expectedExecutionGeneration: args[2]!,
        resolution: control[1] === '/approve' ? 'approve' : 'deny',
      };
      else return this.rejected(requestId, idempotencyKey,
        '用法：/pending [游标]；/approve 或 /deny 请求ID 修订ID 执行代次 [会话ID]；/stop-task 任务ID 执行代次 [会话ID]；/stop-turn 轮次ID [会话ID]');
      const replyEvents: GatewayEventEnvelope[] = [];
      let bytes = 0;
      const unsubscribe = this.deps.subscriptions.subscribe({ accountId: this.deps.accountId,
        conversationId: clientConnectionEventStreamId(context.connectionId), listener: event => {
          if (event.requestId !== requestId) return;
          bytes += Buffer.byteLength(JSON.stringify(event));
          if (bytes > 256 * 1024) throw new Error('feishu_query_budget');
          replyEvents.push(event);
        } });
      try {
        const result = await this.handle(sender, { requestId, idempotencyKey, connectionId: context.connectionId,
          scope: { kind: 'conversation', selection: { mode: 'attach', conversationId } }, command });
        return isReceipt(result) ? { ...result, conversationId, connectionId: context.connectionId, replyEvents,
          routeKind: command.kind === 'get_pending_interactions' ? 'pending_interactions' : 'conversation_control' } : result;
      } finally { unsubscribe(); }
    }
    if (/^\/workspace(?:\s|$)/u.test(normalized)) {
      const path = normalized.slice('/workspace'.length).trim();
      if (!path) {
        return this.rejected(requestId, idempotencyKey, 'workspace_path_required');
      }
      return this.selectWorkspace(sender, channel, path, requestId, idempotencyKey);
    }
    if (normalized === '/conversations') {
      return this.listConversations(sender, channel, requestId, idempotencyKey);
    }
    const attachMatch = /^\/conversation(?:\s+(\S+))?$/u.exec(normalized);
    if (attachMatch) {
      const conversationId = attachMatch[1];
      if (!conversationId) {
        return this.rejected(requestId, idempotencyKey, 'conversation_id_required');
      }
      return this.attachConversation(
        sender,
        channel,
        conversationId,
        requestId,
        idempotencyKey,
      );
    }
    const historyMatch = /^\/history(?:\s+(\S+))?$/u.exec(normalized);
    if (historyMatch) {
      return this.getHistory(
        sender,
        channel,
        requestId,
        idempotencyKey,
        undefined,
        boundedHistoryLimit(historyMatch[1]),
      );
    }
    return this.submitConversationCommand(
      sender,
      channel,
      normalized.startsWith('/')
        ? { kind: 'slash_command', text: normalized }
        : { kind: 'user_message', text: normalized, attachments: [] },
      requestId,
      idempotencyKey,
      normalized.startsWith('/') ? undefined : attachments,
    );
  }

  /**
   * §5.5: persists attachment bytes into the Gateway attachment store ONLY
   * after the bound Conversation is known — including the first message that
   * CREATES the Conversation (a brand-new Conversation must not drop the
   * screenshot that created it).
   */
  private async persistAttachmentsForConversation(
    conversationId: string,
    channel: FeishuChannelBinding,
    attachments: Array<{ path: string; name: string; kind: 'image' | 'file' }> | undefined,
    workspaceId: string,
  ): Promise<Array<{ attachmentId: string; kind: string }>> {
    if (!attachments || attachments.length === 0 || !this.deps.attachments) return [];
    const references: Array<{ attachmentId: string; kind: string }> = [];
    const { readFile } = await import('node:fs/promises');
    for (const attachment of attachments) {
      try {
        const bytes = await readFile(attachment.path);
        const saved = await this.deps.attachments.saveAttachment({
          conversationId,
          workspaceId,
          name: attachment.name,
          bytes,
        }) as { attachmentId: string };
        references.push({ attachmentId: saved.attachmentId, kind: attachment.kind });
        this.deps.onAttachmentSaved?.({
          conversationId,
          attachmentId: saved.attachmentId,
          name: attachment.name,
          kind: attachment.kind,
        });
      } catch (error) {
        // A failing attachment never blocks the text command, but the
        // failure is surfaced through the failure callback — never a silent
        // drop (§5.5.6 reports the exact stage).
        this.deps.onAttachmentFailed?.({
          conversationId,
          ...(channel.chatId ? { chatId: channel.chatId } : {}),
          ...(channel.threadId !== undefined ? { threadId: channel.threadId } : {}),
          name: attachment.name,
          kind: attachment.kind,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return references;
  }

  routeCardAction(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    action: FeishuConversationCardAction,
    requestId: string,
    idempotencyKey: string,
  ): Promise<FeishuConversationRouteResult> {
    return this.serialize(sender, channel, () => this.routeCardActionOpen(
      sender,
      channel,
      action,
      requestId,
      idempotencyKey,
    ));
  }

  private async routeCardActionOpen(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    action: FeishuConversationCardAction,
    requestId: string,
    idempotencyKey: string,
  ): Promise<FeishuConversationRouteResult> {
    if (action.kind === 'gateway_action') {
      if (!this.deps.actions) return this.rejected(requestId, idempotencyKey, 'capability_mismatch');
      const principalId = `feishu:${sender.tenantKey}:${sender.userId}`;
      const target = this.deps.actions.resolve(action.cursor, { accountId: this.deps.accountId, principalId,
        chatId: channel.chatId, threadId: channel.threadId ?? null });
      if (!await this.deps.resolveConversationWorkspace(this.deps.accountId, target.conversationId, principalId)) {
        return this.rejected(requestId, idempotencyKey, 'conversation_denied');
      }
      const connectionId = feishuClientConnectionId(this.deps.accountId, channel, sender);
      const replyEvents: GatewayEventEnvelope[] = [];
      const stop = this.deps.subscriptions.subscribe({ accountId: this.deps.accountId,
        conversationId: clientConnectionEventStreamId(connectionId), listener: event => {
          if (event.requestId === requestId && (event.kind === 'command_result' || event.kind === 'conversation_resource')) replyEvents.push(event);
        } });
      try {
        const result = await this.handle(sender, { requestId, idempotencyKey, connectionId,
          scope: { kind: 'conversation', selection: { mode: 'attach', conversationId: target.conversationId } }, command: target.command });
        return isReceipt(result) ? { ...result, conversationId: target.conversationId, connectionId,
          routeKind: 'conversation_control', replyEvents } : result;
      } finally { stop(); }
    }
    if (action.kind === 'conversation_history') {
      return this.getHistory(
        sender,
        channel,
        requestId,
        idempotencyKey,
        action.cursor,
        boundedHistoryLimit(action.limit),
      );
    }
    return this.listConversations(
      sender,
      channel,
      requestId,
      idempotencyKey,
      action.cursor,
    );
  }

  private async selectWorkspace(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    path: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<FeishuConversationRouteResult> {
    const connectionId = feishuClientConnectionId(this.deps.accountId, channel, sender);
    const result = await this.handle(sender, {
      requestId,
      idempotencyKey,
      connectionId,
      scope: { kind: 'workspace' },
      command: { kind: 'select_workspace', path },
    });
    if (!isReceipt(result) || result.status === 'rejected' || !result.workspaceId) {
      return result;
    }
    this.deps.navigation.write({
      ...bindingKey(this.deps.accountId, channel),
      principalId: `feishu:${sender.tenantKey}:${sender.userId}`,
      workspaceId: result.workspaceId,
      conversationId: null,
    });
    return {
      ...result,
      conversationId: null,
      routeKind: 'workspace_directory',
      connectionId,
    };
  }

  private async listConversations(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    requestId: string,
    idempotencyKey: string,
    cursor?: string,
  ): Promise<FeishuConversationRouteResult> {
    const context = await this.bindingContext(sender, channel);
    if (!context.binding?.workspaceId) {
      return this.rejected(requestId, idempotencyKey, 'workspace_required');
    }
    await this.restoreWorkspace(context);
    const result = await this.handle(sender, {
      requestId,
      idempotencyKey,
      connectionId: context.connectionId,
      scope: { kind: 'workspace' },
      command: {
        kind: 'list_workspace_conversations',
        workspaceId: context.binding.workspaceId,
        ...(cursor ? { cursor } : {}),
      },
    });
    return isReceipt(result)
      ? {
          ...result,
          workspaceId: context.binding.workspaceId,
          routeKind: 'workspace_directory',
          connectionId: context.connectionId,
          projectionRequestId: requestId,
          projectionStreamId: clientConnectionEventStreamId(context.connectionId),
        }
      : result;
  }

  private async attachConversation(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<FeishuConversationRouteResult> {
    const context = await this.bindingContext(sender, channel);
    if (!context.binding?.workspaceId) {
      return this.rejected(requestId, idempotencyKey, 'workspace_required');
    }
    const actualWorkspaceId = await this.deps.resolveConversationWorkspace(
      this.deps.accountId,
      conversationId,
      context.principalId,
    );
    if (!actualWorkspaceId || actualWorkspaceId !== context.binding.workspaceId) {
      return this.rejected(requestId, idempotencyKey, 'conversation_not_in_workspace');
    }
    const page = await this.resource(sender, context.connectionId, conversationId, requestId, idempotencyKey, 'turns');
    if (!isReceipt(page) || page.status === 'rejected') return page;
    this.deps.navigation.write({ ...bindingKey(this.deps.accountId, channel), principalId: context.principalId,
      workspaceId: actualWorkspaceId, conversationId });
    return { ...page, conversationId, workspaceId: actualWorkspaceId, connectionId: context.connectionId,
      routeKind: 'conversation_attached' };
  }

  private async getHistory(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    requestId: string,
    idempotencyKey: string,
    cursor?: string,
    limit?: number,
  ): Promise<FeishuConversationRouteResult> {
    const context = await this.bindingContext(sender, channel);
    if (!context.binding?.workspaceId) {
      return this.rejected(requestId, idempotencyKey, 'workspace_required');
    }
    if (!context.binding.conversationId) {
      return this.rejected(requestId, idempotencyKey, 'conversation_required');
    }
    const actualWorkspaceId = await this.deps.resolveConversationWorkspace(
      this.deps.accountId,
      context.binding.conversationId,
      context.principalId,
    );
    if (actualWorkspaceId !== context.binding.workspaceId) {
      return this.rejected(requestId, idempotencyKey, 'conversation_not_in_workspace');
    }
    const page = await this.resource(sender, context.connectionId, context.binding.conversationId, requestId, idempotencyKey, 'turns', cursor);
    return isReceipt(page) ? { ...page, workspaceId: actualWorkspaceId, connectionId: context.connectionId,
      routeKind: 'conversation_history' } : page;
  }

  private async submitConversationCommand(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    command: Extract<GatewayCommand, { kind: 'user_message' | 'slash_command' }>,
    requestId: string,
    idempotencyKey: string,
    rawAttachments?: Array<{ path: string; name: string; kind: 'image' | 'file' }>,
  ): Promise<FeishuConversationRouteResult> {
    const context = await this.bindingContext(sender, channel);
    if (!context.binding?.workspaceId) {
      return this.rejected(requestId, idempotencyKey, 'workspace_required');
    }
    await this.restoreWorkspace(context);
    let conversationId = context.binding.conversationId;
    if (!conversationId) {
      const createResult = await this.handle(sender, {
        requestId: derivedId('request_create', requestId),
        idempotencyKey: derivedId('idempotency_create', idempotencyKey),
        connectionId: context.connectionId,
        scope: { kind: 'workspace' },
        command: {
          kind: 'create_conversation',
          workspaceId: context.binding.workspaceId,
        },
      });
      if (
        !isReceipt(createResult)
        || createResult.status === 'rejected'
        || !createResult.conversationId
      ) {
        return createResult;
      }
      conversationId = createResult.conversationId;
      this.deps.navigation.write({
        ...bindingKey(this.deps.accountId, channel),
      principalId: `feishu:${sender.tenantKey}:${sender.userId}`,
        workspaceId: context.binding.workspaceId,
        conversationId,
      });
    }
    // §5.5: resolve attachment bytes now that the Conversation exists — the
    // first message that CREATES the Conversation keeps its screenshots too.
    if (command.kind === 'user_message' && rawAttachments?.length) {
      const references = await this.persistAttachmentsForConversation(
        conversationId,
        channel,
        rawAttachments,
        context.binding.workspaceId,
      );
      if (references.length > 0) {
        command = { ...command, attachments: references };
      }
    }
    // Install the default destination before admission; immediate results and restart
    // recovery use the same route, independent of an open Feishu connection.
    const route = this.deps.notifications ? await this.deps.notifications.follow({
      accountId: this.deps.accountId, principalId: context.principalId, conversationId,
      requestId, taskId: null, source: 'default_reply', destination: { platform: 'feishu', tenantKey: sender.tenantKey,
        senderId: sender.userId, chatId: channel.chatId, ...(channel.threadId ? { threadId: channel.threadId } : {}), chatType: channel.chatType ?? 'unknown' },
    }) : null;
    const result = await this.handle(sender, {
      requestId, idempotencyKey, connectionId: context.connectionId,
      scope: { kind: 'conversation', selection: { mode: 'attach', conversationId } }, command,
    });
    if (route && (!isReceipt(result) || result.status === 'rejected')) {
      this.deps.notifications!.unfollow(this.deps.accountId, context.principalId, route.id);
    }
    return isReceipt(result)
      ? {
          ...result,
          workspaceId: context.binding.workspaceId,
          conversationId,
          routeKind: 'conversation_terminal',
          connectionId: context.connectionId,
        }
      : result;
  }

  private async resource(sender: FeishuSenderIdentity, connectionId: string, conversationId: string,
    requestId: string, idempotencyKey: string, resource: 'turns', cursor?: string): Promise<FeishuConversationRouteResult> {
    let resourcePage: unknown;
    const stop = this.deps.subscriptions.subscribe({ accountId: this.deps.accountId,
      conversationId: clientConnectionEventStreamId(connectionId), listener: event => {
        if (event.requestId === requestId && event.kind === 'conversation_resource') {
          resourcePage = (event.payload as { page: unknown }).page;
        }
      } });
    try {
      const result = await this.handle(sender, { requestId, idempotencyKey, connectionId,
        scope: { kind: 'conversation', selection: { mode: 'attach', conversationId } },
        command: { kind: 'get_conversation_resource', conversationId, resource, ...(cursor ? { cursor } : {}) } });
      return isReceipt(result) ? { ...result, conversationId, connectionId, routeKind: 'conversation_history', resourcePage } : result;
    } finally { stop(); }
  }

  private async bindingContext(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
  ): Promise<{
    binding: ConversationBindingRecord | null;
    connectionId: string;
    principalId: string;
  }> {
    const principalId = `feishu:${sender.tenantKey}:${sender.userId}`;
    const key = { ...bindingKey(this.deps.accountId, channel), principalId };
    let binding: ConversationBindingRecord | null = this.deps.navigation.read(key);
    if (!binding) {
      // Legacy channel provenance seeds a user's first selection only after the
      // ordinary ownership check. New selections never overwrite that provenance.
      const legacy = await this.deps.bindings.resolveBinding(this.deps.accountId, 'feishu', channel.chatId, channel.threadId);
      if (legacy?.conversationId) {
        const workspaceId = await this.deps.resolveConversationWorkspace(this.deps.accountId, legacy.conversationId, principalId);
        if (workspaceId) { binding = { ...legacy, workspaceId }; this.deps.navigation.write({ ...binding, principalId }); }
      } else if (legacy?.workspaceId) {
        await this.deps.restoreWorkspace(feishuClientConnectionId(this.deps.accountId, channel, sender), legacy.workspaceId, principalId);
        binding = legacy; this.deps.navigation.write({ ...legacy, principalId });
      }
    }
    return {
      binding,
      connectionId: feishuClientConnectionId(this.deps.accountId, channel, sender),
      principalId,
    };
  }

  private restoreWorkspace(context: {
    binding: ConversationBindingRecord | null;
    connectionId: string;
    principalId: string;
  }): Promise<void> {
    if (!context.binding?.workspaceId) return Promise.resolve();
    return this.deps.restoreWorkspace(
      context.connectionId,
      context.binding.workspaceId,
      context.principalId,
    );
  }

  private async handle(
    sender: FeishuSenderIdentity,
    input: Omit<GatewayCommandEnvelope, 'protocolVersion' | 'clientCapabilities'>,
  ): Promise<ClientGatewayResult & { readonly replyEvents?: readonly GatewayEventEnvelope[] }> {
    const replyEvents: GatewayEventEnvelope[] = [];
    let bytes = 0;
    const stop = this.deps.subscriptions.subscribe({ accountId: this.deps.accountId,
      conversationId: clientConnectionEventStreamId(input.connectionId), listener: event => {
        if (event.requestId !== input.requestId) return;
        bytes += Buffer.byteLength(JSON.stringify(event));
        if (bytes > 256 * 1024) throw new Error('feishu_query_budget');
        replyEvents.push(event);
      } });
    try {
      const result = await this.deps.gateway.handle({ protocolVersion: 2, ...input,
        clientCapabilities: ['conversation_observation_v1', 'conversation_resources_v1', 'multi_client_control_v1'],
      }, 'feishu', sender);
      return { ...result, replyEvents };
    } finally { stop(); }
  }

  private rejected(
    requestId: string,
    idempotencyKey: string,
    reason: string,
  ): FeishuConversationRouteReceipt {
    return {
      requestId,
      idempotencyKey,
      status: 'rejected',
      conversationId: null,
      reason,
      routeKind: 'conversation_terminal',
      connectionId: 'feishu_unresolved',
    };
  }

  private async serialize<T>(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = feishuClientConnectionId(this.deps.accountId, channel, sender);
    const previous = this.operations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.operations.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
  }
}

function bindingKey(
  accountId: string,
  channel: FeishuChannelBinding,
): Pick<
  ConversationBindingRecord,
  'accountId' | 'platform' | 'channelId' | 'threadId'
> {
  return {
    accountId,
    platform: 'feishu',
    channelId: channel.chatId,
    ...(channel.threadId !== undefined ? { threadId: channel.threadId } : {}),
  };
}

export function feishuClientConnectionId(
  accountId: string,
  channel: FeishuChannelBinding,
  sender: FeishuSenderIdentity,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([accountId, 'feishu', sender.tenantKey, sender.userId, channel.chatId, channel.threadId ?? '']))
    .digest('hex')
    .slice(0, 32);
  return `feishu_${digest}`;
}

function derivedId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function boundedHistoryLimit(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return Math.min(Math.max(parsed, 1), 50);
}

function isReceipt(result: ClientGatewayResult): result is CommandReceipt {
  return !('kind' in result);
}
