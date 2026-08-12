import { describe, expect, it } from 'vitest';
import type { KernelDecision, KernelEvent, KernelSnapshot } from '../../src/kernel/control-kernel.js';
import { ExecutorAttemptReceiptRepo } from '../../src/storage/executor-attempt-receipt-repo.js';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import {
  KernelBindingStatusRepo,
  KernelModelStatusRepo,
  KernelProviderStatusRepo,
} from '../../src/storage/kernel-binding-status-repos.js';
import { KernelDecisionRepo } from '../../src/storage/kernel-decision-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { KernelExecutorStatusRepo } from '../../src/storage/kernel-executor-status-repo.js';
import { PlannerRunRepo } from '../../src/storage/planner-run-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import {
  NOW,
  REVISION,
  createV31RepositoryDb,
} from './v31-repository-fixture.js';

const binding = {
  agentClassRef: 'codex-engineering',
  harnessRef: 'codex-cli',
  providerRef: 'openai',
  modelRef: 'engineering-model',
  permissionProfileRef: 'workspace-default',
  configurationRevision: REVISION,
};
const bindingFingerprint = 'sha256:binding';

describe('schema v31 revisioned repositories', () => {
  it('persists executorBindings without a legacy preference field', () => {
    const db = createV31RepositoryDb();
    seedGraphRevision(db);
    const repo = new SubtaskRepo(db);
    repo.upsert({
      id: 'subtask_1',
      taskId: 'task_1',
      graphRevision: 1,
      generationId: 'generation_1',
      title: 'Implement',
      goal: 'Implement storage',
      status: 'ready',
      dependencies: [],
      contextRefs: [],
      requiredCapabilities: ['workspace-engineering'],
      executorBindings: [binding],
      deliveryKind: 'edit',
      acceptance: [],
      riskLevel: 'medium',
      result: '',
      artifacts: [],
      verification: { warnings: [], completionSchemaVersion: null },
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(repo.findById('subtask_1')?.executorBindings).toEqual([binding]);
    expect(db.prepare('SELECT executor_bindings_json FROM subtasks').get())
      .toEqual({ executor_bindings_json: expect.stringContaining('engineering-model') });
    expect(() => repo.upsert({
      ...repo.findById('subtask_1')!,
      executorBindings: [{
        ...binding,
        configurationRevision: 'different_revision',
      }],
    })).toThrow('Subtask binding revision mismatch');
  });

  it('persists planner, graph and decision revision identities', () => {
    const db = createV31RepositoryDb();
    const planner = new PlannerRunRepo(db);
    const run = planner.start({
      sessionId: 'session_1',
      requestSource: 'interactive',
      configurationRevision: REVISION,
      plannerBinding: binding,
      plannerBindingFingerprint: bindingFingerprint,
    });
    expect(run).toMatchObject({
      configurationRevision: REVISION,
      plannerBinding: binding,
      plannerBindingFingerprint: bindingFingerprint,
    });

    const revisions = new WorkGraphRevisionRepo(db);
    expect(revisions.activate({
      id: 'graph_1',
      taskId: 'task_1',
      revision: 1,
      generationId: 'generation_1',
      configurationRevision: REVISION,
      authorizedDecisionId: null,
      proposalSource: 'initial',
      automaticReplan: false,
      createdAt: NOW,
      updatedAt: NOW,
    }).configurationRevision).toBe(REVISION);

    const record = kernelDecisionRecord();
    const decisions = new KernelDecisionRepo(db);
    expect(decisions.insertIfAbsent({
      ...record,
      configurationRevision: REVISION,
      authorizedBindings: [binding],
      bindingFingerprints: [bindingFingerprint],
    })).toBe(true);
    expect(decisions.findByEventId(record.eventId)).toMatchObject({
      configurationRevision: REVISION,
      authorizedBindings: [binding],
      bindingFingerprints: [bindingFingerprint],
    });
    expect(() => decisions.insertIfAbsent({
      ...record,
      id: 'decision_different',
      configurationRevision: 'different_revision',
      authorizedBindings: [{
        ...binding,
        configurationRevision: 'different_revision',
      }],
      bindingFingerprints: ['sha256:different'],
    })).toThrow('persisted Kernel decision binding mismatch');

    expect(() => revisions.activate({
      id: 'graph_different',
      taskId: 'task_1',
      revision: 1,
      generationId: 'generation_1',
      configurationRevision: 'different_revision',
      authorizedDecisionId: null,
      proposalSource: 'initial',
      automaticReplan: false,
      createdAt: NOW,
      updatedAt: NOW,
    })).toThrow('persisted Work Graph revision identity mismatch');
  });

  it('copies exact dispatch binding identity into an immutable receipt', () => {
    const db = createV31RepositoryDb();
    seedSubtask(db);
    const dispatch = new KernelDispatchItemRepo(db);
    dispatch.insertBatch(
      dispatchDecision(),
      {
        generationId: 'generation_1',
        configurationRevision: REVISION,
        attempts: {
          attempt_1: { authorizedBinding: binding, bindingFingerprint },
        },
      },
      NOW,
    );
    expect(dispatch.find('attempt_1')).toMatchObject({
      configurationRevision: REVISION,
      authorizedBinding: binding,
      bindingFingerprint,
    });

    db.prepare(`
      UPDATE kernel_dispatch_items
      SET status = 'running', work_unit_id = 'work_unit_1'
      WHERE attempt_id = 'attempt_1'
    `).run();
    const receipts = new ExecutorAttemptReceiptRepo(db);
    receipts.insert({
      attemptId: 'attempt_1',
      executionId: 'execution_1',
      taskId: 'task_1',
      subtaskId: 'subtask_1',
      workUnitId: 'work_unit_1',
      agentClassName: binding.agentClassRef,
      startedAt: NOW,
      completedAt: NOW,
      terminalState: 'completed',
      rawResponse: 'complete',
      completionSchemaVersion: 3,
      parsing: {},
      verification: { warnings: [], violations: [] },
      errorCode: null,
      errorDetail: null,
    });
    expect(receipts.findByAttemptId('attempt_1')).toMatchObject({
      configurationRevision: REVISION,
      authorizedBinding: binding,
      bindingFingerprint,
    });
    expect(() => dispatch.insertBatch(
      dispatchDecision(),
      {
        generationId: 'generation_1',
        configurationRevision: 'different_revision',
        attempts: {
          attempt_1: {
            authorizedBinding: {
              ...binding,
              configurationRevision: 'different_revision',
            },
            bindingFingerprint: 'sha256:different',
          },
        },
      },
      NOW,
    )).toThrow('persisted dispatch binding mismatch');
  });

  it('pins deferred replans and health projections to a revision', () => {
    const db = createV31RepositoryDb();
    const replans = new GenerationReplanRequestRepo(db);
    const request = replans.enqueue({
      id: 'replan_1',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceRevision: 1,
      configurationRevision: REVISION,
      triggerDecisionId: 'decision_1',
      now: NOW,
    });
    expect(request.configurationRevision).toBe(REVISION);
    expect(() => replans.enqueue({
      id: 'replan_duplicate',
      taskId: 'task_1',
      generationId: 'generation_1',
      sourceRevision: 1,
      configurationRevision: 'different_revision',
      triggerDecisionId: 'decision_2',
      now: NOW,
    })).toThrow('persisted replan revision mismatch');
    expect(replans.markPlanning(request.id, 'quiescence', NOW)).toBe(true);
    expect(replans.deferForAvailability(
      request.id,
      {
        schemaVersion: 5,
        type: 'plan_proposed',
        id: 'event_replan',
        correlationId: request.id,
        causationId: request.id,
        occurredAt: NOW,
        sessionId: 'session_1',
        taskId: 'task_1',
        plan: {} as never,
      },
      'wait for model',
      [binding],
      NOW,
    )).toBe(true);
    expect(replans.find(request.id)).toMatchObject({
      configurationRevision: REVISION,
      deferredBindings: [binding],
    });

    const executor = new KernelExecutorStatusRepo(db);
    executor.upsert({
      agentClassName: binding.agentClassRef,
      configurationRevision: REVISION,
      classHealth: 'healthy',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: NOW,
    });
    expect(executor.findByAgentClassName(binding.agentClassRef, REVISION))
      .toMatchObject({ configurationRevision: REVISION, classHealth: 'healthy' });

    const providers = new KernelProviderStatusRepo(db);
    providers.upsert({
      providerRef: binding.providerRef,
      configurationRevision: REVISION,
      health: 'error',
      recentRecoveryChecks: [],
      updatedAt: NOW,
    });
    expect(providers.find(binding.providerRef, REVISION))
      .toMatchObject({ health: 'error', configurationRevision: REVISION });

    const models = new KernelModelStatusRepo(db);
    models.upsert({
      providerRef: binding.providerRef,
      modelRef: binding.modelRef,
      configurationRevision: REVISION,
      health: 'healthy',
      recentRecoveryChecks: [],
      updatedAt: NOW,
    });
    expect(models.find(binding.providerRef, binding.modelRef, REVISION))
      .toMatchObject({ health: 'healthy', modelRef: binding.modelRef });

    const bindings = new KernelBindingStatusRepo(db);
    bindings.upsert({
      bindingFingerprint,
      binding,
      health: 'unverified',
      recentAttempts: [],
      recentRecoveryChecks: [],
      updatedAt: NOW,
    });
    expect(bindings.find(bindingFingerprint)).toMatchObject({
      binding,
      health: 'unverified',
    });
  });

  it('fails closed on corrupt revision-scoped health JSON', () => {
    const db = createV31RepositoryDb();
    db.prepare(`
      INSERT INTO kernel_executor_status (
        agent_class_name, configuration_revision, class_health,
        recent_attempts_json, recent_recovery_checks_json, updated_at
      ) VALUES (?, ?, 'healthy', '{broken', '[]', ?)
    `).run(binding.agentClassRef, REVISION, NOW);

    expect(() => new KernelExecutorStatusRepo(db).findByAgentClassName(
      binding.agentClassRef,
      REVISION,
    )).toThrow();
  });
});

function seedSubtask(db: ReturnType<typeof createV31RepositoryDb>): void {
  seedGraphRevision(db);
  db.prepare(`
    INSERT INTO subtasks (
      id, task_id, graph_revision, generation_id, title, goal, status,
      dependencies_json, context_refs_json, required_capabilities_json,
      executor_bindings_json, delivery_kind, acceptance_json, risk_level,
      result, artifacts_json, verification_json, created_at, updated_at
    ) VALUES (
      'subtask_1', 'task_1', 1, 'generation_1', 'Subtask', 'Goal', 'ready',
      '[]', '[]', '[]', '[]', 'edit', '[]', 'medium', '', '[]', '{}', ?, ?
    )
  `).run(NOW, NOW);
}

function seedGraphRevision(db: ReturnType<typeof createV31RepositoryDb>): void {
  db.prepare(`
    INSERT OR IGNORE INTO work_graph_revisions (
      id, task_id, revision, generation_id, authorized_decision_id,
      proposal_source, automatic_replan, status, configuration_revision,
      created_at, updated_at
    ) VALUES (
      'graph_1', 'task_1', 1, 'generation_1', NULL,
      'initial', 0, 'active', ?, ?, ?
    )
  `).run(REVISION, NOW, NOW);
}

function kernelDecisionRecord() {
  const event: KernelEvent = {
    schemaVersion: 5,
    type: 'timer_tick',
    id: 'event_1',
    correlationId: 'correlation_1',
    causationId: null,
    occurredAt: NOW,
    sessionId: 'session_1',
    taskId: 'task_1',
    subtaskId: null,
    wakeKind: 'capacity',
    sourceDecisionId: 'decision_source',
    scheduledFor: NOW,
    retry: null,
  };
  const snapshot: KernelSnapshot = {
    schemaVersion: 5,
    type: 'timer',
    capacityBlockedAt: null,
    recheckAfterMs: 1000,
    task: { id: 'task_1', status: 'running' },
    wakeAuthorized: true,
    nativeContinuationAgentClasses: [],
    capacityAgentClasses: [],
    executorStatuses: [],
    defaultResourceGrant: [],
  };
  const decision: KernelDecision = {
    schemaVersion: 5,
    id: 'decision_1',
    eventId: event.id,
    action: { type: 'no_op' },
    reason: 'nothing due',
  };
  return {
    id: decision.id,
    schemaVersion: 5 as const,
    eventId: event.id,
    eventType: event.type,
    correlationId: event.correlationId,
    causationId: event.causationId,
    sessionId: event.sessionId,
    taskId: event.taskId,
    subtaskId: null,
    attemptId: null,
    event,
    snapshot,
    decision,
    action: decision.action.type,
    reason: decision.reason,
    createdAt: NOW,
  };
}

function dispatchDecision(): KernelDecision & {
  action: Extract<KernelDecision['action'], { type: 'dispatch_batch' }>;
} {
  return {
    schemaVersion: 5,
    id: 'decision_1',
    eventId: 'event_1',
    reason: 'dispatch',
    action: {
      type: 'dispatch_batch',
      taskId: 'task_1',
      items: [{
        order: 0,
        attemptId: 'attempt_1',
        subtaskId: 'subtask_1',
        agentClassName: binding.agentClassRef,
        attemptKind: 'primary',
        sourceAttemptId: null,
        recoveryMode: 'fresh',
        attemptPayload: null,
        defaultResourceGrant: [],
      }],
    },
  };
}
