import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DatabaseUpgradeTransaction,
} from '../../src/installation/database-upgrade-transaction.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('DatabaseUpgradeTransaction', () => {
  it('backs up the source, migrates only the clone, and verifies the candidate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-db-upgrade-'));
    cleanup.push(root);
    const sourcePath = join(root, 'active.db');
    const backupPath = join(root, 'backup.db');
    const clonePath = join(root, 'candidate.db');
    createDatabase(sourcePath, 30);
    const sourceBefore = readFileSync(sourcePath);
    const transaction = new DatabaseUpgradeTransaction({
      migrateClone: path => {
        const db = new Database(path);
        db.prepare('UPDATE schema_version SET version = 31').run();
        db.exec('CREATE TABLE candidate_marker (id TEXT PRIMARY KEY)');
        db.close();
      },
    });

    const result = await transaction.prepare({
      sourcePath,
      backupPath,
      clonePath,
      expectedSourceSchema: 30,
      expectedTargetSchema: 31,
      sentinelTables: ['schema_version', 'candidate_marker'],
    });

    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(result.sourceSchemaVersion).toBe(30);
    expect(result.candidateSchemaVersion).toBe(31);
    expect(result.backupSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.candidateSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('deletes an invalid candidate and leaves the source unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-db-upgrade-invalid-'));
    cleanup.push(root);
    const sourcePath = join(root, 'active.db');
    const backupPath = join(root, 'backup.db');
    const clonePath = join(root, 'candidate.db');
    createDatabase(sourcePath, 30);
    const sourceBefore = readFileSync(sourcePath);
    const transaction = new DatabaseUpgradeTransaction({
      migrateClone: () => undefined,
    });

    await expect(transaction.prepare({
      sourcePath,
      backupPath,
      clonePath,
      expectedSourceSchema: 30,
      expectedTargetSchema: 31,
      sentinelTables: ['schema_version'],
    })).rejects.toThrow('candidate database schema mismatch');

    expect(readFileSync(sourcePath)).toEqual(sourceBefore);
    expect(() => readFileSync(clonePath)).toThrow();
  });
});

function createDatabase(path: string, version: number): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at)
    VALUES (${version}, '2026-08-14T00:00:00.000Z');
  `);
  db.close();
}
