import type { ConversationReadBaseline, ConversationTurnView, ConversationViewCursor, ConversationTurnPage } from '../../../src/session/conversation-read-types';
import type { ConversationObservationFrame } from '../../../src/gateway/conversation-observation-contract';
import type { ConversationActivityView } from '../../../src/session/conversation-activity-types';

export interface ConversationWindow {
  readonly atLatest: boolean;
  readonly ids: readonly string[];
  readonly cursor: ConversationViewCursor | null;
  readonly olderCursor: string | null;
  readonly status: 'loading' | 'ready' | 'preparing' | 'disconnected' | 'error';
  readonly error: string | null;
}

const EMPTY: ConversationWindow = { ids: [], cursor: null, olderCursor: null, status: 'loading', error: null, atLatest: true };
const EMPTY_ACTIVITY: ConversationActivityView = { tasks: [], nextCursor: null, pendingInteractions: [] };
type Listener = () => void;

/** Entity references remain stable; a Turn patch notifies only its own subscribers. */
export class ConversationEntityStore {
  private readonly windows = new Map<string, ConversationWindow>();
  private readonly turns = new Map<string, ConversationTurnView>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly used = new Map<string, number>();
  private readonly active = new Set<string>();
  private readonly activityViews = new Map<string, ConversationActivityView>();
  private readonly deletedAt = new Map<string, number>();
  private generation = 0;
  private readonly revocations = new Set<(id: string) => void>();

  onRevoked(listener: (id: string) => void): () => void {
    this.revocations.add(listener); return () => { this.revocations.delete(listener); };
  }

  constructor(private readonly maxConversations = 12, private readonly maxTurns = 500) {}

  window(conversationId: string): ConversationWindow { return this.windows.get(conversationId) ?? EMPTY; }
  turn(conversationId: string, turnId: string): ConversationTurnView | undefined { return this.turns.get(`${conversationId}\0${turnId}`); }
  currentGeneration(): number { return this.generation; }
  activity(conversationId: string): ConversationActivityView { return this.activityViews.get(conversationId) ?? EMPTY_ACTIVITY; }
  retain(conversationId: string): () => void {
    this.active.add(conversationId); this.used.set(conversationId, Date.now());
    return () => { this.active.delete(conversationId); this.evict(); };
  }
  subscribe(key: string, listener: Listener): () => void {
    const listeners = this.listeners.get(key) ?? new Set();
    listeners.add(listener); this.listeners.set(key, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(key); };
  }
  subscribeTurn(conversationId: string, turnId: string, listener: Listener): () => void {
    return this.subscribe(`${conversationId}\0${turnId}`, listener);
  }

  baseline(conversationId: string, value: ConversationReadBaseline): void {
    if (value.turns.some(turn => turn.conversationId !== conversationId)) throw new Error('observation_scope_mismatch');
    const previous = this.window(conversationId);
    const sameEpoch = previous.cursor?.epoch === value.head?.epoch;
    if (!sameEpoch) this.deletedAt.delete(conversationId);
    if (sameEpoch && previous.cursor && value.head && value.head.revision < previous.cursor.revision) return;
    const ids = new Set<string>();
    for (const turn of value.turns) { this.upsert(conversationId, turn, !sameEpoch); ids.add(turn.id); }
    this.windows.set(conversationId, {
      ids: this.limitWindow(conversationId, this.order(conversationId, [...ids]), 'latest'), cursor: value.head,
      olderCursor: value.nextCursor, atLatest: true,
      status: value.head ? 'ready' : 'preparing', error: null,
    });
    this.notify(conversationId); this.evict();
  }

  apply(frame: Exclude<ConversationObservationFrame, { kind: 'baseline' }>): 'applied' | 'reset' {
    const conversationId = frame.conversationId;
    const previous = this.window(conversationId);
    if (frame.kind === 'patch') {
      const change = frame.change;
      if (!previous.cursor || change.epoch !== previous.cursor.epoch) return 'reset';
      if (change.revision <= previous.cursor.revision) return 'applied';
      if (change.prevRevision !== previous.cursor.revision || change.revision !== change.prevRevision + 1
        || change.turn.conversationId !== conversationId) return 'reset';
      if (change.removed) {
        this.deletedAt.set(conversationId, change.revision);
        const key = `${conversationId}\0${change.turn.id}`;
        this.turns.delete(key);
        this.windows.set(conversationId, { ...previous, ids: previous.ids.filter(id => id !== change.turn.id),
          cursor: { epoch: change.epoch, revision: change.revision } });
        this.notify(key); this.notify(conversationId);
        return 'applied';
      }
      if (!previous.atLatest && !previous.ids.includes(change.turn.id)) {
        this.windows.set(conversationId, { ...previous, cursor: { epoch: change.epoch, revision: change.revision } });
        return 'applied';
      }
      this.upsert(conversationId, change.turn);
      const inserted = !previous.ids.includes(change.turn.id);
      this.windows.set(conversationId, { ...previous,
        ids: inserted ? this.limitWindow(conversationId, this.order(conversationId, [...previous.ids, change.turn.id]), 'latest') : previous.ids,
        olderCursor: inserted && previous.ids.length >= Math.min(50, this.maxTurns) ? 'window_anchor' : previous.olderCursor,
        cursor: { epoch: change.epoch, revision: change.revision },
      });
      if (inserted) this.notify(conversationId);
      this.evict();
    } else if (frame.kind === 'activity') {
      this.activityViews.set(conversationId, frame.view); this.notify(`${conversationId}\0activity`);
    } else if (frame.kind === 'freshness') {
      const status = frame.preparing ? 'preparing' : 'ready';
      if (previous.status !== status) { this.windows.set(conversationId, { ...previous, status }); this.notify(conversationId); }
    } else if (frame.kind === 'closed') {
      if (frame.reason === 'authorization_revoked') {
        this.generation++; this.remove(conversationId);
        this.revocations.forEach(listener => listener(conversationId));
      }
      this.windows.set(conversationId, { ...this.window(conversationId), status: 'error', error: frame.reason });
      this.notify(conversationId);
    } else return 'reset';
    return 'applied';
  }

  older(conversationId: string, page: ConversationTurnPage, expectedEpoch: string, generation: number): void {
    const previous = this.window(conversationId);
    if (generation !== this.generation || previous.cursor?.epoch !== expectedEpoch) return;
    if ((this.deletedAt.get(conversationId) ?? 0) > (page.asOf?.revision ?? 0)) return;
    if (page.turns.some(turn => turn.conversationId !== conversationId)) throw new Error('observation_scope_mismatch');
    for (const turn of page.turns) this.upsert(conversationId, turn);
    this.windows.set(conversationId, { ...previous,
      ids: this.limitWindow(conversationId, this.order(conversationId, [...new Set([...page.turns.map(turn => turn.id), ...previous.ids])]), 'oldest'),
      olderCursor: page.nextCursor, atLatest: false });
    this.notify(conversationId); this.evict();
  }

  locate(conversationId: string, page: ConversationTurnPage, expectedEpoch: string, generation: number): void {
    const previous = this.window(conversationId);
    if (generation !== this.generation || previous.cursor?.epoch !== expectedEpoch
      || page.asOf?.epoch !== expectedEpoch || (this.deletedAt.get(conversationId) ?? 0) > page.asOf.revision) return;
    if (page.turns.some(turn => turn.conversationId !== conversationId)) throw new Error('observation_scope_mismatch');
    for (const turn of page.turns) this.upsert(conversationId, turn);
    this.windows.set(conversationId, { ...previous,
      ids: this.limitWindow(conversationId, page.turns.map(turn => turn.id), 'latest'),
      olderCursor: page.nextCursor, atLatest: false });
    this.notify(conversationId); this.evict();
  }

  disconnected(): void {
    for (const [id, value] of this.windows) { this.windows.set(id, { ...value, status: 'disconnected' }); this.notify(id); }
  }

  purge(): void {
    this.generation++;
    const keys = [...this.listeners.keys()];
    this.windows.clear(); this.turns.clear(); this.active.clear(); this.used.clear(); this.activityViews.clear(); this.deletedAt.clear();
    keys.forEach(key => this.notify(key));
  }

  private upsert(conversationId: string, turn: ConversationTurnView, force = false): void {
    if (turn.conversationId !== conversationId) throw new Error('observation_scope_mismatch');
    const key = `${conversationId}\0${turn.id}`;
    if (!force && (this.turns.get(key)?.revision ?? -1) >= turn.revision) return;
    this.turns.set(key, turn); this.notify(key);
  }
  private order(conversationId: string, ids: string[]): string[] {
    return ids.sort((a, b) => (this.turn(conversationId, a)?.firstSequence ?? 0)
      - (this.turn(conversationId, b)?.firstSequence ?? 0) || a.localeCompare(b));
  }
  private limitWindow(conversationId: string, ids: string[], direction: 'latest' | 'oldest'): string[] {
    const limit = Math.min(50, this.maxTurns);
    const keep = direction === 'latest' ? ids.slice(-limit) : ids.slice(0, limit);
    const retained = new Set(keep);
    for (const id of new Set([...ids, ...this.window(conversationId).ids])) {
      if (retained.has(id)) continue;
      this.turns.delete(`${conversationId}\0${id}`); this.notify(`${conversationId}\0${id}`);
    }
    return keep;
  }
  private notify(key: string): void { this.listeners.get(key)?.forEach(listener => listener()); }
  private remove(id: string): void {
    this.deletedAt.delete(id);
    this.activityViews.delete(id); this.notify(`${id}\0activity`);
    for (const turnId of this.window(id).ids) { this.turns.delete(`${id}\0${turnId}`); this.notify(`${id}\0${turnId}`); }
    this.windows.delete(id); this.used.delete(id); this.notify(id);
  }
  private evict(): void {
    const candidates = [...this.windows.keys()].filter(id => !this.active.has(id))
      .sort((a, b) => (this.used.get(a) ?? 0) - (this.used.get(b) ?? 0));
    while ((this.windows.size > this.maxConversations || this.turns.size > this.maxTurns) && candidates.length) {
      this.remove(candidates.shift()!);
    }
  }
}
