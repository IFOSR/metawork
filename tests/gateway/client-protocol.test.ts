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

  it('accepts bounded complete_command in workspace and attached conversation scopes', () => {
    const workspaceCompletion = parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: { kind: 'workspace' },
      command: { kind: 'complete_command', text: '/wor', cursor: 4 },
    });
    expect(workspaceCompletion).toMatchObject({
      command: { kind: 'complete_command', text: '/wor', cursor: 4 },
    });
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'complete_command', text: '/task ' },
    })).not.toBeNull();
  });

  it('rejects complete_command without an explicit attached Conversation', () => {
    // Conversation scope 必须显式 attach 已存在的 Conversation，不得用 new/bound
    // 隐式获得补全上下文。
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: {
        kind: 'conversation',
        selection: { mode: 'new', workspaceId: 'workspace_repo' },
      },
      command: { kind: 'complete_command', text: '/task' },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: {
        kind: 'conversation',
        selection: {
          mode: 'bound',
          binding: { platform: 'feishu', channelId: 'ch_1' },
        },
      },
      command: { kind: 'complete_command', text: '/task' },
    })).toBeNull();
  });

  it('enforces the completion text limit and a valid UTF-16 cursor offset', () => {
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'complete_command', text: 'x'.repeat(8 * 1024 + 1) },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'complete_command', text: '/task', cursor: 6 },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'complete_command', text: '/task', cursor: -1 },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'complete_command', text: '/task', cursor: 1.5 },
    })).toBeNull();
    // 空输入合法：补全根候选。
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'complete_command', text: '' },
    })).not.toBeNull();
  });

  it('requires get_task_view to target the attached Conversation', () => {
    const command = {
      kind: 'get_task_view',
      conversationId: 'conv_1',
      turnId: 'turn_1',
      taskId: 'task_1',
    } as const;
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command,
    })).not.toBeNull();
    // conversationId 必须与 attach 目标一致。
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { ...command, conversationId: 'conv_other' },
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      scope: { kind: 'workspace' },
      command,
    })).toBeNull();
    expect(parseGatewayCommandEnvelope({
      ...conversationEnvelope(),
      command: { kind: 'get_task_view', conversationId: 'conv_1', turnId: 'turn_1' },
    })).toBeNull();
  });
});
