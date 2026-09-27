import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationHistoryRepo } from '../../src/storage/conversation-history-repo.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(account = 'local-default', kind = 'presentation') {
  const db = new Database(':memory:');
  databases.push(db);
  runMigrations(db);
  return { db, repo: new SqliteConversationHistoryRepo<{ id: string; text: string }>(db, account, kind) };
}

describe('indexed Conversation history', () => {
  it('changes its durable version on same-ID replacement and deletion, not just append', () => {
    const { db, repo } = fixture();
    expect(repo.version('conv_a')).toBeNull();
    repo.importOnce('conv_a', [{ id: 'a', text: 'before' }]);
    const first = repo.version('conv_a');
    repo.upsert('conv_a', { id: 'a', text: 'after' });
    expect(repo.version('conv_a')).not.toBe(first);
    const replaced = repo.version('conv_a');
    repo.replace('conv_a', []);
    expect(repo.version('conv_a')).not.toBe(replaced);
    const reopened = new SqliteConversationHistoryRepo(db, 'local-default', 'presentation');
    expect(reopened.version('conv_a')).toBe(repo.version('conv_a'));
  });

  it('bounds pages by UTF-8 bytes without skipping the first excluded Turn', () => {
    const { repo } = fixture();
    repo.importOnce('conv_a', Array.from({ length: 7 }, (_, n) => ({ id: `t${n}`, text: '中文'.repeat(1_000) })));
    const first = repo.page('conv_a', { limit: 5, maxBytes: 13_000 });
    expect(first.turns.map(turn => turn.id)).toEqual(['t5', 't6']);
    const older = repo.page('conv_a', { limit: 5, maxBytes: 13_000, cursor: first.nextCursor! });
    expect(older.turns.map(turn => turn.id)).toEqual(['t3', 't4']);
    // An oversized single Turn still makes progress; the transport fragments it.
    expect(repo.page('conv_a', { maxBytes: 100 }).turns.map(turn => turn.id)).toEqual(['t6']);
    expect(() => repo.page('conv_a', { maxBytes: 0 })).toThrow('invalid_history_byte_limit');
  });

  it('atomically replaces a presentation without recycling old cursor sequences', () => {
    const { repo } = fixture();
    repo.importOnce('conv_a', [{ id: 'old', text: 'old' }, { id: 'keep', text: 'keep' }]);
    const cursor = repo.page('conv_a', { limit: 1 }).nextCursor!;
    repo.replace('conv_a', [{ id: 'keep', text: 'enriched' }, { id: 'new', text: 'new' }]);
    expect(repo.page('conv_a', {}).turns.map(turn => turn.id)).toEqual(['keep', 'new']);
    expect(repo.page('conv_a', { cursor }).turns).toEqual([]);
    const broken = { id: 'broken', text: 'broken', extra: 1n };
    expect(() => repo.replace('conv_a', [broken]))
      .toThrow();
    expect(repo.page('conv_a', {}).turns.map(turn => turn.id)).toEqual(['keep', 'new']);
  });

  it('reads only a bounded newest page and keeps older cursors stable under append and replacement', () => {
    const { repo } = fixture();
    repo.importOnce('conv_a', Array.from({ length: 105 }, (_, n) => ({ id: `turn_${n}`, text: `${n}` })));
    const first = repo.page('conv_a', { limit: 3 });
    expect(first.turns.map(turn => turn.id)).toEqual(['turn_102', 'turn_103', 'turn_104']);
    repo.upsert('conv_a', { id: 'turn_105', text: 'new' });
    repo.upsert('conv_a', { id: 'turn_101', text: 'richer' });
    const older = repo.page('conv_a', { limit: 3, cursor: first.nextCursor! });
    expect(older.turns).toEqual([
      { id: 'turn_99', text: '99' }, { id: 'turn_100', text: '100' }, { id: 'turn_101', text: 'richer' },
    ]);
    expect(repo.page('conv_a', { limit: 3 }).turns.at(-1)?.id).toBe('turn_105');
  });

  it('does not deserialize unrelated or off-page bodies, including malformed legacy bodies', () => {
    const { db, repo } = fixture();
    repo.importOnce('conv_a', [{ id: 'old', text: 'old' }, { id: 'new', text: 'new' }]);
    db.prepare("UPDATE conversation_history_turns SET body_json = '{broken' WHERE turn_id = 'old'").run();
    expect(repo.page('conv_a', { limit: 1 }).turns).toEqual([{ id: 'new', text: 'new' }]);
    const query = db.prepare(`EXPLAIN QUERY PLAN SELECT body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = ? AND sequence < ?
      ORDER BY sequence DESC LIMIT ?`).all('local-default', 'conv_a', 'presentation', 99, 11);
    expect(JSON.stringify(query)).toMatch(/SEARCH.*INDEX/);
    expect(JSON.stringify(query)).not.toContain('TEMP B-TREE');
  });

  it('imports atomically, resumes after failure and never overwrites newer rows on repeated import', () => {
    const { db, repo } = fixture();
    const bad = { id: 'bad', text: 'bad', extra: 1n };
    expect(() => repo.importOnce('conv_a', [{ id: 'one', text: 'one' }, bad])).toThrow();
    expect(repo.isImported('conv_a')).toBe(false);
    repo.importOnce('conv_a', [{ id: 'one', text: 'one' }]);
    repo.upsert('conv_a', { id: 'one', text: 'updated' });
    const reopened = new SqliteConversationHistoryRepo<{ id: string; text: string }>(db, 'local-default', 'presentation');
    reopened.importOnce('conv_a', [{ id: 'one', text: 'stale' }]);
    expect(reopened.page('conv_a', {}).turns).toEqual([{ id: 'one', text: 'updated' }]);
    expect(reopened.isImported('conv_a')).toBe(true);
  });

  it('scopes cursors to account, Conversation and history kind and validates limits', () => {
    const { db, repo } = fixture();
    repo.importOnce('conv_a', [{ id: 'one', text: '1' }, { id: 'two', text: '2' }]);
    const cursor = repo.page('conv_a', { limit: 1 }).nextCursor!;
    expect(() => repo.page('conv_b', { cursor })).toThrow('invalid_history_cursor');
    const other = new SqliteConversationHistoryRepo(db, 'another', 'presentation');
    expect(() => other.page('conv_a', { cursor })).toThrow('invalid_history_cursor');
    expect(() => repo.page('conv_a', { cursor: 'garbage' })).toThrow('invalid_history_cursor');
    expect(() => repo.page('conv_a', { limit: Number.NaN })).toThrow('invalid_history_limit');
    expect(repo.page('conv_a', { limit: 500 }).turns).toHaveLength(2);
  });
});
