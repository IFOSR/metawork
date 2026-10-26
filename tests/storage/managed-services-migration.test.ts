import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskArtifactRepo } from '../../src/storage/task-artifact-repo.js';
import { localServiceSpecificationRevision } from '../../src/task/local-service.js';
import { ManagedLocalServiceRepo } from '../../src/storage/managed-local-service-repo.js';
import type { LocalServiceRecord } from '../../src/task/local-service.js';

function schema50() {
  const db = new Database(':memory:');
  runMigrations(db);
  db.exec(`DROP TABLE public_workspace_files;
    DROP TABLE managed_local_service_effects;
    DROP TABLE managed_local_services;
    ALTER TABLE tasks DROP COLUMN public_task_directory;
    ALTER TABLE tasks DROP COLUMN public_delivery_baseline_json;
    ALTER TABLE tasks DROP COLUMN start_service_after_publish;
    ALTER TABLE tasks DROP COLUMN public_project;
    UPDATE schema_version SET version=50;
    INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('old', 'Old title', 'retain facts', 'succeeded', 'then', 'then');
    INSERT INTO tasks (id,title,goal,status,created_at,updated_at) VALUES ('new', 'New title', 'new directory', 'needs_action', 'then', 'then');`);
  new TaskArtifactRepo(db).insert({ accountId: 'a', taskId: 'old', displayName: 'answer.md',
    relativePath: 'reports/answer.md', publishedPath: '/user/workspace/metaclaw-tasks/original/reports/answer.md',
    mediaType: 'text/markdown', previewKind: 'markdown', contentHash: 'sha256:old', byteLength: 4, now: 'then' });
  return db;
}

describe('schema 50 to 51 public delivery and managed service migration', () => {
  it('retains historical delivery directories and artifact bytes metadata across repeated opens', () => {
    const db = schema50();
    try {
      const facts = db.prepare('SELECT * FROM task_artifacts').all();
      runMigrations(db); runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
      expect(db.prepare('SELECT * FROM task_artifacts').all()).toEqual(facts);
      const tasks = new TaskRepo(db);
      expect(tasks.findById('old')?.publicTaskDirectory).toBe('metaclaw-tasks/original');
      const original = tasks.findById('new')!.publicTaskDirectory;
      expect(original).toMatch(/^metaclaw-tasks\/new-title-[a-f0-9]{16}$/u);
      tasks.update('new', { title: 'Renamed' });
      expect(tasks.findById('new')!.publicTaskDirectory).toBe(original);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });

  it('rolls back all new columns, tables and backfill when version advancement fails, then retries cleanly', () => {
    const db = schema50();
    try {
      const facts = db.prepare('SELECT * FROM tasks').all();
      db.exec("CREATE TRIGGER fail_51 BEFORE UPDATE ON schema_version BEGIN SELECT RAISE(ABORT, 'injected 51 failure'); END");
      expect(() => runMigrations(db)).toThrow('injected 51 failure');
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 50 });
      expect(db.prepare('SELECT * FROM tasks').all()).toEqual(facts);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('managed_local_services','managed_local_service_effects','public_workspace_files')").all()).toEqual([]);
      db.exec('DROP TRIGGER fail_51');
      runMigrations(db);
      expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: CURRENT_SCHEMA_VERSION });
    } finally { db.close(); }
  });

  it('isolates account service facts and prevents changing a service identity or its launch specification', () => {
    const db = schema50();
    try {
      runMigrations(db);
      const a = new ManagedLocalServiceRepo(db, 'a');
      const b = new ManagedLocalServiceRepo(db, 'b');
      const record: LocalServiceRecord = {
        accountId: 'a',
        workspaceId: null,
        specificationRevision: '',
        specification: { serviceId: 'api', taskId: 'old',
        command: 'node', args: ['server.mjs'], environmentReferences: {}, host: '127.0.0.1', port: 8080,
        healthPath: '/health', startupTimeoutMs: 1000, restartPolicy: 'explicit' },
        state: 'stopped', processId: null, processToken: null, healthMessage: null, updatedAt: 'now',
      };
      // The repository derives the revision on write; mirror the stored fact.
      record.specificationRevision = localServiceSpecificationRevision(record.specification);
      a.save(record);
      expect(b.find('api')).toBeNull(); expect(b.list()).toEqual([]);
      // Service identity is (account, workspace, service): another account may
      // register the same id, and the two rows stay isolated.
      b.save({ ...record, accountId: 'b' });
      expect(a.find('api')).toMatchObject({ accountId: 'a' });
      expect(b.find('api')).toMatchObject({ accountId: 'b' });
      // The same account with a different Workspace is a different service too.
      a.save({ ...record, workspaceId: 'workspace_two' });
      expect(a.findInWorkspace('workspace_two', 'api')).toMatchObject({ workspaceId: 'workspace_two' });
      // Re-registering the same identity with a different spec still needs an
      // explicit authorization, not a silent overwrite.
      expect(() => a.save({ ...record, specification: { ...record.specification, args: ['other.mjs'] } })).toThrow();
      a.saveOperation({ decisionId: 'decision', serviceId: 'api', operation: 'stop', phase: 'completed', initialToken: null, result: null, error: null });
      expect(b.findOperation('decision')).toBeNull();
      // Two registrations share the id, so the bare lookup refuses to guess and
      // callers must name the Workspace.
      expect(() => a.find('api')).toThrow(/多个 Workspace/u);
      expect(a.findInWorkspace('', 'api')).toEqual(record);
      // Changing the launch specification needs an explicit authorization.
      expect(a.findAuthorizedRevision('a', 'old', 'api')).toBe(record.specificationRevision);
    } finally { db.close(); }
  });
});
