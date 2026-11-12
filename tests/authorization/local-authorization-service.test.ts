import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfficialServiceClient } from '../../src/authorization/official-service-client.js';
import { LocalAuthorizationService } from '../../src/authorization/local-authorization-service.js';
import { OfficialAuthorizationError, type OfficialOrderPaymentResult, type OfficialPaymentView, type OfficialOrderView } from '../../src/authorization/types.js';

const epoch = Date.parse('2026-10-09T00:00:00Z');
const day = 86400000;
function entitlement(offset = 0) {
  return { status: 'trial' as const, plan: 'trial' as const, effectiveAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 7 * day).toISOString(), revision: 1, serverTime: new Date(epoch + offset).toISOString() };
}
function paymentRow(status: OfficialPaymentView['status'] = 'pending'): OfficialPaymentView {
  return { hubOrderNo: 'a'.repeat(32), attempt: 1, status, amountCents: 990, qrCodeUrl: null, expiresAt: null, paidAt: null, channelOrderNo: null };
}
function orderRow(status = 'pending_payment', payment: OfficialPaymentView | null = null): OfficialOrderView {
  return { orderId: 'ord_1', plan: 'monthly', amountCny: '9.90', currency: 'CNY', status, createdAt: new Date(epoch).toISOString(), payment };
}
function client() {
  return {
    sendEmailCode: vi.fn(async (email: string) => ({ sent: true, expiresIn: 900 })),
    login: vi.fn(async (email: string) => ({ sessionToken: 'private-session', account: { accountId: `acct-${email}`, email }, entitlement: entitlement() })),
    logout: vi.fn(async () => undefined), verifyEntitlement: vi.fn(async () => entitlement()),
    register: vi.fn(async () => undefined), createOrder: vi.fn(async () => ({})), getPlans: vi.fn(async () => ({ plans: [] })),
    payOrder: vi.fn(async (): Promise<OfficialOrderPaymentResult> => ({ order: orderRow(), payment: paymentRow() })),
    getOrder: vi.fn(async (): Promise<OfficialOrderPaymentResult> => ({ order: orderRow(), payment: paymentRow() })),
    listOrders: vi.fn(async () => ({ orders: [] as OfficialOrderView[] })),
    ai: vi.fn(async () => ({ operation: 'responsibility_rewrite' as const, result: { mission: '测试' }, entitlement: entitlement() })),
  };
}
const services: LocalAuthorizationService[] = [];
function service(options: ConstructorParameters<typeof LocalAuthorizationService>[0]) {
  const result = new LocalAuthorizationService({ clock: () => epoch, ...options }); services.push(result); return result;
}
afterEach(async () => { await Promise.all(services.splice(0).map(value => value.dispose())); vi.useRealTimers(); });

describe('memory-only official authorization', () => {
  it('shares a single session, rejects replacement and does not serialize credentials', async () => {
    const api = client(); const auth = service({ client: api });
    expect((await auth.login('a@example.com', 'password')).state).toBe('active');
    await expect(auth.login('b@example.com', 'password')).rejects.toMatchObject({ code: 'already_logged_in' });
    expect(JSON.stringify(auth.getStatus())).not.toContain('private-session');
    await auth.logout(); expect(auth.getStatus().state).toBe('logged_out');
    expect(service({ client: api }).getStatus().state).toBe('logged_out');
  });
  it('revokes a late login response after logout, and rejects overlapping login', async () => {
    const api = client(); const original = await api.login('a@example.com', 'password');
    let finish!: (value: typeof original) => void;
    api.login.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const auth = service({ client: api }); const pending = auth.login('a@example.com', 'password');
    await expect(auth.login('b@example.com', 'password')).rejects.toMatchObject({ code: 'already_logged_in' });
    await auth.logout(); finish(original);
    await expect(pending).rejects.toMatchObject({ code: 'session_invalid' });
    expect(auth.getStatus().state).toBe('logged_out'); expect(api.logout).toHaveBeenCalledWith('private-session');
  });
  it('does not transfer unfinished work to another account', async () => {
    const auth = service({ client: client(), hasUnfinishedWork: () => true });
    await auth.login('a@example.com', 'password'); await auth.logout();
    await expect(auth.login('b@example.com', 'password')).rejects.toMatchObject({ code: 'already_logged_in' });
    expect((await auth.login('a@example.com', 'password')).state).toBe('active');
  });
  it('coalesces checks and fences old responses from a new account', async () => {
    const api = client(); let finish!: (value: ReturnType<typeof entitlement>) => void;
    // 第一次核验属于登录后的自动刷新，随后才进入需要挂起的核验。
    api.verifyEntitlement
      .mockImplementationOnce(async () => entitlement())
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementation(async () => entitlement());
    const auth = service({ client: api }); await auth.login('a@example.com', 'password');
    const pending = auth.verifyForProduction(); expect(auth.verifyForProduction()).toBe(pending);
    await auth.logout(); await auth.login('b@example.com', 'password'); finish(entitlement());
    expect((await pending).state).toBe('logged_out'); expect(auth.getStatus().account?.email).toBe('b@example.com');
  });
  it('closes on network failure, preserves login and only clears on explicit invalidation', async () => {
    const api = client(); const auth = service({ client: api }); await auth.login('a@example.com', 'password');
    api.verifyEntitlement.mockRejectedValueOnce(new Error('offline'));
    expect((await auth.verifyForProduction()).state).toBe('unavailable'); expect(auth.getStatus().account).not.toBeNull();
    expect((await auth.verifyForProduction()).state).toBe('active');
    api.verifyEntitlement.mockRejectedValueOnce(new OfficialAuthorizationError('invalid', 'session_invalid'));
    expect((await auth.verifyForProduction()).state).toBe('logged_out');
  });
  it('refreshes the entitlement online right after a successful login', async () => {
    const api = client(); const auth = service({ client: api });
    api.verifyEntitlement.mockResolvedValueOnce(entitlement(3600_000));
    const projection = await auth.login('a@example.com', 'password');
    expect(api.verifyEntitlement).toHaveBeenCalledTimes(1);
    expect(projection.state).toBe('active');
    // 登录后的权益以在线核验结果为准，而不是登录响应里的快照。
    expect(projection.entitlement?.serverTime).toBe(new Date(epoch + 3600_000).toISOString());
    expect(projection.verifiedAt).not.toBeNull();
  });
  it('keeps the official service untouched while no official session exists', async () => {
    const api = client(); const auth = service({ client: api });
    // 客户端页面进入时的刷新在未登录时不得产生官方网络流量。
    expect((await auth.verifyForProduction()).state).toBe('logged_out');
    expect(api.verifyEntitlement).not.toHaveBeenCalled();
  });
  it('checks once per 24h only with active work and never retries a failed check rapidly', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch); let active = false;
    const api = client(); const auth = service({ client: api, clock: Date.now, hasActiveWork: () => active });
    await auth.login('a@example.com', 'password');
    const afterLogin = api.verifyEntitlement.mock.calls.length;
    expect(afterLogin).toBe(1);
    await vi.advanceTimersByTimeAsync(day * 2); expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin);
    active = true; api.verifyEntitlement.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(30000); expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin + 1);
    await vi.advanceTimersByTimeAsync(day - 30000); expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin + 1);
    await vi.advanceTimersByTimeAsync(30000); expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin + 2);
  });
  it('closes at known expiry, on clock rollback, and after sleep', async () => {
    let wall = epoch; let mono = 0; const auth = service({ client: client(), clock: () => wall, monotonicClock: () => mono });
    await auth.login('a@example.com', 'password'); wall += 7 * day; mono += 7 * day;
    expect(auth.getStatus().state).toBe('expired');
    await auth.verifyForProduction(); wall -= day; expect(auth.getStatus().state).toBe('unavailable');
    await auth.verifyForProduction(); wall += day; expect(auth.getStatus().state).toBe('unavailable');
  });
  it('official AI supplies its own verification without a duplicate local network check', async () => {
    const api = client(); const auth = service({ client: api }); await auth.login('a@example.com', 'password');
    const afterLogin = api.verifyEntitlement.mock.calls.length;
    expect(await auth.callOfficialAi('responsibility_rewrite', {})).toEqual({ mission: '测试' });
    expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin);
    api.ai.mockRejectedValueOnce(new OfficialAuthorizationError('revoked', 'entitlement_inactive'));
    await expect(auth.callOfficialAi('responsibility_rewrite', {})).rejects.toThrow(); expect(auth.getStatus().state).toBe('revoked');
  });
  it('sends the email verification code without requiring a session', async () => {
    const api = client(); const auth = service({ client: api });
    await expect(auth.sendEmailCode('a@example.com')).resolves.toMatchObject({ sent: true, expiresIn: 900 });
    expect(auth.getStatus().state).toBe('logged_out');
    api.sendEmailCode.mockRejectedValueOnce(new OfficialAuthorizationError('注册功能暂时不可用，请联系客服', 'verification_unavailable'));
    await expect(auth.sendEmailCode('a@example.com')).rejects.toMatchObject({ code: 'verification_unavailable' });
    expect(auth.getStatus().state).toBe('logged_out');
  });
});

describe('official payment passthrough', () => {
  it('fences a late payOrder response after logout instead of accepting payment state', async () => {
    const api = client(); const auth = service({ client: api }); await auth.login('a@example.com', 'password');
    let finish!: (value: OfficialOrderPaymentResult) => void;
    api.payOrder.mockImplementation(() => new Promise<OfficialOrderPaymentResult>(resolve => { finish = resolve; }));
    const pending = auth.payOrder('ord_1');
    await auth.logout();
    finish({ order: orderRow('paid', paymentRow('paid')), payment: paymentRow('paid') });
    await expect(pending).rejects.toMatchObject({ code: 'session_invalid' });
    expect(auth.getStatus().state).toBe('logged_out');
  });
  it('verifies production online as soon as a refreshed order reports paid, and not on unpaid polls', async () => {
    const api = client(); const auth = service({ client: api }); await auth.login('a@example.com', 'password');
    const afterLogin = api.verifyEntitlement.mock.calls.length;
    api.getOrder.mockResolvedValueOnce({ order: orderRow('paid', paymentRow('paid')), payment: paymentRow('paid') });
    expect((await auth.refreshOrder('ord_1')).order.status).toBe('paid');
    expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin + 1);
    api.getOrder.mockResolvedValueOnce({ order: orderRow('pending_payment', paymentRow('pending')), payment: paymentRow('pending') });
    await auth.refreshOrder('ord_1');
    expect(api.verifyEntitlement).toHaveBeenCalledTimes(afterLogin + 1);
  });
  it('keeps payment surfaces unavailable when the client reports unconfigured service', async () => {
    const api = client();
    api.payOrder.mockRejectedValue(new OfficialAuthorizationError('未配置', 'payment_unavailable'));
    const auth = service({ client: api }); await auth.login('a@example.com', 'password');
    await expect(auth.payOrder('ord_1')).rejects.toMatchObject({ code: 'payment_unavailable' });
    expect(auth.getStatus().state).toBe('active'); // payment failures never change the entitlement state
  });
});

describe('official service client payment error mapping', () => {
  function clientWith(code: string, status: number) {
    return new OfficialServiceClient({ baseUrl: 'https://official.test', fetchImpl: (async () => new Response(JSON.stringify({ code }), { status })) });
  }
  it('maps hub failure codes onto the typed payment contract', async () => {
    await expect(clientWith('payment_hub_busy', 429).payOrder('t', 'ord_1')).rejects.toMatchObject({ code: 'payment_unavailable' });
    await expect(clientWith('payment_unavailable', 503).payOrder('t', 'ord_1')).rejects.toMatchObject({ code: 'payment_unavailable' });
    await expect(clientWith('OPC_PAY_CHANNEL_UNAVAILABLE', 503).payOrder('t', 'ord_1')).rejects.toMatchObject({ code: 'payment_unavailable' });
    await expect(clientWith('payment_order_expired', 400).payOrder('t', 'ord_1')).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(clientWith('payment_order_state_conflict', 409).payOrder('t', 'ord_1')).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(clientWith('order_not_payable', 400).payOrder('t', 'ord_1')).rejects.toMatchObject({ code: 'request_rejected' });
  });
});
