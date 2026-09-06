import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Durable Feishu artifact delivery ledger (2026-09-06 plan §4.5/§5.6).
 *
 * Business result delivery and Feishu cloud-document publication are separate
 * durable effects. Each effect carries an idempotency key (delivery target +
 * artifact identity) and advances through explicit states: a `pending`
 * reservation is written BEFORE the external import/send, then settled to a
 * `terminal` outcome. This prevents a concurrent or post-restart duplicate
 * import ("cloud doc created, crash before ledger write") and never silently
 * swallows a persistence failure — a write that cannot be persisted fails the
 * reservation closed rather than risking a duplicate external effect.
 */

export type FeishuArtifactDeliveryOutcome =
  | 'cloud_doc'
  | 'file_fallback'
  | 'file'
  | 'cloud_doc_failed'
  | 'skipped'
  | 'failed'
  | 'uncertain';

export type FeishuArtifactDeliveryState = 'pending' | 'terminal';

export interface FeishuArtifactDeliveryEntry {
  /** Idempotency key: delivery target + artifact identity. */
  key: string;
  name: string;
  state: FeishuArtifactDeliveryState;
  outcome?: FeishuArtifactDeliveryOutcome;
  url?: string;
  reason?: string;
  ts: string;
}

export type FeishuArtifactReservation =
  | 'reserved'
  | 'already_delivered'
  | 'in_flight'
  | 'write_failed';

const MAX_REASON_LENGTH = 160;

export function artifactDeliveryKey(input: {
  chatId: string;
  threadId?: string;
  artifactPath: string;
}): string {
  return `${input.chatId}\0${input.threadId ?? ''}\0${input.artifactPath}`;
}

export function boundedArtifactReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, ' ').slice(0, MAX_REASON_LENGTH);
}

export class FeishuArtifactDeliveryLedger {
  private readonly entries = new Map<string, FeishuArtifactDeliveryEntry>();
  private readonly pendingTtlMs: number;

  constructor(
    private readonly path: string,
    options: { pendingTtlMs?: number } = {},
  ) {
    this.pendingTtlMs = options.pendingTtlMs ?? 10 * 60_000;
    this.load();
  }

  find(key: string): FeishuArtifactDeliveryEntry | null {
    return this.entries.get(key) ?? null;
  }

  /**
   * Reserves a delivery slot before any external effect. Returns the exact
   * reservation state so callers can distinguish "deliver now", "reuse a
   * terminal outcome", "another attempt is in flight", and "persistence
   * failed (fail closed)". A `pending` reservation older than the pending TTL
   * is treated as abandoned (its owning process crashed) and may be re-taken.
   */
  reserve(key: string, name: string): FeishuArtifactReservation {
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.state === 'terminal'
        && existing.outcome
        && ['cloud_doc', 'file', 'file_fallback'].includes(existing.outcome)) {
        return 'already_delivered';
      }
      if (existing.state === 'pending' && isStalePending(existing, this.pendingTtlMs)) {
        // Abandoned in-flight reservation: allow a fresh reservation.
      } else {
        return 'in_flight';
      }
    }
    const entry: FeishuArtifactDeliveryEntry = {
      key,
      name,
      state: 'pending',
      ts: new Date().toISOString(),
    };
    if (!this.append(entry)) {
      return 'write_failed';
    }
    this.entries.set(key, entry);
    return 'reserved';
  }

  /** Settles a reservation to a terminal outcome. Returns persistence status. */
  settle(
    key: string,
    outcome: FeishuArtifactDeliveryOutcome,
    extra: { url?: string; reason?: string } = {},
  ): boolean {
    const previous = this.entries.get(key);
    const entry: FeishuArtifactDeliveryEntry = {
      key,
      name: previous?.name ?? '',
      state: 'terminal',
      outcome,
      ...(extra.url ? { url: extra.url } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
      ts: new Date().toISOString(),
    };
    const persisted = this.append(entry);
    this.entries.set(key, entry);
    return persisted;
  }

  private append(entry: FeishuArtifactDeliveryEntry): boolean {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    } catch {
      // Never silently swallowed: the caller decides how to surface the
      // non-durability and the in-memory map still guards this process.
      return false;
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as FeishuArtifactDeliveryEntry;
          if (entry && typeof entry.key === 'string') {
            this.entries.set(entry.key, entry);
          }
        } catch {
          // Corrupted lines are skipped; the ledger is append-only history.
        }
      }
    } catch {
      // Unreadable ledger: start empty and re-record as deliveries happen.
    }
  }
}

/** Detects a pending reservation abandoned by a crashed owning process. */
function isStalePending(entry: FeishuArtifactDeliveryEntry, pendingTtlMs: number): boolean {
  if (entry.state !== 'pending') return false;
  const elapsed = Date.now() - Date.parse(entry.ts || '');
  return Number.isFinite(elapsed) && elapsed > pendingTtlMs;
}

/** Renders the user-visible final-reply status line for one entry (§4.3). */
export function formatArtifactDeliveryStatusLine(entry: FeishuArtifactDeliveryEntry): string {
  switch (entry.outcome ?? 'uncertain') {
    case 'cloud_doc':
      return `云文档已生成：[${entry.name}](${entry.url ?? ''})`;
    case 'file':
    case 'file_fallback':
      return entry.outcome === 'file_fallback'
        ? `文件已发送：${entry.name}（云文档生成失败：${entry.reason ?? '未知原因'}）`
        : `文件已发送：${entry.name}`;
    case 'cloud_doc_failed':
      return `正文已返回，云文档生成失败：${entry.name}（${entry.reason ?? '未知原因'}）`;
    case 'failed':
      return `产物投递失败：${entry.name}（${entry.reason ?? '未知原因'}）`;
    case 'skipped':
      return `产物投递跳过：${entry.name}（${entry.reason ?? '不支持'}）`;
    case 'uncertain':
      return `产物投递未确认：${entry.name}（${entry.reason ?? '重复投递或账本不可用'}）`;
  }
}
