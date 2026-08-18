import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { FileAccountRepository } from '../../src/account/file-account-repository.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../../src/account/account-id.js';
import { resolveAccountPaths } from '../../src/account/account-paths.js';
import { AccountLayoutMigrator } from '../../src/installation/account-layout-migrator.js';
import { resolveAnyFusionPaths } from '../../src/installation/paths.js';
import { runMigrations } from '../../src/storage/migrations.js';

const tmpRoots: string[] = [];

async function makeInstallRoot(): Promise<string> {
  const root = await mkdtempDir(join(tmpdir(), 'anyfusion-migrator-'));
  tmpRoots.push(root);
  return root;
}

async function mkdtempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(prefix);
}

function seedLegacyState(paths: ReturnType<typeof resolveAnyFusionPaths>): void {
  const db = new Database(paths.database);
  try {
    runMigrations(db);
    db.prepare('INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at) VALUES (?, ?, ?, ?)')
      .run('revision_legacy', 'content', 'native', '2026-08-18T00:00:00.000Z');
  } finally {
    db.close();
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(tmpRoots.map(root => rm(root, { recursive: true, force: true })));
  tmpRoots.length = 0;
});

describe('account layout migration', () => {
  it('migrates legacy state into local-default and is idempotent', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);

    // legacy 状态：数据库 + planner 会话 + workspace
    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.plannerSessions, { recursive: true });
    await mkdir(paths.executionWorkspaces, { recursive: true });
    seedLegacyState(paths);
    await writeFile(join(paths.plannerSessions, 'session_1.jsonl'), '{}', 'utf8');
    await mkdir(join(paths.executionWorkspaces, 'ws_1'), { recursive: true });
    await writeFile(join(paths.executionWorkspaces, 'ws_1', 'file.txt'), 'content', 'utf8');

    const migrator = new AccountLayoutMigrator({ paths });
    const first = await migrator.migrate();
    expect(first.outcome).toBe('migrated');

    // 账户目录有迁移后的数据
    expect((await readdir(accountPaths.data)).length).toBeGreaterThan(0);
    expect(await readdir(accountPaths.plannerSessions)).toContain('session_1.jsonl');

    // 账户元数据已写入
    const repository = new FileAccountRepository(paths.accountsRoot);
    const record = await repository.load(LOCAL_DEFAULT_ACCOUNT_ID);
    expect(record?.accountId).toBe(LOCAL_DEFAULT_ACCOUNT_ID);
    expect(record?.migratedAt).toBeTruthy();

    // 重复迁移幂等
    const second = await migrator.migrate();
    expect(second.outcome).toBe('already_migrated');
  });

  it('preserves planner session filenames', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);

    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.plannerSessions, { recursive: true });
    seedLegacyState(paths);
    await writeFile(join(paths.plannerSessions, 'metaclaw-planner-session-123.jsonl'), '{}', 'utf8');

    await new AccountLayoutMigrator({ paths }).migrate();

    expect(await readdir(accountPaths.plannerSessions)).toContain('metaclaw-planner-session-123.jsonl');
  });

  it('rejects a corrupted legacy database', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);

    await mkdir(paths.data, { recursive: true });
    // 写入非 SQLite 内容，模拟损坏的 legacy 数据库
    await writeFile(paths.database, 'this is not a sqlite database', 'utf8');

    const migrator = new AccountLayoutMigrator({ paths });
    await expect(migrator.migrate()).rejects.toThrow();
  });

  it('leaves legacy state present and does not re-write it after migration', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);

    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.plannerSessions, { recursive: true });
    seedLegacyState(paths);
    await writeFile(join(paths.plannerSessions, 's.jsonl'), '{}', 'utf8');

    await new AccountLayoutMigrator({ paths }).migrate();

    // 迁移后 legacy 状态仍存在（回滚元数据保留），账户目录有副本。
    expect(await readdir(paths.plannerSessions)).toContain('s.jsonl');
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    expect(await readdir(accountPaths.plannerSessions)).toContain('s.jsonl');
  });
});
