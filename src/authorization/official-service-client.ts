import { z } from 'zod';
import {
  OfficialAuthorizationError,
  type OfficialAiRequest,
  type OfficialAiResult,
  type OfficialAccount,
  type OfficialEntitlement,
  type OfficialLoginResult,
} from './types.js';

export const DEFAULT_OFFICIAL_SERVICE_URL = 'https://14.103.216.193:9222';

export interface OfficialServiceClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** HTTPS adapter. The session token is deliberately supplied by the caller and never persisted here. */
export class OfficialServiceClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private baseUrl: string;

  constructor(options: OfficialServiceClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Official service requires an HTTPS URL without credentials');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async login(email: string, password: string, client?: { version?: string }): Promise<{ sessionToken: string } & OfficialLoginResult> {
    const response = await this.request('/v1/auth/login', {
      method: 'POST',
      body: { email, password, client },
    });
    const data = parseObject(response, 'login');
    const account = parseAccount(data.account);
    const entitlement = parseEntitlement(data.entitlement);
    const sessionToken = typeof data.sessionToken === 'string' && data.sessionToken.length >= 32
      ? data.sessionToken : null;
    if (!sessionToken) throw new OfficialAuthorizationError('官方服务返回的登录会话无效', 'official_protocol_error');
    return { sessionToken, account, entitlement };
  }

  async register(email: string, password: string): Promise<void> {
    await this.request('/v1/auth/register', { method: 'POST', body: { email, password } });
  }

  async getPlans(): Promise<{ plans: Array<{ plan: 'trial' | 'monthly' | 'annual'; amountCny: string; currency: 'CNY'; duration: string; payment: string }> }> {
    const result = z.object({ plans: z.array(z.object({
      plan: z.enum(['trial', 'monthly', 'annual']), amountCny: z.string().regex(/^\d+\.\d{2}$/u),
      currency: z.literal('CNY'), duration: z.string().max(100), payment: z.enum(['activate', 'pending_payment']),
    })).max(3) }).safeParse(await this.request('/v1/plans', { method: 'GET' }));
    if (!result.success) throw new OfficialAuthorizationError('套餐响应无效', 'official_protocol_error');
    return result.data;
  }

  async logout(sessionToken: string): Promise<void> {
    await this.request('/v1/auth/logout', { method: 'POST', sessionToken, allowError: true });
  }

  async verifyEntitlement(sessionToken: string): Promise<OfficialEntitlement> {
    const response = await this.request('/v1/entitlement', { method: 'GET', sessionToken });
    return parseEntitlement(parseObject(response, 'entitlement').entitlement);
  }

  async createOrder(sessionToken: string, plan: 'trial' | 'monthly' | 'annual', idempotencyKey: string): Promise<unknown> {
    return this.request('/v1/orders', { method: 'POST', sessionToken, body: { plan, idempotencyKey } });
  }

  async getSession(sessionToken: string): Promise<OfficialAccount> {
    const response = await this.request('/v1/auth/session', { method: 'GET', sessionToken });
    return parseAccount(parseObject(response, 'session').account);
  }

  async ai(request: OfficialAiRequest, sessionToken: string): Promise<OfficialAiResult> {
    const response = await this.request('/v1/ai/operation', {
      method: 'POST', sessionToken, body: request,
    });
    const data = parseObject(response, 'official AI');
    if (data.operation !== request.operation || !('result' in data)) {
      throw new OfficialAuthorizationError('官方内置 AI 响应无效', 'official_protocol_error');
    }
    return { operation: request.operation, result: data.result, entitlement: parseEntitlement(data.entitlement) };
  }

  private async request(path: string, input: {
    method: 'GET' | 'POST';
    body?: unknown;
    sessionToken?: string;
    allowError?: boolean;
  }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), isAiPath(path) ? Math.max(this.timeoutMs, 45000) : this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: input.method,
        headers: {
          Accept: 'application/json',
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(input.sessionToken ? { Authorization: `Bearer ${input.sessionToken}` } : {}),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        signal: controller.signal,
        redirect: 'error',
      });
      const raw = await readBoundedResponse(response);
      const data = raw ? parseObject(JSON.parse(raw), 'response') : {};
      if (response.ok || (input.allowError && response.status === 401)) return data;
      const code = typeof data?.code === 'string' ? data.code : '';
      if (response.status === 401 && path === '/v1/auth/login') throw new OfficialAuthorizationError('邮箱或密码不正确', 'invalid_credentials');
      if (['trial_already_used', 'account_exists', 'invalid_account', 'idempotency_conflict', 'active_plan_conflict', 'rate_limited', 'daily_limit', 'request_already_processed', 'invalid_input', 'invalid_operation'].includes(code)) {
        throw new OfficialAuthorizationError(({ trial_already_used: '该账号已使用过试用', account_exists: '账号已存在', invalid_account: '请填写有效邮箱及 12–128 位密码', idempotency_conflict: '订单请求冲突，请刷新', active_plan_conflict: '当前套餐不支持此操作', rate_limited: '请求过于频繁，请稍后重试', daily_limit: '今日内置 AI 额度已用完', request_already_processed: '此请求已处理，请刷新后重试', invalid_input: '业务输入超出限制或格式不正确', invalid_operation: '不支持的内置 AI 操作' } as Record<string, string>)[code]!, 'request_rejected');
      }
      if (code === 'official_ai_unavailable') throw new OfficialAuthorizationError('MetaWork 内置 AI 暂时不可用', 'official_ai_unavailable');
      if (response.status === 401) throw new OfficialAuthorizationError('官方登录会话已失效，请重新登录', 'session_invalid');
      if (response.status === 402 || code === 'entitlement_inactive') {
        throw new OfficialAuthorizationError('当前账号没有有效 MetaWork 服务权益', 'entitlement_inactive');
      }
      if (response.status === 503) throw new OfficialAuthorizationError('官方服务暂时无法核验，请稍后重试', 'verification_unavailable');
      throw new OfficialAuthorizationError('官方服务请求失败', isAiPath(path) ? 'official_ai_unavailable' : 'official_protocol_error');
    } catch (error) {
      if (error instanceof OfficialAuthorizationError) throw error;
      throw new OfficialAuthorizationError(
        controller.signal.aborted ? '官方服务请求超时，请重试' : '官方服务暂时无法连接，请重试',
        'verification_unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseObject(value: unknown, operation: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OfficialAuthorizationError(`官方 ${operation} 响应无效`, 'official_protocol_error');
  }
  return value as Record<string, unknown>;
}

function parseAccount(value: unknown): OfficialAccount {
  const result = z.object({ accountId: z.string().min(1).max(128), email: z.string().email().max(254), displayName: z.string().max(120).optional() }).safeParse(value);
  if (!result.success) throw new OfficialAuthorizationError('官方账号响应无效', 'official_protocol_error');
  return result.data;
}

function parseEntitlement(value: unknown): OfficialEntitlement {
  const timestamp = z.string().datetime({ offset: true });
  const result = z.object({
    status: z.enum(['active', 'trial', 'pending_payment', 'expired', 'revoked', 'unknown']),
    plan: z.enum(['trial', 'monthly', 'annual', 'internal_perpetual']).nullable(),
    effectiveAt: timestamp.nullable(), expiresAt: timestamp.nullable(),
    revision: z.number().int().nonnegative(), serverTime: timestamp,
  }).safeParse(value);
  if (!result.success || (['active', 'trial'].includes(result.data.status)
    && (!result.data.plan || !result.data.effectiveAt || (result.data.plan !== 'internal_perpetual' && !result.data.expiresAt)))) {
    throw new OfficialAuthorizationError('官方权益响应无效', 'official_protocol_error');
  }
  return result.data;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) throw new OfficialAuthorizationError('官方响应超出限制', 'official_protocol_error');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => undefined); }
}

function isAiPath(path: string): boolean {
  return path.startsWith('/v1/ai/');
}
