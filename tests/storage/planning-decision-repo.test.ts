import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/storage/migrations.js';
import { PlanningDecisionRepo } from '../../src/storage/planning-decision-repo.js';
import { PolicyKernel } from '../../src/kernel/policy-kernel.js';
import type { PlanningAgentPlan } from '../../src/planning/planning-types.js';

function createDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function directReplyPlan(): PlanningAgentPlan {
  return {
    id: 'plan_direct',
    schemaVersion: 2,
    action: 'direct_reply',
    confidence: 0.95,
    reason: 'chat',
    clarificationQuestion: null,
    response: { directReply: '你好，我在。' },
    task: {
      binding: 'none',
      taskId: null,
      control: 'none',
      scope: null,
      title: null,
      goal: null,
      includeRecentConversationContext: false,
      priority: null,
    },
    execution: {
      mode: 'none',
      complexity: 'simple',
      selectedExecutor: null,
      candidateExecutors: [],
      requiresVerification: false,
      canModifyFiles: false,
      requiresExternalGateway: false,
      capabilityClass: 'conversation',
      matchedBoundary: [],
    },
    risk: { level: 'low', requiresConfirmation: false, reasons: [] },
    workGraph: null,
    source: 'test',
  };
}

describe('PlanningDecisionRepo', () => {
  it('stores direct reply audit records without a task', () => {
    const repo = new PlanningDecisionRepo(createDb());
    const plan = directReplyPlan();
    const decision = new PolicyKernel().decide(plan, {
      tasks: [],
      runningTask: null,
      agentClasses: [],
      currentFocus: null,
    });

    repo.insert({
      id: decision.id,
      sessionId: 'session_1',
      requestId: plan.id,
      taskId: null,
      userInput: 'hello',
      plan,
      decision,
      outcome: decision.outcome,
      reason: decision.reason,
      createdAt: '2026-07-03T00:00:00.000Z',
    });

    expect(repo.listBySession('session_1')).toEqual([
      expect.objectContaining({
        id: decision.id,
        taskId: null,
        outcome: 'accept',
        reason: 'direct reply authorized',
      }),
    ]);
  });

  it('binds a newly created task and lists decisions by task', () => {
    const repo = new PlanningDecisionRepo(createDb());
    const plan = directReplyPlan();
    const decision = new PolicyKernel().decide(plan, {
      tasks: [], runningTask: null, agentClasses: [], currentFocus: null,
    });
    repo.insert({
      id: decision.id, sessionId: 'session_2', requestId: plan.id, taskId: null,
      userInput: 'create work', plan, decision, outcome: decision.outcome,
      reason: decision.reason, createdAt: '2026-07-14T00:00:00.000Z',
    });

    repo.bindTask(decision.id, 'task-created-later');

    expect(repo.listByTask('task-created-later')).toEqual([
      expect.objectContaining({ id: decision.id, taskId: 'task-created-later' }),
    ]);
  });
});
