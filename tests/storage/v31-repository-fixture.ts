import Database from 'better-sqlite3';

export function createV31RepositoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE work_units (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE configuration_revisions (
      revision_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      graph_revision INTEGER NOT NULL,
      generation_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      context_refs_json TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      executor_bindings_json TEXT NOT NULL,
      delivery_kind TEXT NOT NULL,
      acceptance_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      result TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE planner_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_source TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_summary TEXT,
      configuration_revision TEXT NOT NULL,
      planner_binding_json TEXT NOT NULL,
      planner_binding_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE planner_tool_calls (
      id TEXT PRIMARY KEY,
      planner_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      arguments_summary_json TEXT NOT NULL,
      result_summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE kernel_decisions (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      session_id TEXT NOT NULL,
      task_id TEXT,
      subtask_id TEXT,
      attempt_id TEXT,
      event_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      authorized_bindings_json TEXT NOT NULL,
      binding_fingerprints_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE kernel_events (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      causation_id TEXT,
      session_id TEXT NOT NULL,
      task_id TEXT,
      subtask_id TEXT,
      attempt_id TEXT,
      event_json TEXT NOT NULL,
      available_at TEXT NOT NULL,
      status TEXT NOT NULL,
      processing_started_at TEXT,
      processed_at TEXT,
      last_error TEXT,
      configuration_revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_graph_revisions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      generation_id TEXT NOT NULL,
      authorized_decision_id TEXT,
      proposal_source TEXT NOT NULL,
      automatic_replan INTEGER NOT NULL,
      status TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      completion_kind TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, revision)
    );
    CREATE TABLE kernel_dispatch_items (
      attempt_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      batch_order INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      agent_class_name TEXT NOT NULL,
      attempt_kind TEXT NOT NULL,
      source_attempt_id TEXT,
      recovery_mode TEXT NOT NULL,
      attempt_payload_json TEXT NOT NULL,
      resource_grant_json TEXT NOT NULL,
      status TEXT NOT NULL,
      work_unit_id TEXT,
      sandbox_container_id TEXT,
      launch_started_at TEXT,
      terminal_at TEXT,
      cancellation_decision_id TEXT,
      cancel_requested_at TEXT,
      cancelled_at TEXT,
      error_summary TEXT,
      configuration_revision TEXT NOT NULL,
      authorized_binding_json TEXT NOT NULL,
      binding_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE executor_attempt_receipts (
      attempt_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      graph_revision INTEGER NOT NULL,
      generation_id TEXT NOT NULL,
      attempt_kind TEXT NOT NULL,
      source_attempt_id TEXT,
      failure_json TEXT,
      recovery_mode TEXT NOT NULL,
      work_unit_id TEXT NOT NULL,
      agent_class_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      terminal_state TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      completion_schema_version INTEGER,
      parsing_json TEXT NOT NULL,
      verification_json TEXT NOT NULL,
      error_code TEXT,
      error_detail TEXT,
      configuration_revision TEXT NOT NULL,
      authorized_binding_json TEXT NOT NULL,
      binding_fingerprint TEXT NOT NULL
    );
    CREATE TABLE generation_replan_requests (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      trigger_decision_id TEXT NOT NULL,
      quiescence_token TEXT,
      error_summary TEXT,
      deferred_plan_json TEXT,
      availability_explanation TEXT,
      configuration_revision TEXT NOT NULL,
      deferred_bindings_json TEXT NOT NULL,
      planning_started_at TEXT,
      submitted_at TEXT,
      resolved_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, generation_id, source_revision)
    );
    CREATE TABLE kernel_executor_status (
      agent_class_name TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      class_health TEXT NOT NULL,
      recent_attempts_json TEXT NOT NULL,
      recent_recovery_checks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_class_name, configuration_revision)
    );
    CREATE TABLE kernel_provider_status (
      provider_ref TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      provider_health TEXT NOT NULL,
      recent_recovery_checks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(provider_ref, configuration_revision)
    );
    CREATE TABLE kernel_model_status (
      provider_ref TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      model_health TEXT NOT NULL,
      recent_recovery_checks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(provider_ref, model_ref, configuration_revision)
    );
    CREATE TABLE kernel_binding_status (
      binding_fingerprint TEXT PRIMARY KEY,
      configuration_revision TEXT NOT NULL,
      agent_class_ref TEXT NOT NULL,
      harness_ref TEXT NOT NULL,
      provider_ref TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      permission_profile_ref TEXT NOT NULL,
      binding_health TEXT NOT NULL,
      recent_attempts_json TEXT NOT NULL,
      recent_recovery_checks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO configuration_revisions
      (revision_id, content_hash, source_kind, imported_at)
    VALUES (?, 'sha256:config', 'native', ?)
  `).run(REVISION, NOW);
  db.prepare(`INSERT INTO tasks (id, status) VALUES ('task_1', 'running')`).run();
  db.prepare(`INSERT INTO work_units (id) VALUES ('work_unit_1')`).run();
  return db;
}

export const NOW = '2026-08-12T00:00:00.000Z';
export const REVISION = 'revision_31';
