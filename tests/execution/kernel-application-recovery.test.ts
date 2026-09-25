import { describe, expect, it } from 'vitest';
import {
  isRetrySafeUncertainReplanScheduling,
  isSatisfiedReplanScheduling,
  isSupersededMergeReplanApplication,
  isRetrySafeMergeRepairReplan,
  mergeReplanAssumeAppliedRecoveryEvent,
  mergeRepairReplanRecoveryEvent,
} from '../../src/execution/kernel-application-recovery.js';
import type { KernelDecisionApplicationRecord } from '../../src/kernel/kernel-workflow.js';
import type {
  GenerationReplanRequestRecord,
  GenerationReplanRequestStatus,
} from '../../src/storage/generation-replan-request-repo.js';

const taskId = 'task-report';
const publicationId = 'publication-report';

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
