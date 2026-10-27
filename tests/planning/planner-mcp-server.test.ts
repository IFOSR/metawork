import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
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
import type { PlannerExecutorCapabilityManual } from '../../src/configuration/types.js';
import type { PlannerAttachmentView } from '../../src/planning/planning-types.js';
import { setTaskStatus } from '../support/task-state-fixture.js';

function createHarness(
  sessionId = 'sess_current',
  conversationId = 'legacy-conversation',
  manuals: readonly PlannerExecutorCapabilityManual[] = [],
  attachments: readonly PlannerAttachmentView[] = [],
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
  const engine = new TaskEngine(taskRepo, '/tmp/metaclaw-planner-mcp');
  const accountId = 'local-default';
  const taskEngine = {
    // Every Planner fact is account-scoped; fixtures must not straddle accounts.
    create: (input: Parameters<typeof engine.create>[0]) => engine.create({ accountId, ...input }),
  } as unknown as TaskEngine;
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
      // TaskEngine fixtures persist their Tasks under the legacy account, so the
      // reader must use the same isolation boundary these facts live in.
    }), conversationId, () => manuals, 'local-default', attachments),
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
    const { db, taskEngine, taskRepo, reader } = createHarness();
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
    const { db, taskEngine, reader } = createHarness('sess-a', 'conversation-a');
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

  it('projects independent Executor capability manuals with explicit completeness metadata', () => {
    const { reader } = createHarness('sess-manuals', 'conversation-manuals', [
      {
        agentClassRef: 'codex-engineering',
        configurationRevision: 'revision-test',
        sourceFingerprint: 'sha256:manual',
        markdown: '# Executor: codex-engineering\n\n## Best Fit\n- TypeScript refactoring',
        tags: { bestFit: ['TypeScript refactoring'], avoid: [] },
      },
      {
        agentClassRef: 'pi-research',
        configurationRevision: 'revision-test',
        sourceFingerprint: 'sha256:research',
        markdown: '# Executor: pi-research\n\n## Best Fit\n- source-backed research',
        tags: { bestFit: ['source-backed research'], avoid: [] },
      },
    ]);

    expect(reader.getPlanningContext().executorCapabilityManuals).toEqual([
      expect.objectContaining({
        agentClassRef: 'codex-engineering',
        markdown: expect.stringContaining('TypeScript refactoring'),
        truncated: false,
      }),
      expect.objectContaining({
        agentClassRef: 'pi-research',
        markdown: expect.stringContaining('source-backed research'),
        truncated: false,
      }),
    ]);
  });

  it('preserves all revision-pinned manuals beyond the former aggregate byte limit', () => {
    const manuals = ['pi-research', 'codex-engineering'].map(agentClassRef => ({
      agentClassRef,
      configurationRevision: 'revision-test',
      sourceFingerprint: `sha256:${agentClassRef}`,
      markdown: `# ${agentClassRef}\n${'中文模型能力与执行职责。'.repeat(1200)}\n最后的限制说明。`,
      tags: { bestFit: ['资料分析'], avoid: ['未经验证的结论'] },
    }));
    expect(manuals.reduce((sum, manual) => sum + Buffer.byteLength(manual.markdown), 0)).toBeGreaterThan(60_000);
    const { reader, db } = createHarness('sess-long-manuals', 'conversation-long-manuals', manuals);
    try {
      expect(reader.getPlanningContext().executorCapabilityManuals).toEqual(
        [manuals[1], manuals[0]].map(manual => ({ ...manual, truncated: false })),
      );
    } finally { db.close(); }
  });

  it('projects only safe metadata for the current Turn attachments', () => {
    const { reader } = createHarness(
      'sess-attachments',
      'conversation-attachments',
      [],
      [{
        attachmentId: 'att_screenshot',
        name: 'screenshot.png',
        mime: 'image/png',
        size: 4096,
        availability: 'available',
      }],
    );

    expect(reader.getPlanningContext().attachments).toEqual([{
      attachmentId: 'att_screenshot',
      name: 'screenshot.png',
      mime: 'image/png',
      size: 4096,
      availability: 'available',
    }]);
    const serialized = JSON.stringify(reader.getPlanningContext());
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('absolute');
    expect(serialized).not.toContain('secret body');
  });

  it('truncates model-generated priority reasons in planner task reads', () => {
    const { db, taskEngine, taskRepo, reader } = createHarness();
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
    const { db, taskEngine, taskRepo, reader } = createHarness();
    const task = taskEngine.create({ title: 'unicode research', goal: 'finish report' });
    taskRepo.update(task.id, { summary: `${'a'.repeat(319)}😀tail` });

    const summary = String(reader.searchTasks({ query: 'unicode research' }).tasks[0]?.summary);

    expect(summary).toBe(`${'a'.repeat(319)}…`);
    expect(summary).toHaveLength(320);
  });

  it('returns bounded recovery context for one explicit task id', () => {
    const { db, taskEngine, taskRepo, reader } = createHarness();
    const task = taskEngine.create({ title: 'blocked research', goal: 'finish report' });
    setTaskStatus(db, task.id, 'queued');
    setTaskStatus(db, task.id, 'running');
    setTaskStatus(db, task.id, 'needs_action');
    taskRepo.update(task.id, {
      snapshots: [{
        done: ['outline'],
        pending: ['final report'],
        nextStep: 'request authorization',
        pauseReason: 'blocked',
        createdAt: '2026-07-10T00:00:00.000Z',
      }],
      dependencies: [{
        taskId: task.id,
        type: 'manual',
        description: 'waiting for authorization',
        status: 'waiting',
        createdAt: '2026-07-10T00:00:00.000Z',
      }],
    });

    const result = reader.getTaskContext(task.id);

    expect(result).toMatchObject({
      found: true,
      task: {
        id: task.id,
        status: 'needs_action',
        latestSnapshot: { done: ['outline'], pending: ['final report'], nextStep: 'request authorization' },
        blockers: [{ taskId: task.id, description: 'waiting for authorization' }],
      },
    });
    expect(reader.getTaskContext('missing')).toEqual({ found: false, taskId: 'missing' });
  });

  it('excludes cancelled tasks from the current runtime snapshot', () => {
    const { db, taskEngine, reader } = createHarness();
    const task = taskEngine.create({
      title: '烧碱产业链与价格走势研究分析',
      goal: '研究当前公开信息',
    });
    setTaskStatus(db, task.id, 'cancelled');

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

  it('projects same-Conversation historical artifacts and executor results as bounded context facts', () => {
    const { db, taskEngine, reader } = createHarness('sess-artifacts', 'conversation-artifacts');
    const publishedPath = '/tmp/metawork-planner-product-image.jpg';
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01]);
    writeFileSync(publishedPath, imageBytes);
    const task = taskEngine.create({
      id: 'task-image-history',
      title: '生成商品图',
      goal: '生成并发布商品图片',
      conversationId: 'conversation-artifacts',
      workspaceId: 'workspace-artifacts',
    });
    db.prepare(`
      INSERT INTO interactions (
        id, task_id, session_id, user_input, system_output, executor_used, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'interaction-image-result',
      task.id,
      'sess-artifacts',
      '生成一张商品图',
      '已生成商品主图。',
      'pi-agent',
      '2026-08-31T00:00:00.000Z',
    );
    try {
      db.prepare(`
        INSERT INTO task_artifacts (
          artifact_id, account_id, task_id, generation_id, subtask_id,
          publication_id, display_name, relative_path, published_path,
          media_type, preview_kind, content_hash, byte_length, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'artifact-product-image',
        'local-default',
        task.id,
        'generation-image',
        'generate-image',
        'publication-image',
        '商品主图.jpg',
        'assets/product.jpg',
        publishedPath,
        'image/jpeg',
        'unsupported',
        `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`,
        imageBytes.byteLength,
        'published',
        '2026-08-31T00:00:01.000Z',
        '2026-08-31T00:00:01.000Z',
      );

      const result = reader.getCurrentSessionContext(20);

      expect(result.artifacts).toEqual([expect.objectContaining({
        artifactId: 'artifact-product-image',
        taskId: task.id,
        displayName: '商品主图.jpg',
        relativePath: 'assets/product.jpg',
        mediaType: 'image/jpeg',
        availability: 'available',
        contentHash: `sha256:${createHash('sha256').update(imageBytes).digest('hex')}`,
      })]);
      expect(result.executorResults).toEqual([expect.objectContaining({
        resultId: 'interaction-image-result',
        taskId: task.id,
        artifactIds: ['artifact-product-image'],
      })]);
      expect(JSON.stringify(result)).not.toContain(publishedPath);
    } finally {
      rmSync(publishedPath, { force: true });
    }
  });

  it('projects unavailable and foreign artifacts without making them eligible candidates', () => {
    const { db, taskEngine, reader } = createHarness(
      'sess-artifact-boundaries',
      'conversation-artifact-boundaries',
    );
    const currentTask = taskEngine.create({
      id: 'task-current-artifacts',
      title: '当前任务',
      goal: '验证产物边界',
      conversationId: 'conversation-artifact-boundaries',
      workspaceId: 'workspace-artifact-boundaries',
    });
    const foreignTask = taskEngine.create({
      id: 'task-foreign-artifacts',
      title: '其他会话任务',
      goal: '不应被看见',
      conversationId: 'conversation-foreign',
      workspaceId: 'workspace-foreign',
    });
    const availablePath = '/tmp/metawork-planner-available.txt';
    const bytes = Buffer.from('available artifact');
    writeFileSync(availablePath, bytes);
    try {
      const insert = db.prepare(`
        INSERT INTO task_artifacts (
          artifact_id, account_id, task_id, generation_id, subtask_id,
          publication_id, display_name, relative_path, published_path,
          media_type, preview_kind, content_hash, byte_length, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        'artifact-available',
        'local-default',
        currentTask.id,
        'available.txt',
        'available.txt',
        availablePath,
        'text/plain; charset=utf-8',
        'text',
        `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes.byteLength,
        'published',
        '2026-08-31T00:00:00.000Z',
        '2026-08-31T00:00:00.000Z',
      );
      insert.run(
        'artifact-unavailable',
        'local-default',
        currentTask.id,
        'unavailable.txt',
        'unavailable.txt',
        '/tmp/missing-artifact.txt',
        'text/plain; charset=utf-8',
        'text',
        'sha256:missing',
        7,
        'unavailable',
        '2026-08-31T00:00:01.000Z',
        '2026-08-31T00:00:01.000Z',
      );
      insert.run(
        'artifact-foreign',
        'local-default',
        foreignTask.id,
        'foreign.txt',
        'foreign.txt',
        '/tmp/foreign-artifact.txt',
        'text/plain; charset=utf-8',
        'text',
        'sha256:foreign',
        7,
        'published',
        '2026-08-31T00:00:02.000Z',
        '2026-08-31T00:00:02.000Z',
      );

      const result = reader.getCurrentSessionContext(20);

      expect(result.artifacts.map(artifact => ({
        artifactId: artifact.artifactId,
        availability: artifact.availability,
      }))).toEqual([
        { artifactId: 'artifact-available', availability: 'available' },
        { artifactId: 'artifact-unavailable', availability: 'unavailable' },
      ]);
      expect(JSON.stringify(result)).not.toContain('artifact-foreign');
      expect(JSON.stringify(result)).not.toContain('/tmp/missing-artifact.txt');
    } finally {
      rmSync(availablePath, { force: true });
    }
  });

  it('exposes bounded Planner-owned facts through MCP without a retired preference projection', () => {
    const { reader } = createHarness();

    const result = reader.getPlanningContext();

    // The pre-TDAI preference store is retired; the Planner reaches durable
    // memory only through the memory recall read model.
    expect(result).not.toHaveProperty('confirmedPreferences');
    expect(result.routingCatalog.agentClasses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'codex-cli', routingCapabilities: ['workspace-engineering'] }),
    ]));
    expect(result.pendingAuthorizationRequest).toBeNull();
  });

  it('returns dynamic executor status without static catalog or runtime configuration', () => {
    const { db, taskEngine, reader } = createHarness();
    const task = taskEngine.create({ title: 'active task', goal: 'work' });
    setTaskStatus(db, task.id, 'queued');
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
      taskCounts: { queued: 1 },
      activeTasks: [expect.objectContaining({ id: task.id, status: 'queued' })],
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

describe('Planner task failure diagnosis', () => {
  it('projects the real failure so a follow-up request does not repeat it', () => {
    const { db, taskEngine, taskRepo, reader } = createHarness('sess-f', 'conversation-f');
    const task = taskEngine.create({
      title: 'run the service',
      goal: 'run the backend service',
      conversationId: 'conversation-f',
    });
    db.prepare('UPDATE tasks SET status = ?, state_detail_json = ? WHERE id = ?').run(
      'failed',
      JSON.stringify({
        reason: {
          code: 'service_start_failed',
          message: '服务进程已退出，需显式重启',
          evidenceRefs: ['service:backend'],
        },
        unresolved: [],
        phase: null,
        pendingActions: [],
        requiredWork: [],
        cleanup: { state: 'none', objects: [] },
        nextWakeAt: null,
      }),
      task.id,
    );
    db.prepare(`INSERT INTO task_operation_results (
      task_id, operation_key, operation_kind, outcome, reason_code, message, evidence_refs_json, updated_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      task.id, 'service:start:backend:r1:attempt:0', 'service', 'definite_failure',
      'service_start_failed', '退出码 1', '[]', '2026-10-27T00:00:00.000Z',
    );
    const context = reader.getTaskContext(task.id);
    expect(context.found).toBe(true);
    if (!context.found) throw new Error('task missing');
    expect(context.task.failure).toMatchObject({
      reason: { code: 'service_start_failed', message: '服务进程已退出，需显式重启' },
      operations: [{ kind: 'service', outcome: 'definite_failure', reasonCode: 'service_start_failed' }],
      lastFailedAttempt: null,
    });
    const listed = reader.searchTasks({ query: 'run the service' }).tasks[0];
    expect(listed?.reason).toEqual({
      code: 'service_start_failed',
      message: '服务进程已退出，需显式重启',
    });
  });
});

describe('Planner failure facts: vocabulary, isolation and terminal states', () => {
  function insertFailedAttempt(
    db: Database.Database,
    input: { taskId: string; attemptId: string; terminalState: string; failure: unknown; completedAt?: string },
  ): void {
    const now = input.completedAt ?? '2026-10-27T00:00:00.000Z';
    db.prepare(`INSERT OR IGNORE INTO subtasks (
      id, task_id, title, goal, status, required_capabilities_json, executor_bindings_json,
      acceptance_json, created_at, updated_at
    ) VALUES (?,?,?,?,'done','[]','[]','[]',?,?)`).run(
      'subtask-1', input.taskId, 'Work', 'Do the work', now, now,
    );
    db.prepare(`INSERT OR IGNORE INTO work_units (
      id, agent_class_name, agent_class_kind, state, created_at, updated_at
    ) VALUES (?,?,?,'idle',?,?)`).run('wu-1', 'pi-engineering', 'executor', now, now);
    db.prepare(`INSERT INTO executor_attempt_receipts (
      attempt_id, execution_id, task_id, subtask_id, work_unit_id, agent_class_name,
      started_at, completed_at, terminal_state, raw_response, completion_schema_version,
      parsing_json, verification_json, error_code, error_detail, graph_revision,
      generation_id, attempt_kind, source_attempt_id, failure_json, recovery_mode,
      configuration_revision, authorized_binding_json, binding_fingerprint
    ) VALUES (?,?,?,?,?,?,?,?,?,'',NULL,'{}','{}','error_x','detail',1,'generation_1','primary',NULL,?,'fresh',?, '{}', 'fp')`).run(
      input.attemptId, `exec-${input.attemptId}`, input.taskId, 'subtask-1', 'wu-1', 'pi-engineering',
      now, now, input.terminalState,
      input.failure === null ? null : JSON.stringify(input.failure),
      'revision-test',
    );
  }

  it('rejects historical Task status vocabulary instead of silently widening the query', () => {
    const { taskEngine, reader } = createHarness('sess-v', 'conversation-v');
    taskEngine.create({ title: 'legacy filter', goal: 'goal', conversationId: 'conversation-v' });
    const result = reader.searchTasks({ statuses: ['done', 'blocked'] });
    expect(result.count).toBe(0);
    expect(result.tasks).toEqual([]);
    expect(result.invalidStatuses).toEqual(['done', 'blocked']);
    expect(result.allowedStatuses).toEqual([
      'queued', 'running', 'needs_action', 'succeeded', 'failed', 'cancelled',
    ]);
    // The current vocabulary is accepted (a fresh Task is `queued`).
    expect(reader.searchTasks({ statuses: ['queued'] }).count).toBe(1);
  });

  it('never projects a healthy Task as a failure', () => {
    const { db, taskEngine, reader } = createHarness('sess-h', 'conversation-h');
    const task = taskEngine.create({ title: 'healthy work', goal: 'do it', conversationId: 'conversation-h' });
    db.prepare('UPDATE tasks SET status = ?, state_detail_json = ? WHERE id = ?').run(
      'succeeded',
      JSON.stringify({
        reason: { code: 'none', message: '用户要求的必需工作已全部完成。', evidenceRefs: [] },
      }),
      task.id,
    );
    const context = reader.getTaskContext(task.id);
    expect(context.found).toBe(true);
    if (!context.found) throw new Error('missing');
    expect(context.task.failure).toBeNull();
    expect(reader.searchTasks({ query: 'healthy work' }).tasks[0]?.reason).toBeUndefined();
  });

  it('scopes task facts to the owning account', () => {
    const { db, taskEngine } = createHarness('sess-a1', 'conversation-a1');
    const task = taskEngine.create({ title: 'account scoped', goal: 'goal', conversationId: 'conversation-a1' });
    const foreign = new PlannerDataReader(db, 'sess-a2', () => ({
      version: 2,
      configurationRevision: 'revision-test',
      capabilities: [],
      agentClasses: [],
    }), 'conversation-a1', () => [], 'another-account');
    expect(foreign.getTaskContext(task.id)).toEqual({ found: false, taskId: task.id });
    expect(foreign.searchTasks({ query: 'account scoped' }).count).toBe(0);
  });

  it('reports contract failures and ignores an uncertified result', () => {
    const { db, taskEngine, reader } = createHarness('sess-t', 'conversation-t');
    const task = taskEngine.create({ title: 'attempt facts', goal: 'goal', conversationId: 'conversation-t' });
    insertFailedAttempt(db, {
      taskId: task.id,
      attemptId: 'attempt-uncertified',
      terminalState: 'uncertified_result',
      failure: { code: 'completion_malformed', summary: 'awaiting a user decision' },
    });
    const uncertified = reader.getTaskContext(task.id);
    if (!uncertified.found) throw new Error('missing');
    expect(uncertified.task.failure?.lastFailedAttempt).toBeNull();

    insertFailedAttempt(db, {
      taskId: task.id,
      attemptId: 'attempt-blocked',
      terminalState: 'contract_blocked',
      failure: { code: 'completion_missing', summary: 'completion protocol was not satisfied' },
      completedAt: '2026-10-27T00:05:00.000Z',
    });
    const blocked = reader.getTaskContext(task.id);
    if (!blocked.found) throw new Error('missing');
    expect(blocked.task.failure?.lastFailedAttempt).toMatchObject({
      attemptId: 'attempt-blocked',
      terminalState: 'contract_blocked',
      failureCode: 'completion_missing',
      failureSummary: 'completion protocol was not satisfied',
    });
  });
});
