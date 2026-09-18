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

export type FeishuConversationRouteKind =
  | 'workspace_directory'
  | 'conversation_attached'
  | 'conversation_history'
  | 'conversation_terminal';

export interface FeishuConversationRouteReceipt extends CommandReceipt {
  readonly routeKind: FeishuConversationRouteKind;
  readonly connectionId: string;
  readonly projectionRequestId?: string;
  readonly projectionStreamId?: string;
}

export type FeishuConversationRouteResult =
  | ClientGatewayResult
  | FeishuConversationRouteReceipt;

export interface FeishuConversationCardAction {
  readonly kind: 'workspace_conversations' | 'conversation_history';
  readonly cursor: string;
  readonly limit?: number;
  readonly threadId?: string;
  readonly chatType?: 'dm' | 'group' | 'unknown';
}

export interface FeishuConversationRoutingDeps {
  readonly accountId: string;
  readonly gateway: ClientGateway;
  readonly bindings: ConversationBindingRepository;
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
    return this.serialize(channel, () => this.routeMessageOpen(
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
    return this.serialize(channel, () => this.routeCardActionOpen(
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
    const connectionId = connectionIdFor(this.deps.accountId, channel);
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
    await this.deps.bindings.set({
      ...bindingKey(this.deps.accountId, channel),
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
    await this.restoreWorkspace(context);
    const result = await this.handle(sender, {
      requestId,
      idempotencyKey,
      connectionId: context.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
      command: { kind: 'attach_conversation', conversationId },
    });
    if (!isReceipt(result) || result.status === 'rejected') return result;
    await this.deps.bindings.set({
      ...bindingKey(this.deps.accountId, channel),
      workspaceId: context.binding.workspaceId,
      conversationId,
    });
    const historyRequestId = derivedId('request_attach_history', requestId);
    const historyResult = await this.handle(sender, {
      requestId: historyRequestId,
      idempotencyKey: derivedId('idempotency_attach_history', idempotencyKey),
      connectionId: context.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
      command: {
        kind: 'get_conversation_history',
        conversationId,
        limit: 3,
      },
    });
    if (!isReceipt(historyResult) || historyResult.status === 'rejected') {
      return historyResult;
    }
    return {
      ...result,
      workspaceId: context.binding.workspaceId,
      conversationId,
      routeKind: 'conversation_attached',
      connectionId: context.connectionId,
      projectionRequestId: historyRequestId,
    };
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
    await this.restoreWorkspace(context);
    const conversationId = context.binding.conversationId;
    const result = await this.handle(sender, {
      requestId,
      idempotencyKey,
      connectionId: context.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
      command: {
        kind: 'get_conversation_history',
        conversationId,
        ...(cursor ? { cursor } : {}),
        ...(limit ? { limit } : {}),
      },
    });
    return isReceipt(result)
      ? {
          ...result,
          workspaceId: context.binding.workspaceId,
          conversationId,
          routeKind: 'conversation_history',
          connectionId: context.connectionId,
          projectionRequestId: requestId,
        }
      : result;
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
      await this.deps.bindings.set({
        ...bindingKey(this.deps.accountId, channel),
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
    const result = await this.handle(sender, {
      requestId,
      idempotencyKey,
      connectionId: context.connectionId,
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId },
      },
      command,
    });
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

  private async bindingContext(
    sender: FeishuSenderIdentity,
    channel: FeishuChannelBinding,
  ): Promise<{
    binding: ConversationBindingRecord | null;
    connectionId: string;
    principalId: string;
  }> {
    let binding = await this.deps.bindings.resolveBinding(
      this.deps.accountId,
      'feishu',
      channel.chatId,
      channel.threadId,
    );
    const principalId = `feishu:${sender.tenantKey}:${sender.userId}`;
    if (binding?.conversationId && !binding.workspaceId) {
      const workspaceId = await this.deps.resolveConversationWorkspace(
        this.deps.accountId,
        binding.conversationId,
        principalId,
      );
      if (workspaceId) {
        binding = { ...binding, workspaceId };
        await this.deps.bindings.set(binding);
      }
    }
    return {
      binding,
      connectionId: connectionIdFor(this.deps.accountId, channel),
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

  private handle(
    sender: FeishuSenderIdentity,
    input: Omit<GatewayCommandEnvelope, 'protocolVersion' | 'clientCapabilities'>,
  ): Promise<ClientGatewayResult> {
    return this.deps.gateway.handle({
      protocolVersion: 2,
      ...input,
      clientCapabilities: ['workspace-directory', 'conversation-history'],
    }, 'feishu', sender);
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
    channel: FeishuChannelBinding,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = connectionIdFor(this.deps.accountId, channel);
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

function connectionIdFor(
  accountId: string,
  channel: FeishuChannelBinding,
): string {
  const digest = createHash('sha256')
    .update(`${accountId}\0feishu\0${channel.chatId}\0${channel.threadId ?? ''}`)
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
