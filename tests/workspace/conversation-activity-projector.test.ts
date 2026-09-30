import { describe, expect, it } from 'vitest';
import {
  ConversationActivityProjector,
  type ConversationActivityFacts,
} from '../../src/workspace/conversation-activity-projector.js';

const NOW = '2026-08-27T08:00:00.000Z';

function projector(facts: Partial<ConversationActivityFacts> = {}) {
  return new ConversationActivityProjector({
    plannerTurns: facts.plannerTurns ?? [],
    tasks: facts.tasks ?? [],
    activeAttemptTaskIds: facts.activeAttemptTaskIds ?? [],
    activeAttemptUpdatedAt: facts.activeAttemptUpdatedAt ?? [],
    openReplanJobTaskIds: facts.openReplanJobTaskIds ?? [],
    pendingRetryWakeTaskIds: facts.pendingRetryWakeTaskIds ?? [],
  });
}

describe('ConversationActivityProjector', () => {
  it.each(['created', 'ready'] as const)('projects %s work without dependency blockers as queued', status => {
    expect(projector({
      tasks: [{
        id: 'queued_task', originConversationId: 'conv_alpha', status,
        dependencies: [], updatedAt: NOW,
      }],
    }).project('conv_alpha', NOW)).toEqual({
      state: 'queued', taskId: 'queued_task', updatedAt: NOW, latestTaskCreatedAt: NOW,
    });
  });

  it('projects an active Planner turn as planning', () => {
    const activity = projector({
      plannerTurns: [{ conversationId: 'conv_alpha', updatedAt: NOW }],
    }).project('conv_alpha', '2026-08-27T07:00:00.000Z');

    expect(activity).toEqual({
      state: 'planning', taskId: null, updatedAt: NOW,
      latestTaskCreatedAt: '2026-08-27T07:00:00.000Z',
    });
  });

  it('projects an active task or attempt as executing', () => {
    const activity = projector({
      tasks: [{
        id: 'task_execute',
        originConversationId: 'conv_alpha',
        status: 'running',
        dependencies: [],
        updatedAt: NOW,
      }],
      activeAttemptTaskIds: ['task_execute'],
    }).project('conv_alpha', '2026-08-27T07:00:00.000Z');

    expect(activity).toEqual({
      state: 'executing', taskId: 'task_execute', updatedAt: NOW,
      latestTaskCreatedAt: '2026-08-27T07:00:00.000Z',
    });
  });

  it('uses the latest active Attempt heartbeat for the activity timestamp', () => {
    const activity = projector({
      tasks: [{
        id: 'task_execute',
        originConversationId: 'conv_alpha',
        status: 'running',
        dependencies: [],
        updatedAt: '2026-08-27T08:00:00.000Z',
      }],
      activeAttemptTaskIds: ['task_execute'],
      activeAttemptUpdatedAt: [{
        taskId: 'task_execute',
        updatedAt: '2026-08-27T08:30:00.000Z',
      }],
    }).project('conv_alpha', NOW);

    expect(activity).toMatchObject({
      state: 'executing',
      taskId: 'task_execute',
      updatedAt: '2026-08-27T08:30:00.000Z',
    });
  });

  it('keeps the newest Task creation time independent from Task progress updates', () => {
    const activity = projector({
      tasks: [
        {
          id: 'task_old',
          originConversationId: 'conv_alpha',
          status: 'done',
          dependencies: [],
          createdAt: '2026-09-29T10:00:00.000Z',
          updatedAt: '2026-09-30T12:00:00.000Z',
        },
        {
          id: 'task_new',
          originConversationId: 'conv_alpha',
          status: 'running',
          dependencies: [],
          createdAt: '2026-09-30T11:00:00.000Z',
          updatedAt: '2026-09-30T11:01:00.000Z',
        },
      ],
      activeAttemptTaskIds: ['task_new'],
    }).project('conv_alpha', '2026-09-01T00:00:00.000Z');

    expect(activity.latestTaskCreatedAt).toBe('2026-09-30T11:00:00.000Z');
  });

  it('projects Kernel retry or capacity waits as waiting', () => {
    const activity = projector({
      tasks: [{
        id: 'task_wait',
        originConversationId: 'conv_alpha',
        status: 'parked',
        dependencies: [{ type: 'kernel_retry', status: 'waiting' }],
        updatedAt: NOW,
      }],
    }).project('conv_alpha', '2026-08-27T07:00:00.000Z');

    expect(activity).toEqual({
      state: 'waiting', taskId: 'task_wait', updatedAt: NOW,
      latestTaskCreatedAt: '2026-08-27T07:00:00.000Z',
    });
  });

  it('gives blocked precedence over executing, waiting and planning', () => {
    const activity = projector({
      plannerTurns: [{ conversationId: 'conv_alpha', updatedAt: NOW }],
      tasks: [
        {
          id: 'task_execute',
          originConversationId: 'conv_alpha',
          status: 'running',
          dependencies: [],
          updatedAt: '2026-08-27T08:01:00.000Z',
        },
        {
          id: 'task_blocked',
          originConversationId: 'conv_alpha',
          status: 'blocked',
          dependencies: [],
          updatedAt: '2026-08-27T08:02:00.000Z',
        },
      ],
    }).project('conv_alpha', '2026-08-27T07:00:00.000Z');

    expect(activity).toEqual({
      state: 'blocked',
      taskId: 'task_blocked',
      updatedAt: '2026-08-27T08:02:00.000Z',
      latestTaskCreatedAt: '2026-08-27T07:00:00.000Z',
    });
  });

  it('projects terminal or absent work as idle', () => {
    const activity = projector({
      tasks: [{
        id: 'task_done',
        originConversationId: 'conv_alpha',
        status: 'done',
        dependencies: [],
        updatedAt: NOW,
      }],
    }).project('conv_alpha', '2026-08-27T07:00:00.000Z');

    expect(activity).toEqual({
      state: 'idle',
      taskId: null,
      updatedAt: '2026-08-27T07:00:00.000Z',
      latestTaskCreatedAt: '2026-08-27T07:00:00.000Z',
    });
  });

  it('attributes activity only to the Task origin Conversation', () => {
    const projection = projector({
      tasks: [{
        id: 'task_execute',
        originConversationId: 'conv_origin',
        status: 'running',
        dependencies: [],
        updatedAt: NOW,
      }],
      activeAttemptTaskIds: ['task_execute'],
    });

    expect(projection.project('conv_origin', NOW).state).toBe('executing');
    expect(projection.project('conv_other', NOW).state).toBe('idle');
  });

  it('never reports a running Task without an active Attempt as executing', () => {
    const projection = projector({
      tasks: [{
        id: 'task_waiting_plan',
        originConversationId: 'conv_alpha',
        status: 'running',
        dependencies: [],
        updatedAt: NOW,
      }],
    });

    expect(projection.project('conv_alpha', NOW).state).toBe('waiting');
  });

  it('reports an outstanding Replan Job as waiting, not idle', () => {
    // The exact case the review reproduced: TaskView said waiting_for_plan while
    // the activity card said idle because it assumed the fact away.
    const projection = projector({
      tasks: [{
        id: 'task_waiting_plan',
        originConversationId: 'conv_alpha',
        status: 'running',
        dependencies: [],
        updatedAt: NOW,
      }],
      openReplanJobTaskIds: ['task_waiting_plan'],
    });

    expect(projection.project('conv_alpha', NOW)).toEqual({
      state: 'waiting',
      taskId: 'task_waiting_plan',
      updatedAt: NOW,
      latestTaskCreatedAt: NOW,
    });
  });

  it('reports a persisted running Task with only a retry wake as waiting', () => {
    const projection = projector({
      tasks: [{
        id: 'task_retry',
        originConversationId: 'conv_alpha',
        status: 'running',
        dependencies: [],
        updatedAt: NOW,
      }],
      pendingRetryWakeTaskIds: ['task_retry'],
    });

    expect(projection.project('conv_alpha', NOW).state).toBe('waiting');
  });

  it('bounds taskId and normalizes updatedAt', () => {
    const activity = projector({
      tasks: [{
        id: `task_${'x'.repeat(500)}`,
        originConversationId: 'conv_alpha',
        status: 'blocked',
        dependencies: [],
        updatedAt: 'not-a-date',
      }],
    }).project('conv_alpha', NOW);

    expect(activity.taskId).toHaveLength(160);
    expect(activity.updatedAt).toBe(NOW);
  });

  it('rebuilds the same activity from durable facts after restart', () => {
    const facts: ConversationActivityFacts = {
      plannerTurns: [],
      tasks: [{
        id: 'task_recovered',
        originConversationId: 'conv_alpha',
        status: 'blocked',
        dependencies: [],
        updatedAt: NOW,
      }],
      activeAttemptTaskIds: [],
      openReplanJobTaskIds: [],
      pendingRetryWakeTaskIds: [],
    };

    expect(projector(facts).project('conv_alpha', NOW))
      .toEqual(projector(structuredClone(facts)).project('conv_alpha', NOW));
  });
});
