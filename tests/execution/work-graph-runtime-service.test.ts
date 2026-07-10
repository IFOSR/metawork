import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { WorkGraphRuntimeService } from '../../src/execution/work-graph-runtime-service.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';
import type { Task } from '../../src/core/types.js';

const now = '2026-07-03T00:00:00.000Z';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function task(id = 'task_1'): Task {
  return {
    id,
    title: 'Task',
    goal: 'Do work',
    status: 'running',
    summary: '',
    snapshots: [],
    resources: [],
    artifacts: [],
    dependencies: [],
    prioritySignals: { dueAt: null, isReady: true, progressRatio: 0, blocksOthers: false, idleHours: 0 },
    injectedPreferences: [],
    lastSchedulingReason: '',
    lastInterruptionReason: '',
    interruptionCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function plan(taskId: string): PlanningAgentPlan {
  return {
    id: 'plan_1',
    schemaVersion: 2,
    action: 'plan_work_graph',
    confidence: 0.9,
    reason: 'execute',
    clarificationQuestion: null,
    response: { directReply: null },
    task: {
      binding: 'reference',
      taskId,
      control: 'none',
      scope: null,
      title: 'Task',
      goal: 'Do work',
      includeRecentConversationContext: false,
      priority: { level: 'normal', reason: 'test priority' },
    },
    execution: {
      mode: 'single_executor',
      complexity: 'simple',
      selectedExecutor: 'codex-cli',
      candidateExecutors: ['codex-cli'],
      requiresVerification: false,
      canModifyFiles: false,
      requiresExternalGateway: false,
      capabilityClass: 'general',
      matchedBoundary: [],
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: {
      reason: 'approved plan',
      subtasks: [{
        id: 'execute',
        title: 'Execute',
        goal: 'Do work',
        dependsOn: [],
        requiredAgentClassKind: 'executor',
        agentClassHint: 'codex-cli',
        candidateAgentClasses: ['codex-cli'],
        expectedOutput: 'summary',
        acceptance: ['done'],
        riskLevel: 'low',
      }],
    },
    source: 'test',
  };
}

describe('WorkGraphRuntimeService', () => {
  it('persists the kernel-approved proposal content, not a generic fallback', () => {
    const db = createDb();
    const taskRecord = task();
    new TaskRepo(db).insert(taskRecord);
    const subtaskRepo = new SubtaskRepo(db);
    const service = new WorkGraphRuntimeService(subtaskRepo, new TaskEventRepo(db));

    // Distinctive approved content: a patch subtask routed to a specific
    // executor with concrete acceptance — none of which the fallback produces.
    const approved = plan(taskRecord.id);
    approved.workGraph!.subtasks[0] = {
      ...approved.workGraph!.subtasks[0]!,
      expectedOutput: 'patch',
      acceptance: ['run the unit tests'],
      candidateAgentClasses: ['codex-cli'],
    };

    const result = service.apply({ task: taskRecord, userPrompt: 'Do work', approvedPlan: approved });

    expect(result.workGraph.reason).toBe('approved plan');
    expect(result.subtasks).toHaveLength(1);
    // The persisted subtask carries the approved plan's content verbatim; if the
    // service ignored approvedPlan and fell back, expectedOutput/acceptance/
    // candidates would be the generic fallback values instead.
    expect(result.subtasks[0]).toMatchObject({
      id: `${taskRecord.id}_execute`,
      status: 'ready',
      expectedOutput: 'patch',
      acceptance: ['run the unit tests'],
      candidateAgentClasses: ['codex-cli'],
    });
    expect(subtaskRepo.listByTask(taskRecord.id)).toHaveLength(1);
  });

  it('falls back to a generic single subtask only when no plan is approved', () => {
    const db = createDb();
    const taskRecord = task('task_fallback');
    new TaskRepo(db).insert(taskRecord);
    const subtaskRepo = new SubtaskRepo(db);
    const service = new WorkGraphRuntimeService(subtaskRepo, new TaskEventRepo(db));

    const result = service.apply({ task: taskRecord, userPrompt: 'just do it', approvedPlan: null });

    // No approved plan -> exactly one runtime fallback subtask, clearly distinct
    // from an approved proposal (generic summary output, goal = raw prompt).
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0]).toMatchObject({
      status: 'ready',
      expectedOutput: 'summary',
      goal: 'just do it',
    });
    expect(result.workGraph.reason).toContain('fallback');
  });

  it('recovers existing non-done subtasks to ready without replacing done subtasks', () => {
    const db = createDb();
    const taskRecord = task('task_recover');
    new TaskRepo(db).insert(taskRecord);
    const subtaskRepo = new SubtaskRepo(db);
    subtaskRepo.upsert({
      id: `${taskRecord.id}_running`,
      taskId: taskRecord.id,
      title: 'Running',
      goal: 'Do work',
      status: 'running',
      dependsOn: [],
      requiredAgentClassKind: 'executor',
      agentClassHint: 'codex-cli',
      candidateAgentClasses: ['codex-cli'],
      expectedOutput: 'summary',
      acceptance: [],
      riskLevel: 'medium',
      result: '',
      error: 'previous timeout',
      createdAt: now,
      updatedAt: now,
    });
    const service = new WorkGraphRuntimeService(subtaskRepo, new TaskEventRepo(db));

    const result = service.apply({ task: taskRecord, userPrompt: 'resume', approvedPlan: plan(taskRecord.id) });

    expect(result.recovered).toBe(true);
    expect(subtaskRepo.findById(`${taskRecord.id}_running`)).toMatchObject({
      status: 'ready',
      error: 'previous timeout',
    });
  });
});
