/**
 * AnyFusion Gateway 客户端协议（镜像根项目 src/gateway 契约）。
 *
 * 本文件在 vendored AnyFusion-Pi fork 内独立维护，不 import 根项目源码。
 * 客户端只提交非信任字段；账户/Principal 身份由服务端注入。
 */

export const GATEWAY_PROTOCOL_VERSION = 2;

export const GATEWAY_EVENT_KINDS = [
  'conversation_snapshot',
  'workspace_changed',
  'workspace_directory_snapshot',
  'workspace_conversation_upserted',
  'workspace_conversation_removed',
  'workspace_activity_changed',
  'workspace_availability_changed',
  'conversation_history_page',
  'turn_started',
  'trace_delta',
  'task_projection',
  'execution_delta',
  'permission_request',
  'artifact',
  'result_delivery_available',
  'result_chunk',
  'result_completed',
  'final_answer',
  'terminal_error',
  'delivery_status',
  'command_completion',
  'task_view_snapshot',
  'usage_billing_projection',
] as const;

export type GatewayEventKind = (typeof GATEWAY_EVENT_KINDS)[number];

export interface GatewayAttachmentRef {
  readonly attachmentId: string;
  readonly kind: string;
}

export type GatewayCommand =
  | { readonly kind: 'select_workspace'; readonly path: string }
  | { readonly kind: 'list_workspace_conversations'; readonly workspaceId: string; readonly cursor?: string; readonly query?: string }
  | { readonly kind: 'create_conversation'; readonly workspaceId: string }
  | { readonly kind: 'archive_conversation'; readonly conversationId: string }
  | { readonly kind: 'attach_conversation'; readonly conversationId: string }
  | { readonly kind: 'get_conversation_history'; readonly conversationId: string; readonly cursor?: string; readonly limit?: number }
  | { readonly kind: 'user_message'; readonly text: string; readonly attachments: GatewayAttachmentRef[] }
  | { readonly kind: 'slash_command'; readonly text: string }
  | { readonly kind: 'permission_resolution'; readonly requestId: string; readonly resolution: 'approve' | 'deny' }
  | { readonly kind: 'cancel_turn'; readonly turnId: string }
  | {
      readonly kind: 'complete_command';
      readonly text: string;
      /** 输入字符串内的 UTF-16 偏移。 */
      readonly cursor?: number;
    }
  | {
      readonly kind: 'get_task_view';
      readonly conversationId: string;
      readonly turnId: string;
      readonly taskId: string;
    }
  | { readonly kind: 'get_query_bill'; readonly queryId: string }
  | { readonly kind: 'get_query_bill_for_turn'; readonly turnId: string }
  | { readonly kind: 'get_task_usage_summary'; readonly taskId: string }
  | {
      readonly kind: 'list_query_bills';
      readonly accountId: string;
      readonly cursor?: string;
      readonly limit?: number;
    }
  | { readonly kind: 'get_usage_summary'; readonly accountId: string };

/** Gateway v2 显式能力：受限只读命令补全。 */
export const GATEWAY_CAPABILITY_COMMAND_COMPLETION = 'command_completion_v1';
/** Gateway v2 显式能力：受限只读 Task 视图查询。 */
export const GATEWAY_CAPABILITY_TASK_VIEW = 'task_view_v1';
/** Gateway v2 显式能力：只读用量与账单投影。 */
export const GATEWAY_CAPABILITY_USAGE_BILLING = 'usage_billing_v1';

/** command_completion 响应 payload（command_completion_v1）。 */
export interface GatewayCommandCompletionPayload {
  readonly queryVersion: 'command_completion_v1';
  readonly requestId: string;
  /** Workspace 补全为 null；Conversation 补全回显目标 ID。 */
  readonly targetConversationId: string | null;
  readonly state: 'inactive' | 'incomplete' | 'executable' | 'invalid';
  readonly suggestions: Array<{
    readonly value: string;
    readonly label: string;
    readonly description: string;
    readonly replacement: {
      readonly start: number;
      readonly end: number;
      readonly text: string;
    };
  }>;
  readonly hint: string | null;
  readonly error: string | null;
}

/**
 * task_view_snapshot 响应 payload（task_view_v1）。
 * timeline 与主仓库 ExecutionProjector 投影同构；展示组件按安全字段消费，
 * 不解析未知字段。
 */
export interface GatewayTaskViewSnapshot {
  readonly queryVersion: 'task_view_v1';
  readonly requestId: string;
  readonly targetConversationId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly goal: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly routing: {
    readonly executor: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly harness: string | null;
  } | null;
  readonly subtasks: Array<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly executor: string | null;
  }>;
  readonly timeline: unknown;
  readonly progressSummary: string | null;
  readonly schedulingReason?: string | null;
  readonly pendingPermission: {
    readonly requestId: string;
    readonly status: 'pending' | 'resolved' | 'expired';
    readonly summary: string | null;
  } | null;
  readonly artifacts: Array<{
    readonly artifactId: string;
    readonly displayName: string;
    readonly relativePath: string;
    readonly mediaType: string;
    readonly previewable: boolean;
    readonly byteLength: number;
    readonly publishedAt: string;
  }>;
  readonly result: {
    readonly resultId: string;
    readonly completeness: 'complete' | 'partial' | 'incomplete';
    readonly certification: 'certified' | 'uncertified';
  } | null;
  /** 快照水位：属于目标 Conversation 的事件流，不是连接流序号。 */
  readonly asOfSequence: number;
}

export type ConversationSelection =
  | { readonly mode: 'attach'; readonly conversationId: string }
  | { readonly mode: 'bound'; readonly binding: { platform: string; channelId: string; threadId?: string } }
  | { readonly mode: 'new'; readonly workspaceId: string };

export type GatewayScope =
  | { readonly kind: 'workspace' }
  | { readonly kind: 'conversation'; readonly selection: ConversationSelection };

export interface GatewayCommandEnvelope {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly connectionId: string;
  readonly scope: GatewayScope;
  readonly command: GatewayCommand;
  readonly resumeFromSequence?: number;
  readonly clientCapabilities: string[];
}

export interface GatewayCommandReceipt {
  readonly requestId: string;
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly conversationId: string | null;
  readonly workspaceId?: string | null;
  readonly reason?: string;
}

export interface GatewayEventEnvelope {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly accountId: string;
  readonly conversationId: string;
  readonly requestId: string | null;
  readonly turnId: string | null;
  readonly kind: GatewayEventKind;
  readonly payload: unknown;
  readonly occurredAt: string;
}

export interface GatewayReplay {
  readonly lastSequence: number;
  readonly snapshot: GatewayEventEnvelope[];
  readonly deltas: GatewayEventEnvelope[];
}

export type GatewayWireClientMessage =
  | { readonly type: 'command'; readonly envelope: GatewayCommandEnvelope }
  | {
      readonly type: 'attach';
      readonly connectionId: string;
      readonly conversationId: string;
      readonly resumeFromSequence?: number;
    }
  | { readonly type: 'close' };

export type GatewayWireServerMessage =
  | {
      readonly type: 'hello';
      readonly sessionId: string;
      readonly attached: boolean;
      /** Server 公布的安全能力清单（旧 Server 可能缺失）。 */
      readonly capabilities?: string[];
    }
  | { readonly type: 'event'; readonly event: GatewayEventEnvelope }
  | { readonly type: 'output'; readonly lines: string[]; readonly event: GatewayEventEnvelope }
  | { readonly type: 'receipt'; readonly receipt: GatewayCommandReceipt }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly requestId?: string;
      readonly event?: GatewayEventEnvelope;
    }
  | { readonly type: 'exit' };
