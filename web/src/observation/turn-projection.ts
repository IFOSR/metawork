import type { ConversationTurnView } from '../../../src/session/conversation-read-types';
import type { ConversationTurnProjection } from '../api/session-types';
/** Compatibility with existing detail widgets; no second event reducer. */
export function turnProjection(turn: ConversationTurnView): ConversationTurnProjection {
  return { id: turn.id, sessionId: turn.conversationId, userInput: turn.userInput,
    interactionKind: turn.interactionKind, status: turn.status, deliveryStatus: turn.deliveryStatus,
    finalAnswer: turn.answer || null, taskId: turn.taskId, startedAt: turn.startedAt,
    completedAt: turn.completedAt, traceEvents: [], executionTimeline: null, artifactRefs: [], artifacts: [] };
}
