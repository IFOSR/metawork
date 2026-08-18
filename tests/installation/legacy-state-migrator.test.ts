import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAnyFusionPaths } from '../../src/installation/paths.js';
import { LegacyStateMigrator } from '../../src/installation/legacy-state-migrator.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('LegacyStateMigrator', () => {
  it('copies one legacy native data root into the unified install root without mutating the source', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anyfusion-legacy-state-'));
    cleanup.push(home);
    const legacyRoot = join(home, '.local', 'share', 'anyfusion');
    const legacyDatabase = join(legacyRoot, 'metaclaw.db');
    createLegacyDatabase(legacyDatabase);
    const sessionPath = join(legacyRoot, 'planner-sessions', 'session.jsonl');
    writeFile(sessionPath, '{"type":"session"}\n');
    const paths = resolveAnyFusionPaths(home);
    const sourceBefore = readFileSync(legacyDatabase);

    const report = await new LegacyStateMigrator({ userHome: home }).migrate(paths);

    expect(report.sourceRoot).toBe(legacyRoot);
    expect(existsSync(paths.database)).toBe(true);
    const migrated = new Database(paths.database, { readonly: true });
    expect(migrated.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 30 });
    migrated.close();
    expect(readFileSync(legacyDatabase)).toEqual(sourceBefore);
    expect(readFileSync(join(paths.plannerSessions, 'session.jsonl'), 'utf8'))
      .toBe('{"type":"session"}\n');
    expect(existsSync(legacyDatabase)).toBe(true);
  });

  it('fails closed when multiple legacy databases compete', async () => {
    const home = mkdtempSync(join(tmpdir(), 'anyfusion-legacy-conflict-'));
    cleanup.push(home);
    createLegacyDatabase(join(home, '.local', 'share', 'anyfusion', 'metaclaw.db'));
    createLegacyDatabase(join(home, '.metaclaw', 'metaclaw.db'));

    await expect(new LegacyStateMigrator({ userHome: home }).migrate(
      resolveAnyFusionPaths(home),
    )).rejects.toThrow('multiple legacy databases');
  });
});

function createLegacyDatabase(path: string): void {
  const parent = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(parent, { recursive: true });
  const db = new Database(path);
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO schema_version (version, applied_at)
    VALUES (30, '2026-08-14T00:00:00.000Z');
  `);
  db.close();
}

function writeFile(path: string, content: string): void {
  const parent = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(parent, { recursive: true });
  writeFileSync(path, content);
}
