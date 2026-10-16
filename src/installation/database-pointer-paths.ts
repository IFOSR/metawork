// Pure path contract for the database revision pointer, shared by the account
// layout and the pointer transaction. Platform shape and rationale live in
// `./database-pointer.ts`; this module has no I/O so path resolution can import
// it without pulling in the database driver.
import { dirname, join, resolve } from 'node:path';

export const DATABASE_FILE_NAME = 'anyfusion.db';
export const DATABASE_REVISIONS_DIRECTORY = 'database-revisions';

export type DatabasePointerKind = 'file' | 'directory';

export function databasePointerKind(
  platform: NodeJS.Platform = process.platform,
): DatabasePointerKind {
  return platform === 'win32' ? 'directory' : 'file';
}

/** Pointer target naming one revision, relative to the pointer's parent directory. */
export function databaseRevisionTarget(revisionId: string): string {
  return databasePointerKind() === 'directory'
    ? join(DATABASE_REVISIONS_DIRECTORY, revisionId)
    : join(DATABASE_REVISIONS_DIRECTORY, `${revisionId}.db`);
}

/** Absolute path of the database file a revision owns. */
export function databaseRevisionFile(revisionsRoot: string, revisionId: string): string {
  return databasePointerKind() === 'directory'
    ? join(revisionsRoot, revisionId, DATABASE_FILE_NAME)
    : join(revisionsRoot, `${revisionId}.db`);
}

/** Absolute database file a stored pointer target resolves to. */
export function resolveDatabasePointerFile(pointerPath: string, target: string): string {
  const resolved = resolve(dirname(pointerPath), target);
  return databasePointerKind() === 'directory'
    ? join(resolved, DATABASE_FILE_NAME)
    : resolved;
}

/** The account's pointer path and the live database file behind it. */
export function resolveAccountDatabasePaths(dataDirectory: string): {
  pointer: string;
  file: string;
} {
  if (databasePointerKind() === 'directory') {
    const pointer = resolve(dataDirectory, 'database-current');
    return { pointer, file: join(pointer, DATABASE_FILE_NAME) };
  }
  const file = resolve(dataDirectory, DATABASE_FILE_NAME);
  return { pointer: file, file };
}
