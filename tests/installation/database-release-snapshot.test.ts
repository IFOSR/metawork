import Database from 'better-sqlite3';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseReleaseSnapshot } from '../../src/installation/database-release-snapshot.js';
import { createDatabase } from '../../src/storage/database.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/storage/schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'metawork-release-db-'));
  roots.push(root);
  return { sourcePath: join(root, 'source.db'), backupPath: join(root, 'backup.db'), clonePath: join(root, 'clone.db') };
}

describe('current-schema release snapshots', () => {
  it.each(['file', 'symlink', 'hardlink', 'dangling-symlink'])(
    'refuses an existing %s destination without changing the source or destination', async kind => {
      const paths = fixture();
      const db = createDatabase(paths.sourcePath);
      try {
        db.exec("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t', 'preserved', 'now', 'now')");
        const before = readFileSync(paths.sourcePath);
        const wal = readFileSync(`${paths.sourcePath}-wal`);
        if (kind === 'file') writeFileSync(paths.clonePath, 'do not overwrite');
        if (kind === 'symlink') symlinkSync(paths.sourcePath, paths.clonePath);
        if (kind === 'hardlink') linkSync(paths.sourcePath, paths.clonePath);
        if (kind === 'dangling-symlink') symlinkSync(`${paths.sourcePath}.missing`, paths.clonePath);
        await expect(new DatabaseReleaseSnapshot().prepare(paths)).rejects.toThrow('destination already exists');
        expect(readFileSync(paths.sourcePath)).toEqual(before);
        expect(readFileSync(`${paths.sourcePath}-wal`)).toEqual(wal);
        expect(existsSync(paths.backupPath)).toBe(false);
        if (kind === 'file') expect(readFileSync(paths.clonePath, 'utf8')).toBe('do not overwrite');
      } finally { db.close(); }
    },
  );

  it('copies committed WAL facts without migrating or checkpointing the source', async () => {
    const paths = fixture();
    const db = createDatabase(paths.sourcePath);
    try {
      db.exec("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('preserved', '中文任务', 'now', 'now')");
      const before = readFileSync(paths.sourcePath);
      const wal = readFileSync(`${paths.sourcePath}-wal`);
      const result = await new DatabaseReleaseSnapshot().prepare(paths);
      expect(result).toMatchObject({ sourceSchemaVersion: CURRENT_SCHEMA_VERSION, candidateSchemaVersion: CURRENT_SCHEMA_VERSION });
      expect(result.backupSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.candidateSha256).toBe(result.backupSha256);
      expect(readFileSync(paths.sourcePath)).toEqual(before);
      expect(readFileSync(`${paths.sourcePath}-wal`)).toEqual(wal);
      for (const path of [paths.backupPath, paths.clonePath]) {
        const copy = new Database(path, { readonly: true });
        try { expect(copy.prepare('SELECT title FROM tasks').get()).toEqual({ title: '中文任务' }); }
        finally { copy.close(); }
      }
    } finally { db.close(); }
  });

  it('rejects legacy databases before creating backup or candidate files', async () => {
    const paths = fixture();
    const db = new Database(paths.sourcePath);
    db.exec('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES (66)');
    db.close();
    const before = readFileSync(paths.sourcePath);
    await expect(new DatabaseReleaseSnapshot().prepare(paths)).rejects.toThrow(/refuses legacy SQLite schema 66.*database:/u);
    expect(readFileSync(paths.sourcePath)).toEqual(before);
    expect(existsSync(paths.backupPath)).toBe(false);
    expect(existsSync(paths.clonePath)).toBe(false);
  });

  it('rejects a partial current schema and overlapping snapshot paths', async () => {
    const paths = fixture();
    const db = createDatabase(paths.sourcePath);
    db.exec('DROP TRIGGER directory_dirty_conversation_task_slots_update');
    db.close();
    await expect(new DatabaseReleaseSnapshot().prepare(paths)).rejects.toThrow(/refuses malformed schema/u);
    await expect(new DatabaseReleaseSnapshot().prepare({ ...paths, clonePath: paths.sourcePath })).rejects.toThrow('paths must be distinct');
    expect(existsSync(paths.backupPath)).toBe(false);
  });
});
