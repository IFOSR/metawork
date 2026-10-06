import { describe, expect, it } from 'vitest';
import { DesktopSessionService } from '../../src/management/desktop-session.js';
import { parseGatewayClientMessage } from '../../src/gateway/protocol.js';
import { exchangeDesktopSession } from '../../src/client/desktop-session-client.js';
import type { DesktopSessionIdentity } from '../../src/gateway/desktop-session-contract.js';

const identity: DesktopSessionIdentity = {
  installationId: 'a'.repeat(64), instanceId: 'instance-1', accountId: 'local-default',
  releaseId: 'desktop-test', pid: 123, webOrigin: 'http://127.0.0.1:8788', gatewayProtocolVersion: 2,
};
const nonce = 'b'.repeat(64);
const exchange = (grant: { ticket: string; nonce: string; instanceId: string }) => ({
  ticket: grant.ticket, nonce: grant.nonce, instanceId: grant.instanceId,
});

describe('Desktop local session boundary', () => {
  it('is single-use, account-bound and unavailable while draining', () => {
    let ready = true;
    const service = new DesktopSessionService(() => ready ? identity : null);
    expect(() => service.issue(nonce, 'another-account')).toThrow();
    const grant = service.issue(nonce, identity.accountId);
    expect(service.consume(exchange(grant))).toEqual(identity);
    expect(service.consume(exchange(grant))).toBeNull();
    const pending = service.issue(nonce, identity.accountId);
    ready = false;
    expect(service.consume(exchange(pending))).toBeNull();
    expect(service.proof(nonce)).toBeNull();
  });

  it('rejects expiry, wrong nonce, wrong instance and cross-process replay', () => {
    let now = 100;
    const service = new DesktopSessionService(() => identity, () => now);
    const expired = service.issue(nonce, identity.accountId);
    now += 15_000;
    expect(service.consume(exchange(expired))).toBeNull();
    const grant = service.issue(nonce, identity.accountId);
    expect(service.consume({ ...exchange(grant), nonce: 'c'.repeat(64) })).toBeNull();
    expect(service.consume(exchange(grant))).toBeNull();
    const other = service.issue(nonce, identity.accountId);
    expect(service.consume({ ...exchange(other), instanceId: 'other' })).toBeNull();
    const restarted = new DesktopSessionService(() => ({ ...identity, instanceId: 'next' }));
    expect(restarted.consume(exchange(service.issue(nonce, identity.accountId)))).toBeNull();
    expect(restarted.proof(nonce)).not.toBe(service.proof(nonce));
  });

  it('bounds pending tickets and reclaims expired slots', () => {
    let now = 0;
    const service = new DesktopSessionService(() => identity, () => now);
    for (let i = 0; i < 128; i++) service.issue(nonce, identity.accountId);
    expect(() => service.issue(nonce, identity.accountId)).toThrow('capacity');
    now = 15_000;
    expect(() => service.issue(nonce, identity.accountId)).not.toThrow();
  });

  it('rejects account injection and nonces outside the wire contract', () => {
    expect(parseGatewayClientMessage({ type: 'register_desktop_session', nonce })).not.toBeNull();
    expect(parseGatewayClientMessage({ type: 'register_desktop_session', nonce, accountId: 'admin' })).toBeNull();
    expect(parseGatewayClientMessage({ type: 'register_desktop_session', nonce: 'short' })).toBeNull();
  });

  it('never discloses a ticket to an HTTP endpoint that fails local instance proof', async () => {
    const grant = new DesktopSessionService(() => identity).issue(nonce, identity.accountId);
    const requests: Array<{ url: string; body: unknown }> = [];
    const fakeFetch: typeof fetch = async (input, options) => {
      requests.push({ url: String(input), body: options?.body });
      return new Response(JSON.stringify({ proof: 'wrong-server' }));
    };
    await expect(exchangeDesktopSession(grant, fakeFetch)).rejects.toThrow('does not match');
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain(grant.ticket);
  });
});
