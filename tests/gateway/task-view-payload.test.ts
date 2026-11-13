import { describe, expect, it } from 'vitest';
import { boundTaskViewPayload } from '../../src/gateway/task-view-payload.js';
import { gatewayEventPayloadBytes, MAX_GATEWAY_EVENT_PAYLOAD_BYTES } from '../../src/gateway/client-events.js';
import type { GatewayTaskViewSnapshot } from '../../src/gateway/task-view.js';

describe('bounded Task view', () => {
  it('keeps every subtask and attempt state when research progress exceeds the response budget', () => {
    const view = { taskId: 'task', turnId: 'turn', status: 'succeeded',
      state: { stateVersion: 42 }, lifecycle: { status: 'succeeded' },
      timeline: { taskId: 'task', status: 'succeeded', stages: [{ phase: 'execution', status: 'done',
        subtasks: Array.from({ length: 4 }, (_, i) => ({ id: `sub-${i}`, title: `Analysis ${i}`, status: 'done',
          attempts: [{ attemptId: `attempt-${i}`, status: 'completed', executionCompletedAt: 'now',
            progress: { history: '旧进度'.repeat(10000) },
            progressHistory: Array.from({ length: 50 }, (_, j) => ({ kind: 'skill', text: `${j} ${'搜索资料'.repeat(200)}`, occurredAt: 'now' })),
          }],
        })),
      }] },
    } as unknown as GatewayTaskViewSnapshot;
    expect(gatewayEventPayloadBytes(view)).toBeGreaterThan(MAX_GATEWAY_EVENT_PAYLOAD_BYTES);
    const bounded = boundTaskViewPayload(view);
    expect(gatewayEventPayloadBytes(bounded)).toBeLessThan(MAX_GATEWAY_EVENT_PAYLOAD_BYTES);
    expect(bounded.lifecycle).toBe(view.lifecycle);
    expect(bounded.state).toBe(view.state);
    const tasks = bounded.timeline!.stages[0]!.subtasks!;
    expect(tasks).toHaveLength(4);
    for (const [i, task] of tasks.entries()) {
      expect(task.status).toBe('done');
      expect(task.attempts[0]).toMatchObject({ attemptId: `attempt-${i}`, status: 'completed', executionCompletedAt: 'now' });
      expect(task.attempts[0]!.progressHistory).toHaveLength(1);
      expect(task.attempts[0]!.progressHistory![0]!.text).toMatch(/^49 /);
    }
    expect(view.timeline!.stages[0]!.subtasks![0]!.attempts[0]!.progressHistory).toHaveLength(50);
  });

  it('leaves a small snapshot intact', () => {
    const small = { timeline: null, status: 'running' } as GatewayTaskViewSnapshot;
    expect(boundTaskViewPayload(small)).toBe(small);
  });
});
