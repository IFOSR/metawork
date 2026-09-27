import { afterEach, expect, it, vi } from 'vitest';
import { EventJournalMaintenance } from '../../src/gateway/event-journal-maintenance.js';

afterEach(() => vi.useRealTimers());

it('processes one indexed stream at a time and drains work before stopping', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : 'conv_b');
  const maintain = vi.fn(async () => { await pending; return true; });
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
  await vi.advanceTimersByTimeAsync(100);
  expect(maintain).toHaveBeenCalledTimes(1);
});

it('finishes a bounded orphan scan before moving on and continues after failures', async () => {
  vi.useFakeTimers();
  const nextStream = vi.fn((_account: string, after: string) => after === '' ? 'conv_a' : after === 'conv_a' ? 'conv_b' : null);
  const onError = vi.fn();
  let calls = 0;
  const maintain = vi.fn(async () => {
    calls += 1;
    if (calls === 1) return false;
    if (calls === 3) throw new Error('disk unavailable');
    return true;
  });
  const worker = new EventJournalMaintenance({
    accountId: 'local-default', nextStream, maintain, intervalMs: 10, onError,
  });
  worker.start();
  await vi.advanceTimersByTimeAsync(40);
  await worker.stop();
  expect(maintain.mock.calls.map(call => call)).toEqual([
    ['local-default', 'conv_a'], ['local-default', 'conv_a'], ['local-default', 'conv_b'],
  ]);
  expect(nextStream.mock.calls.map(call => call[1])).toEqual(['', 'conv_a', 'conv_b']);
  expect(onError).toHaveBeenCalledTimes(1);
});
