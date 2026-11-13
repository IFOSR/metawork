import { RouterError, routeDecisionInputHash, type RouteDecision, type RouteRequest, type RouterService } from '../routing/router.js';

export interface RouteDecisionStore {
  findByAttempt(taskId: string, generationId: string, subtaskId: string, attemptOrdinal: number): RouteDecision | null;
  findById(id: string): RouteDecision | null;
  /** checkCurrent runs inside the same transaction as the append. */
  record(input: RouteRequest, decision: RouteDecision, checkCurrent?: () => void): 'inserted' | 'replayed' | 'conflict';
}

export interface RouterDispatchTarget {
  readonly request: RouteRequest;
  readonly signal?: AbortSignal;
  /** Synchronous owner read, rechecked inside the persistence transaction. */
  readonly readCurrentRequest: () => RouteRequest | null;
  /**
   * Account-bound Query that pays for the decision-model call. Absent when the
   * dispatch has no Query (system-triggered recovery), so no usage fact can be
   * attributed and none is written.
   */
  readonly queryId?: string | null;
}

/** Metering facts of the decision-model call that produced one route. */
export interface RouterModelUsageRecord {
  readonly request: RouteRequest;
  readonly queryId: string;
  readonly routeDecisionId: string;
  readonly providerRef: string;
  readonly modelId: string;
  readonly outcome: RouteDecision['outcome'];
  readonly usage?: { inputTokens?: number; outputTokens?: number };
  readonly occurredAtUtc: string;
}

export interface RouterDispatchServiceOptions {
  readonly router: RouterService;
  readonly decisions: RouteDecisionStore;
  /**
   * Called exactly once per actual decision-model call, never for a replay.
   * The Router reports tokens only; the caller owns facts and attribution.
   */
  readonly onModelUsage?: (record: RouterModelUsageRecord) => void;
}

interface PendingRoute {
  readonly hash: string;
  readonly controller: AbortController;
  readonly promise: Promise<RouteDecision>;
  waiters: number;
}

/**
 * Runtime-owned Router persistence seam. Concurrent callers share one model
 * invocation. The durable winner is authoritative, including when two service
 * instances race. Cancellation never publishes a late route, and persistence
 * rechecks the current Task/graph/configuration before accepting the fact.
 * Executor claim/launch belongs to the dispatch owner, not this service.
 */
export class RouterDispatchService {
  private readonly pending = new Map<string, PendingRoute>();

  constructor(private readonly options: RouterDispatchServiceOptions) {}

  async route(target: RouterDispatchTarget): Promise<RouteDecision> {
    if (target.signal?.aborted) throw cancelled();
    const request = structuredClone(target.request);
    this.checkCurrent(request, target.readCurrentRequest);
    const existing = this.find(request);
    if (existing) {
      this.options.router.assertFresh(existing, request);
      return existing;
    }
    const key = JSON.stringify([request.taskId, request.generationId, request.subtaskId, request.attemptOrdinal]);
    const hash = routeDecisionInputHash(request);
    let pending = this.pending.get(key);
    if (pending && pending.hash !== hash) {
      throw new RouterError('route_stale_decision', 'another snapshot is already being routed for this attempt');
    }
    if (!pending) {
      const controller = new AbortController();
      // Schedule after registering the entry and its first waiter. A synchronous
      // adapter failure must also release the pending identity.
      const promise = Promise.resolve().then(() => this.produce(
        request,
        target.readCurrentRequest,
        controller.signal,
        target.queryId ?? null,
      ));
      pending = { hash, controller, promise, waiters: 0 };
      this.pending.set(key, pending);
      const entry = pending;
      void promise.finally(() => {
        if (this.pending.get(key) === entry) this.pending.delete(key);
      }).catch(() => undefined);
    }
    pending.waiters++;
    let detach = () => undefined as void;
    const cancelledPromise = new Promise<never>((_, reject) => {
      const onAbort = () => reject(cancelled());
      target.signal?.addEventListener('abort', onAbort, { once: true });
      detach = () => target.signal?.removeEventListener('abort', onAbort);
      if (target.signal?.aborted) onAbort();
    });
    try {
      const decision = await Promise.race([pending.promise, cancelledPromise]);
      if (target.signal?.aborted) throw cancelled();
      this.checkCurrent(request, target.readCurrentRequest);
      return structuredClone(decision);
    } finally {
      detach();
      pending.waiters--;
      if (pending.waiters === 0) {
        pending.controller.abort();
        if (this.pending.get(key) === pending) this.pending.delete(key);
      }
    }
  }

  private async produce(
    request: RouteRequest,
    readCurrent: () => RouteRequest | null,
    signal: AbortSignal,
    queryId: string | null,
  ): Promise<RouteDecision> {
    const decision = await this.options.router.decide(request, signal);
    if (signal.aborted) throw cancelled();
    this.recordModelUsage(request, queryId, decision);
    this.options.decisions.record(request, decision, () => this.checkCurrent(request, readCurrent));
    // Another process/service may win with a different nondeterministic choice.
    // Never replace that fact or dispatch our uncommitted choice.
    const persisted = this.find(request);
    if (!persisted) throw new Error('route decision was not persisted');
    this.options.router.assertFresh(persisted, request);
    return persisted;
  }

  /**
   * Persists decision-model usage for a call that really happened. A Router
   * call without an account-bound Query cannot be attributed, and a call that
   * never left the process (disabled policy, missing credential) creates no
   * fact at all.
   */
  private recordModelUsage(
    request: RouteRequest,
    queryId: string | null,
    decision: RouteDecision,
  ): void {
    const record = this.options.onModelUsage;
    const call = decision.call;
    if (!record || !call?.callAttempted || !queryId) return;
    record({
      request,
      queryId,
      routeDecisionId: decision.routeDecisionId,
      providerRef: decision.decisionModel.providerRef,
      modelId: decision.decisionModel.modelRef,
      outcome: decision.outcome,
      ...(call.usage ? { usage: call.usage } : {}),
      occurredAtUtc: call.occurredAtUtc,
    });
  }

  private find(request: RouteRequest): RouteDecision | null {
    return this.options.decisions.findByAttempt(request.taskId, request.generationId, request.subtaskId, request.attemptOrdinal);
  }

  private checkCurrent(request: RouteRequest, readCurrent: () => RouteRequest | null): void {
    const current = readCurrent();
    if (!current || routeDecisionInputHash(current) !== routeDecisionInputHash(request)) {
      throw new RouterError('route_stale_decision', 'Task, graph or routing configuration changed before route persistence');
    }
  }
}

function cancelled(): RouterError {
  return new RouterError('route_cancelled', 'router decision was cancelled');
}
