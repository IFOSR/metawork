import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 37;

const CURRENT_SCHEMA_SQL = `
CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT,
          status TEXT NOT NULL DEFAULT 'created',
          summary TEXT DEFAULT '',
          snapshot_json TEXT DEFAULT '[]',
          resources_json TEXT DEFAULT '[]',
          dependencies_json TEXT DEFAULT '[]',
          priority_json TEXT,
          injected_prefs_json TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        , last_scheduling_reason TEXT DEFAULT '', last_interruption_reason TEXT DEFAULT '', interruption_count INTEGER DEFAULT 0, artifacts_json TEXT DEFAULT '[]',
          account_id TEXT NOT NULL DEFAULT 'legacy-account',
          conversation_id TEXT NOT NULL DEFAULT 'legacy-conversation',
          workspace_id TEXT NOT NULL DEFAULT 'legacy-workspace',
          owner_planner_session_id TEXT NOT NULL DEFAULT 'legacy-planner-session',
          admitted_at TEXT NOT NULL DEFAULT '');

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
          was_overridden INTEGER DEFAULT 0,
          FOREIGN KEY (preference_id) REFERENCES preferences(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

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

CREATE TABLE reflection_events (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT,
        task_id TEXT,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

CREATE TABLE learning_candidates (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source_reflection_id TEXT,
        source_task_id TEXT,
        safety_status TEXT NOT NULL DEFAULT 'pending',
        safety_reasons_json TEXT NOT NULL DEFAULT '[]',
        review_note TEXT,
        promoted_asset_id TEXT,
        created_at TEXT NOT NULL,
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
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          source_id TEXT,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          exact_only INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
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
            workspace_kind TEXT NOT NULL CHECK(workspace_kind IN ('git')),
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

CREATE INDEX idx_preferences_scope ON preferences(scope);

CREATE INDEX idx_preferences_status ON preferences(status);

CREATE INDEX idx_interactions_session ON interactions(session_id, created_at);

CREATE INDEX idx_interactions_task ON interactions(task_id, created_at);

CREATE INDEX idx_reflection_events_task
        ON reflection_events(task_id, created_at);

CREATE INDEX idx_reflection_events_source
        ON reflection_events(source_type, source_id);

CREATE INDEX idx_learning_candidates_status
        ON learning_candidates(status, created_at);

CREATE INDEX idx_learning_candidates_source_task
        ON learning_candidates(source_task_id, created_at);

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
 * Creates schema 34 or applies the supported pre-release upgrades.
 */
export function runMigrations(
  db: Database.Database,
  migrationContext?: Schema30MigrationContext,
): void {
  if (tableExists(db, 'schema_version')) {
    const versions = db.prepare(
      'SELECT version FROM schema_version ORDER BY version',
    ).all() as Array<{ version: number }>;
    if (versions.length === 1 && versions[0]?.version === CURRENT_SCHEMA_VERSION) {
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 31) {
      migrateSchema31To32(db);
      migrateSchema32To33(db);
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 32) {
      migrateSchema32To33(db);
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 33) {
      migrateSchema33To34(db);
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 34) {
      migrateSchema34To35(db);
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 35) {
      migrateSchema35To36(db);
      migrateSchema36To37(db);
      return;
    }
    if (versions.length === 1 && versions[0]?.version === 36) {
      migrateSchema36To37(db);
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

function migrateSchema30To31(
  db: Database.Database,
  context: Schema30MigrationContext,
): void {
  const existingViolations = db.pragma('foreign_key_check') as unknown[];
  if (existingViolations.length > 0) {
    throw new Error('schema 30 to 31 migration cannot start with foreign key violations');
  }
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;
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
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
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
