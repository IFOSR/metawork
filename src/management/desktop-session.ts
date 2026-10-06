import { createHmac, randomBytes } from 'node:crypto';
import {
  isDesktopNonce,
  type DesktopSessionGrant,
  type DesktopSessionIdentity,
} from '../gateway/desktop-session-contract.js';

/** Issuance is reachable only through the owner-only local Gateway. */
export class DesktopSessionService {
  private readonly secret = randomBytes(32);
  private readonly tickets = new Map<string, DesktopSessionGrant>();

  constructor(
    private readonly identity: () => DesktopSessionIdentity | null,
    private readonly now: () => number = Date.now,
  ) {}

  proof(nonce: unknown): string | null {
    const identity = this.identity();
    if (!identity || !isDesktopNonce(nonce)) return null;
    return createHmac('sha256', this.secret)
      .update(JSON.stringify([identity, nonce])).digest('hex');
  }

  issue(nonce: string, accountId: string): DesktopSessionGrant {
    const identity = this.identity();
    const proof = this.proof(nonce);
    if (!identity || !proof || accountId !== identity.accountId) {
      throw new Error('Desktop session is unavailable');
    }
    for (const [key, entry] of this.tickets) {
      if (entry.expiresAt <= this.now()) this.tickets.delete(key);
    }
    if (this.tickets.size >= 128) throw new Error('Desktop session capacity exceeded');
    const grant = {
      ...identity, nonce, proof, ticket: randomBytes(32).toString('hex'),
      expiresAt: this.now() + 15_000,
    };
    this.tickets.set(grant.ticket, grant);
    return grant;
  }

  consume(input: unknown): DesktopSessionIdentity | null {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const fields = input as Record<string, unknown>;
    if (Object.keys(fields).some(key => !['ticket', 'nonce', 'instanceId'].includes(key))
      || !isDesktopNonce(fields.ticket) || !isDesktopNonce(fields.nonce)
      || typeof fields.instanceId !== 'string') return null;
    const grant = this.tickets.get(fields.ticket);
    this.tickets.delete(fields.ticket);
    const current = this.identity();
    if (!grant || !current || grant.expiresAt <= this.now()
      || grant.nonce !== fields.nonce || grant.instanceId !== fields.instanceId
      || grant.proof !== this.proof(grant.nonce)) return null;
    return current;
  }
}
