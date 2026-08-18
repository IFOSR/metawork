// 与 src/gateway/client-events.ts 契约同构的前端类型。初期手动同步。
//
// Web 客户端只识别已知的 Gateway event kind，并拒绝未知协议版本，避免
// 客户端与服务端事件协议漂移。

export type GatewayEventKind =
  | 'conversation_snapshot'
  | 'turn_started'
  | 'trace_delta'
  | 'task_projection'
  | 'execution_delta'
  | 'permission_request'
  | 'artifact'
  | 'final_answer'
  | 'terminal_error'
  | 'delivery_status';

export const GATEWAY_EVENT_KINDS: readonly GatewayEventKind[] = [
  'conversation_snapshot',
  'turn_started',
  'trace_delta',
  'task_projection',
  'execution_delta',
  'permission_request',
  'artifact',
  'final_answer',
  'terminal_error',
  'delivery_status',
];

export interface GatewayEventEnvelope {
  readonly protocolVersion: 1;
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

export function isKnownGatewayEventKind(kind: string): kind is GatewayEventKind {
  return (GATEWAY_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isSupportedGatewayProtocolVersion(version: unknown): version is 1 {
  return version === 1;
}
