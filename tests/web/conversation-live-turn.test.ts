import { describe, expect, it } from 'vitest';
import type {
  ConversationTurnProjection,
  WebSessionRecord,
} from '../../web/src/api/session-types';
import {
  isCurrentConversationRecordRequest,
  mergeFinalAnswer,
  mergeBilling,
  mergeTraceDelta,
  mergeTraceSnapshot,
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
  it('stays running for a cancellation request and stops on the terminal trace without reloading', () => {
    const running = liveTurn('conversation-a');
    const requested = mergeTraceDelta(running, running.id, [], 'running');
    expect(requested?.status).toBe('running');
    const cancelled = mergeTraceDelta(requested, running.id, [], 'cancelled', '2026-09-21T00:00:00.000Z');
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      completedAt: '2026-09-21T00:00:00.000Z',
    });
  });

  it.each([true, false])('does not reopen a cancelled Turn on a late final answer (background=%s)', backgroundWorkPending => {
    const running = liveTurn('conversation-a');
    const cancelled = mergeTraceDelta(running, running.id, [], 'cancelled', '2026-09-21T00:00:00.000Z');
    const result = mergeFinalAnswer(cancelled, running.id, ['late answer'], '2026-09-21T00:01:00.000Z', backgroundWorkPending);
    expect(result).toMatchObject({
      status: 'cancelled',
      completedAt: '2026-09-21T00:00:00.000Z',
      finalAnswer: 'late answer',
    });
  });

  it('does not reopen a terminal Turn on late trace deltas or snapshots', () => {
    const running = liveTurn('conversation-a');
    const cancelled = mergeTraceDelta(running, running.id, [], 'cancelled', '2026-09-21T00:00:00.000Z');
    expect(mergeTraceDelta(cancelled, running.id, [], 'running')).toMatchObject({
      status: 'cancelled',
      completedAt: '2026-09-21T00:00:00.000Z',
    });
    expect(mergeTraceSnapshot(cancelled, {
      sessionId: running.sessionId,
      turnId: running.id,
      taskId: running.taskId,
      status: 'running',
      startedAt: running.startedAt,
      completedAt: null,
      events: [],
    })).toMatchObject({
      status: 'cancelled',
      completedAt: '2026-09-21T00:00:00.000Z',
    });
  });

  it('ignores a cancellation for a different Turn', () => {
    const running = liveTurn('conversation-a');
    expect(mergeTraceDelta(running, 'another-turn', [], 'cancelled')).toBe(running);
    expect(mergeFinalAnswer(running, 'another-turn', ['stopped'], '2026-09-21T00:00:00.000Z')).toBe(running);
  });

  it('merges a late billing projection without reopening a terminal Turn', () => {
    const running = liveTurn('conversation-a');
    const completed = mergeTraceDelta(running, running.id, [], 'completed', '2026-09-21T00:00:00.000Z');
    const projected = mergeBilling(completed, running.id, {
      billId: 'bill-1', queryId: 'query-1', taskId: null, state: 'finalized',
      assessedMicroCoin: '1400000', assessedIsFinal: true, externalState: 'received',
      externalEntryId: null, confirmedDeductedMicroCoin: null, coverage: 'complete',
      coverageNote: null, platformAbsorption: false, lines: [], adjustments: [], finalizedAt: '2026-09-21T00:00:00.000Z',
    }, null);
    expect(projected).toMatchObject({ status: 'completed', queryBill: { externalState: 'received' } });
  });

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
