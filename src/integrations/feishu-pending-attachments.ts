import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { dirname } from 'path';

/**
 * Message-scoped pending Feishu attachments (2026-09-06 plan §5.5).
 *
 * Every downloaded image/file is bound to its message identity, its
 * Conversation route (chat + thread), AND its sender — a group chat must
 * never hand A's image to B. Records persist to a JSONL ledger with explicit
 * tombstones, so a restart never re-binds an already-claimed attachment or
 * reloads an expired one whose file is gone.
 *
 * Claiming an attachment hands its downloaded path to the Gateway attachment
 * store but does NOT delete the file — the routing layer still has to read it.
 * Only expiry and per-route limit eviction delete the downloaded file.
 */

export interface FeishuPendingAttachment {
  messageId: string;
  chatId: string;
  threadId?: string;
  senderId?: string;
  /** Downloaded file on disk (bytes land in the Gateway attachment store on bind). */
  path: string;
  name: string;
  resourceType: 'image' | 'file';
  receivedAt: string;
  expiresAtMs: number;
}

const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_PENDING_PER_ROUTE = 8;

export class FeishuPendingAttachmentStore {
  private readonly records: FeishuPendingAttachment[] = [];
  private readonly removedMessageIds = new Set<string>();

  constructor(
    private readonly deps: {
      ttlMs?: number;
      maxPerRoute?: number;
      nowMs?: () => number;
      /** Optional JSONL ledger path for restart durability. */
      ledgerPath?: string;
    } = {},
  ) {
    this.load();
  }

  add(input: Omit<FeishuPendingAttachment, 'receivedAt' | 'expiresAtMs'> & {
    receivedAt?: string;
  }): FeishuPendingAttachment {
    const nowMs = this.deps.nowMs ?? Date.now;
    const record: FeishuPendingAttachment = {
      ...input,
      receivedAt: input.receivedAt ?? new Date().toISOString(),
      expiresAtMs: nowMs() + (this.deps.ttlMs ?? DEFAULT_TTL_MS),
    };
    this.sweep();
    const routeRecords = this.records.filter(
      recordCandidate => recordCandidate.chatId === input.chatId
        && recordCandidate.threadId === input.threadId
        && recordCandidate.senderId === input.senderId,
    );
    const maxPerRoute = this.deps.maxPerRoute ?? DEFAULT_MAX_PENDING_PER_ROUTE;
    if (routeRecords.length >= maxPerRoute) {
      const oldest = routeRecords[0]!;
      this.remove(oldest);
    }
    this.records.push(record);
    this.append(record);
    return record;
  }

  /**
   * Claims pending attachments for the exact route (chat + thread) and sender
   * of a text message, dropping expired records deterministically. Claiming
   * detaches the record but keeps the downloaded file — the routing layer
   * still reads it into the Gateway attachment store.
   */
  claimForText(input: {
    chatId: string;
    threadId?: string;
    senderId?: string;
  }): FeishuPendingAttachment[] {
    this.sweep();
    const claimed: FeishuPendingAttachment[] = [];
    for (const record of [...this.records]) {
      if (record.chatId !== input.chatId) continue;
      if (record.threadId !== input.threadId) continue;
      // §5.5: same sender only — a group chat must never route A's image to B.
      if (input.senderId && record.senderId && record.senderId !== input.senderId) continue;
      this.detach(record);
      claimed.push(record);
    }
    return claimed;
  }

  /** Drops expired records and removes their downloaded files. */
  sweep(): number {
    const nowMs = this.deps.nowMs ?? Date.now;
    let removed = 0;
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (record.expiresAtMs <= nowMs()) {
        this.remove(record);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.records.length;
  }

  /** Detach without deleting the downloaded file (claim path). */
  private detach(record: FeishuPendingAttachment): void {
    const index = this.records.indexOf(record);
    if (index >= 0) this.records.splice(index, 1);
    this.tombstone(record);
  }

  /** Detach AND delete the downloaded file (expiry / limit eviction). */
  private remove(record: FeishuPendingAttachment): void {
    const index = this.records.indexOf(record);
    if (index >= 0) this.records.splice(index, 1);
    this.tombstone(record);
    try {
      if (record.path) rmSync(record.path, { force: true });
    } catch {
      // Best-effort cleanup; the ledger tombstone is the durable source of truth.
    }
  }

  private tombstone(record: FeishuPendingAttachment): void {
    this.removedMessageIds.add(record.messageId);
    const path = this.deps.ledgerPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(
        path,
        `${JSON.stringify({ messageId: record.messageId, removedAt: new Date().toISOString() })}\n`,
        'utf8',
      );
    } catch {
      // In-memory removal still guards this process.
    }
  }

  private append(record: FeishuPendingAttachment): void {
    const path = this.deps.ledgerPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // In-memory still guards this process; durability is best effort.
    }
  }

  private load(): void {
    const path = this.deps.ledgerPath;
    if (!path) return;
    try {
      if (!existsSync(path)) return;
      const lines = readFileSync(path, 'utf8').split('\n');
      // Pass 1: collect tombstones first so a record removed in the same file
      // is never re-bound on restart.
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.messageId === 'string' && parsed.removedAt) {
            this.removedMessageIds.add(parsed.messageId);
          }
        } catch {
          // Corrupted lines are skipped.
        }
      }
      // Pass 2: load live records, skipping tombstoned ids.
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof parsed.messageId === 'string' && parsed.removedAt) continue;
          const record = parsed as unknown as FeishuPendingAttachment;
          if (record && typeof record.path === 'string' && typeof record.messageId === 'string') {
            if (this.removedMessageIds.has(record.messageId)) continue;
            this.records.push(record);
          }
        } catch {
          // Corrupted lines are skipped.
        }
      }
    } catch {
      // Unreadable ledger: start empty.
    }
  }
}
