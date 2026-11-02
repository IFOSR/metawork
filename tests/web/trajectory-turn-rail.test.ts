import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TrajectoryTurnRail } from '../../web/src/components/TrajectoryTurnRail';
import { ConversationEntityStore } from '../../web/src/observation/conversation-store';
import type { ConversationTurnView } from '../../src/session/conversation-read-types';
import type { WsClient } from '../../web/src/api/ws';
import type { HttpClient } from '../../web/src/api/http';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

function turnView(id: string, sequence: number, input: string): ConversationTurnView {
  return {
    id,
    conversationId: 'conv_1',
    requestId: `req_${sequence}`,
    revision: sequence,
    firstSequence: sequence,
    lastSequence: sequence,
    userInput: input,
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
    taskId: `task_${id}`,
    startedAt: `2026-11-02T0${sequence}:00:00.000Z`,
    completedAt: `2026-11-02T0${sequence}:10:00.000Z`,
    interactionKind: 'ai_turn',
  } as ConversationTurnView;
}

function client(store: ConversationEntityStore): WsClient {
  return { conversations: store } as unknown as WsClient;
}

describe('trajectory turn switcher', () => {
  it('lists every Turn in the conversation, not only the newest one', () => {
    const store = new ConversationEntityStore();
    const turns = [1, 2, 3].map(sequence => turnView(`turn_${sequence}`, sequence, `第 ${sequence} 轮`));
    store.baseline('conv_1', {
      turns,
      head: { epoch: 'epoch-1', revision: 3 },
      nextCursor: null,
    } as never);

    const html = renderToStaticMarkup(createElement(TrajectoryTurnRail, {
      conversationId: 'conv_1',
      ws: client(store),
      http: null,
      selectedTurnId: 'turn_2',
      onSelectTurn: vi.fn(),
    }));

    expect(html).toContain('第 1 轮');
    expect(html).toContain('第 2 轮');
    expect(html).toContain('第 3 轮');
    expect(html).toContain('3 轮');
    // The Turn being read is marked, and selection never rewrites Turn data.
    expect(html).toContain('aria-current="true"');
  });

  it('pages older Turns through locate without mutating the bounded window', async () => {
    const store = new ConversationEntityStore();
    store.baseline('conv_1', {
      turns: [turnView('turn_3', 3, '第 3 轮')],
      head: { epoch: 'epoch-1', revision: 3 },
      nextCursor: null,
    } as never);
    const before = store.window('conv_1').ids;
    const locateConversationTurn = vi.fn(async () => ({
      turns: [turnView('turn_1', 1, '第 1 轮'), turnView('turn_2', 2, '第 2 轮')],
    }));

    const page = await (async () => {
      const oldest = before[0]!;
      return locateConversationTurn('conv_1', oldest);
    })();

    expect(page.turns.map(turn => turn.id)).toEqual(['turn_1', 'turn_2']);
    // Reading older Turns must not shrink or replace the conversation window.
    expect(store.window('conv_1').ids).toEqual(before);
    expect(locateConversationTurn).toHaveBeenCalledWith('conv_1', 'turn_3');
  });
});
