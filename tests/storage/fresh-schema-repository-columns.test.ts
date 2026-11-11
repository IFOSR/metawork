import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CURRENT_SCHEMA_SQL } from '../../src/storage/current-schema.js';

/**
 * ADR-0055 D8 makes `current-schema.ts` the only schema: there is no upgrade
 * chain that could add a column a repository already writes. A repository write
 * that names a missing column therefore only fails against a fresh database, at
 * runtime, in the middle of a Task. This check reads the fresh DDL and every
 * literal `INSERT`/`UPDATE` column in `src/storage` so that drift fails here.
 */
function freshColumns(): Map<string, Set<string>> {
  const db = new Database(':memory:');
  try {
    db.exec(CURRENT_SCHEMA_SQL);
    const tables = new Map<string, Set<string>>();
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const row of rows) {
      const columns = db.prepare(`PRAGMA table_info('${row.name}')`).all() as { name: string }[];
      tables.set(row.name, new Set(columns.map(column => column.name)));
    }
    return tables;
  } finally {
    db.close();
  }
}

function storageSources(directory = 'src/storage'): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return storageSources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('fresh schema and repository writes', () => {
  it('declares every column the storage layer writes', () => {
    const tables = freshColumns();
    const problems: string[] = [];
    for (const file of storageSources()) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/giu)) {
        const table = match[1]!;
        const columns = tables.get(table);
        if (!columns) continue;
        for (const raw of match[2]!.split(',')) {
          const name = raw.replace(/--.*$/smu, '').trim();
          if (!/^[a-z_][a-z0-9_]*$/iu.test(name) || columns.has(name)) continue;
          problems.push(`${file}: INSERT ${table}.${name}`);
        }
      }
      for (const match of text.matchAll(/UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([\s\S]*?)(?=\bWHERE\b|$)/giu)) {
        const table = match[1]!;
        const columns = tables.get(table);
        if (!columns) continue;
        for (const assignment of match[2]!.split(',')) {
          const name = assignment.split('=')[0]!.replace(/--.*$/smu, '').trim();
          // `rowid` is a real SQLite alias used by the notification queues for
          // FIFO ordering; PRAGMA table_info does not list it.
          if (!/^[a-z_][a-z0-9_]*$/iu.test(name) || name === 'rowid' || columns.has(name)) continue;
          problems.push(`${file}: UPDATE ${table}.${name}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
