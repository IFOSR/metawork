import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlKernel } from '../../src/kernel/control-kernel.js';
import {
  KernelApplicationRejectionError,
  KernelApplicationSettledError,
} from '../../src/kernel/kernel-workflow.js';
import { parseApplicationSettlement } from '../../src/kernel/kernel-application-settlement.js';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';
import { TaskResidueReader } from '../../src/execution/task-residue-reader.js';
import { KernelDispatchItemRepo } from '../../src/storage/kernel-dispatch-item-repo.js';
import { WorkspacePublicationRepo } from '../../src/storage/workspace-publication-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';

const NOW = '2026-10-22T00:00:00.000Z';
const TASK_ID = 'task_service_1';
const PUBLISHED_SPEC = {
  serviceId: 'systemone-decision',
  taskId: TASK_ID,
  command: 'node',
  args: ['server.js'],
  host: '127.0.0.1' as const,
  port: 8789,
  healthPath: '/health',
  startupTimeoutMs: 1_000,
  restartPolicy: 'explicit' as const,
  environmentReferences: {},
};

let db: Database.Database | null = null;

afterEach(() => { db?.close(); db = null; });

function compose(input: {
  taskStatus: string;
  published: boolean;
  readSpecification?: () => Promise<typeof PUBLISHED_SPEC>;
  applyAuthorizedOperation?: (input: { decisionId: string; operation: string; serviceId: string })
    => Promise<{ decisionId: string; serviceId: string; operation: 'start'; phase: 'completed';
      initialToken: null; result: null; error: string | null }>;
}) {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(`INSERT INTO configuration_revisions (revision_id, content_hash, source_kind, imported_at)
    VALUES ('revision_1', 'test-content', 'native', ?)`).run(NOW);
  const store = new KernelWorkflowRepo(db);
  const getConfigurationRevision = () => 'revision_1';
  const runtime = new KernelExecutionRuntime({
    sessionId: 'session_1',
    callbacks: { appendOutput: vi.fn(), refreshRuntimeState: vi.fn() },
    taskRuntimeService: {
      findTask: (taskId: string) => taskId === TASK_ID
        ? { id: TASK_ID, status: input.taskStatus, conversationId: 'conv_1' }
        : null,
    },
    controlKernel: new ControlKernel(),
    kernelWorkflowStore: store,
    workGraphRevisionRepo: { findActive: () => null },
    getConfigurationRevision,
    maxConcurrentAttempts: 4,
    managedLocalServices: {
      readSpecification: input.readSpecification ?? (async () => PUBLISHED_SPEC),
      isPublished: async () => input.published,
      resolveServiceWorkspaceId: async () => 'workspace_service',
      find: () => null,
      forTask: () => [],
      applyAuthorizedOperation: input.applyAuthorizedOperation ?? (async () => {
        throw new Error('unexpected service operation');
      }),
    },
  } as never);
  return { runtime, store };
}

describe('managed service rejection convergence', () => {
  it('turns an unpublished pre-flight refusal into an effect-free rejection', async () => {
    const { runtime } = compose({
      taskStatus: 'cancelled',
      published: false,
      readSpecification: async () => { throw new Error('代码尚未发布到用户任务目录'); },
    });
    const error = await runtime.manageLocalService(TASK_ID, 'start').catch(value => value);
    expect(error).toBeInstanceOf(KernelApplicationRejectionError);
    expect(error).toMatchObject({ code: 'service_not_startable' });
    expect(error.message).toContain('代码尚未发布到用户任务目录');
  });

  it('turns a Kernel reject_request into a rejection instead of an uncertain application', async () => {
    const { runtime } = compose({ taskStatus: 'cancelled', published: false });
    const error = await runtime.manageLocalService(TASK_ID, 'start').catch(value => value);
    expect(error).toBeInstanceOf(KernelApplicationRejectionError);
    expect(error).toMatchObject({ code: 'service_request_rejected' });
    // P0-5: the refusal names the service, the task and the real cause.
    expect(error.message).toContain('serviceId=systemone-decision');
    expect(error.message).toContain(`taskId=${TASK_ID}`);
    expect(error.message).toContain('任务状态=cancelled');
  });

  it('turns a journaled operation error into a settled outcome', async () => {
    const { runtime } = compose({
      taskStatus: 'done',
      published: true,
      applyAuthorizedOperation: async input => ({
        decisionId: input.decisionId,
        serviceId: input.serviceId,
        operation: 'start',
        phase: 'completed',
        initialToken: null,
        result: null,
        error: '监听端口已被占用，请停止原服务或更换端口',
      }),
    });
    const error = await runtime.manageLocalService(TASK_ID, 'start').catch(value => value);
    expect(error).toBeInstanceOf(KernelApplicationSettledError);
    expect(error).toMatchObject({ code: 'service_operation_failed' });
    expect(error.message).toContain('监听端口已被占用');
  });

  it('records the inner service application as settled, never as uncertain', async () => {
    const { runtime, store } = compose({ taskStatus: 'cancelled', published: false });
    await runtime.manageLocalService(TASK_ID, 'start').catch(() => undefined);
    const counts = store.countByApplicationStatus();
    expect(counts.uncertain).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.pending).toBe(0);
    expect(counts.applied).toBe(1);
  });

  it('leaves no residue behind, so the Conversation slot can be released', async () => {
    const { runtime } = compose({ taskStatus: 'cancelled', published: false });
    await runtime.manageLocalService(TASK_ID, 'start').catch(() => undefined);
    const residue = new TaskResidueReader({
      db: db!,
      dispatchItemRepo: new KernelDispatchItemRepo(db!),
      publicationRepo: new WorkspacePublicationRepo(db!),
      workUnitClaimService: new WorkUnitClaimService(new WorkUnitRepo(db!)),
    });
    expect(residue.blockingReasons(TASK_ID, null)).toEqual([]);
  });

  it('converges a parent authorize_task_control application that the Runtime refused', async () => {
    const { store } = compose({ taskStatus: 'cancelled', published: false });
    const decisionId = 'decision_task_control_1';
    const eventId = 'event_task_control_1';
    const event = {
      schemaVersion: 5 as const, configurationRevision: 'revision_1', type: 'managed_service_requested' as const,
      id: eventId, correlationId: TASK_ID, causationId: null, occurredAt: NOW, sessionId: 'session_1',
      taskId: TASK_ID, operation: 'start' as const, serviceId: PUBLISHED_SPEC.serviceId, specification: undefined,
    };
    store.enqueue(event);
    store.claimNext(NOW);
    store.issue(eventId, {
      id: decisionId, schemaVersion: 5, eventId, eventType: event.type, correlationId: TASK_ID,
      causationId: null, sessionId: 'session_1', taskId: TASK_ID, subtaskId: null, attemptId: null,
      event, snapshot: { schemaVersion: 5, type: 'service_control', task: { id: TASK_ID, status: 'cancelled' },
        published: false, serviceTaskId: null },
      decision: { schemaVersion: 5, configurationRevision: 'revision_1', id: decisionId, eventId,
        action: { type: 'authorize_task_control', task: { binding: 'reference', taskId: TASK_ID,
          control: 'service_start', scope: PUBLISHED_SPEC.serviceId, title: null, goal: null,
          includeRecentConversationContext: false, priority: null } },
        reason: 'fixture' },
      action: 'authorize_task_control', reason: 'fixture', configurationRevision: 'revision_1',
      authorizedBindings: [], bindingFingerprints: [], createdAt: NOW,
    });
    store.markApplying(decisionId, NOW);
    store.markApplicationSettled?.(decisionId,
      'kernel_settlement/rejected_without_effect:service_request_rejected 服务归属不匹配：serviceId=systemone-decision',
      NOW);
    // The parent application is converged, not `uncertain`, so the Conversation
    // slot it would otherwise hold is free on the next reconciliation.
    expect(store.findApplication(decisionId)).toMatchObject({ status: 'applied' });
    expect(store.countByApplicationStatus().uncertain).toBe(0);
    expect(parseApplicationSettlement(store.findApplication(decisionId)?.errorSummary)?.kind)
      .toBe('rejected_without_effect');
  });
});
