import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';
import { tmpdir } from 'os';
import { resolve } from 'path';

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('OrchestrationEngine', () => {
  let orchestration: OrchestrationEngine;
  let taskEngine: TaskEngine;

  beforeEach(() => {
    const db = createTestDb();
    const repo = new TaskRepo(db);
    taskEngine = new TaskEngine(repo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    orchestration = new OrchestrationEngine(taskEngine);
  });

  it('should generate empty dashboard', () => {
    const dashboard = orchestration.getDashboard();
    expect(dashboard.summary.active).toBe(0);
    expect(dashboard.summary.blocked).toBe(0);
    expect(dashboard.priorityTask).toBeNull();
  });

  it('should show active tasks in dashboard', () => {
    taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine.create({ title: '任务B', goal: '目标B' });

    const dashboard = orchestration.getDashboard();
    expect(dashboard.summary.active).toBe(2);
  });

  it('should show blocked tasks with reasons', () => {
    const t = taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine.transition(t.id, 'ready');
    taskEngine.transition(t.id, 'running');
    taskEngine.block(t.id, {
      taskId: t.id,
      type: 'manual',
      description: '等待客户资料',
      status: 'waiting',
    });

    const blocked = orchestration.getBlockedTasks();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].blockReason).toBe('等待客户资料');
  });

  it('does not expose next-task selection or prioritization', () => {
    const engine = orchestration as unknown as Record<string, unknown>;
    expect('getPrioritizedTasks' in engine).toBe(false);
    expect('suggestNext' in engine).toBe(false);
    expect('suggestNextProposal' in engine).toBe(false);
  });

  it('renders no prioritize_task proposal for ready tasks', () => {
    const ready = taskEngine.create({ title: '就绪任务', goal: '目标' });
    taskEngine.transition(ready.id, 'ready');

    const proposals = orchestration.generateProposals();
    expect(proposals.some(proposal => proposal.actionType === 'prioritize_task')).toBe(false);
  });
});
