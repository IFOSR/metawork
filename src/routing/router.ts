import { createHash, randomUUID } from 'node:crypto';

/**
 * Runtime owned Router contract (ADR-0055 D1). The Router is a decision model
 * that selects one already eligible Executor binding for a Subtask. It never
 * writes storage, starts a process, or asks a second policy layer to approve
 * its result.
 */
export interface RouterCandidate {
  readonly agentClassRef: string;
  readonly providerRef: string;
  readonly modelRef: string;
  readonly permissionProfileRef: string;
}

export type RouteExclusionReason =
  | 'disabled'
  | 'missing_capability'
  | 'provider_unavailable'
  | 'model_unavailable'
  | 'capacity_unavailable'
  | 'incompatible';

export interface RouteRequest {
  readonly taskId: string;
  readonly generationId: string;
  readonly subtaskId: string;
  readonly graphRevision: number;
  readonly attemptOrdinal: number;
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly configurationRevision: string;
  readonly candidates: readonly RouterCandidate[];
  readonly excluded: readonly { agentClassRef: string; reason: RouteExclusionReason }[];
  readonly modelCatalog: readonly { providerRef: string; modelRef: string; modelId: string }[];
}

export interface RouteDecision {
  readonly routeDecisionId: string;
  readonly taskId: string;
  readonly attemptOrdinal: number;
  readonly inputSnapshotHash: string;
  readonly candidates: readonly RouterCandidate[];
  readonly excluded: readonly RouteRequest['excluded'][number][];
  readonly selected: RouterCandidate | null;
  readonly decisionModel: { providerRef: string; modelRef: string };
  readonly rationale: string;
  readonly configurationRevision: string;
  readonly generationId: string;
  readonly subtaskId: string;
  readonly graphRevision: number;
  readonly createdAt: string;
  readonly outcome: 'selected' | 'no_candidate';
  /**
   * Metering facts of the model call that produced this decision. They are not
   * persisted with the decision: a replayed decision consumed no new tokens.
   */
  readonly call?: RouterModelCallFacts;
}

export type RouterModelOutput = {
  selectedAgentClassRef: string | null;
  selectedProviderRef?: string;
  selectedModelRef?: string;
  rationale: string;
  /**
   * Decision-model usage for the call that produced this output. Dropped when
   * the adapter reports none.
   */
  usage?: { inputTokens?: number; outputTokens?: number };
  /**
   * True when a decision-model call actually left this process, even if its
   * usage is missing. The Router never fabricates a call that did not happen
   * (disabled policy, missing credential, single candidate).
   */
  callAttempted?: boolean;
  /** Adapter-observed completion time of the decision-model call. */
  occurredAtUtc?: string;
};

/** Decision-model metering facts for one actual Router call. */
export interface RouterModelCallFacts {
  readonly usage?: { inputTokens?: number; outputTokens?: number };
  readonly callAttempted: boolean;
  readonly occurredAtUtc: string;
}

export interface RouterModel {
  decide(input: RouteRequest, signal: AbortSignal): Promise<RouterModelOutput>;
  readonly providerRef: string;
  readonly modelRef: string;
}

export class RouterError extends Error {
  constructor(
    readonly code: 'route_invalid_input' | 'route_invalid_output' | 'route_timeout' | 'route_cancelled' | 'route_process_exit' | 'route_stale_decision',
    message: string,
  ) {
    super(message);
    this.name = 'RouterError';
  }
}

export interface RouterServiceOptions {
  readonly model: RouterModel;
  readonly timeoutMs?: number;
  readonly now?: () => string;
  readonly createId?: () => string;
}

export class RouterService {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(private readonly options: RouterServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => `route_${cryptoRandom()}`);
  }

  async decide(input: RouteRequest, signal?: AbortSignal): Promise<RouteDecision> {
    if (signal?.aborted) throw new RouterError('route_cancelled', 'router decision was cancelled');
    // Retain the exact input observed before the asynchronous model call. Neither
    // a caller updating its graph nor an adapter mutating its argument may
    // rewrite the facts certified by this decision.
    input = structuredClone(input);
    const candidates = dedupeCandidates(input.candidates);
    const excluded = new Set(input.excluded.map(item => item.agentClassRef));
    if (candidates.some(candidate => !candidate.agentClassRef || !candidate.permissionProfileRef
      || excluded.has(candidate.agentClassRef)
      || !input.modelCatalog.some(model => model.providerRef === candidate.providerRef && model.modelRef === candidate.modelRef))) {
      throw new RouterError('route_invalid_input', 'Router candidate is excluded or absent from the pinned model catalog');
    }
    const snapshotHash = routeInputHash({ ...input, candidates });
    const controller = new AbortController();
    const unlink = linkAbort(signal, controller);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let unlinkAbortPromise: () => void = () => undefined;
    try {
      if (candidates.length === 0) {
        return {
          routeDecisionId: this.createId(),
          taskId: input.taskId,
          attemptOrdinal: input.attemptOrdinal,
          inputSnapshotHash: snapshotHash,
          candidates,
          excluded: input.excluded,
          selected: null,
          decisionModel: { providerRef: this.options.model.providerRef, modelRef: this.options.model.modelRef },
          rationale: 'no eligible Router candidate is available',
          configurationRevision: input.configurationRevision,
          generationId: input.generationId,
          subtaskId: input.subtaskId,
          graphRevision: input.graphRevision,
          createdAt: this.now(),
          outcome: 'no_candidate',
        };
      }
      const timeoutMs = this.options.timeoutMs ?? 30_000;
      const timeoutPromise = timeoutMs > 0
        ? new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              controller.abort();
              reject(new RouterError('route_timeout', 'router decision timed out'));
            }, timeoutMs);
          })
        : null;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            if (signal.aborted) reject(new RouterError('route_cancelled', 'router decision was cancelled'));
            else {
              const onAbort = () => reject(new RouterError('route_cancelled', 'router decision was cancelled'));
              signal.addEventListener('abort', onAbort, { once: true });
              unlinkAbortPromise = () => signal.removeEventListener('abort', onAbort);
            }
          })
        : null;
      const output = await Promise.race([
        this.options.model.decide(structuredClone({ ...input, candidates }), controller.signal),
        ...(timeoutPromise ? [timeoutPromise] : []),
        ...(abortPromise ? [abortPromise] : []),
      ]);
      if (signal?.aborted) throw new RouterError('route_cancelled', 'router decision was cancelled');
      if (!output || typeof output.rationale !== 'string' || output.rationale.trim().length === 0
        || (output.selectedAgentClassRef !== null && typeof output.selectedAgentClassRef !== 'string')) {
        throw new RouterError('route_invalid_output', 'Router returned an invalid decision');
      }
      const matches = candidates.filter(candidate => candidate.agentClassRef === output.selectedAgentClassRef
        && (output.selectedProviderRef === undefined || candidate.providerRef === output.selectedProviderRef)
        && (output.selectedModelRef === undefined || candidate.modelRef === output.selectedModelRef));
      if (output.selectedAgentClassRef !== null && matches.length > 1) {
        throw new RouterError('route_invalid_output', 'Router must select one exact AgentClass/provider/model binding');
      }
      const selected = output.selectedAgentClassRef === null ? null : matches[0] ?? null;
      if (output.selectedAgentClassRef !== null && !selected) {
        throw new RouterError('route_invalid_output', 'Router selected an unknown AgentClass');
      }
      return {
        routeDecisionId: this.createId(),
        taskId: input.taskId,
        attemptOrdinal: input.attemptOrdinal,
        inputSnapshotHash: snapshotHash,
        candidates,
        excluded: input.excluded,
        selected,
        decisionModel: { providerRef: this.options.model.providerRef, modelRef: this.options.model.modelRef },
        rationale: output.rationale.trim().slice(0, 2_000),
        configurationRevision: input.configurationRevision,
        generationId: input.generationId,
        subtaskId: input.subtaskId,
        graphRevision: input.graphRevision,
        createdAt: this.now(),
        outcome: selected ? 'selected' : 'no_candidate',
        call: {
          ...(output.usage ? { usage: output.usage } : {}),
          callAttempted: output.callAttempted ?? true,
          occurredAtUtc: output.occurredAtUtc ?? this.now(),
        },
      };
    } catch (error) {
      if (controller.signal.aborted) {
        if (signal?.aborted) throw new RouterError('route_cancelled', 'router decision was cancelled');
        throw new RouterError('route_timeout', 'router decision timed out');
      }
      if (error instanceof RouterError) throw error;
      throw new RouterError('route_process_exit', error instanceof Error ? error.message : String(error));
    } finally {
      if (timeout) clearTimeout(timeout);
      unlinkAbortPromise();
      unlink();
    }
  }

  /** Rejects a decision produced for an older graph/configuration snapshot. */
  assertFresh(decision: RouteDecision, current: RouteRequest): void {
    if (decision.configurationRevision !== current.configurationRevision
      || decision.generationId !== current.generationId
      || decision.subtaskId !== current.subtaskId
      || decision.taskId !== current.taskId
      || decision.attemptOrdinal !== current.attemptOrdinal
      || decision.graphRevision !== current.graphRevision
      || decision.inputSnapshotHash !== routeDecisionInputHash(current)) {
      throw new RouterError('route_stale_decision', 'router decision is stale');
    }
  }
}

export function routeDecisionInputHash(input: RouteRequest): string {
  return routeInputHash({ ...input, candidates: dedupeCandidates(input.candidates) });
}

function dedupeCandidates(candidates: readonly RouterCandidate[]): RouterCandidate[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = JSON.stringify([candidate.agentClassRef, candidate.providerRef, candidate.modelRef, candidate.permissionProfileRef]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function routeInputHash(input: RouteRequest): string {
  return createHash('sha256').update(JSON.stringify({
    taskId: input.taskId,
    generationId: input.generationId,
    subtaskId: input.subtaskId,
    graphRevision: input.graphRevision,
    attemptOrdinal: input.attemptOrdinal,
    goal: input.goal,
    acceptance: input.acceptance,
    configurationRevision: input.configurationRevision,
    candidates: input.candidates.map(candidate => [candidate.agentClassRef, candidate.providerRef,
      candidate.modelRef, candidate.permissionProfileRef]),
    excluded: input.excluded.map(item => [item.agentClassRef, item.reason]),
    modelCatalog: input.modelCatalog.map(item => [item.providerRef, item.modelRef, item.modelId]),
  })).digest('hex');
}

function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function cryptoRandom(): string {
  return randomUUID();
}
