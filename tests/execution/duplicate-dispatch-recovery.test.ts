import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStartupRecoveryService } from '../../src/account/account-startup-recovery-service.js';
import { ControlExecutionRuntime } from '../../src/execution/control-execution-runtime.js';
import { TaskControlWorkflow } from '../../src/execution/task-control-workflow.js';
import { ConversationTaskSchedulerRepo } from '../../src/storage/conversation-task-scheduler-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { TaskRecoveryItemRepo } from '../../src/storage/task-recovery-item-repo.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import type { ControlEvent } from '../../src/control/control-contracts.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(runtimeDeps: Record<string, unknown> = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  initializeDatabaseSchema(db);
  db.prepare(`INSERT INTO tasks (id,title,goal,status,account_id,conversation_id,workspace_id,
    owner_planner_session_id,admitted_at,created_at,updated_at)
    VALUES ('task','Report','Report','queued','account','conv','ws','conv','now','now','now')`).run();
  const tasks = new TaskRepo(db);
  const scheduler = new ConversationTaskSchedulerRepo(db);
  scheduler.enqueueTask('task', 'conv', 'now');
  scheduler.promoteAvailable(2, 'now');
  scheduler.markRunning('task', 'now');
  const runtime = new ControlExecutionRuntime({
    sessionId: 'conv', taskRuntimeService: { findTask: (id: string) => tasks.findById(id) },
    ...runtimeDeps,
  } as never);
  const service = new AccountStartupRecoveryService({
    taskServices: { taskRuntimeService: { findTask: (id: string) => tasks.findById(id),
      listTasksByStatus: (status: string) => tasks.findAll().filter(task => task.status === status) } },
    repositories: { conversationTaskSchedulerRepo: scheduler, workGraphRevisionRepo: { findActive: () => null } },
    kernelExecutionServices: { kernelExecutionRuntime: runtime },
    kernelConfiguration: { runtimePolicy: { maxConcurrentConversationsPerWorkspace: 2 } },
    kernelServices: { recoveryItems: { listIncompleteDispatchCompletions: () => [] } },
    blockedRecheckEnabled: false,
  } as never);
  for (const method of ['deliverPendingEffects', 'recoverWorkspaceGit', 'convergeMissingRetryWakes', 'convergeRecoveryRequired'] as const) {
    vi.spyOn(service as never, method).mockResolvedValue(false as never);
  }
  vi.spyOn(service as never, 'runReplanWorker').mockResolvedValue({ claimed: 0 } as never);
  vi.spyOn(service as never, 'getRetryWakeWorker').mockReturnValue({ run: async () => 0 } as never);
  vi.spyOn(service as never, 'convergeTerminalTaskUsage').mockImplementation(() => undefined);
  vi.spyOn(service as never, 'convergeUncertainApplications').mockReturnValue([] as never);
  vi.spyOn(service as never, 'clearStaleCapacityBlocks').mockReturnValue([] as never);
  vi.spyOn(service as never, 'hasReleasableResidue').mockReturnValue(false as never);
  const promoted = vi.spyOn(service as never, 'promoteConversationTask').mockResolvedValue(undefined as never);
  return { db, tasks, scheduler, runtime, service, promoted };
}

function event(id: string): ControlEvent {
  return { schemaVersion: 5, configurationRevision: 'config', type: 'dispatch_requested', id,
    taskId: 'task', sessionId: 'conv', correlationId: id, causationId: null, occurredAt: 'now', reason: 'wake' };
}

describe('dispatch preparation and periodic recovery', () => {
  it('keeps the reservation while Router is paused and rereads facts for another control request', async () => {
    const f = fixture();
    const entered = deferred();
    const router = deferred();
    const before = f.scheduler.getSlot('conv');
    let dispatched = false;
    const routed = vi.fn(async () => { entered.resolve(); await router.promise; dispatched = true; });
    const snapshots = vi.fn(() => ({ schemaVersion: 5, type: 'dispatch', dispatched }));
    const recordUncertain = vi.fn();
    const makeWorkflow = () => new TaskControlWorkflow({
      withTaskOperation: (id, work) => f.runtime.withTaskOperation(id, work),
      kernel: { decide: (input, snapshot) => ({ schemaVersion: 5, id: `decision-${input.id}`,
        configurationRevision: 'config', eventId: input.id, reason: 'test',
        action: { type: 'no_op' }, ...{ shouldRoute: !(snapshot as unknown as { dispatched: boolean }).dispatched } }) },
      buildSnapshot: snapshots as never,
      runtime: { apply: async decision => {
        if ((decision as unknown as { shouldRoute: boolean }).shouldRoute) await routed();
        return null;
      } }, clock: { now: () => 'now' }, recordUncertain,
    });
    const first = makeWorkflow().submit(event('first'));
    await entered.promise;
    await f.service.recoverPeriodic();
    expect(f.scheduler.getSlot('conv')).toEqual(before);
    expect(f.promoted).not.toHaveBeenCalled();
    const second = makeWorkflow().submit({ ...event('second'), type: 'task_resume_requested',
      blockerCategory: 'capacity', sourceInputExcerpt: 'continue', newlyProvidedResources: [], idempotencyKey: 'second' } as ControlEvent);
    expect(snapshots).toHaveBeenCalledTimes(1);
    router.resolve();
    const results = await Promise.all([first, second]);
    expect(results[1].decisions[0]?.eventId).toBe('second');
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(routed).toHaveBeenCalledTimes(1);
    expect(recordUncertain).not.toHaveBeenCalled();
    expect(f.runtime.isTaskOperationActive('task')).toBe(false);
  });

  it('protects the actual execute entry and acknowledges a distinct resume request', async () => {
    const entered = deferred(); const router = deferred();
    let dispatched = false;
    const f = fixture({
      executionProgressService: { createTracker: () => ({}) },
      workGraphRevisionRepo: { findActive: () => null },
      attemptReceiptRepo: { listByTask: () => [] },
      cancellationCoordinator: { recover: async () => {}, settlePartialCancellation: () => {} },
      controlLoop: { decide: (e: ControlEvent) => ({ schemaVersion: 5, id: `decision-${e.id}`,
        eventId: e.id, configurationRevision: 'config', action: { type: 'no_op' }, reason: 'test' }) },
    });
    vi.spyOn(f.runtime as never, 'resumeResultContinuations').mockResolvedValue(true as never);
    vi.spyOn(f.runtime as never, 'configurationRevisionForTask').mockReturnValue('config' as never);
    vi.spyOn(f.runtime as never, 'buildDispatchStableFacts').mockReturnValue({} as never);
    const snapshots = vi.spyOn(f.runtime as never, 'buildDispatchSnapshot').mockImplementation(
      (() => ({ schemaVersion: 5, type: 'dispatch', dispatched })) as never);
    vi.spyOn(f.runtime as never, 'recoverExpiredAttempts').mockResolvedValue(undefined as never);
    vi.spyOn(f.runtime as never, 'drainPublications').mockResolvedValue(undefined as never);
    vi.spyOn(f.runtime['attemptSupervisor'], 'recover').mockImplementation(() => {});
    vi.spyOn(f.runtime['attemptSupervisor'], 'drain').mockResolvedValue(undefined);
    const route = vi.fn(async () => { entered.resolve(); await router.promise; dispatched = true; });
    vi.spyOn(f.runtime as never, 'applyExecutionDecision').mockImplementation((async () => {
      if (!dispatched) await route();
      return null;
    }) as never);
    const acknowledged = vi.fn();
    const before = f.scheduler.getSlot('conv');
    const first = f.runtime.execute({ taskId: 'task', graphState: 'ready',
      request: { userPrompt: 'Report', executionMode: 'follow-up' } } as never);
    await entered.promise;
    await f.service.recoverPeriodic();
    expect(f.scheduler.getSlot('conv')).toEqual(before);
    const second = f.runtime.execute({ taskId: 'task', graphState: 'ready', onInitialDecision: acknowledged,
      request: { userPrompt: 'continue', executionMode: 'resume-blocked' } } as never);
    expect(snapshots).toHaveBeenCalledTimes(1);
    router.resolve();
    await Promise.all([first, second]);
    expect(route).toHaveBeenCalledTimes(1);
    expect(acknowledged).toHaveBeenCalledWith(expect.objectContaining({ eventId: expect.stringContaining('resume_event_') }));
    expect(snapshots).toHaveBeenCalledTimes(2);
    expect(f.runtime.isTaskOperationActive('task')).toBe(false);
  });

  it('still releases and promotes a queued task after its driver yielded resources', async () => {
    const f = fixture();
    const before = f.scheduler.getSlot('conv');
    await f.service.recoverPeriodic();
    expect(f.scheduler.getSlot('conv').reservationId).not.toBe(before.reservationId);
    expect(f.promoted).toHaveBeenCalledTimes(1);
  });

  it('does not spend another retry authorization on repeated scans or during an active operation', async () => {
    const f = fixture();
    const recovery = new TaskRecoveryItemRepo(f.db);
    recovery.record({ operation: { schemaVersion: 5, id: 'recover', eventId: 'event',
      configurationRevision: 'config', action: { type: 'dispatch_batch', taskId: 'task',
        items: [{ attemptId: 'retry', subtaskId: 'sub' } as never] }, reason: 'interrupted' },
    taskId: 'task', subtaskId: null, attemptId: null, errorSummary: 'interrupted', createdAt: 'now' });
    const service = new AccountStartupRecoveryService({
      kernelServices: { recoveryItems: recovery },
      kernelExecutionServices: { kernelExecutionRuntime: f.runtime },
    } as never);
    vi.spyOn(service as never, 'recoveryFactSource').mockReturnValue({
      findTask: () => null, listSubtasks: () => [], listDispatchItems: () => [],
    } as never);
    await f.runtime.withTaskOperation('task', async () => {
      expect(service['convergeUncertainApplications']('now')).toEqual([]);
      expect(recovery.findRecoveryItem('recover')?.applyAttempts).toBe(1);
    });
    service['convergeUncertainApplications']('now');
    service['convergeUncertainApplications']('now');
    expect(recovery.findRecoveryItem('recover')).toMatchObject({ status: 'retry_authorized', applyAttempts: 2 });
  });
});
