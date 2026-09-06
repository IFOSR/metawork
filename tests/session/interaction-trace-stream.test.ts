import { describe, expect, it, vi } from 'vitest';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';

describe('InteractionTraceStream', () => {
  it('assigns stable event ids and sequences while redacting bounded details', () => {
    const stream = new InteractionTraceStream('session-trace', {
      now: () => '2026-08-17T00:00:00.000Z',
    });
    stream.beginTurn({
      turnId: 'turn-trace',
      userInput: 'Investigate the Planner warning',
    });
    stream.append({
      phase: 'planning',
      actor: 'planner',
      kind: 'planner_started',
      status: 'running',
      title: 'Planner started',
      summary: 'Inspecting request',
      details: {
        apiToken: 'secret-token-value',
        nested: { password: 'hidden', action: 'plan_work_graph' },
        message: `Bearer abcdefghijklmnopqrstuvwxyz ${'x'.repeat(2_000)}`,
      },
    });

    const trace = stream.getSnapshot();
    expect(trace?.events.map(event => ({
      id: event.id,
      sequence: event.sequence,
      kind: event.kind,
    }))).toEqual([
      {
        id: 'interaction:turn-trace:query_received:query',
        sequence: 1,
        kind: 'query_received',
      },
      {
        id: 'interaction:turn-trace:planner_started:2',
        sequence: 2,
        kind: 'planner_started',
      },
    ]);
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('secret-token-value');
    expect(serialized).not.toContain('hidden');
    expect(serialized).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz');
    expect(serialized.length).toBeLessThan(5_000);
  });

  it('publishes a replay cursor and execution identity alongside safe progress', () => {
    const stream = new InteractionTraceStream('session-execution', {
      now: () => '2026-08-17T00:00:00.000Z',
    });
    stream.beginTurn({ turnId: 'turn-execution', userInput: '运行任务' });
    stream.append({
      phase: 'execution',
      actor: 'executor',
      kind: 'executor_progress',
      status: 'running',
      title: 'Executor progress',
      summary: '正在读取公开材料',
      taskId: 'task_1',
      details: {
        subtaskId: 'sub_1',
        attemptId: 'attempt_1',
      },
      eventKey: 'attempt_1:progress:1',
    });

    const event = stream.getSnapshot()?.events.at(-1);
    expect(event).toMatchObject({
      cursor: 'turn-execution:2',
      eventKey: 'attempt_1:progress:1',
      taskId: 'task_1',
      subtaskId: 'sub_1',
      attemptId: 'attempt_1',
    });
  });

  it('replays the latest snapshot to late subscribers and bounds retained events', () => {
    const stream = new InteractionTraceStream('session-replay', {
      maxEvents: 3,
      now: () => '2026-08-17T00:00:00.000Z',
    });
    stream.beginTurn({ turnId: 'turn-replay', userInput: 'Run the task' });
    for (let index = 0; index < 4; index += 1) {
      stream.append({
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'running',
        title: `Step ${index + 1}`,
        summary: `Progress ${index + 1}`,
        details: {},
      });
    }
    const listener = vi.fn();

    const unsubscribe = stream.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      turnId: 'turn-replay',
      status: 'running',
      events: [
        { sequence: 3, title: 'Step 2' },
        { sequence: 4, title: 'Step 3' },
        { sequence: 5, title: 'Step 4' },
      ],
    });
    unsubscribe();
  });

  it('projects explicit terminal statuses without exposing hidden reasoning', () => {
    const stream = new InteractionTraceStream('session-terminal', {
      now: () => '2026-08-17T00:00:00.000Z',
    });
    stream.beginTurn({ turnId: 'turn-terminal', userInput: 'Plan this' });
    stream.append({
      phase: 'planning',
      actor: 'planner',
      kind: 'proposal_transport_uncertain',
      status: 'blocked',
      title: 'Planner transport uncertain',
      summary: 'connect ENOENT /tmp/anyfusion-planner.sock',
      details: {
        turnId: 'turn-terminal',
        submissionId: 'submission-terminal',
        retryableByReplay: true,
      },
      traceStatus: 'blocked',
    });

    expect(stream.getSnapshot()).toMatchObject({
      status: 'blocked',
      completedAt: '2026-08-17T00:00:00.000Z',
      events: [
        { kind: 'query_received', status: 'completed' },
        {
          kind: 'proposal_transport_uncertain',
          status: 'blocked',
          details: {
            turnId: 'turn-terminal',
            submissionId: 'submission-terminal',
            retryableByReplay: true,
          },
        },
      ],
    });
    expect(JSON.stringify(stream.getSnapshot())).not.toMatch(/chain.of.thought|reasoning_tokens/iu);
  });
});

describe('long event keys (production attempt ids)', () => {
  it('does not collapse distinct events whose eventKeys only differ after the 160-char bound', () => {
    // Regression: production attemptIds are ~188 chars, so
    // `${attemptId}:progress:N` exceeds the 160-char id bound for every N.
    // Naive truncation made all executor_progress/heartbeat events share one
    // id, and dedupe silently dropped every step after the first.
    const stream = new InteractionTraceStream('conv-long');
    stream.beginTurn({ turnId: 'turn_1', userInput: 'research' });
    const attemptId = `attempt_dispatch_event_exec_int_abcdef_${
      'x'.repeat(170)
    }_primary`;
    for (let index = 1; index <= 3; index += 1) {
      stream.append({
        phase: 'execution',
        actor: 'executor',
        kind: 'executor_progress',
        status: 'running',
        title: `Executor progress: ${index}`,
        summary: `step ${index}`,
        details: {},
        eventKey: `${attemptId}:progress:${index}`,
      });
    }
    const snapshot = stream.getSnapshot()!;
    const progressEvents = snapshot.events.filter(event => event.kind === 'executor_progress');
    expect(progressEvents).toHaveLength(3);
    expect(new Set(progressEvents.map(event => event.id)).size).toBe(3);
  });

  it('still dedupes replays of the same long eventKey', () => {
    const stream = new InteractionTraceStream('conv-long-2');
    stream.beginTurn({ turnId: 'turn_1', userInput: 'research' });
    const attemptId = `attempt_${'y'.repeat(180)}`;
    const input = {
      phase: 'execution' as const,
      actor: 'executor' as const,
      kind: 'executor_progress',
      status: 'running' as const,
      title: 'Executor progress: 1',
      summary: 'step 1',
      details: {},
      eventKey: `${attemptId}:progress:1`,
    };
    stream.append(input);
    stream.append(input);
    const snapshot = stream.getSnapshot()!;
    expect(snapshot.events.filter(event => event.kind === 'executor_progress')).toHaveLength(1);
  });
});
