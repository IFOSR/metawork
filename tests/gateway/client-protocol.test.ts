import { describe, expect, it } from 'vitest';
import {
  GATEWAY_PROTOCOL_VERSION,
  parseGatewayCommandEnvelope,
  type GatewayCommandEnvelope,
} from '../../src/gateway/client-protocol.js';

function conversationEnvelope(): GatewayCommandEnvelope {
  return {
    protocolVersion: 2,
    requestId: 'req_1',
    idempotencyKey: 'idem_1',
    connectionId: 'conn_1',
    scope: {
      kind: 'conversation',
      selection: { mode: 'attach', conversationId: 'conv_1' },
    },
    command: { kind: 'user_message', text: 'hello', attachments: [] },
    clientCapabilities: ['trace_v1'],
  };
}

describe('gateway client command protocol v2', () => {
  it('accepts Conversation and Workspace scopes', () => {
    const conversation = conversationEnvelope();
    const workspace: GatewayCommandEnvelope = {
      ...conversation,
      scope: { kind: 'workspace' },
      command: { kind: 'select_workspace', path: '/repo-a' },
    };
    expect(parseGatewayCommandEnvelope(conversation)).toEqual(conversation);
    expect(parseGatewayCommandEnvelope(workspace)).toEqual(workspace);
  });

  it('requires a workspaceId for new Conversations', () => {
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: {
        kind: 'conversation',
        selection: { mode: 'new', workspaceId: 'workspace_repo' },
      },
    })).not.toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: { kind: 'conversation', selection: { mode: 'new' } },
    })).toBeNull();
  });

  it('rejects commands placed in the wrong scope', () => {
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: { kind: 'workspace' },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'select_workspace', path: '/repo-a' },
    })).toBeNull();
  });

  it('accepts bounded history commands and rejects trusted fields', () => {
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: {
        kind: 'get_conversation_history',
        conversationId: 'conv_1',
        limit: 20,
      },
    })).not.toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      accountId: 'local-default',
    })).toBeNull();
  });

  it('hard rejects v1 envelopes', () => {
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      protocolVersion: 1,
    })).toBeNull();
    expect(GATEWAY_PROTOCOL_VERSION).toBe(2);
  });
});
