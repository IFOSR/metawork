import { describe, expect, it } from 'vitest';
import type {
  ConversationTurnProjection,
  WebSessionRecord,
} from '../../web/src/api/session-types';
import {
  isCurrentConversationRecordRequest,
  retainTerminalLiveTurnInRecord,
  retainLiveTurnForConversation,
} from '../../web/src/conversation-live-turn';

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

  it('accepts only the newest record response for the Conversation still being browsed', () => {
    expect(isCurrentConversationRecordRequest({
      requestId: 7,
      latestRequestId: 7,
      requestedSessionId: 'conversation-a',
      browsedSessionId: 'conversation-a',
    })).toBe(true);

    expect(isCurrentConversationRecordRequest({
      requestId: 6,
      latestRequestId: 7,
      requestedSessionId: 'conversation-a',
      browsedSessionId: 'conversation-a',
    })).toBe(false);

    expect(isCurrentConversationRecordRequest({
      requestId: 7,
      latestRequestId: 7,
      requestedSessionId: 'conversation-a',
      browsedSessionId: 'conversation-b',
    })).toBe(false);
  });

  it('retains a completed live Turn before the next Turn replaces it', () => {
    const record = {
      version: 1,
      session: { id: 'conversation-a' },
      turns: [],
    } as WebSessionRecord;
    const completedTurn = {
      ...liveTurn('conversation-a'),
      status: 'completed',
      finalAnswer: 'first answer',
      completedAt: '2026-09-10T10:01:00.000Z',
    } as ConversationTurnProjection;

    expect(retainTerminalLiveTurnInRecord(record, completedTurn)?.turns).toEqual([
      completedTurn,
    ]);
    expect(retainTerminalLiveTurnInRecord(record, liveTurn('conversation-a'))).toBe(record);
  });
});
