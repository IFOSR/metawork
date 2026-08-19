import { describe, expect, it } from 'vitest';
import {
  GATEWAY_PROTOCOL_VERSION,
  MAX_GATEWAY_ATTACHMENTS,
  MAX_GATEWAY_COMMAND_TEXT_BYTES,
  MAX_GATEWAY_ID_BYTES,
  parseGatewayCommandEnvelope,
  type GatewayCommandEnvelope,
} from '../../src/gateway/client-protocol.js';

describe('gateway client command protocol', () => {
  it('accepts a valid user message command envelope', () => {
    const command: GatewayCommandEnvelope = {
      protocolVersion: 1,
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      connectionId: 'conn_1',
      conversation: { mode: 'attach', conversationId: 'conv_1' },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      clientCapabilities: ['trace_v1'],
    };
    expect(parseGatewayCommandEnvelope(command)).toEqual(command);
  });

  it('accepts bound and new conversation selections', () => {
    const bound: GatewayCommandEnvelope = {
      protocolVersion: 1,
      requestId: 'req_2',
      idempotencyKey: 'idem_2',
      connectionId: 'conn_2',
      conversation: { mode: 'bound', binding: { platform: 'feishu', channelId: 'chat_1' } },
      command: { kind: 'user_message', text: 'hi', attachments: [] },
      clientCapabilities: [],
    };
    const fresh: GatewayCommandEnvelope = {
      protocolVersion: 1,
      requestId: 'req_3',
      idempotencyKey: 'idem_3',
      connectionId: 'conn_3',
      conversation: { mode: 'new' },
      command: { kind: 'slash_command', text: '/status' },
      clientCapabilities: [],
    };
    expect(parseGatewayCommandEnvelope(bound)).toEqual(bound);
    expect(parseGatewayCommandEnvelope(fresh)).toEqual(fresh);
  });

  it('rejects client payloads that set a trusted accountId', () => {
    const input = {
      protocolVersion: 1,
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      connectionId: 'conn_1',
      accountId: 'local-default',
      conversation: { mode: 'new' },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      clientCapabilities: [],
    };
    expect(parseGatewayCommandEnvelope(input)).toBeNull();
  });

  it('rejects client payloads that set a trusted principal', () => {
    const input = {
      protocolVersion: 1,
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      connectionId: 'conn_1',
      principal: { kind: 'local', id: 'x' },
      conversation: { mode: 'new' },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      clientCapabilities: [],
    };
    expect(parseGatewayCommandEnvelope(input)).toBeNull();
  });

  it('rejects unknown protocol versions', () => {
    const input = {
      protocolVersion: 999,
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      connectionId: 'conn_1',
      conversation: { mode: 'new' },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      clientCapabilities: [],
    };
    expect(parseGatewayCommandEnvelope(input)).toBeNull();
  });

  it('rejects an attach selection without a conversationId', () => {
    const input = {
      protocolVersion: 1,
      requestId: 'req_1',
      idempotencyKey: 'idem_1',
      connectionId: 'conn_1',
      conversation: { mode: 'attach' },
      command: { kind: 'user_message', text: 'hello', attachments: [] },
      clientCapabilities: [],
    };
    expect(parseGatewayCommandEnvelope(input)).toBeNull();
  });

  it('rejects command text and identifiers above their protocol limits', () => {
    expect(parseGatewayCommandEnvelope({
      ...validEnvelope(),
      requestId: 'r'.repeat(MAX_GATEWAY_ID_BYTES + 1),
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...validEnvelope(),
      command: {
        kind: 'user_message',
        text: 'x'.repeat(MAX_GATEWAY_COMMAND_TEXT_BYTES + 1),
        attachments: [],
      },
    })).toBeNull();
  });

  it('rejects excessive capabilities and attachment references', () => {
    expect(parseGatewayCommandEnvelope({
      ...validEnvelope(),
      command: {
        kind: 'user_message',
        text: 'hello',
        attachments: Array.from(
          { length: MAX_GATEWAY_ATTACHMENTS + 1 },
          (_, index) => ({ attachmentId: `attachment_${index}`, kind: 'file' }),
        ),
      },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...validEnvelope(),
      clientCapabilities: Array.from({ length: 33 }, (_, index) => `capability_${index}`),
    })).toBeNull();
  });

  it('exports a stable protocol version constant', () => {
    expect(GATEWAY_PROTOCOL_VERSION).toBe(1);
  });
});

function validEnvelope(): GatewayCommandEnvelope {
  return {
    protocolVersion: 1,
    requestId: 'req_1',
    idempotencyKey: 'idem_1',
    connectionId: 'conn_1',
    conversation: { mode: 'attach', conversationId: 'conv_1' },
    command: { kind: 'user_message', text: 'hello', attachments: [] },
    clientCapabilities: ['trace_v1'],
  };
}
