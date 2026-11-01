import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SqliteConversationTurnStore } from './conversation-turn-repo.js';

/** Runtime text has explicit provenance; it is never promoted to a user Turn. */
export function storeDerivedContent(db: Database.Database, input: {
  accountId: string; conversationId: string; turnId: string | null; kind: string; text: string;
}): string {
  const hash = createHash('sha256').update(input.text).digest('hex');
  if (new SqliteConversationTurnStore(db).deletionState(input.accountId, input.conversationId)) throw new Error('conversation_deleted');
  db.prepare(`INSERT OR IGNORE INTO conversation_turn_bodies(account_id, body_hash, body, byte_length, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(input.accountId, hash, Buffer.from(input.text), Buffer.byteLength(input.text), new Date().toISOString());
  if (new SqliteConversationTurnStore(db).readBody(input.accountId, hash).text !== input.text) throw new Error('body_integrity_error');
  const id = createHash('sha256').update(JSON.stringify([input.accountId, input.conversationId, input.turnId, input.kind, hash])).digest('hex');
  db.prepare(`INSERT OR IGNORE INTO conversation_derived_content(id, account_id, conversation_id, derived_from_turn_id, kind, body_hash)
    VALUES (?, ?, ?, ?, ?, ?)`).run(id, input.accountId, input.conversationId, input.turnId, input.kind, hash);
  return id;
}

export function resolveDerivedContent(db: Database.Database, id: string): string {
  const row = db.prepare('SELECT account_id, conversation_id, body_hash FROM conversation_derived_content WHERE id = ?').get(id) as
    { account_id: string; conversation_id: string; body_hash: string } | undefined;
  if (!row) throw new Error('body_unavailable');
  const store = new SqliteConversationTurnStore(db);
  if (store.deletionState(row.account_id, row.conversation_id)) throw new Error('conversation_deleted');
  return store.readBody(row.account_id, row.body_hash).text;
}

/** SQL joins are useful projections; full consumers still verify referenced bytes. */
export function verifyInteractionContent<T extends { id: unknown }>(db: Database.Database, row: T): T {
  const refs = db.prepare('SELECT input_content_ref, output_content_ref FROM interactions WHERE id = ?')
    .get(String(row.id)) as { input_content_ref: string | null; output_content_ref: string | null } | undefined;
  return { ...row,
    ...(refs?.input_content_ref ? { user_input: resolveDerivedContent(db, refs.input_content_ref) } : {}),
    ...(refs?.output_content_ref ? { system_output: resolveDerivedContent(db, refs.output_content_ref) } : {}),
  };
}
