import type { ConversationTurnProjection } from './api/session-types';

export function retainLiveTurnForConversation(
  turn: ConversationTurnProjection | null,
  sessionId: string,
): ConversationTurnProjection | null {
  return turn?.sessionId === sessionId ? turn : null;
}
