import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseGatewayCommandEnvelope, type GatewayCommand } from './client-protocol.js';

export interface ClientActionReference {
  readonly id: string;
  readonly accountId: string;
  readonly principalId: string;
  readonly conversationId: string;
  readonly chatId: string;
  readonly threadId: string | null;
  readonly expiresAt: number;
  readonly command: GatewayCommand;
}
export interface ClientActionReferenceStore {
  signingKey(): string;
  put(value: ClientActionReference): void;
  find(id: string): ClientActionReference | null;
}

/** The signed value names a server-owned exact target; it never grants account authority. */
export class ClientActionReferences {
  constructor(private readonly store: ClientActionReferenceStore, private readonly now: () => number = Date.now) {}
  issue(input: Omit<ClientActionReference, 'id' | 'expiresAt'>, ttlMs = 15 * 60_000): string {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60_000) throw new Error('invalid_action_expiry');
    const value: ClientActionReference = { ...input, id: randomUUID(), expiresAt: this.now() + ttlMs };
    this.store.put(value);
    return `${value.id}.${this.signature(value)}`;
  }
  resolve(token: string, actor: Pick<ClientActionReference, 'accountId' | 'principalId' | 'chatId' | 'threadId'>): ClientActionReference {
    if (typeof token !== 'string' || token.length > 256) throw new Error('invalid_action_reference');
    const [id, signature, extra] = token.split('.');
    if (!id || !signature || extra || !/^[a-f0-9]{64}$/u.test(signature)) throw new Error('invalid_action_reference');
    const value = this.store.find(id);
    if (!value || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.signature(value), 'hex'))) throw new Error('invalid_action_reference');
    if (value.accountId !== actor.accountId || value.principalId !== actor.principalId || value.chatId !== actor.chatId
      || value.threadId !== actor.threadId) throw new Error('forbidden_scope');
    if (value.expiresAt <= this.now()) throw new Error('request_expired');
    if (!parseGatewayCommandEnvelope({ protocolVersion: 2, requestId: 'action', idempotencyKey: 'action', connectionId: 'action',
      scope: { kind: 'conversation', selection: { mode: 'attach', conversationId: value.conversationId } },
      command: value.command, clientCapabilities: [] })) throw new Error('capability_mismatch');
    return value;
  }
  private signature(value: ClientActionReference): string {
    return createHmac('sha256', this.store.signingKey()).update(JSON.stringify(value)).digest('hex');
  }
}
