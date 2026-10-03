import type { GatewayEventEnvelope } from '../gateway/client-events.js';

export * from './conversation-read-types.js';
import { CONVERSATION_PREVIEW_BYTES,
  type ConversationContentReference, type ConversationReadBaseline, type ConversationReadHead,
  type ConversationTurnView, type ConversationTurnPage, type ConversationViewCursor, type ConversationViewChange,
} from './conversation-read-types.js';

export interface ConversationReadModel {
  isRemoved(accountId: string, conversationId: string, turnId: string): boolean;
  remove(accountId: string, conversationId: string, turnId: string): void;
  putContent(accountId: string, conversationId: string, value: string): ConversationContentReference;
  putContentChunk(accountId: string, conversationId: string, reference: ConversationContentReference, offset: number, text: string): void;
  verifyContent(accountId: string, conversationId: string, reference: ConversationContentReference): boolean;
  /** Head and page come from one database snapshot; subscribe before calling. */
  baseline(accountId: string, conversationId: string): ConversationReadBaseline;
  head(accountId: string, conversationId: string): ConversationReadHead | null;
  findTurn(accountId: string, conversationId: string, turnId: string): ConversationTurnView | null;
  findTaskTurn(accountId: string, conversationId: string, taskId: string): ConversationTurnView | null;
  page(accountId: string, conversationId: string, request?: {
    cursor?: string; beforeTurnId?: string; limit?: number; maxBytes?: number; activeOnly?: boolean;
  }): ConversationTurnPage;
  changes(accountId: string, conversationId: string, cursor: ConversationViewCursor):
    { reset: boolean; head: ConversationReadHead | null; changes: readonly ConversationViewChange[] };
  /** Atomically commits bodies, view changes and the durable source checkpoint. */
  commit(accountId: string, conversationId: string, turns: readonly ConversationTurnView[], journalSequence: number,
    bodies?: readonly { hash: string; value: string }[]): void;
  content(accountId: string, conversationId: string, hash: string, offset: number, maxBytes: number):
    { text: string; offset: number; nextOffset: number; byteLength: number } | null;
}

/** Bounded UTF-8 prefix without broken code points. */
export function conversationPreview(value: string, maxBytes = CONVERSATION_PREVIEW_BYTES): string {
  const data = Buffer.from(value);
  let end = Math.min(data.length, maxBytes);
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  let preview = data.subarray(0, end).toString('utf8');
  // Escaped control characters also count against the hot wire budget.
  while (Buffer.byteLength(JSON.stringify(preview)) > maxBytes + 2) {
    end = Math.floor(end * 0.8);
    while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
    preview = data.subarray(0, end).toString('utf8');
  }
  return preview;
}

/** Pure projection of public Gateway facts; never interprets executor logs or Task policy. */
export function projectConversationTurn(
  previous: ConversationTurnView | null, event: GatewayEventEnvelope,
): ConversationTurnView | null {
  if (!event.turnId || !['turn_started', 'trace_delta', 'task_projection', 'result_delivery_available',
    'result_chunk', 'result_completed', 'delivery_status', 'final_answer', 'terminal_error'].includes(event.kind)) return previous;
  if (previous && previous.lastSequence >= event.sequence) return previous;
  const value = record(event.payload);
  const turn: { -readonly [K in keyof ConversationTurnView]: ConversationTurnView[K] } = previous ? { ...previous } : {
    id: event.turnId, conversationId: event.conversationId, requestId: event.requestId,
    revision: 0, firstSequence: event.sequence, lastSequence: event.sequence,
    userInput: '', userInputRef: null, answer: '', answerRef: null,
    resultId: null, certification: null, completeness: null, resultOffset: 0, resultPreviewOmitted: false,
    status: 'running', deliveryStatus: 'none', taskId: null,
    startedAt: event.occurredAt, completedAt: null, interactionKind: 'ai_turn',
  };
  turn.lastSequence = event.sequence;
  if (typeof value.taskId === 'string' && turn.taskId && value.taskId !== turn.taskId) return previous;
  if (event.kind === 'final_answer' && typeof value.resultId === 'string' && turn.resultId && value.resultId !== turn.resultId) return previous;
  if (event.kind === 'turn_started') {
    if (typeof value.userInput === 'string') turn.userInput = conversationPreview(value.userInput);
    if (value.interactionKind === 'system_command') turn.interactionKind = 'system_command';
  }
  if (event.kind === 'trace_delta') {
    for (const item of Array.isArray(value.events) ? value.events : []) {
      const trace = record(item);
      if (!turn.userInput && trace.kind === 'query_received' && trace.actor === 'user'
        && typeof trace.summary === 'string') turn.userInput = conversationPreview(trace.summary);
    }
    if (typeof value.taskId === 'string' && (!turn.taskId || turn.taskId === value.taskId)) turn.taskId = value.taskId;
    if ((!value.taskId || value.taskId === turn.taskId) && isTurnStatus(value.status)) {
      turn.status = previous && previous.status !== 'running' ? previous.status : value.status;
      turn.completedAt = turn.status === 'running' ? null :
        previous?.completedAt ?? (typeof value.completedAt === 'string' ? value.completedAt : event.occurredAt);
    }
  }
  if (event.kind === 'task_projection' && typeof value.currentTaskId === 'string') turn.taskId ??= value.currentTaskId;
  if (event.kind === 'result_delivery_available' && typeof value.resultId === 'string') {
    if (turn.resultId !== value.resultId) {
      turn.answer = ''; turn.answerRef = null; turn.resultOffset = 0; turn.resultPreviewOmitted = false;
    }
    turn.resultId = value.resultId;
    if (value.certification === 'certified' || value.certification === 'uncertified') turn.certification = value.certification;
    if (value.completeness === 'complete' || value.completeness === 'partial' || value.completeness === 'incomplete') {
      turn.completeness = value.completeness;
    }
    if (typeof value.contentHash === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.contentHash)
      && typeof value.byteLength === 'number' && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0) {
      turn.answerRef = { hash: value.contentHash.slice(7), byteLength: value.byteLength };
    }
    turn.deliveryStatus = 'streaming';
  }
  if (event.kind === 'result_chunk' && typeof value.chunk === 'string' && typeof value.offset === 'number'
    && value.resultId === turn.resultId) {
    if (value.offset === turn.resultOffset) {
      const next = turn.answer + value.chunk;
      turn.answer = conversationPreview(next);
      turn.resultOffset += Buffer.byteLength(value.chunk);
      turn.resultPreviewOmitted ||= Buffer.byteLength(next) > CONVERSATION_PREVIEW_BYTES;
    } else if (value.offset > turn.resultOffset) turn.resultPreviewOmitted = true;
  }
  // Observing completion is not a claim that this preview passed full ResultObject verification.
  if (event.kind === 'result_completed' && value.resultId === turn.resultId) turn.deliveryStatus = 'verifying';
  if (event.kind === 'delivery_status' && value.resultId === turn.resultId && isDeliveryStatus(value.status)) {
    turn.deliveryStatus = value.status;
  }
  if (event.kind === 'final_answer') {
    const lines = Array.isArray(value.lines) ? value.lines.filter((line): line is string => typeof line === 'string') : [];
    if (!turn.resultId && lines.length) { turn.answer = conversationPreview(lines.join('\n')); turn.deliveryStatus = 'ready'; }
    if (value.backgroundWorkPending !== true) {
      if (turn.status === 'running') turn.status = 'completed';
      turn.completedAt ??= event.occurredAt;
    }
  }
  if (event.kind === 'terminal_error') {
    if (turn.status === 'running') turn.status = value.code === 'cancelled' ? 'cancelled' : 'failed';
    turn.completedAt ??= event.occurredAt;
  }
  return turn;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isTurnStatus(value: unknown): value is ConversationTurnView['status'] {
  return typeof value === 'string' && ['running', 'completed', 'failed', 'blocked', 'cancelled'].includes(value);
}

function isDeliveryStatus(value: unknown): value is ConversationTurnView['deliveryStatus'] {
  return typeof value === 'string' && ['none', 'streaming', 'verifying', 'ready', 'failed'].includes(value);
}
