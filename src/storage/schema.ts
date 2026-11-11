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

/** Install only into an empty database; existing supported databases are read-only here. */
export function initializeDatabaseSchema(db: Database.Database): void {
  if (assertDatabaseSchema(db) === 'current') return;
  db.transaction(() => {
    db.exec(CURRENT_SCHEMA_SQL);
    db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(CURRENT_SCHEMA_VERSION);
    db.prepare('INSERT INTO conversation_observation_identity(singleton, id) VALUES (1, ?)').run(randomUUID());
  }).immediate();
}
