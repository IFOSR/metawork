// Checkpoints and backs up the runtime SQLite database before any migration.
// The backup API runs against a quiesced database, then the backup file hash and
// schema version are recorded so rollback can verify it restored the same state.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export interface DatabaseBackupResult {
  backupPath: string;
  schemaVersion: number;
  sha256: string;
}

export class DatabaseBackup {
  async backup(db: Database.Database, backupPath: string): Promise<DatabaseBackupResult> {
    db.pragma('wal_checkpoint(TRUNCATE)');
    await db.backup(backupPath);
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number } | undefined;
    const schemaVersion = row?.version ?? 0;
    const sha256 = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
    return { backupPath, schemaVersion, sha256 };
  }
}
