import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskStateChangeRepo } from '../../src/storage/task-state-change-repo.js';
import { tmpdir } from 'os';
import { resolve } from 'path';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('TaskEngine', () => {
  let engine: TaskEngine;
  let repo: TaskRepo;
  let stateChanges: TaskStateChangeRepo;

  beforeEach(() => {
    const db = createTestDb();
    repo = new TaskRepo(db);
    stateChanges = new TaskStateChangeRepo(db);
    engine = new TaskEngine({
      taskRepo: repo,
      snapshotDir: resolve(tmpdir(), 'metaclaw-test-snapshots'),
      stateChanges,
    });
  });

  it('creates a Task already in the single queued state', () => {
    const task = engine.create({ title: '测试任务', goal: '验证创建功能' });
    expect(task.id).toMatch(/^task_/);
    expect(task.title).toBe('测试任务');
    expect(task.status).toBe('queued');
    expect(task.stateVersion).toBe(1);
    expect(task.completedAt).toBeNull();
    expect(task.archivedAt).toBeNull();
    expect(task.retryOfTaskId).toBeNull();
  });

  it.each(['', '   '])('replaces a blank explicit task id with a generated id', id => {
    const task = engine.create({ id, title: '测试任务', goal: '拒绝空主键' });

    expect(task.id).toMatch(/^task_/);
    expect(repo.findById(id)).toBeNull();
  });

  it('records the creation baseline in the durable state ledger', () => {
    const task = engine.create({ title: '测试', goal: '基线' });
    const history = stateChanges.listForTask(task.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe(1);
    expect(history[0]!.operationKey).toBe(`create:${task.id}`);
    expect(history[0]!.toStatus).toBe('queued');
  });

  it('has no status transition API: lifecycle writes belong to the state port', () => {
    expect('transition' in engine).toBe(false);
    expect('cancel' in engine).toBe(false);
    expect('park' in engine).toBe(false);
    expect('block' in engine).toBe(false);
    expect('unblock' in engine).toBe(false);
    expect('resume' in engine).toBe(false);
  });

  it('attaches resources without changing the conclusion', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    const updated = engine.attachResource(task.id, '/path/to/file.pdf');
    expect(updated.resources).toContain('/path/to/file.pdf');
    expect(updated.status).toBe('queued');
    expect(updated.stateVersion).toBe(1);
  });

  it('persists scheduler metadata on tasks', () => {
    const task = engine.create({ title: '测试', goal: '测试' });

    repo.update(task.id, {
      lastSchedulingReason: '截止时间临近',
      lastInterruptionReason: '被更高优先级任务抢占',
      interruptionCount: 2,
    });

    const updated = repo.findById(task.id);
    expect(updated?.lastSchedulingReason).toBe('截止时间临近');
    expect(updated?.lastInterruptionReason).toBe('被更高优先级任务抢占');
    expect(updated?.interruptionCount).toBe(2);
    // Metadata cannot change the Task version.
    expect(updated?.stateVersion).toBe(1);
  });

  it('rejects a lifecycle field in the generic metadata update at the type level', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    // @ts-expect-error `status` is a protected lifecycle field.
    expect(() => repo.update(task.id, { status: 'running' })).not.toThrow();
    // The runtime guard is the type; a cast would be required to bypass it.
    expect(repo.findById(task.id)!.status).toBe('queued');
  });

  it('archives by attribute without changing the conclusion or version', () => {
    const task = engine.create({ title: '测试', goal: '测试' });
    repo.setArchivedAt(task.id, '2026-10-22T00:00:00.000Z');
    const archived = repo.findById(task.id)!;
    expect(archived.archivedAt).toBe('2026-10-22T00:00:00.000Z');
    expect(archived.status).toBe('queued');
    expect(archived.stateVersion).toBe(1);
  });
});
