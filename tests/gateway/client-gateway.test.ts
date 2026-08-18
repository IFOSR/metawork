import { describe, expect, it } from 'vitest';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';

const envelope: GatewayCommandEnvelope = {
  protocolVersion: 1,
  requestId: 'req_1',
  idempotencyKey: 'idem_1',
  connectionId: 'conn_1',
  conversation: { mode: 'new' },
  command: { kind: 'user_message', text: 'hello', attachments: [] },
  clientCapabilities: [],
};

describe('ClientGateway', () => {
  it('returns an authentication error when authentication fails', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => null },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });

    const result = await gateway.handle(envelope, 'web');
    expect(result).toMatchObject({ kind: 'authentication', requestId: 'req_1' });
  });

  it('returns an authorization error when the account is denied', async () => {
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'denied', reason: 'no mapping' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => ({ status: 'accepted' }),
    });

    const result = await gateway.handle(envelope, 'local');
    expect(result).toMatchObject({ kind: 'authorization', requestId: 'req_1' });
  });

  it('admits a valid command end to end', async () => {
    const activated: string[] = [];
    const submitted: string[] = [];
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async accountId => { activated.push(accountId); },
      submitToConversation: async conversationId => {
        submitted.push(conversationId);
        return { status: 'accepted' };
      },
    });

    const result = await gateway.handle(envelope, 'local');
    expect(result).toMatchObject({ status: 'accepted', conversationId: 'conv_1' });
    expect(activated).toEqual(['local-default']);
    expect(submitted).toEqual(['conv_1']);
  });

  it('returns duplicate for a repeated idempotency key', async () => {
    let submits = 0;
    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'created', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: async () => { submits += 1; return { status: 'accepted' }; },
    });

    await gateway.handle(envelope, 'local');
    const duplicate = await gateway.handle(envelope, 'local');

    expect(duplicate).toMatchObject({ status: 'duplicate' });
    expect(submits).toBe(1);
  });
});
