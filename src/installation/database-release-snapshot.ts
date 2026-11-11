import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { assertCurrentDatabaseFile, CURRENT_SCHEMA_VERSION } from '../storage/schema.js';

/** A release activation copies current facts; it never upgrades a database. */
export class DatabaseReleaseSnapshot {
  async prepare(input: { sourcePath: string; backupPath: string; clonePath: string }): Promise<{
    sourceSchemaVersion: number;
    candidateSchemaVersion: number;
    backupSha256: string;
    candidateSha256: string;
  }> {
    const paths = [input.sourcePath, input.backupPath, input.clonePath].map(path => resolve(path));
    if (new Set(paths).size !== paths.length) throw new Error('database snapshot paths must be distinct');
    // In particular, never checkpoint or copy a legacy database before rejecting it.
    assertCurrentDatabaseFile(input.sourcePath);
    await Promise.all([
      mkdir(dirname(input.backupPath), { recursive: true, mode: 0o700 }),
      mkdir(dirname(input.clonePath), { recursive: true, mode: 0o700 }),
    ]);
    // Resolve parent aliases, and refuse existing files (including dangling
    // symlinks and hard links). EXCL also fences a destination created later.
    const canonical = await Promise.all(paths.map(async path =>
      join(await realpath(dirname(path)), basename(path))));
    if (new Set(canonical).size !== canonical.length) throw new Error('database snapshot paths must be distinct');
    for (const path of [input.backupPath, input.clonePath]) {
      const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing) throw new Error(`database snapshot destination already exists: ${path}`);
    }
    const staging = await mkdtemp(join(dirname(input.backupPath), '.metawork-snapshot-'));
    const stagedBackup = join(staging, 'snapshot.db');
    let backupCreated = false;
    let cloneCreated = false;
    try {
      const source = new Database(input.sourcePath, { readonly: true, fileMustExist: true });
      try { await source.backup(stagedBackup); }
      finally { source.close(); }
      assertCurrentDatabaseFile(stagedBackup);
      await copyFile(stagedBackup, input.backupPath, constants.COPYFILE_EXCL);
      backupCreated = true;
      await copyFile(stagedBackup, input.clonePath, constants.COPYFILE_EXCL);
      cloneCreated = true;
      assertCurrentDatabaseFile(input.clonePath);
      const candidate = new Database(input.clonePath, { readonly: true, fileMustExist: true });
      try {
        if (candidate.pragma('integrity_check', { simple: true }) !== 'ok'
          || (candidate.pragma('foreign_key_check') as unknown[]).length) {
          throw new Error('candidate database integrity check failed');
        }
      } finally { candidate.close(); }
      const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
      return {
        sourceSchemaVersion: CURRENT_SCHEMA_VERSION,
        candidateSchemaVersion: CURRENT_SCHEMA_VERSION,
        backupSha256: await hash(input.backupPath),
        candidateSha256: await hash(input.clonePath),
      };
    } catch (error) {
      if (cloneCreated) await rm(input.clonePath, { force: true });
      if (backupCreated) await rm(input.backupPath, { force: true });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
