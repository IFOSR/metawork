import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabaseSchema } from '../../src/storage/schema.js';
import { ControlDispatchItemRepo, DispatchAttemptConflictError } from '../../src/storage/dispatch-item-repo.js';
import { SubtaskRepo } from '../../src/storage/subtask-repo.js';
import { WorkGraphRevisionRepo } from '../../src/storage/work-graph-revision-repo.js';
import { TaskRecoveryItemRepo } from '../../src/storage/task-recovery-item-repo.js';
import { ControlExecutionRuntime } from '../../src/execution/control-execution-runtime.js';
import { TaskControlWorkflow } from '../../src/execution/task-control-workflow.js';
import { authorizedExecutorBindingFingerprint } from '../../src/core/authorized-executor-binding.js';
import { inspectApplicationPostcondition, type ApplicationPostconditionFacts, type DispatchRecoveryFacts } from '../../src/execution/control-application-recovery.js';
import { stableAttemptOrdinal } from '../../src/execution/attempt-dispatch-plan.js';
import type { ControlDecision, ControlEvent } from '../../src/control/control-contracts.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const binding = { agentClassRef: 'pi', harnessRef: 'pi-cli', providerRef: 'provider', modelRef: 'model',
  permissionProfileRef: 'standard', configurationRevision: 'config' };
const fingerprint = authorizedExecutorBindingFingerprint(binding);
const start = '2026-11-14T10:00:00.000Z';
const conflict = '2026-11-14T10:01:00.000Z';
const end = '2026-11-14T10:02:00.000Z';
function decision(id: string, nodes = ['sub']) {
  return { schemaVersion: 5 as const, id, eventId: id, configurationRevision: 'config', reason: 'dispatch',
    action: { type: 'dispatch_batch' as const, taskId: 'task', items: nodes.map((subtaskId, order) => ({
      subtaskId, attemptId: `${id}-${subtaskId}`, authorizedBinding: binding, bindingFingerprint: fingerprint,
      attemptKind: 'primary' as const, sourceAttemptId: null, recoveryMode: 'fresh' as const,
      attemptPayload: null, defaultResourceGrant: [], order,
    })) } };
}
function fixture() {
  const db = new Database(':memory:'); databases.push(db); initializeDatabaseSchema(db);
  db.prepare(`INSERT INTO tasks (id,title,status,account_id,conversation_id,workspace_id,created_at,updated_at)
    VALUES ('task','Report','running','account','conv','ws',?,?)`).run(start, start);
  db.prepare(`INSERT INTO configuration_revisions (revision_id,content_hash,source_kind,imported_at)
    VALUES ('config','test','native',?)`).run(start);
  db.prepare(`INSERT INTO work_graph_revisions
    (id,task_id,revision,generation_id,status,configuration_revision,authorized_decision_id,created_at,updated_at)
    VALUES ('graph','task',1,'gen','active','config','admission',?,?)`).run(start, start);
  for (const id of ['sub', 'other']) db.prepare(`INSERT INTO subtasks
    (id,task_id,generation_id,graph_revision,title,goal,status,executor_bindings_json,required_capabilities_json,created_at,updated_at)
    VALUES (?,'task','gen',1,'Node','Node','ready',?,'[]',?,?)`).run(id, JSON.stringify([binding]), start, start);
  const repo = new ControlDispatchItemRepo(db);
  const insert = (d: ReturnType<typeof decision>) => repo.insertBatch(d, {
    generationId: 'gen', configurationRevision: 'config', executionBindingFingerprint: 'workspace',
    attempts: Object.fromEntries(d.action.items.map(i => [i.attemptId, i])),
  }, start);
  return { db, repo, insert, recovery: new TaskRecoveryItemRepo(db) };
}
function historicalFacts(): ApplicationPostconditionFacts {
  const f = fixture(); const owner = f.insert(decision('owner'))[0]!;
  const proposed = decision('duplicate');
  f.db.prepare("UPDATE subtasks SET status='done'").run();
  f.recovery.record({ operation: proposed, taskId: 'task', subtaskId: null, attemptId: null,
    errorSummary: 'live owner', createdAt: conflict });
  f.recovery.resolveRecoveryItem('duplicate', 'retry', conflict);
  const raw = f.recovery.readDispatchRecoveryFacts(f.recovery.findRecoveryItem('duplicate')!);
  const evidence: DispatchRecoveryFacts = { ...raw, binding: { binding_fingerprint: 'workspace', created_at: start },
    dispatches: [{ ...owner, status: 'terminal', terminalAt: end }],
    receipts: [{ ...owner, graphRevision: 1, terminalState: 'completed' } as never],
    routes: [{ task_id: 'task', generation_id: 'gen', subtask_id: 'sub', graph_revision: 1,
      configuration_revision: 'config', outcome: 'selected', created_at: conflict,
      attempt_ordinal: stableAttemptOrdinal(proposed.action.items[0]!.attemptId) }] };
  return { application: f.recovery.findRecoveryItem('duplicate')!, task: { id: 'task', status: 'needs_action', dependencies: [] },
    subtasks: evidence.subtasks, dispatchItems: evidence.dispatches, dispatchRecovery: evidence,
    workGraphRevision: null, replanRequest: null, queuedReplanRequest: null };
}

describe('dispatch conflict ownership', () => {
  it('rolls back the whole competing batch, including earlier nonconflicting nodes', () => {
    const f = fixture(); f.insert(decision('owner'));
    expect(() => f.insert(decision('duplicate', ['other', 'sub']))).toThrow(DispatchAttemptConflictError);
    expect(f.repo.listByTask('task').map(i => i.attemptId)).toEqual(['owner-sub']);
    expect(f.recovery.listUnresolved()).toEqual([]);
  });
  it.each(['continuation', 'fallback', 'contract_correction', 'merge_repair'] as const)
    ('allows %s after a terminal attempt', kind => {
      const f = fixture(); f.insert(decision('owner'));
      f.repo.claimPending('owner-sub', start);
      f.repo.markTerminal('owner-sub', null, end);
      const next = decision('retry');
      const item = { ...next.action.items[0]!, attemptKind: kind, sourceAttemptId: 'owner-sub' };
      const rows = f.insert({ ...next, action: { ...next.action, items: [item] } } as never);
      expect(rows[0]!.attemptKind).toBe(kind);
    });
  it.each([true, false])('settles only typed rollback, leaves unknown effects fenced: typed=%s', async typed => {
    const f = fixture(); const runtime = new ControlExecutionRuntime({ sessionId: 'conv',
      callbacks: { appendExecutionTrace: vi.fn() } } as never);
    const d = decision('duplicate');
    vi.spyOn(runtime as never, 'applyExecutionDecisionUnchecked').mockRejectedValue(typed
      ? new DispatchAttemptConflictError('task', 'gen', 'sub', 'owner') : new Error('external preparation outcome unknown'));
    const uncertain = vi.fn();
    const workflow = new TaskControlWorkflow({ kernel: { decide: e => e.id === 'event' ? d
      : { ...d, id: 'fresh', action: { type: 'no_op' } } },
      buildSnapshot: () => ({ schemaVersion: 5, type: 'dispatch' } as never),
      runtime: { apply: async selected => selected.action.type === 'no_op' ? null
        : runtime['applyExecutionDecision']({ decision: selected } as never) },
      clock: { now: () => conflict }, recordUncertain: uncertain });
    const result = await workflow.submit({ id: 'event', taskId: 'task', type: 'dispatch_requested' } as ControlEvent);
    expect(uncertain).toHaveBeenCalledTimes(typed ? 0 : 1);
    expect(result.decisions.map(i => i.id)).toEqual(typed ? ['duplicate', 'fresh'] : ['duplicate']);
  });
});

describe('completed duplicate recovery evidence', () => {
  it('proves the unlanded request is redundant using same-generation completed owner receipts', () => {
    expect(inspectApplicationPostcondition(historicalFacts()).verdict).toBe('settled');
  });
  it.each(['cancelled', 'wrong-generation', 'wrong-graph', 'wrong-config', 'revoked-binding', 'late-binding',
    'missing-route', 'late-owner', 'old-owner', 'failed-receipt', 'missing-receipt', 'workspace-unknown',
    'own-effects', 'continuation', 'repair-payload', 'wrong-owner-binding', 'different-grant'])(
    'preserves the blocker when evidence is insufficient: %s', mode => {
      const facts = historicalFacts(); const raw = structuredClone(facts) as any;
      const e = raw.dispatchRecovery;
      switch (mode) {
        case 'cancelled': raw.task.status = 'cancelled'; break;
        case 'wrong-generation': e.revision.generationId = 'other'; break;
        case 'wrong-graph': e.revision.revision = 2; break;
        case 'wrong-config': e.revision.configurationRevision = 'other'; break;
        case 'revoked-binding': e.subtasks[0].executorBindings = []; break;
        case 'late-binding': e.binding.created_at = end; break;
        case 'missing-route': e.routes = []; break;
        case 'late-owner': e.dispatches[0].createdAt = end; break;
        case 'old-owner': e.dispatches[0].terminalAt = start; break;
        case 'failed-receipt': e.receipts[0].terminalState = 'failed'; break;
        case 'missing-receipt': e.receipts = []; break;
        case 'workspace-unknown': e.workspaceSettled = false; break;
        case 'own-effects': e.ownAttemptEffects = true; break;
        case 'continuation': raw.application.decision.action.items[0].attemptKind = 'continuation'; break;
        case 'repair-payload': raw.application.decision.action.items[0].attemptPayload = { protocol: 'metawork:service-repair:v1' }; break;
        case 'wrong-owner-binding': e.dispatches[0].executionBindingFingerprint = 'other'; break;
        case 'different-grant': e.dispatches[0].resourceGrant = [{ access: 'write' }]; break;
      }
      expect(inspectApplicationPostcondition(raw).verdict).toBe('unresolved');
    });
  it('retains settled completion work across a new repository instance without incrementing retries', () => {
    const f = fixture(); const d = decision('duplicate');
    f.recovery.record({ operation: d, taskId: 'task', subtaskId: null, attemptId: null,
      errorSummary: 'original error', createdAt: conflict });
    f.recovery.resolveRecoveryItem(d.id, 'retry', conflict);
    f.recovery.settleRedundantDispatch(d.id, 'verified owner', end);
    f.recovery.settleRedundantDispatch(d.id, 'second scan', end);
    const restarted = new TaskRecoveryItemRepo(f.db);
    expect(restarted.listUnresolved()).toEqual([]);
    expect(restarted.findRecoveryItem(d.id)).toMatchObject({ applyAttempts: 2,
      errorSummary: expect.stringContaining('original error') });
    expect(restarted.listIncompleteDispatchCompletions()).toEqual(['task']);
    // A terminal conclusion still needs the durable completion boundary.
    f.db.prepare("UPDATE tasks SET status='succeeded'").run();
    expect(restarted.listIncompleteDispatchCompletions()).toEqual(['task']);
  });
});


describe('durable settled completion recovery', () => {
  it.each(['needs_action', 'succeeded'])(
    'finds the settled tag through the real repository even when Task is %s', async status => {
      const f = fixture(); const d = decision('duplicate');
      f.recovery.record({ operation: d, taskId: 'task', subtaskId: null, attemptId: null,
        errorSummary: 'owner', createdAt: conflict });
      f.recovery.settleRedundantDispatch(d.id, 'verified owner', end);
      const runtime = new ControlExecutionRuntime({
        taskRuntimeService: { findTask: () => ({ id: 'task', status, goal: 'Report' }) },
        workGraphRevisionRepo: { findActive: () => ({ generationId: 'gen', revision: 1,
          configurationRevision: 'config', authorizedOperationId: 'admission' }) },
        conversationWorktrees: { repo: { binding: () => ({ workspaceId: 'ws' }) } },
        recoveryItems: new TaskRecoveryItemRepo(f.db),
        cancellationCoordinator: { completionBlockedReasons: () => [] },
        subtaskRepo: { listByTask: () => [{ generationId: 'gen', status: 'done' }] },
      } as never);
      const complete = vi.spyOn(runtime as never, 'completeTask').mockResolvedValue(undefined as never);
      await runtime['recoverCompletedWorkspaceAnswer']('task');
      expect(complete).toHaveBeenCalledWith(expect.objectContaining({
        decisionId: 'completion_recovery:task:gen', revisionCompletion: { revision: 1, completionKind: 'full' },
      }));
      expect(f.recovery.listUnresolved()).toEqual([]);
    });
});


describe('authorized ordinary dispatch recovery owner', () => {
  it.each(['landed', 'no-progress', 'unknown', 'repair'])(
    'reevaluates only a proven safe frontier and spends budget only on its owner pass: %s', async mode => {
      const f = fixture(); const d = decision('retry');
      if (mode === 'repair') d.action.items[0]!.attemptPayload = { protocol: 'metawork:service-repair:v1' } as never;
      f.recovery.record({ operation: d, taskId: 'task', subtaskId: null, attemptId: null,
        errorSummary: 'interrupted', createdAt: conflict });
      f.recovery.resolveRecoveryItem('retry', 'retry', conflict);
      if (mode === 'unknown') f.insert(decision('competing'));
      const task = { id: 'task', status: 'running', goal: 'Report', updatedAt: start, dependencies: [] };
      const runtime = new ControlExecutionRuntime({ sessionId: 'conv', recoveryItems: f.recovery,
        taskRuntimeService: { findTask: () => task }, subtaskRepo: new SubtaskRepo(f.db),
        dispatchItemRepo: f.repo, workGraphRevisionRepo: new WorkGraphRevisionRepo(f.db),
      } as never);
      vi.spyOn(runtime as never, 'recoverCompletedWorkspaceAnswer').mockResolvedValue(false as never);
      vi.spyOn(runtime as never, 'resumeRemainingWork').mockResolvedValue(false as never);
      vi.spyOn(runtime as never, 'resumeResultContinuations').mockResolvedValue(true as never);
      vi.spyOn(runtime as never, 'recoverLocalServiceOperations').mockResolvedValue(undefined as never);
      vi.spyOn(runtime, 'prepareExecution').mockImplementation(input => ({ ...input, graphState: 'ready' }));
      vi.spyOn(runtime as never, 'applyExecutionDecisionUnchecked').mockImplementation((async () => {
        f.insert(d); return null;
      }) as never);
      const execute = vi.spyOn(runtime, 'execute').mockImplementation(async input => {
        if (mode === 'landed') await runtime['applyExecutionDecision']({ decision: d } as never);
        expect(Boolean(input.initialEvent)).toBe(mode === 'landed' || mode === 'no-progress');
        if (input.initialEvent) expect(input.initialEvent.id).toBe(d.eventId);
      });
      await runtime.recoverDue('task');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(f.recovery.findRecoveryItem('retry')).toMatchObject({
        status: mode === 'landed' ? 'assumed_applied' : 'retry_authorized',
        applyAttempts: mode === 'no-progress' ? 3 : 2,
      });
    });
});
