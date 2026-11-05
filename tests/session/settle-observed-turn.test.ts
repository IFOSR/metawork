import { describe, expect, it } from 'vitest';
import { settleObservedTurn } from '../../src/session/settle-observed-turn.js';
import type { ConversationTurnView } from '../../src/session/conversation-read-types.js';

const turn: ConversationTurnView = {
  id: 'turn', conversationId: 'conversation', requestId: 'request', revision: 1,
  firstSequence: 1, lastSequence: 2, userInput: '/task retry-result task', userInputRef: null,
  answer: '该结果操作已过期', answerRef: null, resultId: null, certification: null, completeness: null,
  resultOffset: 0, resultPreviewOmitted: false, status: 'running', deliveryStatus: 'ready',
  taskId: null, startedAt: '2026-11-04T14:25:38.817Z', completedAt: '2026-11-04T14:25:38.869Z',
  interactionKind: 'system_command',
};

describe('observed turn settlement', () => {
  it('repairs a finished unbound control command instead of leaving Stop stuck', () => {
    expect(settleObservedTurn(turn, null, null).status).toBe('completed');
  });
  it.each(['succeeded', 'failed', 'cancelled'] as const)('recognizes the current %s Task status', status => {
    expect(settleObservedTurn({ ...turn, taskId: 'task', completedAt: null }, null, { status, updatedAt: 'finished' }))
      .toMatchObject({ status: status === 'succeeded' ? 'completed' : status, completedAt: 'finished' });
  });
  it('preserves live work and does not infer completion from a missing owner alone', () => {
    expect(settleObservedTurn(turn, { turnId: turn.id, status: 'running' }, null)).toBe(turn);
    const unfinished = { ...turn, completedAt: null };
    expect(settleObservedTurn(unfinished, null, null)).toBe(unfinished);
  });
});
