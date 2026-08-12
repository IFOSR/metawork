import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  createSchema30MigrationContext,
  runMigrations,
} from '../../src/storage/migrations.js';

describe('current SQLite baseline', () => {
  it('creates schema 31 without requiring migration context on a fresh database', () => {
    const db = new Database(':memory:');

    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 31 }]);
    for (const table of [
      'tasks',
      'subtasks',
      'configuration_revisions',
      'work_graph_revisions',
      'kernel_events',
      'kernel_decisions',
      'kernel_decision_applications',
      'kernel_effect_outbox',
      'kernel_dispatch_items',
      'executor_attempt_receipts',
      'resource_leases',
      'resource_waits',
      'workspace_records',
      'workspace_publications',
      'workspace_merge_attempts',
      'generation_replan_requests',
      'kernel_executor_status',
      'kernel_provider_status',
      'kernel_model_status',
      'kernel_binding_status',
      'planner_proposal_turns',
      'planner_proposal_submissions',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
    }
    for (const removed of [
      'planning_decisions_legacy_audit',
      'subtasks_v2_audit',
      'subtasks_v3_audit',
      'worktree_leases_legacy_audit',
      'executor_profiles',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${removed})`).all(), removed).toEqual([]);
    }
    expect(columns(db, 'subtasks')).toContain('executor_bindings_json');
    expect(columns(db, 'subtasks')).not.toContain('preferred_agent_class_list_json');
    expect(columns(db, 'work_graph_revisions')).toEqual(expect.arrayContaining([
      'completion_kind',
      'configuration_revision',
    ]));
    expect(columns(db, 'planner_runs')).toEqual(expect.arrayContaining([
      'configuration_revision',
      'planner_binding_json',
      'planner_binding_fingerprint',
    ]));
    expect(columns(db, 'kernel_decisions')).toEqual(expect.arrayContaining([
      'configuration_revision',
      'authorized_bindings_json',
      'binding_fingerprints_json',
    ]));
    expect(columns(db, 'executor_attempt_receipts')).toEqual(expect.arrayContaining([
      'configuration_revision',
      'authorized_binding_json',
      'binding_fingerprint',
    ]));
    expect(columns(db, 'kernel_dispatch_items')).toEqual(expect.arrayContaining([
      'configuration_revision',
      'authorized_binding_json',
      'binding_fingerprint',
    ]));
    expect(columns(db, 'generation_replan_requests')).toEqual(expect.arrayContaining([
      'configuration_revision',
      'deferred_bindings_json',
    ]));
    expect((db.prepare('PRAGMA table_info(resource_leases)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'revocation_requested_at',
      'revocation_reason',
    ]));
    expect((db.prepare('PRAGMA table_info(kernel_executor_status)').all() as Array<{ name: string }>)
      .map(column => column.name)).toContain('recent_recovery_checks_json');
    expect((db.prepare('PRAGMA table_info(generation_replan_requests)').all() as Array<{ name: string }>)
      .map(column => column.name)).toEqual(expect.arrayContaining([
      'deferred_plan_json',
      'availability_explanation',
    ]));
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_planner_proposal_submissions_turn'
    `).get()).toEqual({ name: 'idx_planner_proposal_submissions_turn' });
    expect(db.prepare('PRAGMA foreign_key_list(planner_proposal_submissions)').all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: 'planner_proposal_turns', from: 'session_id', to: 'session_id', on_delete: 'CASCADE',
        }),
        expect.objectContaining({
          table: 'planner_proposal_turns', from: 'turn_id', to: 'turn_id', on_delete: 'CASCADE',
        }),
      ]));
    expect(db.prepare('PRAGMA foreign_key_list(work_units)').all())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'agent_classes', from: 'agent_class_name' }),
      ]));
    expect(db.prepare('PRAGMA foreign_key_list(kernel_executor_status)').all())
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'agent_classes', from: 'agent_class_name' }),
      ]));
    expect(() => db.prepare(`
      INSERT INTO configuration_revisions (
        revision_id, content_hash, source_kind, imported_at
      ) VALUES ('immutable', 'sha256:immutable', 'native', ?)
    `).run(NOW)).not.toThrow();
    expect(() => db.prepare(`
      UPDATE configuration_revisions SET content_hash = 'changed'
      WHERE revision_id = 'immutable'
    `).run()).toThrow('configuration_revisions are immutable');
    expect(() => db.prepare(`
      DELETE FROM configuration_revisions WHERE revision_id = 'immutable'
    `).run()).toThrow('configuration_revisions are immutable');
    expectSchema31Contracts(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('upgrades schema 30 recoverable records with one imported revision and preserves terminal ledgers byte-for-byte', () => {
    const db = schema30Fixture();
    seedSchema30Runtime(db);
    const plan = v7Plan();
    const event = {
      schemaVersion: 5,
      type: 'plan_proposed',
      proposal: plan,
    };
    const rawEvent = JSON.stringify(event);
    const rawPlan = JSON.stringify(plan);
    const terminalDispatchPayload = '{ "proposal": { "schemaVersion": 7 } }';
    const terminalSnapshot = '{ "schemaVersion": 5, "proposal": { "schemaVersion": 7 } }';
    const terminalDecision = '{ "schemaVersion": 5, "action": { "type": "no_op" } }';
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, event_json,
        available_at, status, created_at, updated_at
      ) VALUES (?, 5, 'plan_proposed', ?, 'session', ?, ?, ?, ?, ?)
    `).run('event_pending', 'corr_pending', rawEvent, NOW, 'pending', NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, event_json,
        available_at, status, processed_at, created_at, updated_at
      ) VALUES (?, 5, 'plan_proposed', ?, 'session', ?, ?, 'processed', ?, ?, ?)
    `).run('event_terminal', 'corr_terminal', rawEvent, NOW, NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, session_id,
        event_json, snapshot_json, decision_json, action, reason, created_at
      ) VALUES ('decision_pending', 5, 'event_pending', 'plan_proposed', 'corr_pending', 'session', ?, ?, ?,
        'authorize_task_plan', 'test', ?)
    `).run(rawEvent, JSON.stringify({ proposal: plan }), JSON.stringify({ proposal: plan }), NOW);
    db.prepare(`
      INSERT INTO kernel_decision_applications (
        id, decision_id, event_id, idempotency_key, status, created_at, updated_at
      ) VALUES ('application_pending', 'decision_pending', 'event_pending', 'decision:pending', 'pending', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_decisions (
        id, schema_version, event_id, event_type, correlation_id, session_id,
        event_json, snapshot_json, decision_json, action, reason, created_at
      ) VALUES ('decision_applied', 5, 'event_terminal', 'plan_proposed', 'corr_terminal', 'session', ?, ?, ?,
        'no_op', 'terminal', ?)
    `).run(rawEvent, terminalSnapshot, terminalDecision, NOW);
    db.prepare(`
      INSERT INTO kernel_decision_applications (
        id, decision_id, event_id, idempotency_key, status, applied_at, created_at, updated_at
      ) VALUES ('application_applied', 'decision_applied', 'event_terminal', 'decision:applied',
        'applied', ?, ?, ?)
    `).run(NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_dispatch_items (
        attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
        agent_class_name, attempt_kind, recovery_mode, attempt_payload_json,
        resource_grant_json, status, created_at, updated_at
      ) VALUES ('attempt_pending', 'decision_pending', 0, 'task', 'generation', 'subtask',
        'codex-cli', 'primary', 'fresh', ?, '[]', 'pending_launch', ?, ?)
    `).run(JSON.stringify({ proposal: plan }), NOW, NOW);
    db.prepare(`
      INSERT INTO kernel_dispatch_items (
        attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
        agent_class_name, attempt_kind, recovery_mode, attempt_payload_json,
        resource_grant_json, status, terminal_at, created_at, updated_at
      ) VALUES ('attempt_terminal', 'decision_applied', 1, 'task', 'generation', 'subtask',
        'codex-cli', 'primary', 'fresh', ?, '[]', 'terminal', ?, ?, ?)
    `).run(terminalDispatchPayload, NOW, NOW, NOW);
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        deferred_plan_json, created_at, updated_at
      ) VALUES ('replan', 'task', 'generation', 1, 'waiting_for_availability',
        'decision_pending', ?, ?, ?)
    `).run(rawPlan, NOW, NOW);
    const rowCountsBefore = Object.fromEntries([
      'subtasks',
      'planner_runs',
      'kernel_events',
      'kernel_decisions',
      'kernel_dispatch_items',
      'work_graph_revisions',
      'generation_replan_requests',
    ].map(table => [table, countRows(db, table)]));

    runMigrations(db, migrationContext());
    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 31 });
    expect(readJson(db, 'SELECT executor_bindings_json FROM subtasks WHERE id = ?', 'subtask'))
      .toEqual([{
        agentClassRef: 'codex-engineering',
        harnessRef: 'codex-cli',
        modelRef: 'engineering-model',
        providerRef: 'openai',
        permissionProfileRef: 'workspace-default',
        configurationRevision: 'import-revision-1',
      }]);
    expect(db.prepare(`
      SELECT revision_id, content_hash, source_kind
      FROM configuration_revisions
    `).all()).toEqual([{
      revision_id: 'import-revision-1',
      content_hash: 'sha256:imported-configuration',
      source_kind: 'schema-30-import',
    }]);
    expect(readJson(db, 'SELECT event_json FROM kernel_events WHERE id = ?', 'event_pending'))
      .toMatchObject({
        proposal: {
          schemaVersion: 8,
          workGraph: {
            schemaVersion: 7,
            subtasks: [{
              executorBindings: [{
                agentClassRef: 'codex-engineering',
                modelSelection: { mode: 'fixed-by-agent-class' },
              }],
            }],
          },
        },
      });
    expect(db.prepare('SELECT event_json FROM kernel_events WHERE id = ?').get('event_terminal'))
      .toEqual({ event_json: rawEvent });
    expect(readJson(db, 'SELECT decision_json FROM kernel_decisions WHERE id = ?', 'decision_pending'))
      .toMatchObject({ proposal: { schemaVersion: 8, workGraph: { schemaVersion: 7 } } });
    expect(db.prepare(`
      SELECT event_json, snapshot_json, decision_json
      FROM kernel_decisions WHERE id = 'decision_applied'
    `).get()).toEqual({
      event_json: rawEvent,
      snapshot_json: terminalSnapshot,
      decision_json: terminalDecision,
    });
    expect(readJson(db, 'SELECT attempt_payload_json FROM kernel_dispatch_items WHERE attempt_id = ?', 'attempt_pending'))
      .toMatchObject({ proposal: { schemaVersion: 8, workGraph: { schemaVersion: 7 } } });
    expect(db.prepare(`
      SELECT attempt_payload_json
      FROM kernel_dispatch_items WHERE attempt_id = 'attempt_terminal'
    `).get()).toEqual({ attempt_payload_json: terminalDispatchPayload });
    expect(readJson(db, 'SELECT deferred_plan_json FROM generation_replan_requests WHERE id = ?', 'replan'))
      .toMatchObject({ schemaVersion: 8, workGraph: { schemaVersion: 7 } });
    expect(db.prepare(`
      SELECT configuration_revision, binding_fingerprint
      FROM kernel_dispatch_items WHERE attempt_id = 'attempt_pending'
    `).get()).toEqual({
      configuration_revision: 'import-revision-1',
      binding_fingerprint: 'sha256:codex-binding',
    });
    expect(db.prepare(`
      SELECT configuration_revision, planner_binding_fingerprint
      FROM planner_runs WHERE id = 'planner-run'
    `).get()).toEqual({
      configuration_revision: 'import-revision-1',
      planner_binding_fingerprint: 'sha256:planner-binding',
    });
    expect(db.prepare(`
      SELECT configuration_revision
      FROM work_graph_revisions WHERE id = 'graph'
    `).get()).toEqual({ configuration_revision: 'import-revision-1' });
    for (const [table, count] of Object.entries(rowCountsBefore)) {
      expect(countRows(db, table), table).toBe(count);
    }
    expectSchema31Contracts(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('requires an authentic sealed context for schema 30', () => {
    const db = schema30Fixture();

    expect(() => runMigrations(db)).toThrow('schema 30 to 31 migration requires sealed context');
    expect(() => runMigrations(db, {
      revisionId: 'forged',
      contentHash: 'forged',
      importedAt: NOW,
      plannerBinding: plannerBinding(),
      legacyAgentClassBindings: { 'codex-cli': executorBinding() },
    } as never)).toThrow('schema 30 to 31 migration requires sealed context');
    expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 30 });
  });

  it('rolls back schema 30 migration when a recoverable payload is invalid', () => {
    const db = schema30Fixture();
    seedSchema30Runtime(db);
    db.prepare(`
      INSERT INTO generation_replan_requests (
        id, task_id, generation_id, source_revision, status, trigger_decision_id,
        deferred_plan_json, created_at, updated_at
      ) VALUES ('replan', 'task', 'generation', 1, 'waiting_for_availability',
        'decision', '{broken', ?, ?)
    `).run(NOW, NOW);

    expect(() => runMigrations(db, migrationContext())).toThrow('contains invalid recoverable JSON');
    expectSchema30Rollback(db);
  });

  it('rolls back schema 30 migration when a legacy AgentClass mapping is ambiguous', () => {
    const db = schema30Fixture();
    seedSchema30Runtime(db);
    const context = createSchema30MigrationContext({
      ...migrationContextInput(),
      legacyAgentClassBindings: {},
    });

    expect(() => runMigrations(db, context)).toThrow(
      'legacy AgentClass codex-cli has no exact schema 31 binding',
    );
    expectSchema30Rollback(db);
  });

  it('rolls back schema 30 migration when a recoverable graph mixes legacy and v31 fields', () => {
    const db = schema30Fixture();
    seedSchema30Runtime(db);
    const ambiguousGraph = {
      reason: 'mixed graph',
      configurationRevision: 'pre-existing-revision',
      subtasks: [{
        id: 'subtask',
        preferredAgentClassList: ['codex-cli'],
        executorBindings: [{
          agentClassRef: 'codex-engineering',
          modelSelection: { mode: 'fixed-by-agent-class' },
        }],
      }],
    };
    db.prepare(`
      INSERT INTO kernel_events (
        id, schema_version, event_type, correlation_id, session_id, event_json,
        available_at, status, created_at, updated_at
      ) VALUES ('event_ambiguous', 5, 'plan_proposed', 'corr_ambiguous',
        'session', ?, ?, 'pending', ?, ?)
    `).run(JSON.stringify(ambiguousGraph), NOW, NOW, NOW);

    expect(() => runMigrations(db, migrationContext())).toThrow(
      'has ambiguous pre-existing configurationRevision',
    );
    expectSchema30Rollback(db);
    expect(db.prepare(`
      SELECT event_json FROM kernel_events WHERE id = 'event_ambiguous'
    `).get()).toEqual({ event_json: JSON.stringify(ambiguousGraph) });
  });

  it('rolls back schema 30 migration when existing foreign keys are invalid', () => {
    const db = schema30Fixture();
    db.pragma('foreign_keys = OFF');
    db.prepare(`
      INSERT INTO subtasks (
        id, task_id, title, goal, required_capabilities_json,
        preferred_agent_class_list_json, created_at, updated_at
      ) VALUES ('orphan', 'missing-task', 'Orphan', 'Goal', '[]', '[]', ?, ?)
    `).run(NOW, NOW);
    db.pragma('foreign_keys = ON');

    expect(() => runMigrations(db, migrationContext())).toThrow(
      'schema 30 to 31 migration cannot start with foreign key violations',
    );
    expectSchema30Rollback(db);
  });

  it('rejects schema versions older than the single supported upgrade', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (26);
    `);

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite schema (26); create a fresh database for schema 31',
    );
    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: 26 }]);
  });

  it('rejects a non-empty pre-release database that has no schema marker', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE legacy_marker (id TEXT PRIMARY KEY)');

    expect(() => runMigrations(db)).toThrow(
      'unsupported pre-release SQLite database without schema_version',
    );
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([{ name: 'legacy_marker' }]);
  });
});

const NOW = '2026-08-03T00:00:00.000Z';

function schema30Fixture(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.pragma('foreign_keys = OFF');
  const v31Tables = [
    'kernel_binding_status',
    'kernel_model_status',
    'kernel_provider_status',
    'configuration_revisions',
  ];
  for (const table of v31Tables) db.exec(`DROP TABLE ${table}`);
  restoreSchema30Table(db, 'work_units', `
    id, agent_class_name, agent_class_kind, state, claimed_task_id, claimed_subtask_id,
    heartbeat_at, lease_expires_at, created_at, updated_at, claimed_attempt_id
  `, `
    id TEXT PRIMARY KEY, agent_class_name TEXT NOT NULL, agent_class_kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'starting', claimed_task_id TEXT, claimed_subtask_id TEXT,
    heartbeat_at TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    claimed_attempt_id TEXT, FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
  `);
  restoreSchema30Table(db, 'kernel_executor_status', `
    agent_class_name, class_health, recent_attempts_json, recent_recovery_checks_json, updated_at
  `, `
    agent_class_name TEXT PRIMARY KEY, class_health TEXT NOT NULL DEFAULT 'unverified',
    recent_attempts_json TEXT NOT NULL DEFAULT '[]',
    recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL,
    FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
  `);
  restoreSchema30Table(db, 'subtasks', `
    id, task_id, title, goal, status, dependencies_json, context_refs_json,
    required_capabilities_json, executor_bindings_json, delivery_kind, acceptance_json,
    risk_level, result, artifacts_json, verification_json, error, created_at, updated_at,
    graph_revision, generation_id
  `, `
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created', dependencies_json TEXT NOT NULL DEFAULT '[]',
    context_refs_json TEXT NOT NULL DEFAULT '[]', required_capabilities_json TEXT NOT NULL,
    preferred_agent_class_list_json TEXT NOT NULL,
    delivery_kind TEXT NOT NULL DEFAULT 'report' CHECK(delivery_kind IN ('edit', 'report')),
    acceptance_json TEXT NOT NULL DEFAULT '[]', risk_level TEXT NOT NULL DEFAULT 'medium',
    result TEXT NOT NULL DEFAULT '', artifacts_json TEXT NOT NULL DEFAULT '[]',
    verification_json TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, graph_revision INTEGER, generation_id TEXT,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  `, 'executor_bindings_json', 'preferred_agent_class_list_json');
  for (const [table, columns] of Object.entries(V31_ADDED_COLUMNS)) {
    restoreWithoutColumns(db, table, columns);
  }
  db.exec('UPDATE schema_version SET version = 30');
  db.pragma('foreign_keys = ON');
  return db;
}

function seedSchema30Runtime(db: Database.Database): void {
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
      dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
      last_interruption_reason, interruption_count, created_at, updated_at
    ) VALUES ('task', 'Task', 'Goal', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO agent_classes (
      name, kind, created_at, updated_at
    ) VALUES ('codex-cli', 'executor', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO subtasks (
      id, task_id, title, goal, status, dependencies_json, context_refs_json,
      required_capabilities_json, preferred_agent_class_list_json, delivery_kind,
      acceptance_json, risk_level, created_at, updated_at, graph_revision, generation_id
    ) VALUES ('subtask', 'task', 'Subtask', 'Goal', 'ready', '[]', '[]',
      '["workspace-engineering"]', '["codex-cli"]', 'edit', '[]', 'low', ?, ?, 1, 'generation')
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO planner_runs (
      id, session_id, request_source, status, created_at
    ) VALUES ('planner-run', 'session', 'test', 'running', ?)
  `).run(NOW);
  db.prepare(`
    INSERT INTO work_graph_revisions (
      id, task_id, revision, generation_id, status, created_at, updated_at
    ) VALUES ('graph', 'task', 1, 'generation', 'active', ?, ?)
  `).run(NOW, NOW);
}

function v7Plan(): Record<string, unknown> {
  return {
    id: 'plan_v7',
    schemaVersion: 7,
    action: 'plan_work_graph',
    task: {},
    workGraph: {
      reason: 'test',
      subtasks: [{
        id: 'subtask',
        preferredAgentClassList: ['codex-cli'],
        deliveryKind: 'edit',
      }],
    },
  };
}

function migrationContext() {
  return createSchema30MigrationContext(migrationContextInput());
}

function migrationContextInput() {
  return {
    revisionId: 'import-revision-1',
    contentHash: 'sha256:imported-configuration',
    importedAt: NOW,
    plannerBinding: plannerBinding(),
    legacyAgentClassBindings: {
      'codex-cli': executorBinding(),
    },
  };
}

function plannerBinding() {
  return {
    agentClassRef: 'planner',
    harnessRef: 'anyfusion-planner',
    modelRef: 'planner-model',
    providerRef: 'openai',
    permissionProfileRef: null,
    bindingFingerprint: 'sha256:planner-binding',
  };
}

function executorBinding() {
  return {
    agentClassRef: 'codex-engineering',
    harnessRef: 'codex-cli',
    modelRef: 'engineering-model',
    providerRef: 'openai',
    permissionProfileRef: 'workspace-default',
    bindingFingerprint: 'sha256:codex-binding',
  };
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(column => column.name);
}

function countRows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function expectSchema31Contracts(db: Database.Database): void {
  const foreignKeys = [
    ['planner_tool_calls', 'planner_run_id', 'planner_runs', 'id'],
    ['kernel_decision_applications', 'decision_id', 'kernel_decisions', 'id'],
    ['kernel_decision_applications', 'event_id', 'kernel_events', 'id'],
    ['kernel_effect_outbox', 'decision_id', 'kernel_decisions', 'id'],
    ['permission_grants', 'decision_id', 'kernel_decisions', 'id'],
    ['work_graph_revisions', 'authorized_decision_id', 'kernel_decisions', 'id'],
  ] as const;
  for (const [table, from, target, to] of foreignKeys) {
    expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all(), `${table}.${from}`)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ from, table: target, to }),
      ]));
  }

  const strictColumns = [
    ['planner_runs', 'configuration_revision'],
    ['planner_runs', 'planner_binding_json'],
    ['planner_runs', 'planner_binding_fingerprint'],
    ['executor_attempt_receipts', 'configuration_revision'],
    ['executor_attempt_receipts', 'authorized_binding_json'],
    ['executor_attempt_receipts', 'binding_fingerprint'],
    ['kernel_decisions', 'configuration_revision'],
    ['kernel_events', 'configuration_revision'],
    ['work_graph_revisions', 'configuration_revision'],
    ['kernel_dispatch_items', 'configuration_revision'],
    ['kernel_dispatch_items', 'authorized_binding_json'],
    ['kernel_dispatch_items', 'binding_fingerprint'],
    ['generation_replan_requests', 'configuration_revision'],
  ] as const;
  for (const [table, name] of strictColumns) {
    const column = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find(item => item.name === name);
    expect(column, `${table}.${name}`).toMatchObject({
      name,
      notnull: 1,
      dflt_value: null,
    });
  }

  const schemaObjects = [
    ['index', 'idx_planner_runs_revision'],
    ['index', 'idx_executor_attempt_receipts_binding'],
    ['index', 'idx_kernel_decisions_revision'],
    ['index', 'idx_kernel_events_revision'],
    ['index', 'idx_work_graph_revisions_revision'],
    ['index', 'idx_kernel_dispatch_items_binding'],
    ['index', 'idx_generation_replan_requests_revision'],
    ['index', 'idx_kernel_executor_status_revision'],
    ['index', 'idx_kernel_provider_status_revision'],
    ['index', 'idx_kernel_model_status_revision'],
    ['index', 'idx_kernel_binding_status_revision'],
    ['trigger', 'configuration_revisions_immutable_update'],
    ['trigger', 'configuration_revisions_immutable_delete'],
    ['trigger', 'executor_attempt_receipts_immutable_update'],
    ['trigger', 'executor_attempt_receipts_immutable_delete'],
  ] as const;
  for (const [type, name] of schemaObjects) {
    expect(db.prepare(`
      SELECT type, name FROM sqlite_master WHERE type = ? AND name = ?
    `).get(type, name), name).toEqual({ type, name });
  }
}

function expectSchema30Rollback(db: Database.Database): void {
  expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 30 });
  expect(columns(db, 'subtasks')).toContain('preferred_agent_class_list_json');
  expect(columns(db, 'subtasks')).not.toContain('executor_bindings_json');
  expect(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'configuration_revisions'
  `).get()).toBeUndefined();
}

const V31_ADDED_COLUMNS: Record<string, string[]> = {
  planner_runs: [
    'configuration_revision',
    'planner_binding_json',
    'planner_binding_fingerprint',
  ],
  executor_attempt_receipts: [
    'configuration_revision',
    'authorized_binding_json',
    'binding_fingerprint',
  ],
  kernel_decisions: [
    'configuration_revision',
    'authorized_bindings_json',
    'binding_fingerprints_json',
  ],
  kernel_events: ['configuration_revision'],
  work_graph_revisions: ['configuration_revision'],
  kernel_dispatch_items: [
    'configuration_revision',
    'authorized_binding_json',
    'binding_fingerprint',
  ],
  generation_replan_requests: [
    'configuration_revision',
    'deferred_bindings_json',
  ],
};

function restoreWithoutColumns(
  db: Database.Database,
  table: string,
  removedColumns: string[],
): void {
  const tableInfo = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  const retained = tableInfo.filter(column => !removedColumns.includes(column.name));
  const columnNames = retained.map(column => `"${column.name}"`).join(', ');
  const definitions = retained.map(column => {
    const parts = [`"${column.name}"`, column.type];
    if (column.pk) parts.push('PRIMARY KEY');
    if (column.notnull) parts.push('NOT NULL');
    if (column.dflt_value !== null) parts.push(`DEFAULT ${column.dflt_value}`);
    return parts.join(' ');
  }).join(', ');
  restoreSchema30Table(db, table, columnNames, definitions);
}

function restoreSchema30Table(
  db: Database.Database,
  table: string,
  selectedColumns: string,
  definitions: string,
  sourceColumn?: string,
  targetColumn?: string,
): void {
  const temporary = `${table}_schema30`;
  db.exec(`CREATE TABLE ${temporary} (${definitions})`);
  const targetColumns = targetColumn
    ? selectedColumns.replace(sourceColumn!, targetColumn)
    : selectedColumns;
  db.exec(`
    INSERT INTO ${temporary} (${targetColumns})
    SELECT ${selectedColumns} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${temporary} RENAME TO ${table};
  `);
}

function readJson(
  db: Database.Database,
  sql: string,
  id: string,
): unknown {
  const row = db.prepare(sql).get(id) as Record<string, string>;
  return JSON.parse(Object.values(row)[0]!) as unknown;
}
