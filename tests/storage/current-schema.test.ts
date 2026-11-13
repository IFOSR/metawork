import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, initializeDatabaseSchema } from '../../src/storage/schema.js';
const NOW = '2026-11-10T00:00:00.000Z';
function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
}
describe('fresh SQLite schema', () => {
  it('creates the current schema with durable Conversation slots and image artifacts', () => {
    const db = new Database(':memory:');

    initializeDatabaseSchema(db);
    expect(() => initializeDatabaseSchema(db)).not.toThrow();

    expect(db.prepare('SELECT version FROM schema_version').all())
      .toEqual([{ version: CURRENT_SCHEMA_VERSION }]);
    for (const table of [
      'tasks',
      'subtasks',
      'configuration_revisions',
      'work_graph_revisions',
      'effect_outbox',
      'dispatch_items',
      'executor_attempt_receipts',
      'resource_leases',
      'resource_waits',
      'workspace_records',
      'workspace_publications',
      'workspace_merge_attempts',
      'generation_replan_requests',
      'executor_status',
      'provider_status',
      'model_status',
      'binding_status',
      'planner_proposal_turns',
      'planner_proposal_submissions',
      'planner_turn_inputs',
      'result_objects',
      'result_references',
      'conversation_task_slots',
      'task_schedule_entries',
      'query_usage_contexts',
      'query_task_links',
      'execution_usage_contexts',
      'metering_spans',
      'usage_observations',
      'usage_normalization_issues',
      'gateway_command_admissions',
      'gateway_command_admission_imports',
      'retry_wakes',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all(), table).not.toEqual([]);
    }
    for (const removed of [
      'billing_price_versions',
      'cost_entries',
      'query_bills',
      'query_bill_lines',
      'consumption_outbox',
      'consumption_receipts',
      'bill_adjustments',
      'billing_source_instance',

      'planning_decisions_legacy_audit',
      'subtasks_v2_audit',
      'subtasks_v3_audit',
      'worktree_leases_legacy_audit',
      'executor_profiles',
    ]) {
      expect(db.prepare(`PRAGMA table_info(${removed})`).all(), removed).toEqual([]);
    }
    expect(columns(db, 'subtasks')).toContain('executor_bindings_json');
    expect(columns(db, 'tasks')).toEqual(expect.arrayContaining([
      'account_id',
      'conversation_id',
      'workspace_id',
      'owner_planner_session_id',
      'admitted_at',
    ]));
    expect(columns(db, 'conversation_task_slots')).toEqual(expect.arrayContaining([
      'conversation_id',
      'active_task_id',
      'state',
      'reservation_id',
      'fairness_sequence',
    ]));
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
    expect(columns(db, 'planner_proposal_submissions')).toContain('configuration_revision');
    expect(columns(db, 'executor_attempt_receipts')).toEqual(expect.arrayContaining([
      'configuration_revision',
      'authorized_binding_json',
      'binding_fingerprint',
    ]));
    expect(columns(db, 'dispatch_items')).toEqual(expect.arrayContaining([
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
    expect((db.prepare('PRAGMA table_info(executor_status)').all() as Array<{ name: string }>)
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
    expect(columns(db, 'task_artifacts')).toEqual(expect.arrayContaining([
      'artifact_id',
      'account_id',
      'task_id',
      'generation_id',
      'subtask_id',
      'publication_id',
      'display_name',
      'relative_path',
      'published_path',
      'media_type',
      'preview_kind',
      'content_hash',
      'byte_length',
      'status',
      'created_at',
      'updated_at',
    ]));
    expect(db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_artifacts'
    `).get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("'image'"),
    }));
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN ('idx_task_artifacts_task', 'idx_task_artifacts_publication')
      ORDER BY name
    `).all()).toEqual([
      { name: 'idx_task_artifacts_publication' },
      { name: 'idx_task_artifacts_task' },
    ]);
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
    expect(db.prepare('PRAGMA foreign_key_list(executor_status)').all())
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
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
