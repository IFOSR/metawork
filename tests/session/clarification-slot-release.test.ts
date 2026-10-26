import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { MetaclawSession } from '../../src/session/metaclaw-session.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { setTaskStatus } from '../support/task-state-fixture.js';
import { stubPlanningAgent, clarificationPlan } from '../support/planning-agent-plans.js';
import { FakeAttemptExecutionBackend } from '../support/fake-attempt-execution-backend.js';
import type { Config } from '../../src/core/types.js';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function createConfig(): Config {
  return {
    version: 1,
    executor: { command: 'codex', timeout: 60_000 },
    orchestration: {
      max_concurrent_attempts: 4,
      reminder_enabled: false,
      reminder_throttle: 3600,
      top_k_preferences: 5,
    },
    ui: { language: 'zh-CN', dashboard_on_start: false },
  };
}

/**
 * User-visible regression (2026-10-22 report): the Planner stopped a turn to ask
 * a clarifying question, the Task kept the Conversation slot, and the user's
 * answer was queued forever behind a Task that was only waiting for them.
 */
describe('Planner clarification releases the Conversation', () => {
  it('moves the owning Task to needs_action and frees the slot for the answer', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metawork-clarification-slot');
    const backend = new FakeAttemptExecutionBackend(() => ({ body: 'done' }));
    const scheduler = new ConversationTaskSchedulerRepo(db);
    const session = new MetaclawSession({
      taskEngine,
        orchestration: new OrchestrationEngine(taskEngine),
      attemptExecutionBackend: backend,
      db,
      config: createConfig(),
      sessionId: 'session-clarification-slot',
        notifier: { notifyTaskCompleted: vi.fn().mockResolvedValue(undefined) },
      planningAgent: stubPlanningAgent(
        clarificationPlan('页面错误卡片还会显示 error.code 与 message。请把这两个值发我。'),
      ),
    });
    try {
      session.initialize();

      // The first Task owns the Conversation slot and is executing.
      const task = taskEngine.create({
        title: 'debug the System One 502',
        goal: 'debug the System One 502',
        conversationId: 'session-clarification-slot',
        accountId: 'local-default',
        workspaceId: 'legacy-workspace',
        ownerPlannerSessionId: 'session-clarification-slot',
      });
      setTaskStatus(db, task.id, 'queued');
      setTaskStatus(db, task.id, 'running');
      scheduler.claimSlot('session-clarification-slot', task.id, 'reservation-1', new Date().toISOString());
      session.setCurrentTaskId(task.id);

      // The Planner answers with a clarification request instead of a plan.
      await session.submit('上游的服务在服务器way，你直接ssh way就可以登录。你自己查看找原因', {
        awaitAsyncWork: true,
      });

      const waiting = taskRepo.findById(task.id)!;
      expect(waiting.status).toBe('needs_action');
      expect(waiting.stateDetail.reason.code).toBe('input_required');
      expect(waiting.stateDetail.reason.message).toContain('error.code');
      expect(waiting.stateDetail.pendingActions.some(action => action.kind === 'provide_input')).toBe(true);

      // The Conversation is free again, so the user's next answer can run.
      expect(scheduler.getSlot('session-clarification-slot')).toMatchObject({
        state: 'free',
        activeTaskId: null,
      });
      expect(session.getSnapshot().output.join('\n')).toContain('需要你回答');
    } finally {
      await session.dispose();
      db.close();
    }
  });

  it('does not hand the slot on while the waiting Task still owns live residue', async () => {
    const db = createTestDb();
    const taskRepo = new TaskRepo(db);
    const taskEngine = new TaskEngine(taskRepo, '/tmp/metawork-clarification-residue');
    const scheduler = new ConversationTaskSchedulerRepo(db);
    const session = new MetaclawSession({
      taskEngine,
        orchestration: new OrchestrationEngine(taskEngine),
      attemptExecutionBackend: new FakeAttemptExecutionBackend(() => ({ body: 'done' })),
      db,
      config: createConfig(),
      sessionId: 'session-clarification-residue',
        notifier: { notifyTaskCompleted: vi.fn().mockResolvedValue(undefined) },
      planningAgent: stubPlanningAgent(clarificationPlan('还需要更多信息。')),
    });
    try {
      session.initialize();
      const task = taskEngine.create({
        title: 'residue task',
        goal: 'residue task',
        conversationId: 'session-clarification-residue',
        accountId: 'local-default',
        workspaceId: 'legacy-workspace',
        ownerPlannerSessionId: 'session-clarification-residue',
      });
      setTaskStatus(db, task.id, 'queued');
      setTaskStatus(db, task.id, 'running');
      scheduler.claimSlot('session-clarification-residue', task.id, 'reservation-1', new Date().toISOString());
      // A live publication is residue: the slot must stay held (state=releasing)
      // instead of being handed to the next Task.
      db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
        VALUES ('revision-residue', 'hash', 'native', ?)`).run(new Date().toISOString());
      db.prepare(`INSERT INTO work_graph_revisions
        (id, task_id, revision, generation_id, configuration_revision, proposal_source, automatic_replan,
          status, created_at, updated_at, completion_requirements_json)
        VALUES ('wgr-residue', ?, 1, ?, 'revision-residue', 'initial', 0, 'active', ?, ?, '[]')`)
        .run(task.id, `generation-${task.id}`, new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO subtasks (id, task_id, generation_id, title, goal, status, dependencies_json,
        context_refs_json, required_capabilities_json, executor_bindings_json, delivery_kind, created_at, updated_at)
        VALUES (?, ?, ?, 'node', 'node', 'done', '[]', '[]', '[]', '[]', 'edit', ?, ?)`)
        .run(`${task.id}_node`, task.id, `generation-${task.id}`, new Date().toISOString(), new Date().toISOString());
      db.prepare(`INSERT INTO workspace_publications
        (id, task_id, generation_id, subtask_id, source_attempt_id, agent_class_name, candidate_commit,
          original_completion_json, topology_layer, first_dispatch_order, status, created_at, updated_at)
        VALUES ('pub-residue', ?, ?, ?, 'attempt-1', 'codex-cli', 'commit-1', '{}', 0, 0, 'pending', ?, ?)`)
        .run(task.id, `generation-${task.id}`, `${task.id}_node`, new Date().toISOString(), new Date().toISOString());
      session.setCurrentTaskId(task.id);

      await session.submit('请继续', { awaitAsyncWork: true });

      expect(taskRepo.findById(task.id)?.status).toBe('needs_action');
      const slot = scheduler.getSlot('session-clarification-residue');
      expect(slot.activeTaskId).toBe(task.id);
      expect(slot.state).toBe('releasing');
    } finally {
      await session.dispose();
      db.close();
    }
  });
});
