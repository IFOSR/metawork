import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { seedAgentClasses } from '../support/seed-agent-classes.js';
import {
  loadPlannerConfigurationSnapshot,
  PlannerDataReader,
  resolvePlannerMcpRuntimePaths,
} from '../../src/planning/planner-mcp-server.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';

function createHarness(
  sessionId = 'sess_current',
  conversationId = 'legacy-conversation',
) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT OR IGNORE INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES ('revision-test', 'sha256:test-configuration', 'native', ?)
  `).run('2026-08-12T00:00:00.000Z');
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-planner-mcp');
  return {
    db,
    taskRepo,
    taskEngine,
    reader: new PlannerDataReader(db, sessionId, () => ({
      version: 2,
      configurationRevision: 'revision-test',
      capabilities: [],
      agentClasses: [{
        id: 'codex-cli',
        routingCapabilities: ['workspace-engineering'],
        primaryUseCases: [],
        avoidUseCases: [],
        affordances: [],
        modelPolicy: { mode: 'fixed', modelRef: 'test-model' },
      }],
    }), conversationId),
  };
}

describe('PlannerDataReader', () => {
  it('loads the immutable revision explicitly bound by the running session', async () => {
    const readSnapshot = vi.fn(async (revisionId: string) => ({
      revisionId,
      contentHash: `sha256:${revisionId}`,
      config: {},
    }));

    const snapshot = await loadPlannerConfigurationSnapshot(
      { readSnapshot } as never,
      'revision-runtime',
    );

    expect(snapshot.revisionId).toBe('revision-runtime');
    expect(readSnapshot).toHaveBeenCalledWith('revision-runtime');
  });

  it('fails closed when the running configuration revision is missing', async () => {
    await expect(loadPlannerConfigurationSnapshot(
      { readSnapshot: async () => ({}) } as never,
      undefined,
    )).rejects.toThrow('METACLAW_CONFIGURATION_REVISION is required');
  });

  it('uses explicit account-scoped database and configuration roots', () => {
    expect(resolvePlannerMcpRuntimePaths({
      home: '/legacy/data',
      databasePath: '/accounts/local-default/data/anyfusion.db',
      configurationRoot: '/accounts/local-default/config',
    })).toEqual({
      databasePath: '/accounts/local-default/data/anyfusion.db',
      configurationRoot: '/accounts/local-default/config',
    });
  });

  it('does not require a legacy home when both account-scoped paths are explicit', () => {
    expect(resolvePlannerMcpRuntimePaths({
      databasePath: '/accounts/local-default/data/anyfusion.db',
      configurationRoot: '/accounts/local-default/config',
    })).toEqual({
      databasePath: '/accounts/local-default/data/anyfusion.db',
      configurationRoot: '/accounts/local-default/config',
    });
  });

  it('requires a legacy home only when the database path needs fallback resolution', () => {
    expect(() => resolvePlannerMcpRuntimePaths({
      configurationRoot: '/accounts/local-default/config',
    })).toThrow('METACLAW_HOME is required when METACLAW_DB_PATH is missing');
  });

  it('bounds task search results and truncates summaries', () => {
    const { taskEngine, taskRepo, reader } = createHarness();
    for (let index = 0; index < 25; index += 1) {
      const task = taskEngine.create({ title: `research ${index}`, goal: `goal ${index}` });
      taskRepo.update(task.id, { summary: 'x'.repeat(600) });
    }

    const result = reader.searchTasks({ query: 'research', limit: 999 });

    expect(result.count).toBe(20);
    expect(result.tasks).toHaveLength(20);
    expect(String(result.tasks[0]?.summary).length).toBeLessThanOrEqual(320);
  });

  it('never exposes another Conversation Task through Planner reads', () => {
    const { taskEngine, reader } = createHarness('sess-a', 'conversation-a');
    taskEngine.create({
      id: 'task-a',
      title: 'private A task',
      goal: 'private A goal',
      conversationId: 'conversation-a',
    });
    taskEngine.create({
      id: 'task-b',
      title: 'private B task',
      goal: 'private B goal',
      conversationId: 'conversation-b',
    });

    expect(reader.searchTasks({ query: 'private' }).tasks.map(task => task.id)).toEqual(['task-a']);
    expect(reader.getTaskContext('task-b')).toEqual({ found: false, taskId: 'task-b' });
    expect(reader.getRuntimeState().activeTasks.map(task => task.id)).toEqual(['task-a']);
    expect(JSON.stringify(reader.getRuntimeState())).not.toContain('private B');
  });

  it('does not project foreign focus or pending permission into Planner context', () => {
    const { db, taskEngine, reader } = createHarness('sess-a', 'conversation-a');
    taskEngine.create({
      id: 'task-a',
      title: 'current task',
      goal: 'current goal',
      conversationId: 'conversation-a',
    });
    taskEngine.create({
      id: 'task-b',
      title: 'foreign task',
      goal: 'foreign goal',
      conversationId: 'conversation-b',
    });
    const now = '2026-08-29T00:00:00.000Z';
    db.prepare(`
      INSERT INTO session_state (
        id, last_focused_task_id, last_completed_task_id, last_session_id, updated_at
      ) VALUES ('global', 'task-b', 'task-b', 'sess-b', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO permission_requests (
        id, fingerprint, task_id, generation_id, subtask_id, attempt_id,
        agent_class_name, permission_profile_id, capability, resource_text,
        partition_key, partition_json, operation, reason, suggested_scope,
        distinct_request_ordinal, status, created_at
      ) VALUES ('permission-b', 'fingerprint-b', 'task-b', 'generation-b', 'subtask-b', 'attempt-b',
        'codex-cli', 'workspace-engineering', 'network', 'foreign.example',
        'network:foreign.example', '{}', 'read', 'foreign permission', 'once', 1, 'pending', ?)
    `).run(now);

    expect(reader.getRuntimeState().focus).toEqual({
      taskId: null,
      lastCompletedTaskId: null,
      updatedAt: now,
    });
    expect(reader.getPlanningContext().pendingAuthorizationRequest).toBeNull();
    expect(JSON.stringify(reader.getPlanningContext())).not.toContain('foreign permission');
  });

  it('truncates model-generated priority reasons in planner task reads', () => {
    const { taskEngine, taskRepo, reader } = createHarness();
    const task = taskEngine.create({ title: 'urgent research', goal: 'finish report' });
    taskRepo.update(task.id, {
      prioritySignals: {
        ...task.prioritySignals,
        semanticPriority: 'urgent',
        semanticPriorityReason: 'x'.repeat(600),
      },
    });

    const searchPriority = reader.searchTasks({ query: 'urgent research' }).tasks[0]?.priority;
    const context = reader.getTaskContext(task.id);
    const contextPriority = context.found ? context.task.priority : null;

    expect(searchPriority).toMatchObject({ semanticPriority: 'urgent' });
    expect(contextPriority).toMatchObject({ semanticPriority: 'urgent' });
    expect(String((searchPriority as Record<string, unknown>).semanticPriorityReason)).toHaveLength(320);
    expect(String((contextPriority as Record<string, unknown>).semanticPriorityReason)).toHaveLength(320);
  });

  it('keeps truncated planner text within its limit without splitting surrogate pairs', () => {
    const { taskEngine, taskRepo, reader } = createHarness();
    const task = taskEngine.create({ title: 'unicode research', goal: 'finish report' });
    taskRepo.update(task.id, { summary: `${'a'.repeat(319)}😀tail` });

    const summary = String(reader.searchTasks({ query: 'unicode research' }).tasks[0]?.summary);

    expect(summary).toBe(`${'a'.repeat(319)}…`);
    expect(summary).toHaveLength(320);
  });

  it('returns bounded recovery context for one explicit task id', () => {
    const { taskEngine, taskRepo, reader } = createHarness();
    const task = taskEngine.create({ title: 'blocked research', goal: 'finish report' });
    taskEngine.transition(task.id, 'ready');
    taskEngine.transition(task.id, 'running');
    taskEngine.block(task.id, {
      taskId: task.id,
      type: 'manual',
      description: 'waiting for authorization',
      status: 'waiting',
    });
    taskRepo.update(task.id, {
      snapshots: [{
        done: ['outline'],
        pending: ['final report'],
        nextStep: 'request authorization',
        pauseReason: 'blocked',
        createdAt: '2026-07-10T00:00:00.000Z',
      }],
    });

    const result = reader.getTaskContext(task.id);

    expect(result).toMatchObject({
      found: true,
      task: {
        id: task.id,
        status: 'blocked',
        latestSnapshot: { done: ['outline'], pending: ['final report'], nextStep: 'request authorization' },
        blockers: [{ taskId: task.id, description: 'waiting for authorization' }],
      },
    });
    expect(reader.getTaskContext('missing')).toEqual({ found: false, taskId: 'missing' });
  });

  it('excludes cancelled tasks from the current runtime snapshot', () => {
    const { taskEngine, reader } = createHarness();
    const task = taskEngine.create({
      title: '烧碱产业链与价格走势研究分析',
      goal: '研究当前公开信息',
    });
    taskEngine.cancel(task.id, 'durable cancellation fence authorized');

    const runtime = reader.getRuntimeState();

    expect(runtime.taskCounts).toMatchObject({ cancelled: 1 });
    expect(runtime.activeTasks).toEqual([]);
    expect(JSON.stringify(runtime.activeTasks)).not.toContain('烧碱');
  });

  it('binds session context to the trusted host session', () => {
    const { db, reader } = createHarness('sess_current');
    const insert = db.prepare(`
      INSERT INTO interactions (
        id, task_id, session_id, user_input, system_output, executor_used, created_at
      ) VALUES (?, NULL, ?, ?, ?, NULL, ?)
    `);
    insert.run('int_current', 'sess_current', 'continue this task', 'current response', '2026-07-10T00:00:00.000Z');
    insert.run('int_other', 'sess_other', 'secret other session', 'other response', '2026-07-10T00:00:01.000Z');

    const result = reader.getCurrentSessionContext(20);

    expect(result.sessionId).toBe('sess_current');
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0]?.userInput).toBe('continue this task');
    expect(JSON.stringify(result)).not.toContain('secret other session');
  });

  it('exposes bounded Planner-owned facts through MCP instead of prompt injection', () => {
    const { db, reader } = createHarness();
    db.prepare(`
      INSERT INTO preferences (
        id, type, scope, subject, content, status, confidence,
        occurrence_count, source_tasks, created_at, updated_at, confirmed_at
      ) VALUES (?, 'instruction', 'global', NULL, ?, 'confirmed', 1, 1, '[]', ?, ?, ?)
    `).run(
      'pref_planner',
      'Prefer concise answers.',
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
      '2026-07-30T00:00:00.000Z',
    );

    const result = reader.getPlanningContext();

    expect(result.confirmedPreferences).toEqual([
      expect.objectContaining({ id: 'pref_planner', content: 'Prefer concise answers.' }),
    ]);
    expect(result.routingCatalog.agentClasses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex-cli', routingCapabilities: ['workspace-engineering'] }),
    ]));
    expect(result.pendingAuthorizationRequest).toBeNull();
  });

  it('returns dynamic executor status without static catalog or runtime configuration', () => {
    const { db, taskEngine, reader } = createHarness();
    const task = taskEngine.create({ title: 'active task', goal: 'work' });
    taskEngine.transition(task.id, 'ready');
    db.prepare(`
      INSERT INTO session_state (
        id, last_focused_task_id, last_completed_task_id, last_session_id, updated_at
      ) VALUES ('global', ?, NULL, 'sess_current', ?)
    `).run(task.id, '2026-07-10T00:00:00.000Z');
    seedAgentClasses(db);
    const agentClassRepo = new AgentClassRepo(db);
    agentClassRepo.upsert({
      ...agentClassRepo.findByName('codex-cli')!,
      name: 'research-bot',
      runtimeCommand: 'C:\\private\\codex.exe',
      runtimeArgs: ['--token', 'sensitive-runtime-token'],
    });
    const now = '2026-07-10T00:00:00.000Z';
    db.prepare(`
      INSERT INTO kernel_executor_status (
        agent_class_name, configuration_revision, class_health,
        recent_attempts_json, recent_recovery_checks_json, updated_at
      )
      VALUES ('codex-cli', 'revision-test', 'healthy', ?, ?, ?)
    `).run(
      JSON.stringify([{ completedAt: now, outcome: 'failed', failureKind: 'network', reason: 'connection timeout' }]),
      JSON.stringify([{ checkId: 'check_1', trigger: 'planning_cycle', outcome: 'recovered', failure: null }]),
      now,
    );

    expect(reader.getRuntimeState()).toMatchObject({
      focus: { taskId: task.id },
      taskCounts: { ready: 1 },
      activeTasks: [expect.objectContaining({ id: task.id, status: 'ready' })],
    });
    const status = reader.listExecutorStatus();
    expect(status.executorStatuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentClassName: 'codex-cli',
        classHealth: 'healthy',
        recentAttempts: [expect.objectContaining({ failureKind: 'network' })],
        recentRecoveryChecks: [expect.objectContaining({
          checkId: 'check_1',
          trigger: 'planning_cycle',
          outcome: 'recovered',
        })],
      }),
    ]));
    expect(JSON.stringify(status)).not.toContain('sensitive-runtime-token');
    expect(JSON.stringify(status)).not.toContain('runtimeCommand');
    expect(JSON.stringify(status)).not.toContain('historicalSuccess');
  });

  it('returns bounded executor probe failures only when explicitly queried', () => {
    const { db, reader } = createHarness();
    const now = '2026-07-29T00:00:00.000Z';
    seedAgentClasses(db);
    db.prepare(`
      INSERT INTO work_units (
        id, agent_class_name, agent_class_kind, state, heartbeat_at,
        lease_expires_at, created_at, updated_at, claimed_attempt_id
      ) VALUES (?, ?, 'executor', 'failed', ?, NULL, ?, ?, NULL)
    `).run('executor-diagnostic', 'codex-cli', now, now, now);
    db.prepare(`
      INSERT INTO work_unit_events (
        id, work_unit_id, task_id, subtask_id, attempt_id,
        event_type, state, message, payload_json, created_at
      ) VALUES (?, ?, NULL, NULL, NULL, 'probe_failed', 'failed', ?, '{}', ?)
    `).run(
      'event-diagnostic',
      'executor-diagnostic',
      'executor probe failed: codex-cli: Cannot connect to the Docker daemon',
      now,
    );

    expect(reader.getExecutorDiagnostics({ agentClassName: 'codex-cli' })).toEqual({
      count: 1,
      failures: [{
        workUnitId: 'executor-diagnostic',
        agentClassName: 'codex-cli',
        taskId: null,
        subtaskId: null,
        eventType: 'probe_failed',
        state: 'failed',
        reason: 'executor probe failed: codex-cli: Cannot connect to the Docker daemon',
        createdAt: now,
      }],
    });
  });

  it('performs all planner reads with SQLite query-only mode enabled', () => {
    const { db, reader } = createHarness();
    db.pragma('query_only = ON');
    const before = Number((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count);

    reader.searchTasks({});
    reader.getPlanningContext();
    reader.getRuntimeState();
    reader.listExecutorStatus();
    reader.getExecutorDiagnostics({});

    const after = Number((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count);
    expect(after).toBe(before);
  });

  it('registers bounded executor diagnostics for explicit on-demand queries', () => {
    const server = readFileSync('src/planning/planner-mcp-server.ts', 'utf-8');
    const authority = readFileSync(
      'docs/adr/0015-planner-owned-semantics-and-tool-mediated-context.md',
      'utf-8',
    );

    expect(server).toContain("server.registerTool('get_executor_diagnostics'");
    expect(server).toContain("server.registerTool('list_executor_status'");
    expect(server).not.toContain("server.registerTool('list_executor_classes'");
    expect(server).toContain('when the user asks why execution is blocked');
    expect(authority).toContain('only through an explicit read-only diagnostic tool when the');
  });
});
