import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useLocatedTurn } from '../../web/src/observation/use-located-turn';
import type { ConversationTurnView } from '../../src/session/conversation-read-types';
import type { HttpClient } from '../../web/src/api/http';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

function turnView(id: string): ConversationTurnView {
  return {
    id,
    conversationId: 'conv_1',
    requestId: 'req_1',
    revision: 1,
    firstSequence: 1,
    lastSequence: 2,
    userInput: '调研',
    userInputRef: null,
    answer: '完成',
    answerRef: null,
    attachments: [],
    resultId: null,
    certification: null,
    completeness: null,
    resultOffset: 0,
    resultPreviewOmitted: false,
    status: 'completed',
    deliveryStatus: 'delivered',
    taskId: `task_for_${id}`,
    startedAt: '2026-11-02T00:00:00.000Z',
    completedAt: '2026-11-02T00:10:00.000Z',
    interactionKind: 'ai_turn',
  } as ConversationTurnView;
}

describe('detail surfaces read a Turn by identity', () => {
  it('reads nothing while the bounded store still has the Turn', () => {
    const locateConversationTurn = vi.fn(async () => ({ turns: [] }));
    const http = { locateConversationTurn } as unknown as HttpClient;
    const Probe = () => {
      const located = useLocatedTurn(http, 'conv_1', 'turn_a', turnView('turn_a'));
      return createElement('span', null, located.turn ? 'located' : 'missing');
    };

    expect(renderToStaticMarkup(createElement(Probe))).toContain('located');
    // A Turn already in the store must not trigger a server read.
    expect(locateConversationTurn).not.toHaveBeenCalled();
  });

  it('resolves exactly the addressed Turn from a server page', async () => {
    // The page also carries neighbouring Turns; only the requested id counts.
    const locateConversationTurn = vi.fn(async () => ({
      turns: [turnView('turn_old'), turnView('turn_target')],
    }));
    const http = { locateConversationTurn } as unknown as HttpClient;

    const page = await http.locateConversationTurn('conv_1', 'turn_target');
    const found = page.turns.find(item => item.id === 'turn_target');
    expect(found?.taskId).toBe('task_for_turn_target');
    expect(locateConversationTurn).toHaveBeenCalledWith('conv_1', 'turn_target');
  });
});
