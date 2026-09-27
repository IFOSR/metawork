import type Database from 'better-sqlite3';
import type { ConversationMetadata, ConversationMetadataIndex } from '../session/conversation-store.js';

export class SqliteConversationMetadataIndex implements ConversationMetadataIndex {
  constructor(private readonly db: Database.Database, private readonly accountId: string) {}

  find(conversationId: string): ConversationMetadata | null {
    const row = this.db.prepare(`SELECT metadata_json FROM conversation_metadata_projection
      WHERE account_id = ? AND conversation_id = ?`).get(this.accountId, conversationId) as {
        metadata_json: string;
      } | undefined;
    return row ? JSON.parse(row.metadata_json) as ConversationMetadata : null;
  }

  put(metadata: ConversationMetadata): void {
    if (metadata.accountId !== this.accountId) throw new Error('conversation_account_mismatch');
    this.db.prepare(`INSERT INTO conversation_metadata_projection (account_id, conversation_id, metadata_json)
      VALUES (?, ?, ?) ON CONFLICT(account_id, conversation_id) DO UPDATE SET metadata_json = excluded.metadata_json`)
      .run(this.accountId, metadata.id, JSON.stringify(metadata));
  }
}
