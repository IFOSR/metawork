import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { AuthorizedExecutorBinding } from '../../src/core/authorized-executor-binding.js';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import type { KernelDecision, KernelEvent } from '../../src/kernel/control-kernel.js';
import { KernelWorkflowRepo } from '../../src/storage/kernel-workflow-repo.js';
import { runMigrations } from '../../src/storage/migrations.js';

const NOW = '2026-08-13T00:00:00.000Z';
const AGENT_CLASS = 'codex-engineering';

describe('KernelExecutionRuntime executor recovery', () => {
  it('resolves only waiting requests pinned to the recovered configuration revision', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    insertConfigurationRevision(db, 'revision-a');
    insertConfigurationRevision(db, 'revision-b');

    const requests = [
      waitingRequest('request-a', 'task-a', 'revision-a'),
      waitingRequest('request-b', 'task-b', 'revision-b'),
    ];
    const resolve = vi.fn();
    const apply = vi.fn().mockReturnValue({
      outcome: 'applied',
      workGraph: requests[0]!.deferredPlan!.proposal.workGraph,
      subtasks: [],
    });
    const unblockTask = vi.fn();
    const runtime = new KernelExecutionRuntime({
      sessionId: 'session-recovery',
      generationReplanRepo: {
        listWaitingForAvailability: vi.fn().mockReturnValue(requests),
        find: vi.fn((id: string) => requests.find(request => request.id === id) ?? null),
        resolve,
      },
      taskRuntimeService: {
        findTask: vi.fn((taskId: string) => ({
          id: taskId,
          title: taskId,
          goal: `Recover ${taskId}`,
          status: 'blocked',
        })),
        unblockTask,
      },
      workGraphRevisionRepo: {
        findActive: vi.fn((taskId: string) => ({
          id: `active-${taskId}`,
          taskId,
          revision: 1,
          generationId: `generation-${taskId}`,
          configurationRevision: taskId === 'task-a' ? 'revision-a' : 'revision-b',
          authorizedDecisionId: 'decision-initial',
          proposalSource: 'initial',
          automaticReplan: false,
          status: 'active',
          completionKind: null,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      },
      kernelExecutorStatusProjector: {
        list: vi.fn().mockReturnValue([]),
      },
      controlKernel: {
        decide: vi.fn((event: KernelEvent): KernelDecision => {
          const request = requests.find(item => item.id === event.correlationId)!;
          const subtask = request.deferredPlan!.proposal.workGraph!.subtasks[0]!;
          return {
            schemaVersion: 5,
            configurationRevision: request.configurationRevision,
            id: `decision-${event.id}`,
            eventId: event.id,
            reason: 'matching revision recovered',
            action: {
              type: 'activate_deferred_task_plan',
              taskId: request.taskId,
              replanRequestId: request.id,
              task: request.deferredPlan!.proposal.task!,
              workGraph: request.deferredPlan!.proposal.workGraph!,
              authorizedBindingsBySubtask: {
                [subtask.id]: request.deferredBindings,
              },
              generationId: request.generationId,
              graphRevision: 2,
              proposalSource: 'replan',
            },
          };
        }),
      },
      kernelWorkflowStore: new KernelWorkflowRepo(db),
      workGraphRuntimeService: { apply },
      callbacks: { refreshRuntimeState: vi.fn() },
      taskEventRepo: {},
      dispatchItemRepo: {},
      maxConcurrentAttempts: 4,
    } as never);

    await runtime.executorRecovered(AGENT_CLASS, 'revision-a', 'check-a');

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('request-a', expect.any(String));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ id: 'task-a' }),
      authorizedBindingsBySubtask: {
        'subtask-task-a': [binding('revision-a')],
      },
    }));
    expect(unblockTask).toHaveBeenCalledWith('task-a');
    expect(unblockTask).not.toHaveBeenCalledWith('task-b');

    const persistedEvents = db.prepare(`
      SELECT correlation_id, configuration_revision
      FROM kernel_events
      WHERE event_type = 'executor_recovered'
      ORDER BY correlation_id
    `).all();
    expect(persistedEvents).toEqual([{
      correlation_id: 'request-a',
      configuration_revision: 'revision-a',
    }]);
  });
});

function waitingRequest(id: string, taskId: string, configurationRevision: string) {
  const authorizedBinding = binding(configurationRevision);
  return {
    id,
    taskId,
    generationId: `generation-${taskId}`,
    sourceRevision: 1,
    configurationRevision,
    status: 'waiting_for_availability' as const,
    triggerDecisionId: `trigger-${id}`,
    quiescenceToken: `quiescence-${id}`,
    errorSummary: null,
    deferredPlan: {
      schemaVersion: 5 as const,
      configurationRevision,
      type: 'plan_proposed' as const,
      id: `plan-${id}`,
      correlationId: id,
      causationId: id,
      occurredAt: NOW,
      sessionId: 'session-recovery',
      taskId,
      requestText: `Recover ${taskId}`,
      generationId: `generation-${taskId}`,
      proposalSource: 'replan' as const,
      targetGraphRevision: 2,
      proposal: {
        task: {
          title: taskId,
          goal: `Recover ${taskId}`,
        },
        workGraph: {
          schemaVersion: 7 as const,
          configurationRevision,
          reason: 'recovery test',
          subtasks: [{
            id: `subtask-${taskId}`,
            title: 'Execute',
            goal: 'Execute recovered work',
            dependencies: [],
            contextRefs: [],
            requiredCapabilities: ['workspace-engineering'],
            executorBindings: [{ agentClassRef: AGENT_CLASS }],
            deliveryKind: 'report' as const,
            acceptance: [],
            riskLevel: 'low' as const,
          }],
        },
      },
    },
    deferredBindings: [authorizedBinding],
    availabilityExplanation: 'waiting for executor recovery',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function binding(configurationRevision: string): AuthorizedExecutorBinding {
  return {
    agentClassRef: AGENT_CLASS,
    harnessRef: 'codex-cli',
    providerRef: 'openai',
    modelRef: 'engineering-model',
    permissionProfileRef: 'workspace-default',
    configurationRevision,
  };
}

function insertConfigurationRevision(db: Database.Database, revisionId: string): void {
  db.prepare(`
    INSERT INTO configuration_revisions (
      revision_id, content_hash, source_kind, imported_at
    ) VALUES (?, ?, 'native', ?)
  `).run(revisionId, `sha256:${revisionId}`, NOW);
}
