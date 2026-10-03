import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { SqliteConversationActivitySource } from '../../src/storage/conversation-activity-source.js';
import { SqliteConversationActivityProjection } from '../../src/storage/conversation-activity-projection-repo.js';
import { SqliteTaskActivityFacts } from '../../src/storage/task-activity-facts-repo.js';
import { projectTaskView } from '../../src/task/task-view.js';
const binding: AuthorizedExecutorBinding = {
  agentClassRef: 'pi-research',
  harnessRef: 'pi-cli',
  providerRef: 'deepseek',
  modelRef: 'deepseek-chat',
  permissionProfileRef: 'public-web-research',
  configurationRevision: 'revision-1',
};

function setup(): { db: Database.Database; repo: KernelDispatchItemRepo } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const now = '2026-09-03T15:30:28.000Z';
  db.prepare(`
    INSERT INTO tasks (
      id, title, goal, status, created_at, updated_at,
      account_id, conversation_id, workspace_id, owner_planner_session_id, admitted_at
    ) VALUES ('task-1', 'T', 'T', 'running', ?, ?, 'account', 'conv-1', 'workspace', 'planner', ?)
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision-1', 'sha256:test', 'native', ?)
  `).run(now);
  db.prepare(`
    INSERT INTO work_graph_revisions (id, task_id, revision, generation_id, status, configuration_revision, created_at, updated_at)
    VALUES ('wgr-1', 'task-1', 1, 'generation-1', 'active', 'revision-1', ?, ?)
  `).run(now, now);
  db.prepare(`
    INSERT INTO subtasks (id, task_id, generation_id, title, goal, status, dependencies_json,
      context_refs_json, required_capabilities_json, executor_bindings_json, delivery_kind, created_at, updated_at)
    VALUES ('subtask-1', 'task-1', 'generation-1', 'S', 'S', 'ready', '[]', '[]', '[]', '[]', 'report', ?, ?)
  `).run(now, now);
  return { db, repo: new KernelDispatchItemRepo(db) };
}

function dispatchDecision(taskId = 'task-1') {
  return {
    id: `decision-${taskId}`,
    eventId: `event-${taskId}`,
    configurationRevision: binding.configurationRevision,
    reason: 'test dispatch',
    action: {
      type: 'dispatch_batch' as const,
      taskId,
      items: [{
        subtaskId: 'subtask-1',
        authorizedBinding: binding,
        bindingFingerprint: 'sha256:abc',
        attemptId: `attempt-${taskId}`,
        attemptKind: 'primary' as const,
        sourceAttemptId: null,
        recoveryMode: 'fresh' as const,
        defaultResourceGrant: [],
        order: 0,
        attemptPayload: { workspacePath: '/tmp/workspace' },
      }],
    },
  };
}


describe('runtime progress activity projection', () => {
  it('reads bounded phase witnesses despite a large settled attempt history', () => {
    const { db, repo } = setup();
    try {
      const decision = dispatchDecision();
      repo.insertBatch(decision as never, { generationId: 'generation-1', configurationRevision: binding.configurationRevision,
        attempts: { 'attempt-task-1': { authorizedBinding: binding, bindingFingerprint: 'sha256:abc' } } }, '2026-10-03T00:00:00Z');
      const reader = new SqliteTaskActivityFacts(db);
      const task = { id: 'task-1', status: 'running' as const, updatedAt: '' };
      expect(projectTaskView(reader.read(task, null)).phase).toBe('executing');
      db.prepare("UPDATE kernel_dispatch_items SET status = 'terminal' WHERE task_id = ?").run(task.id);
      const insert = db.prepare(`INSERT INTO kernel_dispatch_items
        SELECT 'old-' || ?, decision_id, batch_order, task_id, generation_id, subtask_id, agent_class_name,
          attempt_kind, source_attempt_id, recovery_mode, attempt_payload_json, resource_grant_json, status,
          work_unit_id, sandbox_container_id, launch_started_at, terminal_at, cancellation_decision_id,
          cancel_requested_at, cancelled_at, error_summary, configuration_revision, authorized_binding_json,
          binding_fingerprint, created_at, updated_at FROM kernel_dispatch_items WHERE attempt_id = 'attempt-task-1'`);
      db.transaction(() => { for (let n = 0; n < 10000; n++) insert.run(n); })();
      const facts = reader.read(task, { requestId: 'approval' });
      expect(facts.dispatches).toEqual([]); expect(facts.receipts).toEqual([]);
      expect(projectTaskView(facts).phase).toBe('waiting_for_user');
      expect(Buffer.byteLength(JSON.stringify(facts))).toBeLessThan(1024);
      expect(db.prepare(`EXPLAIN QUERY PLAN SELECT attempt_id FROM kernel_dispatch_items
        WHERE task_id = ? AND status IN ('pending_launch', 'launching', 'running', 'cancelling') LIMIT 1`).all(task.id))
        .toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining('observation_witness_kernel_dispatch_items') })]));
    } finally { db.close(); }
  });
  it('invalidates the owning Task and excludes late progress from a previous generation', () => {
    const { db, repo } = setup();
    try {
      const decision = dispatchDecision();
      repo.insertBatch(decision as never, { generationId: 'generation-1', configurationRevision: binding.configurationRevision,
        attempts: { 'attempt-task-1': { authorizedBinding: binding, bindingFingerprint: 'sha256:abc' } } }, '2026-10-03T00:00:00Z');
      const old = { ...decision, id: 'old', action: { ...decision.action, items: [{ ...decision.action.items[0]!, attemptId: 'old-attempt' }] } };
      repo.insertBatch(old as never, { generationId: 'old-generation', configurationRevision: binding.configurationRevision,
        attempts: { 'old-attempt': { authorizedBinding: binding, bindingFingerprint: 'sha256:abc' } } }, '2026-10-02T00:00:00Z');
      db.exec('DELETE FROM conversation_activity_dirty');
      const insert = db.prepare(`INSERT INTO executor_attempt_runtime(attempt_id, recovery_safety, progress_json, created_at, updated_at)
        VALUES (?, 'safe', ?, ?, ?)`);
      insert.run('attempt-task-1', JSON.stringify({ text: 'current progress' }), '2026-10-03T00:00:01Z', '2026-10-03T00:00:01Z');
      const projection = new SqliteConversationActivityProjection(db);
      const first = projection.nextDirty()!;
      expect(first.task.id).toBe('task-1');
      insert.run('old-attempt', JSON.stringify({ text: 'late old progress' }), '2026-10-03T00:00:02Z', '2026-10-03T00:00:02Z');
      expect(projection.nextDirty()!.version).toBeGreaterThan(first.version);
      const source = new SqliteConversationActivitySource(db);
      expect(source.latestProgress('task-1', 'generation-1')).toBe('current progress');
      expect(source.latestProgress('task-1', 'missing-generation')).toBeNull();
      db.prepare('UPDATE executor_attempt_runtime SET progress_json = ? WHERE attempt_id = ?')
        .run(JSON.stringify({ text: 'next progress' }), 'attempt-task-1');
      expect(source.latestProgress('task-1', 'generation-1')).toBe('next progress');
      expect(projection.nextDirty()!.version).toBeGreaterThan(first.version + 1);
    } finally { db.close(); }
  });
});
