// The database revision pointer.
//
// POSIX keeps the accepted shape: `<account>/data/anyfusion.db` is a relative
// file symlink to `database-revisions/<revision>.db`, replaced with one atomic
// rename. Windows cannot create a file symlink without elevation, and a hard
// link is not a substitute for this pointer (WAL, verified backup, cloned
// migration and rollback open the revision path directly), so the pointer is a
// directory junction to `database-revisions/<revision>/` and the database file
// lives inside that directory. Every stored pointer target stays a path
// relative to the pointer's parent directory, so activation journals, lineage
// comparison and rollback targets keep the same format on both platforms.
//
// See ADR-0030 (2026-10-16 amendment).
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import type { AccountPaths } from '../account/account-paths.js';
import { CURRENT_SCHEMA_VERSION } from '../storage/migrations.js';
import { syncDirectory, syncFile } from '../platform/durable-fs.js';
import {
  createDirectoryLink,
  readDirectoryLinkTarget,
  replaceDirectoryLink,
} from '../platform/fs-links.js';
import {
  DATABASE_FILE_NAME,
  databaseRevisionFile,
  databaseRevisionTarget,
  databasePointerKind,
  resolveDatabasePointerFile,
  type DatabasePointerKind,
} from './database-pointer-paths.js';

export {
  DATABASE_FILE_NAME,
  databasePointerKind,
  databaseRevisionFile,
  databaseRevisionTarget,
  resolveDatabasePointerFile,
};
export type { DatabasePointerKind };

export const DATABASE_POINTER_MIGRATION_JOURNAL = 'database-pointer-migration.json';

/** Read the active revision target; POSIX reads the symlink, Windows the junction. */
export function readDatabasePointerTarget(pointerPath: string): Promise<string> {
  return readDirectoryLinkTarget(pointerPath);
}

export async function replaceDatabasePointer(
  pointerPath: string,
  target: string,
): Promise<void> {
  const parent = dirname(pointerPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (databasePointerKind() === 'directory') {
    await replaceDirectoryLink(pointerPath, target);
    await syncDirectory(parent);
    return;
  }
  // POSIX replaces the pointer with one atomic rename over the previous link.
  const temporary = `${pointerPath}.next-${randomUUID()}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, pointerPath);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove a pointer without touching the revision it referenced. */
export async function removeDatabasePointer(pointerPath: string): Promise<void> {
  await rm(pointerPath, { recursive: true, force: true });
}

export interface DatabasePointerMigrationRecord {
  schemaVersion: 1;
  /** Junction path whose target is being migrated. */
  pointerPath: string;
  /** Absolute database file the new revision owns. */
  revisionFile: string;
  /** Relative target that must end up stored in the pointer. */
  target: string;
  /** Pre-created replacement junction, recorded so recovery can finish the swap. */
  temporaryPointerPath: string;
}

export function databasePointerMigrationJournalPath(dataDirectory: string): string {
  return join(dataDirectory, DATABASE_POINTER_MIGRATION_JOURNAL);
}

/**
 * Bring a plain `<data>/database-current/anyfusion.db` under the revision
 * pointer. POSIX installs already have the pointer because a fresh POSIX root
 * keeps the database at `<data>/anyfusion.db` as a plain file and the first
 * install/update converts it atomically. Windows reaches this state with a real
 * `database-current` directory, and the swap cannot be atomic there, so the
 * conversion records its intent before it touches the pointer.
 */
export async function ensureRevisionedDatabasePointer(accountPaths: AccountPaths): Promise<void> {
  if (databasePointerKind() === 'file') {
    await ensureRevisionedFilePointer(accountPaths);
    return;
  }
  const pointerPath = accountPaths.databasePointer;
  const pointer = await lstatOrNull(pointerPath);
  if (pointer === null) {
    throw new Error(`account database pointer is missing: ${pointerPath}`);
  }
  if (pointer.isSymbolicLink()) return;
  if (!pointer.isDirectory()) {
    throw new Error(`account database pointer is not a directory or link: ${pointerPath}`);
  }
  assertCompatibleDatabase(accountPaths.database);
  const revisionId = `pre-revision-pointer-${randomUUID()}`;
  const record: DatabasePointerMigrationRecord = {
    schemaVersion: 1,
    pointerPath,
    revisionFile: databaseRevisionFile(accountPaths.databaseRevisions, revisionId),
    target: databaseRevisionTarget(revisionId),
    temporaryPointerPath: `${pointerPath}.next-${randomUUID()}`,
  };
  await writeDatabasePointerMigrationJournal(accountPaths.data, record);
  await installDatabasePointerMigration(accountPaths, record);
  await clearDatabasePointerMigrationJournal(accountPaths.data);
}

/**
 * Finish or repair an interrupted Windows pointer conversion. Deterministic:
 * a live pointer matching the journal ends the migration, a pre-created
 * junction is installed, and otherwise the recorded revision is re-created from
 * the revision that already verifies (or from the still-plain database).
 */
export async function recoverDatabasePointerMigration(
  accountPaths: AccountPaths,
): Promise<'none' | 'recovered'> {
  if (databasePointerKind() === 'file') return 'none';
  const journalPath = databasePointerMigrationJournalPath(accountPaths.data);
  const source = await readFile(journalPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (source === null) return 'none';
  const record = parseDatabasePointerMigrationRecord(source);
  const pointer = await lstatOrNull(record.pointerPath);
  if (pointer?.isSymbolicLink()) {
    const target = await readDirectoryLinkTarget(record.pointerPath);
    if (target !== record.target) {
      throw new Error(
        'database pointer migration journal does not match the active pointer',
      );
    }
    await clearDatabasePointerMigrationJournal(accountPaths.data);
    return 'recovered';
  }
  await installDatabasePointerMigration(accountPaths, record);
  await clearDatabasePointerMigrationJournal(accountPaths.data);
  return 'recovered';
}

/** Schema range the runtime can migrate forward from. */
export function isSupportedDatabaseSchema(version: number | undefined): boolean {
  return version !== undefined
    && Number.isInteger(version)
    && version >= 30
    && version <= CURRENT_SCHEMA_VERSION;
}

/**
 * A revision payload must not ship transient SQLite companions. On Windows the
 * revision directory is the live database directory, so a `-wal` left behind by
 * staging would be replayed against the database after activation.
 */
export async function clearDatabaseRevisionCompanions(revisionFile: string): Promise<void> {
  if (databasePointerKind() !== 'directory') return;
  await rm(`${revisionFile}-wal`, { force: true });
  await rm(`${revisionFile}-shm`, { force: true });
}

/** Rejects a database that is missing, corrupt or outside the supported range. */export function assertCompatibleDatabase(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = db.prepare('SELECT version FROM schema_version').get() as {
      version: number;
    } | undefined;
    if (!isSupportedDatabaseSchema(version?.version)) {
      throw new Error(`rollback database schema is incompatible: ${version?.version ?? 'missing'}`);
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('rollback database integrity check failed');
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('rollback database foreign key check failed');
    }
  } finally {
    db.close();
  }
}

async function ensureRevisionedFilePointer(accountPaths: AccountPaths): Promise<void> {
  const info = await lstat(accountPaths.database);
  if (info.isSymbolicLink()) return;
  if (!info.isFile()) {
    throw new Error(`account database is not a file or symlink: ${accountPaths.database}`);
  }
  assertCompatibleDatabase(accountPaths.database);
  await mkdir(accountPaths.databaseRevisions, { recursive: true, mode: 0o700 });
  const revisionId = `pre-revision-pointer-${randomUUID()}`;
  const baseline = databaseRevisionFile(accountPaths.databaseRevisions, revisionId);
  await cloneDatabase(accountPaths.database, baseline);
  await chmod(baseline, 0o600);
  assertCompatibleDatabase(baseline);
  await replaceDatabasePointer(accountPaths.database, databaseRevisionTarget(revisionId));
}

async function installDatabasePointerMigration(
  accountPaths: AccountPaths,
  record: DatabasePointerMigrationRecord,
): Promise<void> {
  if (!(await databaseFileIsUsable(record.revisionFile))) {
    if (!(await databaseFileIsUsable(accountPaths.database))) {
      throw new Error(
        `database pointer migration has no usable database: ${record.revisionFile}`,
      );
    }
    await rm(dirname(record.revisionFile), { recursive: true, force: true });
    await mkdir(dirname(record.revisionFile), { recursive: true, mode: 0o700 });
    await cloneDatabase(accountPaths.database, record.revisionFile);
    await chmod(record.revisionFile, 0o600);
    await syncFile(record.revisionFile);
    await syncDirectory(dirname(record.revisionFile));
    if (!(await databaseFileIsUsable(record.revisionFile))) {
      throw new Error(`database pointer migration clone failed verification: ${record.revisionFile}`);
    }
  }
  await rm(record.temporaryPointerPath, { recursive: true, force: true });
  await createDirectoryLink(record.temporaryPointerPath, record.target);
  await removeDatabasePointer(record.pointerPath);
  await rename(record.temporaryPointerPath, record.pointerPath);
  await syncDirectory(dirname(record.pointerPath));
}

async function cloneDatabase(sourcePath: string, targetPath: string): Promise<void> {
  await rm(targetPath, { force: true });
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await source.backup(targetPath);
  } finally {
    source.close();
  }
}

async function databaseFileIsUsable(path: string): Promise<boolean> {
  const info = await lstatOrNull(path);
  if (info === null || !info.isFile()) return false;
  try {
    assertCompatibleDatabase(path);
    return true;
  } catch {
    return false;
  }
}

async function writeDatabasePointerMigrationJournal(
  dataDirectory: string,
  record: DatabasePointerMigrationRecord,
): Promise<void> {
  const path = databasePointerMigrationJournalPath(dataDirectory);
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await syncFile(temporary);
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

async function clearDatabasePointerMigrationJournal(dataDirectory: string): Promise<void> {
  await rm(databasePointerMigrationJournalPath(dataDirectory), { force: true });
  await syncDirectory(dataDirectory);
}

function parseDatabasePointerMigrationRecord(source: string): DatabasePointerMigrationRecord {
  const value = JSON.parse(source) as DatabasePointerMigrationRecord;
  if (
    value.schemaVersion !== 1
    || typeof value.pointerPath !== 'string'
    || typeof value.revisionFile !== 'string'
    || typeof value.target !== 'string'
    || typeof value.temporaryPointerPath !== 'string'
  ) {
    throw new Error('invalid database pointer migration journal');
  }
  return value;
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}
