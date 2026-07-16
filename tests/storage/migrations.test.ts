import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';

describe('runMigrations', () => {
  it('repairs a legacy v1 database whose schema_version table is empty', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'created',
        summary TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        block_reason TEXT,
        next_step TEXT,
        resources_json TEXT DEFAULT '[]'
      );

      CREATE TABLE preferences (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        subject TEXT,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'observed',
        confidence REAL DEFAULT 0,
        occurrence_count INTEGER DEFAULT 1,
        source_tasks TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        confirmed_at TEXT
      );

      CREATE TABLE preference_usage (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        was_overridden INTEGER DEFAULT 0
      );

      CREATE TABLE observations (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        occurrence_count INTEGER DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        source_tasks TEXT DEFAULT '[]',
        promoted_to_preference_id TEXT
      );

      CREATE TABLE interactions (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT,
        system_output TEXT,
        executor_used TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tasks_status ON tasks(status);
    `);

    expect(() => runMigrations(db)).not.toThrow();

    const versions = db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>;
    expect(versions.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    expect(taskColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'snapshot_json',
      'dependencies_json',
      'priority_json',
      'injected_prefs_json',
      'last_scheduling_reason',
      'last_interruption_reason',
      'interruption_count',
      'artifacts_json',
    ]));

    const auditColumns = db.prepare('PRAGMA table_info(memory_audit_events)').all() as Array<{ name: string }>;
    expect(auditColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'task_id',
      'memory_id',
      'action',
      'score',
      'reason',
      'judge_source',
      'evidence_json',
      'created_at',
    ]));

    const executorProfileColumns = db.prepare('PRAGMA table_info(executor_profiles)').all() as Array<{ name: string }>;
    expect(executorProfileColumns).toEqual([]);

    const agentClassColumns = db.prepare('PRAGMA table_info(agent_classes)').all() as Array<{ name: string }>;
    expect(agentClassColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'name',
      'kind',
      'harness',
      'model',
      'skills_json',
      'mcp_servers_json',
      'plugins_json',
      'runtime_command',
    ]));
    expect(agentClassColumns.map(column => column.name)).not.toContain('historical_success');

    const subtaskColumns = db.prepare('PRAGMA table_info(subtasks)').all() as Array<{ name: string }>;
    expect(subtaskColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'task_id',
      'status',
      'required_agent_class_kind',
      'candidate_agent_classes_json',
    ]));

    const workUnitColumns = db.prepare('PRAGMA table_info(work_units)').all() as Array<{ name: string }>;
    expect(workUnitColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'agent_class_name',
      'agent_class_kind',
      'state',
      'claimed_task_id',
      'claimed_subtask_id',
      'heartbeat_at',
      'lease_expires_at',
    ]));

    const planningDecisionColumns = db.prepare('PRAGMA table_info(planning_decisions)').all() as Array<{ name: string }>;
    expect(planningDecisionColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'session_id',
      'request_id',
      'task_id',
      'user_input',
      'plan_json',
      'decision_json',
      'outcome',
      'reason',
      'created_at',
    ]));

    const taskSearchIndexColumns = db.prepare('PRAGMA table_info(task_search_index)').all() as Array<{ name: string }>;
    expect(taskSearchIndexColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      'task_id',
      'source_kind',
      'source_id',
      'title',
      'body',
      'tags',
      'created_at',
      'updated_at',
    ]));

    const repo = new TaskRepo(db);
    repo.insert({
      id: 'task_legacy_repaired',
      title: 'legacy repaired',
      goal: 'verify repo can write after migration repair',
      status: 'created',
      summary: '',
      snapshots: [],
      resources: [],
      artifacts: [],
      dependencies: [],
      prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
      injectedPreferences: [],
      lastSchedulingReason: '',
      lastInterruptionReason: '',
      interruptionCount: 0,
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:00:00.000Z',
    });

    expect(repo.findById('task_legacy_repaired')?.title).toBe('legacy repaired');
  });

  it('drops the legacy Executor profile table from v18 without losing AgentClass rows, route events, or foreign keys', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (18);

      CREATE TABLE executor_profiles (
        name TEXT PRIMARY KEY,
        historical_success REAL NOT NULL DEFAULT 0.5
      );
      INSERT INTO executor_profiles (name, historical_success) VALUES ('legacy-profile', 0.9);

      CREATE TABLE executor_route_events (id TEXT PRIMARY KEY);
      INSERT INTO executor_route_events (id) VALUES ('route-1');

      CREATE TABLE agent_classes (
        name TEXT PRIMARY KEY,
        historical_success REAL NOT NULL DEFAULT 0.5
      );
      INSERT INTO agent_classes (name, historical_success) VALUES ('codex-cli', 0.85);
      INSERT INTO agent_classes (name, historical_success) VALUES ('research-bot', 0.75);

      CREATE TABLE work_units (
        id TEXT PRIMARY KEY,
        agent_class_name TEXT NOT NULL,
        FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
      );
      INSERT INTO work_units (id, agent_class_name) VALUES ('wu-1', 'codex-cli');
    `);

    runMigrations(db);

    const agentClassColumns = db.prepare('PRAGMA table_info(agent_classes)').all() as Array<{ name: string }>;
    expect(db.prepare('PRAGMA table_info(executor_profiles)').all()).toEqual([]);
    expect(agentClassColumns.map(column => column.name)).not.toContain('historical_success');
    expect(db.prepare('SELECT name FROM agent_classes ORDER BY name').all()).toEqual([
      { name: 'codex-cli' },
      { name: 'research-bot' },
    ]);
    expect(db.prepare('SELECT id FROM executor_route_events').all()).toEqual([{ id: 'route-1' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()).toEqual({ version: 20 });
  });
});
