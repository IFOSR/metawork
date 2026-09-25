import { describe, expect, it, vi } from 'vitest';
import { KernelExecutionRuntime } from '../../src/execution/kernel-execution-runtime.js';
import type { ExecutionTraceAppendInput } from '../../src/execution/execution-trace.js';
import { InteractionTraceStream } from '../../src/session/interaction-trace-stream.js';

function fixture(status = 'cancelled', residue: string[] = []) {
  const trace = new InteractionTraceStream('conv_cancel');
  trace.beginTurn({ turnId: 'turn_cancel', userInput: 'Run a task' });
  const recover = vi.fn(async () => undefined);
  const onTaskTerminal = vi.fn();
  const runtime = new KernelExecutionRuntime({
    taskEventRepo: {},
    dispatchItemRepo: {},
    maxConcurrentAttempts: 4,
    taskRuntimeService: { findTask: () => ({ id: 'task_cancel', status }) },
    cancellationCoordinator: {
      recover,
      completionBlockedReasons: () => residue,
      listCleanupTaskIds: () => [],
    },
    onTaskTerminal,
    callbacks: {
      appendExecutionTrace: (event: ExecutionTraceAppendInput) => trace.append(event),
      refreshRuntimeState: vi.fn(),
    },
  } as never);
  const internal = runtime as unknown as {
    attemptSupervisor: { drain(taskId: string): Promise<unknown> };
    drainCancellation(taskId: string): Promise<void>;
  };
  vi.spyOn(internal.attemptSupervisor, 'drain').mockResolvedValue(undefined);
  return { runtime, trace, recover, onTaskTerminal, drain: () => internal.drainCancellation('task_cancel') };
}

describe('cancellation completion trace', () => {
  it('publishes a terminal Turn only after cancelled Task cleanup has settled', async () => {
    const { runtime, trace, recover, onTaskTerminal, drain } = fixture();
    let release!: () => void;
    recover.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const listener = vi.fn();
    trace.subscribe(listener);
    try {
      const pending = drain();
      await vi.waitFor(() => expect(recover).toHaveBeenCalled());
      expect(trace.getSnapshot()?.status).toBe('running');
      expect(onTaskTerminal).not.toHaveBeenCalled();
      release();
      await pending;

      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
        turnId: 'turn_cancel',
        taskId: 'task_cancel',
        status: 'cancelled',
        completedAt: expect.any(String),
      }));
      expect(trace.getSnapshot()?.events.at(-1)).toMatchObject({
        kind: 'turn_cancelled',
        taskId: 'task_cancel',
      });
      expect(onTaskTerminal).toHaveBeenCalledWith('task_cancel');
      recover.mockResolvedValue(undefined);
      await drain();
      expect(trace.getSnapshot()?.events.filter(event => event.kind === 'turn_cancelled')).toHaveLength(1);
    } finally {
      await runtime.dispose();
    }
  });

  it.each([
    ['cancelled', ['attempt cleanup pending']],
    ['running', []],
    ['done', []],
  ] as const)('does not report cancellation for status=%s, residue=%j', async (status, residue) => {
    const { runtime, trace, drain } = fixture(status, [...residue]);
    try {
      await drain();
      expect(trace.getSnapshot()?.status).toBe('running');
      expect(trace.getSnapshot()?.events.some(event => event.kind === 'turn_cancelled')).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it('does not report cancellation when cleanup fails', async () => {
    const { runtime, trace, recover, drain } = fixture();
    recover.mockRejectedValue(new Error('backend unavailable'));
    try {
      await drain();
      expect(trace.getSnapshot()?.status).toBe('running');
    } finally {
      await runtime.dispose();
    }
  });
});
