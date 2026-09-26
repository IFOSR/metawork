import { describe, expect, it } from 'vitest';
import {
  inspectApplicationPostcondition,
  isRetrySafeUncertainReplanScheduling,
  isSatisfiedReplanScheduling,
  isSupersededMergeReplanApplication,
  isRetrySafeMergeRepairReplan,
  mergeReplanAssumeAppliedRecoveryEvent,
  mergeRepairReplanRecoveryEvent,
  type ApplicationPostconditionFacts,
} from '../../src/execution/kernel-application-recovery.js';
import type { KernelDecisionApplicationRecord } from '../../src/kernel/kernel-workflow.js';
import type {
  GenerationReplanRequestRecord,
  GenerationReplanRequestStatus,
} from '../../src/storage/generation-replan-request-repo.js';

const taskId = 'task-report';
const publicationId = 'publication-report';

function dispatchItem(attemptId: string) {
  return {
    order: 0,
    subtaskId: 'subtask-a',
    attemptId,
    authorizedBinding: binding(),
    bindingFingerprint: 'fp',
    attemptKind: 'primary' as const,
    sourceAttemptId: null,
    recoveryMode: 'fresh' as const,
    attemptPayload: null,
    defaultResourceGrant: [],
  };
}

function binding() {
  return {
    agentClassRef: 'codex-cli',
    harnessRef: 'codex-cli',
    providerRef: 'test-provider',
    modelRef: 'test-model',
    permissionProfileRef: 'workspace-engineering',
    configurationRevision: 'revision-a',
  };
}

function application(): KernelDecisionApplicationRecord {
  return {
    id: 'application-request-merge-replan',
    decisionId: 'decision-request-merge-replan',
    eventId: 'event-request-merge-replan',
    idempotencyKey: 'decision:decision-request-merge-replan',
    status: 'uncertain',
    applyAttempts: 1,
    observationEvent: null,
    errorSummary: 'startup recovery requires the originating Conversation Planner for merge replan',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:01.000Z',
    decision: {
      schemaVersion: 5,
      configurationRevision: 'revision-a',
      id: 'decision-request-merge-replan',
      eventId: 'event-request-merge-replan',
      reason: 'three merge repairs failed; one conflict replan is authorized',
      action: {
        type: 'request_merge_replan',
        taskId,
        subtaskId: 'subtask-report',
        publicationId,
        conflictChainId: 'conflict-report',
      },
    },
  };
}

describe('merge repair application recovery', () => {
  it('retries an uncertain merge replan only after a proven pre-executor repair preparation failure', () => {
    const item = application();
    expect(isRetrySafeMergeRepairReplan({
      taskId,
      application: item,
      publication: {
        id: publicationId,
        taskId,
        status: 'parked',
      },
      dispatchItems: [{
        attemptKind: 'merge_repair',
        status: 'terminal',
        attemptPayload: {
          protocol: 'metaclaw:merge-repair:v1',
          publicationId,
          conflictChainId: 'conflict-report',
          conflictingPaths: ['index.html'],
        },
        errorSummary: "EACCES: permission denied, open '/workspace/.metaclaw/merge-repair/index.html.base'",
      }],
    })).toBe(true);

    expect(mergeRepairReplanRecoveryEvent({
      taskId,
      application: item,
      sessionId: 'conversation-a',
      occurredAt: '2026-08-25T00:01:00.000Z',
    })).toMatchObject({
      type: 'recovery_resolution_requested',
      recoveryItemId: item.id,
      resolution: 'retry',
      taskId,
    });
  });

  it('does not retry ordinary semantic merge-repair failures automatically', () => {
    expect(isRetrySafeMergeRepairReplan({
      taskId,
      application: application(),
      publication: {
        id: publicationId,
        taskId,
        status: 'parked',
      },
      dispatchItems: [{
        attemptKind: 'merge_repair',
        status: 'terminal',
        attemptPayload: {
          protocol: 'metaclaw:merge-repair:v1',
          publicationId,
          conflictChainId: 'conflict-report',
          conflictingPaths: ['index.html'],
        },
        errorSummary: 'merge repair trailer protocol is invalid',
      }],
    })).toBe(false);
  });

  it('assumes an uncertain merge replan was superseded only after its publication integrated', () => {
    const item = application();
    expect(isSupersededMergeReplanApplication({
      taskId,
      application: item,
      publication: {
        id: publicationId,
        taskId,
        subtaskId: 'subtask-report',
        status: 'integrated',
      },
      subtask: {
        id: 'subtask-report',
        taskId,
        status: 'done',
      },
    })).toBe(true);
    expect(mergeReplanAssumeAppliedRecoveryEvent({
      taskId,
      application: item,
      sessionId: 'conversation-a',
      occurredAt: '2026-08-25T00:02:00.000Z',
    })).toMatchObject({
      type: 'recovery_resolution_requested',
      recoveryItemId: item.id,
      resolution: 'assume_applied',
    });
  });
});

describe('durable replan scheduling recovery', () => {
  function replanApplication(
    action: { type: 'schedule_replan'; taskId: string; generationId: string; sourceRevision: number; replanJobId: string }
      | { type: 'request_replan'; taskId: string; generationId: string; sourceRevision: number },
    decisionId: string,
  ): KernelDecisionApplicationRecord {
    return {
      id: `application-${decisionId}`,
      decisionId,
      eventId: `event-${decisionId}`,
      idempotencyKey: `decision:${decisionId}`,
      status: 'uncertain',
      applyAttempts: 1,
      observationEvent: null,
      errorSummary: 'process exit during apply',
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:01.000Z',
      decision: {
        schemaVersion: 5,
        configurationRevision: 'revision-a',
        id: decisionId,
        eventId: `event-${decisionId}`,
        reason: 'generation quiescence token accepted',
        action,
      },
    };
  }

  function replanRequest(
    status: GenerationReplanRequestStatus,
    overrides: Partial<GenerationReplanRequestRecord> = {},
  ): GenerationReplanRequestRecord {
    return {
      id: 'generation_replan_job_1',
      taskId,
      generationId: 'generation_task-report_1',
      sourceRevision: 1,
      configurationRevision: 'revision-a',
      status,
      triggerDecisionId: 'trigger_queue_replan',
      quiescenceToken: 'quiescence_decision-schedule-replan',
      errorSummary: null,
      deferredPlan: null,
      deferredBindings: [],
      availabilityExplanation: null,
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:01.000Z',
      ...overrides,
    };
  }

  it('is satisfied once the Job carries this exact Decision quiescence token', () => {
    const application = replanApplication({
      type: 'schedule_replan',
      taskId,
      generationId: 'generation_task-report_1',
      sourceRevision: 1,
      replanJobId: 'generation_replan_job_1',
    }, 'decision-schedule-replan');
    for (const status of ['planning', 'submitted', 'waiting_for_availability', 'resolved', 'failed'] as const) {
      expect(isSatisfiedReplanScheduling({
        application,
        replanRequest: replanRequest(status),
      }), status).toBe(true);
    }
  });

  it('is not satisfied when the token, Job id or Task does not match', () => {
    const application = replanApplication({
      type: 'schedule_replan',
      taskId,
      generationId: 'generation_task-report_1',
      sourceRevision: 1,
      replanJobId: 'generation_replan_job_1',
    }, 'decision-schedule-replan');
    expect(isSatisfiedReplanScheduling({
      application,
      replanRequest: replanRequest('planning', { quiescenceToken: 'quiescence_other' }),
    })).toBe(false);
    expect(isSatisfiedReplanScheduling({
      application,
      replanRequest: replanRequest('planning', { id: 'generation_replan_job_2' }),
    })).toBe(false);
    expect(isSatisfiedReplanScheduling({
      application,
      replanRequest: replanRequest('planning', { taskId: 'other-task' }),
    })).toBe(false);
    expect(isSatisfiedReplanScheduling({ application, replanRequest: undefined as never }))
      .toBe(false);
  });

  it('retries only a Job that is still waiting for quiescence', () => {
    const application = replanApplication({
      type: 'request_replan',
      taskId,
      generationId: 'generation_task-report_1',
      sourceRevision: 1,
    }, 'decision-schedule-replan');
    expect(isRetrySafeUncertainReplanScheduling({
      application,
      replanRequest: replanRequest('pending_quiescence', { quiescenceToken: null }),
    })).toBe(true);
    expect(isRetrySafeUncertainReplanScheduling({
      application,
      replanRequest: replanRequest('planning'),
    })).toBe(false);
  });
});

describe('application postcondition inspection', () => {
  function app(
    action: KernelDecisionApplicationRecord['decision']['action'],
    decisionId = 'decision-1',
    applyAttempts = 1,
  ): KernelDecisionApplicationRecord {
    return {
      id: `application-${decisionId}`,
      decisionId,
      eventId: `event-${decisionId}`,
      idempotencyKey: `decision:${decisionId}`,
      status: 'uncertain',
      applyAttempts,
      observationEvent: null,
      errorSummary: 'process exit during apply',
      createdAt: '2026-09-25T00:00:00.000Z',
      updatedAt: '2026-09-25T00:00:01.000Z',
      decision: {
        schemaVersion: 5,
        configurationRevision: 'revision-a',
        id: decisionId,
        eventId: `event-${decisionId}`,
        reason: 'fixture',
        action,
      },
    };
  }

  function facts(
    overrides: Partial<ApplicationPostconditionFacts> = {},
  ): ApplicationPostconditionFacts {
    return {
      application: app({ type: 'no_op' }),
      task: { id: taskId, status: 'running' },
      subtasks: [],
      dispatchItems: [],
      workGraphRevision: null,
      replanRequest: null,
      ...overrides,
    };
  }

  it('requires every authorized dispatch item with the same Decision id', () => {
    const action = {
      type: 'dispatch_batch' as const,
      taskId,
      items: [dispatchItem('attempt-1'), dispatchItem('attempt-2')],
    };
    const application = app(action);
    expect(inspectApplicationPostcondition(facts({ application }))).toMatchObject({
      family: 'dispatch',
      verdict: 'retry_safe',
    });
    expect(inspectApplicationPostcondition(facts({
      application,
      dispatchItems: [{ attemptId: 'attempt-1', decisionId: 'decision-1', subtaskId: 'subtask-a', status: 'running' }],
    }))).toMatchObject({ family: 'dispatch', verdict: 'unresolved' });
    expect(inspectApplicationPostcondition(facts({
      application,
      dispatchItems: [
        { attemptId: 'attempt-1', decisionId: 'decision-1', subtaskId: 'subtask-a', status: 'running' },
        { attemptId: 'attempt-2', decisionId: 'decision-1', subtaskId: 'subtask-b', status: 'pending_launch' },
      ],
    }))).toMatchObject({ family: 'dispatch', verdict: 'applied' });
    expect(inspectApplicationPostcondition(facts({
      application,
      dispatchItems: [
        { attemptId: 'attempt-1', decisionId: 'other-decision', subtaskId: 'subtask-a', status: 'running' },
      ],
    }))).toMatchObject({ family: 'dispatch', verdict: 'retry_safe' });
  });

  it('reads the durable Task transition for block and complete', () => {
    const complete = app({ type: 'complete_task', taskId });
    expect(inspectApplicationPostcondition(facts({
      application: complete,
      task: { id: taskId, status: 'done' },
    }))).toMatchObject({ family: 'task_transition', verdict: 'applied' });
    expect(inspectApplicationPostcondition(facts({ application: complete })))
      .toMatchObject({ family: 'task_transition', verdict: 'retry_safe' });

    const block = app({ type: 'block_work', taskId, subtaskId: 'subtask-a' });
    expect(inspectApplicationPostcondition(facts({
      application: block,
      task: { id: taskId, status: 'blocked' },
      subtasks: [{ id: 'subtask-a', status: 'blocked' }],
    }))).toMatchObject({ family: 'task_transition', verdict: 'applied' });
    // The Runtime writes the Subtask blocker before the Task block, so a
    // half-applied decision must not be mistaken for success.
    expect(inspectApplicationPostcondition(facts({
      application: block,
      task: { id: taskId, status: 'running' },
      subtasks: [{ id: 'subtask-a', status: 'blocked' }],
    }))).toMatchObject({ family: 'task_transition', verdict: 'retry_safe' });
    expect(inspectApplicationPostcondition(facts({
      application: block,
      task: { id: taskId, status: 'blocked' },
      subtasks: [{ id: 'subtask-a', status: 'awaiting_decision' }],
    }))).toMatchObject({ family: 'task_transition', verdict: 'retry_safe' });
    // A Task-level block with no named Subtask is complete on its own.
    const taskWideBlock = app({ type: 'block_work', taskId, subtaskId: null });
    expect(inspectApplicationPostcondition(facts({
      application: taskWideBlock,
      task: { id: taskId, status: 'blocked' },
    }))).toMatchObject({ family: 'task_transition', verdict: 'applied' });
  });

  it('requires the resume observation before treating resume_task as applied', () => {
    const application = app({
      type: 'resume_task',
      taskId,
      generationId: 'generation-1',
      graphRevision: 1,
      subtaskIds: ['subtask-a'],
      blockerCategory: 'manual',
    });
    expect(inspectApplicationPostcondition(facts({
      application,
      task: { id: taskId, status: 'running' },
      subtasks: [{ id: 'subtask-a', status: 'ready' }],
    }))).toMatchObject({ family: 'observation_only', verdict: 'retry_safe' });
    expect(inspectApplicationPostcondition(facts({
      application,
      task: { id: taskId, status: 'running' },
      subtasks: [{ id: 'subtask-a', status: 'ready' }],
      dispatchItems: [{
        attemptId: 'attempt-1',
        decisionId: 'decision-1',
        subtaskId: 'subtask-a',
        status: 'running',
      }],
    }))).toMatchObject({ family: 'observation_only', verdict: 'applied' });
    expect(inspectApplicationPostcondition(facts({
      application,
      task: { id: taskId, status: 'running' },
      subtasks: [{ id: 'subtask-a', status: 'blocked' }],
    }))).toMatchObject({ family: 'observation_only', verdict: 'retry_safe' });
  });

  it('accepts a durable graph revision as plan activation', () => {
    const application = app({
      type: 'authorize_task_plan',
      taskId,
      task: { binding: 'reference', taskId, control: 'none', scope: null, title: null, goal: null, includeRecentConversationContext: false, priority: null },
      workGraph: { schemaVersion: 7, configurationRevision: 'revision-a', reason: 'fixture', subtasks: [] },
      authorizedBindingsBySubtask: {},
      generationId: 'generation-1',
      graphRevision: 2,
      proposalSource: 'replan',
    });
    expect(inspectApplicationPostcondition(facts({
      application,
      workGraphRevision: { revision: 2, generationId: 'generation-1', authorizedDecisionId: 'decision-1' },
    }))).toMatchObject({ family: 'plan_activation', verdict: 'applied' });
    // A replan revision cannot be re-applied blindly.
    expect(inspectApplicationPostcondition(facts({ application })))
      .toMatchObject({ family: 'plan_activation', verdict: 'unresolved' });
  });

  it('leaves dedicated reconciler families untouched', () => {
    for (const action of [
      { type: 'cancel_task' as const, taskId, generationId: 'generation-1' },
      { type: 'request_merge_replan' as const, taskId, subtaskId: 'subtask-a', publicationId: 'pub-1', conflictChainId: 'chain-1' },
      { type: 'deliver_direct_reply' as const, response: 'hi', taskId: null },
    ]) {
      expect(inspectApplicationPostcondition(facts({ application: app(action) })))
        .toMatchObject({ verdict: 'not_managed' });
    }
  });

  it('declares observation-only actions retry-safe and unknown actions unresolved', () => {
    expect(inspectApplicationPostcondition(facts({
      application: app({ type: 'wait_for_retry', taskId, subtaskId: 'subtask-a', resumeAt: '2026-09-25T00:10:00.000Z', authorizedBinding: binding(), bindingFingerprint: 'fp' }),
    }))).toMatchObject({ family: 'observation_only', verdict: 'retry_safe' });
    expect(inspectApplicationPostcondition(facts({
      application: app({ type: 'recover_workspace_attempt', taskId, subtaskId: 'subtask-a', workspaceId: 'ws', checkpointId: null, lostAttemptId: 'attempt-1', attemptKind: 'primary', recoveryMode: 'fresh', defaultResourceGrant: [] }),
    }))).toMatchObject({ verdict: 'not_managed' });
  });
});
