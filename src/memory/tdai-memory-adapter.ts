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
  type MemoryLayer,
  type MemoryMaterialization,
  type MemoryScope,
  type MemorySearchResult,
} from './memory-types.js';
import { memoryScopeFields } from './memory-scope.js';
import { interpretEngineHealth } from './memory-sidecar.js';
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_TIMEOUT_MS = 2_000;

/** TDAI `/v3/conversation/add` accepts 1–100 messages. */
const MAX_MESSAGES_PER_DEPOSIT = 100;
/** TDAI `messages[].content` accepts 1–8192 characters. */
const MAX_MESSAGE_CHARS = 8_192;

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
  revision?: string;
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
  id?: string;
  content?: string | null;
  updated_at?: string | null;
  revision?: string;
}

interface ProfileReadData {
  id?: string;
  title?: string;
  content?: string;
  summary?: string;
  updated_at?: string | null;
  revision?: string;
}

interface ScenarioSearchData {
  items?: Array<{ id: string; title: string; preview: string; revision: string; updated_at?: string | null; score?: number }>;
}

interface ProfileDeleteData {
  deleted?: boolean;
}

interface ProfileQueryData {
  items?: Array<AtomicDetail & { title?: string; layer?: MemoryLayer }>;
  total?: number;
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
    const messages = batch.turns.flatMap(turn => {
      const key = createHash('sha256').update(JSON.stringify([batch.conversationId, turn.turnId,
        turn.userInput, turn.assistantAnswer])).digest('hex');
      return ([['user', turn.userInput], ['assistant', turn.assistantAnswer]] as const).flatMap(([role, text]) => {
        const points = Array.from(text);
        const parts: { id: string; role: string; content: string }[] = [];
        for (let offset = 0; offset < points.length; offset += MAX_MESSAGE_CHARS) {
          parts.push({ id: `${key}:${role}:${offset / MAX_MESSAGE_CHARS}`, role,
            content: points.slice(offset, offset + MAX_MESSAGE_CHARS).join('') });
        }
        return parts;
      });
    });
    if (!messages.length) throw new MemoryPortError('memory_request_invalid', 'memory_empty_batch');
    const batchId = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    for (let offset = 0; offset < messages.length; offset += MAX_MESSAGES_PER_DEPOSIT) {
      const page = messages.slice(offset, offset + MAX_MESSAGES_PER_DEPOSIT);
      const data = await this.call<ConversationAddData>('/v3/metawork/conversation/upsert', {
        session_id: batch.conversationId, messages: page, batch_id: batchId,
        offset, total: messages.length,
        complete: offset + page.length === messages.length, ...memoryScopeFields(scope),
      });
      if (data?.total_count !== page.length) throw new MemoryPortError('memory_request_invalid', 'memory_partial_deposit');
    }
    return { accepted: batch.turns.length * 2 };
  }

  async deleteConversation(conversationId: string, scope: MemoryScope): Promise<boolean> {
    const data = await this.call<{ deleted: boolean }>('/v3/metawork/conversation/delete', {
      session_id: conversationId, ...memoryScopeFields(scope),
    });
    return data?.deleted === true;
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

  async searchScenarios(input: { query: string; limit: number }, scope: MemoryScope) {
    try {
      const data = await this.call<ScenarioSearchData>('/v3/metawork/scenario/search', {
        query: input.query,
        limit: Math.max(1, Math.min(5, input.limit)),
        ...memoryScopeFields(scope),
      }, this.searchTimeoutMs, 0);
      return {
        items: (data?.items ?? []).map(item => ({
          id: item.id, title: item.title, preview: item.preview, revision: item.revision,
          updatedAt: item.updated_at ?? null, score: item.score ?? 0,
        })),
        degraded: false,
      };
    } catch (error) {
      if (error instanceof MemoryPortError && error.code === 'memory_engine_unavailable') {
        return { items: [], degraded: true, degradedReason: error.detail ?? error.message };
      }
      throw error;
    }
  }

  async materialize(memoryId: string, scope: MemoryScope, layer: MemoryLayer = 'l1'): Promise<MemoryMaterialization> {
    if (layer === 'l2') {
      const data = await this.call<ProfileReadData>('/v3/metawork/scenario/read', {
        id: memoryId, ...memoryScopeFields(scope),
      });
      if (!data?.content) throw new MemoryPortError('memory_asset_not_found', `memory_asset_not_found: ${memoryId}`);
      return {
        id: data.id ?? memoryId, type: 'scene', title: data.title ?? memoryId,
        content: data.content, background: data.summary ?? null, createdAt: '',
        updatedAt: data.updated_at ?? '', revision: data.revision ?? digest(data.content), layer,
      };
    }
    if (layer === 'l3') {
      const data = await this.call<CoreReadData>('/v3/core/read', { ...memoryScopeFields(scope) });
      if (!data?.content || data.id !== memoryId) {
        throw new MemoryPortError('memory_asset_not_found', `memory_asset_not_found: ${memoryId}`);
      }
      return {
        id: data.id, type: 'persona', title: 'User persona', content: data.content,
        background: null, createdAt: '', updatedAt: data.updated_at ?? '',
        revision: data.revision ?? digest(data.content), layer,
      };
    }
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
      offset: Math.min(input.offset, 100_000),
      ...memoryScopeFields(scope),
    });
    const atomicTotal = data?.total ?? data?.items?.length ?? 0;
    const profileOffset = Math.max(0, input.offset - atomicTotal);
    const profileLimit = Math.max(1, Math.min(100, input.limit));
    const profiles = await this.call<ProfileQueryData>('/v3/metawork/profile/query', {
      limit: profileLimit,
      offset: profileOffset,
      ...memoryScopeFields(scope),
    });
    const profileItems = profiles?.items ?? [];
    const merged = input.offset < atomicTotal
      ? [...(data?.items ?? []).map(item => toAsset(item, scope)), ...(input.offset + input.limit > atomicTotal
        ? profileItems.slice(0, input.offset + input.limit - atomicTotal).map(item => toProfileAsset(item, scope))
        : [])]
      : profileItems.slice(0, input.limit).map(item => toProfileAsset(item, scope));
    return { items: merged, total: atomicTotal + (profiles?.total ?? profileItems.length) };
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

  async readPersona(scope: MemoryScope): Promise<{ id: string; content: string | null; updatedAt: string | null; revision: string }> {
    const data = await this.call<CoreReadData>('/v3/core/read', { ...memoryScopeFields(scope) }, this.searchTimeoutMs, 0);
    return {
      id: data?.id ?? '', content: data?.content ?? null,
      updatedAt: data?.updated_at ?? null, revision: data?.revision ?? digest(data?.content ?? ''),
    };
  }

  async deleteProfile(memoryId: string, layer: Exclude<MemoryLayer, 'l1'>, scope: MemoryScope): Promise<boolean> {
    const data = await this.call<ProfileDeleteData>('/v3/metawork/profile/delete', {
      id: memoryId, layer, ...memoryScopeFields(scope),
    });
    return data?.deleted === true;
  }

  /**
   * One v3 RPC call: envelope parsing, timeout, error normalization and a
   * bounded retry for transport-level failures only.
   */
  private async call<T>(path: string, body: unknown, timeoutMs = this.timeoutMs, retries = this.retries): Promise<T | undefined> {
    const payload = JSON.stringify(body ?? {});
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
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
            if (attempt < retries) continue;
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
    revision: item.revision ?? digest(item.content),
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
    revision: item.revision ?? digest(item.content),
    layer: 'l1',
  };
}

function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
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
    layer: 'l1',
    title: item.type,
    revision: item.revision ?? digest(item.content),
  };
}

function toProfileAsset(item: AtomicDetail & { title?: string; layer?: MemoryLayer }, scope: MemoryScope): MemoryAsset {
  const layer = item.layer ?? (item.type === 'persona' ? 'l3' : 'l2');
  return {
    id: item.id,
    memoryId: item.id,
    type: item.type,
    content: item.content,
    background: item.background ?? null,
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
    source: 'profile',
    workspaceId: null,
    enabled: true,
    layer,
    title: item.title ?? item.type,
    revision: item.revision ?? digest(item.content),
  };
}
