import type { ConversationTurn } from './conversation-store.js';

/** Durable canonical history backfill. Invoked only by bounded background maintenance. */
export interface ConversationHistoryProjectionSource {
  next(accountId: string, conversationId: string): { sequence: number; turn: ConversationTurn } | null;
  commit(accountId: string, conversationId: string, sequence: number, project: () => void): void;
}
