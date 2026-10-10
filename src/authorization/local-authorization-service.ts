import { randomUUID } from 'node:crypto';
import type { OfficialServiceClient } from './official-service-client.js';
import { OfficialAuthorizationError, type OfficialAuthorizationProjection, type OfficialEntitlement } from './types.js';

type Client = Pick<OfficialServiceClient, 'login' | 'logout' | 'verifyEntitlement' | 'ai' | 'createOrder' | 'getPlans' | 'register'>;
export interface LocalAuthorizationServiceOptions {
  readonly client: Client;
  readonly clock?: () => number;
  readonly monotonicClock?: () => number;
  readonly dailyCheckMs?: number;
  readonly hasActiveWork?: () => boolean;
  readonly hasUnsettledWork?: () => boolean;
  readonly hasUnfinishedWork?: () => boolean;
  readonly onStateChange?: (state: OfficialAuthorizationProjection) => void;
}
const empty = (): OfficialAuthorizationProjection => ({
  state: 'logged_out', account: null, entitlement: null, verifiedAt: null, nextDailyCheckAt: null,
});

/** One memory-only session per Server. Every asynchronous response is generation-fenced. */
export class LocalAuthorizationService {
  private lastAccountId: string | null = null;
  private token: string | null = null;
  private generation = 0;
  private loginPending = false;
  private disposed = false;
  private check: { generation: number; promise: Promise<OfficialAuthorizationProjection> } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baseline: { wall: number; mono: number; server: number } | null = null;
  private dailyAttempt = 0;
  private state = empty();
  private listeners = new Set<(state: OfficialAuthorizationProjection) => void>();
  private readonly wall: () => number;
  private readonly mono: () => number;
  private readonly day: number;

  constructor(private readonly options: LocalAuthorizationServiceOptions) {
    this.wall = options.clock ?? Date.now;
    this.mono = options.monotonicClock ?? options.clock ?? (() => performance.now());
    this.day = options.dailyCheckMs ?? 86_400_000;
  }

  subscribe(listener: (state: OfficialAuthorizationProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): OfficialAuthorizationProjection {
    if (this.state.state === 'active' && this.baseline) {
      const elapsed = this.mono() - this.baseline.mono;
      const wallElapsed = this.wall() - this.baseline.wall;
      // Suspend/wake and large clock changes require an online check; neither extends expiry.
      if (elapsed < 0 || Math.abs(wallElapsed - elapsed) > 60_000) {
        this.publish({ ...this.state, state: 'unavailable', reason: '系统时间或休眠状态变化，请刷新权益。' });
      } else if (this.state.entitlement?.expiresAt
        && this.baseline.server + Math.max(elapsed, wallElapsed) >= Date.parse(this.state.entitlement.expiresAt)) {
        this.publish({ ...this.state, state: 'expired', reason: '服务权益已到期，请续费。' });
      }
    }
    return structuredClone(this.state);
  }

  async login(email: string, password: string): Promise<OfficialAuthorizationProjection> {
    if (this.disposed) throw new OfficialAuthorizationError('Server 已停止', 'session_invalid');
    if (this.token || this.loginPending || this.options.hasUnsettledWork?.()) {
      throw new OfficialAuthorizationError('请先退出当前账号，并等待活动工作安全收尾。', 'already_logged_in');
    }
    const generation = ++this.generation;
    this.loginPending = true;
    try {
      const result = await this.options.client.login(email, password, { version: process.env.METAWORK_VERSION });
      if (generation !== this.generation) {
        await this.options.client.logout(result.sessionToken).catch(() => undefined);
        throw new OfficialAuthorizationError('登录已取消，请重试。', 'session_invalid');
      }
      if (this.lastAccountId && this.lastAccountId !== result.account.accountId && this.options.hasUnfinishedWork?.()) {
        await this.options.client.logout(result.sessionToken).catch(() => undefined);
        throw new OfficialAuthorizationError('请先用原账号完成或取消未结束任务，再切换账号。', 'already_logged_in');
      }
      this.lastAccountId = result.account.accountId;
      this.token = result.sessionToken;
      this.state = { ...empty(), account: result.account };
      // Login response includes an authoritative online entitlement query.
      this.accept(result.entitlement);
      this.schedule();
      return this.getStatus();
    } finally {
      if (generation === this.generation) this.loginPending = false;
    }
  }

  async register(email: string, password: string): Promise<void> {
    if (this.token || this.loginPending) throw new OfficialAuthorizationError('请先退出当前账号。', 'already_logged_in');
    await this.options.client.register(email, password);
  }

  async logout(): Promise<void> {
    const token = this.token;
    this.clear(); // Close local admission before awaiting any network operation.
    if (token) await this.options.client.logout(token).catch(() => undefined);
  }

  verifyForProduction(): Promise<OfficialAuthorizationProjection> {
    if (!this.token) return Promise.resolve(this.getStatus());
    const generation = this.generation;
    if (this.check?.generation === generation) return this.check.promise;
    const token = this.token;
    const promise = this.options.client.verifyEntitlement(token).then(entitlement => {
      if (generation !== this.generation) throw new OfficialAuthorizationError('登录状态已变化。', 'session_invalid');
      this.accept(entitlement);
      return this.getStatus();
    }).catch(error => {
      if (generation === this.generation) this.handleFailure(error);
      // A stale request must never inherit another account's successful projection.
      if (generation !== this.generation) return empty();
      return this.getStatus();
    }).finally(() => {
      if (this.check?.promise === promise) this.check = null;
    });
    this.check = { generation, promise };
    return promise;
  }

  getPlans() { return this.options.client.getPlans(); }

  async createOrder(plan: 'trial' | 'monthly' | 'annual', idempotencyKey: string): Promise<unknown> {
    const token = this.requireToken();
    const generation = this.generation;
    try {
      const result = await this.options.client.createOrder(token, plan, idempotencyKey);
      if (generation !== this.generation) throw new OfficialAuthorizationError('登录状态已变化。', 'session_invalid');
      await this.verifyForProduction();
      if (generation !== this.generation) throw new OfficialAuthorizationError('登录状态已变化。', 'session_invalid');
      return result;
    } catch (error) {
      if (generation === this.generation) this.handleFailure(error, true);
      throw error;
    }
  }

  async callOfficialAi<T>(operation: 'responsibility_rewrite' | 'model_summary' | 'capability_explanation', input: unknown, requestId: string = randomUUID()): Promise<T> {
    this.getStatus();
    const token = this.requireToken();
    const generation = this.generation;
    try {
      const result = await this.options.client.ai({ operation, input, requestId }, token);
      if (generation !== this.generation) throw new OfficialAuthorizationError('登录状态已变化。', 'session_invalid');
      this.accept(result.entitlement);
      return result.result as T;
    } catch (error) {
      if (generation === this.generation) this.handleFailure(error, true);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.logout();
    this.listeners.clear();
  }

  private requireToken(): string {
    if (!this.token) throw new OfficialAuthorizationError('请先在本机 Web 或 Desktop 登录 MetaWork 官方账号。', 'session_invalid');
    return this.token;
  }

  private accept(entitlement: OfficialEntitlement): void {
    this.baseline = { wall: this.wall(), mono: this.mono(), server: Date.parse(entitlement.serverTime) };
    this.dailyAttempt = this.baseline.mono;
    const status = entitlement.status;
    const active = (status === 'active' || status === 'trial')
      && (!entitlement.expiresAt || Date.parse(entitlement.expiresAt) > this.baseline.server)
      && (!entitlement.effectiveAt || Date.parse(entitlement.effectiveAt) <= this.baseline.server);
    this.publish({ ...this.state, entitlement, state: active ? 'active'
      : status === 'revoked' ? 'revoked' : status === 'unknown' || status === 'pending_payment' ? 'pending_payment' : 'expired',
      verifiedAt: new Date(this.baseline.wall).toISOString(),
      nextDailyCheckAt: new Date(this.baseline.wall + this.day).toISOString(), reason: undefined });
  }

  private handleFailure(error: unknown, business = false): void {
    if (error instanceof OfficialAuthorizationError && error.code === 'session_invalid') this.clear();
    else if (error instanceof OfficialAuthorizationError && error.code === 'entitlement_inactive') {
      this.publish({ ...this.state, state: 'revoked', reason: '当前权益无效，请刷新或续费。' });
    } else if (!business || !(error instanceof OfficialAuthorizationError)
      || ['verification_unavailable', 'official_protocol_error'].includes(error.code)) {
      this.publish({ ...this.state, state: 'unavailable', reason: '官方授权暂时无法确认，新工作已暂停，请刷新权益。' });
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.token || this.disposed) return;
    // Local time observation only: network traffic occurs once per 24 hours with active work.
    const remaining = this.state.entitlement?.expiresAt && this.baseline
      ? Date.parse(this.state.entitlement.expiresAt) - this.baseline.server - (this.mono() - this.baseline.mono) : 30_000;
    this.timer = setTimeout(() => {
      this.getStatus();
      if (this.token && this.options.hasActiveWork?.() && this.mono() - this.dailyAttempt >= this.day) {
        this.dailyAttempt = this.mono(); // Failure also consumes the daily attempt; no rapid background retries.
        void this.verifyForProduction();
      }
      this.schedule();
    }, Math.max(100, Math.min(30_000, remaining > 0 ? remaining : 30_000)));
    this.timer.unref?.();
  }

  private clear(): void {
    ++this.generation;
    this.token = null;
    this.loginPending = false;
    this.check = null;
    this.baseline = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.publish(empty());
  }

  private publish(state: OfficialAuthorizationProjection): void {
    this.state = state;
    this.options.onStateChange?.(structuredClone(state));
    for (const listener of this.listeners) listener(structuredClone(state));
  }
}
