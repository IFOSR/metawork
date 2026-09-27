import { OpenRouter } from '@openrouter/sdk';
import { validateSpanDecisionsResponse } from './span-response-validator.js';
import {
  SPAN_MAX_CONCURRENT_REQUESTS,
  SPAN_MAX_QUEUED_REQUESTS,
  SpanEvaluationAbortedError,
  type SpanRoutingEvaluator,
  type SpanSubtaskEvaluationRequest,
  type SpanSubtaskObservation,
  type SpanUsage,
} from './span-routing-types.js';

export { SpanEvaluationAbortedError } from './span-routing-types.js';

/** Narrow callable seam around the Decisions API so tests never hit the network. */
export interface SpanDecisionClient {
  create(
    request: {
      model: string;
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
    },
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<unknown>;
}

export interface SpanRoutingAdvisorDeps {
  /**
   * Resolves the OpenRouter credential for the exact pinned configuration
   * revision the proposal belongs to; null when unset. Resolution is bounded by
   * the proposal deadline and any failure degrades to a scored fallback instead
   * of failing plan admission.
   */
  resolveApiKey: (configurationRevision: string) => Promise<string | null>;
  /** Test seam; defaults to the real OpenRouter SDK client. */
  createClient?: (apiKey: string) => SpanDecisionClient;
  maxConcurrent?: number;
  /**
   * Server lifetime signal. Aborting it interrupts every in-flight Span
   * request and releases queued waiters, so a stopping Server cannot leave
   * external calls running or hand a late observation to a live Turn.
   */
  lifetimeSignal?: AbortSignal;
}

/**
 * Server-only Span advisor.
 *
 * Owns the single external call site: bounded one-batch-per-Subtask `noul`
 * evaluation with a proposal-wide deadline, a small concurrency cap, disabled
 * SDK retries, and abort-on-timeout. It never mutates a decision, binding, or
 * candidate set; it returns an observation for the Kernel to validate.
 */
export class SpanRoutingAdvisor implements SpanRoutingEvaluator {
  /**
   * One Server-wide limiter, not one per proposal: the design bounds total
   * concurrent Span requests rather than allowing every Conversation to open
   * its own pair.
   */
  private readonly limiter: ConcurrencyLimiter;

  constructor(private readonly deps: SpanRoutingAdvisorDeps) {
    this.limiter = new ConcurrencyLimiter(
      Math.max(1, deps.maxConcurrent ?? SPAN_MAX_CONCURRENT_REQUESTS),
    );
  }

  async evaluate(input: {
    configurationRevision: string;
    deadlineMs: number;
    signal?: AbortSignal;
    requests: readonly SpanSubtaskEvaluationRequest[];
  }): Promise<{ subtasks: SpanSubtaskObservation[]; usage?: SpanUsage }> {
    if (input.requests.length === 0) return { subtasks: [] };
    // Fold in the Server lifetime so shutdown aborts the request itself, not
    // just the waiting caller.
    const signal = combineAbortSignals(input.signal, this.deps.lifetimeSignal);
    const fallbackAll = (
      reason: 'span_secret_unavailable' | 'span_timeout',
    ): SpanSubtaskObservation[] => input.requests.map(request => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'fallback',
      reason,
    }));
    const credential = await this.resolveCredential({
      configurationRevision: input.configurationRevision,
      deadlineMs: input.deadlineMs,
      signal,
    });
    if (typeof credential !== 'object') {
      return { subtasks: fallbackAll(credential) };
    }
    const client = (this.deps.createClient ?? defaultSpanDecisionClient)(credential.apiKey);
    const subtasks = await Promise.all(input.requests.map(request => this.evaluateOne({
      request,
      deadlineMs: input.deadlineMs,
      signal,
      client,
    })));
    const usage = aggregateUsage(subtasks);
    return { subtasks, ...(usage ? { usage } : {}) };
  }

  /**
   * Resolves the pinned-revision credential within the proposal deadline.
   * Missing, failed, or over-deadline resolution is a bounded fallback reason;
   * only a caller abort propagates.
   */
  private async resolveCredential(input: {
    configurationRevision: string;
    deadlineMs: number;
    signal?: AbortSignal;
  }): Promise<{ apiKey: string } | 'span_secret_unavailable' | 'span_timeout'> {
    if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
    const remaining = input.deadlineMs - Date.now();
    if (remaining <= 0) return 'span_timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const outcome = await Promise.race([
        this.deps.resolveApiKey(input.configurationRevision).then(
          apiKey => (typeof apiKey === 'string' && apiKey.trim().length > 0
            ? { kind: 'resolved' as const, apiKey: apiKey.trim() }
            : { kind: 'missing' as const }),
          () => ({ kind: 'missing' as const }),
        ),
        new Promise<'timeout'>(resolve => {
          timer = setTimeout(() => resolve('timeout'), remaining);
        }),
        new Promise<'aborted'>(resolve => {
          onAbort = () => resolve('aborted');
          input.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
      if (outcome === 'timeout') return 'span_timeout';
      if (outcome === 'aborted') throw new SpanEvaluationAbortedError();
      return outcome.kind === 'resolved' ? { apiKey: outcome.apiKey } : 'span_secret_unavailable';
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    }
  }

  private async evaluateOne(input: {
    request: SpanSubtaskEvaluationRequest;
    deadlineMs: number;
    signal?: AbortSignal;
    client: SpanDecisionClient;
  }): Promise<SpanSubtaskObservation> {
    const { request } = input;
    const startedAt = Date.now();
    if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
    const fallback = (
      reason: 'span_timeout' | 'span_http_error' | 'span_invalid_response' | 'span_candidate_mismatch' | 'span_proposal_budget_exhausted',
    ): SpanSubtaskObservation => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'fallback',
      reason,
      durationMs: Date.now() - startedAt,
    });

    const release = await this.limiter.acquire(input.deadlineMs, input.signal);
    if (release === 'full') return fallback('span_proposal_budget_exhausted');
    if (!release) {
      if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
      return fallback('span_timeout');
    }
    const remaining = input.deadlineMs - Date.now();
    if (remaining <= 0) {
      release();
      return fallback('span_timeout');
    }
    if (input.signal?.aborted) {
      release();
      throw new SpanEvaluationAbortedError();
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), remaining);
    let rejectAborted: (() => void) | undefined;
    try {
      const operation = Promise.resolve().then(() => input.client.create(
        {
          model: request.request.model,
          state: request.request.state,
          questions: request.request.questions,
        },
        { signal: controller.signal, timeoutMs: remaining },
      ));
      // Keep the physical slot until the transport actually settles, even if a
      // faulty transport ignores abort. The caller still meets its deadline.
      void operation.finally(release).catch(() => undefined);
      const response = await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        rejectAborted = () => reject(new Error('span request aborted'));
        if (controller.signal.aborted) rejectAborted();
        else controller.signal.addEventListener('abort', rejectAborted, { once: true });
      })]);
      if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
      if (controller.signal.aborted || Date.now() >= input.deadlineMs) return fallback('span_timeout');
      const validated = validateSpanDecisionsResponse({ request: request.request, response });
      if (!validated.ok) return fallback(validated.reason);
      return {
        subtaskId: request.subtaskId,
        candidateSetFingerprint: request.candidateSetFingerprint,
        status: 'advised',
        resolvedModel: validated.resolvedModel,
        candidates: request.request.candidates.map(binding => ({
          candidateId: binding.questionId,
          agentClassRef: binding.agentClassRef,
          providerRef: binding.providerRef,
          modelRef: binding.modelRef,
          probability: validated.probabilities[binding.questionId]!,
        })),
        ...(validated.usage ? { usage: validated.usage } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
      if (error instanceof SpanEvaluationAbortedError) throw error;
      if (controller.signal.aborted) return fallback('span_timeout');
      return fallback('span_http_error');
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onAbort);
      if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted);
    }
  }
}

/**
 * Real client with SDK retries disabled and the deadline enforced by the SDK's
 * own request timeout plus an abort signal (never a bare `Promise.race`).
 */
export function defaultSpanDecisionClient(apiKey: string): SpanDecisionClient {
  const client = new OpenRouter({ apiKey, retryConfig: { strategy: 'none' } });
  return {
    async create(request, options) {
      return client.alpha.decisions.create(
        {
          decisionsRequest: {
            model: request.model,
            // Respan accepts textual state only; the SDK also permits objects
            // for other decision providers, which Respan rejects with HTTP 400.
            state: JSON.stringify(request.state),
            questions: request.questions as never,
          },
        },
        {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          retries: { strategy: 'none' },
        },
      );
    },
  };
}

/** Small FIFO limiter shared by every proposal on one Server. */
class ConcurrencyLimiter {
  private active = 0;
  /** Queued acquirers; each returns true only if it actually accepted a slot. */
  private readonly waiters: Array<() => boolean> = [];

  constructor(private readonly limit: number) {}

  acquire(deadlineMs: number, signal?: AbortSignal): Promise<(() => void) | null | 'full'> {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= SPAN_MAX_QUEUED_REQUESTS) return Promise.resolve('full');
    return new Promise(resolve => {
      let settled = false;
      const accept = () => settle(true);
      const settle = (accepted: boolean): boolean => {
        if (settled) return false;
        settled = true;
        const index = this.waiters.indexOf(accept);
        if (index >= 0) this.waiters.splice(index, 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(accepted ? this.makeRelease() : null);
        return true;
      };
      const onAbort = () => { settle(false); };
      const remaining = deadlineMs - Date.now();
      const timer = setTimeout(() => { settle(false); }, Math.max(0, remaining));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(accept);
    });
  }

  /**
   * Releases one slot. A waiting acquirer inherits the slot directly instead of
   * the slot being counted down and re-granted, which previously let a newly
   * arriving request be admitted while the inherited slot was still held.
   */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      while (this.waiters.length > 0) {
        // A waiter that already timed out or aborted refuses the slot, so the
        // next live waiter is offered it instead of leaking a slot.
        if (this.waiters.shift()!()) return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

/**
 * Merges the caller signal with the Server lifetime into one abort signal.
 * Always returns a signal, so callers never need a `signal === undefined`
 * branch when combining sources.
 */
function combineAbortSignals(
  ...signals: ReadonlyArray<AbortSignal | undefined>
): AbortSignal {
  const live = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (live.length === 0) return new AbortController().signal;
  if (live.length === 1) return live[0]!;
  return AbortSignal.any(live);
}

function aggregateUsage(subtasks: readonly SpanSubtaskObservation[]): SpanUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let observed = false;
  for (const subtask of subtasks) {
    if (subtask.status !== 'advised' || !subtask.usage) continue;
    observed = true;
    inputTokens += subtask.usage.inputTokens ?? 0;
    outputTokens += subtask.usage.outputTokens ?? 0;
    cost += subtask.usage.cost ?? 0;
  }
  return observed
    ? {
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(cost > 0 ? { cost } : {}),
    }
    : undefined;
}
