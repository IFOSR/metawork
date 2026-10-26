import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRepo } from '../../src/storage/task-repo.js';

const LEGACY_TABLES = [
  'preferences',
  'preference_usage',
  'reflection_events',
  'learning_candidates',
];

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function tableNames(db: Database.Database, names: string[]): string[] {
  return (db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${names.map(() => '?').join(',')})
  `).all(...names) as Array<{ name: string }>).map(row => row.name).sort();
}

/** Recreate the schema 58 state of the retired local memory chain. */
function addLegacyMemoryChain(db: Database.Database) {
  db.exec(`
    ALTER TABLE tasks ADD COLUMN injected_prefs_json TEXT DEFAULT '[]';
    CREATE TABLE preferences (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, subject TEXT,
      content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'observed',
      confidence REAL DEFAULT 0, occurrence_count INTEGER DEFAULT 1,
      source_tasks TEXT DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_used_at TEXT, confirmed_at TEXT
    );
    CREATE TABLE preference_usage (
      id TEXT PRIMARY KEY, preference_id TEXT NOT NULL, task_id TEXT NOT NULL,
      injected_at TEXT NOT NULL, was_overridden INTEGER DEFAULT 0
    );
    CREATE TABLE reflection_events (
      id TEXT PRIMARY KEY, source_type TEXT NOT NULL, source_id TEXT, task_id TEXT,
      summary TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE TABLE learning_candidates (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL, content TEXT NOT NULL, source_reflection_id TEXT,
      source_task_id TEXT, safety_status TEXT NOT NULL DEFAULT 'pending',
      safety_reasons_json TEXT NOT NULL DEFAULT '[]', review_note TEXT,
      promoted_asset_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_preferences_scope ON preferences(scope);
    CREATE INDEX idx_learning_candidates_status ON learning_candidates(status, created_at);
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
      VALUES ('revision-legacy', 'sha256:legacy', 'native', '2026-10-26T00:00:00.000Z');
  `);
  db.prepare('UPDATE schema_version SET version = 58').run();
}

describe('schema 59 retires the pre-TDAI memory chain', () => {
  let db: Database.Database | null = null;

  afterEach(() => { db?.close(); db = null; });

  it('creates schema 59 with the memory tables and no legacy tables on a fresh install', () => {
    db = createDb();
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
    });
    expect(CURRENT_SCHEMA_VERSION).toBe(59);
    expect(tableNames(db, LEGACY_TABLES)).toEqual([]);
    expect(tableNames(db, [
      'memory_bindings', 'memory_recall_candidates', 'memory_flush_state',
      'memory_recall_state', 'memory_runtime_state',
    ])).toHaveLength(5);
    expect((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
      .map(column => column.name)).not.toContain('injected_prefs_json');
  });

  it('identifies a memory-branch schema 53 that has no six-state Task base', () => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (53);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    expect(() => runMigrations(db!)).toThrow(/six-state Task base/u);
  });

  it('upgrades schema 58, drops the legacy chain and invalidates persisted preference references', () => {
    db = createDb();
    addLegacyMemoryChain(db);
    const engine = new TaskEngine(new TaskRepo(db), '/tmp/metawork-schema-59');
    const task = engine.create({ title: '旧偏好任务', goal: '使用旧偏好' });
    db.prepare(`
      UPDATE tasks SET status = 'running', state_version = state_version + 1 WHERE id = ?
    `).run(task.id);

    db.prepare(`
      INSERT INTO subtasks (
        id, task_id, title, goal, status, dependencies_json, context_refs_json,
        required_capabilities_json, executor_bindings_json, acceptance_json,
        created_at, updated_at, graph_revision, generation_id
      ) VALUES (?, ?, '旧子任务', '旧目标', 'created', '[]', ?, '[]', '[]', '[]', ?, ?, 0, 'generation-legacy')
    `).run(
      'subtask_legacy', task.id,
      JSON.stringify([
        { kind: 'preference', preferenceId: 'pref-1' },
        { kind: 'current_user_input' },
      ]),
      '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO task_execution_evidence (id, task_id, kind, source_id, title, content, exact_only, created_at)
      VALUES ('evidence_pref_1', ?, 'preference', 'pref-1', 'Confirmed preference', '用中文', 1, ?)
    `).run(task.id, '2026-10-26T00:00:00.000Z');
    db.prepare(`
      INSERT INTO preferences (id, type, scope, content, status, created_at, updated_at)
      VALUES ('pref-1', 'style', 'global', '用中文', 'confirmed', ?, ?)
    `).run('2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z');

    const deferredPlan = {
      type: 'plan_proposed',
      proposal: {
        subtasks: [{ id: 's1', contextRefs: [{ kind: 'preference', preferenceId: 'pref-1' }] }],
      },
    };
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, configuration_revision,
        status, trigger_decision_id, deferred_plan_json, deferred_bindings_json,
        created_at, updated_at
      ) VALUES ('replan_legacy', ?, 'generation-legacy', 0, 'revision-legacy',
        'planning', 'decision-legacy', ?, '[]', ?, ?)
    `).run(
      task.id, JSON.stringify(deferredPlan),
      '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, task_id,
        event_json, available_at, status, configuration_revision, created_at, updated_at
      ) VALUES ('event_legacy', 1, 'plan_proposed', 'corr', 'sess', ?,
        ?, ?, 'pending', 'revision-legacy', ?, ?)
    `).run(
      task.id, JSON.stringify(deferredPlan),
      '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z', '2026-10-26T00:00:00.000Z',
    );

    runMigrations(db);

    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 59 });
    expect(tableNames(db, LEGACY_TABLES)).toEqual([]);
    expect((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>)
      .map(column => column.name)).not.toContain('injected_prefs_json');

    const refs = JSON.parse((db.prepare('SELECT context_refs_json FROM subtasks WHERE id = ?')
      .get('subtask_legacy') as { context_refs_json: string }).context_refs_json) as Array<{ kind: string }>;
    expect(refs).toEqual([{ kind: 'current_user_input' }]);

    expect(db.prepare("SELECT COUNT(*) AS count FROM task_execution_evidence WHERE kind = 'preference'")
      .get()).toEqual({ count: 0 });

    const taskRow = db.prepare('SELECT status, state_detail_json FROM tasks WHERE id = ?')
      .get(task.id) as { status: string; state_detail_json: string };
    expect(taskRow.status).toBe('needs_action');
    expect(JSON.parse(taskRow.state_detail_json)).toMatchObject({
      reason: { code: 'requirements_incomplete' },
      phase: null,
      pendingActions: [],
    });

    expect(db.prepare(`SELECT status, deferred_plan_json, error_summary
      FROM generation_replan_requests WHERE id = 'replan_legacy'`).get()).toMatchObject({
      status: 'failed',
      deferred_plan_json: null,
      error_summary: expect.stringContaining('legacy_preference_context_ref_retired'),
    });
    expect(db.prepare(`SELECT status, last_error FROM kernel_events WHERE id = 'event_legacy'`).get())
      .toMatchObject({
        status: 'failed',
        last_error: expect.stringContaining('legacy_preference_context_ref_retired'),
      });
  });
});
