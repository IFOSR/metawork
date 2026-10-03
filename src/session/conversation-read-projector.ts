import { createHash } from 'node:crypto';
import type { GatewayEventEnvelope } from '../gateway/client-events.js';
import type { ConversationTurn } from './conversation-store.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';
import {
  conversationPreview, projectConversationTurn,
  type ConversationContentReference, type ConversationReadModel, type ConversationTurnView,
} from './conversation-read-model.js';

/** Replays only the unprojected durable suffix, outside any client lifetime. */
export class ConversationReadProjector {
  constructor(private readonly store: ConversationReadModel) {}

  /** Canonical history is a separate source; its sequence is never a journal cursor. */
  applyHistory(accountId: string, conversationId: string, source: ConversationTurn, historySequence: number): void {
    const previous = this.store.findTurn(accountId, conversationId, source.id);
    const initial = previous ?? projectConversationTurn(null, {
      protocolVersion: 2, eventId: `history:${source.id}`, sequence: 0,
      accountId, conversationId, turnId: source.id, requestId: null,
      kind: 'turn_started', payload: {}, occurredAt: '',
    })!;
    const userInput = redactSensitiveText(source.userInput);
    const answer = source.finalAnswer === null ? null : redactSensitiveText(source.finalAnswer);
    const userInputRef = this.store.putContent(accountId, conversationId, userInput);
    // A ResultObject reference remains authoritative over terminal display text.
    const answerRef = initial.resultId && initial.answerRef ? initial.answerRef
      : answer !== null ? this.store.putContent(accountId, conversationId, answer) : initial.answerRef;
    const turn: ConversationTurnView = {
      ...initial, userInput: conversationPreview(userInput), userInputRef,
      answer: initial.resultId ? initial.answer : answer !== null ? conversationPreview(answer) : initial.answer,
      answerRef, status: previous && previous.status !== 'running' ? previous.status : source.status,
      deliveryStatus: answerRef && this.store.content(accountId, conversationId, answerRef.hash, 0, 4)
        ? 'ready' : initial.deliveryStatus,
      // Imported history precedes live events. Existing Turn order never moves.
      firstSequence: previous?.firstSequence ?? historySequence - Number.MAX_SAFE_INTEGER,
      interactionKind: source.userInput.trim().startsWith('/') ? 'system_command' : 'ai_turn',
    };
    if (previous && JSON.stringify({ ...turn, revision: previous.revision }) === JSON.stringify(previous)) return;
    this.store.commit(accountId, conversationId, [turn], this.store.head(accountId, conversationId)?.journalSequence ?? 0);
  }

  apply(accountId: string, conversationId: string, events: readonly GatewayEventEnvelope[], through: number): void {
    const head = this.store.head(accountId, conversationId);
    const changed = new Map<string, ConversationTurnView>();
    const bodies = new Map<string, string>();
    const content = (value: string): ConversationContentReference => {
      const hash = createHash('sha256').update(value).digest('hex');
      bodies.set(hash, value);
      return { hash, byteLength: Buffer.byteLength(value) };
    };
    for (const event of events) {
      if (event.accountId !== accountId || event.conversationId !== conversationId) throw new Error('observation_source_scope_mismatch');
      if (!event.turnId || event.sequence <= (head?.journalSequence ?? 0)
        || this.store.isRemoved(accountId, conversationId, event.turnId)) continue;
      const previous = changed.get(event.turnId) ?? this.store.findTurn(accountId, conversationId, event.turnId);
      let turn = projectConversationTurn(previous, event);
      if (!turn || turn === previous) continue;
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
      if (event.kind === 'result_chunk' && turn.answerRef && payload.resultId === turn.resultId
        && typeof payload.offset === 'number' && typeof payload.chunk === 'string') {
        this.store.putContentChunk(accountId, conversationId, turn.answerRef, payload.offset, payload.chunk);
      }
      if (event.kind === 'turn_started' && typeof payload.userInput === 'string') {
        const ref = payload.userInputRef as ConversationContentReference | undefined;
        const valid = ref && /^[a-f0-9]{64}$/.test(ref.hash) && Number.isSafeInteger(ref.byteLength)
          && this.store.content(accountId, conversationId, ref.hash, 0, 4)?.byteLength === ref.byteLength;
        turn = { ...turn, userInputRef: valid ? ref : content(payload.userInput) };
      }
      if (event.kind === 'trace_delta' && !turn.userInputRef && Array.isArray(payload.events)) {
        for (const value of payload.events) {
          const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          if (item.kind === 'query_received' && item.actor === 'user' && typeof item.summary === 'string') {
            turn = { ...turn, userInput: conversationPreview(item.summary), userInputRef: content(item.summary) };
            break;
          }
        }
      }
      if (event.kind === 'final_answer' && !turn.resultId && !payload.resultId && Array.isArray(payload.lines) && payload.lines.length) {
        const answer = payload.lines.filter((line): line is string => typeof line === 'string').join('\n');
        turn = { ...turn, answerRef: content(answer) };
      }
      if ((event.kind === 'result_completed' || event.kind === 'final_answer'
        || (event.kind === 'delivery_status' && payload.status === 'ready')) && turn.answerRef && payload.resultId) {
        const verified = this.store.verifyContent(accountId, conversationId, turn.answerRef);
        turn = { ...turn, deliveryStatus: verified ? 'ready' : 'verifying' };
      }
      changed.set(turn.id, turn);
    }
    this.store.commit(accountId, conversationId, [...changed.values()], through,
      [...bodies].map(([hash, value]) => ({ hash, value })));
  }
}
