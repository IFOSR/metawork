/**
 * MemoryService — the application-level memory behavior.
 *
 * Owns the parts of the memory contract that are policy, not protocol:
 *   - when a batch of turns may be deposited (idle / fallback thresholds);
 *   - that a batch is deposited as a whole, never turn by turn (§5.3);
 *   - that secrets never reach the engine (§8);
 *   - that recall degrades to an empty result instead of failing a task (§6.6);
 *   - that a memory reaches an Executor only through evidence (pull semantics).
 *
 * The engine protocol itself lives in the Memory Port implementation.
 */

import type { MemoryPort } from './memory-port.js';
import { MemorySanitizer } from './memory-sanitizer.js';
import { deriveMemoryScope } from './memory-scope.js';
import type {
  MemoryAsset,
  MemoryAssetSummary,
  MemoryFlushBatch,
  MemoryMaterialization,
  MemoryScope,
  MemorySearchResult,
  MemoryTurnCandidate,
} from './memory-types.js';
import type { MemoryBindingsRepo } from '../storage/memory-bindings-repo.js';
import type { MemoryFlushCursorRepo } from '../storage/memory-flush-cursor-repo.js';
import {
  MEMORY_MAX_TURNS_PER_DEPOSIT,
  type MemoryTurnSource,
} from '../storage/memory-turn-source.js';

export interface MemoryFlushThresholds {
  /** A conversation is idle after this long without a new turn. */
  idleAfterMs: number;
  /** Unflushed turns that force a flush even when the conversation is active. */
  maxUnflushedTurns: number;
  /**
   * Maximum **turns** deposited in one batch. Capped by the engine's message
   * budget (one turn is two messages), so this can never produce an oversized
   * request (review P1-4).
   */
  maxBatchTurns: number;
  /** Conversations inspected per tick. */
  maxConversationsPerTick: number;
}

export const MEMORY_FLUSH_THRESHOLDS: MemoryFlushThresholds = {
  idleAfterMs: 10 * 60 * 1000,
  maxUnflushedTurns: 20,
  maxBatchTurns: MEMORY_MAX_TURNS_PER_DEPOSIT,
  maxConversationsPerTick: 25,
};

export interface MemoryFlushOutcome {
  conversationId: string;
  flushed: number;
  refused: number;
  sanitized: boolean;
  advancedTo: number;
  error?: string;
}

export interface MemoryServiceOptions {
  port: MemoryPort;
  bindings: MemoryBindingsRepo;
  cursors: MemoryFlushCursorRepo;
  turns: MemoryTurnSource;
  sanitizer?: MemorySanitizer;
  thresholds?: Partial<MemoryFlushThresholds>;
  now?: () => number;
  logger?: (message: string) => void;
}

export class MemoryService {
  private readonly port: MemoryPort;
  private readonly bindings: MemoryBindingsRepo;
  private readonly cursors: MemoryFlushCursorRepo;
  private readonly turns: MemoryTurnSource;
  private readonly sanitizer: MemorySanitizer;
  private readonly thresholds: MemoryFlushThresholds;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;

  constructor(options: MemoryServiceOptions) {
    this.port = options.port;
    this.bindings = options.bindings;
    this.cursors = options.cursors;
    this.turns = options.turns;
    this.sanitizer = options.sanitizer ?? new MemorySanitizer();
    this.thresholds = { ...MEMORY_FLUSH_THRESHOLDS, ...options.thresholds };
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? (() => undefined);
  }

  scopeFor(accountId: string): MemoryScope {
    return deriveMemoryScope(accountId);
  }

  /**
   * Flush one conversation. Only completed turns are deposited, and only after
   * the sanitizer has approved them. The cursor advances only when the engine
   * accepted the batch, so a failed flush is retried on the next tick.
   */
  async flushConversation(input: {
    accountId: string;
    conversationId: string;
    workspaceId?: string | null;
    force?: boolean;
  }): Promise<MemoryFlushOutcome> {
    const scope = this.scopeFor(input.accountId);
    const cursor = this.cursors.lastSequence(input.accountId, input.conversationId);
    const candidates = this.turns.completedTurnsAfter({
      accountId: input.accountId,
      conversationId: input.conversationId,
      afterSequence: cursor,
      maxTurns: this.thresholds.maxBatchTurns,
    });
    if (!candidates.length) {
      // Nothing eligible after the cursor. If ineligible turns (failed,
      // cancelled, blocked) still sit there, skip past them: otherwise they
      // would be re-scanned on every tick and hide every later eligible turn
      // behind the page boundary (review P1-6).
      const skipped = this.skipIneligibleTurns(input.accountId, input.conversationId, cursor);
      return {
        conversationId: input.conversationId,
        flushed: 0,
        refused: 0,
        sanitized: false,
        advancedTo: skipped,
      };
    }
    if (!input.force && candidates.length < this.thresholds.maxUnflushedTurns) {
      const idle = this.isIdle(input.accountId, input.conversationId);
      if (!idle) {
        return { conversationId: input.conversationId, flushed: 0, refused: 0, sanitized: false, advancedTo: cursor };
      }
    }

    const sanitized = this.sanitizer.sanitizeTurns(candidates);
    if (!sanitized.turns.length) {
      // Everything was refused. The cursor still advances past the refused turns
      // so a poisoned turn is not retried forever.
      const advancedTo = this.highestSequence(candidates);
      this.cursors.advance(input.accountId, input.conversationId, advancedTo, true);
      return {
        conversationId: input.conversationId,
        flushed: 0,
        refused: sanitized.refused,
        sanitized: sanitized.sanitized > 0,
        advancedTo,
      };
    }

    const batch: MemoryFlushBatch = {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId ?? null,
      turns: sanitized.turns,
    };
    try {
      const result = await this.port.deposit(batch, scope);
      const advancedTo = this.highestSequence(candidates);
      // Sticky provenance: a segment that needed redaction marks this
      // conversation, so assets recalled from it carry `source='sanitized'`
      // (design §8.2, review P2-4).
      this.cursors.advance(input.accountId, input.conversationId, advancedTo, sanitized.sanitized > 0);
      return {
        conversationId: input.conversationId,
        flushed: result.accepted,
        refused: sanitized.refused,
        sanitized: sanitized.sanitized > 0,
        advancedTo,
      };
    } catch (error) {
      const message = (error as Error).message;
      this.logger(`memory flush failed for ${input.conversationId}: ${message}`);
      return {
        conversationId: input.conversationId,
        flushed: 0,
        refused: sanitized.refused,
        sanitized: sanitized.sanitized > 0,
        advancedTo: cursor,
        error: message,
      };
    }
  }

  /**
   * Flush every conversation that is idle or over the fallback threshold.
   * Failures are contained per conversation: one bad conversation never stops
   * the others and never touches the conversation or execution path.
   */
  async flushPending(input: { accountId: string }): Promise<MemoryFlushOutcome[]> {
    const now = this.now();
    const idle = this.cursors.listPendingCandidates({
      accountId: input.accountId,
      limit: this.thresholds.maxConversationsPerTick,
      now,
      idleAfterMs: this.thresholds.idleAfterMs,
    });
    const overflow = this.cursors.listOverflowCandidates({
      accountId: input.accountId,
      limit: this.thresholds.maxConversationsPerTick,
      minUnflushedTurns: this.thresholds.maxUnflushedTurns,
    });
    const conversations = [...new Set([...idle, ...overflow])]
      .slice(0, this.thresholds.maxConversationsPerTick);
    const outcomes: MemoryFlushOutcome[] = [];
    for (const conversationId of conversations) {
      outcomes.push(await this.flushConversation({
        accountId: input.accountId,
        conversationId,
        force: overflow.includes(conversationId),
      }));
    }
    return outcomes;
  }

  /**
   * Deposit everything still pending, regardless of the idle window.
   *
   * Used when the Server shuts down, where the design requires a final
   * deposition so a conversation that never reached the idle threshold or the
   * fallback turn count is not lost (design §5.2, review P1-2).
   *
   * The loop repeats because a single batch is bounded by the engine's message
   * budget: a long conversation needs several passes to drain.
   */
  async flushAll(input: { accountId: string; maxPasses?: number }): Promise<MemoryFlushOutcome[]> {
    const maxPasses = Math.max(1, input.maxPasses ?? 20);
    const outcomes: MemoryFlushOutcome[] = [];
    for (let pass = 0; pass < maxPasses; pass++) {
      const conversations = this.cursors.listConversationsWithUndepositedTurns({
        accountId: input.accountId,
        limit: this.thresholds.maxConversationsPerTick,
      });
      if (!conversations.length) break;
      let progressed = false;
      for (const conversationId of conversations) {
        const before = this.cursors.lastSequence(input.accountId, conversationId);
        const outcome = await this.flushConversation({
          accountId: input.accountId,
          conversationId,
          force: true,
        });
        outcomes.push(outcome);
        // Progress means the cursor actually moved. A failed deposit must not
        // spin the loop.
        if (!outcome.error && this.cursors.lastSequence(input.accountId, conversationId) > before) {
          progressed = true;
        }
      }
      if (!progressed) break;
    }
    return outcomes;
  }

  /**
   * Advance the cursor past trailing ineligible turns (failed, cancelled,
   * blocked, or same-session system commands). Returns the new cursor.
   *
   * This is what stops a run of ineligible turns from hiding later eligible
   * ones behind the page boundary (review P1-6). It only skips when nothing
   * eligible remains, so a refusable-but-eligible turn is still retried by the
   * normal path.
   */
  private skipIneligibleTurns(accountId: string, conversationId: string, cursor: number): number {
    const newest = this.cursors.newestSequence(accountId, conversationId);
    if (newest <= cursor) return cursor;
    // Only move forward when the newest turn itself is ineligible; otherwise the
    // eligible turns between the cursor and the newest one would be skipped.
    if (!this.isTrailingTurnIneligible(accountId, conversationId, newest)) return cursor;
    this.cursors.advance(accountId, conversationId, newest);
    return newest;
  }

  private isTrailingTurnIneligible(accountId: string, conversationId: string, sequence: number): boolean {
    // `completedTurnsAfter` already proved there is no eligible turn after the
    // cursor, so a newer newest-sequence means the tail is ineligible.
    const candidates = this.turns.completedTurnsAfter({
      accountId,
      conversationId,
      afterSequence: sequence - 1,
      maxTurns: 1,
    });
    return candidates.length === 0;
  }

  /**
   * Recall candidate memories for the Planner. A degraded engine yields an
   * empty result with the degraded flag set; the task chain never fails.
   */
  async search(input: {
    accountId: string;
    query: string;
    limit: number;
    type?: string;
  }): Promise<MemorySearchResult> {
    const scope = this.scopeFor(input.accountId);
    try {
      const result = await this.port.search({
        query: input.query,
        limit: input.limit,
        ...(input.type ? { type: input.type } : {}),
      }, scope);
      return result;
    } catch (error) {
      return {
        items: [],
        degraded: true,
        degradedReason: (error as Error).message,
      };
    }
  }

  /**
   * Materialize one memory for execution evidence. The asset must belong to the
   * account and must be enabled; otherwise the evidence is refused explicitly
   * and never faked with empty content.
   */
  async materialize(input: {
    accountId: string;
    memoryId: string;
  }): Promise<MemoryMaterialization> {
    const binding = this.bindings.findEnabledForAccount(input.memoryId, input.accountId);
    if (!binding) {
      throw new Error(`memory_not_authorized: ${input.memoryId}`);
    }
    const scope = this.scopeFor(input.accountId);
    return this.port.materialize(binding.tdaiMemoryId, scope);
  }

  /** The local binding of one memory, or null when it is unknown or disabled. */
  bindingFor(input: { accountId: string; memoryId: string }) {
    return this.bindings.findEnabledForAccount(input.memoryId, input.accountId);
  }

  /** Bind a recalled memory locally so that it can be referenced and governed. */
  bind(input: {
    accountId: string;
    tdaiMemoryId: string;
    workspaceId?: string | null;
    /** Explicit provenance override; otherwise derived from the deposition state. */
    source?: 'conversation' | 'sanitized';
    /** Conversation that produced this memory, used to resolve provenance. */
    conversationId?: string | null;
    content?: string | null;
    confidence?: number | null;
  }) {
    // Provenance (design §8.2, review P2-4): when the originating conversation
    // is known, use its own flag; otherwise fall back to the account-level fact,
    // which never claims clean content if a redaction happened anywhere.
    const source = input.source
      ?? ((input.conversationId
        ? this.cursors.isSanitized(input.accountId, input.conversationId)
        : this.cursors.hasSanitizedSegments(input.accountId))
        ? 'sanitized'
        : 'conversation');
    return this.bindings.upsert({
      tdaiMemoryId: input.tdaiMemoryId,
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? null,
      source,
      content: input.content ?? null,
      confidence: input.confidence ?? null,
    });
  }

  /** Management view of the account's memory assets. */
  async listAssets(input: {
    accountId: string;
    limit: number;
    offset: number;
    includeDisabled: boolean;
  }): Promise<{ items: MemoryAsset[]; total: number }> {
    const scope = this.scopeFor(input.accountId);
    const remote = await this.port.listAssets({
      limit: input.limit,
      offset: input.offset,
      includeDisabled: input.includeDisabled,
    }, scope);
    const items = remote.items.map(asset => {
      const binding = this.bindings.findByTdaiMemoryId(asset.id);
      return {
        ...asset,
        memoryId: binding?.memoryId ?? asset.id,
        enabled: binding ? binding.enabled : true,
        workspaceId: binding?.workspaceId ?? null,
        source: binding?.source ?? asset.source,
      };
    });
    return { items, total: remote.total };
  }

  /** Local summaries of the bound assets, independent of the engine. */
  listBindings(input: {
    accountId: string;
    limit: number;
    offset: number;
    includeDisabled: boolean;
  }): { items: MemoryAssetSummary[]; total: number } {
    const page = this.bindings.listByAccount(input);
    return { items: this.bindings.toSummaries(page.items), total: page.total };
  }

  async setEnabled(input: {
    accountId: string;
    memoryId: string;
    enabled: boolean;
  }): Promise<MemoryAssetSummary | null> {
    const record = this.bindings.setEnabled(input.memoryId, input.accountId, input.enabled);
    return record ? this.bindings.toSummaries([record])[0]! : null;
  }

  async deleteAsset(input: { accountId: string; memoryId: string }): Promise<boolean> {
    const binding = this.bindings.findByMemoryId(input.memoryId);
    if (!binding || binding.accountId !== input.accountId) return false;
    const scope = this.scopeFor(input.accountId);
    await this.port.deleteAsset(binding.tdaiMemoryId, scope);
    return this.bindings.delete(input.memoryId, input.accountId);
  }

  private isIdle(accountId: string, conversationId: string): boolean {
    return this.cursors.isIdle({
      accountId,
      conversationId,
      now: this.now(),
      idleAfterMs: this.thresholds.idleAfterMs,
    });
  }

  private highestSequence(turns: readonly MemoryTurnCandidate[]): number {
    let highest = 0;
    for (const turn of turns) highest = Math.max(highest, turn.sequence);
    return highest;
  }
}
