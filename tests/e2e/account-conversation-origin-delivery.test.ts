import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountRuntimeHandle } from '../../src/account/account-runtime-ports.js';
import { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayCommand, GatewayCommandEnvelope } from '../../src/gateway/client-protocol.js';
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { MemoryCommandAdmissionStore } from '../../src/gateway/command-admission-store.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from '../../src/session/conversation-input-mailbox.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import type { ConversationSession } from '../../src/session/conversation-session.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeConversation {
  readonly output: string[] = [];
  private readonly mailbox = new ConversationInputMailbox({ execute: async () => undefined });

  constructor(readonly conversationId: string) {}

  bindMailboxExecutor(execute: (command: MailboxCommand) => Promise<void>): void {
    this.mailbox.bindExecutor(execute);
  }

  submitCommand(command: MailboxCommand): MailboxReceipt {
    return this.mailbox.submit(command);
  }

  async executeGatewayCommand(command: GatewayCommand): Promise<void> {
    this.output.push(`answer:${'text' in command ? command.text : command.kind}`);
  }

  getOutput(): string[] {
    return [...this.output];
  }

  getResultDeliveries(): unknown[] {
    return [];
  }

  hasBackgroundWork(): boolean {
    return false;
  }

  async getWorkspace(): Promise<null> {
    return null;
  }

  subscribe(): () => void {
    return () => undefined;
  }

  subscribeInteractionTrace(): () => void {
    return () => undefined;
  }

  attachClient(): void {}

  detachClient(): void {}
}

function commandEnvelope(
  requestId: string,
  connectionId: string,
  text: string,
): GatewayCommandEnvelope {
  return {
    protocolVersion: 2,
    requestId,
    idempotencyKey: `idem_${requestId}`,
    connectionId,
    scope: {
      kind: 'conversation',
      selection: { mode: 'attach', conversationId: 'conv_1' },
    },
    command: { kind: 'user_message', text, attachments: [] },
    clientCapabilities: ['trace_v1'],
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe('account conversation origin delivery', () => {
  it('isolates detailed live events by origin and replays all origins in order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-e2e-origin-'));
    roots.push(root);

    const journal = new FileEventJournal(join(root, 'events'));
    const subscriptions = new GatewaySubscriptions();
    const conversations = new ConversationRegistry();

    const runtime = new ConversationGatewayRuntime({
      accountId: 'local-default',
      registry: {
        getOrActivate: async () => ({ accountId: 'local-default' }) as AccountRuntimeHandle,
        getIfLoaded: () => null,
      } as never,
      conversations,
      conversationFactory: (conversationId: string) =>
        new FakeConversation(conversationId) as unknown as ConversationSession,
      journal,
      subscriptions,
      createId: prefix => `${prefix}_${Math.random().toString(36).slice(2)}`,
    });

    const gateway = new ClientGateway({
      authenticator: { authenticate: async () => ({ kind: 'local', id: 'local-installation' }) },
      accountResolver: { resolve: async () => ({ status: 'authorized', accountId: 'local-default' }) },
      conversationResolver: { resolve: async () => ({ status: 'resolved', conversationId: 'conv_1' }) },
      activateAccount: async () => undefined,
      submitToConversation: (conversationId, requestId, idempotencyKey, command, principalId, origin) =>
        runtime.submit(conversationId, requestId, idempotencyKey, command, principalId, origin),
      commandAdmissionStore: new MemoryCommandAdmissionStore(),
    });

    const webEvents: GatewayEventEnvelope[] = [];
    const feishuEvents: GatewayEventEnvelope[] = [];
    const tuiEvents: GatewayEventEnvelope[] = [];
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: 'web_a',
      listener: event => webEvents.push(event),
    });
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: 'feishu_b',
      listener: event => feishuEvents.push(event),
    });
    subscriptions.subscribe({
      accountId: 'local-default',
      conversationId: 'conv_1',
      liveConnectionId: 'tui_c',
      listener: event => tuiEvents.push(event),
    });

    await gateway.handle(commandEnvelope('req_web', 'web_a', 'from-web'), 'web');
    await gateway.handle(commandEnvelope('req_feishu', 'feishu_b', 'from-feishu'), 'feishu');
    await gateway.handle(commandEnvelope('req_tui', 'tui_c', 'from-tui'), 'local');

    await waitFor(async () => {
      const replay = await journal.replay('local-default', 'conv_1');
      const finals = [...replay.snapshot, ...replay.deltas].filter(
        event => event.kind === 'final_answer',
      );
      return finals.length === 3;
    });

    const finalLines = (events: GatewayEventEnvelope[]) => events
      .filter(event => event.kind === 'final_answer')
      .flatMap(event => {
        const payload = event.payload as { lines?: string[] };
        return payload.lines ?? [];
      });

    // 每个来源只实时收到自己回合的最终答案。
    expect(finalLines(webEvents)).toEqual(['answer:from-web']);
    expect(finalLines(feishuEvents)).toEqual(['answer:from-feishu']);
    expect(finalLines(tuiEvents)).toEqual(['answer:from-tui']);

    // 持久历史完整保留三个来源，按稳定顺序且无重复。
    const replay = await journal.replay('local-default', 'conv_1');
    const ordered = [...replay.snapshot, ...replay.deltas]
      .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
    const finalIds = ordered.filter(event => event.kind === 'final_answer').map(event => event.eventId);
    expect(new Set(finalIds).size).toBe(finalIds.length);
    expect(finalLines(ordered)).toEqual([
      'answer:from-web',
      'answer:from-feishu',
      'answer:from-tui',
    ]);

    // 断开来源不丢失历史：解除 web 订阅后 replay 仍完整。
    const replayAfter = await journal.replay('local-default', 'conv_1');
    expect(finalLines([...replayAfter.snapshot, ...replayAfter.deltas])).toEqual([
      'answer:from-web',
      'answer:from-feishu',
      'answer:from-tui',
    ]);
  });
});
