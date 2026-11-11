/** ADR-0055 D8: the sole fresh SQLite schema. No historical upgrades or bills. */
export const CURRENT_SCHEMA_VERSION = 68;

export const CURRENT_SCHEMA_SQL = `
      CREATE TABLE model_usage_facts (
        usage_id TEXT PRIMARY KEY,
        call_idempotency_key TEXT NOT NULL UNIQUE,
        query_id TEXT NOT NULL,
        task_id TEXT,
        provider_ref TEXT,
        model_id TEXT,
        agent_class_ref TEXT,
        payer TEXT NOT NULL DEFAULT 'unknown' CHECK(payer IN ('platform', 'user_direct', 'system', 'unknown')),
        input_tokens TEXT,
        output_tokens TEXT,
        cache_read_tokens TEXT,
        cache_write_tokens TEXT,
        reasoning_tokens TEXT,
        usage_source TEXT NOT NULL CHECK(usage_source IN ('reported', 'provider_unavailable')),
        occurred_at_utc TEXT NOT NULL,
        recorded_at_utc TEXT NOT NULL,
        source_id TEXT NOT NULL,
        provider_response_id TEXT,
        normalization_version TEXT NOT NULL
      );
      CREATE INDEX model_usage_facts_query ON model_usage_facts(query_id, occurred_at_utc);
      CREATE INDEX model_usage_facts_task ON model_usage_facts(task_id, occurred_at_utc);
      CREATE INDEX model_usage_facts_payer ON model_usage_facts(payer, occurred_at_utc);

CREATE TABLE schema_version (version INTEGER PRIMARY KEY);

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
          admitted_at TEXT NOT NULL DEFAULT '', public_task_directory TEXT, public_delivery_baseline_json TEXT NOT NULL DEFAULT '{}', start_service_after_publish INTEGER NOT NULL DEFAULT 0, public_project INTEGER NOT NULL DEFAULT 0, execution_mode TEXT, workspace_execution_source TEXT NOT NULL DEFAULT '', workspace_delivery_policy TEXT NOT NULL DEFAULT '', workspace_target_paths_json TEXT NOT NULL DEFAULT '[]', workspace_intent_json TEXT,
          -- A completion time only exists for a terminal Task. The other
          -- direction (terminal => completed_at) is guaranteed by the single
          -- state entry, which always stamps it on a terminal transition.
          CHECK (completed_at IS NULL
            OR status IN ('succeeded', 'failed', 'cancelled')));

CREATE TABLE task_state_changes (
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

CREATE INDEX task_state_changes_task_created
  ON task_state_changes(task_id, created_at, version);

CREATE INDEX task_state_changes_decision
  ON task_state_changes(decision_id);

CREATE TABLE task_operation_results (
  task_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'execution', 'integration', 'delivery', 'safety_report', 'service'
  )),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'definite_failure', 'unknown', 'repair_pending')),
  reason_code TEXT,
  message TEXT NOT NULL DEFAULT '',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, operation_key),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX task_operation_results_task
  ON task_operation_results(task_id, updated_at);

CREATE TABLE task_state_projection_outbox (
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

CREATE INDEX task_state_projection_outbox_pending
  ON task_state_projection_outbox(sequence) WHERE dispatched_at IS NULL;

CREATE TABLE interactions (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          user_input TEXT,
          system_output TEXT,
          executor_used TEXT,
          created_at TEXT NOT NULL
        , session_id TEXT, input_content_ref TEXT, output_content_ref TEXT, derived_from_turn_id TEXT);

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
        updated_at TEXT NOT NULL, input_hash TEXT, source_turn_id TEXT,
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

CREATE TABLE executor_status (
        agent_class_name TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        class_health TEXT NOT NULL DEFAULT 'unverified',
        recent_attempts_json TEXT NOT NULL DEFAULT '[]',
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (agent_class_name, configuration_revision),
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE provider_status (
        provider_ref TEXT NOT NULL,
        configuration_revision TEXT NOT NULL,
        provider_health TEXT NOT NULL DEFAULT 'unverified'
          CHECK(provider_health IN ('unverified', 'healthy', 'error', 'disabled')),
        recent_recovery_checks_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider_ref, configuration_revision),
        FOREIGN KEY (configuration_revision) REFERENCES configuration_revisions(revision_id)
      );

CREATE TABLE model_status (
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

CREATE TABLE binding_status (
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
          updated_at TEXT NOT NULL, graph_revision INTEGER, generation_id TEXT, workspace_effect TEXT CHECK(workspace_effect IN ('read_only','write','unknown')),
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

  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  exact_only INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, content_ref TEXT,
  PRIMARY KEY (task_id, id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)

        );

CREATE TABLE effect_outbox (
            id TEXT PRIMARY KEY,
            -- Operation identity. Task Runtime operations (ADR-0055 §6) own
            -- effects without a Kernel Decision, so this column is deliberately
            -- not a foreign key to a decision row.
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
            updated_at TEXT NOT NULL
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
          , write_started_at TEXT, write_finished_at TEXT, receipt_persisted_at TEXT, external_effect_status TEXT NOT NULL DEFAULT 'none', change_record_id TEXT, worktree_id TEXT, worktree_incarnation INTEGER, before_commit TEXT, after_commit TEXT);

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
            FOREIGN KEY (request_id) REFERENCES permission_requests(id)
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

CREATE TABLE "dispatch_items" (
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
            updated_at TEXT NOT NULL, execution_binding_fingerprint TEXT, terminal_disposition TEXT,
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
            updated_at TEXT NOT NULL, delivery_authorized_at TEXT,
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
            deferred_bindings_json TEXT NOT NULL DEFAULT '{}',
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

CREATE INDEX idx_executor_status_revision
        ON executor_status(configuration_revision, agent_class_name);

CREATE INDEX idx_provider_status_revision
        ON provider_status(configuration_revision, provider_health, provider_ref);

CREATE INDEX idx_model_status_revision
        ON model_status(configuration_revision, model_health, provider_ref, model_ref);

CREATE INDEX idx_binding_status_revision
        ON binding_status(configuration_revision, binding_health, agent_class_ref);

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

CREATE INDEX idx_effect_outbox_drain
            ON effect_outbox(status, available_at, created_at, id);

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

CREATE INDEX idx_dispatch_items_supervisor
            ON dispatch_items(status, batch_order, created_at, attempt_id);

CREATE INDEX idx_dispatch_items_task
            ON dispatch_items(task_id, status, batch_order);

CREATE INDEX idx_dispatch_items_binding
            ON dispatch_items(configuration_revision, binding_fingerprint, status);

CREATE UNIQUE INDEX idx_dispatch_one_active_subtask
            ON dispatch_items(task_id, generation_id, subtask_id)
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
            updated_at TEXT NOT NULL, reference_kind TEXT NOT NULL DEFAULT 'legacy_published_copy', workspace_id TEXT, artifact_version_id TEXT, source_relative_path TEXT,
            UNIQUE(account_id, task_id, relative_path, content_hash),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
          );

CREATE INDEX idx_task_artifacts_task
            ON task_artifacts(task_id, created_at);

CREATE INDEX idx_task_artifacts_publication
            ON task_artifacts(publication_id);

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

CREATE TABLE conversation_turn_bodies (
  account_id TEXT NOT NULL, body_hash TEXT NOT NULL, body BLOB NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0), format TEXT NOT NULL DEFAULT 'text/plain',
  created_at TEXT NOT NULL, PRIMARY KEY(account_id, body_hash)
);

CREATE TABLE conversation_turns (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  sequence INTEGER NOT NULL, request_key TEXT NOT NULL, user_input_hash TEXT NOT NULL,
  final_answer_revision INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id),
  UNIQUE(account_id, conversation_id, sequence), UNIQUE(account_id, conversation_id, request_key),
  FOREIGN KEY(account_id, user_input_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);

CREATE TABLE conversation_turn_answers (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  revision INTEGER NOT NULL, revision_key TEXT NOT NULL, body_hash TEXT NOT NULL,
  source_task_id TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id, revision),
  UNIQUE(account_id, conversation_id, turn_id, revision_key),
  FOREIGN KEY(account_id, conversation_id, turn_id) REFERENCES conversation_turns(account_id, conversation_id, turn_id) ON DELETE CASCADE,
  FOREIGN KEY(account_id, body_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);

CREATE TABLE conversation_turn_outbox (
  account_id TEXT NOT NULL, event_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  event_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, event_id)
);

CREATE TABLE conversation_deletions (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','completed')), created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id)
);

CREATE TABLE conversation_turn_cancellations (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  requested_at TEXT NOT NULL, PRIMARY KEY(account_id, conversation_id, turn_id)
);

CREATE TABLE conversation_turn_migration (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  classification TEXT NOT NULL, evidence_json TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id)
);

CREATE TABLE conversation_derived_content (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  derived_from_turn_id TEXT, kind TEXT NOT NULL, body_hash TEXT NOT NULL,
  FOREIGN KEY(account_id, body_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);

CREATE TABLE conversation_result_content_refs (
  result_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, body_hash TEXT NOT NULL,
  FOREIGN KEY(account_id, body_hash) REFERENCES conversation_turn_bodies(account_id, body_hash)
);

CREATE TABLE conversation_memory_attempts (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, started_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id)
);

CREATE TABLE planner_transcript_turns (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  planner_session_id TEXT NOT NULL, input_hash TEXT NOT NULL, transcript_hash TEXT NOT NULL,
  integrity TEXT NOT NULL CHECK(integrity IN ('match','derived')), created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id, planner_session_id)
);

CREATE TABLE conversation_memory_receipts (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, answer_hash TEXT NOT NULL, acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(account_id, conversation_id, turn_id, input_hash, answer_hash)
);

CREATE VIEW conversation_memory_turns AS
SELECT t.account_id, t.conversation_id, t.turn_id, t.sequence AS first_sequence,
  t.user_input_hash AS input_hash, a.body_hash AS answer_hash,
  EXISTS (SELECT 1 FROM conversation_memory_receipts r WHERE r.account_id = t.account_id
    AND r.conversation_id = t.conversation_id AND r.turn_id = t.turn_id
    AND r.input_hash = t.user_input_hash AND r.answer_hash = a.body_hash) AS deposited,
  json_set(h.body_json, '$.interactionKind', COALESCE(json_extract(h.body_json, '$.interactionKind'), 'ai_turn'),
    '$.status', CASE task.status WHEN 'succeeded' THEN 'completed' WHEN 'needs_action' THEN 'blocked'
      WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' WHEN 'running' THEN 'running'
      WHEN 'queued' THEN 'running' WHEN 'pending' THEN 'running' ELSE json_extract(h.body_json, '$.status') END,
    '$.startedAt', t.created_at, '$.completedAt', COALESCE(a.created_at, t.created_at), '$.id', t.turn_id) AS body_json
FROM conversation_turns t JOIN conversation_history_turns h
  ON h.account_id = t.account_id AND h.conversation_id = t.conversation_id AND h.turn_id = t.turn_id AND h.kind = 'conversation'
LEFT JOIN conversation_turn_answers a ON a.account_id = t.account_id AND a.conversation_id = t.conversation_id
  AND a.turn_id = t.turn_id AND a.revision = t.final_answer_revision
LEFT JOIN tasks task ON task.id = COALESCE(a.source_task_id, json_extract(h.body_json, '$.taskId'))
  AND task.account_id = t.account_id AND task.conversation_id = t.conversation_id
WHERE NOT EXISTS (SELECT 1 FROM conversation_deletions d WHERE d.account_id = t.account_id AND d.conversation_id = t.conversation_id);

CREATE VIEW interaction_contents AS
    SELECT i.id, i.task_id, i.session_id, i.executor_used, i.created_at, i.derived_from_turn_id, ir.kind AS input_kind,
      CASE WHEN i.input_content_ref IS NULL THEN i.user_input ELSE CAST(ib.body AS TEXT) END AS user_input,
      CASE WHEN i.output_content_ref IS NULL THEN i.system_output ELSE CAST(ob.body AS TEXT) END AS system_output
    FROM interactions i
    LEFT JOIN conversation_derived_content ir ON ir.id = i.input_content_ref
    LEFT JOIN conversation_turn_bodies ib ON ib.account_id = ir.account_id AND ib.body_hash = ir.body_hash
    LEFT JOIN conversation_derived_content ore ON ore.id = i.output_content_ref
    LEFT JOIN conversation_turn_bodies ob ON ob.account_id = ore.account_id AND ob.body_hash = ore.body_hash;

CREATE TRIGGER trg_task_search_index_interactions_insert AFTER INSERT ON interactions WHEN NEW.task_id IS NOT NULL BEGIN
      DELETE FROM task_search_index WHERE source_kind = 'interaction' AND source_id = NEW.id;
      INSERT INTO task_search_index(task_id, source_kind, source_id, title, body, tags, created_at, updated_at)
      SELECT task_id, 'interaction', id, '', substr(COALESCE(user_input,'') || char(10) || COALESCE(system_output,''), 1, 4000),
        'interaction', created_at, created_at FROM interaction_contents WHERE id = NEW.id;
    END;

CREATE TABLE workspace_execution_bindings (
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

CREATE TABLE workspace_change_records (
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

CREATE INDEX idx_workspace_change_records_task
    ON workspace_change_records(task_id, created_at);

CREATE INDEX idx_workspace_change_records_attempt
    ON workspace_change_records(attempt_id, created_at);

CREATE TABLE artifact_versions (
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
    created_at TEXT NOT NULL, git_commit TEXT, git_relative_path TEXT,
    UNIQUE(workspace_id, relative_path, content_hash)
  );

CREATE TABLE workspace_publication_deliveries (
    publication_id TEXT PRIMARY KEY REFERENCES workspace_publications(id),
    status TEXT NOT NULL CHECK(status IN ('pending', 'failed', 'succeeded')),
    projections_json TEXT NOT NULL DEFAULT '[]',
    failures_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );

CREATE INDEX workspace_publication_delivery_status ON workspace_publication_deliveries(status, publication_id);

CREATE TABLE retry_wakes (
    wake_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    -- The Session that armed the wake: delivery reads it from this fact, so a
    -- retry needs no ledger or Session reconstruction lookup.
    session_id TEXT,
    subtask_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    source_decision_id TEXT NOT NULL UNIQUE,
    source_attempt_id TEXT NOT NULL,
    configuration_revision TEXT NOT NULL,
    binding_fingerprint TEXT NOT NULL,
    authorized_binding_json TEXT NOT NULL,
    resume_at TEXT NOT NULL,
    wake_kind TEXT NOT NULL DEFAULT 'retry',
    status TEXT NOT NULL CHECK (status IN ('armed', 'fired', 'consumed', 'superseded', 'recovery_required')),
    timer_event_id TEXT UNIQUE,
    consumed_decision_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX retry_wakes_due
    ON retry_wakes (status, resume_at, wake_id);

CREATE INDEX retry_wakes_task
    ON retry_wakes (task_id, generation_id, status);

CREATE INDEX retry_wakes_decision
    ON retry_wakes (source_decision_id);

CREATE TABLE conversation_metadata_projection (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE gateway_journal_streams (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, last_sequence INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL, replay_floor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE gateway_journal_segments (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, segment_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, segment_id)
  );

CREATE INDEX gateway_journal_segment_range ON gateway_journal_segments
    (account_id, conversation_id, last_sequence);

CREATE TABLE gateway_journal_event_index (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, segment_id TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id, event_id)
  );

CREATE INDEX gateway_journal_event_segment ON gateway_journal_event_index
    (account_id, conversation_id, segment_id);

CREATE TABLE gateway_turn_task_observations (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    observation_json TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id, turn_id)
  );

CREATE TABLE conversation_history_streams (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
    last_sequence INTEGER NOT NULL, revision TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (account_id, conversation_id, kind)
  );

CREATE TABLE conversation_history_turns (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, kind TEXT NOT NULL,
    sequence INTEGER NOT NULL, turn_id TEXT NOT NULL, body_json TEXT NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, kind, sequence),
    UNIQUE (account_id, conversation_id, kind, turn_id)
  );

CREATE TRIGGER conversation_history_insert_revision
  AFTER INSERT ON conversation_history_turns BEGIN
    UPDATE conversation_history_streams SET revision = lower(hex(randomblob(16)))
    WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND kind = NEW.kind;
  END;

CREATE TRIGGER conversation_history_update_revision
  AFTER UPDATE ON conversation_history_turns BEGIN
    UPDATE conversation_history_streams SET revision = lower(hex(randomblob(16)))
    WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND kind = NEW.kind;
  END;

CREATE TRIGGER conversation_history_delete_revision
  AFTER DELETE ON conversation_history_turns BEGIN
    UPDATE conversation_history_streams SET revision = lower(hex(randomblob(16)))
    WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND kind = OLD.kind;
  END;

CREATE TABLE workspace_directory_projection (
    account_id TEXT NOT NULL, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    archived INTEGER NOT NULL, activity_rank INTEGER NOT NULL, updated_at TEXT NOT NULL,
    latest_task_created_at TEXT NOT NULL,
    title_search TEXT NOT NULL, summary_json TEXT NOT NULL, projection_version INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE INDEX workspace_directory_page ON workspace_directory_projection
    (account_id, workspace_id, archived, latest_task_created_at DESC, conversation_id ASC);

CREATE INDEX workspace_directory_all_page ON workspace_directory_projection
    (account_id, workspace_id, latest_task_created_at DESC, conversation_id ASC);

CREATE TABLE workspace_directory_revisions (
    account_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (account_id, workspace_id)
  );

CREATE TABLE workspace_directory_rebuilds (
    account_id TEXT PRIMARY KEY, projection_version INTEGER NOT NULL, status TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL, checkpoint TEXT NOT NULL
  );

CREATE TABLE workspace_directory_rebuild_candidates (
    account_id TEXT NOT NULL, rebuild_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    PRIMARY KEY (account_id, rebuild_id, conversation_id)
  );

CREATE TABLE workspace_directory_observations (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, rebuild_id TEXT NOT NULL,
    removed INTEGER NOT NULL CHECK (removed IN (0, 1)),
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE workspace_directory_dirty (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE public_workspace_files (
    account_id TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), relative_path TEXT NOT NULL,
    generation_id TEXT, subtask_id TEXT, publication_id TEXT, published_path TEXT NOT NULL,
    content_hash TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (account_id, task_id, relative_path)
  );

CREATE TABLE managed_local_services (
    service_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL DEFAULT '',
    task_id TEXT NOT NULL REFERENCES tasks(id),
    specification_revision TEXT NOT NULL DEFAULT '',
    specification_json TEXT NOT NULL,
    state TEXT NOT NULL,
    process_id INTEGER,
    process_token TEXT,
    source_task_id TEXT,
    operation_task_id TEXT,
    health_message TEXT,
    updated_at TEXT NOT NULL, source_commit TEXT, project_path TEXT, service_worktree_id TEXT,
    PRIMARY KEY (account_id, workspace_id, service_id)
  );

CREATE INDEX managed_services_task ON managed_local_services(account_id, task_id);

CREATE TABLE managed_local_service_effects (
    account_id TEXT NOT NULL, decision_id TEXT NOT NULL, effect_json TEXT NOT NULL,
    PRIMARY KEY (account_id, decision_id)
  );

CREATE TABLE memory_bindings (
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
  , layer TEXT NOT NULL DEFAULT 'l1' CHECK(layer IN ('l1','l2','l3')), tdai_revision TEXT, tdai_title TEXT NOT NULL DEFAULT '');

CREATE INDEX idx_memory_bindings_account
    ON memory_bindings(account_id, enabled);

CREATE TABLE memory_recall_candidates (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, memory_id TEXT NOT NULL,
    type TEXT NOT NULL, preview TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, layer TEXT NOT NULL DEFAULT 'l1' CHECK(layer IN ('l1','l2','l3')), revision TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'conversation',
    PRIMARY KEY (account_id, conversation_id, memory_id)
  );

CREATE INDEX idx_memory_recall_conversation
    ON memory_recall_candidates(account_id, conversation_id, score DESC);

CREATE TABLE memory_flush_state (
    account_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    last_sequence   INTEGER NOT NULL DEFAULT 0,
    sanitized       INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE INDEX idx_memory_flush_state_sequence
    ON memory_flush_state(account_id, last_sequence);

CREATE TABLE memory_recall_state (
    account_id      TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    degraded        INTEGER NOT NULL DEFAULT 0,
    reason          TEXT,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE memory_runtime_state (
    account_id TEXT PRIMARY KEY,
    mode       TEXT NOT NULL,
    detail     TEXT,
    updated_at TEXT NOT NULL
  );

CREATE UNIQUE INDEX idx_memory_bindings_account_layer_tdai
    ON memory_bindings(account_id, layer, tdai_memory_id);

CREATE TABLE memory_recall_layers (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    layer TEXT NOT NULL CHECK(layer IN ('l1','l2','l3')),
    status TEXT NOT NULL CHECK(status IN ('available','empty','degraded')),
    reason TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(account_id, conversation_id, layer)
  );

CREATE INDEX idx_memory_recall_candidates_layer
    ON memory_recall_candidates(account_id, conversation_id, layer, score DESC);

CREATE TABLE task_recovery_items (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'retry_authorized', 'assumed_applied')),
    apply_attempts INTEGER NOT NULL DEFAULT 1,
    observation_event_json TEXT,
    error_summary TEXT,
    decision_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task_id TEXT NOT NULL,
    subtask_id TEXT,
    attempt_id TEXT
  );

CREATE INDEX task_recovery_items_task
    ON task_recovery_items(task_id, status, created_at);

CREATE INDEX task_recovery_items_pending
    ON task_recovery_items(status, created_at, id);

CREATE TABLE conversation_observation_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL);

CREATE TABLE conversation_read_history_dirty (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(account_id, conversation_id, turn_id)
  );

CREATE TABLE conversation_read_tombstones (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    PRIMARY KEY(account_id, conversation_id, turn_id)
  );

CREATE TABLE client_navigation (
    account_id TEXT NOT NULL, principal_id TEXT NOT NULL, platform TEXT NOT NULL,
    channel_id TEXT NOT NULL, thread_id TEXT NOT NULL, workspace_id TEXT, conversation_id TEXT,
    PRIMARY KEY(account_id, principal_id, platform, channel_id, thread_id)
  );

CREATE TABLE conversation_activity_views (
    task_id TEXT PRIMARY KEY, body_json TEXT NOT NULL
  );

CREATE TABLE conversation_activity_dirty (
    task_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1
  );

CREATE TABLE conversation_read_history_checkpoint (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE conversation_read_heads (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, journal_sequence INTEGER NOT NULL DEFAULT 0, projector_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE conversation_read_rebuilds (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, journal_sequence INTEGER NOT NULL DEFAULT 0,
    history_sequence INTEGER NOT NULL DEFAULT 0, source_history_revision TEXT NOT NULL, projector_version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE conversation_read_turns (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL, turn_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL,
    body_json TEXT NOT NULL, byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, epoch, turn_id)
  );

CREATE INDEX conversation_read_turn_page ON conversation_read_turns
    (account_id, conversation_id, epoch, first_sequence DESC, turn_id DESC);

CREATE INDEX conversation_read_task_turn ON conversation_read_turns
    (account_id, conversation_id, epoch, json_extract(body_json, '$.taskId'));

CREATE INDEX conversation_read_answer_ref ON conversation_read_turns
    (account_id, conversation_id, json_extract(body_json, '$.answerRef.hash'));

CREATE INDEX conversation_read_input_ref ON conversation_read_turns
    (account_id, conversation_id, json_extract(body_json, '$.userInputRef.hash'));

CREATE INDEX conversation_read_active_turn_page ON conversation_read_turns
    (account_id, conversation_id, epoch, active, first_sequence DESC, turn_id DESC);

CREATE TABLE conversation_read_changes (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, epoch TEXT NOT NULL, revision INTEGER NOT NULL,
    body_json TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, epoch, revision)
  );

CREATE INDEX conversation_read_changes_age ON conversation_read_changes
    (account_id, created_at);

CREATE INDEX conversation_read_changes_answer ON conversation_read_changes
    (account_id, conversation_id, json_extract(body_json, '$.answerRef.hash'));

CREATE INDEX conversation_read_changes_input ON conversation_read_changes
    (account_id, conversation_id, json_extract(body_json, '$.userInputRef.hash'));

CREATE TABLE conversation_read_bodies (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
    body BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (account_id, conversation_id, hash)
  );

CREATE TABLE conversation_read_content_chunks (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
    byte_offset INTEGER NOT NULL, body BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (account_id, conversation_id, hash, byte_offset)
  );

CREATE TABLE conversation_read_content_manifests (
    account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL, byte_length INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (account_id, conversation_id, hash)
  );

CREATE INDEX conversation_read_bodies_gc ON conversation_read_bodies(account_id, conversation_id, created_at);

CREATE INDEX conversation_read_chunks_gc ON conversation_read_content_chunks(account_id, conversation_id, created_at);

CREATE INDEX conversation_read_manifests_gc ON conversation_read_content_manifests(account_id, conversation_id, created_at);

CREATE TABLE gateway_trace_read_heads (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    indexed_through INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, conversation_id)
  );

CREATE TABLE gateway_trace_read_events (
    account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    gateway_sequence INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    event_key TEXT NOT NULL,
    body_json TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    PRIMARY KEY (account_id, conversation_id, turn_id, event_id)
  );

CREATE INDEX gateway_trace_read_page ON gateway_trace_read_events
    (account_id, conversation_id, turn_id, sequence, event_key, event_id);

CREATE VIRTUAL TABLE conversation_content_search USING fts5(
  account_id UNINDEXED, conversation_id UNINDEXED, hash UNINDEXED, text,
  byte_offset UNINDEXED, tokenize = 'trigram'
);

CREATE TABLE conversation_content_search_queue (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0, prefix TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(account_id, conversation_id, hash)
);

CREATE TABLE conversation_content_search_chunks (
  account_id TEXT NOT NULL, conversation_id TEXT NOT NULL, hash TEXT NOT NULL,
  byte_offset INTEGER NOT NULL, search_rowid INTEGER NOT NULL,
  PRIMARY KEY(account_id, conversation_id, hash, byte_offset)
);

CREATE TRIGGER search_enqueue_conversation_read_bodies AFTER INSERT ON conversation_read_bodies BEGIN
      INSERT OR IGNORE INTO conversation_content_search_queue(account_id, conversation_id, hash)
        VALUES (NEW.account_id, NEW.conversation_id, NEW.hash);
    END;

CREATE TRIGGER search_remove_conversation_read_bodies AFTER DELETE ON conversation_read_bodies BEGIN
      DELETE FROM conversation_content_search WHERE rowid IN (
        SELECT search_rowid FROM conversation_content_search_chunks
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash);
      DELETE FROM conversation_content_search_chunks
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash;
      DELETE FROM conversation_content_search_queue
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash;
    END;

CREATE TRIGGER search_enqueue_conversation_read_content_manifests AFTER INSERT ON conversation_read_content_manifests BEGIN
      INSERT OR IGNORE INTO conversation_content_search_queue(account_id, conversation_id, hash)
        VALUES (NEW.account_id, NEW.conversation_id, NEW.hash);
    END;

CREATE TRIGGER search_remove_conversation_read_content_manifests AFTER DELETE ON conversation_read_content_manifests BEGIN
      DELETE FROM conversation_content_search WHERE rowid IN (
        SELECT search_rowid FROM conversation_content_search_chunks
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash);
      DELETE FROM conversation_content_search_chunks
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash;
      DELETE FROM conversation_content_search_queue
        WHERE account_id = OLD.account_id AND conversation_id = OLD.conversation_id AND hash = OLD.hash;
    END;

CREATE TABLE notification_route_seeds (
  route_id TEXT PRIMARY KEY, route_revision INTEGER NOT NULL, cursor TEXT
);

CREATE TABLE notification_permission_scans (
  task_id TEXT PRIMARY KEY, after_id TEXT NOT NULL DEFAULT '', rescan INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE notification_routes (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, principal_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, request_id TEXT, task_id TEXT, body_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1, expires_at INTEGER
);

CREATE INDEX notification_route_match ON notification_routes(account_id, conversation_id, enabled);

CREATE INDEX notification_route_owner ON notification_routes(account_id, principal_id, enabled, id);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY, route_id TEXT NOT NULL, route_revision INTEGER NOT NULL,
  subject_id TEXT NOT NULL, category TEXT NOT NULL, version TEXT NOT NULL,
  body_json TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL, claim_token TEXT, lease_until INTEGER,
  UNIQUE(route_id, route_revision, subject_id, category, version)
);

CREATE INDEX notification_outbox_ready ON notification_outbox(state, available_at);

CREATE INDEX notification_outbox_route ON notification_outbox(route_id, subject_id, category, state);

CREATE TABLE client_action_signing_key (id INTEGER PRIMARY KEY CHECK(id = 1), secret TEXT NOT NULL);

CREATE TABLE client_action_references (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, body_json TEXT NOT NULL);

CREATE INDEX client_action_expiry ON client_action_references(expires_at);

CREATE TRIGGER observation_history_insert
      AFTER INSERT ON conversation_history_turns WHEN NEW.kind = 'conversation' BEGIN
        INSERT INTO conversation_read_history_dirty(account_id, conversation_id, turn_id)
        VALUES (NEW.account_id, NEW.conversation_id, NEW.turn_id)
        ON CONFLICT(account_id, conversation_id, turn_id) DO UPDATE SET version = version + 1;
        DELETE FROM conversation_read_tombstones WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND turn_id = NEW.turn_id;
      END;

CREATE TRIGGER observation_history_update
      AFTER UPDATE ON conversation_history_turns WHEN NEW.kind = 'conversation' BEGIN
        INSERT INTO conversation_read_history_dirty(account_id, conversation_id, turn_id)
        VALUES (NEW.account_id, NEW.conversation_id, NEW.turn_id)
        ON CONFLICT(account_id, conversation_id, turn_id) DO UPDATE SET version = version + 1;
        DELETE FROM conversation_read_tombstones WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id AND turn_id = NEW.turn_id;
      END;

CREATE TRIGGER observation_history_delete
      AFTER DELETE ON conversation_history_turns WHEN OLD.kind = 'conversation' BEGIN
        INSERT INTO conversation_read_history_dirty(account_id, conversation_id, turn_id)
        VALUES (OLD.account_id, OLD.conversation_id, OLD.turn_id)
        ON CONFLICT(account_id, conversation_id, turn_id) DO UPDATE SET version = version + 1;
        INSERT OR IGNORE INTO conversation_read_tombstones VALUES (OLD.account_id, OLD.conversation_id, OLD.turn_id);
      END;

CREATE INDEX permission_pending_page ON permission_requests(status, id, decision_id);

CREATE INDEX observation_witness_dispatch_items ON dispatch_items(task_id, status);

CREATE INDEX observation_witness_generation_replan_requests ON generation_replan_requests(task_id, status);

CREATE INDEX observation_witness_workspace_publications ON workspace_publications(task_id, status);

CREATE INDEX observation_witness_retry_wakes ON retry_wakes(task_id, status, resume_at DESC);

CREATE INDEX conversation_activity_tasks ON tasks(account_id, conversation_id, id)
    WHERE status IN ('queued', 'running', 'needs_action');

CREATE TRIGGER observation_dirty_tasks_insert
        AFTER INSERT ON tasks BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.id, 1 WHERE NEW.id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_tasks_update
        AFTER UPDATE ON tasks BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.id, 1 WHERE NEW.id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_tasks_delete
        AFTER DELETE ON tasks BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.id, 1 WHERE OLD.id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_subtasks_insert
        AFTER INSERT ON subtasks BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_subtasks_update
        AFTER UPDATE ON subtasks BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_subtasks_delete
        AFTER DELETE ON subtasks BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_dispatch_items_insert
        AFTER INSERT ON dispatch_items BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_dispatch_items_update
        AFTER UPDATE ON dispatch_items BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_dispatch_items_delete
        AFTER DELETE ON dispatch_items BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_executor_attempt_receipts_insert
        AFTER INSERT ON executor_attempt_receipts BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_executor_attempt_receipts_update
        AFTER UPDATE ON executor_attempt_receipts BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_executor_attempt_receipts_delete
        AFTER DELETE ON executor_attempt_receipts BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_executor_attempt_runtime_insert
        AFTER INSERT ON executor_attempt_runtime BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT (SELECT task_id FROM dispatch_items WHERE attempt_id = NEW.attempt_id), 1 WHERE (SELECT task_id FROM dispatch_items WHERE attempt_id = NEW.attempt_id) IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_executor_attempt_runtime_update
        AFTER UPDATE ON executor_attempt_runtime BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT (SELECT task_id FROM dispatch_items WHERE attempt_id = NEW.attempt_id), 1 WHERE (SELECT task_id FROM dispatch_items WHERE attempt_id = NEW.attempt_id) IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_executor_attempt_runtime_delete
        AFTER DELETE ON executor_attempt_runtime BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT (SELECT task_id FROM dispatch_items WHERE attempt_id = OLD.attempt_id), 1 WHERE (SELECT task_id FROM dispatch_items WHERE attempt_id = OLD.attempt_id) IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_work_graph_revisions_insert
        AFTER INSERT ON work_graph_revisions BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_work_graph_revisions_update
        AFTER UPDATE ON work_graph_revisions BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_work_graph_revisions_delete
        AFTER DELETE ON work_graph_revisions BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_resource_leases_insert
        AFTER INSERT ON resource_leases BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_resource_leases_update
        AFTER UPDATE ON resource_leases BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_resource_leases_delete
        AFTER DELETE ON resource_leases BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_resource_waits_insert
        AFTER INSERT ON resource_waits BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_resource_waits_update
        AFTER UPDATE ON resource_waits BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_resource_waits_delete
        AFTER DELETE ON resource_waits BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_conversation_task_slots_insert
        AFTER INSERT ON conversation_task_slots BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.active_task_id, 1 WHERE NEW.active_task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_conversation_task_slots_update
        AFTER UPDATE ON conversation_task_slots BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.active_task_id, 1 WHERE NEW.active_task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_conversation_task_slots_delete
        AFTER DELETE ON conversation_task_slots BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.active_task_id, 1 WHERE OLD.active_task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_task_schedule_entries_insert
        AFTER INSERT ON task_schedule_entries BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_task_schedule_entries_update
        AFTER UPDATE ON task_schedule_entries BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_task_schedule_entries_delete
        AFTER DELETE ON task_schedule_entries BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_generation_replan_requests_insert
        AFTER INSERT ON generation_replan_requests BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_generation_replan_requests_update
        AFTER UPDATE ON generation_replan_requests BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_generation_replan_requests_delete
        AFTER DELETE ON generation_replan_requests BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_workspace_publications_insert
        AFTER INSERT ON workspace_publications BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_workspace_publications_update
        AFTER UPDATE ON workspace_publications BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_workspace_publications_delete
        AFTER DELETE ON workspace_publications BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_retry_wakes_insert
        AFTER INSERT ON retry_wakes BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_retry_wakes_update
        AFTER UPDATE ON retry_wakes BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_retry_wakes_delete
        AFTER DELETE ON retry_wakes BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_permission_requests_insert
        AFTER INSERT ON permission_requests BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_permission_requests_update
        AFTER UPDATE ON permission_requests BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_permission_requests_delete
        AFTER DELETE ON permission_requests BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_task_recovery_items_insert
        AFTER INSERT ON task_recovery_items BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_task_recovery_items_update
        AFTER UPDATE ON task_recovery_items BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT NEW.task_id, 1 WHERE NEW.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_dirty_task_recovery_items_delete
        AFTER DELETE ON task_recovery_items BEGIN
          INSERT INTO conversation_activity_dirty(task_id, version) SELECT OLD.task_id, 1 WHERE OLD.task_id IS NOT NULL
          ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
        END;

CREATE TRIGGER observation_released_slot
    AFTER UPDATE OF active_task_id ON conversation_task_slots WHEN OLD.active_task_id IS NOT NULL BEGIN
      INSERT INTO conversation_activity_dirty(task_id, version) VALUES (OLD.active_task_id, 1)
      ON CONFLICT(task_id) DO UPDATE SET version = version + 1;
    END;

CREATE TABLE gateway_command_admissions (
    account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    state TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (account_id, idempotency_key)
  );

CREATE INDEX gateway_command_admissions_recoverable
    ON gateway_command_admissions (account_id, idempotency_key)
    WHERE state != 'terminal';

CREATE TABLE gateway_command_admission_imports (
    account_id TEXT PRIMARY KEY
  );

CREATE TRIGGER directory_dirty_tasks_insert
        AFTER INSERT ON tasks
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT NEW.account_id, NEW.conversation_id, 1 WHERE NEW.conversation_id IS NOT NULL
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_tasks_update
        AFTER UPDATE ON tasks
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT NEW.account_id, NEW.conversation_id, 1 WHERE NEW.conversation_id IS NOT NULL
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_tasks_delete
        AFTER DELETE ON tasks
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT OLD.account_id, OLD.conversation_id, 1 WHERE OLD.conversation_id IS NOT NULL
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_dispatch_items_insert
        AFTER INSERT ON dispatch_items
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_dispatch_items_update
        AFTER UPDATE ON dispatch_items
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_dispatch_items_delete
        AFTER DELETE ON dispatch_items
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = OLD.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_generation_replan_requests_insert
        AFTER INSERT ON generation_replan_requests
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_generation_replan_requests_update
        AFTER UPDATE ON generation_replan_requests
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_generation_replan_requests_delete
        AFTER DELETE ON generation_replan_requests
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = OLD.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_attempt_sandboxes_insert
        AFTER INSERT ON attempt_sandboxes
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_attempt_sandboxes_update
        AFTER UPDATE ON attempt_sandboxes
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_attempt_sandboxes_delete
        AFTER DELETE ON attempt_sandboxes
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = OLD.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_task_recovery_items_insert
        AFTER INSERT ON task_recovery_items
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_task_recovery_items_update
        AFTER UPDATE ON task_recovery_items
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_task_recovery_items_delete
        AFTER DELETE ON task_recovery_items
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = OLD.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_conversation_task_slots_insert
        AFTER INSERT ON conversation_task_slots
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.active_task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_conversation_task_slots_update
        AFTER UPDATE ON conversation_task_slots
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.active_task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_conversation_task_slots_delete
        AFTER DELETE ON conversation_task_slots
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = OLD.active_task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_task_schedule_entries_insert
        AFTER INSERT ON task_schedule_entries
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_task_schedule_entries_update
        AFTER UPDATE ON task_schedule_entries
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = NEW.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TRIGGER directory_dirty_task_schedule_entries_delete
        AFTER DELETE ON task_schedule_entries
        BEGIN
          INSERT INTO workspace_directory_dirty (account_id, conversation_id, revision)
          SELECT account_id, conversation_id, 1 FROM tasks WHERE id = OLD.task_id
          ON CONFLICT(account_id, conversation_id) DO UPDATE SET revision = revision + 1;
        END;

CREATE TABLE query_usage_contexts (
  query_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  ingress TEXT NOT NULL CHECK(ingress IN ('web', 'feishu', 'tui', 'cli', 'system')),
  request_key TEXT NOT NULL,
  request_payload_digest TEXT NOT NULL,
  conversation_id TEXT,
  request_id TEXT NOT NULL,
  turn_id TEXT,
  execution_segment_id TEXT,
  accepted_at TEXT NOT NULL,
  UNIQUE(account_id, ingress, request_key)
);

CREATE TABLE query_task_links (
  query_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  basis TEXT NOT NULL CHECK(basis IN ('authorized_application', 'authorized_execution_segment')),
  linked_at TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);

CREATE INDEX idx_query_task_links_task ON query_task_links(task_id);

CREATE TABLE execution_usage_contexts (
  execution_segment_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('planner_run', 'task_generation', 'attempt', 'resume_segment')),
  reference_id TEXT NOT NULL,
  task_id TEXT,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);

CREATE INDEX idx_execution_usage_contexts_query
  ON execution_usage_contexts(query_id);

CREATE INDEX idx_execution_usage_contexts_reference
  ON execution_usage_contexts(kind, reference_id);

CREATE TABLE metering_spans (
  span_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  execution_segment_id TEXT,
  source_id TEXT NOT NULL,
  source_scope TEXT NOT NULL CHECK(source_scope IN (
    'model_request', 'harness_turn', 'attempt', 'resource_allocation'
  )),
  call_id TEXT NOT NULL,
  stage TEXT,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('started', 'closed', 'uncertain')),
  payer TEXT NOT NULL CHECK(payer IN ('platform', 'user_direct', 'system', 'unknown')),
  started_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(source_id, call_id),
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);

CREATE INDEX idx_metering_spans_query ON metering_spans(query_id, state);

CREATE TABLE usage_observations (
  observation_id TEXT PRIMARY KEY,
  span_id TEXT,
  source_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  source_scope TEXT NOT NULL CHECK(source_scope IN (
    'model_request', 'harness_turn', 'attempt', 'resource_allocation'
  )),
  call_id TEXT NOT NULL,
  query_id TEXT NOT NULL,
  execution_segment_id TEXT,
  task_id TEXT,
  stage TEXT,
  reason TEXT NOT NULL,
  resource TEXT NOT NULL,
  metric TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity_numerator TEXT NOT NULL,
  quantity_denominator TEXT NOT NULL DEFAULT '1',
  quality TEXT NOT NULL CHECK(quality IN ('reported', 'estimated', 'unavailable')),
  counts_toward_total INTEGER NOT NULL CHECK(counts_toward_total IN (0, 1)),
  payer TEXT NOT NULL CHECK(payer IN ('platform', 'user_direct', 'system', 'unknown')),
  agent_class_ref TEXT,
  provider_ref TEXT,
  model_id TEXT,
  captured_at TEXT NOT NULL,
  provider_binding_version TEXT,
  evidence_ref TEXT,
  normalization_rule_version TEXT NOT NULL,
  cumulative_value TEXT,
  UNIQUE(source_id, source_event_key, metric),
  FOREIGN KEY (query_id) REFERENCES query_usage_contexts(query_id)
);

CREATE INDEX idx_usage_observations_query
  ON usage_observations(query_id, resource, metric);

CREATE INDEX idx_usage_observations_task
  ON usage_observations(task_id);

CREATE TABLE usage_normalization_issues (
  issue_id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  code TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL
);

CREATE INDEX idx_usage_normalization_issues_query
  ON usage_normalization_issues(query_id);

CREATE TABLE workspace_git_roots (
      workspace_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, canonical_path TEXT NOT NULL UNIQUE,
      repository_path TEXT NOT NULL, integration_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('initializing','ready','recovering','failed')),
      main_commit TEXT, delivered_commit TEXT, next_sequence INTEGER NOT NULL DEFAULT 1,
      active_job_id TEXT, row_version INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

CREATE TABLE conversation_git_worktrees (
      worktree_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id),
      conversation_id TEXT NOT NULL, incarnation INTEGER NOT NULL, branch TEXT NOT NULL, root_path TEXT NOT NULL,
      base_commit TEXT NOT NULL, head_commit TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('creating','idle','executing','awaiting_delivery','conflicted','retained','cleaning','cleaned','failed')),
      owner_task_id TEXT, owner_token TEXT, cleanup_requested_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );

CREATE UNIQUE INDEX one_live_conversation_worktree ON conversation_git_worktrees(conversation_id) WHERE state <> 'cleaned';

CREATE UNIQUE INDEX one_live_conversation_branch ON conversation_git_worktrees(workspace_id, branch) WHERE state <> 'cleaned';

CREATE TABLE conversation_execution_bindings (
      task_id TEXT NOT NULL REFERENCES tasks(id), generation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL REFERENCES conversation_git_worktrees(worktree_id), incarnation INTEGER NOT NULL,
      user_root TEXT NOT NULL, execution_root TEXT NOT NULL, task_base_commit TEXT NOT NULL,
      binding_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,generation_id)
    );

CREATE TABLE task_workspace_changes (
      change_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), generation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL REFERENCES conversation_git_worktrees(worktree_id),
      base_commit TEXT NOT NULL, result_commit TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('sealing','sealed','held','queued','delivered','abandoned')),
      delivery_policy TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(task_id,generation_id,result_commit)
    );

CREATE INDEX conversation_changes ON task_workspace_changes(conversation_id,created_at);

CREATE TABLE workspace_merge_jobs (
      job_id TEXT PRIMARY KEY, change_id TEXT NOT NULL UNIQUE REFERENCES task_workspace_changes(change_id),
      request_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL REFERENCES tasks(id),
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT NOT NULL,
      source_commit TEXT NOT NULL, sequence INTEGER NOT NULL, expected_main TEXT, external_commit TEXT, merged_commit TEXT,
      state TEXT NOT NULL CHECK(state IN ('queued','preparing','merging','conflicted','writing','recovering','delivered','cancelled')),
      conflict_version INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
      operation_id TEXT NOT NULL, row_version INTEGER NOT NULL DEFAULT 0, error TEXT,
      queued_at TEXT NOT NULL, merge_started_at TEXT, delivered_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,sequence)
    );

CREATE INDEX workspace_merge_queue ON workspace_merge_jobs(workspace_id,sequence);

CREATE TABLE workspace_merge_files (
      job_id TEXT NOT NULL REFERENCES workspace_merge_jobs(job_id), ordinal INTEGER NOT NULL,
      relative_path TEXT NOT NULL, operation TEXT NOT NULL,
      before_kind TEXT, before_blob TEXT, before_mode TEXT, after_kind TEXT, after_blob TEXT, after_mode TEXT,
      before_sha256 TEXT, after_sha256 TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','prepared','applied','conflicted')),
      backup_blob TEXT, last_error TEXT, PRIMARY KEY(job_id,ordinal), UNIQUE(job_id,relative_path)
    );

CREATE INDEX pending_writeback_files ON workspace_merge_files(job_id,state,ordinal);

CREATE TABLE workspace_git_operations (
      operation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id), conversation_id TEXT,
      kind TEXT NOT NULL, owner_token TEXT, owner_process TEXT,
      state TEXT NOT NULL CHECK(state IN ('prepared','applying','applied','needs_recovery')),
      expected_ref TEXT, target_commit TEXT, payload_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );

CREATE INDEX workspace_git_unfinished_operations ON workspace_git_operations(state,updated_at);

CREATE TABLE service_git_worktrees (
      service_worktree_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace_git_roots(workspace_id),
      service_id TEXT NOT NULL, source_task_id TEXT REFERENCES tasks(id), source_commit TEXT NOT NULL,
      project_path TEXT NOT NULL, root_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('preparing','ready','running','stopped','retained','cleaning','cleaned','failed')),
      process_token TEXT, runtime_dirty INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(workspace_id,service_id,source_commit)
    );

CREATE TABLE conversation_attempt_owners (
    conversation_id TEXT NOT NULL,
    token TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    access_mode TEXT NOT NULL CHECK(access_mode IN ('read','write')),
    created_at TEXT NOT NULL
  );

CREATE INDEX conversation_attempt_owners_conversation
    ON conversation_attempt_owners(conversation_id);

CREATE TABLE permission_resolutions (
    request_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK(resolution IN ('approve', 'deny')),
    source TEXT NOT NULL CHECK(source IN ('command', 'button', 'planner')),
    planner_plan_id TEXT,
    created_at TEXT NOT NULL
  );

CREATE INDEX permission_resolutions_session
    ON permission_resolutions(session_id, created_at, request_id);

CREATE TABLE route_decisions (
    route_decision_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    generation_id TEXT NOT NULL,
    subtask_id TEXT NOT NULL,
    graph_revision INTEGER NOT NULL,
    attempt_ordinal INTEGER NOT NULL,
    input_snapshot_hash TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    excluded_json TEXT NOT NULL,
    selected_json TEXT,
    decision_model_json TEXT NOT NULL,
    rationale TEXT NOT NULL,
    configuration_revision TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('selected', 'no_candidate')),
    created_at TEXT NOT NULL,
    UNIQUE(task_id, generation_id, subtask_id, attempt_ordinal)
  );

CREATE INDEX route_decisions_subtask
    ON route_decisions(task_id, generation_id, subtask_id, created_at);

CREATE TABLE permission_work_items (
    event_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('permission_requested', 'permission_resolution_received')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed')),
    processing_started_at TEXT,
    processed_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

CREATE INDEX permission_work_items_ready
    ON permission_work_items(status, created_at, event_id);

CREATE INDEX permission_work_items_request
    ON permission_work_items(request_id, event_type, status);

CREATE TABLE task_plan_proposals (
      proposal_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      replan_request_id TEXT UNIQUE,
      trigger_operation_id TEXT,
      request_json TEXT NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending', 'forwarded', 'invalidated')),
      delivery_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE UNIQUE INDEX task_plan_proposals_operation
      ON task_plan_proposals(operation_id);

CREATE INDEX task_plan_proposals_delivery
      ON task_plan_proposals(delivery, created_at, proposal_id);

CREATE TABLE task_plan_origins (
      task_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE REFERENCES task_plan_proposals(proposal_id)
    );

CREATE TABLE task_plan_admission_results (
    proposal_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN (
      'authorized', 'queued', 'deferred',
      'rejected', 'clarification', 'direct_reply', 'no_action',
      'task_control', 'permission_resolution'
    )),
    task_id TEXT,
    generation_id TEXT,
    graph_revision INTEGER,
    reason TEXT NOT NULL,
    detail_json TEXT,
    applied_at TEXT NOT NULL
  );

CREATE INDEX task_plan_admission_results_applied
    ON task_plan_admission_results(status, applied_at, proposal_id);
`;
