import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';

describe('schema 65 shared Conversation readers', () => {
  it('migrates atomically and preserves historical unspecified effects', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db);
      db.exec(`DROP TABLE conversation_attempt_owners;
        ALTER TABLE subtasks DROP COLUMN workspace_effect;
        UPDATE schema_version SET version=64;
        INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('old','old','old','running','then','then');
        INSERT INTO subtasks (id,task_id,graph_revision,generation_id,title,goal,status,dependencies_json,
          context_refs_json,required_capabilities_json,executor_bindings_json,delivery_kind,acceptance_json,
          risk_level,result,artifacts_json,verification_json,created_at,updated_at)
        VALUES ('node','old',1,'g','node','node','ready','[]','[]','[]','[]','report','[]','low','','[]','{}','then','then');
        CREATE TRIGGER fail_65 BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
      expect(() => runMigrations(db)).toThrow('injected');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({version: 64});
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversation_attempt_owners'").get()).toBeUndefined();
      db.exec('DROP TRIGGER fail_65');
      runMigrations(db);
      runMigrations(db);
      expect(db.prepare('SELECT workspace_effect FROM subtasks').get()).toEqual({workspace_effect: null});
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({version: CURRENT_SCHEMA_VERSION});
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
});
