/**
 * AnyFusion Gateway 客户端协议（镜像根项目 src/gateway 契约）。
 *
 * 本文件在 vendored AnyFusion-Pi fork 内独立维护，不 import 根项目源码。
 * 客户端只提交非信任字段；账户/Principal 身份由服务端注入。
 */

export const GATEWAY_PROTOCOL_VERSION = 1;

export type GatewayEventKind =
  | 'conversation_snapshot'
  | 'workspace_changed'
  | 'turn_started'
  | 'trace_delta'
  | 'task_projection'
  | 'execution_delta'
  | 'permission_request'
  | 'artifact'
  | 'result_delivery_available'
  | 'result_chunk'
  | 'result_completed'
  | 'final_answer'
  | 'terminal_error'
  | 'delivery_status';

export interface GatewayAttachmentRef {
  readonly attachmentId: string;
  readonly kind: string;
}

export type GatewayCommand =
  | { readonly kind: 'user_message'; readonly text: string; readonly attachments: GatewayAttachmentRef[] }
  | { readonly kind: 'slash_command'; readonly text: string }
  | { readonly kind: 'permission_resolution'; readonly requestId: string; readonly resolution: 'approve' | 'deny' }
  | { readonly kind: 'cancel_turn'; readonly turnId: string };

export type ConversationSelection =
  | { readonly mode: 'attach'; readonly conversationId: string }
  | { readonly mode: 'bound'; readonly binding: { platform: string; channelId: string; threadId?: string } }
  | { readonly mode: 'new' };

export interface GatewayCommandEnvelope {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly connectionId: string;
  readonly conversation: ConversationSelection;
  readonly command: GatewayCommand;
  readonly resumeFromSequence?: number;
  readonly clientCapabilities: string[];
}

export interface GatewayCommandReceipt {
  readonly requestId: string;
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly conversationId: string | null;
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
  | { readonly type: 'attach'; readonly conversationId: string; readonly resumeFromSequence?: number }
  | { readonly type: 'close' };

export type GatewayWireServerMessage =
  | { readonly type: 'hello'; readonly sessionId: string }
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
