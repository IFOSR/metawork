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
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export type GatewayEventKind =
  | 'conversation_snapshot'
  | 'workspace_changed'
  | 'workspace_directory_snapshot'
  | 'workspace_conversation_upserted'
  | 'workspace_conversation_removed'
  | 'workspace_activity_changed'
  | 'workspace_availability_changed'
  | 'conversation_history_page'
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

export const GATEWAY_EVENT_KINDS: readonly GatewayEventKind[] = [
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
];

export const TERMINAL_GATEWAY_EVENT_KINDS: readonly GatewayEventKind[] = [
  'result_completed',
  'final_answer',
  'terminal_error',
  'delivery_status',
];

/** 单个事件 payload 的大小上限（字节），进入事件日志前必须通过该边界。 */
export const MAX_GATEWAY_EVENT_PAYLOAD_BYTES = 64 * 1024;
const MAX_GATEWAY_PAYLOAD_DEPTH = 10;
const SENSITIVE_GATEWAY_PAYLOAD_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|credential|authorization|private[_-]?key|connection[_-]?string|prompt|reasoning|thoughts?|raw[_-]?(?:response|output|stdout|stderr)|stdout|stderr|signature|content)(?:$|[_-])/iu;
const SAFE_GATEWAY_PAYLOAD_KEYS = new Set(['contentHash']);

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

export function sanitizeGatewayEventPayload(payload: unknown): unknown {
  return sanitizePayloadValue(payload, 0, new WeakSet<object>());
}

export function gatewayEventPayloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function sanitizePayloadValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
): unknown {
  if (depth > MAX_GATEWAY_PAYLOAD_DEPTH) {
    throw new Error('Gateway event payload exceeds the maximum nesting depth');
  }
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return redactSensitiveText(String(value));
  if (ancestors.has(value)) throw new Error('Gateway event payload must not contain cycles');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => sanitizePayloadValue(item, depth + 1, ancestors));
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
      if (
        !SAFE_GATEWAY_PAYLOAD_KEYS.has(key)
        && SENSITIVE_GATEWAY_PAYLOAD_KEY.test(normalizedKey)
      ) continue;
      sanitized[key] = sanitizePayloadValue(item, depth + 1, ancestors);
    }
    return sanitized;
  } finally {
    ancestors.delete(value);
  }
}
