import { createHash, randomUUID } from 'node:crypto';
import type { ConversationTurnView } from '../session/conversation-read-types.js';

// The runnable pool is bounded. Excess durable delivery intents stay on disk
// as deferred work; platform outages must never roll back execution facts.
export const NOTIFICATION_READY_JOB_LIMIT = 1024;
export const NOTIFICATION_FACT_BYTES = 32 * 1024;

export class NotificationDestinationRevoked extends Error {
  constructor(reason: string) { super(reason); this.name = 'NotificationDestinationRevoked'; }
}

export interface NotificationDestination {
  readonly platform: 'feishu';
  readonly tenantKey: string;
  readonly senderId: string;
  readonly chatId: string;
  readonly threadId?: string;
  readonly chatType: 'dm' | 'group' | 'unknown';
}
export interface NotificationRoute {
  readonly id: string;
  readonly accountId: string;
  readonly principalId: string;
  readonly conversationId: string;
  readonly requestId: string | null;
  readonly taskId: string | null;
  readonly destination: NotificationDestination;
  readonly source: 'default_reply' | 'explicit_follow';
  readonly revision: number;
  readonly enabled: boolean;
}
export interface NotificationFact {
  readonly accountId: string;
  readonly conversationId: string;
  readonly subjectId: string;
  readonly version: string;
  readonly requestId: string | null;
  readonly taskId: string | null;
  readonly category: 'progress' | 'result' | 'approval';
  readonly payload: unknown;
}
export interface NotificationJob {
  readonly id: string;
  readonly token: string;
  readonly route: NotificationRoute;
  readonly fact: NotificationFact;
  readonly attempts: number;
}
export interface NotificationFactPage {
  readonly facts: readonly NotificationFact[];
  readonly nextCursor: string | null;
}
/** Delivery owns routes, coalescing and retries. Storage provides atomic durable operations. */
export interface NotificationRoutingStore {
  nextSeed(routeId?: string): { route: NotificationRoute; cursor: string | null } | null;
  commitSeed(route: NotificationRoute, cursor: string | null, page: NotificationFactPage, now: number): void;
  upsert(route: Omit<NotificationRoute, 'revision' | 'enabled'>): NotificationRoute;
  disable(accountId: string, principalId: string, routeId: string): boolean;
  list(accountId: string, principalId: string, afterId?: string): readonly NotificationRoute[];
  capture(fact: NotificationFact, now: number): void;
  claim(now: number, token: string, excludedRouteIds?: readonly string[]): NotificationJob | null;
  renew(job: NotificationJob, now: number): boolean;
  settle(job: NotificationJob, outcome: 'delivered' | 'superseded' | 'revoked' | 'retry', now: number, retryAt?: number): void;
}

export class NotificationRoutingService {
  private running: Promise<void> | null = null;
  private readonly deliveries = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(private readonly deps: {
    store: NotificationRoutingStore;
    authorize(route: Omit<NotificationRoute, 'revision' | 'enabled'>): Promise<boolean>;
    /** Bounded current projection, read synchronously after route creation. */
    current?(route: NotificationRoute, cursor: string | null): NotificationFactPage;
    valid?(job: NotificationJob): boolean;
    deliver(job: NotificationJob): Promise<void>;
    onError(error: unknown): void;
    now?: () => number;
  }) {}
  async follow(input: Omit<NotificationRoute, 'id' | 'revision' | 'enabled'>): Promise<NotificationRoute> {
    if (!await this.deps.authorize({ ...input, id: '' })) throw new Error('forbidden_scope');
    const id = `route_${createHash('sha256').update(JSON.stringify([
      input.accountId, input.principalId, input.conversationId, input.taskId, input.requestId,
      input.destination.platform, input.destination.chatId, input.destination.threadId ?? '', input.source,
    ])).digest('hex')}`;
    const route = this.deps.store.upsert({ ...input, id });
    if (input.source === 'explicit_follow') {
      await this.seed(route.id);
    }
    return route;
  }
  unfollow(accountId: string, principalId: string, routeId: string): boolean {
    return this.deps.store.disable(accountId, principalId, routeId);
  }
  list(accountId: string, principalId: string, afterId?: string) {
    return this.deps.store.list(accountId, principalId, afterId);
  }
  /** Called inside the source projection transaction; never performs network I/O. */
  capture(fact: NotificationFact): void { this.deps.store.capture(fact, (this.deps.now ?? Date.now)()); }
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drainOpen().finally(() => { this.running = null; });
    return this.running;
  }
  private async drainOpen(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    await this.seed();
    // One slot per route, four physical sends maximum. A slow route keeps its
    // slot until its actual send settles; it cannot block replenishing other slots.
    for (let n = 0; n < 4 && this.deliveries.size < 4 && !this.stopped; n++) {
      const job = this.deps.store.claim(now(), randomUUID(), [...this.deliveries.keys()]);
      if (!job) break;
      const delivery = this.deliver(job).catch(error => this.deps.onError(error))
        .finally(() => { this.deliveries.delete(job.route.id); });
      this.deliveries.set(job.route.id, delivery);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([delivery, new Promise<void>(resolve => { timer = setTimeout(resolve, 25); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
    await Promise.allSettled([...this.deliveries.values()]);
  }
  private async deliver(job: NotificationJob): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const renewal = setInterval(() => {
      try { this.deps.store.renew(job, now()); } catch (error) { this.deps.onError(error); }
    }, 30_000);
    renewal.unref?.();
    try {
      if (!await this.deps.authorize(job.route)) {
        this.deps.store.settle(job, 'revoked', now()); return;
      }
      if (this.deps.valid && !this.deps.valid(job)) {
        // A stale approval is obsolete, but the route remains useful for later work.
        this.deps.store.settle(job, 'superseded', now()); return;
      }
      await this.deps.deliver(job);
      this.deps.store.settle(job, 'delivered', now());
    } catch (error) {
      this.deps.onError(error);
      if (error instanceof NotificationDestinationRevoked) {
        this.deps.store.settle(job, 'revoked', now()); return;
      }
      const delay = Math.min(300_000, 2_000 * 2 ** Math.min(job.attempts, 7));
      this.deps.store.settle(job, 'retry', now(), now() + delay);
    } finally { clearInterval(renewal); }
  }
  private async seed(routeId?: string): Promise<void> {
    if (!this.deps.current) return;
    const seed = this.deps.store.nextSeed(routeId);
    if (!seed) return;
    if (!await this.deps.authorize(seed.route)) {
      this.deps.store.disable(seed.route.accountId, seed.route.principalId, seed.route.id); return;
    }
    const page = this.deps.current(seed.route, seed.cursor);
    this.deps.store.commitSeed(seed.route, seed.cursor, page, (this.deps.now ?? Date.now)());
  }
}

/** Only presentation facts cross into Delivery; audit events are not replayed. */
export function notificationFromTurn(accountId: string, turn: ConversationTurnView): NotificationFact | null {
  if (!turn.requestId) return null;
  const ready = turn.deliveryStatus === 'ready';
  const failed = turn.status === 'failed' || turn.status === 'cancelled';
  const category = (ready && turn.status !== 'running') || failed ? 'result' : 'progress';
  const payload = { turnId: turn.id, status: turn.status, deliveryStatus: turn.deliveryStatus,
    answer: ready ? turn.answer : '', answerRef: ready ? turn.answerRef : null,
    resultId: turn.resultId, taskId: turn.taskId, certification: turn.certification,
    completeness: turn.completeness };
  return { accountId, conversationId: turn.conversationId, subjectId: turn.id,
    version: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    requestId: turn.requestId, taskId: turn.taskId, category, payload };
}
