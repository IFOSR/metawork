/**
 * Feishu card delivery state machine (2026-09-06 plan §5.1/§5.2).
 *
 * One Feishu-only delivery coordinator per delivery scope
 * (`conversationId + taskId + generationId`, never an unstable request-only
 * lifetime). It owns the activity-card lifecycle:
 *
 * ```text
 * idle -> card_created -> card_update_throttled -> card_update_failed
 *      -> create_only_degraded -> terminal_painted -> archived
 * ```
 *
 * Guarantees:
 * 1. Send/update operations are serialized per card key.
 * 2. Duplicate event keys and duplicate failure notices are suppressed; a
 *    broken update path emits at most one diagnostic per scope.
 * 3. Ordinary progress repaint is throttled by one update cooldown; a
 *    degraded scope may only create replacement cards under one replacement
 *    cooldown — never one message per progress event.
 * 4. Terminal and blocker milestones paint immediately.
 * 5. The last known activity snapshot is preserved, so a replacement card
 *    shows the current state instead of starting from an empty card.
 * 6. Every outcome (created/updated/degraded/replaced/terminal/failed/
 *    suppressed) emits an audit record.
 */

export type FeishuCardDeliveryState =
  | 'idle'
  | 'card_created'
  | 'card_update_throttled'
  | 'card_update_failed'
  | 'create_only_degraded'
  | 'terminal_painted'
  | 'archived';

/** §5.2 failure classification for interactive-card updates. */
export type FeishuCardUpdateFailureClass =
  | 'contract'
  | 'not_found'
  | 'permission'
  | 'transient'
  | 'unknown';

export interface FeishuCardDeliveryOps {
  createCard(markdown: string, options: { collapsedMarkdown?: string }): Promise<string | null>;
  updateCard(messageId: string, markdown: string, options: {
    collapsedMarkdown?: string;
  }): Promise<{ ok: boolean; error?: string; classification: FeishuCardUpdateFailureClass }>;
}

export type FeishuCardDeliveryOutcome =
  | 'created'
  | 'updated'
  | 'replaced'
  | 'throttled'
  | 'suppressed'
  | 'terminal';

export interface FeishuCardDeliveryAuditRecord {
  scopeKey: string;
  outcome: FeishuCardDeliveryOutcome | 'degraded' | 'failed';
  state: FeishuCardDeliveryState;
  error?: string;
  classification?: FeishuCardUpdateFailureClass;
}

export interface FeishuCardDeliveryMachineOptions {
  updateCooldownMs?: number;
  replacementCooldownMs?: number;
  nowMs?: () => number;
  /** Duplicate suppression window for identical event keys. */
  onAudit?(record: FeishuCardDeliveryAuditRecord): void;
  /** Emitted at most once per machine (one diagnostic per delivery scope). */
  onDiagnostic?(message: string): void;
}

export interface FeishuCardPaintInput {
  markdown: string;
  collapsedMarkdown?: string | null;
  /** Terminal/blocker milestone: bypasses the update cooldown. */
  immediate?: boolean;
  /** Final paint for the scope; later paints are suppressed. */
  terminal?: boolean;
  /** Duplicate event key suppression. */
  eventKey?: string | null;
}

export interface FeishuCardPaintResult {
  operation: FeishuCardDeliveryOutcome | 'suppressed';
}

const DEFAULT_UPDATE_COOLDOWN_MS = 5_000;
const DEFAULT_REPLACEMENT_COOLDOWN_MS = 5 * 60_000;

export class FeishuCardDeliveryMachine {
  state: FeishuCardDeliveryState = 'idle';
  private readonly ops: FeishuCardDeliveryOps;
  private readonly options: Required<
    Pick<FeishuCardDeliveryMachineOptions, 'updateCooldownMs' | 'replacementCooldownMs'>
  > & FeishuCardDeliveryMachineOptions;
  private messageId: string | null = null;
  private lastPaintAtMs = 0;
  /** Any successful card send (creation or replacement) — the one
   * replacement-cooldown anchor, so degradation can never out-pace it. */
  private lastCardSentAtMs = 0;
  private degraded = false;
  private lastSnapshot: { markdown: string; collapsedMarkdown?: string } | null = null;
  private pending: FeishuCardPaintInput | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly seenEventKeys = new Set<string>();
  private diagnosticSent = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly scopeKey: string,
    ops: FeishuCardDeliveryOps,
    options: FeishuCardDeliveryMachineOptions = {},
  ) {
    this.ops = ops;
    this.options = {
      updateCooldownMs: options.updateCooldownMs ?? DEFAULT_UPDATE_COOLDOWN_MS,
      replacementCooldownMs: options.replacementCooldownMs ?? DEFAULT_REPLACEMENT_COOLDOWN_MS,
      ...options,
    };
  }

  /** Serializes every send/update so card operations never race each other. */
  paint(input: FeishuCardPaintInput): Promise<FeishuCardPaintResult> {
    // The operation must not START before the previous one settles — chaining
    // only the awaiting would still run sends concurrently.
    const result = this.chain.then(
      () => this.paintSerialized(input),
      () => this.paintSerialized(input),
    );
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Coalesced progress paint; throttled by the update cooldown. */
  paintProgress(input: Omit<FeishuCardPaintInput, 'immediate' | 'terminal'>): Promise<FeishuCardPaintResult> {
    return this.paint(input);
  }

  /** Final paint; later paints for the scope are suppressed. */
  paintTerminal(input: Omit<FeishuCardPaintInput, 'immediate' | 'terminal'>): Promise<FeishuCardPaintResult> {
    return this.paint({ ...input, immediate: true, terminal: true });
  }

  archive(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending = null;
    this.state = 'archived';
  }

  private async paintSerialized(input: FeishuCardPaintInput): Promise<FeishuCardPaintResult> {
    if (this.state === 'archived' || this.state === 'terminal_painted') {
      this.audit({ outcome: 'suppressed' });
      return { operation: 'suppressed' };
    }
    if (input.eventKey) {
      if (this.seenEventKeys.has(input.eventKey)) {
        this.audit({ outcome: 'suppressed' });
        return { operation: 'suppressed' };
      }
      this.seenEventKeys.add(input.eventKey);
    }
    this.lastSnapshot = {
      markdown: input.markdown,
      ...(input.collapsedMarkdown ? { collapsedMarkdown: input.collapsedMarkdown } : {}),
    };
    const now = this.options.nowMs?.() ?? Date.now();

    if (this.messageId === null) {
      return this.createCard(input, now);
    }

    if (!this.degraded) {
      if (!input.immediate && this.lastPaintAtMs > 0
        && now - this.lastPaintAtMs < this.options.updateCooldownMs) {
        // Coalesce: keep only the latest snapshot; flush after the cooldown.
        this.pending = input;
        this.state = 'card_update_throttled';
        this.scheduleFlush(this.options.updateCooldownMs - (now - this.lastPaintAtMs));
        this.audit({ outcome: 'throttled' });
        return { operation: 'throttled' };
      }
      const updated = await this.ops.updateCard(this.messageId, input.markdown, {
        ...(input.collapsedMarkdown ? { collapsedMarkdown: input.collapsedMarkdown } : {}),
      });
      if (updated.ok) {
        this.lastPaintAtMs = now;
        this.state = input.terminal ? 'terminal_painted' : 'card_created';
        this.audit({ outcome: input.terminal ? 'terminal' : 'updated' });
        return { operation: input.terminal ? 'terminal' : 'updated' };
      }
      this.onUpdateFailure(updated.error ?? 'unknown', updated.classification);
      if (updated.classification !== 'contract' && updated.classification !== 'not_found') {
        // Transient/unknown/permission failures keep the update path armed for
        // the next paint; the diagnostic already fired once.
        this.state = 'card_update_failed';
        this.audit({ outcome: 'failed', error: updated.error, classification: updated.classification });
        return { operation: 'throttled' };
      }
      // Contract-incompatible or message-not-found responses degrade this
      // scope to create-only immediately (§5.2).
    }

    // Degraded (or freshly degraded) path: replacement cards only under the
    // replacement cooldown, and always from the latest snapshot. Terminal
    // receipts still paint immediately — a degraded scope must never suppress
    // the user's completion/failure signal (§5.1.5).
    if (!input.terminal
      && this.lastCardSentAtMs > 0
      && now - this.lastCardSentAtMs < this.options.replacementCooldownMs) {
      this.pending = input;
      this.scheduleFlush(this.options.replacementCooldownMs - (now - this.lastCardSentAtMs));
      this.audit({ outcome: 'suppressed' });
      return { operation: 'suppressed' };
    }
    return this.createCard(input, now);
  }

  private async createCard(
    input: FeishuCardPaintInput,
    now: number,
  ): Promise<FeishuCardPaintResult> {
    const messageId = await this.ops.createCard(input.markdown, {
      ...(input.collapsedMarkdown ? { collapsedMarkdown: input.collapsedMarkdown } : {}),
    });
    this.lastPaintAtMs = now;
    if (messageId) {
      const isReplacement = this.messageId !== null && messageId !== this.messageId;
      this.messageId = messageId;
      this.lastCardSentAtMs = now;
      if (input.terminal) {
        this.state = 'terminal_painted';
        this.audit({ outcome: 'terminal' });
        return { operation: 'terminal' };
      }
      if (isReplacement) {
        // Stay in degraded mode — the update contract stays broken for this
        // scope until it ends.
        this.state = 'create_only_degraded';
        this.audit({ outcome: 'replaced' });
        return { operation: 'replaced' };
      }
      this.state = 'card_created';
      this.audit({ outcome: 'created' });
      return { operation: 'created' };
    }
    this.audit({ outcome: 'failed', error: 'card create returned no message id' });
    return { operation: 'suppressed' };
  }

  private onUpdateFailure(error: string, classification: FeishuCardUpdateFailureClass): void {
    const degrade = classification === 'contract' || classification === 'not_found';
    if (degrade) {
      this.degraded = true;
      if (this.state !== 'create_only_degraded') {
        this.state = 'create_only_degraded';
        this.audit({ outcome: 'degraded', error, classification });
      }
    }
    if (!this.diagnosticSent) {
      this.diagnosticSent = true;
      this.options.onDiagnostic?.(
        classification === 'permission'
          ? `飞书卡片更新权限不足，降级为低频新发: ${error}`
          : `飞书卡片原地更新失败（${classification}），降级为低频新发: ${error}`,
      );
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) return;
    const waitMs = Math.max(0, delayMs);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const pending = this.pending;
      this.pending = null;
      if (!pending || this.state === 'archived' || this.state === 'terminal_painted') return;
      void this.paint({ ...pending, eventKey: null });
    }, waitMs);
    this.flushTimer.unref?.();
  }

  private audit(record: Omit<FeishuCardDeliveryAuditRecord, 'scopeKey' | 'state'>): void {
    try {
      this.options.onAudit?.({ scopeKey: this.scopeKey, state: this.state, ...record });
    } catch {
      // Audit must never break delivery.
    }
  }
}

/**
 * Bridge-level registry: card slots live for the bridge lifetime, keyed by
 * stable delivery scope, so a retried or re-attached request reuses the same
 * card instead of leaking a new one per request.
 */
export class FeishuCardDeliveryRegistry {
  private readonly machines = new Map<string, FeishuCardDeliveryMachine>();

  constructor(
    private readonly deps: {
      opsFor: (scopeKey: string) => FeishuCardDeliveryOps;
      options?: FeishuCardDeliveryMachineOptions;
    },
  ) {}

  machineFor(scopeKey: string): FeishuCardDeliveryMachine {
    const existing = this.machines.get(scopeKey);
    if (existing) return existing;
    const machine = new FeishuCardDeliveryMachine(
      scopeKey,
      this.deps.opsFor(scopeKey),
      this.deps.options,
    );
    this.machines.set(scopeKey, machine);
    return machine;
  }

  release(scopeKey: string): void {
    this.machines.get(scopeKey)?.archive();
    this.machines.delete(scopeKey);
  }

  size(): number {
    return this.machines.size;
  }
}
