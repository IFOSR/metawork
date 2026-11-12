import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/storage/database.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/storage/migrations.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dbPathFixture() {
  const root = await mkdtemp(join(tmpdir(), 'migration-guard-'));
  roots.push(root);
  return join(root, 'data', 'anyfusion.db');
}

describe('createDatabase migration guard', () => {
  it('refuses to open a database migrated by a newer release', async () => {
    const dbPath = await dbPathFixture();
    // 用当前代码建库，再人为把版本标到未来（模拟"卷被更新的版本迁移过"）。
    const db = createDatabase(dbPath);
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION + 1);
    db.close();

    expect(() => createDatabase(dbPath))
      .toThrow(/migrated to schema \d+ by a newer MetaWork release/u);
  });

  it('backs up the database before migrating it forward', async () => {
    const dbPath = await dbPathFixture();
    const db = createDatabase(dbPath);
    // 回拨版本，模拟旧库：下次打开必然触发迁移。
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION - 1);
    db.close();

    const reopened = createDatabase(dbPath);
    const version = reopened.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(CURRENT_SCHEMA_VERSION);
    reopened.close();

    const backupsDir = join(dbPath, '..', 'backups');
    const entries = await readdir(backupsDir);
    expect(entries.some(name => name.includes(`pre-migration-${CURRENT_SCHEMA_VERSION - 1}`))).toBe(true);
    const backup = entries.find(name => name.includes('pre-migration'))!;
    expect((await stat(join(backupsDir, backup))).size).toBeGreaterThan(0);
  });

  it('does not create a backup when the database is already current', async () => {
    const dbPath = await dbPathFixture();
    const db = createDatabase(dbPath);
    db.close();
    createDatabase(dbPath).close();
    const backupsDir = join(dbPath, '..', 'backups');
    await expect(readdir(backupsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
