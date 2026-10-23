import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventJournalMaintenance } from '../../src/gateway/event-journal-maintenance.js';

afterEach(() => vi.useRealTimers());

describe('EventJournalMaintenance', () => {
  it('keeps one pass in flight and awaits it on stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : after === 'conv_a' ? 'conv_b' : null);
    const maintain = vi.fn(async () => { await pending; return { done: true, didWork: false }; });
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain, intervalMs: 10, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(nextStream).toHaveBeenCalledTimes(1);
    expect(maintain).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    const callsAtStop = maintain.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(maintain).toHaveBeenCalledTimes(callsAtStop);
  });

  it('finishes a bounded batch before moving on and isolates a failing stream', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn((_account: string, after: string) => (
      after === '' ? 'conv_a' : after === 'conv_a' ? 'conv_b' : null
    ));
    const onError = vi.fn();
    const maintain = vi.fn(async (_account: string, conversationId: string) => {
      if (conversationId === 'conv_a') return callsForA++ === 0 ? { done: false, didWork: true } : { done: true, didWork: false };
      throw new Error('disk unavailable');
    });
    let callsForA = 0;
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain, intervalMs: 10, onError,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(40);
    await worker.stop();
    // The first stream needed two bounded batches and the damaged stream was
    // still visited in the same sweep: failure never starves a sibling stream.
    expect(maintain.mock.calls.slice(0, 3)).toEqual([
      ['local-default', 'conv_a'], ['local-default', 'conv_a'], ['local-default', 'conv_b'],
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, context] = onError.mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect(context).toMatchObject({
      accountId: 'local-default',
      conversationId: 'conv_b',
      stage: 'maintain',
      attempts: 1,
      outcome: 'reported',
    });
  });

  it('sleeps on the idle interval after a complete sweep found no work', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn((_account: string, after: string) => {
      const order = ['', 'conv_a', 'conv_b'];
      const index = order.indexOf(after);
      return index >= 0 && index < order.length - 1 ? order[index + 1]! : null;
    });
    const maintain = vi.fn(async () => ({ done: true, didWork: false }));
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain,
      intervalMs: 5, idleIntervalMs: 1_000, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(2_000);
    // One sweep per idle interval, not one per stream per active interval.
    const perSweep = 2;
    expect(maintain.mock.calls.length).toBeLessThanOrEqual(perSweep * 3);
    expect(maintain).toHaveBeenCalledTimes(perSweep * 2);
    await worker.stop();
  });

  it('stays on the active interval while a pass reports work', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : null);
    const maintain = vi.fn(async () => ({ done: true, didWork: true }));
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain,
      intervalMs: 5, idleIntervalMs: 1_000, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(maintain.mock.calls.length).toBeGreaterThan(5);
    await worker.stop();
  });

  it('wakes an idle loop as soon as new work is known', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : null);
    const maintain = vi.fn(async () => ({ done: true, didWork: false }));
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain,
      intervalMs: 5, idleIntervalMs: 1_000, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(5);
    const afterFirstSweep = maintain.mock.calls.length;
    expect(afterFirstSweep).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(maintain).toHaveBeenCalledTimes(afterFirstSweep);
    worker.wake();
    await vi.advanceTimersByTimeAsync(5);
    expect(maintain).toHaveBeenCalledTimes(afterFirstSweep + 1);
    await worker.stop();
  });

  it('backs off a failing stream, bounds repeat reports, and announces recovery', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : null);
    let failing = true;
    const maintain = vi.fn(async () => {
      if (failing) throw new Error('Cannot read properties of null (reading \'length\')');
      return { done: true, didWork: false };
    });
    const onError = vi.fn();
    const onRecovered = vi.fn();
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain,
      intervalMs: 5, idleIntervalMs: 30, errorBackoffBaseMs: 20, errorBackoffMaxMs: 100,
      errorReportEvery: 3, onError, onRecovered,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(600);
    const attemptsWhileFailing = maintain.mock.calls.length;
    // Per-stream exponential backoff: a persistent failure is retried rarely.
    expect(attemptsWhileFailing).toBeGreaterThan(1);
    expect(attemptsWhileFailing).toBeLessThan(20);
    // First failure is reported with context, repeats are suppressed until the
    // bounded report interval elapses.
    expect(onError.mock.calls[0]![1]).toMatchObject({ conversationId: 'conv_a', stage: 'maintain', attempts: 1, outcome: 'reported' });
    const suppressed = onError.mock.calls.filter(call => call[1].outcome === 'suppressed');
    expect(suppressed.length).toBeGreaterThan(0);
    expect(onError.mock.calls.some(call => call[1].outcome === 'reported' && call[1].attempts > 1)).toBe(true);
    failing = false;
    await vi.advanceTimersByTimeAsync(400);
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(onRecovered.mock.calls[0]![0]).toMatchObject({ conversationId: 'conv_a' });
    expect(onRecovered.mock.calls[0]![0].failedAttempts).toBeGreaterThan(1);
    await worker.stop();
  });

  it('reports a failure of the stream index itself with a null conversation', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn(() => { throw new Error('database is locked'); });
    const maintain = vi.fn(async () => ({ done: true, didWork: false }));
    const onError = vi.fn();
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain, intervalMs: 5, idleIntervalMs: 50, onError,
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(30);
    await worker.stop();
    expect(maintain).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1]).toMatchObject({ stage: 'next_stream', conversationId: null });
  });

  it('sweeps a large converged install once per idle interval, not per stream', async () => {
    vi.useFakeTimers();
    const streams = Array.from({ length: 200 }, (_value, index) => `conv_${String(index).padStart(3, '0')}`);
    const nextStream = vi.fn((_account: string, after: string) => (
      after === '' ? streams[0]! : streams[streams.indexOf(after) + 1] ?? null
    ));
    const maintain = vi.fn(async () => ({ done: true, didWork: false }));
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain,
      intervalMs: 5, idleIntervalMs: 1_000, maxSweepMs: 10_000, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(3_000);
    await worker.stop();
    // Two to four idle sweeps over 3s; the old wiring re-walked every stream at
    // 40Hz (hundreds of sweeps), which is what this bound protects.
    const sweeps = maintain.mock.calls.length / streams.length;
    expect(Number.isInteger(sweeps)).toBe(true);
    expect(sweeps).toBeGreaterThanOrEqual(2);
    expect(sweeps).toBeLessThanOrEqual(4);
  });

  it('bounds one sweep for an install larger than the per-sweep stream budget', async () => {
    vi.useFakeTimers();
    const streams = Array.from({ length: 30 }, (_value, index) => `conv_${String(index).padStart(2, '0')}`);
    const nextStream = vi.fn((_account: string, after: string) => (
      after === '' ? streams[0]! : streams[streams.indexOf(after) + 1] ?? null
    ));
    const maintain = vi.fn(async () => ({ done: true, didWork: false }));
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain,
      intervalMs: 5, idleIntervalMs: 1_000, maxSweepMs: 10_000, maxStreamsPerSweep: 10, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(maintain).toHaveBeenCalledTimes(10);
    // Partial sweeps continue on the active interval instead of sleeping.
    await vi.advanceTimersByTimeAsync(10);
    expect(maintain).toHaveBeenCalledTimes(30);
    await worker.stop();
  });

  it('accepts a boolean pass result for the pre-backoff contract', async () => {
    vi.useFakeTimers();
    const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : null);
    const maintain = vi.fn(async () => false);
    const worker = new EventJournalMaintenance({
      accountId: 'local-default', nextStream, maintain, intervalMs: 5, idleIntervalMs: 1_000, onError: vi.fn(),
    });
    worker.start();
    await vi.advanceTimersByTimeAsync(5);
    // An unfinished batch is work: the same stream is revisited within the sweep.
    expect(maintain.mock.calls.length).toBe(4);
    await worker.stop();
  });
});
