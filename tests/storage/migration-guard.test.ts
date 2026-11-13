import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/storage/database.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/storage/current-schema.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dbPathFixture() {
  const root = await mkdtemp(join(tmpdir(), 'migration-guard-'));
  roots.push(root);
  return join(root, 'data', 'anyfusion.db');
}

describe('createDatabase schema guard', () => {
  it('refuses to open a database stamped by a newer schema', async () => {
    const dbPath = await dbPathFixture();
    // 用当前代码建库，再人为把版本标到未来（模拟"卷被更新的版本迁移过"）。
    const db = createDatabase(dbPath);
    db.prepare('UPDATE schema_version SET version = ?').run(CURRENT_SCHEMA_VERSION + 1);
    db.close();

    expect(() => createDatabase(dbPath)).toThrow(/refuses/u);
  });

  it('opens an intact current database unchanged', async () => {
    const dbPath = await dbPathFixture();
    const first = createDatabase(dbPath);
    first.close();
    const second = createDatabase(dbPath);
    const version = second.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(CURRENT_SCHEMA_VERSION);
    second.close();
  });
});
