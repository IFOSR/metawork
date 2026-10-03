import type Database from 'better-sqlite3';
import type { ClientNavigationKey, ClientNavigationSelection, ClientNavigationStore } from '../session/client-navigation-store.js';

export class SqliteClientNavigationStore implements ClientNavigationStore {
  constructor(private readonly db: Database.Database) {}
  read(key: ClientNavigationKey): ClientNavigationSelection | null {
    const row = this.db.prepare(`SELECT workspace_id AS workspaceId, conversation_id AS conversationId
      FROM client_navigation WHERE account_id = ? AND principal_id = ? AND platform = ? AND channel_id = ? AND thread_id = ?`)
      .get(key.accountId, key.principalId, key.platform, key.channelId, key.threadId ?? '') as
      { workspaceId: string | null; conversationId: string | null } | undefined;
    return row ? { ...key, ...row } : null;
  }
  write(value: ClientNavigationSelection): void {
    this.db.prepare(`INSERT INTO client_navigation(account_id, principal_id, platform, channel_id, thread_id, workspace_id, conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, principal_id, platform, channel_id, thread_id)
      DO UPDATE SET workspace_id = excluded.workspace_id, conversation_id = excluded.conversation_id`)
      .run(value.accountId, value.principalId, value.platform, value.channelId, value.threadId ?? '', value.workspaceId, value.conversationId);
  }
}
