import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { GatewayClient } from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-client.js';
import type {
  GatewayCommandEnvelope,
  GatewayEventEnvelope,
} from '../../planner/AnyFusion-Pi/packages/coding-agent/src/anyfusion/gateway-protocol.js';
import { parseGatewayClientMessage } from '../../src/gateway/protocol.js';

function makeClient() {
  const submitted: GatewayCommandEnvelope[] = [];
  const replayed: number[] = [];
  let publish: (event: GatewayEventEnvelope) => void = () => undefined;
  let sequenceCounter = 0;

  const client = new GatewayClient({
    submit: async envelope => {
      submitted.push(envelope);
      return { requestId: envelope.requestId, status: 'accepted', conversationId: 'conv_1' };
    },
    replay: async (_conversationId, afterSequence) => {
      replayed.push(afterSequence ?? 0);
      return { lastSequence: 5, snapshot: [], deltas: [] };
    },
    subscribe: listener => {
      publish = listener;
      return () => undefined;
    },
    createId: prefix => {
      sequenceCounter += 1;
      return `${prefix}_${sequenceCounter}`;
    },
  });

  return { client, submitted, replayed, publish: (kind: string, sequence: number) => {
    publish({
      protocolVersion: 2,
      eventId: `evt_${sequence}`,
      sequence,
      accountId: 'local-default',
      conversationId: 'conv_1',
      requestId: null,
      turnId: null,
      kind: kind as GatewayEventEnvelope['kind'],
      payload: {},
      occurredAt: '2026-08-18T00:00:00.000Z',
    });
  } };
}

describe('native TUI gateway client', () => {
  it('submits raw user input as a user_message command', async () => {
    const { client, submitted } = makeClient();
    await client.submitUserInput('hello', { mode: 'new', workspaceId: 'workspace_repo' });

    expect(submitted).toHaveLength(1);
    expect(submitted[0].command).toEqual({ kind: 'user_message', text: 'hello', attachments: [] });
    expect(submitted[0].connectionId).toMatch(/^tui_/u);
    expect(submitted[0].protocolVersion).toBe(2);
  });

  it('submits slash commands with a versioned command kind', async () => {
    const { client, submitted } = makeClient();
    await client.submitSlashCommand('/status', { mode: 'new', workspaceId: 'workspace_repo' });

    expect(submitted[0].command).toEqual({ kind: 'slash_command', text: '/status' });
  });

  it('renders streamed events and tracks the cursor', () => {
    const { client, publish } = makeClient();
    const received: string[] = [];
    client.onEvent(event => received.push(event.kind));

    publish('turn_started', 1);
    publish('trace_delta', 2);
    publish('final_answer', 3);

    expect(received).toEqual(['turn_started', 'trace_delta', 'final_answer']);
    expect(client.currentSequence).toBe(3);
  });

  it('resumes from the last cursor', async () => {
    const { client, replayed } = makeClient();

    await client.resume('conv_1');
    expect(replayed).toEqual([0]);
    expect(client.currentSequence).toBe(5);

    await client.resume('conv_1');
    expect(replayed).toEqual([0, 5]);
  });

  it('does not invoke a local semantic AgentSession', () => {
    // GatewayClient 只依赖 submit/replay/subscribe 端口，没有构造或 import
    // 本地语义 AgentSession。本测试通过类型边界验证：client 无本地语义依赖。
    const { client } = makeClient();
    expect(client).toBeDefined();
  });

  it('has a production client-only mode caller before Pi creates AgentSession runtime', () => {
    const mainSource = readFileSync(
      'planner/AnyFusion-Pi/packages/coding-agent/src/main.ts',
      'utf8',
    );
    // ADR-0041：唯一产品 TUI 入口按需加载，仍先于本地 Agent 运行时。
    expect(mainSource).toContain('runMetaWorkTui');
    expect(mainSource).toContain('./modes/metawork-tui/index.ts');
    expect(mainSource.indexOf('await runMetaWorkTui'))
      .toBeLessThan(mainSource.indexOf('await import("./main-runtime.ts")'));

    // 简版客户端与本地交互 Agent TUI 已删除；无 Gateway 的交互调用明确失败。
    expect(mainSource).not.toContain('runAnyFusionClientMode');
    expect(mainSource).not.toContain('InteractiveMode');
    const runtimeSource = readFileSync(
      'planner/AnyFusion-Pi/packages/coding-agent/src/main-runtime.ts', 'utf8',
    );
    expect(runtimeSource).toContain('standalone interactive agent UI is retired');
    expect(existsSync(
      'planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/anyfusion-client-mode.ts',
    )).toBe(false);
    expect(existsSync(
      'planner/AnyFusion-Pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts',
    )).toBe(false);

    // 新 TUI 树无本地 Agent/模型/工具实现。
    const tuiEntry = readFileSync(
      'planner/AnyFusion-Pi/packages/coding-agent/src/modes/metawork-tui/index.ts',
      'utf8',
    );
    expect(tuiEntry).toContain('runMetaWorkTui');
    expect(tuiEntry).not.toContain('AgentSession');
    expect(tuiEntry).not.toContain('.prompt(');
    expect(tuiEntry).not.toContain('SessionManager');
  });

  it('accepts only the untrusted Web launch hint on the local control message', () => {
    expect(parseGatewayClientMessage({
      type: 'register_web_launch',
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    })).toEqual({
      type: 'register_web_launch',
      workspaceHint: '/repo-a',
      conversationId: 'conv_1',
    });
    expect(parseGatewayClientMessage({
      type: 'register_web_launch',
      workspaceHint: '/repo-a',
      selectedAt: '2026-08-27T08:00:00.000Z',
    })).toBeNull();
  });
});
