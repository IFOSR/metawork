/**
 * Gateway 受限只读查询分支（统一 TUI 设计 §9.3）。
 *
 * complete_command / get_task_view 的响应只发布到请求连接的 connection 事件流：
 * - 不写 Conversation 历史，不广播给其他连接；
 * - 不持久化补全草稿与候选（响应不经 journal.append，仅经 reserveSequence
 *   共用连接流序号分配器）；
 * - receipt 与数据响应分离；payload 显式携带目标 Conversation ID。
 */

import { nanoid } from 'nanoid';
import type { CommandCompletion } from '../commands/catalog.js';
import {
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  gatewayEventPayloadBytes,
  sanitizeGatewayEventPayload,
  type GatewayEventEnvelope,
} from './client-events.js';
import { clientConnectionEventStreamId } from './client-connection-event-stream.js';
import type { EventJournal } from './event-journal.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import type { GatewayScope } from './client-protocol.js';
import type {
  GatewayReadOnlyQuery,
  GatewayReadOnlyQueryContext,
  GatewayReadOnlyQueryResult,
} from './client-gateway.js';
import {
  GATEWAY_COMMAND_COMPLETION_QUERY_VERSION,
  type GatewayCommandCompletionPayload,
  type GatewayTaskViewError,
  type GatewayTaskViewSnapshot,
} from './task-view.js';
import type { BillQueryService } from '../billing/bill-query-service.js';
import type { AccountPermissionService } from '../account/account-permission-service.js';

/**
 * Workspace scope 下合法的导航/只读候选（统一 TUI 设计 §9.3）。
 * 静态白名单：不触碰任何 Conversation 数据，不泄露其他会话的 Task 或配置。
 */
const WORKSPACE_NAVIGATION_COMMANDS = [
  { value: '/workspace', label: '/workspace', description: '选择 Workspace：/workspace /absolute/path' },
  { value: '/conversations', label: '/conversations', description: '列出并选择当前 Workspace 的 Conversation' },
  { value: '/help', label: '/help', description: '查看命令帮助' },
  { value: '/exit', label: '/exit', description: '退出客户端（不取消 Server 工作）' },
] as const;

export function completeWorkspaceNavigationCommand(text: string, cursor?: number): CommandCompletion {
  const inactive: CommandCompletion = { state: 'inactive', suggestions: [], hint: null, error: null };
  if (!text.startsWith('/')) return inactive;
  const position = Math.max(0, Math.min(cursor ?? text.length, text.length));
  const firstTokenEnd = text.search(/\s/u);
  const inFirstToken = firstTokenEnd === -1 || position <= firstTokenEnd;
  if (!inFirstToken) return inactive;
  const prefix = text.slice(1, position).toLowerCase();
  const suggestions = WORKSPACE_NAVIGATION_COMMANDS
    .filter(candidate => candidate.value.slice(1).toLowerCase().startsWith(prefix))
    .map(candidate => ({
      value: candidate.value,
      label: candidate.label,
      description: candidate.description,
      replacement: {
        start: 0,
        end: firstTokenEnd === -1 ? text.length : firstTokenEnd,
        text: candidate.value,
      },
    }));
  return {
    state: suggestions.some(item => item.value === text) ? 'executable' : 'incomplete',
    suggestions,
    hint: suggestions.length === 0 ? '暂无匹配候选。' : null,
    error: null,
  };
}

export interface GatewayReadOnlyQueryHandlerDeps {
  readonly subscriptions: GatewaySubscriptions;
  readonly journal: EventJournal;
  /** Conversation/Workspace 归属校验；拒绝时查询 fail closed。 */
  readonly authorizeConversation: (
    accountId: string,
    conversationId: string,
  ) => Promise<boolean>;
  /**
   * Server 命令目录补全。实现只能使用既有 ConversationSession.completeCommand
   * 的查询能力，不得把 CommandContext / catalog 实现暴露给客户端。
   */
  readonly completeCommand: (input: {
    readonly accountId: string;
    readonly scope: GatewayScope;
    readonly text: string;
    readonly cursor?: number;
  }) => Promise<CommandCompletion> | CommandCompletion;
  /** Task 安全展示快照查询；未知或不匹配的关联返回结构化错误。 */
  readonly getTaskView: (input: {
    readonly accountId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly taskId: string;
    readonly requestId: string;
  }) => Promise<GatewayTaskViewSnapshot | { readonly error: GatewayTaskViewError }>;
  readonly authorizeTask?: (accountId: string, taskId: string) => Promise<boolean> | boolean;
  readonly billing?: BillQueryService;
  readonly pendingInteractions?: (accountId: string, conversationId: string, cursor?: string, limit?: number) =>
    Promise<ReturnType<AccountPermissionService['listForSession']>>;
  readonly conversationResource?: (accountId: string, command: Extract<GatewayReadOnlyQuery, { kind: 'get_conversation_resource' }>) => Promise<unknown>;
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
}

export function createGatewayReadOnlyQueryHandler(
  deps: GatewayReadOnlyQueryHandlerDeps,
): (
  command: GatewayReadOnlyQuery,
  context: GatewayReadOnlyQueryContext,
) => Promise<GatewayReadOnlyQueryResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const createId = deps.createId ?? (prefix => `${prefix}_${nanoid(12)}`);

  const publishToConnection = async (
    context: GatewayReadOnlyQueryContext,
    kind: 'command_completion' | 'task_view_snapshot' | 'usage_billing_projection' | 'pending_interactions' | 'conversation_resource',
    payload: unknown,
  ): Promise<void> => {
    if (!deps.journal.reserveSequence) {
      throw new Error('connection stream sequence reservation is unavailable');
    }
    const streamId = clientConnectionEventStreamId(context.connectionId);
    const sequence = await deps.journal.reserveSequence(context.accountId, streamId);
    const sanitized = sanitizeGatewayEventPayload(payload);
    if (gatewayEventPayloadBytes(sanitized) > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) {
      throw new Error('read-only query response exceeds the Gateway event payload limit');
    }
    const event: GatewayEventEnvelope = {
      protocolVersion: 2,
      eventId: createId('event'),
      sequence,
      accountId: context.accountId,
      conversationId: streamId,
      requestId: context.requestId,
      turnId: null,
      kind,
      payload: sanitized,
      occurredAt: now(),
    };
    deps.subscriptions.publish(event);
  };

  return async (command, context) => {
    if (command.kind === 'get_conversation_resource') {
      if (!await deps.authorizeConversation(context.accountId, command.conversationId)) return { status: 'rejected', reason: 'conversation_denied' };
      if (!deps.conversationResource) return { status: 'rejected', reason: 'capability_mismatch' };
      const page = await deps.conversationResource(context.accountId, command);
      await publishToConnection(context, 'conversation_resource', { targetConversationId: command.conversationId,
        resource: command.resource, page });
      return { status: 'accepted', conversationId: command.conversationId };
    }
    if (command.kind === 'get_pending_interactions') {
      if (!await deps.authorizeConversation(context.accountId, command.conversationId)) {
        return { status: 'rejected', reason: 'conversation_denied' };
      }
      if (!deps.pendingInteractions) return { status: 'rejected', reason: 'pending_interactions_unavailable' };
      const requests = await deps.pendingInteractions(context.accountId, command.conversationId, command.cursor, 9);
      // Each descriptor is a standalone bounded reply. The terminal frame
      // certifies completeness, so an interrupted response is never an empty list.
      for (const request of requests.slice(0, 8)) await publishToConnection(context, 'pending_interactions', {
        targetConversationId: command.conversationId, request, complete: false,
      });
      await publishToConnection(context, 'pending_interactions', { targetConversationId: command.conversationId, complete: true,
        nextCursor: requests.length > 8 ? requests[7]!.permissionRequestId : null });
      return { status: 'accepted', conversationId: command.conversationId };
    }
    if (command.kind === 'complete_command') {
      const targetConversationId = context.scope.kind === 'conversation'
        && context.scope.selection.mode === 'attach'
        ? context.scope.selection.conversationId
        : null;
      if (targetConversationId) {
        const authorized = await deps.authorizeConversation(
          context.accountId,
          targetConversationId,
        );
        if (!authorized) {
          return { status: 'rejected', reason: 'conversation_denied' };
        }
      }
      const completion = await deps.completeCommand({
        accountId: context.accountId,
        scope: context.scope,
        text: command.text,
        ...(command.cursor !== undefined ? { cursor: command.cursor } : {}),
      });
      const payload: GatewayCommandCompletionPayload = {
        queryVersion: GATEWAY_COMMAND_COMPLETION_QUERY_VERSION,
        requestId: context.requestId,
        targetConversationId,
        state: completion.state,
        suggestions: completion.suggestions.slice(0, 50),
        hint: completion.hint,
        error: completion.error,
      };
      await publishToConnection(context, 'command_completion', payload);
      return {
        status: 'accepted',
        conversationId: targetConversationId,
      };
    }

    const billingCommand = command.kind === 'get_query_bill'
      || command.kind === 'get_query_bill_for_turn'
      || command.kind === 'get_task_usage_summary'
      || command.kind === 'list_query_bills'
      || command.kind === 'get_usage_summary';
    if (billingCommand) {
      if (!deps.billing) return { status: 'rejected', reason: 'usage_billing_unavailable' };
    }
    const billing = deps.billing;
    if (command.kind === 'get_query_bill' || command.kind === 'get_query_bill_for_turn') {
      if (!billing) return { status: 'rejected', reason: 'usage_billing_unavailable' };
      if (command.kind === 'get_query_bill') {
        const bill = billing.getQueryBillForAccount(context.accountId, command.queryId);
        if (!bill) return { status: 'rejected', reason: 'query_bill_not_found' };
        await publishToConnection(context, 'usage_billing_projection', bill);
        return { status: 'accepted' };
      }
      // Turn 查询必须返回三态用户视图：账单记录在 finalize 前不存在，
      // 按记录查询会让流式客户端在计量收束前永远拿不到投影。
      const view = billing.getTurnBillUserView(
        context.accountId,
        command.turnId,
        { liveFallback: true },
      );
      if (!view) return { status: 'rejected', reason: 'query_bill_not_found' };
      await publishToConnection(
        context,
        'usage_billing_projection',
        { turnId: command.turnId, turnBill: view },
      );
      return { status: 'accepted' };
    }
    if (billingCommand) {
      if (!billing) return { status: 'rejected', reason: 'usage_billing_unavailable' };
      if ('accountId' in command && command.accountId !== context.accountId) {
        return { status: 'rejected', reason: 'account_denied' };
      }
      if (
        command.kind === 'get_task_usage_summary'
        && (!deps.authorizeTask || !(await deps.authorizeTask(context.accountId, command.taskId)))
      ) {
        return { status: 'rejected', reason: 'task_usage_not_found' };
      }
      const payload = command.kind === 'get_task_usage_summary'
        ? billing.getTaskUsageSummaryForAccount(context.accountId, command.taskId)
          ?? billing.getTaskUsageSummary(command.taskId)
        : command.kind === 'get_usage_summary'
          ? billing.getUsageSummary(context.accountId)
          : billing.listQueryBillsPage
            ? billing.listQueryBillsPage({
              accountId: context.accountId,
              limit: command.limit ?? 20,
              ...(command.cursor ? { cursor: command.cursor } : {}),
            })
            : billing.listQueryBills({
              accountId: context.accountId,
              limit: command.limit ?? 20,
            });
      if (payload === null) {
        return { status: 'rejected', reason: 'task_usage_not_found' };
      }
      await publishToConnection(context, 'usage_billing_projection', payload);
      return { status: 'accepted' };
    }

    if (command.kind !== 'get_task_view') {
      return { status: 'rejected', reason: 'readonly_query_unavailable' };
    }
    const authorized = await deps.authorizeConversation(
      context.accountId,
      command.conversationId,
    );
    if (!authorized) {
      return { status: 'rejected', reason: 'conversation_denied' };
    }
    const view = await deps.getTaskView({
      accountId: context.accountId,
      conversationId: command.conversationId,
      turnId: command.turnId,
      taskId: command.taskId,
      requestId: context.requestId,
    });
    if ('error' in view) {
      return {
        status: 'rejected',
        conversationId: command.conversationId,
        reason: view.error,
      };
    }
    await publishToConnection(context, 'task_view_snapshot', view);
    return { status: 'accepted', conversationId: command.conversationId };
  };
}
