import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { SqliteConversationReadRebuildStore } from '../../src/storage/conversation-read-rebuild-repo.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';
import { ConversationReadRebuilder } from '../../src/session/conversation-read-rebuild.js';
import type { ConversationTurn } from '../../src/session/conversation-store.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(':memory:'); databases.push(db); runMigrations(db);
  const notified = vi.fn();
  const live = new SqliteConversationReadModel(db, Date.now, notified);
  const source = new SqliteConversationHistoryRepo<ConversationTurn>(db, 'a', 'conversation');
  const turn: ConversationTurn = { id: 'one', conversationId: 'c', userInput: 'original', finalAnswer: 'result', status: 'completed' };
  source.importOnce('c', [turn]);
  new ConversationReadProjector(live).applyHistory('a', 'c', turn, 1);
  const store = new SqliteConversationReadRebuildStore(db);
  const rebuilder = () => new ConversationReadRebuilder(new SqliteConversationReadRebuildStore(db),
    async (_a, _c, view) => { view.commit('a', 'c', [], 4); return true; }, () => 4);
  return { db, source, turn, live, store, rebuilder, notified };
}

describe('atomic staging read-model rebuild', () => {
  it('automatically rebuilds a stale projector version without invalidating the visible epoch early', async () => {
    const { db, live, rebuilder } = fixture();
    const epoch = live.head('a', 'c')!.epoch;
    db.exec('UPDATE conversation_read_heads SET projector_version = 0');
    expect(await rebuilder().maintain('a', 'c')).toBe(false);
    expect(live.head('a', 'c')!.epoch).toBe(epoch);
    expect(await rebuilder().maintain('a', 'c')).toBe(true);
    expect(live.head('a', 'c')!.epoch).not.toBe(epoch);
    const published = live.head('a', 'c')!.epoch;
    expect(await rebuilder().maintain('a', 'c')).toBe(true);
    expect(live.head('a', 'c')!.epoch).toBe(published);
  });
  it('collects abandoned bodies in bounded batches while retaining live and staged references', () => {
    const { db, live, store } = fixture();
    const liveHash = live.findTurn('a', 'c', 'one')!.answerRef!.hash;
    const staging = store.begin('a', 'c');
    new ConversationReadProjector(staging.view).applyHistory('a', 'c', {
      id: 'stage', conversationId: 'c', userInput: 'staged prompt', finalAnswer: 'staged body', status: 'completed',
    }, 2);
    const stageHash = staging.view.findTurn('a', 'c', 'stage')!.answerRef!.hash;
    for (let n = 0; n < 100; n++) live.putContent('a', 'c', `abandoned ${n}`);
    db.exec('UPDATE conversation_read_bodies SET created_at = 0');
    const count = () => (db.prepare('SELECT count(*) AS n FROM conversation_read_bodies').get() as { n: number }).n;
    const before = count(); store.collect('a', 'c');
    expect(count()).toBeGreaterThanOrEqual(before - 32);
    expect(count()).toBeLessThan(before);
    for (let n = 0; n < 5; n++) store.collect('a', 'c');
    expect(live.content('a', 'c', liveHash, 0, 100)?.text).toBe('result');
    expect(live.content('a', 'c', stageHash, 0, 100)?.text).toBe('staged body');
    expect(count()).toBe(4);
  });
  it('keeps the published epoch visible, resumes after restart and invalidates old cursors on promotion', async () => {
    const { live, store, source, turn, rebuilder, notified } = fixture();
    const before = live.head('a', 'c')!;
    source.upsert('c', { ...turn, userInput: 'replacement' });
    store.begin('a', 'c');
    expect(await rebuilder().maintain('a', 'c')).toBe(false);
    expect(live.findTurn('a', 'c', 'one')?.userInput).toBe('original');
    expect(store.pending('a', 'c')?.view.findTurn('a', 'c', 'one')?.userInput).toBe('replacement');
    expect(await rebuilder().maintain('a', 'c')).toBe(true);
    expect(live.findTurn('a', 'c', 'one')?.userInput).toBe('replacement');
    expect(live.head('a', 'c')?.epoch).not.toBe(before.epoch);
    expect(live.changes('a', 'c', before).reset).toBe(true);
    expect(store.pending('a', 'c')).toBeNull();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('rolls back promotion atomically and can retry after a crash', async () => {
    const { db, live, store, rebuilder } = fixture();
    const before = live.head('a', 'c');
    const staging = store.begin('a', 'c');
    await rebuilder().maintain('a', 'c');
    db.exec(`CREATE TRIGGER fail_promotion BEFORE DELETE ON conversation_read_rebuilds
      BEGIN SELECT RAISE(ABORT, 'crash'); END`);
    await expect(rebuilder().maintain('a', 'c')).rejects.toThrow('crash');
    expect(live.head('a', 'c')).toEqual(before);
    expect(store.pending('a', 'c')?.epoch).toBe(staging.epoch);
    db.exec('DROP TRIGGER fail_promotion');
    expect(await rebuilder().maintain('a', 'c')).toBe(true);
  });

  it('fences replaced staging writers and rejects publication behind either durable source', async () => {
    const { live, source, turn, store, rebuilder } = fixture();
    const stale = store.begin('a', 'c');
    const current = store.begin('a', 'c');
    expect(() => stale.view.commit('a', 'c', [], 0)).toThrow('observation_stale_rebuild');
    expect(() => current.view.commit('other', 'c', [], 0)).toThrow('observation_scope_mismatch');
    await rebuilder().maintain('a', 'c');
    expect(store.publish('a', 'c', current.epoch, 4)).toBe(false);
    current.view.commit('a', 'c', [], 4);
    live.commit('a', 'c', [], 5);
    expect(store.publish('a', 'c', current.epoch, 4)).toBe(false);
    source.upsert('c', { ...turn, userInput: 'changed during rebuild' });
    expect(store.publish('a', 'c', current.epoch, 4)).toBe(false);
    await rebuilder().maintain('a', 'c');
    expect(store.pending('a', 'c')?.epoch).not.toBe(current.epoch);
  });

  it('collects retired epochs in bounded batches without deleting live or staging entities', async () => {
    const { db, live, store, rebuilder } = fixture();
    const old = live.head('a', 'c')!;
    const value = live.findTurn('a', 'c', 'one')!;
    live.commit('a', 'c', Array.from({ length: 100 }, (_, index) => ({ ...value, id: `old_${index}` })), 0);
    store.begin('a', 'c');
    await rebuilder().maintain('a', 'c'); await rebuilder().maintain('a', 'c');
    const current = live.head('a', 'c')!;
    const staging = store.begin('a', 'c');
    staging.view.commit('a', 'c', [value], 0);
    store.collect('a', 'c');
    const count = (epoch: string) => (db.prepare('SELECT COUNT(*) AS n FROM conversation_read_turns WHERE epoch = ?').get(epoch) as { n: number }).n;
    expect(count(old.epoch)).toBe(37);
    expect(count(current.epoch)).toBe(1);
    expect(count(staging.epoch)).toBe(1);
    store.collect('a', 'c'); expect(count(old.epoch)).toBe(0);
  });
});
