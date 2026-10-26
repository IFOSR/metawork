/**
 * Memory Port: the single seam between MetaWork and the memory engine.
 *
 * Contract (design §6.6):
 *   1. Cross-process memory access happens only through this port.
 *   2. Direction is single: MetaWork is the only client; the engine never calls back.
 *   3. Memory bodies are materialized on the host side only.
 *   4. Credentials are read on demand from the SecretStore; they never enter the
 *      Server `process.env`.
 *   5. Memory reaches an Executor only through `task_execution_evidence`.
 *   6. When the engine is unavailable, recall returns empty with `degraded` set and
 *      the task chain never fails.
 *   7. Account scope is the only isolation boundary.
 *   8. MetaWork writes L0 only; L1/L2/L3 are produced by the engine.
 *
 * Pure contract module: no http, database or planner imports.
 */

import type {
  MemoryAsset,
  MemoryAssetSummary,
  MemoryEngineHealth,
  MemoryFlushBatch,
  MemoryMaterialization,
  MemoryPortError,
  MemoryScope,
  MemorySearchResult,
} from './memory-types.js';

export interface MemoryPort {
  /** Engine health including the BM25/FTS5 gate. */
  health(): Promise<MemoryEngineHealth>;

  /**
   * S1 — deposit a batch of completed conversation turns into the L0 layer.
   * Fire-and-forget semantics live in the caller; failures must not throw into
   * any conversation or execution path.
   */
  deposit(batch: MemoryFlushBatch, scope: MemoryScope): Promise<{ accepted: number }>;

  /** S2 — recall candidate memory atoms for the account scope. */
  search(input: {
    query: string;
    limit: number;
    type?: string;
  }, scope: MemoryScope): Promise<MemorySearchResult>;

  /** S3 — materialize the full body of one memory atom. */
  materialize(memoryId: string, scope: MemoryScope): Promise<MemoryMaterialization>;

  /** S4 — list the account's memory assets for the management view. */
  listAssets(input: {
    limit: number;
    offset: number;
    includeDisabled: boolean;
  }, scope: MemoryScope): Promise<{ items: readonly MemoryAsset[]; total: number }>;

  /** S4 — update the engine-side content of one memory atom. */
  updateAsset(input: {
    memoryId: string;
    content: string;
  }, scope: MemoryScope): Promise<{ memoryId: string; version: string }>;

  /** S4 — delete one memory atom from the engine. */
  deleteAsset(memoryId: string, scope: MemoryScope): Promise<{ deleted: boolean }>;

  /** S4 — read the L3 persona document for the account scope. */
  readPersona(scope: MemoryScope): Promise<{ content: string | null; updatedAt: string | null }>;
}

export type { MemoryPortError };
