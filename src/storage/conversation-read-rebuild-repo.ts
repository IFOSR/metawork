import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConversationReadRebuild, ConversationReadRebuildStore } from '../session/conversation-read-rebuild.js';
import { CONVERSATION_PROJECTOR_VERSION } from '../session/conversation-read-rebuild.js';
import type { ConversationTurn } from '../session/conversation-store.js';
import { SqliteConversationReadModel } from './conversation-read-model-repo.js';

/** Each staging writer is fenced to one immutable epoch, including after restart. */
export class SqliteConversationReadRebuildStore implements ConversationReadRebuildStore {
  constructor(private readonly db: Database.Database) {}

  ensureVersion(accountId: string, conversationId: string): void {
    const row = this.db.prepare(`SELECT head.projector_version, rebuild.projector_version AS staging_version
      FROM conversation_read_heads head LEFT JOIN conversation_read_rebuilds rebuild
        ON rebuild.account_id = head.account_id AND rebuild.conversation_id = head.conversation_id
      WHERE head.account_id = ? AND head.conversation_id = ?`).get(accountId, conversationId) as
      { projector_version: number; staging_version: number | null } | undefined;
    if (row && row.projector_version !== CONVERSATION_PROJECTOR_VERSION && row.staging_version !== CONVERSATION_PROJECTOR_VERSION) {
      this.begin(accountId, conversationId);
    }
  }

  pending(accountId: string, conversationId: string): ConversationReadRebuild | null {
    const row = this.db.prepare(`SELECT epoch, history_sequence, source_history_revision
      FROM conversation_read_rebuilds WHERE account_id = ? AND conversation_id = ?`)
      .get(accountId, conversationId) as
      { epoch: string; history_sequence: number; source_history_revision: string } | undefined;
    return row ? {
      epoch: row.epoch, historySequence: row.history_sequence, historyRevision: row.source_history_revision,
      view: new SqliteConversationReadModel(this.db, Date.now, undefined, { accountId, conversationId, epoch: row.epoch }),
    } : null;
  }

  begin(accountId: string, conversationId: string): ConversationReadRebuild {
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO conversation_read_rebuilds
        (account_id, conversation_id, epoch, source_history_revision, projector_version) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id) DO UPDATE SET epoch = excluded.epoch,
          revision = 0, journal_sequence = 0, history_sequence = 0,
          source_history_revision = excluded.source_history_revision, projector_version = excluded.projector_version`)
        .run(accountId, conversationId, randomUUID(), this.historyRevision(accountId, conversationId), CONVERSATION_PROJECTOR_VERSION);
      return this.pending(accountId, conversationId)!;
    }).immediate();
  }

  historyRevision(accountId: string, conversationId: string): string {
    return (this.db.prepare(`SELECT revision FROM conversation_history_streams
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation'`)
      .get(accountId, conversationId) as { revision: string } | undefined)?.revision ?? '';
  }

  history(accountId: string, conversationId: string, after: number) {
    const row = this.db.prepare(`SELECT sequence, body_json FROM conversation_history_turns
      WHERE account_id = ? AND conversation_id = ? AND kind = 'conversation' AND sequence > ?
      ORDER BY sequence LIMIT 1`).get(accountId, conversationId, after) as
      { sequence: number; body_json: string } | undefined;
    return row ? { sequence: row.sequence, turn: JSON.parse(row.body_json) as ConversationTurn } : null;
  }

  commitHistory(accountId: string, conversationId: string, epoch: string, sequence: number, write: () => void): void {
    this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE conversation_read_rebuilds SET history_sequence = ?
        WHERE account_id = ? AND conversation_id = ? AND epoch = ? AND history_sequence < ?`)
        .run(sequence, accountId, conversationId, epoch, sequence);
      if (!result.changes) throw new Error('observation_stale_rebuild');
      write();
    }).immediate();
  }

  publish(accountId: string, conversationId: string, epoch: string, sourceSequence: number): boolean {
    return this.db.transaction(() => {
      const staging = this.pending(accountId, conversationId);
      if (!staging || staging.epoch !== epoch || staging.historyRevision !== this.historyRevision(accountId, conversationId)) return false;
      const head = staging.view.head(accountId, conversationId)!;
      const live = new SqliteConversationReadModel(this.db).head(accountId, conversationId);
      // The caller captures the durable source head after the final journal batch.
      if (head.journalSequence !== sourceSequence || (live?.journalSequence ?? 0) > sourceSequence
        || this.db.prepare(`SELECT 1 FROM conversation_history_turns WHERE account_id = ? AND conversation_id = ?
          AND kind = 'conversation' AND sequence > ? LIMIT 1`).get(accountId, conversationId, staging.historySequence)) return false;
      this.db.prepare(`INSERT INTO conversation_read_heads
        (account_id, conversation_id, epoch, revision, journal_sequence, projector_version) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id) DO UPDATE SET epoch = excluded.epoch,
          revision = excluded.revision, journal_sequence = excluded.journal_sequence, projector_version = excluded.projector_version`)
        .run(accountId, conversationId, epoch, head.revision, head.journalSequence, CONVERSATION_PROJECTOR_VERSION);
      this.db.prepare(`INSERT INTO conversation_read_history_checkpoint (account_id, conversation_id, sequence)
        VALUES (?, ?, ?) ON CONFLICT(account_id, conversation_id) DO UPDATE SET sequence = excluded.sequence`)
        .run(accountId, conversationId, staging.historySequence);
      this.db.prepare('DELETE FROM conversation_read_rebuilds WHERE account_id = ? AND conversation_id = ? AND epoch = ?')
        .run(accountId, conversationId, epoch);
      return true;
    }).immediate();
  }

  collect(accountId: string, conversationId: string): void {
    // Bounded keyset deletion; keep both currently visible and resumable staging epochs.
    for (const table of ['conversation_read_turns', 'conversation_read_changes']) {
      this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (
        SELECT rowid FROM ${table} WHERE account_id = ? AND conversation_id = ?
          AND epoch NOT IN (SELECT epoch FROM conversation_read_heads WHERE account_id = ? AND conversation_id = ?
            UNION ALL SELECT epoch FROM conversation_read_rebuilds WHERE account_id = ? AND conversation_id = ?)
        LIMIT 64)`).run(accountId, conversationId, accountId, conversationId, accountId, conversationId);
    }
    // Keep current/staging/tail references and undelivered notifications. A 24h grace
    // also protects in-flight input writes and permission-detail readers before linkage.
    for (const table of ['conversation_read_content_chunks', 'conversation_read_content_manifests', 'conversation_read_bodies']) this.db.transaction(() => {
      const now = Date.now();
      const candidates = this.db.prepare(`SELECT rowid FROM ${table}
        WHERE account_id = ? AND conversation_id = ? AND created_at < ? ORDER BY created_at LIMIT 32`)
        .all(accountId, conversationId, now - 24 * 60 * 60 * 1000) as Array<{ rowid: number }>;
      if (!candidates.length) return;
      const ids = candidates.map(row => row.rowid);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (
        SELECT content.rowid FROM ${table} content WHERE content.rowid IN (${placeholders})
        AND NOT EXISTS (SELECT 1 FROM conversation_read_turns turn WHERE turn.account_id = content.account_id
          AND turn.conversation_id = content.conversation_id AND json_extract(turn.body_json, '$.answerRef.hash') = content.hash)
        AND NOT EXISTS (SELECT 1 FROM conversation_read_turns turn WHERE turn.account_id = content.account_id
          AND turn.conversation_id = content.conversation_id AND json_extract(turn.body_json, '$.userInputRef.hash') = content.hash)
        AND NOT EXISTS (SELECT 1 FROM conversation_read_changes change WHERE change.account_id = content.account_id
          AND change.conversation_id = content.conversation_id AND (json_extract(change.body_json, '$.answerRef.hash') = content.hash
            OR json_extract(change.body_json, '$.userInputRef.hash') = content.hash))
        AND NOT EXISTS (SELECT 1 FROM notification_outbox job JOIN notification_routes route ON route.id = job.route_id
          WHERE route.account_id = content.account_id AND route.conversation_id = content.conversation_id
          AND job.state IN ('pending', 'sending', 'deferred') AND (json_extract(job.body_json, '$.payload.answerRef.hash') = content.hash
            OR json_extract(job.body_json, '$.payload.detailsRef.hash') = content.hash)))`).run(...ids);
      // Referenced candidates move behind the remaining old candidates, so one
      // maintenance tick inspects at most 32 rows even when most bodies are live.
      this.db.prepare(`UPDATE ${table} SET created_at = ? WHERE rowid IN (${placeholders})`).run(now, ...ids);
    }).immediate();
  }
}
