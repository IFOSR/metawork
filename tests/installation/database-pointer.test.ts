import { mkdir, mkdtemp, readFile, rm, stat, writeFile, copyFile, lstat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAccountPaths, type AccountPaths } from '../../src/account/account-paths.js';
import {
  assertCompatibleDatabase,
  databasePointerMigrationJournalPath,
  ensureRevisionedDatabasePointer,
  isSupportedDatabaseSchema,
  readDatabasePointerTarget,
  recoverDatabasePointerMigration,
  replaceDatabasePointer,
} from '../../src/installation/database-pointer.js';
import {
  DATABASE_FILE_NAME,
  databasePointerKind,
  databaseRevisionFile,
  databaseRevisionTarget,
  resolveAccountDatabasePaths,
  resolveDatabasePointerFile,
} from '../../src/installation/database-pointer-paths.js';
import { createDirectoryLink } from '../../src/platform/fs-links.js';
import { runMigrations } from '../../src/storage/migrations.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Journal targets are compared with POSIX separators on every platform. */
function posix(value: string): string {
  return value.replaceAll('\\', '/');
}

async function fixture(): Promise<{ root: string; accountPaths: AccountPaths }> {
  const root = await mkdtemp(join(tmpdir(), 'metawork-database-pointer-'));
  roots.push(root);
  const accountPaths = resolveAccountPaths('local-default', root);
  await mkdir(accountPaths.data, { recursive: true, mode: 0o700 });
  return { root, accountPaths };
}

function createDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
}

describe('database pointer path contract', () => {
  it('resolves every stored target to the database file the revision owns', () => {
    const revisionsRoot = join(process.cwd(), 'root', 'data', 'database-revisions');
    const pointerPath = join(process.cwd(), 'root', 'data', DATABASE_FILE_NAME);
    const target = databaseRevisionTarget('rev-1');

    expect(resolveDatabasePointerFile(pointerPath, target))
      .toBe(databaseRevisionFile(revisionsRoot, 'rev-1'));
    expect(databaseRevisionTarget('rev-1')).toContain('database-revisions');
  });

  it('selects one pointer kind per platform', () => {
    expect(databasePointerKind('darwin')).toBe('file');
    expect(databasePointerKind('linux')).toBe('file');
    expect(databasePointerKind('win32')).toBe('directory');
  });

  it('reports the schema range the runtime can migrate forward from', () => {
    expect(isSupportedDatabaseSchema(undefined)).toBe(false);
    expect(isSupportedDatabaseSchema(29)).toBe(false);
    expect(isSupportedDatabaseSchema(30)).toBe(true);
    expect(isSupportedDatabaseSchema(50)).toBe(true);
    expect(isSupportedDatabaseSchema(51)).toBe(false);
  });
});

describe.runIf(process.platform !== 'win32')('posix account database paths', () => {
  it('keeps the pointer and the live database at the same path', async () => {
    const { accountPaths } = await fixture();
    const resolved = resolveAccountDatabasePaths(accountPaths.data);

    expect(resolved.pointer).toBe(join(accountPaths.data, DATABASE_FILE_NAME));
    expect(resolved.file).toBe(resolved.pointer);
    expect(accountPaths.database).toBe(resolved.pointer);
  });
});

describe.runIf(process.platform === 'win32')('windows account database paths', () => {
  it('points the junction at the revision directory and keeps the file inside it', async () => {
    const { accountPaths } = await fixture();
    const resolved = resolveAccountDatabasePaths(accountPaths.data);

    expect(resolved.pointer).toBe(join(accountPaths.data, 'database-current'));
    expect(resolved.file).toBe(join(resolved.pointer, DATABASE_FILE_NAME));
    expect(accountPaths.database).toBe(resolved.file);
    expect(posix(databaseRevisionTarget('rev-1'))).toBe('database-revisions/rev-1');
    expect(resolveDatabasePointerFile(resolved.pointer, 'database-revisions/rev-1'))
      .toBe(join(accountPaths.databaseRevisions, 'rev-1', DATABASE_FILE_NAME));
  });
});

describe('database pointer activation', () => {
  it('activates one revision and opens the database through the pointer', async () => {
    const { accountPaths } = await fixture();
    const revisionFile = databaseRevisionFile(accountPaths.databaseRevisions, 'revision-1');
    await mkdir(dirname(revisionFile), { recursive: true, mode: 0o700 });
    createDatabase(revisionFile);

    await replaceDatabasePointer(
      accountPaths.databasePointer,
      databaseRevisionTarget('revision-1'),
    );

    expect((await lstat(accountPaths.databasePointer)).isSymbolicLink()).toBe(true);
    expect(posix(await readDatabasePointerTarget(accountPaths.databasePointer)))
      .toBe('database-revisions/revision-1' + (databasePointerKind() === 'file' ? '.db' : ''));
    expect(() => assertCompatibleDatabase(accountPaths.database)).not.toThrow();
  });

  it('rejects a database without a readable schema', async () => {
    const { accountPaths } = await fixture();
    createDatabase(accountPaths.database);

    const snapshot = new Database(accountPaths.database);
    snapshot.exec('DROP TABLE schema_version');
    snapshot.close();

    expect(() => assertCompatibleDatabase(accountPaths.database)).toThrow();
  });
});

describe.runIf(process.platform === 'win32')('windows database pointer conversion', () => {
  it('moves a plain database behind a revision junction and is idempotent', async () => {
    const { accountPaths } = await fixture();
    createDatabase(accountPaths.database);

    await ensureRevisionedDatabasePointer(accountPaths);

    expect((await lstat(accountPaths.databasePointer)).isSymbolicLink()).toBe(true);
    expect(posix(await readDatabasePointerTarget(accountPaths.databasePointer)))
      .toMatch(/^database-revisions\/pre-revision-pointer-/u);
    expect(() => assertCompatibleDatabase(accountPaths.database)).not.toThrow();
    expect(await readFile(
      databasePointerMigrationJournalPath(accountPaths.data), 'utf8',
    ).catch(() => null)).toBeNull();

    // A revisioned account is left alone on the next pass.
    const before = await readDatabasePointerTarget(accountPaths.databasePointer);
    await ensureRevisionedDatabasePointer(accountPaths);
    expect(await readDatabasePointerTarget(accountPaths.databasePointer)).toBe(before);
  });

  it('finishes an interrupted conversion from the recorded revision', async () => {
    const { accountPaths } = await fixture();
    createDatabase(accountPaths.database);
    const revisionFile = databaseRevisionFile(accountPaths.databaseRevisions, 'interrupted');
    await mkdir(dirname(revisionFile), { recursive: true, mode: 0o700 });
    await copyFile(accountPaths.database, revisionFile);
    // Crash window: the replacement junction exists, the plain directory is gone,
    // and the journal is the only record of what the pointer must become.
    const temporaryPointerPath = `${accountPaths.databasePointer}.next-test`;
    await createDirectoryLink(temporaryPointerPath, databaseRevisionTarget('interrupted'));
    await rm(accountPaths.databasePointer, { recursive: true, force: true });
    await writeFile(
      databasePointerMigrationJournalPath(accountPaths.data),
      `${JSON.stringify({
        schemaVersion: 1,
        pointerPath: accountPaths.databasePointer,
        revisionFile,
        target: databaseRevisionTarget('interrupted'),
        temporaryPointerPath,
      }, null, 2)}\n`,
      'utf8',
    );

    expect(await recoverDatabasePointerMigration(accountPaths)).toBe('recovered');
    expect(posix(await readDatabasePointerTarget(accountPaths.databasePointer)))
      .toBe('database-revisions/interrupted');
    expect(() => assertCompatibleDatabase(accountPaths.database)).not.toThrow();
    expect(await readFile(
      databasePointerMigrationJournalPath(accountPaths.data), 'utf8',
    ).catch(() => null)).toBeNull();
    expect((await stat(revisionFile)).isFile()).toBe(true);
  });
});

describe.runIf(process.platform !== 'win32')('posix database pointer conversion', () => {
  it('wraps a plain database file in one revision symlink', async () => {
    const { accountPaths } = await fixture();
    createDatabase(accountPaths.database);

    await ensureRevisionedDatabasePointer(accountPaths);

    expect((await lstat(accountPaths.database)).isSymbolicLink()).toBe(true);
    expect(() => assertCompatibleDatabase(accountPaths.database)).not.toThrow();
  });

  it('never writes a conversion journal where replacement is atomic', async () => {
    const { accountPaths } = await fixture();
    createDatabase(accountPaths.database);

    expect(await recoverDatabasePointerMigration(accountPaths)).toBe('none');
    expect(await readFile(
      databasePointerMigrationJournalPath(accountPaths.data), 'utf8',
    ).catch(() => null)).toBeNull();
  });
});
