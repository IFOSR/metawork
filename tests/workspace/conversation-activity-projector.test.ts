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
  });
}

describe('ConversationActivityProjector', () => {
  it('projects an active Planner turn as planning', () => {
    const activity = projector({
      plannerTurns: [{ conversationId: 'conv_alpha', updatedAt: NOW }],
    }).project('conv_alpha', '2026-08-27T07:00:00.000Z');

    expect(activity).toEqual({ state: 'planning', taskId: null, updatedAt: NOW });
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

    expect(activity).toEqual({ state: 'executing', taskId: 'task_execute', updatedAt: NOW });
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

    expect(activity).toEqual({ state: 'waiting', taskId: 'task_wait', updatedAt: NOW });
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
    });

    expect(projection.project('conv_origin', NOW).state).toBe('executing');
    expect(projection.project('conv_other', NOW).state).toBe('idle');
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
    };

    expect(projector(facts).project('conv_alpha', NOW))
      .toEqual(projector(structuredClone(facts)).project('conv_alpha', NOW));
  });
});
