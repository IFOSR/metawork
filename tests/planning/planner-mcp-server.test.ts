import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AgentClassService } from '../../src/executor/agent-class-service.js';
import { PlannerDataReader } from '../../src/planning/planner-mcp-server.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';

function createHarness(sessionId = 'sess_current') {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-planner-mcp');
  return { db, taskRepo, taskEngine, reader: new PlannerDataReader(db, sessionId) };
}

describe('PlannerDataReader', () => {
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

  it('returns dynamic executor status without static catalog or runtime configuration', () => {
    const { db, taskEngine, reader } = createHarness();
    const task = taskEngine.create({ title: 'active task', goal: 'work' });
    taskEngine.transition(task.id, 'ready');
    db.prepare(`
      INSERT INTO session_state (
        id, last_focused_task_id, last_completed_task_id, last_session_id, updated_at
      ) VALUES ('global', ?, NULL, 'sess_current', ?)
    `).run(task.id, '2026-07-10T00:00:00.000Z');
    const agentClassService = new AgentClassService({ db, defaultExecutorName: 'codex-cli' });
    agentClassService.seedDefaults();
    agentClassService.upsert({
      ...agentClassService.findByName('codex-cli')!,
      runtimeCommand: 'C:\\private\\codex.exe',
      runtimeArgs: ['--token', 'sensitive-runtime-token'],
    });
    const now = '2026-07-10T00:00:00.000Z';
    db.prepare(`
      INSERT INTO kernel_executor_status (agent_class_name, class_health, recent_attempts_json, updated_at)
      VALUES ('codex-cli', 'healthy', ?, ?)
    `).run(JSON.stringify([{ completedAt: now, outcome: 'failed', failureKind: 'network', reason: 'connection timeout' }]), now);

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
      }),
    ]));
    expect(JSON.stringify(status)).not.toContain('sensitive-runtime-token');
    expect(JSON.stringify(status)).not.toContain('runtimeCommand');
    expect(JSON.stringify(status)).not.toContain('historicalSuccess');
  });

  it('performs all planner reads with SQLite query-only mode enabled', () => {
    const { db, reader } = createHarness();
    db.pragma('query_only = ON');
    const before = Number((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count);

    reader.searchTasks({});
    reader.getRuntimeState();
    reader.listExecutorStatus();

    const after = Number((db.prepare('SELECT total_changes() AS count').get() as { count: number }).count);
    expect(after).toBe(before);
  });
});
