import { describe, expect, it } from 'vitest';
import {
  isSupersededMergeReplanApplication,
  isRetrySafeMergeRepairReplan,
  mergeReplanAssumeAppliedRecoveryEvent,
  mergeRepairReplanRecoveryEvent,
} from '../../src/execution/kernel-application-recovery.js';
import type { KernelDecisionApplicationRecord } from '../../src/kernel/kernel-workflow.js';

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
