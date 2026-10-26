import { publicTaskRelativeDirectory } from '../task/public-task-directory.js';
import type Database from 'better-sqlite3';
import { BILLING_SCHEMA_VERSION, createBillingSchema } from './billing-schema.js';
import { installObservationSchema } from './observation-schema.js';

export const CURRENT_SCHEMA_VERSION = 59;

/**
 * Local memory index (design §4.2).
 *
 * The account is the only isolation boundary. Bodies live in the memory engine;
 * this table keeps only ownership, the user switch and a content digest, so the
 * engine can be discarded and rebuilt without losing the user's choices.
 */
const MEMORY_BINDINGS_SQL = `
  CREATE TABLE IF NOT EXISTS memory_bindings (
    memory_id       TEXT PRIMARY KEY,
    tdai_memory_id  TEXT NOT NULL,
    account_id      TEXT NOT NULL,
    workspace_id    TEXT,
    source          TEXT NOT NULL DEFAULT 'conversation',
    enabled         INTEGER NOT NULL DEFAULT 1,
    confidence      REAL,
    content_digest  TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_bindings_account
    ON memory_bindings(account_id, enabled);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_bindings_tdai
    ON memory_bindings(tdai_memory_id);
  CREATE TABLE IF NOT EXISTS memory_recall_candidates (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    type TEXT NOT NULL, preview TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id, memory_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_recall_conversation
    ON memory_recall_candidates(account_id, conversation_id, score DESC);
`;

/**
 * Memory deposition state (schema 53).
 *
 * `memory_flush_state` replaces the earlier reuse of
 * `conversation_history_streams(kind='memory')`, because the deposition needs
 * more than a cursor: it also records whether the deposited segment was
 * sanitized (design §8.2 `source='sanitized'`).
 *
 * `memory_recall_state` records whether the last recall for a conversation was
 * served by a healthy engine, so that the Planner can distinguish "no matching
 * memory" from "the memory engine is unavailable" (design §6.1, §6.6).
 */
const MEMORY_STATE_SQL = `
  CREATE TABLE IF NOT EXISTS memory_flush_state (
    account_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    last_sequence   INTEGER NOT NULL DEFAULT 0,
    sanitized       INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_flush_state_sequence
    ON memory_flush_state(account_id, last_sequence);
  CREATE TABLE IF NOT EXISTS memory_recall_state (
    account_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    degraded        INTEGER NOT NULL DEFAULT 0,
    reason          TEXT,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS memory_runtime_state (
    account_id TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,
    detail     TEXT,
    updated_at TEXT NOT NULL
  );
`;

const MANAGED_SERVICES_SQL = `
  CREATE TABLE IF NOT EXISTS public_workspace_files (
    account_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), relative_path TEXT NOT NULL,
    generation_id TEXT, subtask_id TEXT, publication_id TEXT, published_path TEXT NOT NULL,
    content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, task_id, relative_path)
  );
  CREATE TABLE IF NOT EXISTS managed_local_services (
    service_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL DEFAULT '',
    task_id TEXT NOT NULL REFERENCES tasks(id),
    specification_revision TEXT NOT NULL DEFAULT '',
    specification_json TEXT NOT NULL,
    state TEXT NOT NULL,
    process_id INTEGER,
    process_token TEXT,
    health_message TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, workspace_id, service_id)
  );
  CREATE INDEX IF NOT EXISTS managed_services_task ON managed_local_services(account_id, task_id);
  CREATE TABLE IF NOT EXISTS managed_local_service_effects (
    account_id TEXT NOT NULL, decision_id TEXT NOT NULL, effect_json TEXT NOT NULL,
    PRIMARY KEY (account_id, decision_id)
  );
`;

const WORKSPACE_EXECUTION_SQL = `
  CREATE TABLE IF NOT EXISTS workspace_execution_bindings (
    task_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    canonical_path TEXT NOT NULL,
    execution_mode TEXT NOT NULL CHECK (execution_mode = 'in_place'),
    authorized_working_directory TEXT NOT NULL,
    mode_source TEXT NOT NULL DEFAULT '',
    delivery_policy TEXT NOT NULL DEFAULT '',
    workspace_intent_json TEXT,
    targeted_paths_json TEXT NOT NULL DEFAULT '[]',
    cleaned_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, generation_id)
  );
`;

const WORKSPACE_CHANGE_RECORD_SQL = `
  CREATE TABLE IF NOT EXISTS workspace_change_records (
    record_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    generation_id TEXT,
    subtask_id TEXT,
    attempt_id TEXT,
    conversation_id TEXT,
    workspace_id TEXT NOT NULL,
    user_turn_id TEXT,
    before_tree TEXT,
    after_tree TEXT,
    files_json TEXT NOT NULL,
    total_files INTEGER NOT NULL,
    added_lines INTEGER NOT NULL,
    deleted_lines INTEGER NOT NULL,
    coverage TEXT NOT NULL CHECK (coverage IN ('complete', 'partial', 'unavailable')),
    missing_reasons_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_change_records_task
    ON workspace_change_records(task_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_workspace_change_records_attempt
    ON workspace_change_records(attempt_id, created_at);
`;

const ARTIFACT_VERSION_SQL = `
  CREATE TABLE IF NOT EXISTS artifact_versions (
    artifact_version_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    source_task_id TEXT,
    source_attempt_id TEXT,
    relative_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    object_uri TEXT NOT NULL,
    media_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, relative_path, content_hash)
  );
`;

const PUBLICATION_DELIVERY_SQL = `
  CREATE TABLE IF NOT EXISTS workspace_publication_deliveries (
    publication_id TEXT PRIMARY KEY REFERENCES workspace_publications(id),
    status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'succeeded')),
    projections_json TEXT NOT NULL DEFAULT '[]',
    failures_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workspace_publication_delivery_status ON workspace_publication_deliveries(status, publication_id);
`;

const TASK_EXECUTION_EVIDENCE_COLUMNS = `
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  exact_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
`;

const GATEWAY_COMMAND_ADMISSION_SQL = `
  CREATE TABLE IF NOT EXISTS gateway_command_admissions (
    account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (account_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS gateway_command_admissions_recoverable
    ON gateway_command_admissions (account_id, idempotency_key)
    WHERE state != 'terminal';
  CREATE TABLE IF NOT EXISTS gateway_command_admission_imports (
    account_id TEXT PRIMARY KEY
  );
`;

const RETRY_WAKE_SQL = `
  CREATE TABLE IF NOT EXISTS retry_wakes (
    wake_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    source_decision_id TEXT NOT NULL UNIQUE,
    source_attempt_id TEXT NOT NULL,
    configuration_revision TEXT NOT NULL,
    binding_fingerprint TEXT NOT NULL,
    authorized_binding_json TEXT NOT NULL,
    resume_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('armed', 'fired', 'consumed', 'superseded', 'recovery_required')),
    timer_event_id TEXT UNIQUE,
    consumed_decision_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS retry_wakes_due
    ON retry_wakes (status, resume_at, wake_id);
  CREATE INDEX IF NOT EXISTS retry_wakes_task
    ON retry_wakes (task_id, generation_id, status);
  CREATE INDEX IF NOT EXISTS retry_wakes_decision
    ON retry_wakes (source_decision_id);
`;

const NAVIGATION_PROJECTION_SQL = `
  CREATE TABLE IF NOT EXISTS conversation_metadata_projection (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS gateway_journal_streams (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, last_sequence INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL, replay_floor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS gateway_journal_segments (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, segment_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, segment_id)
  );
  CREATE INDEX IF NOT EXISTS gateway_journal_segment_range ON gateway_journal_segments
    (account_id, conversation_id, last_sequence);
  CREATE TABLE IF NOT EXISTS gateway_journal_event_index (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, segment_id TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS gateway_journal_event_segment ON gateway_journal_event_index
    (account_id, conversation_id, segment_id);
  CREATE TABLE IF NOT EXISTS gateway_turn_task_observations (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id, turn_id)
  );
  CREATE TABLE IF NOT EXISTS conversation_history_streams (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
    last_sequence INTEGER NOT NULL, revision TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, conversation_id, kind)
  );
  CREATE TABLE IF NOT EXISTS conversation_history_turns (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
    sequence INTEGER NOT NULL, turn_id TEXT NOT NULL, body_json TEXT NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, kind, sequence),
    UNIQUE (account_id, conversation_id, kind, turn_id)
  );
  CREATE TRIGGER IF NOT EXISTS conversation_history_insert_revision
  AFTER INSERT ON conversation_history_turns BEGIN
    UPDATE conversation_history_streams SET revision = lower(hex(randomblob(16)))
    WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND kind = NEW.kind;
  END;
  CREATE TRIGGER IF NOT EXISTS conversation_history_update_revision
  AFTER UPDATE ON conversation_history_turns BEGIN
    UPDATE conversation_history_streams SET revision = lower(hex(randomblob(16)))
    WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND kind = NEW.kind;
  END;
  CREATE TRIGGER IF NOT EXISTS conversation_history_delete_revision
  AFTER DELETE ON conversation_history_turns BEGIN
    UPDATE conversation_history_streams SET revision = lower(hex(randomblob(16)))
    WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND kind = OLD.kind;
  END;
  CREATE TABLE IF NOT EXISTS workspace_directory_projection (
    account_id TEXT NOT NULL, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    archived INTEGER NOT NULL, activity_rank INTEGER NOT NULL, updated_at TEXT NOT NULL,
    latest_task_created_at TEXT NOT NULL,
    title_search TEXT NOT NULL, summary_json TEXT NOT NULL, projection_version INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE INDEX IF NOT EXISTS workspace_directory_page ON workspace_directory_projection
    (account_id, workspace_id, archived, latest_task_created_at DESC, conversation_id ASC);
  CREATE INDEX IF NOT EXISTS workspace_directory_all_page ON workspace_directory_projection
    (account_id, workspace_id, latest_task_created_at DESC, conversation_id ASC);
  CREATE TABLE IF NOT EXISTS workspace_directory_revisions (
    account_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (account_id, workspace_id)
  );
  CREATE TABLE IF NOT EXISTS workspace_directory_rebuilds (
    account_id TEXT PRIMARY KEY, projection_version INTEGER NOT NULL, status TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL, checkpoint TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_directory_rebuild_candidates (
    account_id TEXT NOT NULL, rebuild_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    PRIMARY KEY (account_id, rebuild_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS workspace_directory_observations (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, rebuild_id TEXT NOT NULL,
    removed INTEGER NOT NULL CHECK (removed IN (0, 1)),
    PRIMARY KEY (account_id, conversation_id)
  );
  CREATE TABLE IF NOT EXISTS workspace_directory_dirty (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );
`;

function installDirectoryInvalidationTriggers(db: Database.Database): void {
  // These triggers record changed identities only. Canonical application
  // projectors, not SQL, interpret the Task lifecycle and activity.
  if (!tableExists(db, 'tasks')) return;
  for (const table of [
    'tasks',
    'kernel_dispatch_items',
    'generation_replan_requests',
    'attempt_sandboxes',
    'kernel_decisions',
    'conversation_task_slots',
    'task_schedule_entries',
  ]) {
    if (!tableExists(db, table)) continue;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const reference = operation === 'DELETE' ? 'OLD' : 'NEW';
      const select = table === 'tasks'
        ? `SELECT ${reference}.account_id, ${reference}.conversation_id, 1 WHERE ${reference}.conversation_id IS NOT NULL`
        : `SELECT account_id, conversation_id, 1 FROM tasks WHERE id = ${reference}.${
          table === 'conversation_task_slots' ? 'active_task_id' : 'task_id'
        }`;
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS directory_dirty_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table}
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          ${select}
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;
      `);
    }
  }
}

const TASK_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_state_changes (
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  operation_key TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL CHECK (to_status IN (
    'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled'
  )),
  detail_json TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, version),
  UNIQUE (task_id, operation_key),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS task_state_changes_task_created
  ON task_state_changes(task_id, created_at, version);
CREATE INDEX IF NOT EXISTS task_state_changes_decision
  ON task_state_changes(decision_id);

CREATE TABLE IF NOT EXISTS task_operation_results (
  task_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'execution', 'integration', 'delivery', 'safety_report', 'service'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'definite_failure', 'unknown')),
  reason_code TEXT,
  message TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, operation_key),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS task_operation_results_task
  ON task_operation_results(task_id, updated_at);

CREATE TABLE IF NOT EXISTS task_state_projection_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  state_version INTEGER NOT NULL CHECK (state_version > 0),
  status TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT
);
CREATE INDEX IF NOT EXISTS task_state_projection_outbox_pending
  ON task_state_projection_outbox(sequence) WHERE dispatched_at IS NULL;
`;

const CURRENT_SCHEMA_SQL = `
CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT,
          status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
            'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled'
          )),
          state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
          state_detail_json TEXT NOT NULL DEFAULT '{}',
          completed_at TEXT,
          archived_at TEXT,
          retry_of_task_id TEXT,
          summary TEXT DEFAULT '',
          snapshot_json TEXT DEFAULT '[]',
          resources_json TEXT DEFAULT '[]',
          dependencies_json TEXT DEFAULT '[]',
          priority_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , last_scheduling_reason TEXT DEFAULT '', last_interruption_reason TEXT DEFAULT '', interruption_count INTEGER DEFAULT 0, artifacts_json TEXT DEFAULT '[]',
          account_id TEXT NOT NULL DEFAULT 'legacy-account',
          conversation_id TEXT NOT NULL DEFAULT 'legacy-conversation',
          workspace_id TEXT NOT NULL DEFAULT 'legacy-workspace',
          owner_planner_session_id TEXT NOT NULL DEFAULT 'legacy-planner-session',
          admitted_at TEXT NOT NULL DEFAULT '',
          -- A completion time only exists for a terminal Task. The other
          -- direction (terminal => completed_at) is guaranteed by the single
          -- state entry, which always stamps it on a terminal transition.
          CHECK (completed_at IS NULL
            OR status IN ('succeeded', 'failed', 'cancelled')));

${TASK_STATE_SCHEMA_SQL}

CREATE TABLE interactions (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          user_input TEXT,
          system_output TEXT,
          executor_used TEXT,
          created_at TEXT NOT NULL
        , session_id TEXT);

CREATE TABLE session_state (
        id TEXT PRIMARY KEY,
        last_focused_task_id TEXT,
        last_completed_task_id TEXT,
        last_session_id TEXT,
        updated_at TEXT NOT NULL
      );

CREATE TABLE executor_skill_usage_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        executor_name TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_version TEXT,
        event_type TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

CREATE TABLE executor_skill_install_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        package_id TEXT,
        executor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

CREATE TABLE task_memory_cards (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        key_decisions_json TEXT NOT NULL DEFAULT '[]',
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        verification_commands_json TEXT NOT NULL DEFAULT '[]',
        pitfalls_json TEXT NOT NULL DEFAULT '[]',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT 'success',
        source_candidate_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE skill_effect_summaries (
        id TEXT PRIMARY KEY,
        executor_name TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        skill_version TEXT,
        skill_version_key TEXT GENERATED ALWAYS AS (COALESCE(skill_version, '')) STORED,
        used_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        helpful_count INTEGER NOT NULL DEFAULT 0,
        patch_candidate_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL,
        last_failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(executor_name, skill_name, skill_version_key)
      );

CREATE TABLE executor_route_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        user_input TEXT NOT NULL,
        selected_executor TEXT NOT NULL,
        action TEXT NOT NULL,
        candidates_json TEXT NOT NULL DEFAULT '[]',
        primary_intent TEXT NOT NULL DEFAULT 'general',
        matched_boundary_json TEXT NOT NULL DEFAULT '[]',
        rejected_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        confirmed_by_user INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        created_at TEXT NOT NULL
      );

CREATE VIRTUAL TABLE task_search_index USING fts5(
        task_id UNINDEXED,
        source_kind UNINDEXED,
        source_id UNINDEXED,
        title,
        body,
        tags,
        created_at UNINDEXED,
        updated_at UNINDEXED,
        tokenize = 'trigram'
      );

CREATE TABLE agent_classes (
          name TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'executor',
          domains_json TEXT NOT NULL DEFAULT '[]',
          capabilities_json TEXT NOT NULL DEFAULT '[]',
          input_types_json TEXT NOT NULL DEFAULT '[]',
          output_types_json TEXT NOT NULL DEFAULT '[]',
          strengths_json TEXT NOT NULL DEFAULT '[]',
          weaknesses_json TEXT NOT NULL DEFAULT '[]',
          primary_use_cases_json TEXT NOT NULL DEFAULT '[]',
          avoid_use_cases_json TEXT NOT NULL DEFAULT '[]',
          intent_affinity_json TEXT NOT NULL DEFAULT '{}',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          availability TEXT NOT NULL DEFAULT 'available',
          harness TEXT,
          model TEXT,
          skills_json TEXT NOT NULL DEFAULT '[]',
          mcp_servers_json TEXT NOT NULL DEFAULT '[]',
          plugins_json TEXT NOT NULL DEFAULT '[]',
          runtime_command TEXT,
          runtime_args_json TEXT NOT NULL DEFAULT '[]',
          runtime_check_command TEXT,
          project_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , execution_image_ref TEXT, resolved_image_id TEXT, permission_profile_id TEXT);

CREATE TABLE configuration_revisions (
          revision_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          source_kind TEXT NOT NULL CHECK(source_kind IN ('native', 'rollback', 'schema-30-import')),
          imported_at TEXT NOT NULL
        );

CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          subtask_id TEXT,
          event_type TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE TABLE work_units (
          id TEXT PRIMARY KEY,
          agent_class_name TEXT NOT NULL,
          agent_class_kind TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'starting',
          claimed_task_id TEXT,
          claimed_subtask_id TEXT,
          heartbeat_at TEXT,
          lease_expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, claimed_attempt_id TEXT
        );

CREATE TABLE work_unit_events (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          task_id TEXT,
          subtask_id TEXT,
          event_type TEXT NOT NULL,
          state TEXT,
          message TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL, attempt_id TEXT,
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
        );

CREATE TABLE planner_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_source TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        configuration_revision TEXT NOT NULL,
        planner_binding_json TEXT NOT NULL,
        planner_binding_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE planner_proposal_turns (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        user_input TEXT NOT NULL,
        accepted_submission_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id)
      );

CREATE TABLE planner_proposal_submissions (
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        plan_fingerprint TEXT NOT NULL,
        plan_id TEXT,
        event_id TEXT,
        configuration_revision TEXT
          REFERENCES configuration_revisions(revision_id),
        status TEXT NOT NULL CHECK (status IN ('submitting', 'uncertain', 'accepted', 'rejected')),
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, turn_id, submission_id),
        UNIQUE (event_id),
        FOREIGN KEY (session_id, turn_id)
          REFERENCES planner_proposal_turns(session_id, turn_id) ON DELETE CASCADE
      );
CREATE INDEX idx_planner_proposal_submissions_turn
  ON planner_proposal_submissions(session_id, turn_id, created_at);

CREATE TABLE planner_turn_inputs (
        conversation_id TEXT PRIMARY KEY,
        user_input_hash TEXT NOT NULL,
        attachment_views_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

CREATE TABLE planner_tool_calls (
        id TEXT PRIMARY KEY,
        planner_run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        arguments_summary_json TEXT NOT NULL DEFAULT '{}',
        result_summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (planner_run_id) REFERENCES planner_runs(id)
      );

CREATE TABLE kernel_executor_status (
        agent_class_name TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        class_health TEXT NOT NULL DEFAULT 'unverified',
        recent_attempts_json TEXT NOT NULL DEFAULT '[]',
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_class_name, configuration_revision),
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE kernel_provider_status (
        provider_ref TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        provider_health TEXT NOT NULL DEFAULT 'unverified'
          CHECK(provider_health IN ('unverified', 'healthy', 'error', 'disabled')),
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider_ref, configuration_revision),
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE kernel_model_status (
        provider_ref TEXT NOT NULL,
        model_ref TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        model_health TEXT NOT NULL DEFAULT 'unverified'
          CHECK(model_health IN ('unverified', 'healthy', 'error', 'disabled')),
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider_ref, model_ref, configuration_revision),
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE kernel_binding_status (
        binding_fingerprint TEXT PRIMARY KEY,
        configuration_revision TEXT NOT NULL,
        agent_class_ref TEXT NOT NULL,
        harness_ref TEXT NOT NULL,
        provider_ref TEXT NOT NULL,
        model_ref TEXT NOT NULL,
        permission_profile_ref TEXT NOT NULL,
        binding_health TEXT NOT NULL DEFAULT 'unverified'
          CHECK(binding_health IN ('unverified', 'healthy', 'error', 'disabled')),
        recent_attempts_json TEXT NOT NULL DEFAULT '[]',
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          context_refs_json TEXT NOT NULL DEFAULT '[]',
          required_capabilities_json TEXT NOT NULL,
          executor_bindings_json TEXT NOT NULL,
          delivery_kind TEXT NOT NULL DEFAULT 'report' CHECK(delivery_kind IN ('edit', 'report')),
          file_outputs_json TEXT,
          acceptance_json TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          result TEXT NOT NULL DEFAULT '',
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          verification_json TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, graph_revision INTEGER, generation_id TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE TABLE subtask_handoffs (
          task_id TEXT NOT NULL,
          from_subtask_id TEXT NOT NULL,
          to_subtask_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          items_json TEXT NOT NULL,
          completion_schema_version INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, from_subtask_id, to_subtask_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (from_subtask_id) REFERENCES subtasks(id),
          FOREIGN KEY (to_subtask_id) REFERENCES subtasks(id)
        );

CREATE TABLE executor_attempt_receipts (
          attempt_id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          subtask_id TEXT NOT NULL,
          work_unit_id TEXT NOT NULL,
          agent_class_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NOT NULL,
          terminal_state TEXT NOT NULL,
          raw_response TEXT NOT NULL,
          completion_schema_version INTEGER,
          parsing_json TEXT NOT NULL DEFAULT '{}',
          verification_json TEXT NOT NULL DEFAULT '{}',
          error_code TEXT,
          error_detail TEXT, graph_revision INTEGER, generation_id TEXT, attempt_kind TEXT NOT NULL DEFAULT 'primary', source_attempt_id TEXT, failure_json TEXT, recovery_mode TEXT NOT NULL DEFAULT 'fresh',
          configuration_revision TEXT NOT NULL,
          authorized_binding_json TEXT NOT NULL,
          binding_fingerprint TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id),
          FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
        );

CREATE TABLE result_objects (
          result_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          generation_id TEXT NOT NULL,
          source_subtask_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('raw_attempt_output', 'business_result', 'safe_projection')),
          content_hash TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          media_type TEXT NOT NULL,
          storage_uri TEXT NOT NULL,
          completeness TEXT NOT NULL CHECK(completeness IN ('complete', 'partial', 'incomplete')),
          retention_class TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (source_subtask_id) REFERENCES subtasks(id)
        );

CREATE TABLE result_references (
          reference_id TEXT PRIMARY KEY,
          result_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          generation_id TEXT NOT NULL,
          source_subtask_id TEXT NOT NULL,
          target_subtask_id TEXT NOT NULL,
          edge_key TEXT NOT NULL,
          required_items_json TEXT NOT NULL DEFAULT '[]',
          read_scope_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (result_id) REFERENCES result_objects(result_id),
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (source_subtask_id) REFERENCES subtasks(id),
          FOREIGN KEY (target_subtask_id) REFERENCES subtasks(id),
          UNIQUE(result_id, source_subtask_id, target_subtask_id, edge_key)
        );

CREATE INDEX idx_result_objects_attempt
          ON result_objects(account_id, task_id, attempt_id, created_at);
CREATE INDEX idx_result_objects_task
          ON result_objects(account_id, task_id, generation_id, created_at);
CREATE INDEX idx_result_references_target
          ON result_references(account_id, task_id, target_subtask_id, created_at);

CREATE TABLE task_execution_evidence (
          ${TASK_EXECUTION_EVIDENCE_COLUMNS}
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
          authorized_bindings_json TEXT NOT NULL DEFAULT '[]',
          binding_fingerprints_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
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
            status TEXT NOT NULL DEFAULT 'pending',
            processing_started_at TEXT,
            processed_at TEXT,
            last_error TEXT,
            configuration_revision TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
          );

CREATE TABLE kernel_decision_applications (
            id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL UNIQUE,
            event_id TEXT NOT NULL UNIQUE,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'pending',
            apply_attempts INTEGER NOT NULL DEFAULT 0,
            observation_event_id TEXT,
            observation_event_json TEXT,
            error_summary TEXT,
            applying_at TEXT,
            applied_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (decision_id) REFERENCES kernel_decisions(id),
            FOREIGN KEY (event_id) REFERENCES kernel_events(id)
          );

CREATE TABLE kernel_effect_outbox (
            id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL,
            task_id TEXT,
            effect_type TEXT NOT NULL,
            idempotency_key TEXT NOT NULL UNIQUE,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            delivery_attempts INTEGER NOT NULL DEFAULT 0,
            provider_receipt TEXT,
            error_summary TEXT,
            available_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (decision_id) REFERENCES kernel_decisions(id)
          );

CREATE TABLE executor_attempt_runtime (
            attempt_id TEXT PRIMARY KEY,
            source_attempt_id TEXT,
            continuation_token TEXT,
            workspace_root TEXT,
            workspace_baseline_json TEXT NOT NULL DEFAULT '{}',
            workspace_delta_json TEXT NOT NULL DEFAULT '{}',
            progress_json TEXT NOT NULL DEFAULT '{}',
            recovery_safety TEXT NOT NULL,
            external_idempotency_key TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );

CREATE TABLE work_graph_revisions (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            generation_id TEXT NOT NULL,
            authorized_decision_id TEXT,
            proposal_source TEXT NOT NULL DEFAULT 'initial',
            automatic_replan INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL,
            configuration_revision TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, completion_kind TEXT CHECK(completion_kind IN ('full', 'partial_accepted')),
            completion_requirements_json TEXT NOT NULL DEFAULT '[]',
            UNIQUE(task_id, revision),
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (authorized_decision_id) REFERENCES kernel_decisions(id),
            FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
          );

CREATE TABLE resource_leases (
            id TEXT PRIMARY KEY,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            access_mode TEXT NOT NULL CHECK(access_mode IN ('read', 'write')),
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            work_unit_id TEXT NOT NULL,
            lease_token TEXT NOT NULL,
            heartbeat_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            released_at TEXT,
            created_at TEXT NOT NULL, revocation_requested_at TEXT, revocation_reason TEXT,
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
            FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
          );

CREATE TABLE resource_waits (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            access_mode TEXT NOT NULL CHECK(access_mode IN ('read', 'write')),
            conflicting_lease_ids_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'waiting',
            requested_at TEXT NOT NULL,
            resolved_at TEXT,
            UNIQUE(attempt_id, partition_key, access_mode)
          );

CREATE TABLE workspace_records (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            workspace_kind TEXT NOT NULL CHECK(workspace_kind IN ('git', 'in_place')),
            root_uri TEXT NOT NULL,
            baseline_json TEXT NOT NULL DEFAULT '{}',
            managed_repository_uri TEXT,
            managed_branch TEXT,
            head_commit TEXT,
            current_checkpoint_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            cleanup_after TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, generation_id, subtask_id)
          );

CREATE TABLE workspace_checkpoints (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            attempt_id TEXT,
            reason TEXT NOT NULL CHECK(reason IN ('attempt_start', 'explicit', 'permission_suspended', 'success', 'failure', 'cancelled')),
            manifest_uri TEXT NOT NULL,
            manifest_hash TEXT NOT NULL,
            manifest_size INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspace_records(id)
          );

CREATE TABLE workspace_objects (
            content_hash TEXT PRIMARY KEY,
            object_uri TEXT NOT NULL UNIQUE,
            size_bytes INTEGER NOT NULL,
            media_type TEXT,
            reference_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_referenced_at TEXT NOT NULL
          );

CREATE TABLE workspace_checkpoint_objects (
            checkpoint_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            PRIMARY KEY(checkpoint_id, content_hash),
            FOREIGN KEY(checkpoint_id) REFERENCES workspace_checkpoints(id) ON DELETE CASCADE,
            FOREIGN KEY(content_hash) REFERENCES workspace_objects(content_hash)
          );

CREATE TABLE permission_requests (
            id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            agent_class_name TEXT NOT NULL,
            permission_profile_id TEXT NOT NULL,
            capability TEXT NOT NULL,
            resource_text TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            operation TEXT NOT NULL,
            reason TEXT NOT NULL,
            suggested_scope TEXT NOT NULL CHECK(suggested_scope IN ('once', 'attempt')),
            distinct_request_ordinal INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            decision_id TEXT,
            decision_reason TEXT,
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            UNIQUE(attempt_id, fingerprint)
          );

CREATE TABLE permission_grants (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            fingerprint TEXT NOT NULL,
            decision_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            attempt_id TEXT NOT NULL,
            capability TEXT NOT NULL,
            partition_key TEXT NOT NULL,
            partition_json TEXT NOT NULL,
            operation TEXT NOT NULL,
            grant_scope TEXT NOT NULL CHECK(grant_scope IN ('once', 'attempt')),
            expires_at TEXT NOT NULL,
            max_calls INTEGER NOT NULL,
            calls_used INTEGER NOT NULL DEFAULT 0,
            max_bytes INTEGER NOT NULL,
            bytes_used INTEGER NOT NULL DEFAULT 0,
            revoked_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (request_id) REFERENCES permission_requests(id),
            FOREIGN KEY (decision_id) REFERENCES kernel_decisions(id)
          );

CREATE TABLE user_authorizations (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            task_id TEXT NOT NULL,
            resolution TEXT NOT NULL CHECK(resolution IN ('approve', 'deny')),
            source TEXT NOT NULL,
            planner_plan_id TEXT,
            received_event_id TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            UNIQUE(request_id, received_event_id),
            FOREIGN KEY (request_id) REFERENCES permission_requests(id)
          );

CREATE TABLE attempt_sandboxes (
            attempt_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            work_unit_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            container_id TEXT NOT NULL UNIQUE,
            image_ref TEXT NOT NULL,
            image_id TEXT NOT NULL,
            status TEXT NOT NULL,
            lease_token TEXT NOT NULL,
            labels_json TEXT NOT NULL,
            exit_code INTEGER,
            result_collected_at TEXT,
            cleanup_status TEXT,
            cleanup_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (workspace_id) REFERENCES workspace_records(id)
          );

CREATE TABLE workspace_merge_attempts (
            id TEXT PRIMARY KEY,
            publication_id TEXT NOT NULL,
            decision_id TEXT NOT NULL,
            attempt_id TEXT,
            ordinal INTEGER NOT NULL,
            attempt_kind TEXT NOT NULL CHECK(attempt_kind IN ('automatic', 'repair')),
            base_commit TEXT NOT NULL,
            ours_commit TEXT NOT NULL,
            theirs_commit TEXT NOT NULL,
            conflict_paths_json TEXT NOT NULL DEFAULT '[]',
            file_policy_json TEXT NOT NULL DEFAULT '{}',
            result TEXT NOT NULL CHECK(result IN ('integrated', 'conflicted', 'failed', 'uncertain')),
            integration_commit TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(publication_id, ordinal),
          FOREIGN KEY (publication_id) REFERENCES workspace_publications(id)
        );

CREATE TABLE conversation_task_slots (
          conversation_id TEXT PRIMARY KEY,
          active_task_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('free', 'occupied', 'releasing', 'recovery_blocked')),
          reservation_id TEXT,
          fairness_sequence INTEGER NOT NULL DEFAULT 0,
          slot_version INTEGER NOT NULL DEFAULT 0,
          last_served_at TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (active_task_id) REFERENCES tasks(id)
        );

CREATE TABLE task_schedule_entries (
          task_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued', 'eligible', 'reserved', 'running', 'terminal')),
          enqueued_at TEXT NOT NULL,
          eligible_since TEXT NOT NULL,
          last_scheduled_at TEXT,
          scheduling_reason TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

CREATE INDEX idx_tasks_conversation_status
          ON tasks(conversation_id, status, updated_at, id);
CREATE INDEX idx_task_schedule_conversation
          ON task_schedule_entries(conversation_id, state, eligible_since, task_id);

CREATE TABLE "kernel_dispatch_items" (
            attempt_id TEXT PRIMARY KEY,
            decision_id TEXT NOT NULL,
            batch_order INTEGER NOT NULL,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            agent_class_name TEXT NOT NULL,
            attempt_kind TEXT NOT NULL CHECK(attempt_kind IN (
              'primary', 'continuation', 'fallback', 'contract_correction', 'merge_repair'
            )),
            source_attempt_id TEXT,
            recovery_mode TEXT NOT NULL CHECK(recovery_mode IN (
              'native_session', 'recovery_packet', 'fresh'
            )),
            attempt_payload_json TEXT NOT NULL DEFAULT 'null',
            resource_grant_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL CHECK(status IN (
              'pending_launch', 'launching', 'running', 'cancelling',
              'terminal', 'cancelled', 'uncertain'
            )),
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
            updated_at TEXT NOT NULL,
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
            FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
          );

CREATE TABLE "workspace_publications" (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            subtask_id TEXT NOT NULL,
            source_attempt_id TEXT NOT NULL,
            agent_class_name TEXT NOT NULL,
            candidate_commit TEXT NOT NULL,
            original_completion_json TEXT NOT NULL,
            topology_layer INTEGER NOT NULL,
            first_dispatch_order INTEGER NOT NULL,
            repair_attempts_used INTEGER NOT NULL DEFAULT 0,
            conflict_replans_used INTEGER NOT NULL DEFAULT 0,
            conflict_chain_id TEXT,
            integration_commit TEXT,
            observed_integration_commit TEXT,
            status TEXT NOT NULL CHECK(status IN (
              'pending', 'applying', 'conflicted', 'integrated', 'parked',
              'cancelling', 'cancelled', 'uncertain'
            )),
            applying_at TEXT,
            integrated_at TEXT,
            cancellation_decision_id TEXT,
            cancel_requested_at TEXT,
            cancelled_at TEXT,
            error_summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, generation_id, subtask_id),
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (subtask_id) REFERENCES subtasks(id)
          );

CREATE TABLE generation_replan_requests (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            generation_id TEXT NOT NULL,
            source_revision INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN (
              'pending_quiescence', 'planning', 'submitted', 'waiting_for_availability',
              'resolved', 'cancelled', 'failed'
            )),
            trigger_decision_id TEXT NOT NULL,
            quiescence_token TEXT,
            error_summary TEXT,
            deferred_plan_json TEXT,
            availability_explanation TEXT,
            configuration_revision TEXT NOT NULL,
            deferred_bindings_json TEXT NOT NULL DEFAULT '[]',
            planning_started_at TEXT,
            planner_claim_token TEXT,
            submitted_at TEXT,
            resolved_at TEXT,
            cancelled_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(task_id, generation_id, source_revision),
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
          );

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_interactions_session ON interactions(session_id, created_at);

CREATE INDEX idx_interactions_task ON interactions(task_id, created_at);

CREATE INDEX idx_skill_usage_events_task
        ON executor_skill_usage_events(task_id, created_at);

CREATE INDEX idx_skill_usage_events_execution
        ON executor_skill_usage_events(execution_id, created_at);

CREATE INDEX idx_skill_usage_events_skill
        ON executor_skill_usage_events(skill_name, event_type, created_at);

CREATE INDEX idx_skill_install_events_candidate
        ON executor_skill_install_events(candidate_id, created_at);

CREATE INDEX idx_skill_install_events_executor
        ON executor_skill_install_events(executor_name, status, created_at);

CREATE INDEX idx_task_memory_cards_task
        ON task_memory_cards(task_id, updated_at);

CREATE INDEX idx_task_memory_cards_source_candidate
        ON task_memory_cards(source_candidate_id);

CREATE INDEX idx_skill_effect_summaries_skill
        ON skill_effect_summaries(skill_name, skill_version_key, updated_at);

CREATE INDEX idx_skill_effect_summaries_executor
        ON skill_effect_summaries(executor_name, used_count, updated_at);

CREATE INDEX idx_executor_route_events_executor
        ON executor_route_events(selected_executor, created_at);

CREATE INDEX idx_executor_route_events_task
        ON executor_route_events(task_id, created_at);

CREATE INDEX idx_task_events_task ON task_events(task_id, created_at);

CREATE INDEX idx_configuration_revisions_content_hash
        ON configuration_revisions(content_hash, imported_at);

CREATE INDEX idx_work_units_state ON work_units(agent_class_kind, state, updated_at);

CREATE INDEX idx_work_unit_events_unit ON work_unit_events(work_unit_id, created_at);

CREATE INDEX idx_planner_runs_session
        ON planner_runs(session_id, created_at);

CREATE INDEX idx_planner_runs_revision
        ON planner_runs(configuration_revision, created_at);

CREATE INDEX idx_planner_tool_calls_run
        ON planner_tool_calls(planner_run_id, sequence);

CREATE INDEX idx_kernel_executor_status_revision
        ON kernel_executor_status(configuration_revision, agent_class_name);

CREATE INDEX idx_kernel_provider_status_revision
        ON kernel_provider_status(configuration_revision, provider_health, provider_ref);

CREATE INDEX idx_kernel_model_status_revision
        ON kernel_model_status(configuration_revision, model_health, provider_ref, model_ref);

CREATE INDEX idx_kernel_binding_status_revision
        ON kernel_binding_status(configuration_revision, binding_health, agent_class_ref);

CREATE INDEX idx_subtasks_task ON subtasks(task_id, status, created_at);

CREATE INDEX idx_subtask_handoffs_to ON subtask_handoffs(task_id, to_subtask_id);

CREATE INDEX idx_executor_attempt_receipts_subtask
          ON executor_attempt_receipts(task_id, subtask_id, completed_at);

CREATE INDEX idx_executor_attempt_receipts_binding
          ON executor_attempt_receipts(configuration_revision, binding_fingerprint, completed_at);

CREATE INDEX idx_task_execution_evidence_task
          ON task_execution_evidence(task_id, created_at, id);

CREATE UNIQUE INDEX idx_work_units_one_active_attempt_per_subtask
          ON work_units(claimed_subtask_id)
          WHERE claimed_subtask_id IS NOT NULL AND state IN ('claimed', 'running', 'waiting');

CREATE INDEX idx_kernel_decisions_session
          ON kernel_decisions(session_id, created_at, id);

CREATE INDEX idx_kernel_decisions_task
          ON kernel_decisions(task_id, created_at, id);

CREATE INDEX idx_kernel_decisions_correlation
          ON kernel_decisions(correlation_id, created_at, id);

CREATE INDEX idx_kernel_decisions_revision
          ON kernel_decisions(configuration_revision, created_at, id);

CREATE INDEX idx_kernel_events_drain
            ON kernel_events(status, available_at, created_at, id);

CREATE INDEX idx_kernel_events_task
            ON kernel_events(task_id, created_at, id);

CREATE INDEX idx_kernel_events_revision
            ON kernel_events(configuration_revision, status, available_at, id);

CREATE INDEX idx_kernel_decision_applications_status
            ON kernel_decision_applications(status, created_at, id);

CREATE INDEX idx_kernel_effect_outbox_drain
            ON kernel_effect_outbox(status, available_at, created_at, id);

CREATE UNIQUE INDEX idx_work_graph_one_active_revision
            ON work_graph_revisions(task_id) WHERE status = 'active';

CREATE INDEX idx_work_graph_revisions_generation
            ON work_graph_revisions(task_id, generation_id, revision);

CREATE INDEX idx_work_graph_revisions_revision
            ON work_graph_revisions(configuration_revision, generation_id, revision);

CREATE INDEX idx_resource_leases_active
            ON resource_leases(released_at, expires_at, partition_key);

CREATE INDEX idx_resource_leases_attempt
            ON resource_leases(attempt_id, released_at);

CREATE UNIQUE INDEX idx_resource_leases_identity
            ON resource_leases(attempt_id, lease_token, partition_key, access_mode);

CREATE INDEX idx_resource_waits_status
            ON resource_waits(status, requested_at);

CREATE INDEX idx_workspace_records_retention
            ON workspace_records(status, cleanup_after);

CREATE INDEX idx_workspace_checkpoints_workspace
            ON workspace_checkpoints(workspace_id, created_at);

CREATE INDEX idx_permission_requests_pending
            ON permission_requests(status, task_id, created_at);

CREATE INDEX idx_permission_grants_attempt
            ON permission_grants(attempt_id, expires_at, revoked_at);

CREATE INDEX idx_user_authorizations_request
            ON user_authorizations(request_id, created_at);

CREATE INDEX idx_attempt_sandboxes_status
            ON attempt_sandboxes(status, updated_at);

CREATE INDEX idx_workspace_merge_attempts_publication
            ON workspace_merge_attempts(publication_id, ordinal);

CREATE INDEX idx_kernel_dispatch_items_supervisor
            ON kernel_dispatch_items(status, batch_order, created_at, attempt_id);

CREATE INDEX idx_kernel_dispatch_items_task
            ON kernel_dispatch_items(task_id, status, batch_order);

CREATE INDEX idx_kernel_dispatch_items_binding
            ON kernel_dispatch_items(configuration_revision, binding_fingerprint, status);

CREATE UNIQUE INDEX idx_kernel_dispatch_one_active_subtask
            ON kernel_dispatch_items(task_id, generation_id, subtask_id)
            WHERE status IN ('pending_launch', 'launching', 'running', 'cancelling');

CREATE INDEX idx_workspace_publications_apply
            ON workspace_publications(
              task_id, generation_id, status, topology_layer,
              first_dispatch_order, subtask_id
            );

CREATE INDEX idx_generation_replan_requests_status
            ON generation_replan_requests(status, created_at, id);

CREATE INDEX idx_generation_replan_requests_task
            ON generation_replan_requests(task_id, generation_id, status);

CREATE INDEX idx_generation_replan_requests_revision
            ON generation_replan_requests(configuration_revision, status, created_at);

CREATE TABLE task_artifacts (
            artifact_id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            generation_id TEXT,
            subtask_id TEXT,
            publication_id TEXT,
            display_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            published_path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            preview_kind TEXT NOT NULL CHECK(preview_kind IN ('markdown', 'text', 'code', 'image', 'unsupported')),
            content_hash TEXT NOT NULL,
            byte_length INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published', 'unavailable')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(account_id, task_id, relative_path, content_hash),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
          );

CREATE INDEX idx_task_artifacts_task
            ON task_artifacts(task_id, created_at);

CREATE INDEX idx_task_artifacts_publication
            ON task_artifacts(publication_id);

CREATE TRIGGER trg_task_search_index_interactions_insert
      AFTER INSERT ON interactions
      WHEN NEW.task_id IS NOT NULL
      BEGIN
        DELETE FROM task_search_index
          WHERE source_kind = 'interaction' AND source_id = NEW.id;
        INSERT INTO task_search_index (
          task_id, source_kind, source_id, title, body, tags, created_at, updated_at
        ) VALUES (
          NEW.task_id,
          'interaction',
          NEW.id,
          '',
          substr(COALESCE(NEW.user_input, '') || char(10) || COALESCE(NEW.system_output, ''), 1, 4000),
          'interaction',
          NEW.created_at,
          NEW.created_at
        );
      END;

CREATE TRIGGER trg_task_search_index_interactions_delete
      AFTER DELETE ON interactions
      WHEN OLD.task_id IS NOT NULL
      BEGIN
        DELETE FROM task_search_index
          WHERE source_kind = 'interaction' AND source_id = OLD.id;
      END;

CREATE TRIGGER subtask_handoffs_immutable_update
        BEFORE UPDATE ON subtask_handoffs BEGIN
          SELECT RAISE(ABORT, 'subtask_handoffs are immutable');
        END;

CREATE TRIGGER subtask_handoffs_immutable_delete
        BEFORE DELETE ON subtask_handoffs BEGIN
          SELECT RAISE(ABORT, 'subtask_handoffs are immutable');
      END;

CREATE TRIGGER configuration_revisions_immutable_update
        BEFORE UPDATE ON configuration_revisions BEGIN
          SELECT RAISE(ABORT, 'configuration_revisions are immutable');
        END;

CREATE TRIGGER configuration_revisions_immutable_delete
        BEFORE DELETE ON configuration_revisions BEGIN
          SELECT RAISE(ABORT, 'configuration_revisions are immutable');
        END;

CREATE TRIGGER executor_attempt_receipts_immutable_update
        BEFORE UPDATE ON executor_attempt_receipts BEGIN
          SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
        END;

CREATE TRIGGER executor_attempt_receipts_immutable_delete
        BEFORE DELETE ON executor_attempt_receipts BEGIN
          SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
      END;

CREATE TRIGGER result_objects_immutable_update
        BEFORE UPDATE ON result_objects BEGIN
          SELECT RAISE(ABORT, 'result_objects are immutable');
        END;

CREATE TRIGGER result_objects_immutable_delete
        BEFORE DELETE ON result_objects BEGIN
          SELECT RAISE(ABORT, 'result_objects are immutable');
        END;

CREATE TRIGGER result_references_immutable_update
        BEFORE UPDATE ON result_references BEGIN
          SELECT RAISE(ABORT, 'result_references are immutable');
        END;

CREATE TRIGGER result_references_immutable_delete
        BEFORE DELETE ON result_references BEGIN
          SELECT RAISE(ABORT, 'result_references are immutable');
        END;

CREATE TRIGGER workspace_checkpoints_immutable_update
          BEFORE UPDATE ON workspace_checkpoints BEGIN
            SELECT RAISE(ABORT, 'workspace checkpoints are immutable');
          END;

CREATE TRIGGER workspace_merge_attempts_immutable_update
          BEFORE UPDATE ON workspace_merge_attempts BEGIN
            SELECT RAISE(ABORT, 'workspace_merge_attempts are immutable');
          END;

CREATE TRIGGER workspace_merge_attempts_immutable_delete
          BEFORE DELETE ON workspace_merge_attempts BEGIN
            SELECT RAISE(ABORT, 'workspace_merge_attempts are immutable');
          END;
`;

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { name: string } | undefined;
  return Boolean(row);
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name);
}

export interface Schema30MigrationBinding {
  agentClassRef: string;
  harnessRef: string;
  modelRef: string;
  providerRef: string;
  permissionProfileRef: string | null;
  bindingFingerprint: string;
}

export interface Schema30MigrationContextInput {
  revisionId: string;
  contentHash: string;
  importedAt: string;
  plannerBinding: Schema30MigrationBinding;
  legacyAgentClassBindings: Readonly<Record<string, Schema30MigrationBinding>>;
}

export type Schema30MigrationContext = Readonly<Schema30MigrationContextInput>;

const sealedSchema30MigrationContexts = new WeakSet<object>();

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

function freezeBinding(
  binding: Schema30MigrationBinding,
  label: string,
): Readonly<Schema30MigrationBinding> {
  for (const [field, value] of Object.entries(binding)) {
    if (field === 'permissionProfileRef' && value === null) continue;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} binding ${field} must be a non-empty string`);
    }
  }
  return Object.freeze({ ...binding });
}

export function createSchema30MigrationContext(
  input: Schema30MigrationContextInput,
): Schema30MigrationContext {
  assertNonEmpty(input.revisionId, 'migration revision ID');
  assertNonEmpty(input.contentHash, 'migration content hash');
  assertNonEmpty(input.importedAt, 'migration import time');
  const context = {
    revisionId: input.revisionId,
    contentHash: input.contentHash,
    importedAt: input.importedAt,
    plannerBinding: freezeBinding(input.plannerBinding, 'Planner'),
    legacyAgentClassBindings: Object.freeze(Object.fromEntries(
      Object.entries(input.legacyAgentClassBindings).map(([legacyName, binding]) => {
        assertNonEmpty(legacyName, 'legacy AgentClass name');
        return [legacyName, freezeBinding(binding, `legacy AgentClass ${legacyName}`)];
      }),
    )),
  };
  Object.freeze(context);
  sealedSchema30MigrationContexts.add(context);
  return context;
}

/**
 * Creates the current schema or applies the supported pre-release upgrades.
 */
export function runMigrations(
  db: Database.Database,
  migrationContext?: Schema30MigrationContext,
): void {
  runBaseMigrations(db, migrationContext);
  let version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  if (version === 42) {
    db.transaction(() => {
      db.exec(NAVIGATION_PROJECTION_SQL);
      installDirectoryInvalidationTriggers(db);
      const changed = db.prepare('UPDATE schema_version SET version = 43 WHERE version = 42').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 42 to 43 migration');
    })();
    version = 43;
  }
  if (version === 43) {
    db.transaction(() => {
      db.exec(GATEWAY_COMMAND_ADMISSION_SQL);
      const changed = db.prepare('UPDATE schema_version SET version = 44 WHERE version = 43').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 43 to 44 migration');
    })();
    version = 44;
  }
  if (version === 44) {
    db.transaction(() => {
      db.exec(RETRY_WAKE_SQL);
      const changed = db.prepare('UPDATE schema_version SET version = 45 WHERE version = 44').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 44 to 45 migration');
    })();
    version = 45;
  }
  if (version === 45) {
    db.transaction(() => {
      const columns = columnsOf(db, 'workspace_directory_projection');
      if (!columns.includes('latest_task_created_at')) {
        db.exec(`
          ALTER TABLE workspace_directory_projection
            ADD COLUMN latest_task_created_at TEXT NOT NULL DEFAULT '';
          UPDATE workspace_directory_projection
          SET latest_task_created_at = COALESCE(
            json_extract(summary_json, '$.latestTaskCreatedAt'),
            json_extract(summary_json, '$.createdAt'),
            ''
          );
          DROP INDEX IF EXISTS workspace_directory_page;
          DROP INDEX IF EXISTS workspace_directory_all_page;
          CREATE INDEX workspace_directory_page ON workspace_directory_projection
            (account_id, workspace_id, archived, latest_task_created_at DESC, conversation_id ASC);
          CREATE INDEX workspace_directory_all_page ON workspace_directory_projection
            (account_id, workspace_id, latest_task_created_at DESC, conversation_id ASC);
        `);
      }
      const changed = db.prepare('UPDATE schema_version SET version = 46 WHERE version = 45').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 45 to 46 migration');
    })();
    version = 46;
  }
  if (version === 46) {
    db.transaction(() => {
      installObservationSchema(db);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kernel_events'").get()) {
        db.exec(`CREATE INDEX IF NOT EXISTS kernel_permission_resolution_request ON kernel_events
          (correlation_id) WHERE event_type = 'permission_resolution_received'`);
      }
      const changed = db.prepare('UPDATE schema_version SET version = 47 WHERE version = 46').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 46 to 47 migration');
    })();
    version = 47;
  }
  if (version === 47) {
    db.transaction(() => {
      db.exec(`CREATE TABLE task_execution_evidence_v48 (${TASK_EXECUTION_EVIDENCE_COLUMNS})`);
      if (tableExists(db, 'task_execution_evidence')) {
        db.exec(`
          INSERT INTO task_execution_evidence_v48
            (id, task_id, kind, source_id, title, content, exact_only, created_at)
          SELECT id, task_id, kind, source_id, title, content, exact_only, created_at
          FROM task_execution_evidence;
          DROP TABLE task_execution_evidence;
        `);
      }
      db.exec(`
        ALTER TABLE task_execution_evidence_v48 RENAME TO task_execution_evidence;
        CREATE INDEX idx_task_execution_evidence_task
          ON task_execution_evidence(task_id, created_at, id);
      `);
      const changed = db.prepare('UPDATE schema_version SET version = 48 WHERE version = 47').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 47 to 48 migration');
    })();
    version = 48;
  }
  if (version === 48) {
    db.transaction(() => {
      db.exec(PUBLICATION_DELIVERY_SQL);
      const changed = db.prepare('UPDATE schema_version SET version = 49 WHERE version = 48').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 48 to 49 migration');
    })();
    version = 49;
  }
  if (version === 49) {
    db.transaction(() => {
      // NULL preserves already-authorized historical delivery; new plans must declare an array.
      if (!columnsOf(db, 'subtasks').includes('file_outputs_json')) {
        db.exec('ALTER TABLE subtasks ADD COLUMN file_outputs_json TEXT');
      }
      const changed = db.prepare('UPDATE schema_version SET version = 50 WHERE version = 49').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 49 to 50 migration');
    })();
    version = 50;
  }
  if (version === 50) {
    db.transaction(() => {
      if (!columnsOf(db, 'tasks').includes('public_task_directory')) {
        db.exec('ALTER TABLE tasks ADD COLUMN public_task_directory TEXT');
        const update = db.prepare('UPDATE tasks SET public_task_directory = ? WHERE id = ?');
        for (const task of db.prepare('SELECT id, title FROM tasks').all() as Array<{ id: string; title: string }>) {
          const artifact = db.prepare("SELECT published_path, relative_path FROM task_artifacts WHERE task_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 1").get(task.id) as { published_path: string; relative_path: string } | undefined;
          const prefix = artifact?.published_path.slice(0, -artifact.relative_path.length).replace(/\/$/u, '');
          const retained = prefix?.match(/(?:^|\/)(metaclaw-tasks\/[^/]+)$/u)?.[1];
          update.run(retained ?? publicTaskRelativeDirectory(task.title, task.id), task.id);
        }
      }
      if (!columnsOf(db, 'tasks').includes('public_delivery_baseline_json')) db.exec("ALTER TABLE tasks ADD COLUMN public_delivery_baseline_json TEXT NOT NULL DEFAULT '{}'");
      if (!columnsOf(db, 'tasks').includes('start_service_after_publish')) db.exec('ALTER TABLE tasks ADD COLUMN start_service_after_publish INTEGER NOT NULL DEFAULT 0');
      if (!columnsOf(db, 'tasks').includes('public_project')) db.exec('ALTER TABLE tasks ADD COLUMN public_project INTEGER NOT NULL DEFAULT 0');
      db.exec(MANAGED_SERVICES_SQL);
      const changed = db.prepare('UPDATE schema_version SET version = 51 WHERE version = 50').run();
      if (changed.changes !== 1) throw new Error('schema version changed during 50 to 51 migration');
    })();
    version = 51;
  }
  // Schema 51 -> 52 is owned by main's six-state Task migration. The
  // Workspace execution objects are added only after that classification so the
  // historical Task table is rebuilt under the six-state CHECK first.
  if (version === 51) {
    migrateSchema51To52(db);
    version = 52;
  }
  if (version === 52) {
    db.transaction(() => {
      // A database stamped as 52 must carry main's six-state base. We do not
      // silently reinterpret a version number from an unrelated branch.
      assertSixStateTaskBase(db);
      applyWorkspaceExecutionDdl(db);
      bumpSchemaVersion(db, 52, 53, '52 to 53');
    })();
    version = 53;
  }
  // A memory-branch database stamped 53 has no six-state Task base. Fail closed
  // instead of silently treating it as main's 53.
  if (version === 53) {
    assertSixStateTaskBase(db);
  }
  // SQLite cannot widen a CHECK constraint in place, so an in-place Workspace
  // requires rebuilding the parent table. Foreign keys stay off for the swap;
  // every parent row keeps its id, so child checkpoints stay consistent.
  if (version === 53 && !tableExists(db, 'workspace_records')) {
    db.transaction(() => {
      bumpSchemaVersion(db, 53, 54, '53 to 54');
    })();
    version = 54;
  }
  if (version === 53) {
    rebuildWorkspaceRecordsForInPlace(db);
    version = 54;
  }
  if (version === 54) {
    db.transaction(() => {
      applySchema55Ddl(db);
      bumpSchemaVersion(db, 54, 55, '54 to 55');
    })();
    version = 55;
  }
  if (version === 55) {
    rebuildManagedServiceIdentity(db);
    version = 56;
  }
  if (version === 56) {
    db.transaction(() => {
      applyWorkspaceExecutionDecisionDdl(db);
      bumpSchemaVersion(db, 56, 57, '56 to 57');
    })();
    version = 57;
  }
  if (version === 57) {
    db.transaction(() => {
      // Worktree generations are historical facts. Keep them visible for
      // diagnosis, but prevent any pending candidate from being replayed by
      // the single-Workspace runtime.
      if (tableExists(db, 'workspace_publications')) {
        db.prepare(`
          UPDATE workspace_publications
          SET status = 'parked',
              error_summary = 'retired Worktree publication; explicit re-execution in the target Workspace is required'
          WHERE status IN ('pending', 'applying')
        `).run();
      }
      bumpSchemaVersion(db, 57, 58, '57 to 58');
    })();
    version = 58;
  }
  if (version === 58) {
    db.transaction(() => {
      db.exec(MEMORY_BINDINGS_SQL);
      db.exec(MEMORY_STATE_SQL);
      retireLegacyMemoryState(db);
      bumpSchemaVersion(db, 58, 59, '58 to 59');
    })();
    version = 59;
  }
  // Current-schema databases may have been created before a new projection
  // invalidation trigger was introduced. Reinstalling the idempotent trigger
  // set on every open upgrades those databases without requiring a rebuild.
  db.transaction(() => {
    installDirectoryInvalidationTriggers(db);
  })();
}

/**
 * Idempotent Workspace execution objects. Applied to 51 (this branch's
 * pre-release base) and to 52 (main's six-state Task schema), because neither
 * version is the owner of these tables: they are additive.
 */
function applyWorkspaceExecutionDdl(db: Database.Database): void {
  if (!columnsOf(db, 'tasks').includes('execution_mode')) {
    db.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'in_place'");
  }
  const artifactColumns = tableExists(db, 'task_artifacts') ? columnsOf(db, 'task_artifacts') : [];
  if (artifactColumns.length > 0 && !artifactColumns.includes('reference_kind')) {
    db.exec("ALTER TABLE task_artifacts ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'legacy_published_copy'");
    db.exec('ALTER TABLE task_artifacts ADD COLUMN workspace_id TEXT');
    db.exec('ALTER TABLE task_artifacts ADD COLUMN artifact_version_id TEXT');
    db.exec('ALTER TABLE task_artifacts ADD COLUMN source_relative_path TEXT');
  }
  db.exec(WORKSPACE_EXECUTION_SQL);
  db.exec(WORKSPACE_CHANGE_RECORD_SQL);
  db.exec(ARTIFACT_VERSION_SQL);
}

/**
 * Schema 57 pins the Kernel-authorized Workspace execution decision on the Task
 * and on the per-Generation binding, so retry/recovery/follow-up rounds inherit
 * the mode instead of re-reading the environment or current settings. It also
 * retires legacy worktree publications that would otherwise be replayed by the
 * old copy path: those are parked for an explicit decision, never silently
 * copied into the user's Workspace.
 */
function applyWorkspaceExecutionDecisionDdl(db: Database.Database): void {
  const taskColumns = columnsOf(db, 'tasks');
  const addTaskColumn = (name: string, ddl: string): void => {
    if (!taskColumns.includes(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
  };
  addTaskColumn('workspace_execution_source', "workspace_execution_source TEXT NOT NULL DEFAULT ''");
  addTaskColumn('workspace_delivery_policy', "workspace_delivery_policy TEXT NOT NULL DEFAULT ''");
  addTaskColumn('workspace_target_paths_json', "workspace_target_paths_json TEXT NOT NULL DEFAULT '[]'");
  addTaskColumn('workspace_intent_json', 'workspace_intent_json TEXT');

  if (tableExists(db, 'workspace_execution_bindings')) {
    const bindingColumns = columnsOf(db, 'workspace_execution_bindings');
    const addBindingColumn = (name: string, ddl: string): void => {
      if (!bindingColumns.includes(name)) db.exec(`ALTER TABLE workspace_execution_bindings ADD COLUMN ${ddl}`);
    };
    addBindingColumn('mode_source', "mode_source TEXT NOT NULL DEFAULT ''");
    addBindingColumn('delivery_policy', "delivery_policy TEXT NOT NULL DEFAULT ''");
    addBindingColumn('workspace_intent_json', 'workspace_intent_json TEXT');
    addBindingColumn('targeted_paths_json', "targeted_paths_json TEXT NOT NULL DEFAULT '[]'");
    addBindingColumn('cleaned_at', 'cleaned_at TEXT');
  }

  if (tableExists(db, 'workspace_publications')) {
    if (!columnsOf(db, 'workspace_publications').includes('delivery_authorized_at')) {
      db.exec('ALTER TABLE workspace_publications ADD COLUMN delivery_authorized_at TEXT');
    }
  }

  if (tableExists(db, 'workspace_publications') && tableExists(db, 'tasks')) {
    db.prepare(`
      UPDATE workspace_publications
      SET status = 'parked',
          error_summary = 'legacy worktree publication retired by schema 57; re-accept or re-execute explicitly'
      WHERE status IN ('pending', 'applying')
        AND task_id IN (SELECT id FROM tasks WHERE execution_mode = 'worktree')
    `).run();
  }
}

/**
 * True when the database carries main's six-state Task base (schema 52). The
 * branch relies on this to decide whether a 52 database may be upgraded.
 */
function hasSixStateTaskBase(db: Database.Database): boolean {
  if (!tableExists(db, 'task_state_changes')
    || !columnsOf(db, 'tasks').includes('state_version')
    || !columnsOf(db, 'tasks').includes('completed_at')) {
    return false;
  }
  // Main's migration rebuilds `tasks` with the six-state CHECK. Merely adding
  // the projection columns to an older branch database must not be accepted as
  // an externally-owned schema 52.
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get() as { sql?: string } | undefined)?.sql ?? '';
  const normalized = sql.toLowerCase();
  return ['queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled']
    .every(state => normalized.includes(`'${state}'`))
    && !normalized.includes("'created'");
}

/**
 * A 52 database is main-owned. Upgrading one without its base would leave a
 * schema that neither runtime can interpret, so the step refuses instead of
 * guessing.
 */
function assertSixStateTaskBase(db: Database.Database): void {
  if (hasSixStateTaskBase(db)) return;
  // A 52 this branch produced itself (51 -> 52 bridge) is known to lack main's
  // reclassification; only an externally observed 52 has to prove its origin.
  if (branchBridgeRecorded(db, '51_to_52_branch_bridge')) return;
  throw new Error(
    'schema 52 does not carry the six-state Task base (task_state_changes, '
    + 'tasks.state_version, tasks.completed_at). Schema 52 belongs to main; '
    + 'merge main before upgrading this database, or recreate it.',
  );
}

function branchBridgeRecorded(db: Database.Database, marker: string): boolean {
  if (!tableExists(db, 'schema_branch_bridges')) return false;
  return Boolean(db.prepare('SELECT 1 FROM schema_branch_bridges WHERE marker = ?').get(marker));
}

/**
 * Records that this branch bridged a version main owns. Post-merge tooling can
 * see that main's step still has to run instead of assuming it happened.
 */
function recordBranchBridge(db: Database.Database, marker: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_branch_bridges (
      marker TEXT PRIMARY KEY,
      recorded_at TEXT NOT NULL
    )
  `);
  db.prepare('INSERT OR IGNORE INTO schema_branch_bridges (marker, recorded_at) VALUES (?, ?)')
    .run(marker, new Date().toISOString());
}

/**
 * Schema 55 adds the durable facts the in-place contract needs: a wake kind so
 * partition waits can be re-dispatched, service workspace/revision identity,
 * and the write-after-crash facts that decide `uncertain` recovery.
 */
function applySchema55Ddl(db: Database.Database): void {
  const retryColumns = tableExists(db, 'retry_wakes') ? columnsOf(db, 'retry_wakes') : [];
  if (retryColumns.length > 0 && !retryColumns.includes('wake_kind')) {
    db.exec("ALTER TABLE retry_wakes ADD COLUMN wake_kind TEXT NOT NULL DEFAULT 'retry'");
  }
  const serviceColumns = tableExists(db, 'managed_local_services') ? columnsOf(db, 'managed_local_services') : [];
  if (serviceColumns.length > 0) {
    if (!serviceColumns.includes('workspace_id')) {
      db.exec('ALTER TABLE managed_local_services ADD COLUMN workspace_id TEXT');
    }
    if (!serviceColumns.includes('specification_revision')) {
      db.exec("ALTER TABLE managed_local_services ADD COLUMN specification_revision TEXT NOT NULL DEFAULT ''");
    }
  }
  const runtimeColumns = tableExists(db, 'executor_attempt_runtime')
    ? columnsOf(db, 'executor_attempt_runtime')
    : [];
  const dispatchColumns = tableExists(db, 'kernel_dispatch_items')
    ? columnsOf(db, 'kernel_dispatch_items')
    : [];
  if (dispatchColumns.length > 0 && !dispatchColumns.includes('execution_binding_fingerprint')) {
    db.exec('ALTER TABLE kernel_dispatch_items ADD COLUMN execution_binding_fingerprint TEXT');
  }
  if (runtimeColumns.length > 0) {
    if (!runtimeColumns.includes('write_started_at')) {
      db.exec('ALTER TABLE executor_attempt_runtime ADD COLUMN write_started_at TEXT');
      db.exec('ALTER TABLE executor_attempt_runtime ADD COLUMN write_finished_at TEXT');
      db.exec('ALTER TABLE executor_attempt_runtime ADD COLUMN receipt_persisted_at TEXT');
      db.exec("ALTER TABLE executor_attempt_runtime ADD COLUMN external_effect_status TEXT NOT NULL DEFAULT 'none'");
      db.exec('ALTER TABLE executor_attempt_runtime ADD COLUMN change_record_id TEXT');
    }
  }
}

/**
 * Service identity is (account, workspace, service), not the bare `service_id`.
 * Two Workspaces may legitimately run a service with the same id, and the
 * previous primary key made that impossible. SQLite cannot change a primary key
 * in place, so the table is rebuilt with the composite key.
 */
function rebuildManagedServiceIdentity(db: Database.Database): void {
  if (!tableExists(db, 'managed_local_services')) {
    db.transaction(() => {
      db.exec(MANAGED_SERVICES_SQL);
      bumpSchemaVersion(db, 55, 56, '55 to 56');
    })();
    return;
  }
  const priorViolations = new Set(
    (db.pragma('foreign_key_check') as Array<Record<string, unknown>>).map(row => JSON.stringify(row)),
  );
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE managed_local_services_v56 (
          service_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL DEFAULT '',
          task_id TEXT NOT NULL REFERENCES tasks(id),
          specification_revision TEXT NOT NULL DEFAULT '',
          specification_json TEXT NOT NULL,
          state TEXT NOT NULL,
          process_id INTEGER,
          process_token TEXT,
          health_message TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (account_id, workspace_id, service_id)
        );
        INSERT INTO managed_local_services_v56 (
          service_id, account_id, workspace_id, task_id, specification_revision,
          specification_json, state, process_id, process_token, health_message, updated_at
        )
        SELECT service_id, account_id, COALESCE(workspace_id, ''), task_id,
          COALESCE(specification_revision, ''), specification_json, state,
          process_id, process_token, health_message, updated_at
        FROM managed_local_services;
        DROP TABLE managed_local_services;
        ALTER TABLE managed_local_services_v56 RENAME TO managed_local_services;
        CREATE INDEX IF NOT EXISTS managed_services_task
          ON managed_local_services(account_id, task_id);
        CREATE INDEX IF NOT EXISTS managed_services_workspace
          ON managed_local_services(account_id, workspace_id, service_id);
      `);
      bumpSchemaVersion(db, 55, 56, '55 to 56');
    })();
    const newViolations = (db.pragma('foreign_key_check') as Array<Record<string, unknown>>)
      .filter(row => !priorViolations.has(JSON.stringify(row)));
    if (newViolations.length > 0) {
      throw new Error('managed_local_services rebuild broke referential integrity');
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function bumpSchemaVersion(
  db: Database.Database,
  from: number,
  to: number,
  label: string,
): void {
  const changed = db.prepare('UPDATE schema_version SET version = ? WHERE version = ?').run(to, from);
  if (changed.changes !== 1) throw new Error(`schema version changed during ${label} migration`);
}

/** Widens `workspace_records.workspace_kind` to accept `in_place` by rebuilding. */
function rebuildWorkspaceRecordsForInPlace(db: Database.Database): void {
  const priorViolations = new Set(
    (db.pragma('foreign_key_check') as Array<Record<string, unknown>>).map(row => JSON.stringify(row)),
  );
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE workspace_records_v54 (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          generation_id TEXT NOT NULL,
          subtask_id TEXT NOT NULL,
          workspace_kind TEXT NOT NULL CHECK(workspace_kind IN ('git', 'in_place')),
          root_uri TEXT NOT NULL,
          baseline_json TEXT NOT NULL DEFAULT '{}',
          managed_repository_uri TEXT,
          managed_branch TEXT,
          head_commit TEXT,
          current_checkpoint_id TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          cleanup_after TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(task_id, generation_id, subtask_id)
        );
        INSERT INTO workspace_records_v54 SELECT
          id, task_id, generation_id, subtask_id, workspace_kind, root_uri, baseline_json,
          managed_repository_uri, managed_branch, head_commit, current_checkpoint_id,
          status, cleanup_after, created_at, updated_at
        FROM workspace_records;
        DROP TABLE workspace_records;
        ALTER TABLE workspace_records_v54 RENAME TO workspace_records;
        CREATE INDEX IF NOT EXISTS idx_workspace_records_retention
          ON workspace_records(status, cleanup_after);
      `);
      bumpSchemaVersion(db, 53, 54, '53 to 54');
    })();
    const newViolations = (db.pragma('foreign_key_check') as Array<Record<string, unknown>>)
      .filter(row => !priorViolations.has(JSON.stringify(row)));
    if (newViolations.length > 0) {
      throw new Error('workspace_records rebuild broke referential integrity');
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

const SIX_STATE_STATUSES = new Set([
  'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled',
]);

function migrateSchema51To52(db: Database.Database): void {
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  const before = new Set(
    (db.pragma('foreign_key_check') as unknown[]).map(row => JSON.stringify(row)),
  );
  const migrate = db.transaction(() => {
    if (tableExists(db, 'work_graph_revisions')
      && !columnsOf(db, 'work_graph_revisions').includes('completion_requirements_json')) {
      db.exec("ALTER TABLE work_graph_revisions ADD COLUMN completion_requirements_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (tableExists(db, 'conversation_task_slots')
      && !columnsOf(db, 'conversation_task_slots').includes('slot_version')) {
      db.exec('ALTER TABLE conversation_task_slots ADD COLUMN slot_version INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(TASK_STATE_SCHEMA_SQL);

    // Legacy fixtures and very old databases may not carry every operational
    // table. A missing table means "no evidence", never a guessed conclusion.
    const hasTable = (table: string) => tableExists(db, table);
    const hasRow = (table: string, sql: string, ...parameters: unknown[]): boolean => {
      if (!hasTable(table)) return false;
      try {
        return Boolean(db.prepare(sql).get(...parameters));
      } catch {
        return false;
      }
    };
    const taskColumns = new Set(columnsOf(db, 'tasks'));
    const taskColumn = (name: string): string | null => (taskColumns.has(name) ? `t.${name}` : null);

    const classifications = (db.prepare('SELECT * FROM tasks').all() as Array<Record<string, unknown>>)
      .map(row => ({
        id: String(row.id),
        status: String(row.status ?? 'queued'),
        updated_at: typeof row.updated_at === 'string' && row.updated_at.length > 0
          ? row.updated_at
          : '1970-01-01T00:00:00.000Z',
        state_detail_json: typeof row.state_detail_json === 'string' ? row.state_detail_json : null,
        completed_at: typeof row.completed_at === 'string' ? row.completed_at : null,
        archived_at: typeof row.archived_at === 'string' ? row.archived_at : null,
      }));
    interface Classification {
      status: string;
      detail: string;
      completedAt: string | null;
      archivedAt: string | null;
    }
    const classify = (task: {
      id: string;
      status: string;
      updated_at: string;
      state_detail_json: string | null;
      completed_at: string | null;
      archived_at: string | null;
    }): Classification => {
      // A row already written with the six-state contract is kept as-is; this
      // makes the migration idempotent for re-opened or reconstructed databases.
      if (taskColumns.has('state_version') && SIX_STATE_STATUSES.has(task.status)) {
        return {
          status: task.status,
          detail: task.state_detail_json ?? '{}',
          // Never invent a completion timestamp for a row that already carries
          // the six-state contract; the state entry stamps it on transitions.
          completedAt: task.completed_at,
          archivedAt: task.archived_at,
        };
      }
      const evidence = {
        activeDispatch: hasRow('kernel_dispatch_items', `SELECT 1 FROM kernel_dispatch_items
          WHERE task_id = ? AND status IN ('pending_launch', 'launching', 'running', 'cancelling') LIMIT 1`,
        task.id),
        armedRetry: hasRow('retry_wakes', `SELECT 1 FROM retry_wakes
          WHERE task_id = ? AND status IN ('armed', 'fired') LIMIT 1`, task.id),
        uncertainResidue: hasRow('kernel_dispatch_items', `SELECT 1 FROM kernel_dispatch_items
          WHERE task_id = ? AND status = 'uncertain' LIMIT 1`, task.id)
          || hasRow('kernel_events', `SELECT 1 FROM kernel_events WHERE task_id = ?
            AND status IN ('pending', 'processing') LIMIT 1`, task.id)
          || hasRow('kernel_decision_applications', `SELECT 1 FROM kernel_decision_applications AS application
            INNER JOIN kernel_events AS event ON event.id = application.event_id
            WHERE event.task_id = ? AND application.status IN ('pending', 'applying', 'uncertain') LIMIT 1`,
            task.id),
        publication: hasRow('workspace_publications', `SELECT 1 FROM workspace_publications
          WHERE task_id = ? AND status IN ('pending', 'applying', 'cancelling') LIMIT 1`, task.id),
        replan: hasRow('generation_replan_requests', `SELECT 1 FROM generation_replan_requests
          WHERE task_id = ? AND status IN ('pending_quiescence', 'planning', 'submitted') LIMIT 1`,
          task.id),
        awaitingAvailability: hasRow('generation_replan_requests', `SELECT 1 FROM generation_replan_requests
          WHERE task_id = ? AND status = 'waiting_for_availability' LIMIT 1`, task.id),
        completeRevision: hasRow('work_graph_revisions', `SELECT 1 FROM work_graph_revisions
          WHERE task_id = ? AND completion_kind = 'full' LIMIT 1`, task.id),
        hasSubtasks: hasRow('subtasks', 'SELECT 1 FROM subtasks WHERE task_id = ? LIMIT 1', task.id),
        unfinishedSubtasks: hasRow('subtasks', `SELECT 1 FROM subtasks
          WHERE task_id = ? AND status NOT IN ('done', 'cancelled') LIMIT 1`, task.id),
        definiteFailure: hasRow('executor_attempt_receipts', `SELECT 1 FROM executor_attempt_receipts r
          WHERE r.task_id = ? AND r.terminal_state IN ('executor_failed', 'contract_blocked', 'heartbeat_lost')
            AND NOT EXISTS (SELECT 1 FROM executor_attempt_receipts newer
              WHERE newer.subtask_id = r.subtask_id AND newer.completed_at > r.completed_at)
          LIMIT 1`, task.id),
        activeService: hasRow('managed_local_services', `SELECT 1 FROM managed_local_services
          WHERE task_id = ? AND state IN ('starting', 'stopping') LIMIT 1`, task.id),
      };
      const terminalTime = ['done', 'archived', 'cancelled'].includes(task.status)
        ? task.updated_at
        : null;
      const archivedAt = task.status === 'archived' ? task.updated_at : null;
      const detail = (
        code: string,
        message: string,
        phase: string | null = null,
      ): string => JSON.stringify({
        reason: { code, message, evidenceRefs: [] },
        unresolved: [],
        phase,
        pendingActions: [],
        requiredWork: [],
        cleanup: { state: 'none', objects: [], reason: '' },
        nextWakeAt: null,
        migration: {
          from: task.status,
          at: new Date().toISOString(),
          note: 'schema-51-to-52 evidence classification',
        },
      });
      if (task.status === 'cancelled') {
        return {
          status: 'cancelled',
          detail: detail('user_cancelled', '用户取消了任务。'),
          completedAt: terminalTime,
          archivedAt: null,
        };
      }
      if (task.status === 'done' || task.status === 'archived') {
        const proven = ['executor_attempt_receipts', 'work_graph_revisions', 'workspace_publications',
          'workspace_publication_deliveries', 'managed_local_services', 'kernel_decisions',
          'kernel_decision_applications'].every(hasTable)
          && evidence.hasSubtasks && !evidence.unfinishedSubtasks
          && !evidence.uncertainResidue
          && !hasRow('subtasks', `SELECT 1 FROM subtasks s
            WHERE s.task_id = ? AND s.graph_revision = (SELECT MAX(revision) FROM work_graph_revisions WHERE task_id = s.task_id)
              AND (s.status <> 'done' OR NOT EXISTS (
                SELECT 1 FROM executor_attempt_receipts r WHERE r.subtask_id = s.id
                  AND r.generation_id = s.generation_id AND r.graph_revision = s.graph_revision
                  AND (r.terminal_state = 'completed' OR EXISTS (
                    SELECT 1 FROM kernel_decisions d JOIN kernel_decision_applications a ON a.decision_id = d.id
                    WHERE d.task_id = r.task_id AND d.action = 'accept_uncertified_result' AND a.status = 'applied'
                      AND json_extract(d.decision_json, '$.action.attemptId') = r.attempt_id
                      AND json_extract(d.decision_json, '$.action.resultId') = json_extract(r.parsing_json, '$.resultObjects.safeProjectionId')
                  )))) LIMIT 1`, task.id)
          && hasRow('work_graph_revisions', `SELECT 1 FROM work_graph_revisions
            WHERE task_id = ? AND revision = (SELECT MAX(revision) FROM work_graph_revisions WHERE task_id = ?)
              AND completion_kind IN ('full', 'partial_accepted')`, task.id, task.id)
          && !hasRow('tasks', `SELECT 1 FROM tasks t WHERE t.id = ?
            AND t.start_service_after_publish = 1 AND NOT EXISTS (
              SELECT 1 FROM managed_local_services svc WHERE svc.task_id = t.id AND svc.state = 'healthy')`, task.id)
          && !hasRow('subtasks', `SELECT 1 FROM subtasks s JOIN tasks t ON t.id = s.task_id
            WHERE s.task_id = ? AND s.graph_revision = (SELECT MAX(revision) FROM work_graph_revisions WHERE task_id = s.task_id)
              AND (t.public_project = 1 OR s.file_outputs_json NOT IN ('[]', '', 'null'))
              AND NOT EXISTS (SELECT 1 FROM workspace_publications p
                JOIN workspace_publication_deliveries d ON d.publication_id = p.id
                WHERE p.subtask_id = s.id AND p.generation_id = s.generation_id
                  AND p.status = 'integrated' AND d.status = 'succeeded') LIMIT 1`, task.id);
        if (proven) {
          return {
            status: 'succeeded',
            detail: detail('none', '用户要求的必需工作已全部完成。'),
            completedAt: terminalTime,
            archivedAt,
          };
        }
        return {
          status: 'needs_action',
          detail: detail(
            'system_anomaly',
            `旧的 ${task.status} 结论缺少可核实的完成证据，需要确认。`,
          ),
          completedAt: null,
          archivedAt,
        };
      }
      if (task.status === 'created' || task.status === 'ready') {
        if (evidence.uncertainResidue) return {
          status: 'needs_action', detail: detail('external_outcome_unknown', '旧版未完成操作需要核实后重新授权。'),
          completedAt: null, archivedAt: null,
        };
        return {
          status: 'queued',
          detail: detail('waiting_for_capacity', '等待执行名额。'),
          completedAt: null,
          archivedAt: null,
        };
      }
      const runningDrivers = evidence.activeDispatch || evidence.armedRetry
        || evidence.publication || evidence.replan || evidence.activeService;
      if (runningDrivers) {
        return {
          status: 'running',
          detail: detail(
            'none',
            '系统正在执行任务。',
            evidence.publication ? 'publishing' : evidence.replan ? 'verifying'
              : evidence.armedRetry ? 'retrying' : evidence.activeService ? 'starting_service' : 'executing',
          ),
          completedAt: null,
          archivedAt: null,
        };
      }
      if (evidence.definiteFailure) {
        return {
          status: 'failed',
          detail: detail('execution_failed', '必需工作确定失败。'),
          completedAt: terminalTime ?? task.updated_at,
          archivedAt: null,
        };
      }
      if (evidence.awaitingAvailability) {
        return {
          status: 'queued',
          detail: detail('waiting_for_capacity', '等待可用的执行容量。'),
          completedAt: null,
          archivedAt: null,
        };
      }
      return {
        status: 'needs_action',
        detail: detail(
          evidence.uncertainResidue ? 'external_outcome_unknown' : 'no_authorized_driver',
          evidence.uncertainResidue
            ? '存在结果不明的操作，需要核实后才能继续。'
            : '旧的阻塞状态没有可核实的继续条件，需要确认。',
        ),
        completedAt: null,
        archivedAt: null,
      };
    };

    db.exec(`
      CREATE TEMP TABLE _task_state_migration (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        state_detail_json TEXT NOT NULL,
        completed_at TEXT,
        archived_at TEXT
      );
    `);
    const insertClassification = db.prepare(`INSERT INTO _task_state_migration
      (task_id, status, state_detail_json, completed_at, archived_at) VALUES (?, ?, ?, ?, ?)`);
    for (const task of classifications) {
      const result = classify(task);
      insertClassification.run(
        task.id, result.status, result.detail, result.completedAt, result.archivedAt,
      );
    }

    // A table rebuild re-parses every schema object. Any trigger that still
    // refers to the rebuilt table would fail to resolve while it is detached, so
    // drop all triggers first; the idempotent installers recreate them below.
    const triggers = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
    ).all() as Array<{ name: string; sql: string | null }>;
    for (const trigger of triggers) {
      if (!/\btasks\b/u.test(trigger.sql ?? '')) continue;
      db.exec(`DROP TRIGGER IF EXISTS "${trigger.name.replace(/"/gu, '""')}"`);
    }
    db.exec(`
      CREATE TABLE tasks_v52 (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
          'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled'
        )),
        state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
        state_detail_json TEXT NOT NULL DEFAULT '{}',
        completed_at TEXT,
        archived_at TEXT,
        retry_of_task_id TEXT,
        summary TEXT DEFAULT '',
        snapshot_json TEXT DEFAULT '[]',
        resources_json TEXT DEFAULT '[]',
        dependencies_json TEXT DEFAULT '[]',
        priority_json TEXT,
        injected_prefs_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_scheduling_reason TEXT DEFAULT '',
        last_interruption_reason TEXT DEFAULT '',
        interruption_count INTEGER DEFAULT 0,
        artifacts_json TEXT DEFAULT '[]',
        account_id TEXT NOT NULL DEFAULT 'legacy-account',
        conversation_id TEXT NOT NULL DEFAULT 'legacy-conversation',
        workspace_id TEXT NOT NULL DEFAULT 'legacy-workspace',
        owner_planner_session_id TEXT NOT NULL DEFAULT 'legacy-planner-session',
        admitted_at TEXT NOT NULL DEFAULT '',
        public_task_directory TEXT,
        public_delivery_baseline_json TEXT NOT NULL DEFAULT '{}',
        start_service_after_publish INTEGER NOT NULL DEFAULT 0,
        public_project INTEGER NOT NULL DEFAULT 0,
        CHECK (completed_at IS NULL
          OR status IN ('succeeded', 'failed', 'cancelled'))
      );
      INSERT INTO tasks_v52 (
        id, title, goal, status, state_version, state_detail_json, completed_at, archived_at,
        retry_of_task_id, summary, snapshot_json, resources_json, dependencies_json, priority_json,
        injected_prefs_json, created_at, updated_at, last_scheduling_reason,
        last_interruption_reason, interruption_count, artifacts_json, account_id, conversation_id,
        workspace_id, owner_planner_session_id, admitted_at, public_task_directory,
        public_delivery_baseline_json, start_service_after_publish, public_project
      )
      SELECT t.id, t.title,
        ${taskColumn('goal') ?? 'NULL'},
        m.status, 1, m.state_detail_json, m.completed_at, m.archived_at,
        NULL,
        ${taskColumn('summary') ?? "''"},
        ${taskColumn('snapshot_json') ?? "'[]'"},
        ${taskColumn('resources_json') ?? "'[]'"},
        ${taskColumn('dependencies_json') ?? "'[]'"},
        ${taskColumn('priority_json') ?? 'NULL'},
        ${taskColumn('injected_prefs_json') ?? "'[]'"},
        ${taskColumn('created_at') ?? "'1970-01-01T00:00:00.000Z'"},
        ${taskColumn('updated_at') ?? "'1970-01-01T00:00:00.000Z'"},
        ${taskColumn('last_scheduling_reason') ?? "''"},
        ${taskColumn('last_interruption_reason') ?? "''"},
        ${taskColumn('interruption_count') ?? '0'},
        ${taskColumn('artifacts_json') ?? "'[]'"},
        ${taskColumn('account_id') ?? "'legacy-account'"},
        ${taskColumn('conversation_id') ?? "'legacy-conversation'"},
        ${taskColumn('workspace_id') ?? "'legacy-workspace'"},
        ${taskColumn('owner_planner_session_id') ?? "'legacy-planner-session'"},
        ${taskColumn('admitted_at') ?? "'1970-01-01T00:00:00.000Z'"},
        ${taskColumn('public_task_directory') ?? 'NULL'},
        ${taskColumn('public_delivery_baseline_json') ?? "'{}'"},
        ${taskColumn('start_service_after_publish') ?? '0'},
        ${taskColumn('public_project') ?? '0'}
      FROM tasks AS t
      INNER JOIN _task_state_migration AS m ON m.task_id = t.id;
      DROP TABLE tasks;
      ALTER TABLE tasks_v52 RENAME TO tasks;
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_conversation_status
        ON tasks(conversation_id, status, updated_at, id);
      DROP TABLE _task_state_migration;
    `);
    // A migration decision is immutable audit, not an extension of the UI detail.
    for (const task of classifications) {
      const migrated = db.prepare('SELECT status, state_detail_json FROM tasks WHERE id = ?').get(task.id) as
        { status: string; state_detail_json: string };
      db.prepare(`INSERT OR IGNORE INTO task_state_changes
        (task_id, version, operation_key, decision_id, from_status, to_status, detail_json, evidence_refs_json, created_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, `migration:${task.id}`, 'schema-51-to-52', migrated.status, migrated.status,
          migrated.state_detail_json, JSON.stringify([`legacy_status:${task.status}`, 'schema:51']), task.updated_at);
    }
    // Old Decisions retain their immutable payload for inspection. Their
    // unapplied effects cannot be replayed as six-state authorization. Explicit
    // cancellation keeps its dedicated recovery path so cleanup can finish.
    if (!taskColumns.has('state_version') && hasTable('kernel_decision_applications') && hasTable('kernel_decisions')) {
      db.prepare(`UPDATE kernel_decision_applications SET status = 'uncertain',
        error_summary = 'task_state_upgrade_requires_reauthorization', updated_at = ?
        WHERE status <> 'applied' AND decision_id IN (
          SELECT id FROM kernel_decisions WHERE task_id IS NOT NULL
            AND action NOT IN ('cancel_task', 'cancel_subtasks'))`).run(new Date().toISOString());
    }
    if (!taskColumns.has('state_version') && hasTable('kernel_events')) {
      db.prepare(`UPDATE kernel_events SET status = 'failed',
        last_error = 'task_state_upgrade_requires_reauthorization', updated_at = ?
        WHERE status IN ('pending', 'processing') AND task_id IS NOT NULL
          AND event_type NOT IN ('task_cancel_requested', 'subtasks_cancel_requested')`)
        .run(new Date().toISOString());
    }
    // Backfill the requirement snapshot for revisions authorized before it
    // existed, from that revision's own persisted Subtasks.
    if (tableExists(db, 'subtasks') && tableExists(db, 'work_graph_revisions')) {
      const subtaskColumns = columnsOf(db, 'subtasks');
      const hasDelivery = subtaskColumns.includes('delivery_kind');
      const hasOutputs = subtaskColumns.includes('file_outputs_json');
      const revisions = db.prepare(`SELECT r.task_id AS taskId, r.revision AS revision
        FROM work_graph_revisions r
        WHERE r.completion_requirements_json IS NULL OR r.completion_requirements_json IN ('', '[]')`)
        .all() as Array<{ taskId: string; revision: number }>;
      const selectSubtasks = db.prepare(`SELECT id, title${hasDelivery ? ', delivery_kind' : ''}${hasOutputs ? ', file_outputs_json' : ''}
        FROM subtasks WHERE task_id = ? AND graph_revision = ? ORDER BY created_at`);
      const update = db.prepare(`UPDATE work_graph_revisions SET completion_requirements_json = ?
        WHERE task_id = ? AND revision = ?`);
      const taskFlags = db.prepare('SELECT public_project, start_service_after_publish FROM tasks WHERE id = ?');
      for (const revision of revisions) {
        const rows = selectSubtasks.all(revision.taskId, revision.revision) as Array<Record<string, unknown>>;
        const flags = taskFlags.get(revision.taskId) as
          { public_project: number; start_service_after_publish: number } | undefined;
        const requirements = rows.flatMap(row => {
          const entries: Array<Record<string, unknown>> = [{
            key: `execution:${String(row.id)}`,
            kind: 'execution',
            label: String(row.title),
            subtaskId: String(row.id),
            serviceId: null,
          }];
          const fileOutputs = row.file_outputs_json ? JSON.parse(String(row.file_outputs_json)) as unknown[] : [];
          if ((flags?.public_project ?? 0) === 1 || fileOutputs.length > 0) {
            entries.push({
              key: `delivery:${String(row.id)}`,
              kind: 'delivery',
              label: `${String(row.title)} 的文件交付`,
              subtaskId: String(row.id),
              serviceId: null,
            });
          }
          if (row.delivery_kind === 'report') {
            entries.push({
              key: `safety_report:${String(row.id)}`,
              kind: 'safety_report',
              label: `${String(row.title)} 的安全报告交付`,
              subtaskId: String(row.id),
              serviceId: null,
            });
          }
          return entries;
        });
        if ((flags?.start_service_after_publish ?? 0) === 1) {
          requirements.push({
            key: 'service',
            kind: 'service',
            label: '启动并接管本地服务',
            subtaskId: null,
            serviceId: null,
          });
        }
        if (requirements.length === 0) continue;
        update.run(JSON.stringify(requirements), revision.taskId, revision.revision);
      }
    }
    installObservationSchema(db);
    installDirectoryInvalidationTriggers(db);
    // Only violations introduced by this migration are fatal; a legacy fixture
    // that already had them cannot block the state migration.
    const fingerprint = (rows: unknown[]) => new Set(rows.map(row => JSON.stringify(row)));
    const introduced = [...fingerprint(db.pragma('foreign_key_check') as unknown[])]
      .filter(row => !before.has(row));
    if (introduced.length > 0) {
      throw new Error('schema 51 to 52 migration produced foreign key violations');
    }
    const changed = db.prepare('UPDATE schema_version SET version = 52 WHERE version = 51').run();
    if (changed.changes !== 1) throw new Error('schema version changed during 51 to 52 migration');
  });
  try {
    migrate();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }
}


/**
 * Retires the pre-TDAI local memory chain at schema 59.
 *
 * The TDAI sidecar is the only automatic memory engine (ADR-0049 amendment).
 * The historical `preferences` and learning/reflection tables are dropped, and
 * every persisted Planner payload that could still drive that chain is made
 * non-executable:
 *
 *   - `preference` ContextRefs are removed from stored work graphs; an active
 *     Task that referenced one is stopped in `needs_action` and requires a new
 *     plan instead of silently executing without the retired asset;
 *   - preference evidence is deleted so evidence lookups cannot resurrect the
 *     body;
 *   - pending/processing `plan_proposed` events and deferred replan payloads
 *     that contain a `preference` reference fail closed rather than replaying.
 */
function retireLegacyMemoryState(db: Database.Database): void {
  const retiredMessage = '旧偏好记忆引用已失效，需要重新规划';
  const changedTasks = new Set<string>();

  const subtaskColumns = tableExists(db, 'subtasks') ? columnsOf(db, 'subtasks') : [];
  if (subtaskColumns.includes('task_id') && subtaskColumns.includes('context_refs_json')) {
    const rows = db.prepare('SELECT id, task_id, context_refs_json FROM subtasks')
      .all() as Array<{ id: string; task_id: string; context_refs_json: string }>;
    const update = db.prepare('UPDATE subtasks SET context_refs_json = ? WHERE id = ?');
    for (const row of rows) {
      const refs = parseJsonArray(row.context_refs_json);
      if (!refs) continue;
      const kept = refs.filter(ref => (ref as { kind?: unknown } | null)?.kind !== 'preference');
      if (kept.length === refs.length) continue;
      update.run(JSON.stringify(kept), row.id);
      changedTasks.add(row.task_id);
    }
  }

  if (tableExists(db, 'task_execution_evidence')) {
    db.prepare("DELETE FROM task_execution_evidence WHERE kind = 'preference'").run();
  }

  if (tableExists(db, 'generation_replan_requests')) {
    const rows = db.prepare(`
      SELECT id, deferred_plan_json FROM generation_replan_requests
      WHERE deferred_plan_json IS NOT NULL AND status NOT IN ('resolved', 'cancelled', 'failed')
    `).all() as Array<{ id: string; deferred_plan_json: string }>;
    const fail = db.prepare(`
      UPDATE generation_replan_requests
      SET deferred_plan_json = NULL, status = 'failed',
          error_summary = ?, updated_at = ?
      WHERE id = ?
    `);
    const now = new Date().toISOString();
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.deferred_plan_json);
      } catch {
        continue;
      }
      if (!planPayloadHasPreferenceRef(payload)) continue;
      fail.run(`legacy_preference_context_ref_retired: ${retiredMessage}`, now, row.id);
    }
  }

  if (tableExists(db, 'kernel_events')) {
    const rows = db.prepare(`
      SELECT id, event_json FROM kernel_events
      WHERE event_type = 'plan_proposed' AND status IN ('pending', 'processing')
    `).all() as Array<{ id: string; event_json: string }>;
    const fail = db.prepare(`
      UPDATE kernel_events
      SET status = 'failed', last_error = ?, processed_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'processing')
    `);
    const now = new Date().toISOString();
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.event_json);
      } catch {
        continue;
      }
      if (!planPayloadHasPreferenceRef(payload)) continue;
      fail.run(`legacy_preference_context_ref_retired: ${retiredMessage}`, now, now, row.id);
    }
  }

  if (changedTasks.size > 0) {
    const now = new Date().toISOString();
    const read = db.prepare('SELECT status, state_detail_json FROM tasks WHERE id = ?');
    const mark = db.prepare(`
      UPDATE tasks
      SET status = 'needs_action', state_version = state_version + 1,
          state_detail_json = ?, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running', 'needs_action')
    `);
    for (const taskId of changedTasks) {
      const task = read.get(taskId) as { status: string; state_detail_json: string } | undefined;
      if (!task) continue;
      if (!['queued', 'running', 'needs_action'].includes(task.status)) continue;
      const detail = parseObject(task.state_detail_json) ?? {};
      detail.reason = {
        code: 'requirements_incomplete',
        message: retiredMessage,
        evidenceRefs: [],
      };
      detail.phase = null;
      detail.pendingActions = [];
      detail.nextWakeAt = null;
      mark.run(JSON.stringify(detail), now, taskId);
    }
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_preferences_scope;
    DROP INDEX IF EXISTS idx_preferences_status;
    DROP INDEX IF EXISTS idx_reflection_events_task;
    DROP INDEX IF EXISTS idx_reflection_events_source;
    DROP INDEX IF EXISTS idx_learning_candidates_status;
    DROP INDEX IF EXISTS idx_learning_candidates_source_task;
    DROP TABLE IF EXISTS preference_usage;
    DROP TABLE IF EXISTS preferences;
    DROP TABLE IF EXISTS reflection_events;
    DROP TABLE IF EXISTS learning_candidates;
  `);
  if (columnsOf(db, 'tasks').includes('injected_prefs_json')) {
    db.exec('ALTER TABLE tasks DROP COLUMN injected_prefs_json');
  }
}

function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Whether a persisted plan payload contains a retired `preference` ContextRef. */
function planPayloadHasPreferenceRef(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const proposal = (payload as { proposal?: unknown }).proposal ?? payload;
  if (!proposal || typeof proposal !== 'object') return false;
  const subtasks = (proposal as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(subtasks)) return false;
  return subtasks.some(subtask => {
    if (!subtask || typeof subtask !== 'object') return false;
    const refs = (subtask as { contextRefs?: unknown }).contextRefs;
    return Array.isArray(refs)
      && refs.some(ref => (ref as { kind?: unknown } | null)?.kind === 'preference');
  });
}

function runBaseMigrations(
  db: Database.Database,
  migrationContext?: Schema30MigrationContext,
): void {
  if (tableExists(db, 'schema_version')) {
    const versions = db.prepare(
      'SELECT version FROM schema_version ORDER BY version',
    ).all() as Array<{ version: number }>;
    if (versions.length === 1 && [42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, CURRENT_SCHEMA_VERSION].includes(versions[0]!.version)) {
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 41) {
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 40) {
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 39) {
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 31) {
      migrateSchema31To32(db);
      migrateSchema32To33(db);
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 32) {
      migrateSchema32To33(db);
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 33) {
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 34) {
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 35) {
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 36) {
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 37) {
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 38) {
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 30) {
      if (
        !migrationContext
        || !sealedSchema30MigrationContexts.has(migrationContext as object)
      ) {
        throw new Error('schema 30 to 31 migration requires sealed context');
      }
      migrateSchema30To31(db, migrationContext);
      migrateSchema31To32(db);
      migrateSchema32To33(db);
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      migrateSchema37To38(db);
      migrateSchema38To39(db);
      migrateSchema39To40(db);
      migrateSchema40To41(db);
      migrateSchema41To42(db);
      return;
    }
    const found = versions.map(row => row.version).join(', ') || 'empty';
    throw new Error(
      `unsupported pre-release SQLite schema (${found}); create a fresh database for schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  const existing = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  if (existing.length > 0) {
    throw new Error(
      `unsupported pre-release SQLite database without schema_version (${existing.map(row => row.name).join(', ')})`,
    );
  }

  db.transaction(() => {
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY)');
    db.exec(CURRENT_SCHEMA_SQL);
    db.exec('ALTER TABLE tasks ADD COLUMN public_task_directory TEXT');
    db.exec("ALTER TABLE tasks ADD COLUMN public_delivery_baseline_json TEXT NOT NULL DEFAULT '{}'");
    db.exec('ALTER TABLE tasks ADD COLUMN start_service_after_publish INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE tasks ADD COLUMN public_project INTEGER NOT NULL DEFAULT 0');
    db.exec("ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'in_place'");
    db.exec("ALTER TABLE task_artifacts ADD COLUMN reference_kind TEXT NOT NULL DEFAULT 'legacy_published_copy'");
    db.exec('ALTER TABLE task_artifacts ADD COLUMN workspace_id TEXT');
    db.exec('ALTER TABLE task_artifacts ADD COLUMN artifact_version_id TEXT');
    db.exec('ALTER TABLE task_artifacts ADD COLUMN source_relative_path TEXT');
    db.exec(WORKSPACE_EXECUTION_SQL);
    db.exec(WORKSPACE_CHANGE_RECORD_SQL);
    db.exec(ARTIFACT_VERSION_SQL);
    db.exec(PUBLICATION_DELIVERY_SQL);
    applyWorkspaceExecutionDecisionDdl(db);
    db.exec(RETRY_WAKE_SQL);
    db.exec(NAVIGATION_PROJECTION_SQL);
    // Fresh installs get the same columns the upgrade chain adds, without
    // rewiring the historical base schema.
    applySchema55Ddl(db);
    db.exec(MANAGED_SERVICES_SQL);
    db.exec(MEMORY_BINDINGS_SQL);
    db.exec(MEMORY_STATE_SQL);
    installObservationSchema(db);
    db.exec(`CREATE INDEX IF NOT EXISTS kernel_permission_resolution_request ON kernel_events
      (correlation_id) WHERE event_type = 'permission_resolution_received'`);
    db.exec(GATEWAY_COMMAND_ADMISSION_SQL);
    installDirectoryInvalidationTriggers(db);
    createBillingSchema(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)')
      .run(CURRENT_SCHEMA_VERSION);
  })();
}

function migrateSchema34To35(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const taskColumns = columnsOf(db, 'tasks');
    if (!taskColumns.includes('account_id')) {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN account_id TEXT NOT NULL DEFAULT 'legacy-account';
        ALTER TABLE tasks ADD COLUMN conversation_id TEXT NOT NULL DEFAULT 'legacy-conversation';
        ALTER TABLE tasks ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'legacy-workspace';
        ALTER TABLE tasks ADD COLUMN owner_planner_session_id TEXT NOT NULL DEFAULT 'legacy-planner-session';
        ALTER TABLE tasks ADD COLUMN admitted_at TEXT NOT NULL DEFAULT '';
      `);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_task_slots (
        conversation_id TEXT PRIMARY KEY,
        active_task_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('free', 'occupied', 'releasing', 'recovery_blocked')),
        reservation_id TEXT,
        fairness_sequence INTEGER NOT NULL DEFAULT 0,
        last_served_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (active_task_id) REFERENCES tasks(id)
      );
      CREATE TABLE IF NOT EXISTS task_schedule_entries (
        task_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'eligible', 'reserved', 'running', 'terminal')),
        enqueued_at TEXT NOT NULL,
        eligible_since TEXT NOT NULL,
        last_scheduled_at TEXT,
        scheduling_reason TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_conversation_status
        ON tasks(conversation_id, status, updated_at, id);
      CREATE INDEX IF NOT EXISTS idx_task_schedule_conversation
        ON task_schedule_entries(conversation_id, state, eligible_since, task_id);
      UPDATE schema_version SET version = 35 WHERE version = 34;
    `);
  });
  migrate();
}

function migrateSchema35To36(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const columns = columnsOf(db, 'task_schedule_entries');
    if (!columns.includes('payload_json')) {
      db.exec("ALTER TABLE task_schedule_entries ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}'");
    }
    db.exec('UPDATE schema_version SET version = 36 WHERE version = 35');
  });
  migrate();
}

function migrateSchema36To37(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE task_artifacts_v37 (
        artifact_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        generation_id TEXT,
        subtask_id TEXT,
        publication_id TEXT,
        display_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        published_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        preview_kind TEXT NOT NULL CHECK(preview_kind IN ('markdown', 'text', 'code', 'image', 'unsupported')),
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published', 'unavailable')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, task_id, relative_path, content_hash),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      INSERT INTO task_artifacts_v37 (
        artifact_id, account_id, task_id, generation_id, subtask_id,
        publication_id, display_name, relative_path, published_path,
        media_type, preview_kind, content_hash, byte_length, status,
        created_at, updated_at
      )
      SELECT
        artifact_id, account_id, task_id, generation_id, subtask_id,
        publication_id, display_name, relative_path, published_path,
        media_type, preview_kind, content_hash, byte_length, status,
        created_at, updated_at
      FROM task_artifacts;
      DROP TABLE task_artifacts;
      ALTER TABLE task_artifacts_v37 RENAME TO task_artifacts;
      CREATE INDEX idx_task_artifacts_task
        ON task_artifacts(task_id, created_at);
      CREATE INDEX idx_task_artifacts_publication
        ON task_artifacts(publication_id);
      UPDATE schema_version SET version = 37 WHERE version = 36;
    `);
  });
  migrate();
}

function migrateSchema37To38(db: Database.Database): void {
  const migrate = db.transaction(() => {
    if (!tableExists(db, 'planner_turn_inputs')) {
      db.exec(`
        CREATE TABLE planner_turn_inputs (
          conversation_id TEXT PRIMARY KEY,
          user_input_hash TEXT NOT NULL,
          attachment_views_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
    db.exec('UPDATE schema_version SET version = 38 WHERE version = 37;');
  });
  migrate();
}

function migrateSchema38To39(db: Database.Database): void {
  const migrate = db.transaction(() => {
    createBillingSchema(db);
    db.exec('UPDATE schema_version SET version = 39 WHERE version = 38;');
  });
  migrate();
}

function migrateSchema39To40(db: Database.Database): void {
  const migrate = db.transaction(() => {
    if (!columnsOf(db, 'query_usage_contexts').includes('external_account_ref')) {
      db.exec('ALTER TABLE query_usage_contexts ADD COLUMN external_account_ref TEXT');
    }
    if (!columnsOf(db, 'usage_observations').includes('cumulative_value')) {
      db.exec('ALTER TABLE usage_observations ADD COLUMN cumulative_value TEXT');
    }
    const updated = db.prepare(
      'UPDATE schema_version SET version = 40 WHERE version = 39',
    ).run();
    if (updated.changes !== 1) {
      throw new Error('schema version changed during 39 to 40 migration');
    }
  });
  migrate();
}

function migrateSchema41To42(db: Database.Database): void {
  const migrate = db.transaction(() => {
    // Tolerate partial fixtures: a schema-version row without the table is
    // upgraded by the fresh-schema path, not by this column addition.
    const columns = columnsOf(db, 'generation_replan_requests');
    if (columns.length > 0 && !columns.includes('planner_claim_token')) {
      db.exec('ALTER TABLE generation_replan_requests ADD COLUMN planner_claim_token TEXT');
    }
    const updated = db.prepare(
      'UPDATE schema_version SET version = 42 WHERE version = 41',
    ).run();
    if (updated.changes !== 1) {
      throw new Error('schema version changed during 41 to 42 migration');
    }
  });
  migrate();
}

function migrateSchema40To41(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const columns = columnsOf(db, 'usage_observations');
    if (!columns.includes('agent_class_ref')) {
      db.exec('ALTER TABLE usage_observations ADD COLUMN agent_class_ref TEXT');
    }
    if (!columns.includes('provider_ref')) {
      db.exec('ALTER TABLE usage_observations ADD COLUMN provider_ref TEXT');
    }
    if (!columns.includes('model_id')) {
      db.exec('ALTER TABLE usage_observations ADD COLUMN model_id TEXT');
    }
    const updated = db.prepare(
      'UPDATE schema_version SET version = 41 WHERE version = 40',
    ).run();
    if (updated.changes !== 1) {
      throw new Error('schema version changed during 40 to 41 migration');
    }
  });
  migrate();
}

function migrateSchema30To31(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  const existingViolations = db.pragma('foreign_key_check') as unknown[];
  if (existingViolations.length > 0) {
    throw new Error('schema 30 to 31 migration cannot start with foreign key violations');
  }
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    validateLegacyBindings(db, context);
    migrateRecoverableJson30To31(db, context);
    db.exec(`
      PRAGMA defer_foreign_keys = ON;
      DROP TABLE IF EXISTS guidance_events;
      CREATE TABLE configuration_revisions (
        revision_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('native', 'rollback', 'schema-30-import')),
        imported_at TEXT NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO configuration_revisions (
        revision_id, content_hash, source_kind, imported_at
      ) VALUES (?, ?, 'schema-30-import', ?)
    `).run(context.revisionId, context.contentHash, context.importedAt);
    db.exec(`
      ALTER TABLE subtasks
        RENAME COLUMN preferred_agent_class_list_json TO executor_bindings_json;
      ALTER TABLE planner_runs
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE planner_runs
        ADD COLUMN planner_binding_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE planner_runs
        ADD COLUMN planner_binding_fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE executor_attempt_receipts
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE executor_attempt_receipts
        ADD COLUMN authorized_binding_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE executor_attempt_receipts
        ADD COLUMN binding_fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE kernel_decisions
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE kernel_decisions
        ADD COLUMN authorized_bindings_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE kernel_decisions
        ADD COLUMN binding_fingerprints_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE kernel_events
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE work_graph_revisions
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE kernel_dispatch_items
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE kernel_dispatch_items
        ADD COLUMN authorized_binding_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE kernel_dispatch_items
        ADD COLUMN binding_fingerprint TEXT NOT NULL DEFAULT '';
      ALTER TABLE generation_replan_requests
        ADD COLUMN configuration_revision TEXT NOT NULL DEFAULT ''
          REFERENCES configuration_revisions(revision_id);
      ALTER TABLE generation_replan_requests
        ADD COLUMN deferred_bindings_json TEXT NOT NULL DEFAULT '[]';
    `);
    backfillSchema31Columns(db, context);
    rebuildSchema31AuditTables(db);
    rebuildWorkUnits(db, context);
    rebuildKernelExecutorStatus(db, context);
    createSchema31HealthTables(db);
    db.exec(`
      CREATE INDEX idx_configuration_revisions_content_hash
        ON configuration_revisions(content_hash, imported_at);
      CREATE INDEX idx_kernel_executor_status_revision
        ON kernel_executor_status(configuration_revision, agent_class_name);
      CREATE INDEX idx_kernel_provider_status_revision
        ON kernel_provider_status(configuration_revision, provider_health, provider_ref);
      CREATE INDEX idx_kernel_model_status_revision
        ON kernel_model_status(configuration_revision, model_health, provider_ref, model_ref);
      CREATE INDEX idx_kernel_binding_status_revision
        ON kernel_binding_status(configuration_revision, binding_health, agent_class_ref);
      CREATE TRIGGER configuration_revisions_immutable_update
        BEFORE UPDATE ON configuration_revisions BEGIN
          SELECT RAISE(ABORT, 'configuration_revisions are immutable');
        END;
      CREATE TRIGGER configuration_revisions_immutable_delete
        BEFORE DELETE ON configuration_revisions BEGIN
          SELECT RAISE(ABORT, 'configuration_revisions are immutable');
        END;
    `);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error('schema 30 to 31 migration produced foreign key violations');
    }
    const updated = db.prepare('UPDATE schema_version SET version = 31 WHERE version = 30').run();
    if (updated.changes !== 1) throw new Error('schema version changed during 30 to 31 migration');
  });
  try {
    migrate();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }
}

function migrateSchema31To32(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS result_objects (
        result_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        source_subtask_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('raw_attempt_output', 'business_result', 'safe_projection')),
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        media_type TEXT NOT NULL,
        storage_uri TEXT NOT NULL,
        completeness TEXT NOT NULL CHECK(completeness IN ('complete', 'partial', 'incomplete')),
        retention_class TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (source_subtask_id) REFERENCES subtasks(id)
      );
      CREATE TABLE IF NOT EXISTS result_references (
        reference_id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        source_subtask_id TEXT NOT NULL,
        target_subtask_id TEXT NOT NULL,
        edge_key TEXT NOT NULL,
        required_items_json TEXT NOT NULL DEFAULT '[]',
        read_scope_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (result_id) REFERENCES result_objects(result_id),
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (source_subtask_id) REFERENCES subtasks(id),
        FOREIGN KEY (target_subtask_id) REFERENCES subtasks(id),
        UNIQUE(result_id, source_subtask_id, target_subtask_id, edge_key)
      );
      CREATE INDEX IF NOT EXISTS idx_result_objects_attempt
        ON result_objects(account_id, task_id, attempt_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_result_objects_task
        ON result_objects(account_id, task_id, generation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_result_references_target
        ON result_references(account_id, task_id, target_subtask_id, created_at);
      CREATE TRIGGER IF NOT EXISTS result_objects_immutable_update
        BEFORE UPDATE ON result_objects BEGIN
          SELECT RAISE(ABORT, 'result_objects are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS result_objects_immutable_delete
        BEFORE DELETE ON result_objects BEGIN
          SELECT RAISE(ABORT, 'result_objects are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS result_references_immutable_update
        BEFORE UPDATE ON result_references BEGIN
          SELECT RAISE(ABORT, 'result_references are immutable');
        END;
      CREATE TRIGGER IF NOT EXISTS result_references_immutable_delete
        BEFORE DELETE ON result_references BEGIN
          SELECT RAISE(ABORT, 'result_references are immutable');
        END;
    `);
    const updated = db.prepare(
      'UPDATE schema_version SET version = 32 WHERE version = 31',
    ).run();
    if (updated.changes !== 1) {
      throw new Error('schema version changed during 31 to 32 migration');
    }
  });
  migrate();
}

function migrateSchema33To34(db: Database.Database): void {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_artifacts (
        artifact_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        generation_id TEXT,
        subtask_id TEXT,
        publication_id TEXT,
        display_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        published_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        preview_kind TEXT NOT NULL CHECK(preview_kind IN ('markdown', 'text', 'code', 'unsupported')),
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('published', 'unavailable')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(account_id, task_id, relative_path, content_hash),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_artifacts_task
        ON task_artifacts(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_artifacts_publication
        ON task_artifacts(publication_id);
    `);
    // 历史 tasks.artifacts_json 保持只读兼容：旧 artifact 的绝对路径不迁移、
    // 不暴露；无法安全映射为用户产物的记录保持不可见（unavailable 事实由
    // 运行时读取时按需落库），这里不做破坏性数据搬迁。
    const updated = db.prepare(
      'UPDATE schema_version SET version = 34 WHERE version = 33',
    ).run();
    if (updated.changes !== 1) {
      throw new Error('schema version changed during 33 to 34 migration');
    }
  });
  migrate();
}

function migrateSchema32To33(db: Database.Database): void {
  const migrate = db.transaction(() => {
    if (!columnsOf(db, 'planner_proposal_submissions').includes('configuration_revision')) {
      db.exec(`
        ALTER TABLE planner_proposal_submissions
          ADD COLUMN configuration_revision TEXT
            REFERENCES configuration_revisions(revision_id);
      `);
    }
    db.exec(`
      UPDATE planner_proposal_submissions
      SET configuration_revision = (
        SELECT configuration_revision
        FROM kernel_events
        WHERE kernel_events.id = planner_proposal_submissions.event_id
      )
      WHERE event_id IS NOT NULL AND configuration_revision IS NULL;
      CREATE INDEX IF NOT EXISTS idx_planner_proposal_submissions_revision
        ON planner_proposal_submissions(configuration_revision, status);
      UPDATE schema_version SET version = 33 WHERE version = 32;
    `);
  });
  migrate();
}

interface RecoverableJsonColumn {
  selectSql: string;
  updateSql: string;
  label: string;
}

function migrateRecoverableJson30To31(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  const columns: RecoverableJsonColumn[] = [
    {
      label: 'kernel_events.event_json',
      selectSql: `SELECT rowid AS rowId, event_json AS value FROM kernel_events WHERE status IN ('pending', 'processing')`,
      updateSql: 'UPDATE kernel_events SET event_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decisions.event_json',
      selectSql: `SELECT decision.rowid AS rowId, decision.event_json AS value
        FROM kernel_decisions decision
        JOIN kernel_decision_applications application ON application.decision_id = decision.id
        WHERE application.status <> 'applied'`,
      updateSql: 'UPDATE kernel_decisions SET event_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decisions.snapshot_json',
      selectSql: `SELECT decision.rowid AS rowId, decision.snapshot_json AS value
        FROM kernel_decisions decision
        JOIN kernel_decision_applications application ON application.decision_id = decision.id
        WHERE application.status <> 'applied'`,
      updateSql: 'UPDATE kernel_decisions SET snapshot_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decisions.decision_json',
      selectSql: `SELECT decision.rowid AS rowId, decision.decision_json AS value
        FROM kernel_decisions decision
        JOIN kernel_decision_applications application ON application.decision_id = decision.id
        WHERE application.status <> 'applied'`,
      updateSql: 'UPDATE kernel_decisions SET decision_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_decision_applications.observation_event_json',
      selectSql: `SELECT rowid AS rowId, observation_event_json AS value
        FROM kernel_decision_applications
        WHERE status <> 'applied' AND observation_event_json IS NOT NULL`,
      updateSql: 'UPDATE kernel_decision_applications SET observation_event_json = ? WHERE rowid = ?',
    },
    {
      label: 'kernel_dispatch_items.attempt_payload_json',
      selectSql: `SELECT rowid AS rowId, attempt_payload_json AS value
        FROM kernel_dispatch_items WHERE status NOT IN ('terminal', 'cancelled')`,
      updateSql: 'UPDATE kernel_dispatch_items SET attempt_payload_json = ? WHERE rowid = ?',
    },
    {
      label: 'generation_replan_requests.deferred_plan_json',
      selectSql: `SELECT rowid AS rowId, deferred_plan_json AS value
        FROM generation_replan_requests
        WHERE status NOT IN ('resolved', 'cancelled', 'failed') AND deferred_plan_json IS NOT NULL`,
      updateSql: 'UPDATE generation_replan_requests SET deferred_plan_json = ? WHERE rowid = ?',
    },
  ];
  for (const column of columns) migrateJsonColumn(db, column, context);
}

function migrateJsonColumn(
  db: Database.Database,
  column: RecoverableJsonColumn,
  context: Schema30MigrationContext,
): void {
  const rows = db.prepare(column.selectSql).all() as Array<{ rowId: number; value: string }>;
  const update = db.prepare(column.updateSql);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value) as unknown;
    } catch (error) {
      throw new Error(`${column.label} row ${row.rowId} contains invalid recoverable JSON`, { cause: error });
    }
    const migrated = migrateRecoverableValue(
      parsed,
      `${column.label}[${row.rowId}]`,
      context,
    );
    if (migrated.changed) update.run(JSON.stringify(migrated.value), row.rowId);
  }
}

function validateLegacyBindings(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  const referenced = new Set<string>();
  const subtaskRows = db.prepare(`
    SELECT id, preferred_agent_class_list_json AS value FROM subtasks ORDER BY id
  `).all() as Array<{ id: string; value: string }>;
  for (const row of subtaskRows) {
    for (const name of parseLegacyJsonAgentClassList(
      row.value,
      `subtasks.${row.id}.preferred_agent_class_list_json`,
    )) {
      referenced.add(name);
    }
  }
  for (const table of [
    'work_units',
    'kernel_executor_status',
    'kernel_dispatch_items',
    'executor_attempt_receipts',
  ]) {
    const rows = db.prepare(`
      SELECT DISTINCT agent_class_name AS name FROM ${table}
      WHERE agent_class_name IS NOT NULL
    `).all() as Array<{ name: string }>;
    for (const row of rows) referenced.add(row.name);
  }
  for (const legacyName of [...referenced].sort()) {
    exactLegacyBinding(legacyName, context);
  }
}

function backfillSchema31Columns(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  const plannerBindingJson = JSON.stringify(
    authorizedBindingFor(context.plannerBinding, context.revisionId),
  );
  db.prepare(`
    UPDATE planner_runs
    SET configuration_revision = ?,
        planner_binding_json = ?,
        planner_binding_fingerprint = ?
  `).run(
    context.revisionId,
    plannerBindingJson,
    context.plannerBinding.bindingFingerprint,
  );
  db.prepare('UPDATE kernel_events SET configuration_revision = ?')
    .run(context.revisionId);
  db.prepare('UPDATE work_graph_revisions SET configuration_revision = ?')
    .run(context.revisionId);
  db.prepare(`
    UPDATE generation_replan_requests
    SET configuration_revision = ?,
        deferred_bindings_json = ?
  `).run(
    context.revisionId,
    JSON.stringify(Object.values(context.legacyAgentClassBindings)
      .map(binding => authorizedBindingFor(binding, context.revisionId))),
  );

  const updateSubtask = db.prepare(
    'UPDATE subtasks SET executor_bindings_json = ? WHERE rowid = ?',
  );
  const subtaskRows = db.prepare(`
    SELECT rowid AS rowId, executor_bindings_json AS value FROM subtasks
  `).all() as Array<{ rowId: number; value: string }>;
  for (const row of subtaskRows) {
    const legacy = parseLegacyJsonAgentClassList(
      row.value,
      `subtasks.executor_bindings_json[${row.rowId}]`,
    );
    updateSubtask.run(
      JSON.stringify(legacy.map(name => authorizedBindingFor(
        exactLegacyBinding(name, context),
        context.revisionId,
      ))),
      row.rowId,
    );
  }

  const updateDispatch = db.prepare(`
    UPDATE kernel_dispatch_items
    SET configuration_revision = ?,
        agent_class_name = ?,
        authorized_binding_json = ?,
        binding_fingerprint = ?
    WHERE rowid = ?
  `);
  const dispatchRows = db.prepare(`
    SELECT rowid AS rowId, agent_class_name AS agentClassName
    FROM kernel_dispatch_items
  `).all() as Array<{ rowId: number; agentClassName: string }>;
  for (const row of dispatchRows) {
    const binding = exactLegacyBinding(row.agentClassName, context);
    updateDispatch.run(
      context.revisionId,
      binding.agentClassRef,
      JSON.stringify(authorizedBindingFor(binding, context.revisionId)),
      binding.bindingFingerprint,
      row.rowId,
    );
  }

  const updateReceipt = db.prepare(`
    UPDATE executor_attempt_receipts
    SET configuration_revision = ?,
        agent_class_name = ?,
        authorized_binding_json = ?,
        binding_fingerprint = ?
    WHERE rowid = ?
  `);
  const receiptRows = db.prepare(`
    SELECT rowid AS rowId, agent_class_name AS agentClassName
    FROM executor_attempt_receipts
  `).all() as Array<{ rowId: number; agentClassName: string }>;
  for (const row of receiptRows) {
    const binding = exactLegacyBinding(row.agentClassName, context);
    updateReceipt.run(
      context.revisionId,
      binding.agentClassRef,
      JSON.stringify(authorizedBindingFor(binding, context.revisionId)),
      binding.bindingFingerprint,
      row.rowId,
    );
  }

  const bindings = Object.values(context.legacyAgentClassBindings);
  db.prepare(`
    UPDATE kernel_decisions
    SET configuration_revision = ?,
        authorized_bindings_json = ?,
        binding_fingerprints_json = ?
  `).run(
    context.revisionId,
    JSON.stringify(bindings.map(binding =>
      authorizedBindingFor(binding, context.revisionId))),
    JSON.stringify(bindings.map(binding => binding.bindingFingerprint)),
  );
}

function rebuildSchema31AuditTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE planner_runs_v31 (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      request_source TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      configuration_revision TEXT NOT NULL,
      planner_binding_json TEXT NOT NULL,
      planner_binding_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO planner_runs_v31 (
      id, session_id, request_source, status, attempt_count, duration_ms,
      error_summary, configuration_revision, planner_binding_json,
      planner_binding_fingerprint, created_at, completed_at
    )
    SELECT
      id, session_id, request_source, status, attempt_count, duration_ms,
      error_summary, configuration_revision, planner_binding_json,
      planner_binding_fingerprint, created_at, completed_at
    FROM planner_runs;
    DROP TABLE planner_runs;
    ALTER TABLE planner_runs_v31 RENAME TO planner_runs;
    CREATE INDEX idx_planner_runs_session
      ON planner_runs(session_id, created_at);
    CREATE INDEX idx_planner_runs_revision
      ON planner_runs(configuration_revision, created_at);

    CREATE TABLE executor_attempt_receipts_v31 (
      attempt_id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      work_unit_id TEXT NOT NULL,
      agent_class_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      terminal_state TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      completion_schema_version INTEGER,
      parsing_json TEXT NOT NULL DEFAULT '{}',
      verification_json TEXT NOT NULL DEFAULT '{}',
      error_code TEXT,
      error_detail TEXT,
      graph_revision INTEGER,
      generation_id TEXT,
      attempt_kind TEXT NOT NULL DEFAULT 'primary',
      source_attempt_id TEXT,
      failure_json TEXT,
      recovery_mode TEXT NOT NULL DEFAULT 'fresh',
      configuration_revision TEXT NOT NULL,
      authorized_binding_json TEXT NOT NULL,
      binding_fingerprint TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
      FOREIGN KEY (work_unit_id) REFERENCES work_units(id),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO executor_attempt_receipts_v31 (
      attempt_id, execution_id, task_id, subtask_id, work_unit_id,
      agent_class_name, started_at, completed_at, terminal_state, raw_response,
      completion_schema_version, parsing_json, verification_json, error_code,
      error_detail, graph_revision, generation_id, attempt_kind,
      source_attempt_id, failure_json, recovery_mode, configuration_revision,
      authorized_binding_json, binding_fingerprint
    )
    SELECT
      attempt_id, execution_id, task_id, subtask_id, work_unit_id,
      agent_class_name, started_at, completed_at, terminal_state, raw_response,
      completion_schema_version, parsing_json, verification_json, error_code,
      error_detail, graph_revision, generation_id, attempt_kind,
      source_attempt_id, failure_json, recovery_mode, configuration_revision,
      authorized_binding_json, binding_fingerprint
    FROM executor_attempt_receipts;
    DROP TABLE executor_attempt_receipts;
    ALTER TABLE executor_attempt_receipts_v31 RENAME TO executor_attempt_receipts;
    CREATE INDEX idx_executor_attempt_receipts_subtask
      ON executor_attempt_receipts(task_id, subtask_id, completed_at);
    CREATE INDEX idx_executor_attempt_receipts_binding
      ON executor_attempt_receipts(
        configuration_revision, binding_fingerprint, completed_at
      );
    CREATE TRIGGER executor_attempt_receipts_immutable_update
      BEFORE UPDATE ON executor_attempt_receipts BEGIN
        SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
      END;
    CREATE TRIGGER executor_attempt_receipts_immutable_delete
      BEFORE DELETE ON executor_attempt_receipts BEGIN
        SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
      END;

    CREATE TABLE kernel_decisions_v31 (
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
      authorized_bindings_json TEXT NOT NULL DEFAULT '[]',
      binding_fingerprints_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO kernel_decisions_v31 (
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    )
    SELECT
      id, schema_version, event_id, event_type, correlation_id, causation_id,
      session_id, task_id, subtask_id, attempt_id, event_json, snapshot_json,
      decision_json, action, reason, configuration_revision,
      authorized_bindings_json, binding_fingerprints_json, created_at
    FROM kernel_decisions;
    DROP TABLE kernel_decisions;
    ALTER TABLE kernel_decisions_v31 RENAME TO kernel_decisions;
    CREATE INDEX idx_kernel_decisions_session
      ON kernel_decisions(session_id, created_at, id);
    CREATE INDEX idx_kernel_decisions_task
      ON kernel_decisions(task_id, created_at, id);
    CREATE INDEX idx_kernel_decisions_correlation
      ON kernel_decisions(correlation_id, created_at, id);
    CREATE INDEX idx_kernel_decisions_revision
      ON kernel_decisions(configuration_revision, created_at, id);

    CREATE TABLE kernel_events_v31 (
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
      status TEXT NOT NULL DEFAULT 'pending',
      processing_started_at TEXT,
      processed_at TEXT,
      last_error TEXT,
      configuration_revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO kernel_events_v31 (
      id, schema_version, event_type, correlation_id, causation_id, session_id,
      task_id, subtask_id, attempt_id, event_json, available_at, status,
      processing_started_at, processed_at, last_error, configuration_revision,
      created_at, updated_at
    )
    SELECT
      id, schema_version, event_type, correlation_id, causation_id, session_id,
      task_id, subtask_id, attempt_id, event_json, available_at, status,
      processing_started_at, processed_at, last_error, configuration_revision,
      created_at, updated_at
    FROM kernel_events;
    DROP TABLE kernel_events;
    ALTER TABLE kernel_events_v31 RENAME TO kernel_events;
    CREATE INDEX idx_kernel_events_drain
      ON kernel_events(status, available_at, created_at, id);
    CREATE INDEX idx_kernel_events_task
      ON kernel_events(task_id, created_at, id);
    CREATE INDEX idx_kernel_events_revision
      ON kernel_events(configuration_revision, status, available_at, id);

    CREATE TABLE work_graph_revisions_v31 (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      generation_id TEXT NOT NULL,
      authorized_decision_id TEXT,
      proposal_source TEXT NOT NULL DEFAULT 'initial',
      automatic_replan INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completion_kind TEXT CHECK(completion_kind IN ('full', 'partial_accepted')),
      configuration_revision TEXT NOT NULL,
      UNIQUE(task_id, revision),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (authorized_decision_id) REFERENCES kernel_decisions(id),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO work_graph_revisions_v31 (
      id, task_id, revision, generation_id, authorized_decision_id,
      proposal_source, automatic_replan, status, created_at, updated_at,
      completion_kind, configuration_revision
    )
    SELECT
      id, task_id, revision, generation_id, authorized_decision_id,
      proposal_source, automatic_replan, status, created_at, updated_at,
      completion_kind, configuration_revision
    FROM work_graph_revisions;
    DROP TABLE work_graph_revisions;
    ALTER TABLE work_graph_revisions_v31 RENAME TO work_graph_revisions;
    CREATE UNIQUE INDEX idx_work_graph_one_active_revision
      ON work_graph_revisions(task_id) WHERE status = 'active';
    CREATE INDEX idx_work_graph_revisions_generation
      ON work_graph_revisions(task_id, generation_id, revision);
    CREATE INDEX idx_work_graph_revisions_revision
      ON work_graph_revisions(configuration_revision, generation_id, revision);

    CREATE TABLE kernel_dispatch_items_v31 (
      attempt_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      batch_order INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      subtask_id TEXT NOT NULL,
      agent_class_name TEXT NOT NULL,
      attempt_kind TEXT NOT NULL CHECK(attempt_kind IN (
        'primary', 'continuation', 'fallback', 'contract_correction', 'merge_repair'
      )),
      source_attempt_id TEXT,
      recovery_mode TEXT NOT NULL CHECK(recovery_mode IN (
        'native_session', 'recovery_packet', 'fresh'
      )),
      attempt_payload_json TEXT NOT NULL DEFAULT 'null',
      resource_grant_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN (
        'pending_launch', 'launching', 'running', 'cancelling',
        'terminal', 'cancelled', 'uncertain'
      )),
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
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO kernel_dispatch_items_v31 (
      attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
      agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
      attempt_payload_json, resource_grant_json, status, work_unit_id,
      sandbox_container_id, launch_started_at, terminal_at,
      cancellation_decision_id, cancel_requested_at, cancelled_at,
      error_summary, configuration_revision, authorized_binding_json,
      binding_fingerprint, created_at, updated_at
    )
    SELECT
      attempt_id, decision_id, batch_order, task_id, generation_id, subtask_id,
      agent_class_name, attempt_kind, source_attempt_id, recovery_mode,
      attempt_payload_json, resource_grant_json, status, work_unit_id,
      sandbox_container_id, launch_started_at, terminal_at,
      cancellation_decision_id, cancel_requested_at, cancelled_at,
      error_summary, configuration_revision, authorized_binding_json,
      binding_fingerprint, created_at, updated_at
    FROM kernel_dispatch_items;
    DROP TABLE kernel_dispatch_items;
    ALTER TABLE kernel_dispatch_items_v31 RENAME TO kernel_dispatch_items;
    CREATE INDEX idx_kernel_dispatch_items_supervisor
      ON kernel_dispatch_items(status, batch_order, created_at, attempt_id);
    CREATE INDEX idx_kernel_dispatch_items_task
      ON kernel_dispatch_items(task_id, status, batch_order);
    CREATE INDEX idx_kernel_dispatch_items_binding
      ON kernel_dispatch_items(
        configuration_revision, binding_fingerprint, status
      );
    CREATE UNIQUE INDEX idx_kernel_dispatch_one_active_subtask
      ON kernel_dispatch_items(task_id, generation_id, subtask_id)
      WHERE status IN ('pending_launch', 'launching', 'running', 'cancelling');

    CREATE TABLE generation_replan_requests_v31 (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending_quiescence', 'planning', 'submitted', 'waiting_for_availability',
        'resolved', 'cancelled', 'failed'
      )),
      trigger_decision_id TEXT NOT NULL,
      quiescence_token TEXT,
      error_summary TEXT,
      deferred_plan_json TEXT,
      availability_explanation TEXT,
      planning_started_at TEXT,
      submitted_at TEXT,
      resolved_at TEXT,
      cancelled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      deferred_bindings_json TEXT NOT NULL DEFAULT '[]',
      UNIQUE(task_id, generation_id, source_revision),
      FOREIGN KEY (task_id) REFERENCES tasks(id),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    INSERT INTO generation_replan_requests_v31 (
      id, task_id, generation_id, source_revision, status, trigger_decision_id,
      quiescence_token, error_summary, deferred_plan_json,
      availability_explanation, planning_started_at, submitted_at, resolved_at,
      cancelled_at, created_at, updated_at, configuration_revision,
      deferred_bindings_json
    )
    SELECT
      id, task_id, generation_id, source_revision, status, trigger_decision_id,
      quiescence_token, error_summary, deferred_plan_json,
      availability_explanation, planning_started_at, submitted_at, resolved_at,
      cancelled_at, created_at, updated_at, configuration_revision,
      deferred_bindings_json
    FROM generation_replan_requests;
    DROP TABLE generation_replan_requests;
    ALTER TABLE generation_replan_requests_v31
      RENAME TO generation_replan_requests;
    CREATE INDEX idx_generation_replan_requests_status
      ON generation_replan_requests(status, created_at, id);
    CREATE INDEX idx_generation_replan_requests_task
      ON generation_replan_requests(task_id, generation_id, status);
    CREATE INDEX idx_generation_replan_requests_revision
      ON generation_replan_requests(configuration_revision, status, created_at);
  `);
}

function rebuildWorkUnits(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  const rows = db.prepare(`
    SELECT rowid AS rowId, agent_class_name AS agentClassName FROM work_units
  `).all() as Array<{ rowId: number; agentClassName: string }>;
  const update = db.prepare(
    'UPDATE work_units SET agent_class_name = ? WHERE rowid = ?',
  );
  for (const row of rows) {
    update.run(exactLegacyBinding(row.agentClassName, context).agentClassRef, row.rowId);
  }
  db.exec(`
    CREATE TABLE work_units_v31 (
      id TEXT PRIMARY KEY,
      agent_class_name TEXT NOT NULL,
      agent_class_kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'starting',
      claimed_task_id TEXT,
      claimed_subtask_id TEXT,
      heartbeat_at TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_attempt_id TEXT
    );
    INSERT INTO work_units_v31 (
      id, agent_class_name, agent_class_kind, state, claimed_task_id,
      claimed_subtask_id, heartbeat_at, lease_expires_at, created_at,
      updated_at, claimed_attempt_id
    )
    SELECT
      id, agent_class_name, agent_class_kind, state, claimed_task_id,
      claimed_subtask_id, heartbeat_at, lease_expires_at, created_at,
      updated_at, claimed_attempt_id
    FROM work_units;
    DROP TABLE work_units;
    ALTER TABLE work_units_v31 RENAME TO work_units;
    CREATE INDEX idx_work_units_state
      ON work_units(agent_class_kind, state, updated_at);
    CREATE UNIQUE INDEX idx_work_units_one_active_attempt_per_subtask
      ON work_units(claimed_subtask_id)
      WHERE claimed_subtask_id IS NOT NULL
        AND state IN ('claimed', 'running', 'waiting');
  `);
}

function rebuildKernelExecutorStatus(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  db.exec(`
    CREATE TABLE kernel_executor_status_v31 (
      agent_class_name TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      class_health TEXT NOT NULL DEFAULT 'unverified',
      recent_attempts_json TEXT NOT NULL DEFAULT '[]',
      recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_class_name, configuration_revision),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
  `);
  const insert = db.prepare(`
    INSERT INTO kernel_executor_status_v31 (
      agent_class_name, configuration_revision, class_health,
      recent_attempts_json, recent_recovery_checks_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const rows = db.prepare(`
    SELECT agent_class_name AS agentClassName, class_health AS classHealth,
           recent_attempts_json AS recentAttemptsJson,
           recent_recovery_checks_json AS recentRecoveryChecksJson,
           updated_at AS updatedAt
    FROM kernel_executor_status
  `).all() as Array<{
    agentClassName: string;
    classHealth: string;
    recentAttemptsJson: string;
    recentRecoveryChecksJson: string;
    updatedAt: string;
  }>;
  for (const row of rows) {
    const binding = exactLegacyBinding(row.agentClassName, context);
    insert.run(
      binding.agentClassRef,
      context.revisionId,
      row.classHealth,
      row.recentAttemptsJson,
      row.recentRecoveryChecksJson,
      row.updatedAt,
    );
  }
  db.exec(`
    DROP TABLE kernel_executor_status;
    ALTER TABLE kernel_executor_status_v31 RENAME TO kernel_executor_status;
  `);
}

function createSchema31HealthTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE kernel_provider_status (
      provider_ref TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      provider_health TEXT NOT NULL DEFAULT 'unverified'
        CHECK(provider_health IN ('unverified', 'healthy', 'error', 'disabled')),
      recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_ref, configuration_revision),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    CREATE TABLE kernel_model_status (
      provider_ref TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      configuration_revision TEXT NOT NULL,
      model_health TEXT NOT NULL DEFAULT 'unverified'
        CHECK(model_health IN ('unverified', 'healthy', 'error', 'disabled')),
      recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_ref, model_ref, configuration_revision),
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
    CREATE TABLE kernel_binding_status (
      binding_fingerprint TEXT PRIMARY KEY,
      configuration_revision TEXT NOT NULL,
      agent_class_ref TEXT NOT NULL,
      harness_ref TEXT NOT NULL,
      provider_ref TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      permission_profile_ref TEXT NOT NULL,
      binding_health TEXT NOT NULL DEFAULT 'unverified'
        CHECK(binding_health IN ('unverified', 'healthy', 'error', 'disabled')),
      recent_attempts_json TEXT NOT NULL DEFAULT '[]',
      recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (configuration_revision)
        REFERENCES configuration_revisions(revision_id)
    );
  `);
}

function parseLegacyJsonAgentClassList(value: string, path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${path} contains invalid recoverable JSON`, { cause: error });
  }
  return parseLegacyAgentClassList(parsed, path);
}

function parseLegacyAgentClassList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty legacy AgentClass list`);
  }
  const names = value.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${path}[${index}] must be a non-empty AgentClass name`);
    }
    return item;
  });
  if (new Set(names).size !== names.length) {
    throw new Error(`${path} contains duplicate legacy AgentClass names`);
  }
  return names;
}

function exactLegacyBinding(
  legacyName: string,
  context: Schema30MigrationContext,
): Readonly<Schema30MigrationBinding> {
  const binding = context.legacyAgentClassBindings[legacyName];
  if (!binding) {
    throw new Error(`legacy AgentClass ${legacyName} has no exact schema 31 binding`);
  }
  return binding;
}

function proposedBindingFor(
  legacyName: string,
  context: Schema30MigrationContext,
): Record<string, unknown> {
  const binding = exactLegacyBinding(legacyName, context);
  return {
    agentClassRef: binding.agentClassRef,
    modelSelection: { mode: 'fixed-by-agent-class' },
  };
}

function authorizedBindingFor(
  binding: Readonly<Schema30MigrationBinding>,
  configurationRevision: string,
): Record<string, unknown> {
  return {
    agentClassRef: binding.agentClassRef,
    harnessRef: binding.harnessRef,
    modelRef: binding.modelRef,
    providerRef: binding.providerRef,
    permissionProfileRef: binding.permissionProfileRef,
    configurationRevision,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function migrateRecoverableValue(
  value: unknown,
  path: string,
  context: Schema30MigrationContext,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const migrated = value.map((item, index) => {
      const result = migrateRecoverableValue(item, `${path}[${index}]`, context);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? migrated : value, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  const source = value as Record<string, unknown>;
  if (isPlanningAgentPlanV7(source)) {
    return { value: migratePlanningAgentPlanV7(source, path, context), changed: true };
  }
  if (isWorkGraphV6(source)) {
    return { value: migrateWorkGraphV6(source, path, context), changed: true };
  }
  const target: Record<string, unknown> = {};
  let changed = false;
  for (const [key, item] of Object.entries(source)) {
    const result = migrateRecoverableValue(item, `${path}.${key}`, context);
    target[key] = result.value;
    changed ||= result.changed;
  }
  return { value: changed ? target : value, changed };
}

function migratePlanningAgentPlanV7(
  source: Record<string, unknown>,
  path: string,
  context: Schema30MigrationContext,
): Record<string, unknown> {
  const target: Record<string, unknown> = { ...source, schemaVersion: 8 };
  if (source.workGraph !== null) {
    if (!isRecord(source.workGraph)) throw new Error(`${path}.workGraph is not an object`);
    target.workGraph = migrateWorkGraphV6(source.workGraph, `${path}.workGraph`, context);
  }
  return target;
}

function migrateWorkGraphV6(
  source: Record<string, unknown>,
  path: string,
  context: Schema30MigrationContext,
): Record<string, unknown> {
  if (!Array.isArray(source.subtasks)) throw new Error(`${path}.subtasks is not an array`);
  if (Object.hasOwn(source, 'schemaVersion')) {
    throw new Error(`${path} has ambiguous pre-existing schemaVersion`);
  }
  if (Object.hasOwn(source, 'configurationRevision')) {
    throw new Error(`${path} has ambiguous pre-existing configurationRevision`);
  }
  const subtasks = source.subtasks.map((value, index) => {
    if (!isRecord(value)) throw new Error(`${path}.subtasks[${index}] is not an object`);
    if (Object.hasOwn(value, 'executorBindings')) {
      throw new Error(`${path}.subtasks[${index}] has ambiguous executorBindings`);
    }
    const legacy = parseLegacyAgentClassList(
      value.preferredAgentClassList,
      `${path}.subtasks[${index}].preferredAgentClassList`,
    );
    const target = { ...value };
    delete target.preferredAgentClassList;
    target.executorBindings = legacy.map(name => proposedBindingFor(name, context));
    return target;
  });
  return {
    ...source,
    schemaVersion: 7,
    configurationRevision: context.revisionId,
    subtasks,
  };
}

function isPlanningAgentPlanV7(value: Record<string, unknown>): boolean {
  return typeof value.id === 'string'
    && value.schemaVersion === 7
    && typeof value.action === 'string'
    && Object.hasOwn(value, 'task')
    && Object.hasOwn(value, 'workGraph');
}

function isWorkGraphV6(value: Record<string, unknown>): boolean {
  if (
    typeof value.reason !== 'string'
    || !Array.isArray(value.subtasks)
    || value.subtasks.length === 0
  ) {
    return false;
  }
  return value.subtasks.every(subtask =>
    isRecord(subtask)
    && Object.hasOwn(subtask, 'preferredAgentClassList'));
}
