import { describe, expect, it, vi } from 'vitest';
import { ConversationEntityStore } from '../../web/src/observation/conversation-store';
import { ObservationManager } from '../../web/src/observation/observation-manager';
import { frameConversationBaseline } from '../../src/gateway/conversation-observation.js';
import { projectConversationTurn } from '../../src/session/conversation-read-model.js';
import type { ConversationReadBaseline, ConversationTurnView } from '../../src/session/conversation-read-types.js';

function turn(conversationId: string, id = 'turn', revision = 1): ConversationTurnView {
  return { ...projectConversationTurn(null, { protocolVersion: 2, sequence: revision, eventId: id,
    accountId: 'account', conversationId, turnId: id, requestId: `request_${id}`, kind: 'turn_started',
    payload: { userInput: id }, occurredAt: '' })!, revision };
}
function baseline(conversationId: string): ConversationReadBaseline {
  return { head: { epoch: 'epoch', revision: 1, journalSequence: 1 }, turns: [turn(conversationId)], nextCursor: null };
}

describe('normalized Conversation observation', () => {
  it('notifies revocation owners and prevents in-flight pages restoring removed content', () => {
    const store = new ConversationEntityStore(); store.baseline('a', baseline('a')); store.baseline('b', baseline('b'));
    const revoke = vi.fn(); store.onRevoked(revoke);
    const generation = store.currentGeneration();
    store.apply({ kind: 'closed', observationId: 'view', conversationId: 'a', reason: 'authorization_revoked' });
    store.older('a', { ...baseline('a'), asOf: { epoch: 'epoch', revision: 1 } }, 'epoch', generation);
    expect(revoke).toHaveBeenCalledWith('a'); expect(store.turn('a', 'turn')).toBeUndefined();
    expect(store.turn('b', 'turn')).toBeDefined(); expect(store.activity('a').tasks).toEqual([]);
  });
  it('keeps a deleted Turn absent when an older page response arrives after its tombstone', () => {
    const store = new ConversationEntityStore(); store.baseline('a', baseline('a'));
    store.apply({ kind: 'patch', observationId: 'view', conversationId: 'a',
      change: { removed: true, epoch: 'epoch', prevRevision: 1, revision: 2, turn: turn('a', 'turn', 2) } });
    store.older('a', { turns: [turn('a')], asOf: { epoch: 'epoch', revision: 1 }, nextCursor: null }, 'epoch', store.currentGeneration());
    expect(store.window('a').ids).toEqual([]); expect(store.turn('a', 'turn')).toBeUndefined();
    store.older('a', { turns: [turn('a', 'other')], asOf: { epoch: 'epoch', revision: 2 }, nextCursor: null }, 'epoch', store.currentGeneration());
    expect(store.window('a').ids).toEqual(['other']);
  });
  it('updates only the addressed Turn, rejects gaps, and never merges another Conversation', () => {
    const store = new ConversationEntityStore();
    store.baseline('a', baseline('a')); store.baseline('b', baseline('b'));
    const a = vi.fn(); const b = vi.fn(); const window = vi.fn();
    store.subscribeTurn('a', 'turn', a); store.subscribeTurn('b', 'turn', b); store.subscribe('a', window);
    const bIdentity = store.turn('b', 'turn');
    expect(store.apply({ kind: 'patch', observationId: 'view', conversationId: 'a',
      change: { epoch: 'epoch', prevRevision: 1, revision: 2, turn: { ...turn('a', 'turn', 2), answer: 'updated' } } })).toBe('applied');
    expect(a).toHaveBeenCalledTimes(1); expect(b).not.toHaveBeenCalled(); expect(window).not.toHaveBeenCalled();
    expect(store.turn('b', 'turn')).toBe(bIdentity);
    expect(store.apply({ kind: 'patch', observationId: 'view', conversationId: 'a',
      change: { epoch: 'epoch', prevRevision: 3, revision: 4, turn: turn('a', 'turn', 4) } })).toBe('reset');
    expect(store.turn('a', 'turn')?.answer).toBe('updated');
    expect(() => store.baseline('a', baseline('b'))).toThrow('observation_scope_mismatch');
  });

  it('rejects stale scoped pages after logout and bounds retained Conversation caches', () => {
    const store = new ConversationEntityStore(2);
    const release = store.retain('a');
    store.baseline('a', baseline('a')); store.baseline('b', baseline('b')); store.baseline('c', baseline('c'));
    expect(store.turn('a', 'turn')).toBeDefined(); expect(store.turn('b', 'turn')).toBeUndefined();
    const generation = store.currentGeneration();
    store.purge();
    store.baseline('a', baseline('a'));
    store.older('a', { turns: [turn('a', 'old')], nextCursor: null }, 'epoch', generation);
    expect(store.turn('a', 'old')).toBeUndefined(); release();
  });

  it('commits a complete hash-checked baseline and resumes independently for each logical stream', async () => {
    const store = new ConversationEntityStore();
    const sent: Array<Record<string, unknown>> = [];
    const manager = new ObservationManager(store, message => { sent.push(message as Record<string, unknown>); return true; });
    const stopA = manager.follow('a'); manager.follow('b'); manager.connection(true);
    const a = sent.find(message => message.conversationId === 'a')!.observationId as string;
    const b = sent.find(message => message.conversationId === 'b')!.observationId as string;
    for (const frame of frameConversationBaseline(baseline('b'), b, 'b')) await manager.consume(frame);
    expect(store.turn('a', 'turn')).toBeUndefined(); expect(store.turn('b', 'turn')).toBeDefined();
    stopA();
    for (const frame of frameConversationBaseline(baseline('a'), a, 'a')) await manager.consume(frame);
    expect(store.turn('a', 'turn')).toBeUndefined();
    manager.connection(false); manager.connection(true);
    expect(sent.at(-1)).toMatchObject({ type: 'observe', conversationId: 'b', cursor: { epoch: 'epoch', revision: 1 } });
    manager.close(); expect(store.turn('b', 'turn')).toBeUndefined();
  });

  it('includes the Web connection identity when opening an observation', () => {
    const sent: Array<Record<string, unknown>> = [];
    const manager = new ObservationManager(new ConversationEntityStore(), message => {
      sent.push(message as Record<string, unknown>); return true;
    });
    manager.follow('conversation');
    manager.connection(true);
    expect(sent[0]).toMatchObject({ type: 'observe', connectionId: 'web', conversationId: 'conversation' });
    manager.close();
  });

  it('hydrates a selected conversation while the WebSocket baseline is pending', () => {
    const store = new ConversationEntityStore();
    const value = baseline('conversation');
    store.hydrate('conversation', { asOf: value.head!, turns: value.turns, nextCursor: 'older' });
    expect(store.window('conversation')).toMatchObject({
      status: 'ready', cursor: { epoch: value.head!.epoch, revision: value.head!.revision }, olderCursor: 'older',
    });
    expect(store.turn('conversation', 'turn')).toBeDefined();
  });

  it('strips the read model journal sequence before resuming an observation', () => {
    const store = new ConversationEntityStore();
    store.baseline('conversation', baseline('conversation'));
    const sent: Array<Record<string, unknown>> = [];
    const manager = new ObservationManager(store, message => {
      sent.push(message as Record<string, unknown>); return true;
    });
    manager.follow('conversation');
    manager.connection(true);
    expect(sent[0]).toMatchObject({
      type: 'observe', conversationId: 'conversation', cursor: { epoch: 'epoch', revision: 1 },
    });
    expect((sent[0]!.cursor as Record<string, unknown>)).not.toHaveProperty('journalSequence');
    manager.close();
  });

  it('bounds active windows while preserving terminal results and reading older pages independently', () => {
    const store = new ConversationEntityStore(); store.retain('a');
    store.baseline('a', baseline('a'));
    for (let revision = 2; revision <= 150; revision++) store.apply({ kind: 'patch', observationId: 'view', conversationId: 'a',
      change: { epoch: 'epoch', prevRevision: revision - 1, revision, turn: { ...turn('a', `t${revision}`, revision), status: 'completed', answer: `result ${revision}` } } });
    expect(store.window('a').ids).toHaveLength(50); expect(store.turn('a', 't99')).toBeUndefined();
    expect(store.turn('a', 't100')).toBeUndefined(); expect(store.turn('a', 't101')?.answer).toBe('result 101');
    expect(store.window('a').olderCursor).not.toBeNull();
    store.older('a', { turns: Array.from({ length: 20 }, (_, n) => turn('a', `t${81 + n}`, 81 + n)), nextCursor: 'older' }, 'epoch', store.currentGeneration());
    expect(store.window('a').ids[0]).toBe('t81'); expect(store.window('a').ids).toHaveLength(50);
    store.apply({ kind: 'patch', observationId: 'view', conversationId: 'a',
      change: { epoch: 'epoch', prevRevision: 150, revision: 151, turn: turn('a', 'new', 151) } });
    expect(store.window('a').ids[0]).toBe('t81'); expect(store.turn('a', 'new')).toBeUndefined();
    expect(store.window('a').cursor?.revision).toBe(151);
  });

  it('retries a lost baseline with backoff and stops retrying after release', async () => {
    vi.useFakeTimers();
    try {
      const store = new ConversationEntityStore(); const sent: Array<Record<string, unknown>> = [];
      const manager = new ObservationManager(store, message => { sent.push(message as Record<string, unknown>); return true; });
      const release = manager.follow('a'); manager.connection(true);
      await vi.advanceTimersByTimeAsync(10_250);
      expect(sent.filter(message => message.type === 'observe')).toHaveLength(2);
      release(); await vi.advanceTimersByTimeAsync(60_000);
      expect(sent.filter(message => message.type === 'observe')).toHaveLength(2); manager.close();
    } finally { vi.useRealTimers(); }
  });

  it('discards an asynchronous baseline from a disconnected transport generation', async () => {
    const store = new ConversationEntityStore(); const sent: Array<Record<string, unknown>> = [];
    const manager = new ObservationManager(store, message => { sent.push(message as Record<string, unknown>); return true; });
    manager.follow('a'); manager.connection(true);
    const frame = frameConversationBaseline(baseline('a'), sent[0]!.observationId as string, 'a')[0]!;
    const receiving = manager.consume(frame); manager.connection(false); await receiving;
    expect(store.turn('a', 'turn')).toBeUndefined(); manager.close();
  });
});
