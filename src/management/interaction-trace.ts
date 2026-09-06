import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import { truncateText } from '../utils/truncate-text.js';

export type InteractionTraceStatus = 'running' | 'completed' | 'failed' | 'blocked';
export type InteractionTraceEventStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
export type InteractionTracePhase =
  | 'intake'
  | 'planning'
  | 'authorization'
  | 'routing'
  | 'execution'
  | 'verification'
  | 'delivery';
export type InteractionTraceActor = 'user' | 'planner' | 'kernel' | 'runtime' | 'executor';

export interface InteractionTrace {
  sessionId: string;
  turnId: string;
  taskId: string | null;
  status: InteractionTraceStatus;
  startedAt: string;
  completedAt: string | null;
  events: InteractionTraceEvent[];
}

export interface InteractionTraceEvent {
  id: string;
  sequence: number;
  /** Stable replay cursor within one turn. */
  cursor?: string;
  /** The idempotent source key used to derive `id`. */
  eventKey?: string;
  /** Safe identity projection for execution detail filtering. */
  taskId?: string | null;
  subtaskId?: string | null;
  attemptId?: string | null;
  occurredAt: string;
  phase: InteractionTracePhase;
  actor: InteractionTraceActor;
  kind: string;
  status: InteractionTraceEventStatus;
  title: string;
  summary: string;
  details: Record<string, unknown>;
}

const SENSITIVE_DETAIL_KEY = /(?:^|[_-])(secret|token|password|passwd|credential|authorization|private[_-]?key|api[_-]?key|prompt|conversation|content|reasoning|thoughts?|signature)(?:$|[_-])/iu;

export function interactionTraceEventId(
  turnId: string,
  kind: string,
  sourceId: string,
): string {
  return `interaction:${boundedId(turnId)}:${boundedId(kind)}:${boundedId(sourceId)}`;
}

export function sanitizeInteractionTraceText(value: string, limit = 500): string {
  return truncateText(redactSensitiveText(value), limit);
}

export function sanitizeInteractionTraceDetails(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeRecord(value, 0);
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= 3) return { truncated: true };
  const sanitized: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
    if (SENSITIVE_DETAIL_KEY.test(normalizedKey)) continue;
    sanitized[key] = sanitizeValue(raw, depth + 1);
  }
  return sanitized;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return sanitizeInteractionTraceText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeValue(item, depth));
  if (value && typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>, depth);
  }
  return value === undefined ? null : sanitizeInteractionTraceText(String(value));
}

const BOUNDED_ID_LIMIT = 160;

function boundedId(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/gu, '_') || 'unknown';
  if (normalized.length <= BOUNDED_ID_LIMIT) return normalized;
  // Truncating alone destroys uniqueness: production attemptIds are ~188
  // chars, so `${attemptId}:progress:N` differs only past char 160 for every
  // N, collapsing all such events onto one dedupe id. Keep a bounded head
  // plus a deterministic hash of the full value instead.
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${normalized.slice(0, BOUNDED_ID_LIMIT - 17)}:${digest}`;
}
