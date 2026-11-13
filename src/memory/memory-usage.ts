import type { RawUsageEvent } from '../metering/usage-normalizer.js';
import type { UsagePayerResolver } from '../metering/usage-payer.js';
import type { QueryUsageLifecycle } from '../metering/query-lifecycle.js';
import type { MemoryEngineUsage } from './memory-types.js';

/**
 * Bridges the memory engine's own model-call ledger into MetaWork metering.
 *
 * The engine performs extraction/scene/persona model calls against the
 * configured extraction provider, so MetaWork cannot observe those calls at a
 * provider boundary. It reports exact per-call tokens over its authenticated v3
 * route, and this module turns them into the same usage facts every other model
 * call produces (ADR-0042, ADR-0055 D4):
 *
 *   - `sourceId: 'memory'`, `stage: 'context'`, `agentClassRef: 'memory'`;
 *   - payer resolved from the extraction Provider's ownership for the pinned
 *     configuration revision (official → platform/Included, user key →
 *     on-demand), never from an installation default;
 *   - one fact per engine call, deduplicated by the engine instance + sequence;
 *   - a call whose tokens are missing stays explicitly missing, not zero.
 *
 * Background memory work has no user Turn, so the facts are attributed to one
 * durable account-level system Query. That Query is created once and reused, so
 * the timeline and quota still see an account-bound fact.
 */

/** Stable identity of the account-level Query that carries memory usage. */
const MEMORY_QUERY_REQUEST_KEY = 'memory:extraction';
const MEMORY_QUERY_DIGEST = 'memory-extraction-v1';

export interface MemoryUsageDrainerDeps {
  readonly accountId: string;
  /** Engine ledger drain, normally `MemoryService.drainEngineUsage`. */
  readonly drainUsage: () => Promise<readonly MemoryEngineUsage[]>;
  readonly queryLifecycle?: Pick<QueryUsageLifecycle, 'beginQuery'>;
  readonly usageObserver?: (event: RawUsageEvent) => void;
  readonly resolveUsagePayer?: UsagePayerResolver;
  /** Pinned configuration revision of the running memory runtime. */
  readonly configurationRevision: string;
  readonly providerRef: string | null;
  readonly modelRef: string | null;
  readonly now?: () => Date;
}

export interface MemoryUsageDrainer {
  /** Pull the engine ledger once and record every call as a usage fact. */
  drain(): Promise<number>;
}

export function createMemoryUsageDrainer(deps: MemoryUsageDrainerDeps): MemoryUsageDrainer {
  return {
    async drain() {
      if (!deps.usageObserver) return 0;
      const calls = await deps.drainUsage();
      if (calls.length === 0) return 0;
      // Without a Query lifecycle there is no account-bound attribution target.
      // The drained calls are dropped rather than written against an unknown
      // account; the drain itself already cleared the engine ledger.
      const queryId = resolveMemoryQueryId(deps);
      if (!queryId) return 0;
      const payer = deps.providerRef
        ? deps.resolveUsagePayer?.(deps.providerRef, deps.configurationRevision) ?? 'unknown'
        : 'unknown';
      let recorded = 0;
      for (const call of calls) {
        const counters: RawUsageEvent['counters'] = [
          ...(call.inputTokens === null ? [] : [{
            resource: 'model_tokens', metric: 'input', unit: 'token',
            kind: 'delta' as const, value: String(call.inputTokens),
          }]),
          ...(call.outputTokens === null ? [] : [{
            resource: 'model_tokens', metric: 'output', unit: 'token',
            kind: 'delta' as const, value: String(call.outputTokens),
          }]),
        ];
        const missing = counters.length === 2 ? undefined : [
          ...(call.inputTokens === null
            ? [{ resource: 'model_tokens' as const, metric: 'input', unit: 'token' as const }]
            : []),
          ...(call.outputTokens === null
            ? [{ resource: 'model_tokens' as const, metric: 'output', unit: 'token' as const }]
            : []),
        ];
        deps.usageObserver({
          sourceId: 'memory',
          // The engine drains atomically, so this key is the durable identity of
          // one call. A restarted engine starts a new instance id.
          sourceEventKey: `memory:${call.instanceId}:${call.seq}`,
          sourceScope: 'model_request',
          callId: `memory:${call.instanceId}:${call.seq}`,
          queryId,
          taskId: null,
          stage: 'context',
          reason: 'primary',
          payer,
          agentClassRef: 'memory',
          providerRef: deps.providerRef,
          modelId: deps.modelRef ?? (call.model || null),
          capturedAt: call.occurredAt,
          providerResponseId: null,
          counters,
          ...(missing && missing.length > 0 ? { missing } : {}),
        });
        recorded += 1;
      }
      return recorded;
    },
  };
}

/**
 * Resolve (or create once) the account-level Query that pays for background
 * memory work. `beginQuery` is idempotent per (account, ingress, request key), so
 * every drain after the first reuses the same query id.
 */
function resolveMemoryQueryId(deps: MemoryUsageDrainerDeps): string | null {
  if (!deps.queryLifecycle) return null;
  const result = deps.queryLifecycle.beginQuery({
    accountId: deps.accountId,
    ingress: 'system',
    requestKey: MEMORY_QUERY_REQUEST_KEY,
    requestPayloadDigest: MEMORY_QUERY_DIGEST,
    conversationId: null,
    requestId: 'memory-extraction',
    turnId: null,
    executionSegmentId: null,
    acceptedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  if (result.status === 'conflict') throw new Error('memory_query_context_conflict');
  return result.context.queryId;
}
