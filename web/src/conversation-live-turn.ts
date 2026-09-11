import type {
  ConversationTurn,
  ConversationTurnProjection,
  WebSessionRecord,
} from './api/session-types';

export function retainLiveTurnForConversation(
  turn: ConversationTurnProjection | null,
  sessionId: string,
): ConversationTurnProjection | null {
  return turn?.sessionId === sessionId ? turn : null;
}

export function isCurrentConversationRecordRequest(input: {
  requestId: number;
  latestRequestId: number;
  requestedSessionId: string;
  browsedSessionId: string | null;
}): boolean {
  return input.requestId === input.latestRequestId
    && input.requestedSessionId === input.browsedSessionId;
}

export function retainTerminalLiveTurnInRecord(
  record: WebSessionRecord | null,
  turn: ConversationTurnProjection | null,
): WebSessionRecord | null {
  if (
    !record
    || !turn
    || turn.status === 'running'
    || record.session.id !== turn.sessionId
    || record.turns.some(item => item.id === turn.id)
  ) {
    return record;
  }
  const terminalTurn: ConversationTurn = {
    ...turn,
    status: turn.status,
  };
  return {
    ...record,
    turns: [...record.turns, terminalTurn],
  };
}
