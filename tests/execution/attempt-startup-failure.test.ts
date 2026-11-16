import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtaskAttemptRunner } from '../../src/execution/subtask-attempt-runner.js';
import { ConversationWorktreeService } from '../../src/execution/conversation-worktree-service.js';
import { WorkspaceGitService } from '../../src/execution/workspace-git-service.js';
import { WorkspaceStore } from '../../src/execution/workspace-store.js';
import { WorkUnitClaimService } from '../../src/execution/work-unit-claim-service.js';
import { ResourceLeaseService } from '../../src/execution/resource-lease-service.js';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { WorkspaceGitRepo } from '../../src/storage/workspace-git-repo.js';
import { TaskRepo } from '../../src/storage/task-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkUnitRepo } from '../../src/storage/work-unit-repo.js';
import { AgentClassRepo } from '../../src/storage/agent-class-repo.js';
import { ControlDispatchItemRepo } from '../../src/storage/dispatch-item-repo.js';
import { ExecutorAttemptReceiptRepo } from '../../src/storage/executor-attempt-receipt-repo.js';
import { ExecutorAttemptRuntimeRepo } from '../../src/storage/executor-attempt-runtime-repo.js';
import { SqliteWorkspaceRepository } from '../../src/storage/workspace-repo.js';
import { SqliteResourceLeaseRepository } from '../../src/storage/resource-lease-repo.js';
import { SqlitePermissionRepository } from '../../src/storage/permission-repo.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { builtinPiAgentClass } from '../support/builtin-agent-classes.js';
import { COMPLETION_MARKER_V4 } from '../../src/execution/completion-protocol.js';
import { decideFailure } from '../../src/execution/failure-retry-policy.js';
import { AttemptSupervisor } from '../../src/execution/attempt-supervisor.js';
import { ControlExecutionRuntime } from '../../src/execution/control-execution-runtime.js';
import type { ControlEvent, ControlSnapshot } from '../../src/control/control-contracts.js';

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
const binding = { agentClassRef: 'pi-agent', harnessRef: 'pi-cli', providerRef: 'provider', modelRef: 'model',
  permissionProfileRef: 'public-web-research', configurationRevision: 'config' };
const fingerprint = authorizedExecutorBindingFingerprint(binding);
const now = '2026-11-15T00:00:00.000Z';
const response = `Research complete.\n\n${COMPLETION_MARKER_V4}\n${JSON.stringify({
  evidence: ['Reviewed the fixture'], noChangeReason: null,
})}`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const db = new Database(':memory:');
  initializeDatabaseSchema(db);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mw-startup-failure-')));
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, 'README.md'), 'Shared research input\n');
  db.prepare(`INSERT INTO tasks (id,title,goal,status,account_id,conversation_id,workspace_id,created_at,updated_at)
    VALUES ('task','Research','Research','running','local-default','conv','ws',?,?)`).run(now, now);
  db.prepare(`INSERT INTO configuration_revisions (revision_id,content_hash,source_kind,imported_at)
    VALUES ('config','test','native',?)`).run(now);
  db.prepare(`INSERT INTO work_graph_revisions
    (id,task_id,revision,generation_id,status,configuration_revision,authorized_decision_id,created_at,updated_at)
    VALUES ('graph','task',1,'gen','active','config','admission',?,?)`).run(now, now);
  const subtasks = new SubtaskRepo(db);
  for (const id of ['s1', 's2', 's3']) subtasks.upsert({
    id, taskId: 'task', generationId: 'gen', graphRevision: 1, title: id, goal: `Research ${id}`, status: 'ready',
    dependencies: [], contextRefs: [], requiredCapabilities: ['current-web-research'], executorBindings: [binding],
    deliveryKind: 'report', workspaceEffect: 'read_only', fileOutputs: [], acceptance: [], riskLevel: 'low',
    result: '', artifacts: [], verification: { warnings: [], completionSchemaVersion: null }, error: null,
    createdAt: now, updatedAt: now,
  });
  new AgentClassRepo(db).upsert(builtinPiAgentClass());
  const units = new WorkUnitRepo(db);
  for (const id of ['unit1', 'unit2', 'unit3']) units.upsert({
    id, agentClassName: binding.agentClassRef, agentClassKind: 'executor', state: 'idle',
    claimedTaskId: null, claimedSubtaskId: null, claimedAttemptId: null, heartbeatAt: null, leaseExpiresAt: null,
    createdAt: now, updatedAt: now,
  });
  const conversations = new ConversationWorktreeService(
    new WorkspaceGitService({ internalRoot: join(root, 'git') }), new WorkspaceGitRepo(db));
  const workspace = await conversations.bind({ accountId: 'local-default', workspaceId: 'ws',
    conversationId: 'conv', userRoot: sourceRoot, taskId: 'task', generationId: 'gen' });
  const tasks = new TaskRepo(db);
  const dispatch = new ControlDispatchItemRepo(db);
  const execution = {
    run: vi.fn(async () => ({ status: 'success', executorName: 'pi-agent', output: response, durationMs: 1 })),
    supportsEvidenceTools: () => true, resolvePermissionProfile: () => 'public-web-research',
    resolveModelId: () => 'model', abortTask: vi.fn(),
  };
  const claims = new WorkUnitClaimService(units);
  const runner = new SubtaskAttemptRunner({
    db, sessionId: 'conv', taskRuntimeService: { findTask: (id: string) => tasks.findById(id) } as never,
    subtaskRepo: subtasks, workUnitClaimService: claims, executionRuntime: execution as never,
    agentClassService: { hasExecutorAgentClass: () => true } as never,
    workspaceStore: new WorkspaceStore(join(root, 'scratch')), conversationWorktrees: conversations,
    attemptExecutionBackend: { kind: 'worktree', pathMode: 'native' } as never,
    resourceLeaseService: new ResourceLeaseService(new SqliteResourceLeaseRepository(db)),
    permissionRepository: new SqlitePermissionRepository(db), workspaceRepository: new SqliteWorkspaceRepository(db),
    sourceRoot, controlNetwork: 'local', resultRoot: join(root, 'results'), accountId: 'local-default',
  });
  function authorize(subtaskId = 's2', attemptId = 'attempt', sourceAttemptId: string | null = null, launch = true) {
    const item = { subtaskId, attemptId, authorizedBinding: binding, bindingFingerprint: fingerprint,
      attemptKind: sourceAttemptId ? 'continuation' as const : 'primary' as const, sourceAttemptId,
      recoveryMode: sourceAttemptId ? 'recovery_packet' as const : 'fresh' as const,
      attemptPayload: null, defaultResourceGrant: [], order: 0 };
    dispatch.insertBatch({ schemaVersion: 5, id: `decision-${attemptId}`, eventId: `event-${attemptId}`,
      configurationRevision: 'config', reason: 'Research', action: { type: 'dispatch_batch', taskId: 'task', items: [item] } },
    { generationId: 'gen', configurationRevision: 'config', executionBindingFingerprint: workspace.bindingFingerprint,
      attempts: { [attemptId]: item } }, now);
    if (launch) {
      dispatch.claimPending(attemptId, now);
      dispatch.markRunning(attemptId, null, now);
    }
    return item;
  }
  const run = (subtaskId = 's2', attemptId = 'attempt', sourceAttemptId: string | null = null) => {
    authorize(subtaskId, attemptId, sourceAttemptId);
    return runner.run({ taskId: 'task', subtaskId, attemptId, executionId: attemptId,
      authorizedBinding: binding, bindingFingerprint: fingerprint, defaultResourceGrant: [] });
  };
  return { db, runner, run, authorize, tasks, subtasks, dispatch, units, claims, conversations, workspace, execution,
    receipts: new ExecutorAttemptReceiptRepo(db), runtimes: new ExecutorAttemptRuntimeRepo(db) };
}

function failureDecision(f: Awaited<ReturnType<typeof fixture>>, attemptId = 'attempt') {
  const receipt = f.receipts.findByAttemptId(attemptId)!;
  return decideFailure({ schemaVersion: 5, id: `failure-${attemptId}`, configurationRevision: 'config',
    taskId: 'task', subtaskId: receipt.subtaskId, attemptId, attemptKind: receipt.attemptKind,
    type: 'execution_outcome', occurredAt: now, terminalKind: 'failed', failure: receipt.failure,
    authorizedBinding: binding, bindingFingerprint: fingerprint,
  } as Extract<ControlEvent, { type: 'execution_outcome' }>, {
    type: 'dispatch', task: f.tasks.findById('task'), subtasks: f.subtasks.listByTask('task'),
    automaticRecoveryAllowed: true, automaticReplansUsed: 0, recoverySafety: 'read_only',
    generationId: 'gen', graphRevision: 1, attempts: [], dispatchItems: f.dispatch.listByTask('task'),
    executorStatuses: [], resourceGrantsBySubtask: {},
  } as unknown as Extract<ControlSnapshot, { type: 'dispatch' }>);
}

describe('Attempt startup failure landing', () => {
  it('lands an original read preparation error and releases claims without starting an Executor', async () => {
    const f = await fixture();
    vi.spyOn(f.conversations, 'beginRead').mockRejectedValueOnce(new Error('injected read preparation failure'));
    await expect(f.run()).resolves.toMatchObject({ outcome: 'executor_failed', error: 'injected read preparation failure' });
    expect(f.receipts.findByAttemptId('attempt')).toMatchObject({
      terminalState: 'executor_failed', errorDetail: 'injected read preparation failure',
      failure: { stage: 'workspace_preparation', attemptStarted: false, externalSideEffect: false, retryable: false },
    });
    expect(f.subtasks.findById('s2')?.status).toBe('awaiting_decision');
    expect(f.dispatch.find('attempt')?.status).toBe('terminal');
    expect(f.runtimes.find('attempt')).toBeNull();
    expect(f.execution.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM resource_leases WHERE released_at IS NULL').all()).toEqual([]);
    expect(f.units.findAll().every(unit => unit.claimedAttemptId === null)).toBe(true);
    expect(f.conversations.repo.conversationState(f.workspace.worktreeId).ownerToken).toBeNull();
    expect(failureDecision(f).action.type).toBe('block_work');
  });

  it.each(['EAGAIN', 'EBUSY', 'ETIMEDOUT', 'workspace_git_busy:integration'])
    ('uses the existing bounded retry policy for a definite transient read preparation error: %s', async code => {
      const f = await fixture();
      const error = code.startsWith('E') ? Object.assign(new Error(`temporary ${code}`), { code }) : new Error(code);
      vi.spyOn(f.conversations, 'beginRead').mockRejectedValueOnce(error);
      await f.run();
      expect(f.receipts.findByAttemptId('attempt')?.failure).toMatchObject({
        kind: 'infrastructure', attemptStarted: false, externalSideEffect: false, retryable: true,
      });
      expect(failureDecision(f).action).toMatchObject({ type: 'wait_for_retry', sourceAttemptId: 'attempt',
        resumeAt: '2026-11-15T00:00:30.000Z' });
      expect(f.execution.run).not.toHaveBeenCalled();
      await expect(f.run('s2', 'retry', 'attempt')).resolves.toMatchObject({ outcome: 'completed' });
      expect(f.execution.run).toHaveBeenCalledTimes(1);
      expect(f.receipts.findByAttemptId('retry')?.terminalState).toBe('completed');
      expect(f.subtasks.findById('s2')?.status).toBe('done');
      expect(f.dispatch.listBlocking()).toEqual([]);
    });

  it.each(['stale_conversation_binding', 'read_only_input_changed'])
    ('lands %s as a repairable configuration failure without automatic retry', async message => {
      const f = await fixture();
      vi.spyOn(f.conversations, 'beginRead').mockRejectedValueOnce(new Error(message));
      await f.run();
      expect(f.receipts.findByAttemptId('attempt')?.failure).toMatchObject({ kind: 'configuration', retryable: false });
      expect(failureDecision(f).action.type).toBe('block_work');
      expect(f.dispatch.listBlocking()).toEqual([]);
    });

  it('does not create unlimited same-route retries when preparation keeps failing', async () => {
    const f = await fixture();
    vi.spyOn(f.conversations, 'beginRead').mockRejectedValue(Object.assign(new Error('temporary busy'), { code: 'EBUSY' }));
    await f.run();
    expect(failureDecision(f).action.type).toBe('wait_for_retry');
    await f.run('s2', 'retry1', 'attempt');
    expect(failureDecision(f, 'retry1').action.type).toBe('wait_for_retry');
    await f.run('s2', 'retry2', 'retry1');
    // The existing policy asks Router after its two same-route retries. It
    // cannot silently launch another continuation on the exhausted binding.
    expect(failureDecision(f, 'retry2').action).toMatchObject({ type: 'dispatch_batch',
      items: [{ attemptKind: 'fallback', sourceAttemptId: 'retry2' }] });
    expect(f.receipts.listByTask('task')).toHaveLength(3);
    expect(f.dispatch.listBlocking()).toEqual([]);
    expect(f.execution.run).not.toHaveBeenCalled();
  });

  it('does not classify an exception after Executor invocation as safe startup failure', async () => {
    const f = await fixture();
    f.execution.run.mockRejectedValueOnce(Object.assign(new Error('late executor error'), { code: 'EBUSY' }));
    const outcome = await f.run();
    if (outcome.outcome !== 'executor_failed') throw new Error(`Unexpected outcome: ${outcome.outcome}`);
    const failure = outcome.failure!;
    expect(failure.kind).toBe('unknown');
    expect(failure.attemptStarted).not.toBe(false);
    expect(failure.externalSideEffect).not.toBe(false);
    expect(f.receipts.findByAttemptId('attempt')?.failure?.attemptStarted).not.toBe(false);
    expect(failureDecision(f).action.type).toBe('block_work');
  });

  it('retains the terminal fence when another result has already completed the Subtask', async () => {
    const f = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(f.conversations, 'beginRead').mockImplementationOnce(async () => {
      f.db.prepare("UPDATE subtasks SET status='done',result='newer result' WHERE id='s2'").run();
      throw new Error('stale preparation');
    });
    await expect(f.run()).rejects.toThrow('terminal persistence failed: attempt terminal fence changed');
    expect(f.subtasks.findById('s2')).toMatchObject({ status: 'done', result: 'newer result' });
    expect(f.receipts.findByAttemptId('attempt')).toBeNull();
  });

  it('keeps an actually changed shared worktree fenced and preserves the verification error', async () => {
    const f = await fixture();
    const beginRead = f.conversations.beginRead.bind(f.conversations);
    vi.spyOn(f.conversations, 'beginRead').mockImplementationOnce(async (...args) => {
      writeFileSync(join(f.workspace.executionRoot, 'README.md'), 'Unexpected modification\n');
      return beginRead(...args);
    });
    await expect(f.run()).resolves.toMatchObject({ outcome: 'executor_failed' });
    expect(f.receipts.findByAttemptId('attempt')?.failure).toMatchObject({
      kind: 'configuration', summary: 'read_only_workspace_changed', retryable: false,
    });
    expect(f.conversations.repo.conversationState(f.workspace.worktreeId).state).toBe('failed');
    expect(f.conversations.repo.operationRecord('read_attempt')?.state).toBe('needs_recovery');
    expect(f.execution.abortTask).toHaveBeenCalledWith('task');
    expect(f.execution.run).not.toHaveBeenCalled();
    expect(failureDecision(f).action.type).toBe('block_work');
  });

  it('does not retry transient verification errors after the Workspace failed closed', async () => {
    const f = await fixture();
    vi.spyOn(f.conversations, 'beginRead').mockImplementationOnce(async () => {
      f.conversations.repo.setConversationState(f.workspace.worktreeId, 'failed');
      throw Object.assign(new Error('verification I/O busy'), { code: 'EBUSY' });
    });
    await f.run();
    expect(f.receipts.findByAttemptId('attempt')?.failure).toMatchObject({ kind: 'configuration', retryable: false });
    expect(failureDecision(f).action.type).toBe('block_work');
  });

  it('keeps a cancellation that wins while preparation is paused', async () => {
    const f = await fixture();
    const entered = deferred(); const gate = deferred();
    vi.spyOn(f.conversations, 'beginRead').mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; throw new Error('preparation interrupted');
    });
    const running = f.run();
    try {
      await entered.promise;
      expect(f.subtasks.findById('s2')?.status).toBe('running');
      // Model an already committed cancellation fence, not cancellation policy.
      f.db.prepare("UPDATE tasks SET status='cancelled' WHERE id='task'").run();
      f.db.prepare("UPDATE subtasks SET status='cancelled' WHERE task_id='task'").run();
    } finally { gate.resolve(); }
    await running;
    expect(f.tasks.findById('task')?.status).toBe('cancelled');
    expect(f.subtasks.findById('s2')?.status).toBe('cancelled');
    expect(f.receipts.findByAttemptId('attempt')).not.toBeNull();
    expect(f.execution.run).not.toHaveBeenCalled();
    expect(f.dispatch.listBlocking()).toEqual([]);
    expect(failureDecision(f).action.type).toBe('no_op');
  });

  it('can land heartbeat loss during preparation without losing the receipt', async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    vi.spyOn(f.conversations, 'beginRead').mockImplementationOnce(async () => {
      entered.resolve(); await gate.promise; throw new Error('preparation interrupted after heartbeat loss');
    });
    const running = f.run();
    try {
      await entered.promise;
      const unit = f.units.findAll().find(value => value.claimedAttemptId === 'attempt')!;
      f.runner.landHeartbeatLost({ taskId: 'task', subtaskId: 's2', attemptId: 'attempt', executionId: 'heartbeat',
        workUnitId: unit.id, authorizedBinding: binding, bindingFingerprint: fingerprint });
    } finally { gate.resolve(); }
    await running;
    expect(f.receipts.listByTask('task')).toHaveLength(1);
    expect(f.receipts.findByAttemptId('attempt')?.terminalState).toBe('heartbeat_lost');
    expect(f.db.prepare('SELECT * FROM resource_leases WHERE released_at IS NULL').all()).toEqual([]);
  });

  it.each([false, true])('keeps both errors and uncertainty when terminal persistence fails (Executor invoked=%s)', async launched => {
    const f = await fixture();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const original = new Error('injected original failure token=test-secret');
    if (launched) f.execution.run.mockRejectedValueOnce(original);
    else vi.spyOn(f.conversations, 'beginRead').mockRejectedValueOnce(original);
    f.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON executor_attempt_receipts
      BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END`);
    f.authorize('s2', 'attempt', null, false);
    const supervisor = new AttemptSupervisor(f.dispatch);
    const control = new ControlExecutionRuntime({ sessionId: 'conv' } as never);
    const submit = vi.fn();
    supervisor.recover('task', {
      run: async item => {
        await f.runner.run({ taskId: 'task', subtaskId: 's2', attemptId: item.attemptId, executionId: item.attemptId,
          authorizedBinding: binding, bindingFingerprint: fingerprint, defaultResourceGrant: [] });
        throw new Error('expected receipt failure');
      },
      onLaunchError: async (item, error) => control['launchFailureEvent'](item, error), submit,
    });
    await supervisor.drain('task');
    expect(f.dispatch.find('attempt')).toMatchObject({ status: 'uncertain',
      errorSummary: expect.stringContaining('injected original failure') });
    expect(f.dispatch.find('attempt')?.errorSummary).toContain('injected receipt write failure');
    expect(f.receipts.findByAttemptId('attempt')).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0]![0].failure.attemptStarted).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      originalError: 'injected original failure token=[REDACTED]', landingError: 'injected receipt write failure',
    }));
    expect(f.execution.run).toHaveBeenCalledTimes(launched ? 1 : 0);
  });

  it('still runs three independent readers concurrently and releases their shared claim', async () => {
    const f = await fixture(); const entered = deferred(); const gate = deferred();
    f.execution.run.mockImplementation(async () => {
      if (f.execution.run.mock.calls.length === 3) entered.resolve();
      await gate.promise;
      return { status: 'success', executorName: 'pi-agent', output: response, durationMs: 1 };
    });
    const running = ['s1', 's2', 's3'].map(id => f.run(id, `attempt-${id}`));
    try {
      await Promise.race([entered.promise, Promise.all(running).then(() => { throw new Error('readers did not overlap'); })]);
      expect(f.units.findAll().filter(unit => unit.claimedAttemptId)).toHaveLength(3);
    } finally { gate.resolve(); }
    expect((await Promise.all(running)).map(value => value.outcome)).toEqual(['completed', 'completed', 'completed']);
    expect(f.receipts.listByTask('task')).toHaveLength(3);
    expect(f.dispatch.listBlocking()).toEqual([]);
    expect(f.conversations.repo.conversationState(f.workspace.worktreeId).ownerToken).toBeNull();
  });
});
