import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  it('rebuilds the active configuration pointer inside the account root', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    await mkdir(join(paths.configurationRevisions, 'revision-1'), { recursive: true });
    await symlink(join('revisions', 'revision-1'), join(installRoot, 'config', 'active'), 'dir');

    await new AccountLayoutMigrator({ paths }).migrate();

    expect(await readlink(accountPaths.configActive)).toBe(join('revisions', 'revision-1'));
  });

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
    expect((await lstat(accountPaths.database)).isSymbolicLink()).toBe(true);
    expect(await readlink(accountPaths.database)).toMatch(/^database-revisions\//u);
    expect(await readdir(accountPaths.plannerSessions)).toContain('session_1.jsonl');
    expect((await lstat(accountPaths.workspaceCatalog)).isDirectory()).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(accountPaths.root, 'account-layout-manifest.json'), 'utf8'),
    ) as { schemaVersion: number; entries: unknown[] };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries.length).toBeGreaterThan(0);

    // 账户元数据已写入
    const repository = new FileAccountRepository(paths.accountsRoot);
    const record = await repository.load(LOCAL_DEFAULT_ACCOUNT_ID);
    expect(record?.accountId).toBe(LOCAL_DEFAULT_ACCOUNT_ID);
    expect(record?.migratedAt).toBeTruthy();

    // Runtime-owned account state changes after activation; the migration
    // manifest is transaction evidence, not a permanent immutable-tree seal.
    await writeFile(join(accountPaths.gateway, 'runtime-event.json'), '{}', 'utf8');

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

  it('archives legacy state after migration so it cannot remain a write authority', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);

    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.plannerSessions, { recursive: true });
    seedLegacyState(paths);
    await writeFile(join(paths.plannerSessions, 's.jsonl'), '{}', 'utf8');

    await new AccountLayoutMigrator({ paths }).migrate();

    await expect(readdir(paths.plannerSessions)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(paths.database)).rejects.toMatchObject({ code: 'ENOENT' });
    const archiveRoot = join(
      installRoot,
      'legacy-account-layout',
      LOCAL_DEFAULT_ACCOUNT_ID,
    );
    expect(await readdir(join(archiveRoot, 'data', 'planner-sessions')))
      .toContain('s.jsonl');
    expect((await lstat(join(archiveRoot, 'data', 'metaclaw.db'))).isFile()).toBe(true);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    expect(await readdir(accountPaths.plannerSessions)).toContain('s.jsonl');
  });

  it('repairs a migrated account created before layout manifests existed', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    const repository = new FileAccountRepository(paths.accountsRoot);

    await mkdir(accountPaths.root, { recursive: true });
    await writeFile(
      accountPaths.accountJson,
      JSON.stringify({
        accountId: LOCAL_DEFAULT_ACCOUNT_ID,
        schemaVersion: 1,
        migratedAt: '2026-08-19T00:00:00.000Z',
      }),
      'utf8',
    );
    await writeFile(join(accountPaths.root, 'state.txt'), 'authoritative account state', 'utf8');
    await mkdir(paths.data, { recursive: true });
    await writeFile(paths.database, 'legacy database placeholder', 'utf8');

    const result = await new AccountLayoutMigrator({ paths }).migrate();

    expect(result.outcome).toBe('already_migrated');
    expect(await lstat(join(accountPaths.root, 'account-layout-manifest.json'))).toBeTruthy();
    expect(await lstat(join(
      installRoot,
      'legacy-account-layout',
      LOCAL_DEFAULT_ACCOUNT_ID,
      'data',
      'metaclaw.db',
    ))).toBeTruthy();
    await expect(lstat(paths.database)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await repository.load(LOCAL_DEFAULT_ACCOUNT_ID))?.migratedAt).toBeTruthy();
  });

  it('backs up committed WAL data into the account database before archiving legacy state', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    await mkdir(paths.data, { recursive: true });
    seedLegacyState(paths);
    const writer = new Database(paths.database);
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec('CREATE TABLE wal_migration_probe (value TEXT NOT NULL)');
      writer.prepare('INSERT INTO wal_migration_probe (value) VALUES (?)').run('committed-in-wal');
      expect((await lstat(`${paths.database}-wal`)).size).toBeGreaterThan(0);

      await new AccountLayoutMigrator({ paths }).migrate();

      const migrated = new Database(accountPaths.database, {
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(migrated.prepare('SELECT value FROM wal_migration_probe').get())
          .toEqual({ value: 'committed-in-wal' });
      } finally {
        migrated.close();
      }
    } finally {
      writer.close();
    }
  });

  it('resumes activation after a crash between directory rename and account metadata', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.plannerSessions, { recursive: true });
    seedLegacyState(paths);
    await writeFile(join(paths.plannerSessions, 'recover.jsonl'), '{}', 'utf8');
    let failOnce = true;

    const interrupted = new AccountLayoutMigrator({
      paths,
      afterActivate: async () => {
        if (!failOnce) return;
        failOnce = false;
        throw new Error('simulated activation crash');
      },
    });
    await expect(interrupted.migrate()).rejects.toThrow('simulated activation crash');
    await expect(readFile(accountPaths.accountJson, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const recovered = await new AccountLayoutMigrator({ paths }).migrate();
    expect(recovered.outcome).toBe('migrated');
    expect(await readdir(accountPaths.plannerSessions)).toContain('recover.jsonl');
    await expect(readdir(paths.plannerSessions)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(
      installRoot,
      'legacy-account-layout',
      LOCAL_DEFAULT_ACCOUNT_ID,
      'data',
      'planner-sessions',
    ))).toContain('recover.jsonl');
    const repository = new FileAccountRepository(paths.accountsRoot);
    expect((await repository.load(LOCAL_DEFAULT_ACCOUNT_ID))?.migratedAt).toBeTruthy();
  });

  it('rejects an unjournaled mixed legacy and account layout', async () => {
    const installRoot = await makeInstallRoot();
    const paths = resolveAnyFusionPaths(undefined, installRoot);
    const accountPaths = resolveAccountPaths(LOCAL_DEFAULT_ACCOUNT_ID, installRoot);
    await mkdir(paths.data, { recursive: true });
    seedLegacyState(paths);
    await mkdir(accountPaths.root, { recursive: true });
    await writeFile(join(accountPaths.root, 'partial.txt'), 'partial', 'utf8');

    await expect(new AccountLayoutMigrator({ paths }).migrate())
      .rejects.toThrow('mixed account layout');
  });
});
