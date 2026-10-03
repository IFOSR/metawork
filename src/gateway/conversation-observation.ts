import type { ConversationHistorySearch } from '../session/conversation-history-search.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ConversationReadBaseline, ConversationReadModel, ConversationViewCursor,
} from '../session/conversation-read-model.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import type { ConversationActivityView } from '../session/conversation-activity-types.js';

export * from './conversation-observation-contract.js';
import { MAX_OBSERVATION_FRAME_BYTES, type ConversationObservationFrame } from './conversation-observation-contract.js';

export interface ConversationObservationHandle {
  close(): void;
  /** Transport drain signal; a slow client resumes from its last committed cursor. */
  refresh(): Promise<void>;
}

type ObservationPayload<T = ConversationObservationFrame> = T extends ConversationObservationFrame
  ? Omit<T, 'observationId' | 'conversationId'> : never;

export interface ConversationObservationDeps {
  readonly identity?: { readonly serverId: string; readonly accountId: string };
  readonly model: ConversationReadModel;
  readonly search?: ConversationHistorySearch;
  readonly subscriptions: GatewaySubscriptions;
  readonly authorize: (accountId: string, conversationId: string) => Promise<boolean>;
  /** Indexed metadata only; this callback must not import or replay source history. */
  readonly sourceSequence: (accountId: string, conversationId: string) => number | null;
  readonly onError: (error: unknown) => void;
  readonly pollMs?: number;
  readonly metadata?: (accountId: string, conversationId: string) => Promise<{
    id: string; workspaceId: string | null; title: string;
    workspace?: { id: string; path: string; displayName: string; availability: 'available' | 'unavailable' };
  } | null>;
  readonly activity?: (accountId: string, conversationId: string, cursor?: string, pendingCursor?: string) => Promise<ConversationActivityView>;
}

/** Shared bounded reads, independent of Planner/Conversation execution lifetime. */
export class ConversationObservationService {
  constructor(private readonly deps: ConversationObservationDeps) {}
  get identity() { return this.deps.identity; }

  async metadata(accountId: string, conversationId: string) {
    if (!await this.deps.authorize(accountId, conversationId)) throw new Error('conversation_denied');
    return this.deps.metadata?.(accountId, conversationId) ?? null;
  }

  async page(accountId: string, conversationId: string, cursor?: string, maxBytes?: number, beforeTurnId?: string) {
    if (!await this.deps.authorize(accountId, conversationId)) throw new Error('conversation_denied');
    return this.deps.model.page(accountId, conversationId, { cursor, maxBytes, beforeTurnId });
  }

  async search(accountId: string, conversationId: string, query: string, cursor?: string) {
    if (!await this.deps.authorize(accountId, conversationId)) throw new Error('conversation_denied');
    if (!this.deps.search) throw new Error('search_unavailable');
    return this.deps.search.search(accountId, conversationId, query, cursor);
  }

  async locate(accountId: string, conversationId: string, turnId: string, taskId?: string, maxBytes = 240 * 1024) {
    if (!await this.deps.authorize(accountId, conversationId)) throw new Error('conversation_denied');
    const turn = taskId ? this.deps.model.findTaskTurn(accountId, conversationId, taskId)
      : this.deps.model.findTurn(accountId, conversationId, turnId);
    if (!turn) throw new Error('turn_not_found');
    const page = this.deps.model.page(accountId, conversationId, { beforeTurnId: turn.id, limit: 19, maxBytes });
    return { ...page, turns: [...page.turns, turn] };
  }

  async content(accountId: string, conversationId: string, hash: string, offset: number, maxBytes: number) {
    if (!await this.deps.authorize(accountId, conversationId)) throw new Error('conversation_denied');
    return this.deps.model.content(accountId, conversationId, hash, offset, maxBytes);
  }

  async activity(accountId: string, conversationId: string, cursor?: string, pendingCursor?: string) {
    if (!await this.deps.authorize(accountId, conversationId)) throw new Error('conversation_denied');
    if ((cursor?.length ?? 0) > 2048 || (pendingCursor?.length ?? 0) > 256) throw new Error('invalid_activity_cursor');
    return this.deps.activity?.(accountId, conversationId, cursor, pendingCursor) ?? { tasks: [], nextCursor: null, pendingInteractions: [] };
  }

  async open(input: {
    accountId: string; conversationId: string; observationId: string;
    cursor?: ConversationViewCursor;
    /** false means nothing was enqueued. No unbounded per-client event buffer. */
    send(frame: ConversationObservationFrame): boolean;
  }): Promise<ConversationObservationHandle> {
    if (!await this.deps.authorize(input.accountId, input.conversationId)) throw new Error('conversation_denied');
    let closed = false;
    let cursor = input.cursor;
    let active: Promise<void> | null = null;
    let rerun = false;
    let lastFreshness = '';
    let lastActivityRevision = '';
    let baselineSent = false;
    let unsubscribe = () => undefined as void;
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = () => {
      closed = true;
      unsubscribe();
      if (timer) clearInterval(timer);
    };
    const send = (frame: ObservationPayload) => {
      if (closed) return false;
      const value = { ...frame, observationId: input.observationId, conversationId: input.conversationId } as ConversationObservationFrame;
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_OBSERVATION_FRAME_BYTES) throw new Error('observation_frame_budget');
      if (input.send(value)) return true;
      close();
      return false;
    };
    const baseline = () => {
      const value = this.deps.model.baseline(input.accountId, input.conversationId);
      for (const frame of frameConversationBaseline(value, input.observationId, input.conversationId)) {
        if (!input.send(frame)) { close(); return; }
      }
      cursor = value.head ?? undefined;
      baselineSent = true;
    };
    const flush = async () => {
      if (closed) return;
      // Revalidate on each drain, including reconnect/backfill polling.
      if (!await this.deps.authorize(input.accountId, input.conversationId)) {
        send({ kind: 'closed', reason: 'authorization_revoked' }); close(); return;
      }
      if (closed) return;
      if (!cursor) {
        if (!baselineSent || this.deps.model.head(input.accountId, input.conversationId)) baseline();
      }
      else {
        const changes = this.deps.model.changes(input.accountId, input.conversationId, cursor);
        if (changes.reset) {
          send({ kind: 'reset', reason: changes.head?.epoch === cursor.epoch ? 'cursor_expired' : 'projection_changed' });
          baseline();
        } else {
          for (const change of changes.changes) {
            if (!send({ kind: 'patch', change })) return;
            cursor = { epoch: change.epoch, revision: change.revision };
          }
        }
      }
      const head = this.deps.model.head(input.accountId, input.conversationId);
      const source = this.deps.sourceSequence(input.accountId, input.conversationId);
      const freshness = { kind: 'freshness' as const, sourceSequence: source,
        projectedSequence: head?.journalSequence ?? 0,
        preparing: source === null || (head?.journalSequence ?? 0) < source };
      const key = JSON.stringify(freshness);
      if (key !== lastFreshness && send(freshness)) lastFreshness = key;
      if (this.deps.activity && !closed) {
        const view = await this.deps.activity(input.accountId, input.conversationId);
        if (closed || !await this.deps.authorize(input.accountId, input.conversationId)) return;
        const revision = createHash('sha256').update(JSON.stringify(view)).digest('hex');
        if (revision !== lastActivityRevision && send({ kind: 'activity', view, revision })) lastActivityRevision = revision;
      }
    };
    const refresh = (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (active) { rerun = true; return active; }
      active = flush().catch(error => {
        this.deps.onError(error);
        send({ kind: 'closed', reason: 'read_unavailable' }); close();
      }).finally(() => {
        active = null;
        if (rerun && !closed) { rerun = false; void refresh(); }
      });
      return active;
    };
    // Subscribe before baseline. Facts are wakeups; the durable tail owns gaps.
    unsubscribe = this.deps.subscriptions.subscribe({
      accountId: input.accountId, conversationId: input.conversationId,
      listener: () => { void refresh(); },
    });
    await refresh();
    if (!closed) {
      timer = setInterval(() => { void refresh(); }, this.deps.pollMs ?? 100);
      timer.unref?.();
    }
    return { close, refresh };
  }
}

export function frameConversationBaseline(
  baseline: ConversationReadBaseline, observationId: string, conversationId: string,
): ConversationObservationFrame[] {
  const body = Buffer.from(JSON.stringify(baseline));
  if (body.byteLength > 256 * 1024) throw new Error('observation_baseline_budget');
  const encoded = body.toString('base64');
  const chunkSize = 48 * 1024;
  const count = Math.max(1, Math.ceil(encoded.length / chunkSize));
  const transferId = randomUUID();
  const hash = createHash('sha256').update(body).digest('hex');
  return Array.from({ length: count }, (_, index) => ({
    observationId, conversationId, kind: 'baseline', transferId, index, count,
    byteLength: body.byteLength, hash, data: encoded.slice(index * chunkSize, (index + 1) * chunkSize),
  }));
}
