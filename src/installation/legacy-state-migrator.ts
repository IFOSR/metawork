import { access, cp, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { AnyFusionPaths } from './paths.js';

export interface LegacyStateMigrationReport {
  sourceRoot: string | null;
  databaseMigrated: boolean;
  plannerSessionsMigrated: boolean;
  snapshotsMigrated: boolean;
}

export class LegacyStateMigrator {
  constructor(private readonly options: {
    userHome?: string;
  } = {}) {}

  async migrate(paths: AnyFusionPaths): Promise<LegacyStateMigrationReport> {
    if (await exists(paths.database)) {
      return emptyReport();
    }
    const userHome = this.options.userHome ?? homedir();
    const roots = [
      resolve(userHome, '.local/share/anyfusion'),
      resolve(userHome, '.metaclaw'),
    ];
    const candidates = [];
    for (const root of roots) {
      const database = resolve(root, 'metaclaw.db');
      if (await exists(database)) candidates.push({ root, database });
    }
    if (candidates.length > 1) {
      throw new Error(
        `multiple legacy databases require explicit resolution: ${candidates
          .map(candidate => candidate.database)
          .join(', ')}`,
      );
    }
    const candidate = candidates[0];
    if (!candidate) return emptyReport();

    await mkdir(paths.data, { recursive: true, mode: 0o700 });
    const source = new Database(candidate.database, { readonly: true, fileMustExist: true });
    try {
      await source.backup(paths.database);
    } finally {
      source.close();
    }
    const plannerSessionsMigrated = await copyDirectoryIfPresent(
      resolve(candidate.root, 'planner-sessions'),
      paths.plannerSessions,
    );
    const snapshotsMigrated = await copyDirectoryIfPresent(
      resolve(candidate.root, 'snapshots'),
      resolve(paths.data, 'snapshots'),
    );
    return {
      sourceRoot: candidate.root,
      databaseMigrated: true,
      plannerSessionsMigrated,
      snapshotsMigrated,
    };
  }
}

async function copyDirectoryIfPresent(source: string, target: string): Promise<boolean> {
  if (!await exists(source)) return false;
  await cp(source, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return true;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function emptyReport(): LegacyStateMigrationReport {
  return {
    sourceRoot: null,
    databaseMigrated: false,
    plannerSessionsMigrated: false,
    snapshotsMigrated: false,
  };
}
