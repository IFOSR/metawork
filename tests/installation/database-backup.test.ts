import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../src/storage/migrations.js';
import { DatabaseBackup } from '../../src/installation/database-backup.js';

describe('DatabaseBackup', () => {
  it('checkpoints, backs up, and records schema version and hash', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const backupPath = join(tmpdir(), `metaclaw-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

    const result = await new DatabaseBackup().backup(db, backupPath);

    expect(existsSync(backupPath)).toBe(true);
    expect(result.backupPath).toBe(backupPath);
    expect(result.schemaVersion).toBe(34);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    unlinkSync(backupPath);
  });
});
