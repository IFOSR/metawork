import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from './current-schema.js';

export { CURRENT_SCHEMA_VERSION } from './current-schema.js';

type SchemaObject = { type: string; name: string; sql: string | null };
const SCHEMA_OBJECTS = "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'";
let expectedObjects: SchemaObject[] | undefined;

function currentObjects(): SchemaObject[] {
  if (!expectedObjects) {
    const reference = new Database(':memory:');
    try {
      reference.exec(CURRENT_SCHEMA_SQL);
      expectedObjects = reference.prepare(SCHEMA_OBJECTS).all() as SchemaObject[];
    } finally { reference.close(); }
  }
  return expectedObjects;
}


/** Exact current DDL for one object, used by in-place table rebuilds. */
function currentObjectSql(marker: string): string {
  const start = CURRENT_SCHEMA_SQL.indexOf(marker);
  if (start < 0) throw new Error(`missing object in current schema: ${marker}`);
  const end = CURRENT_SCHEMA_SQL.indexOf(';\n', start);
  if (end < 0) throw new Error(`unterminated object in current schema: ${marker}`);
  // sqlite_master stores the statement without the trailing semicolon.
  return CURRENT_SCHEMA_SQL.slice(start, end);
}

/** Read-only preflight shared by update/rollback and ordinary startup. */
export function assertCurrentDatabaseFile(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (assertDatabaseSchema(db) !== 'current') {
      throw new Error('runtime refuses an empty existing database; create a fresh installation');
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; database: ${path}; backup: ${path}.backup (include -wal/-shm); stop Server, back up, and move originals aside before reset`, { cause: error });
  } finally { db.close(); }
}

/** Validate before any journal or DDL mutation. Current markers never repair partial schemas. */
export function assertDatabaseSchema(db: Database.Database): 'empty' | 'current' {
  const objects = db.prepare(SCHEMA_OBJECTS).all() as SchemaObject[];
  if (!objects.length) return 'empty';
  if (!objects.some(object => object.type === 'table' && object.name === 'schema_version')) {
    throw new Error('runtime startup refuses an unversioned nonempty database; back up and create a fresh database');
  }
  const versions = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0]!.version) || versions[0]!.version <= 0) {
    throw new Error('runtime startup refuses malformed schema_version; back up and create a fresh database');
  }
  const version = versions[0]!.version;
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`runtime startup refuses legacy SQLite schema ${version}; back up the database (including -wal/-shm), then move the originals aside and create a fresh database for schema ${CURRENT_SCHEMA_VERSION}`);
  }
  // Every current object is mandatory; this also detects dropped indexes and
  // triggers, instead of trusting a single column on the tasks table. The
  // report names what is missing or extra so an operator never has to diff the
  // fresh DDL by hand.
  const expected = currentObjects();
  const expectedNames = new Set(expected.map(object => object.name));
  const actualNames = new Set(objects.map(object => object.name));
  const missing = [...expectedNames].filter(name => !actualNames.has(name)).sort();
  const extra = [...actualNames].filter(name => !expectedNames.has(name)).sort();
  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.slice(0, 12).join(', ')}` : '',
      extra.length > 0 ? `unexpected ${extra.slice(0, 12).join(', ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`runtime startup refuses malformed schema ${CURRENT_SCHEMA_VERSION}: ${details}; back up and create a fresh database`);
  }
  const actual = new Map(objects.map(object => [object.name, object]));
  for (const expected of currentObjects()) {
    const object = actual.get(expected.name);
    if (!object || object.type !== expected.type || object.sql !== expected.sql) {
      throw new Error(`runtime startup refuses malformed schema ${CURRENT_SCHEMA_VERSION}: ${expected.name}; back up and create a fresh database`);
    }
  }
  return 'current';
}

/**
 * Forward-only in-place upgrades for the immediately preceding schemas.
 *
 * The runtime still refuses unknown or older files: a release activation copies
 * facts and never rewrites a database. These steps exist only so an installed
 * account database survives a schema widening whose semantics are unchanged
 * (2026-11-11: `task_operation_results.outcome` gained `repair_pending`).
 */
function runUpgrade67To68(db: Database.Database): void {
  // The only change is a wider CHECK constraint; SQLite cannot ALTER one, so the
  // table is rebuilt with the exact current DDL and its rows copied.
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_operation_results'")
    .get() as { sql: string } | undefined;
  if (!existing) throw new Error('schema 67 upgrade: task_operation_results is missing');
  if (!existing.sql.includes("'unknown')")) {
    throw new Error('schema 67 upgrade: unexpected task_operation_results definition');
  }
  const targetSql = currentObjectSql('CREATE TABLE task_operation_results (');
  // Keep rows in a TEMP table so the rebuilt table can be created under its
  // final name with the exact current DDL. ALTER TABLE ... RENAME would quote
  // the name and break the fresh-schema comparison.
  db.exec('CREATE TEMP TABLE task_operation_results_upgrade AS SELECT * FROM task_operation_results');
  db.exec('DROP TABLE task_operation_results');
  db.exec(targetSql);
  db.exec('INSERT INTO task_operation_results SELECT * FROM task_operation_results_upgrade');
  db.exec('DROP TABLE task_operation_results_upgrade');
  // Dropping the table also dropped its index; recreate the current definition.
  db.exec(currentObjectSql('CREATE INDEX task_operation_results_task'));
  db.prepare('UPDATE schema_version SET version = ?').run(68);
}

const SUPPORTED_UPGRADES: Readonly<Record<number, (db: Database.Database) => void>> = {
  67: runUpgrade67To68,
};

/**
 * Opens an empty database by installing the current schema, or upgrades one
 * supported predecessor in place. Anything else is refused before any DDL.
 */
export function prepareDatabaseSchema(db: Database.Database): 'created' | 'current' | 'upgraded' {
  const objects = db.prepare(SCHEMA_OBJECTS).all() as SchemaObject[];
  if (!objects.length) {
    initializeDatabaseSchema(db);
    return 'created';
  }
  if (!objects.some(object => object.type === 'table' && object.name === 'schema_version')) {
    throw new Error('runtime startup refuses an unversioned nonempty database; back up and create a fresh database');
  }
  const versions = db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>;
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0]!.version) || versions[0]!.version <= 0) {
    throw new Error('runtime startup refuses malformed schema_version; back up and create a fresh database');
  }
  const version = versions[0]!.version;
  if (version === CURRENT_SCHEMA_VERSION) {
    assertDatabaseSchema(db);
    return 'current';
  }
  const upgrade = SUPPORTED_UPGRADES[version];
  if (!upgrade) {
    throw new Error(`runtime startup refuses legacy SQLite schema ${version}; supported upgrade sources: ${
      Object.keys(SUPPORTED_UPGRADES).join(', ') || '(none)'}; back up the database (including -wal/-shm), then move the originals aside and create a fresh database for schema ${CURRENT_SCHEMA_VERSION}`);
  }
  // PRAGMA foreign_keys cannot change inside a transaction; the table rebuild
  // must drop a referenced table, so restore the previous setting afterwards.
  const foreignKeys = Number(db.pragma('foreign_keys', { simple: true })) === 1;
  if (foreignKeys) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => { upgrade(db); }).immediate();
  } finally {
    if (foreignKeys) db.pragma('foreign_keys = ON');
  }
  assertDatabaseSchema(db);
  return 'upgraded';
}

/** Install only into an empty database; existing supported databases are read-only here. */
export function initializeDatabaseSchema(db: Database.Database): void {
  if (assertDatabaseSchema(db) === 'current') return;
  db.transaction(() => {
    db.exec(CURRENT_SCHEMA_SQL);
    db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    db.prepare('INSERT INTO conversation_observation_identity(singleton, id) VALUES (1, ?)').run(randomUUID());
  }).immediate();
}
