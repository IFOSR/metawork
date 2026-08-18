/**
 * 版本化 Gateway 事件出口契约（ADR-0031 第 8 节）。
 *
 * 事件流只承载会话输出、安全交互轨迹、Task/执行投影、权限请求、产物、
 * 终态回复与结构化错误。绝不承载隐藏思维链、原始 prompt、凭证、无限制工具
 * 载荷或未脱敏 stdout/stderr。
 *
 * 纯协议模块：不 import repository / socket / http / planner / kernel /
 * executor 实现。
 */

import { GATEWAY_PROTOCOL_VERSION } from './client-protocol.js';

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

export const TERMINAL_GATEWAY_EVENT_KINDS: readonly GatewayEventKind[] = [
  'final_answer',
  'terminal_error',
  'delivery_status',
];

/** 单个事件 payload 的大小上限（字节），进入事件日志前必须通过该边界。 */
export const MAX_GATEWAY_EVENT_PAYLOAD_BYTES = 64 * 1024;

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

export interface GatewayCommandReceipt {
  readonly requestId: string;
  readonly status: 'accepted' | 'duplicate' | 'rejected';
  readonly turnId: string | null;
  readonly reason?: string;
}

/** 重连回放：当前快照 + 之后缺失的 delta，以及最新的序列号。 */
export interface GatewayReplay {
  readonly lastSequence: number;
  readonly snapshot: GatewayEventEnvelope[];
  readonly deltas: GatewayEventEnvelope[];
}

export function isTerminalGatewayEvent(kind: GatewayEventKind): boolean {
  return TERMINAL_GATEWAY_EVENT_KINDS.includes(kind);
}
