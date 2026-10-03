import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { SqliteConversationReadModel } from '../../src/storage/conversation-read-model-repo.js';
import { SqliteConversationHistorySearch } from '../../src/storage/conversation-history-search-repo.js';
import { ConversationReadProjector } from '../../src/session/conversation-read-projector.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function fixture() {
  const db = new Database(':memory:'); databases.push(db); runMigrations(db);
  const model = new SqliteConversationReadModel(db);
  const search = new SqliteConversationHistorySearch(db, model);
  const projector = new ConversationReadProjector(model);
  const add = (id: string, answer: string, conversationId = 'conversation') => projector.applyHistory('account', conversationId, {
    id, conversationId, userInput: 'question', finalAnswer: answer, status: 'completed',
  }, 1);
  const drain = () => { for (let n = 0; n < 1000 && search.maintain('account', 'conversation'); n++); };
  return { db, model, search, add, drain };
}

describe('bounded full-history search', () => {
  it('locates Unicode case-insensitive matches at the original UTF-8 byte offset', () => {
    const { search, add, drain } = fixture();
    const prefix = '前言🙂 '.repeat(400);
    add('unicode', `${prefix}ÄÖÜ résumé`);
    drain();
    expect(search.search('account', 'conversation', 'äöü').hits[0]).toMatchObject({
      turnId: 'unicode', offset: Buffer.byteLength(prefix),
    });
  });
  it('indexes beyond the preview, finds range-boundary Chinese phrases and survives restart', () => {
    const { search, add, model, db, drain } = fixture();
    add('old', `${'x'.repeat(32765)}鸡蛋期货上涨原因${'尾'.repeat(20000)}`);
    expect(search.search('account', 'conversation', '鸡蛋期货上涨原因')).toMatchObject({ hits: [], preparing: true });
    search.maintain('account', 'conversation');
    expect(db.prepare('SELECT max(length(CAST(text AS BLOB))) AS n FROM conversation_content_search').get())
      .toMatchObject({ n: expect.any(Number) });
    drain();
    const restarted = new SqliteConversationHistorySearch(db, model);
    expect(restarted.search('account', 'conversation', '鸡蛋期货上涨原因')).toMatchObject({
      preparing: false, hits: [expect.objectContaining({ turnId: 'old', excerpt: expect.stringContaining('鸡蛋期货上涨原因') })],
    });
    expect(restarted.search('other', 'conversation', '鸡蛋期货上涨原因').hits).toEqual([]);
    expect(restarted.search('account', 'foreign', '鸡蛋期货上涨原因').hits).toEqual([]);
  });

  it('paginates, fences cursors and hides deleted or replaced bodies immediately', () => {
    const { search, add, model, drain } = fixture();
    for (let n = 0; n < 25; n++) add(`turn${n}`, `searchable result ${n}`);
    drain();
    const first = search.search('account', 'conversation', 'searchable');
    expect(first.hits).toHaveLength(20); expect(first.nextCursor).not.toBeNull();
    const second = search.search('account', 'conversation', 'searchable', first.nextCursor!);
    expect(second.hits).toHaveLength(5);
    expect(new Set([...first.hits, ...second.hits].map(hit => hit.turnId)).size).toBe(25);
    expect(() => search.search('account', 'foreign', 'searchable', first.nextCursor!)).toThrow('invalid_search_cursor');
    expect(() => search.search('account', 'conversation', 'ab')).toThrow('search_requires');
    const removed = first.hits[0]!.turnId;
    model.remove('account', 'conversation', removed);
    add(first.hits[1]!.turnId, 'replacement');
    const remaining = search.search('account', 'conversation', 'searchable');
    expect(remaining.hits.some(hit => hit.turnId === removed || hit.turnId === first.hits[1]!.turnId)).toBe(false);
  });
});
