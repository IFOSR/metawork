import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalAuthorizationService } from '../../src/authorization/local-authorization-service.js';
import { OfficialAuthorizationError } from '../../src/authorization/types.js';

const epoch = Date.parse('2026-10-09T00:00:00Z');
const day = 86400000;
function entitlement(offset = 0) {
  return { status: 'trial' as const, plan: 'trial' as const, effectiveAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 7 * day).toISOString(), revision: 1, serverTime: new Date(epoch + offset).toISOString() };
}
function client() {
  return {
    login: vi.fn(async (email: string) => ({ sessionToken: 'private-session', account: { accountId: email, email }, entitlement: entitlement() })),
    logout: vi.fn(async () => undefined), verifyEntitlement: vi.fn(async () => entitlement()),
    register: vi.fn(async () => undefined), createOrder: vi.fn(async () => ({})), getPlans: vi.fn(async () => ({ plans: [] })),
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
    const api = client(); const original = await api.login('a@example.com');
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
    api.verifyEntitlement.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
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
  it('checks once per 24h only with active work and never retries a failed check rapidly', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch); let active = false;
    const api = client(); const auth = service({ client: api, clock: Date.now, hasActiveWork: () => active });
    await auth.login('a@example.com', 'password');
    await vi.advanceTimersByTimeAsync(day * 2); expect(api.verifyEntitlement).not.toHaveBeenCalled();
    active = true; api.verifyEntitlement.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(30000); expect(api.verifyEntitlement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(day - 30000); expect(api.verifyEntitlement).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000); expect(api.verifyEntitlement).toHaveBeenCalledTimes(2);
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
    expect(await auth.callOfficialAi('responsibility_rewrite', {})).toEqual({ mission: '测试' });
    expect(api.verifyEntitlement).not.toHaveBeenCalled();
    api.ai.mockRejectedValueOnce(new OfficialAuthorizationError('revoked', 'entitlement_inactive'));
    await expect(auth.callOfficialAi('responsibility_rewrite', {})).rejects.toThrow(); expect(auth.getStatus().state).toBe('revoked');
  });
});
