import { describe, expect, it } from 'vitest';
import type { InteractionTraceEvent } from '../../src/management/interaction-trace.js';
import { createTaskActivityTracker } from '../../src/gateway/task-activity-tracker.js';

let sequence = 0;
function traceEvent(input: {
  kind: string;
  title?: string;
  summary?: string;
  phase?: InteractionTraceEvent['phase'];
  actor?: InteractionTraceEvent['actor'];
  status?: InteractionTraceEvent['status'];
  subtaskId?: string | null;
  taskId?: string | null;
  occurredAt?: string;
  details?: Record<string, unknown>;
}): InteractionTraceEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    sequence,
    occurredAt: input.occurredAt ?? '2026-09-05T01:00:00.000Z',
    phase: input.phase ?? 'execution',
    actor: input.actor ?? 'executor',
    kind: input.kind,
    status: input.status ?? 'running',
    title: input.title ?? '',
    summary: input.summary ?? '',
    details: input.details ?? {},
    taskId: input.taskId ?? 'task-1',
    subtaskId: input.subtaskId ?? null,
  };
}

describe('task-activity-tracker', () => {
  it('tracks the current subtask from subtask_execution_started', () => {
    const tracker = createTaskActivityTracker();
    tracker.consume(traceEvent({
      kind: 'subtask_execution_started',
      title: 'Executing Subtask: 收集视频号数据',
      summary: 'goal…',
      subtaskId: 'sub-1',
    }));
    const snapshot = tracker.snapshot();
    expect(snapshot.currentSubtask).toBe('收集视频号数据');
    expect(snapshot.taskId).toBe('task-1');
  });

  it('counts executor steps and keeps the latest step digest', () => {
    const tracker = createTaskActivityTracker();
    tracker.consume(traceEvent({ kind: 'executor_progress', title: 'Executor progress: skill', summary: 'Executor started tool: web_search — 视频号' }));
    tracker.consume(traceEvent({ kind: 'executor_progress', title: 'Executor progress: skill', summary: 'Executor completed tool: web_search — 视频号' }));
    const snapshot = tracker.snapshot();
    expect(snapshot.stepCount).toBe(2);
    expect(snapshot.currentStep).toContain('web_search');
    expect(snapshot.recentSteps).toHaveLength(2);
  });

  it('caps recent steps to the newest entries', () => {
    const tracker = createTaskActivityTracker({ recentStepsLimit: 3 });
    for (let index = 0; index < 5; index += 1) {
      tracker.consume(traceEvent({ kind: 'executor_progress', summary: `step ${index}` }));
    }
    const steps = tracker.snapshot().recentSteps;
    expect(steps).toHaveLength(3);
    expect(steps[0]!.text).toContain('step 2');
    expect(steps[2]!.text).toContain('step 4');
  });

  it('flags milestones for immediate delivery and keeps non-milestones quiet', () => {
    const tracker = createTaskActivityTracker();
    expect(tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'tool noise' })).milestone).toBeNull();
    expect(tracker.consume(traceEvent({ kind: 'executor_heartbeat', summary: 'still running' })).milestone).toBeNull();

    const started = tracker.consume(traceEvent({ kind: 'subtask_execution_started', title: 'Executing Subtask: A', subtaskId: 's1' }));
    expect(started.milestone?.text).toContain('Executing Subtask: A');

    const observed = tracker.consume(traceEvent({ kind: 'executor_result_observed', title: 'Result observed' }));
    expect(observed.milestone).not.toBeNull();

    const published = tracker.consume(traceEvent({ kind: 'publication_integrated', title: 'Publication integrated' }));
    expect(published.milestone).not.toBeNull();

    const blocked = tracker.consume(traceEvent({ kind: 'execution_blocked', title: 'Execution blocked', status: 'blocked' }));
    expect(blocked.milestone).not.toBeNull();
  });

  it('dedupes milestone pushes per subtask/kind key', () => {
    const tracker = createTaskActivityTracker();
    const event = traceEvent({ kind: 'subtask_execution_started', title: 'Executing Subtask: A', subtaskId: 's1' });
    expect(tracker.consume(event).milestone).not.toBeNull();
    expect(tracker.consume({ ...event, id: 'evt-dup', sequence: 99 }).milestone).toBeNull();
  });

  it('reports heartbeat health from activity age', () => {
    const t0 = Date.parse('2026-09-05T01:00:00.000Z');
    const tracker = createTaskActivityTracker({ nowMs: () => t0 });
    expect(tracker.health(t0)).toBe('unknown');

    tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'working', occurredAt: '2026-09-05T01:00:00.000Z' }));
    expect(tracker.health(t0 + 5_000)).toBe('active');
    expect(tracker.health(t0 + 45_000)).toBe('stale');
    expect(tracker.health(t0 + 180_000)).toBe('lost');
  });

  it('treats heartbeat_lost and recovery kinds as lost until new activity arrives', () => {
    const t0 = Date.parse('2026-09-05T01:00:00.000Z');
    const tracker = createTaskActivityTracker({ nowMs: () => t0 });
    tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'working' }));
    tracker.consume(traceEvent({ kind: 'kernel_decision', title: 'heartbeat_lost: retry scheduled', summary: 'Kernel 正在恢复' }));
    expect(tracker.health(t0 + 5_000)).toBe('lost');
    expect(tracker.snapshot().recoveryNote).toContain('heartbeat_lost');

    tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'resumed', occurredAt: '2026-09-05T01:01:00.000Z' }));
    expect(tracker.health(Date.parse('2026-09-05T01:01:05.000Z'))).toBe('active');
    expect(tracker.snapshot().recoveryNote).toBeNull();
  });

  it('renders a compact activity card with health, current step and recent steps', () => {
    const t0 = Date.parse('2026-09-05T01:00:00.000Z');
    const tracker = createTaskActivityTracker({ nowMs: () => t0 });
    tracker.consume(traceEvent({ kind: 'subtask_execution_started', title: 'Executing Subtask: 收集数据', subtaskId: 's1' }));
    tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'Executor started tool: web_search — 视频号' }));
    const card = tracker.renderCard(t0 + 10_000);
    expect(card).toContain('收集数据');
    expect(card).toContain('web_search');
    expect(card).toMatch(/活跃/);
  });
});

describe('milestone tiers (Feishu notification governance)', () => {
  it('tiers chat-worthy vs card-only milestones', () => {
    const tracker = createTaskActivityTracker();
    const cases: Array<[string, string, string]> = [
      // [kind, title, expectedTier]
      ['subtask_execution_started', 'Executing Subtask: A', 'card'],
      ['executor_dispatch_authorized', 'Dispatch authorized', 'card'],
      ['publication_integrated', 'Publication integrated', 'card'],
      ['delivery_completed', 'Final answer delivered', 'card'],
      ['kernel_decision_applied', 'Kernel applied no_op', 'card'],
      ['executor_result_observed', 'Result observed', 'chat'],
      ['execution_blocked', 'Execution blocked', 'chat'],
      ['executor_capacity_unavailable', 'Capacity unavailable', 'chat'],
      ['kernel_decision', 'heartbeat_lost: retry scheduled', 'chat'],
    ];
    for (const [kind, title, tier] of cases) {
      const { milestone } = tracker.consume(traceEvent({ kind, title, subtaskId: `s-${kind}` }));
      expect(milestone, kind).not.toBeNull();
      expect(milestone!.tier, kind).toBe(tier);
    }
  });
});

describe('activity card parts and completion receipt', () => {
  it('renders status in the main body and recent steps in the collapsed section', () => {
    const t0 = Date.parse('2026-09-05T01:00:00.000Z');
    const tracker = createTaskActivityTracker({ nowMs: () => t0 });
    tracker.consume(traceEvent({ kind: 'subtask_execution_started', title: 'Executing Subtask: 收集数据', subtaskId: 's1' }));
    tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'Executor started tool: web_search — 视频号' }));
    const parts = tracker.renderCardParts(t0 + 10_000);
    expect(parts.markdown).toContain('收集数据');
    expect(parts.markdown).toContain('web_search');
    expect(parts.collapsedMarkdown).toContain('web_search');
    expect(parts.markdown).not.toContain('最近步骤');
  });

  it('renders a completion receipt with elapsed time and step count', () => {
    const t0 = Date.parse('2026-09-05T01:00:00.000Z');
    const tracker = createTaskActivityTracker({ nowMs: () => t0 });
    tracker.consume(traceEvent({ kind: 'subtask_execution_started', title: 'Executing Subtask: A', subtaskId: 's1' }));
    tracker.consume(traceEvent({ kind: 'executor_progress', summary: 'step' }));
    const receipt = tracker.renderReceipt('completed', undefined, t0 + 130_000);
    expect(receipt).toContain('✅');
    expect(receipt).toContain('已完成');
    expect(receipt).toContain('2 分钟');
    expect(receipt).toContain('1 步');
  });

  it('renders a failure receipt with the error', () => {
    const tracker = createTaskActivityTracker();
    const receipt = tracker.renderReceipt('failed', '执行器进程异常退出');
    expect(receipt).toContain('❌');
    expect(receipt).toContain('执行器进程异常退出');
  });
});
