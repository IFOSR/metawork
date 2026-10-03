/**
 * 主仓库 Gateway 协议与 vendored AnyFusion-Pi 镜像的字段级契约测试
 * （统一 TUI 设计 §9.4）：不只比较 event kind 名称，而是验证 vendored
 * 客户端实际产出的 envelope 能被主仓库协议解析，且两侧事件 kind 集合一致。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GatewayClient } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.js';
import type { GatewayCommandEnvelope } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.js';
import { GATEWAY_EVENT_KINDS as VENDORED_EVENT_KINDS } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.js';
import { GATEWAY_EVENT_KINDS } from '../../src/gateway/client-events.js';
import {
  GATEWAY_CAPABILITY_COMMAND_COMPLETION,
  GATEWAY_CAPABILITY_TASK_VIEW,
  GATEWAY_SERVER_CAPABILITIES,
  parseGatewayCommandEnvelope,
} from '../../src/gateway/client-protocol.js';
import { parseGatewayClientMessage } from '../../src/gateway/protocol.js';

const VENDORED_PROTOCOL = join(
  process.cwd(),
  'planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.ts',
);

function makeClient() {
  const submitted: GatewayCommandEnvelope[] = [];
  let sequence = 0;
  const client = new GatewayClient({
    submit: async envelope => {
      submitted.push(envelope);
      return { requestId: envelope.requestId, status: 'accepted', conversationId: 'conv_1' };
    },
    subscribe: () => () => undefined,
    createId: prefix => `${prefix}_${sequence += 1}`,
  });
  return { client, submitted };
}

describe('gateway protocol mirror contract', () => {
  it('parses every vendored read-only query envelope with the authoritative protocol', async () => {
    const { client, submitted } = makeClient();

    await client.completeCommand('/task', 5, 'conv_1');
    await client.completeCommand('/wo', 3);
    await client.getTaskView('conv_1', 'turn_1', 'task_1');
    await client.submitWithEnvelope({ kind: 'get_pending_interactions', conversationId: 'conv_1' },
      { kind: 'conversation', selection: { mode: 'attach', conversationId: 'conv_1' } });
    await client.getQueryBillForTurn('turn_1');
    await client.getTaskUsageSummary('task_1');
    await client.submitWithEnvelope({ kind: 'get_conversation_resource', conversationId: 'conv_1',
      resource: 'locate', taskId: 'task_old' },
    { kind: 'conversation', selection: { mode: 'attach', conversationId: 'conv_1' } });

    expect(submitted).toHaveLength(7);
    for (const envelope of submitted) {
      expect(parseGatewayCommandEnvelope(envelope)).toEqual(envelope);
      expect(parseGatewayClientMessage({ type: 'command', envelope })).toEqual({
        type: 'command',
        envelope,
      });
    }
    expect(submitted[0]!.command.kind).toBe('complete_command');
    expect(submitted[1]!.command.kind).toBe('complete_command');
    expect(submitted[2]!.command.kind).toBe('get_task_view');
    expect(submitted[3]!.command.kind).toBe('get_pending_interactions');
  });

  it('keeps the event kind sets identical on both sides of the mirror', () => {
    expect([...VENDORED_EVENT_KINDS].sort()).toEqual([...GATEWAY_EVENT_KINDS].sort());
  });

  it('publishes the read-only capabilities the vendored client checks', () => {
    const vendored = readFileSync(VENDORED_PROTOCOL, 'utf8');
    expect(vendored).toMatch(new RegExp(`['"]${GATEWAY_CAPABILITY_COMMAND_COMPLETION}['"]`));
    expect(vendored).toMatch(new RegExp(`['"]${GATEWAY_CAPABILITY_TASK_VIEW}['"]`));
    expect(GATEWAY_SERVER_CAPABILITIES).toEqual(
      expect.arrayContaining([
        GATEWAY_CAPABILITY_COMMAND_COMPLETION,
        GATEWAY_CAPABILITY_TASK_VIEW,
      ]),
    );
  });
});
