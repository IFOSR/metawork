/**
 * Memory domain vocabulary.
 *
 * The account is the only isolation boundary (design §4.3 / D14). Workspaces,
 * agent roles and conversations are provenance labels, never boundaries.
 *
 * Pure module: no repository, http, planner, kernel or executor imports.
 */

/** TDAI isolation scope. One fixed triple per account (design §6.5). */
export interface MemoryScope {
  accountId: string;
  teamId: string;
  agentId: string;
  userId: string;
}

/** One conversation turn that is a candidate for long-term memory. */
export interface MemoryTurnCandidate {
  turnId: string;
  /** Journal sequence of the turn; the flush cursor advances to this value. */
  sequence: number;
  userInput: string;
  assistantAnswer: string;
  completedAt: string;
}

/** A batch of turns written to the L0 conversation layer in one call. */
export interface MemoryFlushBatch {
  conversationId: string;
  workspaceId: string | null;
  turns: readonly MemoryTurnCandidate[];
}

/** Where a memory asset came from. */
export type MemoryAssetSource = 'conversation' | 'sanitized';

/** A memory atom as surfaced to Planner and the management view. */
export interface MemoryAsset {
  /** TDAI atomic id; stable within the account scope. */
  id: string;
  /** Local stable id used by ContextRef{kind:'memory'}. */
  memoryId: string;
  type: string;
  content: string;
  background: string | null;
  createdAt: string;
  updatedAt: string;
  score?: number;
  source: MemoryAssetSource;
  /** Provenance label only; never an isolation boundary. */
  workspaceId: string | null;
  enabled: boolean;
}

/** A memory candidate returned by search, before it is bound locally. */
export interface MemorySearchCandidate {
  id: string;
  type: string;
  content: string;
  background: string | null;
  createdAt: string;
  updatedAt: string;
  score: number;
}

/** Result of a recall request. */
export interface MemorySearchResult {
  items: readonly MemorySearchCandidate[];
  /** True when the memory engine was unavailable and the result is empty. */
  degraded: boolean;
  /** Human readable reason for the degraded state. */
  degradedReason?: string;
}

/** Health of the memory engine sidecar. */
export interface MemoryEngineHealth {
  ready: boolean;
  /** FTS5 gate: BM25 silently returns empty without it (design R2). */
  ftsAvailable: boolean;
  version?: string;
  detail?: string;
}

/** Result of materializing one memory asset for execution evidence. */
export interface MemoryMaterialization {
  id: string;
  type: string;
  content: string;
  background: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Management view of one bound asset. */
export interface MemoryAssetSummary {
  memoryId: string;
  tdaiMemoryId: string;
  type: string;
  digest: string;
  source: MemoryAssetSource;
  workspaceId: string | null;
  enabled: boolean;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Errors raised by the memory port. */
export type MemoryPortErrorCode =
  | 'memory_engine_unavailable'
  | 'memory_engine_degraded'
  | 'memory_asset_not_found'
  | 'memory_asset_forbidden'
  | 'memory_request_invalid'
  | 'memory_request_failed';

/** Normalized failure surfaced by every Memory Port implementation. */
export class MemoryPortError extends Error {
  constructor(
    readonly code: MemoryPortErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'MemoryPortError';
  }
}
