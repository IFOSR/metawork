import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  up: string | ((db: Database.Database) => void);
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
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
        );

        CREATE TABLE IF NOT EXISTS preferences (
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

        CREATE TABLE IF NOT EXISTS preference_usage (
          id TEXT PRIMARY KEY,
          preference_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          injected_at TEXT NOT NULL,
          was_overridden INTEGER DEFAULT 0,
          FOREIGN KEY (preference_id) REFERENCES preferences(id),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

        CREATE TABLE IF NOT EXISTS observations (
          id TEXT PRIMARY KEY,
          pattern TEXT NOT NULL,
          occurrence_count INTEGER DEFAULT 1,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          source_tasks TEXT DEFAULT '[]',
          promoted_to_preference_id TEXT
        );

        CREATE TABLE IF NOT EXISTS interactions (
          id TEXT PRIMARY KEY,
          task_id TEXT,
          user_input TEXT,
          system_output TEXT,
          executor_used TEXT,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_preferences_scope ON preferences(scope);
        CREATE INDEX IF NOT EXISTS idx_preferences_status ON preferences(status);
        CREATE INDEX IF NOT EXISTS idx_observations_pattern ON observations(pattern);
      `);
      addColumnIfMissing(db, 'tasks', 'snapshot_json', "TEXT DEFAULT '[]'");
      addColumnIfMissing(db, 'tasks', 'dependencies_json', "TEXT DEFAULT '[]'");
      addColumnIfMissing(db, 'tasks', 'priority_json', 'TEXT');
      addColumnIfMissing(db, 'tasks', 'injected_prefs_json', "TEXT DEFAULT '[]'");
    },
  },
  {
    version: 2,
    up: (db) => {
      addColumnIfMissing(db, 'interactions', 'session_id', 'TEXT');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_interactions_session ON interactions(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_interactions_task ON interactions(task_id, created_at);
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      addColumnIfMissing(db, 'tasks', 'last_scheduling_reason', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'tasks', 'last_interruption_reason', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'tasks', 'interruption_count', 'INTEGER DEFAULT 0');
    },
  },
  {
    version: 4,
    up: (db) => {
      addColumnIfMissing(db, 'tasks', 'artifacts_json', "TEXT DEFAULT '[]'");
    },
  },
  {
    version: 5,
    up: `
      CREATE TABLE IF NOT EXISTS guidance_events (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        task_id TEXT,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        reasons_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL DEFAULT 0,
        requires_confirmation INTEGER DEFAULT 1,
        accepted_at TEXT,
        dismissed_at TEXT,
        executed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_relations (
        id TEXT PRIMARY KEY,
        source_task_id TEXT NOT NULL,
        target_task_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_memory_embeddings (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        memory_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preference_embeddings (
        id TEXT PRIMARY KEY,
        preference_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_recall_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        query_text TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        task_candidates_json TEXT NOT NULL DEFAULT '[]',
        preference_candidates_json TEXT NOT NULL DEFAULT '[]',
        review_summary_json TEXT NOT NULL DEFAULT '{}',
        accepted_candidates_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recall_review_policies (
        id TEXT PRIMARY KEY,
        policy_type TEXT NOT NULL,
        scope TEXT,
        subject TEXT,
        proposal_type TEXT,
        auto_apply INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_guidance_events_task ON guidance_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_relations_source ON task_relations(source_task_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_task_relations_target ON task_relations(target_task_id, relation_type);
      CREATE INDEX IF NOT EXISTS idx_task_memory_embeddings_task ON task_memory_embeddings(task_id, memory_kind);
      CREATE INDEX IF NOT EXISTS idx_preference_embeddings_preference ON preference_embeddings(preference_id);
      CREATE INDEX IF NOT EXISTS idx_memory_recall_events_task ON memory_recall_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recall_review_policies_lookup
        ON recall_review_policies(policy_type, scope, subject, proposal_type);
    `,
  },
  {
    version: 6,
    up: `
      CREATE TABLE IF NOT EXISTS session_state (
        id TEXT PRIMARY KEY,
        last_focused_task_id TEXT,
        last_completed_task_id TEXT,
        last_session_id TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    up: `
      CREATE TABLE IF NOT EXISTS recall_feedback (
        id TEXT PRIMARY KEY,
        audit_id TEXT,
        query_task_id TEXT,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        action TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recall_feedback_target
        ON recall_feedback(target_kind, target_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_recall_feedback_audit
        ON recall_feedback(audit_id, created_at);
    `,
  },
  {
    version: 8,
    up: `
      CREATE TABLE IF NOT EXISTS reflection_events (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_id TEXT,
        task_id TEXT,
        summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS learning_candidates (
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

      CREATE INDEX IF NOT EXISTS idx_reflection_events_task
        ON reflection_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_reflection_events_source
        ON reflection_events(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_learning_candidates_status
        ON learning_candidates(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_learning_candidates_source_task
        ON learning_candidates(source_task_id, created_at);
    `,
  },
  {
    version: 9,
    up: `
      CREATE TABLE IF NOT EXISTS executor_skill_usage_events (
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

      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_task
        ON executor_skill_usage_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_execution
        ON executor_skill_usage_events(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_usage_events_skill
        ON executor_skill_usage_events(skill_name, event_type, created_at);
    `,
  },
  {
    version: 10,
    up: `
      CREATE TABLE IF NOT EXISTS executor_skill_install_events (
        id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        package_id TEXT,
        executor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_skill_install_events_candidate
        ON executor_skill_install_events(candidate_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_skill_install_events_executor
        ON executor_skill_install_events(executor_name, status, created_at);
    `,
  },
  {
    version: 11,
    up: `
      CREATE TABLE IF NOT EXISTS task_memory_cards (
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

      CREATE INDEX IF NOT EXISTS idx_task_memory_cards_task
        ON task_memory_cards(task_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_task_memory_cards_source_candidate
        ON task_memory_cards(source_candidate_id);

      CREATE TABLE IF NOT EXISTS skill_effect_summaries (
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

      CREATE INDEX IF NOT EXISTS idx_skill_effect_summaries_skill
        ON skill_effect_summaries(skill_name, skill_version_key, updated_at);
      CREATE INDEX IF NOT EXISTS idx_skill_effect_summaries_executor
        ON skill_effect_summaries(executor_name, used_count, updated_at);
    `,
  },
  {
    version: 12,
    up: `
      CREATE TABLE IF NOT EXISTS memory_audit_events (
        id TEXT PRIMARY KEY,
        task_id TEXT,
        memory_id TEXT NOT NULL,
        action TEXT NOT NULL,
        score REAL,
        reason TEXT NOT NULL DEFAULT '',
        judge_source TEXT NOT NULL DEFAULT 'rule',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_memory
        ON memory_audit_events(memory_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_task
        ON memory_audit_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_action
        ON memory_audit_events(action, created_at);
    `,
  },
  {
    version: 13,
    up: `
      CREATE TABLE IF NOT EXISTS executor_profiles (
        name TEXT PRIMARY KEY,
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
        historical_success REAL NOT NULL DEFAULT 0.5,
        runtime_command TEXT,
        runtime_args_json TEXT NOT NULL DEFAULT '[]',
        runtime_check_command TEXT,
        project_url TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executor_route_events (
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

      CREATE INDEX IF NOT EXISTS idx_executor_route_events_executor
        ON executor_route_events(selected_executor, created_at);
      CREATE INDEX IF NOT EXISTS idx_executor_route_events_task
        ON executor_route_events(task_id, created_at);
    `,
  },
  {
    version: 14,
    up: `
      CREATE VIRTUAL TABLE IF NOT EXISTS task_search_index USING fts5(
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

      CREATE TRIGGER IF NOT EXISTS trg_task_search_index_interactions_insert
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

      CREATE TRIGGER IF NOT EXISTS trg_task_search_index_interactions_delete
      AFTER DELETE ON interactions
      WHEN OLD.task_id IS NOT NULL
      BEGIN
        DELETE FROM task_search_index
          WHERE source_kind = 'interaction' AND source_id = OLD.id;
      END;
    `,
  },
  {
    version: 15,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_classes (
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
          historical_success REAL NOT NULL DEFAULT 0.5,
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
        );

        CREATE TABLE IF NOT EXISTS subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          depends_on_json TEXT NOT NULL DEFAULT '[]',
          required_agent_class_kind TEXT NOT NULL DEFAULT 'executor',
          agent_class_hint TEXT,
          candidate_agent_classes_json TEXT NOT NULL DEFAULT '[]',
          expected_output TEXT NOT NULL DEFAULT 'summary',
          acceptance_json TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          result TEXT NOT NULL DEFAULT '',
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

        CREATE TABLE IF NOT EXISTS task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          subtask_id TEXT,
          event_type TEXT NOT NULL,
          message TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );

        CREATE TABLE IF NOT EXISTS work_units (
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
          FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
        );

        CREATE TABLE IF NOT EXISTS work_unit_events (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          task_id TEXT,
          subtask_id TEXT,
          event_type TEXT NOT NULL,
          state TEXT,
          message TEXT NOT NULL DEFAULT '',
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
        );

        CREATE TABLE IF NOT EXISTS worktree_leases (
          id TEXT PRIMARY KEY,
          worktree_path TEXT NOT NULL,
          work_unit_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          subtask_id TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
        );

        CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_work_units_state ON work_units(agent_class_kind, state, updated_at);
        CREATE INDEX IF NOT EXISTS idx_work_unit_events_unit ON work_unit_events(work_unit_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_worktree_leases_active ON worktree_leases(worktree_path, released_at, expires_at);
      `);

      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO agent_classes (
          name, kind, domains_json, capabilities_json, input_types_json, output_types_json,
          strengths_json, weaknesses_json, primary_use_cases_json, avoid_use_cases_json,
          intent_affinity_json, risk_level, availability, historical_success,
          runtime_command, runtime_args_json, runtime_check_command, project_url,
          harness, model, skills_json, mcp_servers_json, plugins_json, created_at, updated_at
        )
        SELECT
          name, 'executor', domains_json, capabilities_json, input_types_json, output_types_json,
          strengths_json, weaknesses_json, primary_use_cases_json, avoid_use_cases_json,
          intent_affinity_json, risk_level, availability, historical_success,
          runtime_command, runtime_args_json, runtime_check_command, project_url,
          NULL, NULL, '[]', '[]', '[]', ?, ?
        FROM executor_profiles
      `).run(now, now);
    },
  },
  {
    version: 16,
    up: `
      CREATE TABLE IF NOT EXISTS planning_decisions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        task_id TEXT,
        user_input TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_planning_decisions_session
        ON planning_decisions(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_planning_decisions_task
        ON planning_decisions(task_id, created_at);
    `,
  },
  {
    version: 17,
    up: `
      CREATE TABLE IF NOT EXISTS planner_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request_source TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS planner_tool_calls (
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

      CREATE INDEX IF NOT EXISTS idx_planner_runs_session
        ON planner_runs(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_planner_tool_calls_run
        ON planner_tool_calls(planner_run_id, sequence);
    `,
  },
  {
    version: 18,
    up: `
      CREATE TABLE IF NOT EXISTS kernel_executor_status (
        agent_class_name TEXT PRIMARY KEY,
        class_health TEXT NOT NULL DEFAULT 'unverified',
        recent_attempts_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        FOREIGN KEY (agent_class_name) REFERENCES agent_classes(name)
      );
    `,
  },
  {
    version: 19,
    up: (db) => {
      dropColumnIfExists(db, 'agent_classes', 'historical_success');
      dropColumnIfExists(db, 'executor_profiles', 'historical_success');
    },
  },
  {
    version: 20,
    up: 'DROP TABLE IF EXISTS executor_profiles;',
  },
  {
    version: 21,
    up: (db) => {
      // Some historical tests intentionally construct partial schemas. A real
      // v20 database always has subtasks, but the migration remains safe when
      // that production table is absent.
      if (!tableExists(db, 'subtasks')) return;

      const now = new Date().toISOString();
      db.exec('DROP INDEX IF EXISTS idx_subtasks_task;');
      db.exec('ALTER TABLE subtasks RENAME TO subtasks_v2_audit;');
      db.exec(`
        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          depends_on_json TEXT NOT NULL DEFAULT '[]',
          required_capabilities_json TEXT NOT NULL,
          preferred_agent_class_list_json TEXT NOT NULL,
          expected_output TEXT NOT NULL DEFAULT 'summary',
          acceptance_json TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          result TEXT NOT NULL DEFAULT '',
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX idx_subtasks_task ON subtasks(task_id, status, created_at);

        CREATE TRIGGER subtasks_v2_audit_read_only_insert
        BEFORE INSERT ON subtasks_v2_audit BEGIN
          SELECT RAISE(ABORT, 'subtasks_v2_audit is read-only');
        END;
        CREATE TRIGGER subtasks_v2_audit_read_only_update
        BEFORE UPDATE ON subtasks_v2_audit BEGIN
          SELECT RAISE(ABORT, 'subtasks_v2_audit is read-only');
        END;
        CREATE TRIGGER subtasks_v2_audit_read_only_delete
        BEFORE DELETE ON subtasks_v2_audit BEGIN
          SELECT RAISE(ABORT, 'subtasks_v2_audit is read-only');
        END;
      `);

      if (tableExists(db, 'tasks') && columnExists(db, 'tasks', 'last_interruption_reason')) {
        db.prepare(`
          UPDATE tasks
          SET status = 'parked',
              last_interruption_reason = ?,
              updated_at = ?
          WHERE id IN (SELECT DISTINCT task_id FROM subtasks_v2_audit)
            AND status NOT IN ('done', 'archived', 'cancelled')
        `).run(
          'work graph schema upgraded to v3; continue with natural language to replan',
          now,
        );
      }

      if (
        tableExists(db, 'work_units')
        && columnExists(db, 'work_units', 'claimed_subtask_id')
        && columnExists(db, 'work_units', 'state')
      ) {
        db.prepare(`
          UPDATE work_units
          SET state = 'heartbeat_lost', updated_at = ?
          WHERE state IN ('claimed', 'running', 'waiting')
            AND claimed_subtask_id IN (SELECT id FROM subtasks_v2_audit)
        `).run(now);
      }
    },
  },
  {
    version: 22,
    up: (db) => {
      const now = new Date().toISOString();
      if (tableExists(db, 'subtasks')) {
        db.exec('DROP INDEX IF EXISTS idx_subtasks_task;');
        db.exec('ALTER TABLE subtasks RENAME TO subtasks_v3_audit;');
        db.exec(`
          CREATE TRIGGER subtasks_v3_audit_read_only_insert
          BEFORE INSERT ON subtasks_v3_audit BEGIN
            SELECT RAISE(ABORT, 'subtasks_v3_audit is read-only');
          END;
          CREATE TRIGGER subtasks_v3_audit_read_only_update
          BEFORE UPDATE ON subtasks_v3_audit BEGIN
            SELECT RAISE(ABORT, 'subtasks_v3_audit is read-only');
          END;
          CREATE TRIGGER subtasks_v3_audit_read_only_delete
          BEFORE DELETE ON subtasks_v3_audit BEGIN
            SELECT RAISE(ABORT, 'subtasks_v3_audit is read-only');
          END;
        `);
      }

      db.exec(`
        CREATE TABLE subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'created',
          dependencies_json TEXT NOT NULL DEFAULT '[]',
          context_refs_json TEXT NOT NULL DEFAULT '[]',
          required_capabilities_json TEXT NOT NULL,
          preferred_agent_class_list_json TEXT NOT NULL,
          expected_output TEXT NOT NULL DEFAULT 'summary',
          acceptance_json TEXT NOT NULL DEFAULT '[]',
          risk_level TEXT NOT NULL DEFAULT 'medium',
          result TEXT NOT NULL DEFAULT '',
          artifacts_json TEXT NOT NULL DEFAULT '[]',
          verification_json TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX idx_subtasks_task ON subtasks(task_id, status, created_at);

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
        CREATE INDEX idx_subtask_handoffs_to ON subtask_handoffs(task_id, to_subtask_id);
        CREATE TRIGGER subtask_handoffs_immutable_update
        BEFORE UPDATE ON subtask_handoffs BEGIN
          SELECT RAISE(ABORT, 'subtask_handoffs are immutable');
        END;
        CREATE TRIGGER subtask_handoffs_immutable_delete
        BEFORE DELETE ON subtask_handoffs BEGIN
          SELECT RAISE(ABORT, 'subtask_handoffs are immutable');
        END;

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
          error_detail TEXT,
          FOREIGN KEY (task_id) REFERENCES tasks(id),
          FOREIGN KEY (subtask_id) REFERENCES subtasks(id),
          FOREIGN KEY (work_unit_id) REFERENCES work_units(id)
        );
        CREATE INDEX idx_executor_attempt_receipts_subtask
          ON executor_attempt_receipts(task_id, subtask_id, completed_at);
        CREATE TRIGGER executor_attempt_receipts_immutable_update
        BEFORE UPDATE ON executor_attempt_receipts BEGIN
          SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
        END;
        CREATE TRIGGER executor_attempt_receipts_immutable_delete
        BEFORE DELETE ON executor_attempt_receipts BEGIN
          SELECT RAISE(ABORT, 'executor_attempt_receipts are immutable');
        END;

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
        CREATE INDEX idx_task_execution_evidence_task
          ON task_execution_evidence(task_id, created_at, id);
      `);

      if (tableExists(db, 'work_units')) {
        addColumnIfMissing(db, 'work_units', 'state', "TEXT NOT NULL DEFAULT 'idle'");
        addColumnIfMissing(db, 'work_units', 'claimed_task_id', 'TEXT');
        addColumnIfMissing(db, 'work_units', 'claimed_subtask_id', 'TEXT');
        addColumnIfMissing(db, 'work_units', 'claimed_attempt_id', 'TEXT');
        addColumnIfMissing(db, 'work_units', 'lease_expires_at', 'TEXT');
        addColumnIfMissing(db, 'work_units', 'updated_at', "TEXT NOT NULL DEFAULT ''");
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_work_units_one_active_attempt_per_subtask
          ON work_units(claimed_subtask_id)
          WHERE claimed_subtask_id IS NOT NULL AND state IN ('claimed', 'running', 'waiting');
        `);
      }
      if (tableExists(db, 'work_unit_events')) {
        addColumnIfMissing(db, 'work_unit_events', 'attempt_id', 'TEXT');
      }

      if (tableExists(db, 'tasks') && tableExists(db, 'subtasks_v3_audit')) {
        const auditedTaskIds = tableExists(db, 'subtasks_v2_audit')
          ? `SELECT DISTINCT task_id FROM subtasks_v3_audit
             UNION
             SELECT DISTINCT task_id FROM subtasks_v2_audit`
          : 'SELECT DISTINCT task_id FROM subtasks_v3_audit';
        db.prepare(`
          UPDATE tasks
          SET status = 'parked',
              last_interruption_reason = ?,
              updated_at = ?
          WHERE id IN (${auditedTaskIds})
            AND status NOT IN ('done', 'archived', 'cancelled')
        `).run(
          'work graph schema upgraded to v4; continue with natural language to replan',
          now,
        );
      }
      if (tableExists(db, 'work_units')) {
        db.prepare(`
          UPDATE work_units
          SET state = 'heartbeat_lost',
              claimed_task_id = NULL,
              claimed_subtask_id = NULL,
              claimed_attempt_id = NULL,
              lease_expires_at = NULL,
              updated_at = ?
          WHERE state IN ('claimed', 'running', 'waiting')
             OR claimed_task_id IS NOT NULL
             OR claimed_subtask_id IS NOT NULL
             OR claimed_attempt_id IS NOT NULL
        `).run(now);
      }
    },
  },
  {
    version: 23,
    up: (db) => {
      if (tableExists(db, 'planning_decisions') && !tableExists(db, 'planning_decisions_legacy_audit')) {
        db.exec('ALTER TABLE planning_decisions RENAME TO planning_decisions_legacy_audit');
      }
      if (!tableExists(db, 'planning_decisions_legacy_audit')) {
        db.exec(`
          CREATE TABLE planning_decisions_legacy_audit (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            task_id TEXT,
            user_input TEXT NOT NULL,
            plan_json TEXT NOT NULL,
            decision_json TEXT NOT NULL,
            outcome TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
      }
      db.exec(`
        DROP INDEX IF EXISTS idx_planning_decisions_session;
        DROP INDEX IF EXISTS idx_planning_decisions_task;
        CREATE INDEX IF NOT EXISTS idx_planning_decisions_legacy_session
          ON planning_decisions_legacy_audit(session_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_planning_decisions_legacy_task
          ON planning_decisions_legacy_audit(task_id, created_at);
        CREATE TRIGGER IF NOT EXISTS planning_decisions_legacy_immutable_insert
        BEFORE INSERT ON planning_decisions_legacy_audit BEGIN
          SELECT RAISE(ABORT, 'planning_decisions_legacy_audit is read-only');
        END;
        CREATE TRIGGER IF NOT EXISTS planning_decisions_legacy_immutable_update
        BEFORE UPDATE ON planning_decisions_legacy_audit BEGIN
          SELECT RAISE(ABORT, 'planning_decisions_legacy_audit is read-only');
        END;
        CREATE TRIGGER IF NOT EXISTS planning_decisions_legacy_immutable_delete
        BEFORE DELETE ON planning_decisions_legacy_audit BEGIN
          SELECT RAISE(ABORT, 'planning_decisions_legacy_audit is read-only');
        END;

        CREATE TABLE IF NOT EXISTS kernel_decisions (
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
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_kernel_decisions_session
          ON kernel_decisions(session_id, created_at, id);
        CREATE INDEX idx_kernel_decisions_task
          ON kernel_decisions(task_id, created_at, id);
        CREATE INDEX idx_kernel_decisions_correlation
          ON kernel_decisions(correlation_id, created_at, id);
      `);
    },
  },
  {
    version: 24,
    up: (db) => {
      const migrate = db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS kernel_events (
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
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_kernel_events_drain
            ON kernel_events(status, available_at, created_at, id);
          CREATE INDEX IF NOT EXISTS idx_kernel_events_task
            ON kernel_events(task_id, created_at, id);

          CREATE TABLE IF NOT EXISTS kernel_decision_applications (
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
          CREATE INDEX IF NOT EXISTS idx_kernel_decision_applications_status
            ON kernel_decision_applications(status, created_at, id);

          CREATE TABLE IF NOT EXISTS kernel_effect_outbox (
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
          CREATE INDEX IF NOT EXISTS idx_kernel_effect_outbox_drain
            ON kernel_effect_outbox(status, available_at, created_at, id);

          CREATE TABLE IF NOT EXISTS executor_attempt_runtime (
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

          CREATE TABLE IF NOT EXISTS work_graph_revisions (
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
            UNIQUE(task_id, revision),
            FOREIGN KEY (task_id) REFERENCES tasks(id),
            FOREIGN KEY (authorized_decision_id) REFERENCES kernel_decisions(id)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_work_graph_one_active_revision
            ON work_graph_revisions(task_id) WHERE status = 'active';
          CREATE INDEX IF NOT EXISTS idx_work_graph_revisions_generation
            ON work_graph_revisions(task_id, generation_id, revision);
        `);

        if (tableExists(db, 'subtasks')) {
          addColumnIfMissing(db, 'subtasks', 'graph_revision', 'INTEGER');
          addColumnIfMissing(db, 'subtasks', 'generation_id', 'TEXT');
          if (tableExists(db, 'tasks')) {
            db.exec(`
              INSERT OR IGNORE INTO work_graph_revisions (
                id, task_id, revision, generation_id, authorized_decision_id,
                proposal_source, automatic_replan, status, created_at, updated_at
              )
              SELECT
                'revision_' || subtasks.task_id || '_1', subtasks.task_id, 1,
                'generation_' || subtasks.task_id || '_1', NULL, 'initial', 0,
                CASE WHEN SUM(CASE WHEN subtasks.status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END) = 0
                  THEN 'completed' ELSE 'active' END,
                MIN(subtasks.created_at), MAX(subtasks.updated_at)
              FROM subtasks
              INNER JOIN tasks ON tasks.id = subtasks.task_id
              GROUP BY subtasks.task_id
            `);
          }
          db.exec(`
            UPDATE subtasks
            SET graph_revision = COALESCE(graph_revision, 1),
                generation_id = COALESCE(generation_id, 'generation_' || task_id || '_1')
          `);
        }

        if (tableExists(db, 'executor_attempt_receipts')) {
          addColumnIfMissing(db, 'executor_attempt_receipts', 'graph_revision', 'INTEGER');
          addColumnIfMissing(db, 'executor_attempt_receipts', 'generation_id', 'TEXT');
          addColumnIfMissing(db, 'executor_attempt_receipts', 'attempt_kind', "TEXT NOT NULL DEFAULT 'primary'");
          addColumnIfMissing(db, 'executor_attempt_receipts', 'source_attempt_id', 'TEXT');
          addColumnIfMissing(db, 'executor_attempt_receipts', 'failure_json', 'TEXT');
          addColumnIfMissing(db, 'executor_attempt_receipts', 'recovery_mode', "TEXT NOT NULL DEFAULT 'fresh'");
          db.exec(`
            UPDATE executor_attempt_receipts
            SET graph_revision = COALESCE(graph_revision, 1),
                generation_id = COALESCE(
                  generation_id,
                  'generation_' || task_id || '_1'
                )
          `);
        }

        if (tableExists(db, 'kernel_decisions')) {
          db.exec(`
            INSERT OR IGNORE INTO kernel_events (
              id, schema_version, event_type, correlation_id, causation_id,
              session_id, task_id, subtask_id, attempt_id, event_json,
              available_at, status, processing_started_at, processed_at,
              last_error, created_at, updated_at
            )
            SELECT event_id, schema_version, event_type, correlation_id, causation_id,
              session_id, task_id, subtask_id, attempt_id, event_json,
              created_at, 'processed', NULL, created_at, NULL, created_at, created_at
            FROM kernel_decisions
          `);
          db.exec(`
            INSERT OR IGNORE INTO kernel_decision_applications (
              id, decision_id, event_id, idempotency_key, status, apply_attempts,
              observation_event_id, observation_event_json, error_summary,
              applying_at, applied_at, created_at, updated_at
            )
            SELECT 'application_' || id, id, event_id, 'decision:' || id,
              CASE WHEN action = 'no_op' THEN 'applied' ELSE 'uncertain' END,
              0, NULL, NULL,
              CASE WHEN action = 'no_op' THEN NULL
                ELSE 'v23 decision has no durable application proof' END,
              NULL, CASE WHEN action = 'no_op' THEN created_at ELSE NULL END,
              created_at, created_at
            FROM kernel_decisions
          `);
          if (tableExists(db, 'tasks')) {
            db.exec(`
              UPDATE kernel_decision_applications
              SET status = 'applied',
                  error_summary = NULL,
                  applied_at = created_at,
                  updated_at = created_at
              WHERE decision_id IN (
                SELECT kernel_decisions.id
                FROM kernel_decisions
                INNER JOIN tasks ON tasks.id = kernel_decisions.task_id
                WHERE kernel_decisions.action = 'complete_task'
                  AND tasks.status = 'done'
              )
            `);
          }
        }
      });
      migrate();
    },
  },
];

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table) as { name: string } | undefined;
  return Boolean(row);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some(row => row.name === column);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  if (columnExists(db, table, column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function dropColumnIfExists(db: Database.Database, table: string, column: string): void {
  if (!columnExists(db, table, column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function runMigration(db: Database.Database, migration: Migration): void {
  if (typeof migration.up === 'string') {
    db.exec(migration.up);
    return;
  }

  migration.up(db);
}

/**
 * 运行数据库迁移
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);

  const result = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = result?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      runMigration(db, migration);
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(migration.version);
    }
  }

  addColumnIfMissing(db, 'executor_route_events', 'primary_intent', "TEXT NOT NULL DEFAULT 'general'");
  addColumnIfMissing(db, 'executor_route_events', 'matched_boundary_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'executor_route_events', 'rejected_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'agent_classes', 'harness', 'TEXT');
  addColumnIfMissing(db, 'agent_classes', 'model', 'TEXT');
  addColumnIfMissing(db, 'agent_classes', 'skills_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'agent_classes', 'mcp_servers_json', "TEXT NOT NULL DEFAULT '[]'");
  addColumnIfMissing(db, 'agent_classes', 'plugins_json', "TEXT NOT NULL DEFAULT '[]'");
}
