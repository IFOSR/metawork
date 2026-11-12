import { describe, expect, it, vi } from 'vitest';
import { OfficialServiceClient } from '../../src/authorization/official-service-client.js';

const fact = { status: 'trial', plan: 'trial', effectiveAt: '2026-10-09T00:00:00Z', expiresAt: '2026-10-16T00:00:00Z', revision: 1, serverTime: '2026-10-09T00:00:00Z' };
function client(value: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(value, { status }));
  return { api: new OfficialServiceClient({ baseUrl: 'https://official.example', fetchImpl }), fetchImpl };
}
describe('official HTTPS contract', () => {
  it.each(['http://official.example', 'https://user:password@official.example', 'https://official.example?key=secret'])('rejects unsafe endpoint %s', baseUrl => {
    expect(() => new OfficialServiceClient({ baseUrl })).toThrow();
  });
  it.each([{ ...fact, serverTime: undefined }, { ...fact, expiresAt: null }, { ...fact, effectiveAt: 'invalid' }, { ...fact, revision: -1 }])('fails closed on invalid entitlement', async entitlement => {
    await expect(client({ entitlement }).api.verifyEntitlement('token')).rejects.toMatchObject({ code: 'official_protocol_error' });
  });
  it('prohibits credential-bearing redirects and returns only business AI data', async () => {
    const { api, fetchImpl } = client({ operation: 'model_summary', result: { summary: '公开资料摘要' }, entitlement: fact, model: 'private-upstream' });
    const result = await api.ai({ operation: 'model_summary', input: {}, requestId: 'request-123' }, 'session');
    expect(result).toEqual({ operation: 'model_summary', result: { summary: '公开资料摘要' }, entitlement: fact });
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('distinguishes bad passwords, revoked sessions, business refusal and provider outage', async () => {
    await expect(client({ code: 'invalid_credentials' }, 401).api.login('a@example.com', 'bad')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(client({ code: 'email_code_expired' }, 400).api.register('a@example.com', 'password-12345', '000000')).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(client({}, 401).api.verifyEntitlement('token')).rejects.toMatchObject({ code: 'session_invalid' });
    await expect(client({ code: 'trial_already_used' }, 409).api.createOrder('token', 'trial', 'key')).rejects.toMatchObject({ code: 'request_rejected' });
    await expect(client({ code: 'official_ai_unavailable' }, 503).api.ai({ operation: 'model_summary', input: {}, requestId: 'request' }, 'token')).rejects.toMatchObject({ code: 'official_ai_unavailable' });
  });
  it('sends the email verification code and registers with it', async () => {
    const challenge = client({ code: 'OK', sent: true, expiresIn: 900 }, 200);
    await expect(challenge.api.sendEmailCode('a@example.com')).resolves.toMatchObject({ sent: true, expiresIn: 900 });
    await expect(challenge.fetchImpl.mock.calls[0]?.[0]).toContain('/v1/auth/email/code');
    await expect(client({ code: 'OK', sent: 'yes' }, 200).api.sendEmailCode('a@example.com')).rejects.toMatchObject({ code: 'official_protocol_error' });
    const ok = client({ code: 'OK' }, 201);
    await expect(ok.api.register('a@example.com', 'password-12345', '123456')).resolves.toBeUndefined();
    const body = JSON.parse(String(ok.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ email: 'a@example.com', password: 'password-12345', code: '123456' });
  });
  it('completes the login with a bounded session and a normalized account projection', async () => {
    const ok = client({ code: 'OK', sessionToken: 's'.repeat(40), account: { accountId: 'acct_1', email: 'a@example.com', displayName: 'A' }, entitlement: fact });
    const result = await ok.api.login('a@example.com', 'password-12345', { version: '0.1.18' });
    expect(result).toMatchObject({ sessionToken: 's'.repeat(40), account: { accountId: 'acct_1' } });
    const body = JSON.parse(String(ok.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ email: 'a@example.com', password: 'password-12345', client: { version: '0.1.18' } });
    await expect(client({ code: 'OK', sessionToken: 'short', account: { accountId: 'acct_1', email: 'a@example.com' }, entitlement: fact }).api.login('a@example.com', 'password-12345')).rejects.toMatchObject({ code: 'official_protocol_error' });
  });
  it('bounds response size without passing arbitrary upstream text into errors', async () => {
    await expect(client({ entitlement: fact, raw: 'x'.repeat(140000) }).api.verifyEntitlement('token')).rejects.toMatchObject({ code: 'official_protocol_error' });
  });
});
