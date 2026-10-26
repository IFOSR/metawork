import { describe, expect, it } from 'vitest';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { workspacePathClaim, workspaceRootClaim } from '../../src/resource/workspace-claim.js';
import { publicTaskRelativeDirectory } from '../../src/task/public-task-directory.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { seedAgentClasses } from '../support/seed-agent-classes.js';

/** Minimal durable rows so ResourceLease foreign keys can resolve. */
function seedLeaseOwners(db: Database.Database, taskIds: readonly string[]): void {
  const now = '2026-10-24T00:00:00.000Z';
  seedAgentClasses(db);
  const insertTask = db.prepare(`INSERT INTO tasks (
    id, title, goal, status, summary, snapshot_json, resources_json, artifacts_json,
    dependencies_json, priority_json, injected_prefs_json, last_scheduling_reason,
    last_interruption_reason, interruption_count, created_at, updated_at
  ) VALUES (?, 'task', 'task', 'running', '', '[]', '[]', '[]', '[]', '{}', '[]', '', '', 0, ?, ?)`);
  const insertSubtask = db.prepare(`INSERT INTO subtasks (
    id, task_id, graph_revision, generation_id, title, goal, status, dependencies_json,
    context_refs_json, required_capabilities_json, executor_bindings_json,
    delivery_kind, acceptance_json, risk_level, result, artifacts_json,
    verification_json, error, created_at, updated_at
  ) VALUES (?, ?, 1, ?, ?, ?, 'ready', '[]', '[]', '[]', '[]', 'report', '[]', 'low', '', '[]', '{}', NULL, ?, ?)`);
  const insertWorkUnit = db.prepare(`INSERT INTO work_units (
    id, agent_class_name, agent_class_kind, state, claimed_task_id, claimed_subtask_id,
    claimed_attempt_id, heartbeat_at, lease_expires_at, created_at, updated_at
  ) VALUES (?, 'codex-cli', 'executor', 'idle', NULL, NULL, NULL, NULL, NULL, ?, ?)`);
  for (const taskId of taskIds) {
    insertTask.run(taskId, now, now);
    insertSubtask.run(`subtask_attempt_${taskId}`, taskId, `generation_${taskId}`, 'a', 'a', now, now);
    insertSubtask.run(`subtask_publication_${taskId}`, taskId, `generation_${taskId}`, 'b', 'b', now, now);
    insertWorkUnit.run(`work_unit_attempt_${taskId}`, now, now);
    insertWorkUnit.run(`work_unit_publication_${taskId}`, now, now);
  }
}

/**
 * The P0 this covers: an in-place Attempt and a worktree publication write the
 * same physical directory. They must reach the same ResourceLease partition, so
 * one of them sees a conflict instead of both writing.
 */
describe('in-place Attempt versus worktree publication', () => {
  function services() {
    const db = new Database(':memory:');
    runMigrations(db);
    seedLeaseOwners(db, ['task_attempt', 'task_publication']);
    const repository = new SqliteResourceLeaseRepository(db);
    return { db, repository, leases: new ResourceLeaseService(repository) };
  }

  const attempt = () => ({
    taskId: 'task_attempt',
    generationId: 'generation_task_attempt',
    subtaskId: 'subtask_attempt_task_attempt',
    workUnitId: 'work_unit_attempt_task_attempt',
    attemptId: 'attempt_1',
    leaseToken: 'attempt_lease',
  });
  const publication = () => ({
    taskId: 'task_publication',
    generationId: 'generation_task_publication',
    subtaskId: 'subtask_publication_task_publication',
    workUnitId: 'work_unit_publication_task_publication',
    attemptId: 'publication-delivery:p1',
    leaseToken: 'publication_lease',
  });

  it('conflicts when publication targets a path inside an in-place Workspace root', () => {
    const { leases, db } = services();
    const root = '/repos/app';
    const target = publicTaskRelativeDirectory('Deck', 'task_publication');

    const inPlace = leases.claim({ ...attempt(), claims: [workspaceRootClaim(root, 'write')] });
    expect(inPlace.type).toBe('claimed');

    const delivery = leases.claim({ ...publication(), claims: [workspacePathClaim(root, target, 'write')] });
    expect(delivery.type).toBe('conflict');
    if (delivery.type === 'conflict') {
      expect(delivery.waits).toHaveLength(1);
      expect(delivery.waits[0]!.taskId).toBe('task_publication');
    }
    db.close();
  });

  it('lets the publication proceed once the in-place Attempt releases its lease', () => {
    const { leases, db } = services();
    const root = '/repos/app';
    const target = publicTaskRelativeDirectory('Deck', 'task_publication');
    leases.claim({ ...attempt(), claims: [workspaceRootClaim(root, 'write')] });
    expect(leases.claim({ ...publication(), claims: [workspacePathClaim(root, target, 'write')] }).type)
      .toBe('conflict');

    leases.release(attempt().attemptId, attempt().leaseToken);

    // Releasing the holder resolves the durable wait, so the parked publication
    // is no longer treated as blocked by the scheduler.
    expect(leases.findWaiting(publication().taskId)).toEqual([]);
    expect(leases.claim({ ...publication(), claims: [workspacePathClaim(root, target, 'write')] }).type)
      .toBe('claimed');
    db.close();
  });

  it('also conflicts across two Workspace identities with nested paths', () => {
    const { leases, db } = services();
    const outer = leases.claim({
      ...attempt(),
      claims: [workspaceRootClaim('/repos/app', 'write')],
    });
    expect(outer.type).toBe('claimed');
    const nestedWorkspaceAttempt = leases.claim({
      ...publication(),
      claims: [workspaceRootClaim('/repos/app/sub', 'write')],
    });
    expect(nestedWorkspaceAttempt.type).toBe('conflict');
    db.close();
  });
});
