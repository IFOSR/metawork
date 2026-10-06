import type { HarnessActivitySignal } from './harness-driver.js';

export interface OperationHealth {
  operationId: string;
  state: 'active' | 'waiting' | 'checking' | 'unknown' | 'unresponsive' | 'exited';
  lastActivityAt: string;
  lastProgressAt?: string;
  observedAt: string;
  evidence: string;
}

/** Observations only. Silence is not a cancellation decision or a wall-clock limit. */
export class OperationActivityMonitor {
  private readonly operations = new Map<string, {
    lastActivity: number; lastProgress?: number; checkpoint?: string; state: OperationHealth['state']; checkedAt: number; publishedAt?: number;
  }>();
  private disposed = false;
  private readonly checks = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly deps: {
    now?: () => number;
    quietMs: number;
    checkMs?: number;
    probe(operationId: string): Promise<{ state: 'unknown' | 'unresponsive' | 'exited' | 'active'; evidence: string }>;
    onHealth(observation: OperationHealth): void;
  }) {
    this.operations.set('process', { lastActivity: this.now(), state: 'active', checkedAt: 0 });
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  observe(signal: HarnessActivitySignal): void {
    if (this.disposed) return;
    if (signal.type === 'operation_finished') {
      const finished = this.operations.get(signal.operationId);
      if (finished && finished.state !== 'active') {
        finished.lastActivity = this.now();
        finished.lastProgress = this.now();
        this.emit(signal.operationId, finished, 'active', 'Operation completed');
      }
      this.operations.delete(signal.operationId);
      for (const [id, op] of this.operations) if (id.startsWith('pi-turn:')) op.lastActivity = this.now();
      if (!this.operations.size) this.operations.set('process', { lastActivity: this.now(), state: 'active', checkedAt: 0 });
      return;
    }
    if (signal.operationId !== 'process') {
      const process = this.operations.get('process');
      if (process && process.state !== 'active') this.emit('process', process, 'active', 'Specific operation activity observed');
      this.operations.delete('process');
    }
    const previous = this.operations.get(signal.operationId);
    if (signal.type === 'operation_progress' && signal.checkpoint !== undefined && previous?.checkpoint === signal.checkpoint) return;
    if (signal.type === 'operation_started' && previous) return;
    const op = { lastActivity: this.now(), lastProgress: signal.type === 'operation_progress' ? this.now() : previous?.lastProgress,
      checkpoint: signal.checkpoint, state: 'active' as const, checkedAt: 0,
      publishedAt: previous?.publishedAt ?? this.now() };
    this.operations.set(signal.operationId, op);
    if (previous && (previous.state !== 'active' || this.now() - op.publishedAt >= 10_000)) {
      op.publishedAt = this.now();
      this.emit(signal.operationId, op, 'active', 'New operation activity observed');
    }
  }

  tick(): void {
    if (this.disposed) return;
    const now = this.now();
    const hasChildOperation = [...this.operations.keys()].some(id => id !== 'process' && !id.startsWith('pi-turn:'));
    for (const [id, op] of this.operations) {
      if (hasChildOperation && id.startsWith('pi-turn:')) {
        if (op.state !== 'active') this.emit(id, op, 'active', 'Child operations are monitored independently');
        // Invalidate a pending parent check while its child owns activity observation.
        this.operations.set(id, { ...op, lastActivity: now, checkedAt: 0 });
        continue;
      }
      const silence = now - op.lastActivity;
      if (silence < Math.min(60_000, this.deps.quietMs)) continue;
      if (op.state === 'active') this.emit(id, op, 'waiting', 'No new operation activity');
      if (silence < this.deps.quietMs || op.state === 'checking'
        || (op.checkedAt && now - op.checkedAt < this.deps.quietMs)) continue;
      this.emit(id, op, 'checking', 'Checking after sustained silence; elapsed duration is not a deadline');
      op.checkedAt = now;
      const lastActivity = op.lastActivity;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<{ state: 'unknown'; evidence: string }>(resolve => {
        timer = setTimeout(() => resolve({ state: 'unknown', evidence: 'Health check did not return; operation state remains unconfirmed' }), this.deps.checkMs ?? 30_000);
        this.checks.add(timer); timer.unref();
      });
      void Promise.race([Promise.resolve().then(() => this.deps.probe(id)), timeout])
        .catch(() => ({ state: 'unknown' as const, evidence: 'Health check unavailable' }))
        .then(result => {
          clearTimeout(timer); this.checks.delete(timer);
          if (this.disposed || this.operations.get(id) !== op || op.lastActivity !== lastActivity) return;
          if (result.state === 'active') op.lastActivity = this.now();
          this.emit(id, op, result.state, result.evidence);
        });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.checks) clearTimeout(timer);
    this.checks.clear(); this.operations.clear();
  }

  private emit(id: string, op: { lastActivity: number; lastProgress?: number; state: OperationHealth['state'] }, state: OperationHealth['state'], evidence: string): void {
    op.state = state;
    this.deps.onHealth({ operationId: id, state, lastActivityAt: new Date(op.lastActivity).toISOString(),
      ...(op.lastProgress !== undefined ? { lastProgressAt: new Date(op.lastProgress).toISOString() } : {}),
      observedAt: new Date(this.now()).toISOString(), evidence });
  }
}
