import { describe, expect, it } from 'vitest';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';
import { retainLiveTurnForConversation } from '../../web/src/conversation-live-turn';

function liveTurn(sessionId: string): ConversationTurnProjection {
  return {
    id: `turn-${sessionId}`,
    sessionId,
    userInput: `task-${sessionId}`,
    status: 'running',
    finalAnswer: null,
    taskId: `task-${sessionId}`,
    startedAt: '2026-08-30T10:00:00.000Z',
    completedAt: null,
    traceEvents: [],
    executionTimeline: null,
    artifactRefs: [],
    artifacts: [],
  };
}

describe('Conversation live Turn ownership', () => {
  it('clears the previous Conversation and preserves a replayed target Turn', () => {
    const targetSessionId = 'conversation-a';
    let current = retainLiveTurnForConversation(liveTurn('conversation-b'), targetSessionId);
    expect(current).toBeNull();

    const replayed = liveTurn(targetSessionId);
    current = replayed;

    // active_session_changed or HTTP attach completion may arrive after replay.
    current = retainLiveTurnForConversation(current, targetSessionId);
    expect(current).toBe(replayed);
  });
});
