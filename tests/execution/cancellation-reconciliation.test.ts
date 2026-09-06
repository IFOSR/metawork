import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/storage/migrations.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskEngine } from '../../src/task/task-engine.js';
import { TaskRuntimeService } from '../../src/task/task-runtime-service.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { TaskEventRepo } from '../../src/storage/task-event-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { GenerationReplanRequestRepo } from '../../src/storage/generation-replan-request-repo.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { SqliteAttemptExecutionRepository } from '../../src/storage/attempt-execution-backend-repo.js';
import { TaskCancellationCoordinator } from '../../src/execution/task-cancellation-coordinator.js';
import { reconcileUncertainCancellations } from '../../src/execution/cancellation-reconciliation.js';
import type { KernelDecision, KernelEvent } from '../../src/kernel/control-kernel.js';
import type { AttemptExecutionBackend } from '../../src/execution/attempt-execution-backend.js';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';

const now = '2026-09-06T07:00:00.000Z';
const binding: AuthorizedExecutorBinding = {
  agentClassRef: 'codex-cli',
  harnessRef: 'codex-cli',
  providerRef: 'openai',
  modelRef: 'gpt-5-codex',
  permissionProfileRef: 'workspace-engineering',
  configurationRevision: 'revision-reconcile-1',
};

interface Harness {
  db: Database.Database;
  store: KernelWorkflowRepo;
  coordinator: TaskCancellationCoordinator;
  taskRuntime: TaskRuntimeService;
  taskRepo: TaskRepo;
  scheduler: ConversationTaskSchedulerRepo;
}

function seedUncertainCancellation(
  harness: Harness,
  options: { taskId: string; generationId: string; conversationId: string },
): string {
  const event: KernelEvent = {
    schemaVersion: 5,
    configurationRevision: binding.configurationRevision,
    type: 'task_cancel_requested',
    id: `event-cancel-${options.taskId}`,
    correlationId: options.taskId,
    causationId: null,
    occurredAt: now,
    sessionId: 'session-reconcile',
    taskId: options.taskId,
    reason: 'durable Task cancellation fence authorized',
  } as KernelEvent;
  const decision: KernelDecision = {
    schemaVersion: 5,
    id: `decision-cancel-${options.taskId}`,
    eventId: event.id,
    reason: event.reason,
    configurationRevision: binding.configurationRevision,
    action: {
      type: 'cancel_task',
      taskId: options.taskId,
      generationId: options.generationId,
    },
  } as KernelDecision;
  harness.store.enqueue(event);
  harness.store.claimNext(event.occurredAt);
  const application = harness.store.issue(event.id, {
    id: decision.id,
    schemaVersion: 5,
    eventId: event.id,
    eventType: event.type,
    correlationId: event.correlationId,
    causationId: null,
    sessionId: event.sessionId,
    taskId: options.taskId,
    subtaskId: null,
    attemptId: null,
    event,
    snapshot: { schemaVersion: 5, type: 'task_control' },
    decision,
    action: decision.action.type,
    reason: decision.reason,
    configurationRevision: binding.configurationRevision,
    authorizedBindings: [],
    bindingFingerprints: [],
    createdAt: event.occurredAt,
  });
  harness.store.markApplying(application.decisionId, now);
  harness.store.markApplicationFailed(
    application.decisionId,
    'uncertain',
    'UNIQUE constraint failed: kernel_dispatch_items.task_id, kernel_dispatch_items.generation_id, kernel_dispatch_items.subtask_id',
    now,
  );
  return application.decisionId;
}

function setup(options: {
  taskId: string;
  taskStatus: 'blocked' | 'cancelled';
  generationId: string;
  conversationId: string;
}): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare(`
    INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES (?, 'sha256:test', 'native', ?)
  `).run(binding.configurationRevision, now);
  const taskRepo = new TaskRepo(db);
  const taskEngine = new TaskEngine(taskRepo, '/tmp/metaclaw-reconcile');
  taskEngine.create({
    id: options.taskId,
    title: 'Reconcile',
    goal: 'Reconcile cancellation',
    conversationId: options.conversationId,
  });
  taskEngine.transition(options.taskId, 'ready');
  taskEngine.transition(options.taskId, 'running');
  if (options.taskStatus === 'blocked') {
    taskEngine.block(options.taskId, {
      taskId: options.taskId,
      type: 'manual',
      description: 'uncertain cancellation residue',
      status: 'waiting',
    });
  } else {
    taskEngine.cancel(options.taskId);
  }
  const revisions = new WorkGraphRevisionRepo(db);
  revisions.activate({
    id: `revision-${options.taskId}`,
    taskId: options.taskId,
    revision: 1,
    generationId: options.generationId,
    configurationRevision: binding.configurationRevision,
    authorizedDecisionId: null,
    proposalSource: 'initial',
    automaticReplan: false,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  const subtasks = new SubtaskRepo(db);
  subtasks.upsert({
    id: `${options.taskId}-subtask`,
    taskId: options.taskId,
    graphRevision: 1,
    generationId: options.generationId,
    title: 'only',
    goal: 'only',
    status: 'ready',
    dependencies: [],
    contextRefs: [],
    requiredCapabilities: ['workspace-engineering'],
    executorBindings: [binding],
    deliveryKind: 'report',
    acceptance: [],
    riskLevel: 'low',
    result: '',
    artifacts: [],
    verification: { warnings: [], completionSchemaVersion: null },
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  const scheduler = new ConversationTaskSchedulerRepo(db);
  if (options.taskStatus === 'blocked') {
    scheduler.claimSlot(options.conversationId, options.taskId, 'decision-admission', now);
    scheduler.markRunning(options.taskId, now);
  }
  const coordinator = new TaskCancellationCoordinator({
    db,
    taskRuntimeService: new TaskRuntimeService({ taskEngine, taskRepo }),
    subtaskRepo: subtasks,
    taskEventRepo: new TaskEventRepo(db),
    workGraphRevisionRepo: revisions,
    dispatchItemRepo: new KernelDispatchItemRepo(db),
    schedulerRepo: scheduler,
    publicationRepo: new WorkspacePublicationRepo(db),
    generationReplanRepo: new GenerationReplanRequestRepo(db),
    resourceLeaseService: new ResourceLeaseService(new SqliteResourceLeaseRepository(db)),
    workUnitClaimService: new WorkUnitClaimService(new WorkUnitRepo(db)),
    activeExecutions: { abortAttempt: vi.fn(), abortTask: vi.fn() },
    attemptExecutionBackend: {} as AttemptExecutionBackend,
    attemptExecutionRepository: new SqliteAttemptExecutionRepository(db),
  });
  return {
    db,
    store: new KernelWorkflowRepo(db),
    coordinator,
    taskRuntime: new TaskRuntimeService({ taskEngine, taskRepo }),
    taskRepo,
    scheduler,
  };
}

describe('reconcileUncertainCancellations (2026-09-06 plan §5.3.5)', () => {
  it('marks an uncertain cancellation applied when every durable postcondition exists', () => {
    const harness = setup({
      taskId: 'task-applied',
      taskStatus: 'cancelled',
      generationId: 'generation-applied',
      conversationId: 'conv-applied',
    });
    const decisionId = seedUncertainCancellation(harness, {
      taskId: 'task-applied',
      generationId: 'generation-applied',
      conversationId: 'conv-applied',
    });
    const onResolved = vi.fn();

    const entries = reconcileUncertainCancellations({
      store: harness.store,
      coordinator: harness.coordinator,
      taskRuntimeService: harness.taskRuntime,
      onResolved,
      now: () => now,
    });

    expect(entries).toEqual([{
      taskId: 'task-applied',
      decisionId,
      outcome: 'already_applied',
      diagnostics: [],
    }]);
    expect(onResolved).toHaveBeenCalledWith('task-applied');
    expect(harness.db.prepare(
      'SELECT status FROM kernel_decision_applications WHERE decision_id = ?',
    ).get(decisionId)).toEqual({ status: 'applied' });
  });

  it('replays the same cancellation identity to release a blocked task and its slot', async () => {
    // Exact §2.1 production state: the cancel transaction rolled back, so the
    // Task stayed blocked with its Conversation slot occupied and the schedule
    // entry running, while the application sat uncertain forever.
    const harness = setup({
      taskId: 'task-stuck',
      taskStatus: 'blocked',
      generationId: 'generation-stuck',
      conversationId: 'conv-stuck',
    });
    const decisionId = seedUncertainCancellation(harness, {
      taskId: 'task-stuck',
      generationId: 'generation-stuck',
      conversationId: 'conv-stuck',
    });

    const entries = reconcileUncertainCancellations({
      store: harness.store,
      coordinator: harness.coordinator,
      taskRuntimeService: harness.taskRuntime,
      now: () => now,
    });

    expect(entries).toEqual([{
      taskId: 'task-stuck',
      decisionId,
      outcome: 'replayed',
      diagnostics: [],
    }]);
    expect(harness.taskRepo.findById('task-stuck')?.status).toBe('cancelled');
    // §4.1: the slot releases only after the drain confirms convergence.
    await harness.coordinator.recover('task-stuck');
    expect(harness.scheduler.getSlot('conv-stuck').state).toBe('free');
    expect(harness.db.prepare(
      'SELECT status FROM kernel_decision_applications WHERE decision_id = ?',
    ).get(decisionId)).toEqual({ status: 'applied' });
  });

  it('keeps admission closed with a named phase when state is contradictory', () => {
    const harness = setup({
      taskId: 'task-contradiction',
      taskStatus: 'blocked',
      generationId: 'generation-old',
      conversationId: 'conv-contradiction',
    });
    const decisionId = seedUncertainCancellation(harness, {
      taskId: 'task-contradiction',
      generationId: 'generation-new',
      conversationId: 'conv-contradiction',
    });

    const entries = reconcileUncertainCancellations({
      store: harness.store,
      coordinator: harness.coordinator,
      taskRuntimeService: harness.taskRuntime,
      now: () => now,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.outcome).toBe('unresolved');
    expect(entries[0]!.diagnostics[0]).toContain('generation changed before application');
    expect(harness.db.prepare(
      'SELECT status FROM kernel_decision_applications WHERE decision_id = ?',
    ).get(decisionId)).toEqual({ status: 'uncertain' });
  });
});
