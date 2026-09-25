import { describe, expect, it } from 'vitest';
import { createBackgroundResultDelivery, type BackgroundResultDeliveryDeps } from '../../src/gateway/background-result-delivery.js';
import type { ConversationTurn, WebSessionRecord } from '../../src/management/web-session-types.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';

function fixture(overrides: Partial<BackgroundResultDeliveryDeps> = {}) {
  const turns: ConversationTurn[] = [];
  const events: GatewayEventEnvelope[] = [];
  const operations: string[] = [];
  const delivery = { resultId: 'safe_result', content: 'Full answer', completeness: 'complete', certification: 'certified' } as const;
  const deliver = createBackgroundResultDelivery({
    accountId: 'account_a',
    resolveTask: () => ({ id: 'task_a', accountId: 'account_a', conversationId: 'conv_a', status: 'done', updatedAt: '2026-09-24T00:01:00Z' }) as never,
    resolveQuery: () => ({ queryId: 'query_a', accountId: 'account_a', conversationId: 'conv_a', turnId: 'turn_a', requestId: 'req_a', acceptedAt: '2026-09-24T00:00:00Z' }) as never,
    taskForQuery: () => 'task_a',
    read: async () => ({ turns } as WebSessionRecord),
    requestText: () => 'Research',
    project: () => ({ taskId: 'task_a', title: 'Research', status: 'completed', stages: [] }),
    append: async (conversationId, turn) => { operations.push(`persist:${conversationId}:${turn.id}`); turns.push(turn); },
    replay: async () => ({ lastSequence: events.length, snapshot: events, deltas: [] }),
    publish: async input => {
      operations.push(`publish:${input.conversationId}:${input.turnId}:${input.requestId}`);
      events.push({ kind: 'result_completed', turnId: input.turnId, payload: { resultId: input.delivery.resultId } } as GatewayEventEnvelope);
    },
    ...overrides,
  });
  return { deliver, delivery, turns, events, operations };
}

describe('background result delivery', () => {
  it('preserves a resume origin while publishing into the original business Turn', async () => {
    let published: unknown;
    const f = fixture({ publish: async value => { published = value; } });
    await f.deliver('conv_a', f.delivery, 'resume-turn');
    expect(published).toMatchObject({ turnId: 'turn_a', requestId: 'req_a', originTurnId: 'resume-turn' });
  });

  it('persists the original Turn before publishing, including concurrent duplicate recovery', async () => {
    const f = fixture();
    await Promise.all([f.deliver('conv_a', f.delivery), f.deliver('conv_a', f.delivery)]);
    expect(f.operations).toEqual(['persist:conv_a:turn_a', 'publish:conv_a:turn_a:req_a']);
    expect(f.turns[0]).toMatchObject({ finalAnswer: 'Full answer', taskId: 'task_a', status: 'completed' });
  });

  it('rejects a foreign Conversation and a mismatched Query link', async () => {
    const f = fixture();
    await f.deliver('conv_b', f.delivery);
    expect(f.operations).toEqual([]);
    const mismatch = fixture({ taskForQuery: () => 'task_b' });
    await mismatch.deliver('conv_a', mismatch.delivery);
    expect(mismatch.operations).toEqual([]);
  });

  it('rejects a Query from another account', async () => {
    const f = fixture({ resolveQuery: () => ({ queryId: 'query_a', accountId: 'account_b', conversationId: 'conv_a', turnId: 'turn_a' }) as never });
    await f.deliver('conv_a', f.delivery);
    expect(f.operations).toEqual([]);
  });

  it('does not publish when persistence fails and can retry delivery', async () => {
    let fail = true;
    const f = fixture({ append: async () => { if (fail) throw new Error('disk unavailable'); } });
    await expect(f.deliver('conv_a', f.delivery)).rejects.toThrow('disk unavailable');
    expect(f.events).toEqual([]);
    fail = false;
    await f.deliver('conv_a', f.delivery);
    expect(f.events).toHaveLength(1);
  });
});
