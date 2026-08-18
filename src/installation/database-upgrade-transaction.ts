import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export interface DatabaseUpgradePrepareInput {
  sourcePath: string;
  backupPath: string;
  clonePath: string;
  expectedSourceSchema: number;
  expectedTargetSchema: number;
  sentinelTables: readonly string[];
}

export interface DatabaseUpgradePrepareResult {
  sourceSchemaVersion: number;
  candidateSchemaVersion: number;
  backupSha256: string;
  candidateSha256: string;
}

export class DatabaseUpgradeTransaction {
  constructor(private readonly dependencies: {
    migrateClone(path: string): Promise<void> | void;
  }) {}

  async prepare(input: DatabaseUpgradePrepareInput): Promise<DatabaseUpgradePrepareResult> {
    await Promise.all([
      mkdir(dirname(input.backupPath), { recursive: true, mode: 0o700 }),
      mkdir(dirname(input.clonePath), { recursive: true, mode: 0o700 }),
    ]);
    await rm(input.clonePath, { force: true });
    const source = new Database(input.sourcePath, { fileMustExist: true });
    let sourceSchemaVersion: number;
    try {
      source.pragma('wal_checkpoint(TRUNCATE)');
      sourceSchemaVersion = schemaVersion(source);
      if (sourceSchemaVersion !== input.expectedSourceSchema) {
        throw new Error(
          `source database schema mismatch: expected ${input.expectedSourceSchema}, got ${sourceSchemaVersion}`,
        );
      }
      await source.backup(input.backupPath);
    } finally {
      source.close();
    }

    verifyDatabase(input.backupPath, input.expectedSourceSchema, ['schema_version']);
    const backupSha256 = await sha256File(input.backupPath);
    await copyFile(input.backupPath, input.clonePath);

    try {
      await this.dependencies.migrateClone(input.clonePath);
      verifyDatabase(
        input.clonePath,
        input.expectedTargetSchema,
        input.sentinelTables,
        'candidate',
      );
      return {
        sourceSchemaVersion,
        candidateSchemaVersion: input.expectedTargetSchema,
        backupSha256,
        candidateSha256: await sha256File(input.clonePath),
      };
    } catch (error) {
      await rm(input.clonePath, { force: true });
      throw error;
    }
  }
}

function verifyDatabase(
  path: string,
  expectedSchema: number,
  sentinelTables: readonly string[],
  label = 'backup',
): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const actualSchema = schemaVersion(db);
    if (actualSchema !== expectedSchema) {
      throw new Error(
        `${label} database schema mismatch: expected ${expectedSchema}, got ${actualSchema}`,
      );
    }
    const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error(`${label} database integrity check failed`);
    }
    const foreignKeys = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeys.length > 0) {
      throw new Error(`${label} database foreign key check failed`);
    }
    for (const table of sentinelTables) {
      const row = db.prepare(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `).get(table) as { present: 1 } | undefined;
      if (!row) throw new Error(`${label} database missing sentinel table: ${table}`);
    }
  } finally {
    db.close();
  }
}

function schemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT version FROM schema_version').get() as {
    version: number;
  } | undefined;
  if (!row || !Number.isInteger(row.version)) {
    throw new Error('database schema version is missing');
  }
  return row.version;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
