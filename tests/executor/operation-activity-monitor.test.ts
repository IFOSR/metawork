import { describe, it, expect, vi, afterEach } from 'vitest';
import { OperationActivityMonitor, type OperationHealth } from '../../src/executor/operation-activity-monitor.js';

afterEach(() => vi.useRealTimers());
describe('operation activity observation', () => {
  it('reports confirmed health evidence without taking recovery authority and clears finished operations', async () => {
    vi.useFakeTimers();
    const events: OperationHealth[] = [];
    const monitor = new OperationActivityMonitor({ quietMs: 300_000,
      probe: async id => ({ state: id === 'dead' ? 'exited' : 'unresponsive', evidence: 'Injected worker response check' }),
      onHealth: event => events.push(event) });
    monitor.observe({ type: 'operation_started', operationId: 'dead' });
    monitor.observe({ type: 'operation_started', operationId: 'blocked-worker' });
    await vi.advanceTimersByTimeAsync(300_000); monitor.tick(); await vi.advanceTimersByTimeAsync(0);
    expect(events.filter(e => ['unresponsive', 'exited'].includes(e.state)).map(e => e.operationId)).toEqual(['dead', 'blocked-worker']);
    monitor.observe({ type: 'operation_finished', operationId: 'blocked-worker' });
    expect(events.at(-1)).toMatchObject({ operationId: 'blocked-worker', state: 'active', evidence: 'Operation completed' });
    monitor.dispose();
  });

  it('allows long work and monitors operations independently without inventing process death', async () => {
    vi.useFakeTimers();
    const events: OperationHealth[] = [];
    const probe = vi.fn(async (_operation: string) => ({ state: 'unknown' as const, evidence: 'Process exists only' }));
    const monitor = new OperationActivityMonitor({ quietMs: 300_000, probe, onHealth: event => events.push(event) });
    monitor.observe({ type: 'operation_started', operationId: 'pi-turn:1' });
    monitor.observe({ type: 'operation_started', operationId: 'pdf-a' });
    monitor.observe({ type: 'operation_started', operationId: 'pdf-b' });
    for (let page = 1; page <= 40; page++) {
      await vi.advanceTimersByTimeAsync(60_000);
      monitor.observe({ type: 'operation_progress', operationId: 'pdf-a', checkpoint: String(page) });
      monitor.tick(); await vi.advanceTimersByTimeAsync(0);
    }
    expect(probe.mock.calls.every(call => call[0] === 'pdf-b')).toBe(true);
    expect(events.some(event => event.operationId === 'pdf-b' && event.state === 'unknown')).toBe(true);
    expect(events.some(event => event.operationId === 'pdf-a' && event.state !== 'active')).toBe(false);
    monitor.dispose();
  });

  it('does not renew activity for duplicate checkpoints, and clears stale health after real progress', async () => {
    vi.useFakeTimers();
    const events: OperationHealth[] = [];
    const monitor = new OperationActivityMonitor({ quietMs: 300_000,
      probe: async () => ({ state: 'unknown', evidence: 'No work evidence' }), onHealth: e => events.push(e) });
    const signal = { type: 'operation_progress' as const, operationId: 'tool', checkpoint: 'page-1' };
    monitor.observe(signal);
    await vi.advanceTimersByTimeAsync(300_001);
    monitor.observe(signal); monitor.tick(); await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)?.state).toBe('unknown');
    monitor.observe({ ...signal, checkpoint: 'page-2' });
    expect(events.at(-1)?.state).toBe('active');
    monitor.dispose();
  });

  it('bounds the health check rather than the operation and ignores late probe responses', async () => {
    vi.useFakeTimers();
    const events: OperationHealth[] = [];
    let resolveProbe!: (v: { state: 'unresponsive'; evidence: string }) => void;
    const monitor = new OperationActivityMonitor({ quietMs: 300_000, checkMs: 30_000,
      probe: () => new Promise(resolve => { resolveProbe = resolve; }), onHealth: e => events.push(e) });
    await vi.advanceTimersByTimeAsync(300_000); monitor.tick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.at(-1)?.state).toBe('unknown');
    monitor.dispose();
    resolveProbe({ state: 'unresponsive', evidence: 'late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)?.state).toBe('unknown');
  });
});
