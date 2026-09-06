import { describe, expect, it } from 'vitest';
import type { InteractionTraceEvent } from '../../src/management/interaction-trace.js';
import { buildTaskStatusLines } from '../../src/session/task-status-snapshot.js';

let sequence = 0;
function traceEvent(input: {
  kind: string;
  title?: string;
  summary?: string;
  subtaskId?: string | null;
  occurredAt?: string;
}): InteractionTraceEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    sequence,
    occurredAt: input.occurredAt ?? '2026-09-05T01:00:00.000Z',
    phase: 'execution',
    actor: 'executor',
    kind: input.kind,
    status: 'running',
    title: input.title ?? '',
    summary: input.summary ?? '',
    details: {},
    taskId: 'task-1',
    subtaskId: input.subtaskId ?? null,
  };
}

describe('buildTaskStatusLines', () => {
  it('reports idle when no task is running', () => {
    const lines = buildTaskStatusLines({
      taskTitle: null,
      taskStatus: null,
      startedAt: null,
      traceEvents: [],
      nowMs: Date.parse('2026-09-05T01:10:00.000Z'),
    });
    expect(lines.join('\n')).toContain('当前没有正在执行的任务');
  });

  it('summarizes task, elapsed, current subtask/step, step count and heartbeat', () => {
    const lines = buildTaskStatusLines({
      taskTitle: '视频号调研',
      taskStatus: 'running',
      startedAt: '2026-09-05T00:30:00.000Z',
      traceEvents: [
        traceEvent({ kind: 'subtask_execution_started', title: 'Executing Subtask: 收集数据', subtaskId: 's1' }),
        traceEvent({ kind: 'executor_progress', summary: 'Executor started tool: web_search — 视频号' }),
        traceEvent({ kind: 'executor_progress', summary: 'Executor completed tool: web_search — 视频号' }),
      ],
      nowMs: Date.parse('2026-09-05T01:00:10.000Z'),
    });
    const text = lines.join('\n');
    expect(text).toContain('视频号调研');
    expect(text).toContain('30');
    expect(text).toContain('收集数据');
    expect(text).toContain('web_search');
    expect(text).toContain('2');
    expect(text).toMatch(/活跃/);
  });

  it('surfaces recovery state when the executor lost its heartbeat', () => {
    const lines = buildTaskStatusLines({
      taskTitle: '视频号调研',
      taskStatus: 'running',
      startedAt: '2026-09-05T00:30:00.000Z',
      traceEvents: [
        traceEvent({ kind: 'executor_progress', summary: 'working' }),
        traceEvent({ kind: 'kernel_decision', title: 'heartbeat_lost: retry scheduled' }),
      ],
      nowMs: Date.parse('2026-09-05T01:00:10.000Z'),
    });
    const text = lines.join('\n');
    expect(text).toContain('heartbeat_lost');
    expect(text).toMatch(/失联|恢复/);
  });

  it('shows stale heartbeat warning when activity is older than the active window', () => {
    const lines = buildTaskStatusLines({
      taskTitle: '视频号调研',
      taskStatus: 'running',
      startedAt: '2026-09-05T00:30:00.000Z',
      traceEvents: [
        traceEvent({ kind: 'executor_progress', summary: 'working', occurredAt: '2026-09-05T00:59:00.000Z' }),
      ],
      nowMs: Date.parse('2026-09-05T01:00:00.000Z'),
    });
    expect(lines.join('\n')).toMatch(/无新活动/);
  });
});
