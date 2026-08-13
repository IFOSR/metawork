import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { GuidancePolicyEngine } from '../../src/guidance/guidance-policy-engine.js';
import { OrchestrationEngine } from '../../src/guidance/orchestration.js';

describe('GuidancePolicyEngine', () => {
  it('proposes resume_task for a high-value parked task with ready materials', () => {
    const engine = new GuidancePolicyEngine();

    const proposals = engine.build([
      {
        taskId: 'task_1',
        status: 'parked',
        isReady: true,
        progressRatio: 0.7,
        idleHours: 3,
        blocksOthers: false,
        hasNewMaterials: false,
        resumability: 'high',
        lastInterruptionReason: '被更高优先级任务抢占：紧急任务',
      },
    ]);

    expect(proposals[0]?.actionType).toBe('resume_task');
    expect(proposals[0]?.requiresConfirmation).toBe(false);
  });

  it('proposes unblock_and_resume when a blocked task has new materials', () => {
    const engine = new GuidancePolicyEngine();

    const proposals = engine.build([
      {
        taskId: 'task_2',
        status: 'blocked',
        isReady: false,
        progressRatio: 0.2,
        idleHours: 8,
        blocksOthers: false,
        hasNewMaterials: true,
        resumability: 'medium',
        lastInterruptionReason: '',
      },
    ]);

    expect(proposals[0]?.actionType).toBe('unblock_and_resume');
    expect(proposals[0]?.recommendedAction).toContain('task_2');
  });
});

describe('OrchestrationEngine proposals', () => {
  let orchestration: OrchestrationEngine;
  let taskEngine: TaskEngine;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const repo = new TaskRepo(db);
    taskEngine = new TaskEngine(repo, resolve(tmpdir(), 'metaclaw-test-snapshots'));
    orchestration = new OrchestrationEngine(taskEngine);
  });

  it('renders no prioritize_task proposal for ready tasks', () => {
    const task = taskEngine.create({ title: '任务A', goal: '目标A' });
    taskEngine['taskRepo'].update(task.id, {
      prioritySignals: {
        dueAt: null,
        isReady: true,
        progressRatio: 0.8,
        blocksOthers: true,
        idleHours: 2,
      },
    });
    taskEngine.transition(task.id, 'ready');

    const proposals = orchestration.generateProposals('idle');

    expect(proposals.some(proposal => proposal.actionType === 'prioritize_task')).toBe(false);
  });
});
