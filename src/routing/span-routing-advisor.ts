import { OpenRouter } from '@openrouter/sdk';
import { validateSpanDecisionsResponse } from './span-response-validator.js';
import {
  SPAN_MAX_CONCURRENT_REQUESTS,
  type SpanRoutingEvaluator,
  type SpanSubtaskEvaluationRequest,
  type SpanSubtaskObservation,
  type SpanUsage,
} from './span-routing-types.js';

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
  /** Resolves the OpenRouter credential for the pinned revision; null when unset. */
  resolveApiKey: () => Promise<string | null>;
  /** Test seam; defaults to the real OpenRouter SDK client. */
  createClient?: (apiKey: string) => SpanDecisionClient;
  maxConcurrent?: number;
}

/** Internal abort marker: cancellation must not become a scored fallback. */
export class SpanEvaluationAbortedError extends Error {
  constructor() {
    super('Span evaluation aborted');
    this.name = 'AbortError';
  }
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
  private readonly maxConcurrent: number;

  constructor(private readonly deps: SpanRoutingAdvisorDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? SPAN_MAX_CONCURRENT_REQUESTS);
  }

  async evaluate(input: {
    deadlineMs: number;
    signal?: AbortSignal;
    requests: readonly SpanSubtaskEvaluationRequest[];
  }): Promise<{ subtasks: SpanSubtaskObservation[]; usage?: SpanUsage }> {
    if (input.requests.length === 0) return { subtasks: [] };
    const fallbackAll = (reason: 'span_secret_unavailable'): SpanSubtaskObservation[] => input.requests.map(request => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'fallback',
      reason,
    }));
    const apiKey = await this.deps.resolveApiKey();
    if (!apiKey) return { subtasks: fallbackAll('span_secret_unavailable') };
    const client = (this.deps.createClient ?? defaultSpanDecisionClient)(apiKey);
    const limiter = new ConcurrencyLimiter(this.maxConcurrent);
    const subtasks = await Promise.all(input.requests.map(request => this.evaluateOne({
      request,
      deadlineMs: input.deadlineMs,
      ...(input.signal ? { signal: input.signal } : {}),
      limiter,
      client,
    })));
    const usage = aggregateUsage(subtasks);
    return { subtasks, ...(usage ? { usage } : {}) };
  }

  private async evaluateOne(input: {
    request: SpanSubtaskEvaluationRequest;
    deadlineMs: number;
    signal?: AbortSignal;
    limiter: ConcurrencyLimiter;
    client: SpanDecisionClient;
  }): Promise<SpanSubtaskObservation> {
    const { request } = input;
    const startedAt = Date.now();
    if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
    const fallback = (
      reason: 'span_timeout' | 'span_http_error' | 'span_invalid_response' | 'span_candidate_mismatch',
    ): SpanSubtaskObservation => ({
      subtaskId: request.subtaskId,
      candidateSetFingerprint: request.candidateSetFingerprint,
      status: 'fallback',
      reason,
      durationMs: Date.now() - startedAt,
    });

    const release = await input.limiter.acquire(input.deadlineMs, input.signal);
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
    try {
      const response = await input.client.create(
        {
          model: request.request.model,
          state: request.request.state,
          questions: request.request.questions,
        },
        { signal: controller.signal, timeoutMs: remaining },
      );
      if (input.signal?.aborted) throw new SpanEvaluationAbortedError();
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
      release();
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
            state: request.state,
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

/** Small FIFO limiter; waiting counts against the proposal deadline. */
class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<(release: (() => void) | null) => void> = [];

  constructor(private readonly limit: number) {}

  acquire(deadlineMs: number, signal?: AbortSignal): Promise<(() => void) | null> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise(resolve => {
      let settled = false;
      const waiter = (release: (() => void) | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(release);
      };
      const onAbort = () => waiter(null);
      const remaining = deadlineMs - Date.now();
      const timer = setTimeout(() => waiter(null), Math.max(0, remaining));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      const next = this.waiters.shift();
      next?.(this.active < this.limit ? this.makeRelease() : null);
    };
  }
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
