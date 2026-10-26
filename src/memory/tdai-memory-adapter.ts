/**
 * TdaiMemoryAdapter — the anti-corruption layer over the TDAI MemoryCore v3 API.
 *
 * Design §6.3: HTTP + JSON, one uniform envelope `{code, message, request_id, data}`.
 * The TDAI TypeScript SDK is deliberately NOT used: it leaks v3 paths and data
 * shapes, and its error model is inconsistent (meta layer uses
 * `"{error_code}: {detail}"`, the skill layer uses five digit codes, and the data
 * plane uses plain text). Everything TDAI-specific is contained in this file so
 * that a contract change lands in exactly one place.
 *
 * The adapter owns no policy: it does not decide what to deposit, what to
 * recall, or who may see what. It only speaks the protocol.
 */

import type { MemoryPort } from './memory-port.js';
import {
  MemoryPortError,
  type MemoryAsset,
  type MemoryEngineHealth,
  type MemoryFlushBatch,
  type MemoryMaterialization,
  type MemoryScope,
  type MemorySearchResult,
} from './memory-types.js';
import { memoryScopeFields } from './memory-scope.js';
import { interpretEngineHealth } from './memory-sidecar.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 2_000;

/** TDAI `/v3/conversation/add` accepts 1–100 messages. */
const MAX_MESSAGES_PER_DEPOSIT = 100;
/** TDAI `messages[].content` accepts 1–8192 characters. */
const MAX_MESSAGE_CHARS = 8_192;

/** Bound one message so a long answer cannot fail the whole deposit. */
function boundMessage(value: string): string {
  if (value.length === 0) return '(empty)';
  if (value.length <= MAX_MESSAGE_CHARS) return value;
  const marker = '…[truncated]';
  return `${value.slice(0, MAX_MESSAGE_CHARS - marker.length)}${marker}`;
}
const DEFAULT_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 200;
/**
 * TDAI v3 has no `/v3/atomic/get`: L1 atoms are addressable by id only through
 * `/v3/atomic/update` and `/v3/atomic/delete`. Materializing one atom therefore
 * needs a bounded paginated scan over `/v3/atomic/query`. The bound keeps a
 * pathological account from turning one recall into an unbounded crawl.
 */
const MATERIALIZE_SCAN_PAGES = 10;
const MATERIALIZE_PAGE_SIZE = 100;

/** TDAI v3 unified response envelope. */
interface TdaiEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
}

export interface TdaiMemoryAdapterOptions {
  baseUrl: string;
  serviceId: string;
  /** Bearer gate for the engine. Never written into the Server `process.env`. */
  kernelAuthToken?: string;
  /** Account-scoped read-only user key for the meta plane. */
  userKey?: string;
  timeoutMs?: number;
  /**
   * Recall timeout. Recall runs inside a Planner turn, so it must stay short:
   * an unavailable engine may never stall a turn (design S2, ≤ 2s).
   */
  searchTimeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface AtomicDetail {
  id: string;
  version?: number | string;
  type: string;
  content: string;
  background?: string | null;
  created_at?: string;
  updated_at?: string;
  score?: number;
}

interface AtomicSearchData {
  items?: AtomicDetail[];
}

interface AtomicQueryData {
  items?: AtomicDetail[];
  total?: number;
}

interface ConversationAddData {
  accepted_ids?: string[];
  total_count?: number;
}

interface CoreReadData {
  content?: string | null;
  updated_at?: string | null;
}

interface AtomicUpdateData {
  id?: string;
  version?: string | number;
  updated_at?: string;
}

interface AtomicDeleteData {
  deleted_count?: number;
}

export class TdaiMemoryAdapter implements MemoryPort {
  private readonly baseUrl: string;
  private readonly serviceId: string;
  private readonly timeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly retries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: TdaiMemoryAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.serviceId = options.serviceId;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    this.retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async health(): Promise<MemoryEngineHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ready: false, ftsAvailable: false, detail: `health_http_${response.status}` };
      }
      const body = await response.json() as {
        status?: string;
        version?: string;
        stores?: { ftsAvailable?: boolean };
      };
      // One health verdict shared with the sidecar supervisor (review P2-5).
      return interpretEngineHealth(body);
    } catch (error) {
      return {
        ready: false,
        ftsAvailable: false,
        detail: `health_unreachable: ${(error as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async deposit(batch: MemoryFlushBatch, scope: MemoryScope): Promise<{ accepted: number }> {
    const messages = batch.turns.flatMap(turn => [
      { role: 'user', content: boundMessage(turn.userInput) },
      { role: 'assistant', content: boundMessage(turn.assistantAnswer) },
    ]);
    // The engine rejects more than 100 messages. Failing here with a clear
    // error beats a rejected request that never advances the cursor
    // (review P1-4); the caller also bounds the batch upstream.
    if (messages.length === 0 || messages.length > MAX_MESSAGES_PER_DEPOSIT) {
      throw new MemoryPortError(
        'memory_request_invalid',
        `memory_deposit_message_budget: ${messages.length}`,
      );
    }
    const data = await this.call<ConversationAddData>('/v3/conversation/add', {
      session_id: batch.conversationId,
      messages,
      ...memoryScopeFields(scope),
    });
    return { accepted: data?.total_count ?? messages.length };
  }

  async search(input: {
    query: string;
    limit: number;
    type?: string;
  }, scope: MemoryScope): Promise<MemorySearchResult> {
    try {
      const data = await this.call<AtomicSearchData>('/v3/atomic/search', {
        query: input.query,
        limit: Math.max(1, Math.min(100, input.limit)),
        ...(input.type ? { type: input.type } : {}),
        ...memoryScopeFields(scope),
      }, this.searchTimeoutMs);
      return { items: (data?.items ?? []).map(toCandidate), degraded: false };
    } catch (error) {
      if (error instanceof MemoryPortError && error.code === 'memory_engine_unavailable') {
        return { items: [], degraded: true, degradedReason: error.detail ?? error.message };
      }
      throw error;
    }
  }

  async materialize(memoryId: string, scope: MemoryScope): Promise<MemoryMaterialization> {
    for (let page = 0; page < MATERIALIZE_SCAN_PAGES; page++) {
      const data = await this.call<AtomicQueryData>('/v3/atomic/query', {
        limit: MATERIALIZE_PAGE_SIZE,
        offset: page * MATERIALIZE_PAGE_SIZE,
        ...memoryScopeFields(scope),
      });
      const items = data?.items ?? [];
      const match = items.find(item => item.id === memoryId);
      if (match) return toMaterialization(match);
      if (items.length === 0) break;
      const total = data?.total ?? 0;
      // A missing total means the engine did not report one; keep scanning
      // until the page runs dry or the scan bound is reached.
      if (total > 0 && (page + 1) * MATERIALIZE_PAGE_SIZE >= total) break;
    }
    throw new MemoryPortError('memory_asset_not_found', `memory_asset_not_found: ${memoryId}`);
  }

  async listAssets(input: {
    limit: number;
    offset: number;
    includeDisabled: boolean;
  }, scope: MemoryScope): Promise<{ items: readonly MemoryAsset[]; total: number }> {
    const data = await this.call<AtomicQueryData>('/v3/atomic/query', {
      limit: Math.max(1, Math.min(100, input.limit)),
      offset: Math.max(0, input.offset),
      ...memoryScopeFields(scope),
    });
    const items = (data?.items ?? []).map(item => toAsset(item, scope));
    return { items, total: data?.total ?? items.length };
  }

  async updateAsset(input: {
    memoryId: string;
    content: string;
  }, scope: MemoryScope): Promise<{ memoryId: string; version: string }> {
    const data = await this.call<AtomicUpdateData>('/v3/atomic/update', {
      id: input.memoryId,
      content: input.content,
      ...memoryScopeFields(scope),
    });
    return { memoryId: input.memoryId, version: String(data?.version ?? '') };
  }

  async deleteAsset(memoryId: string, scope: MemoryScope): Promise<{ deleted: boolean }> {
    const data = await this.call<AtomicDeleteData>('/v3/atomic/delete', {
      ids: [memoryId],
      ...memoryScopeFields(scope),
    });
    return { deleted: (data?.deleted_count ?? 0) > 0 };
  }

  async readPersona(scope: MemoryScope): Promise<{ content: string | null; updatedAt: string | null }> {
    const data = await this.call<CoreReadData>('/v3/core/read', { ...memoryScopeFields(scope) });
    return { content: data?.content ?? null, updatedAt: data?.updated_at ?? null };
  }

  /**
   * One v3 RPC call: envelope parsing, timeout, error normalization and a
   * bounded retry for transport-level failures only.
   */
  private async call<T>(path: string, body: unknown, timeoutMs = this.timeoutMs): Promise<T | undefined> {
    const payload = JSON.stringify(body ?? {});
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await this.sleep(RETRY_BASE_DELAY_MS * attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: this.headers(),
          body: payload,
          signal: controller.signal,
        });
        const text = await response.text();
        let envelope: TdaiEnvelope<T> | null = null;
        try {
          envelope = text ? JSON.parse(text) as TdaiEnvelope<T> : null;
        } catch {
          envelope = null;
        }
        if (!response.ok) {
          const message = envelope?.message ?? text ?? `http_${response.status}`;
          if (response.status === 401 || response.status === 403) {
            throw new MemoryPortError('memory_request_failed', `tdai_auth_${response.status}: ${message}`);
          }
          if (response.status === 404) {
            throw new MemoryPortError('memory_asset_not_found', `tdai_not_found: ${message}`);
          }
          if (response.status >= 500 || response.status === 429) {
            lastError = new MemoryPortError('memory_request_failed', `tdai_http_${response.status}: ${message}`);
            continue;
          }
          throw new MemoryPortError('memory_request_failed', `tdai_http_${response.status}: ${message}`);
        }
        if (!envelope) {
          throw new MemoryPortError('memory_request_failed', 'tdai_invalid_envelope');
        }
        if (envelope.code !== 0) {
          throw new MemoryPortError('memory_request_failed',
            `tdai_code_${envelope.code}: ${envelope.message ?? 'unknown'}`);
        }
        return envelope.data;
      } catch (error) {
        if (error instanceof MemoryPortError) {
          if (error.code === 'memory_request_failed') {
            lastError = error;
            if (attempt < this.retries) continue;
          }
          throw error;
        }
        lastError = new MemoryPortError('memory_engine_unavailable',
          `tdai_unreachable: ${(error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    const failure = lastError instanceof MemoryPortError
      ? lastError
      : new MemoryPortError('memory_engine_unavailable', 'tdai_unreachable');
    throw failure;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-tdai-service-id': this.serviceId,
    };
    if (this.options.kernelAuthToken) {
      headers.Authorization = `Bearer ${this.options.kernelAuthToken}`;
    }
    if (this.options.userKey) {
      headers['x-tdai-user-key'] = this.options.userKey;
    }
    return headers;
  }
}

function toCandidate(item: AtomicDetail) {
  return {
    id: item.id,
    type: item.type,
    content: item.content,
    background: item.background ?? null,
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
    score: typeof item.score === 'number' ? item.score : 0,
  };
}

function toMaterialization(item: AtomicDetail): MemoryMaterialization {
  return {
    id: item.id,
    type: item.type,
    content: item.content,
    background: item.background ?? null,
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
  };
}

function toAsset(item: AtomicDetail, scope: MemoryScope): MemoryAsset {
  return {
    id: item.id,
    memoryId: item.id,
    type: item.type,
    content: item.content,
    background: item.background ?? null,
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
    score: typeof item.score === 'number' ? item.score : undefined,
    source: 'conversation',
    workspaceId: null,
    enabled: true,
  };
}
