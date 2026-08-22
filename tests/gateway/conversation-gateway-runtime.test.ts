import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountRuntimeHandle } from '../../src/account/account-runtime-ports.js';
import type { RuntimeRegistry } from '../../src/account/runtime-registry.js';
import type { GatewayCommand } from '../../src/gateway/client-protocol.js';
import {
  gatewayEventPayloadBytes,
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  type GatewayEventEnvelope,
} from '../../src/gateway/client-events.js';
import { redactSensitiveText } from '../../src/utils/redact-sensitive-text.js';
import { ConversationGatewayRuntime } from '../../src/gateway/conversation-gateway-runtime.js';
import { FileEventJournal } from '../../src/gateway/file-event-journal.js';
import { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import {
  ConversationInputMailbox,
  type MailboxCommand,
  type MailboxReceipt,
} from '../../src/session/conversation-input-mailbox.js';
import { ConversationRegistry } from '../../src/session/conversation-registry.js';
import type { ConversationSession } from '../../src/session/conversation-session.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ConversationGatewayRuntime', () => {
  it('returns duplicate without executing a second turn', async () => {
    const fixture = createFixture();
    const command = userMessage('hello');

    expect(await fixture.runtime.submit('conv_1', 'req_1', 'idem_1', command))
      .toMatchObject({ status: 'accepted' });
    expect(await fixture.runtime.submit('conv_1', 'req_2', 'idem_1', command))
      .toMatchObject({ status: 'duplicate' });
    await waitFor(() => fixture.executions.length === 1);
  });

  it('single-flights concurrent submissions and shares their terminal completion', async () => {
    const release = deferred<void>();
    const fixture = createFixture(async (conversationId, command, session) => {
      fixture.executions.push(`${conversationId}:${commandText(command)}`);
      await release.promise;
      session.output.push('done');
    });

    const [first, duplicate] = await Promise.all([
      fixture.runtime.submit('conv_1', 'req_1', 'idem_1', userMessage('hello')),
      fixture.runtime.submit('conv_1', 'req_2', 'idem_1', userMessage('hello')),
    ]);

    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.completion).toBe(first.completion);
    await waitFor(() => fixture.executions.length === 1);
    expect(fixture.executions).toEqual(['conv_1:hello']);

    release.resolve();
    await expect(Promise.all([first.completion, duplicate.completion])).resolves.toEqual([
      { status: 'completed' },
      { status: 'completed' },
    ]);
  });

  it('serializes one Conversation and publishes final answers after execution', async () => {
    const first = deferred<void>();
    const fixture = createFixture(async (conversationId, command, session) => {
      fixture.executions.push(`${conversationId}:${commandText(command)}`);
      if (commandText(command) === 'first') await first.promise;
      session.output.push(`answer:${commandText(command)}`);
    });
    const events = fixture.capture('conv_1');

    await fixture.runtime.submit('conv_1', 'req_1', 'idem_1', userMessage('first'));
    await fixture.runtime.submit('conv_1', 'req_2', 'idem_2', userMessage('second'));
    await waitFor(() => events.some(event => event.kind === 'turn_started'));

    expect(fixture.executions).toEqual(['conv_1:first']);
    expect(events.some(event => event.kind === 'final_answer')).toBe(false);

    first.resolve();
    await waitFor(() => events.filter(event => event.kind === 'final_answer').length === 2);
    expect(fixture.executions).toEqual(['conv_1:first', 'conv_1:second']);
    expect(events.filter(event => ['turn_started', 'final_answer'].includes(event.kind))
      .map(event => event.kind))
      .toEqual(['turn_started', 'final_answer', 'turn_started', 'final_answer']);
  });

  it('allows separate Conversations to execute independently', async () => {
    const first = deferred<void>();
    const fixture = createFixture(async (conversationId, command, session) => {
      fixture.executions.push(`${conversationId}:${commandText(command)}`);
      if (conversationId === 'conv_a') await first.promise;
      session.output.push(`answer:${commandText(command)}`);
    });

    await fixture.runtime.submit('conv_a', 'req_a', 'idem_a', userMessage('slow'));
    const receiptB = await fixture.runtime.submit(
      'conv_b',
      'req_b',
      'idem_b',
      userMessage('fast'),
    );
    await waitFor(() => fixture.executions.length === 2);
    await receiptB.completion;
    const replayB = await fixture.journal.replay('local-default', 'conv_b');

    expect(replayB.snapshot.some(event => event.kind === 'final_answer')).toBe(true);
    first.resolve();
  });

  it('publishes a terminal error when Conversation execution fails', async () => {
    const fixture = createFixture(async () => {
      throw new Error('planner failed');
    });
    const events = fixture.capture('conv_1');

    await fixture.runtime.submit('conv_1', 'req_1', 'idem_1', userMessage('fail'));
    await waitFor(() => events.some(event => event.kind === 'terminal_error'));

    expect(events.filter(event => ['turn_started', 'terminal_error'].includes(event.kind))
      .map(event => event.kind))
      .toEqual(['turn_started', 'terminal_error']);
    expect(events.at(-1)?.payload).toEqual({ message: 'planner failed' });
  });

  it('passes the Gateway turn identity into Conversation execution', async () => {
    const fixture = createFixture();
    const events = fixture.capture('conv_1');

    await fixture.runtime.submit('conv_1', 'req_1', 'idem_1', userMessage('hello'));
    await waitFor(() => events.some(event => event.kind === 'final_answer'));

    const started = events.find(event => event.kind === 'turn_started');
    expect(fixture.turnIds).toEqual([started?.turnId]);
  });

  it('publishes only assistant output in the final answer payload', async () => {
    const fixture = createFixture(async (_conversationId, command, session) => {
      session.output.push('', `> ${commandText(command)}`, 'answer only');
    });
    const events = fixture.capture('conv_1');

    await fixture.runtime.submit('conv_1', 'req_1', 'idem_1', userMessage('hello'));
    await waitFor(() => events.some(event => event.kind === 'final_answer'));

    expect(events.find(event => event.kind === 'final_answer')?.payload)
      .toMatchObject({ lines: ['answer only'] });
  });

  it('publishes an oversized final answer as replayable bounded result chunks', async () => {
    const answer = `开头\n${'x'.repeat(MAX_GATEWAY_EVENT_PAYLOAD_BYTES * 2)}\n结尾`;
    const fixture = createFixture(async (_conversationId, _command, session) => {
      session.output.push(answer);
    });
    const events = fixture.capture('conv_1');

    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('large answer'),
    );

    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
    const finalAnswer = events.find(event => event.kind === 'final_answer');
    expect(finalAnswer).toBeDefined();
    const available = events.find(event => event.kind === 'result_delivery_available');
    const chunks = events.filter(event => event.kind === 'result_chunk');
    const completed = events.find(event => event.kind === 'result_completed');
    expect(available?.payload).toMatchObject({
      certification: 'certified',
      completeness: 'complete',
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(completed?.payload).toMatchObject({
      resultId: (available?.payload as { resultId?: string }).resultId,
      contentHash: (available?.payload as { contentHash?: string }).contentHash,
    });
    expect(chunks.map(event => (event.payload as { chunk: string }).chunk).join(''))
      .toBe(answer);
    expect(events.every(event =>
      gatewayEventPayloadBytes(event.payload) <= MAX_GATEWAY_EVENT_PAYLOAD_BYTES
    )).toBe(true);
    expect(finalAnswer?.payload).not.toHaveProperty('truncated');
    expect(events.some(event => event.kind === 'terminal_error')).toBe(false);

    const replay = await fixture.journal.replay('local-default', 'conv_1', 0);
    const replayedChunks = [...replay.snapshot, ...replay.deltas]
      .filter(event => event.kind === 'result_chunk')
      .sort((left, right) => left.sequence - right.sequence);
    expect(replayedChunks.map(event =>
      (event.payload as { chunk: string }).chunk
    ).join('')).toBe(answer);
  });

  it('uses the structured Conversation result projection instead of parsing status text', async () => {
    const fixture = createFixture(async (_conversationId, _command, session) => {
      session.output.push('safe business body', '', 'localized certification status');
      session.recordResultDelivery({
        resultId: 'result_persisted_safe',
        content: 'safe business body',
        completeness: 'partial',
        certification: 'uncertified',
      });
    });
    const events = fixture.capture('conv_1');

    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('structured result'),
    );

    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
    expect(events.find(event => event.kind === 'result_delivery_available')?.payload)
      .toMatchObject({
        resultId: 'result_persisted_safe',
        completeness: 'partial',
        certification: 'uncertified',
      });
    expect(events.filter(event => event.kind === 'result_chunk')
      .map(event => (event.payload as { chunk: string }).chunk)
      .join('')).toBe('safe business body');
    expect(events.find(event => event.kind === 'final_answer')?.payload)
      .toMatchObject({ lines: [], resultId: 'result_persisted_safe' });
  });

  it('hashes the same redacted result content that the Gateway journal stores', async () => {
    const unsafeContent = 'Report\napi_key=secret-value';
    const safeContent = redactSensitiveText(unsafeContent);
    const fixture = createFixture(async (_conversationId, _command, session) => {
      session.recordResultDelivery({
        resultId: 'result_redacted_hash',
        content: unsafeContent,
        completeness: 'complete',
        certification: 'certified',
      });
    });
    const events = fixture.capture('conv_1');
    const assembler = new (await import('../../src/gateway/result-stream-assembler.js')).ResultStreamAssembler();

    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('redacted result'),
    );

    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
    const completed = events.find(event => event.kind === 'result_completed')!;
    for (const event of events.filter(event => (
      ['result_delivery_available', 'result_chunk', 'result_completed'].includes(event.kind)
    ))) {
      assembler.consume(event);
    }
    expect(assembler.find('result_redacted_hash')).toMatchObject({
      resultId: 'result_redacted_hash',
      content: safeContent,
    });
    expect(completed.payload).toMatchObject({
      contentHash: hash(safeContent),
      byteLength: Buffer.byteLength(safeContent, 'utf8'),
    });
  });

  it('exposes terminal completion for an accepted mailbox command', async () => {
    const release = deferred<void>();
    const fixture = createFixture(async (_conversationId, _command, session) => {
      await release.promise;
      session.output.push('done');
    });

    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('hello'),
    );
    expect(receipt).toMatchObject({ status: 'accepted' });
    expect(receipt.completion).toBeDefined();

    release.resolve();
    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
  });

  it('fails closed without a second execution when a durable turn already started', async () => {
    const fixture = createFixture();
    await fixture.journal.append({
      protocolVersion: 1,
      eventId: 'event_started',
      sequence: 0,
      accountId: 'local-default',
      conversationId: 'conv_1',
      requestId: 'req_1',
      turnId: 'turn_existing',
      kind: 'turn_started',
      payload: { commandKind: 'user_message' },
      occurredAt: '2026-08-19T00:00:00.000Z',
    });

    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('hello'),
    );

    expect(receipt).toMatchObject({
      status: 'rejected',
      reason: 'command_execution_uncertain',
    });
    await expect(receipt.completion).resolves.toEqual({
      status: 'failed',
      reason: 'command_execution_uncertain',
    });
    expect(fixture.executions).toEqual([]);
    const replay = await fixture.journal.replay('local-default', 'conv_1');
    expect([...replay.deltas, ...replay.snapshot]
      .filter(event => event.requestId === 'req_1')
      .sort((left, right) => left.sequence - right.sequence)
      .map(event => event.kind))
      .toEqual(['turn_started', 'terminal_error']);
  });

  it('does not re-execute a command whose final event is already durable', async () => {
    const fixture = createFixture();
    await fixture.journal.append({
      protocolVersion: 1,
      eventId: 'event_final',
      sequence: 0,
      accountId: 'local-default',
      conversationId: 'conv_1',
      requestId: 'req_1',
      turnId: 'turn_existing',
      kind: 'final_answer',
      payload: { lines: ['done'] },
      occurredAt: '2026-08-19T00:00:00.000Z',
    });

    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('hello'),
    );

    expect(receipt).toMatchObject({ status: 'duplicate' });
    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
    expect(fixture.executions).toEqual([]);
  });

  it('closes admission and drains accepted command completions', async () => {
    const release = deferred<void>();
    const fixture = createFixture(async (_conversationId, _command, session) => {
      await release.promise;
      session.output.push('done');
    });
    const receipt = await fixture.runtime.submit(
      'conv_1',
      'req_1',
      'idem_1',
      userMessage('slow'),
    );

    fixture.runtime.closeAdmission();
    await expect(fixture.runtime.submit(
      'conv_1',
      'req_2',
      'idem_2',
      userMessage('late'),
    )).resolves.toMatchObject({
      status: 'rejected',
      reason: 'gateway_closing',
    });
    let drained = false;
    const draining = fixture.runtime.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release.resolve();
    await expect(receipt.completion).resolves.toEqual({ status: 'completed' });
    await draining;
  });

  it('binds a client connection to both the account and Conversation lifecycles', async () => {
    const accountCalls: string[] = [];
    const conversationCalls: string[] = [];
    const fixture = createFixture();
    fixture.registry.getOrActivate = async () => ({
      accountId: 'local-default',
      getConversationPort: () => null as never,
      initialize: async () => undefined,
      beginWork: () => undefined,
      endWork: () => undefined,
      attachClient: () => { accountCalls.push('attach'); },
      detachClient: () => { accountCalls.push('detach'); },
      closeWhenIdle: async () => 'closed',
    });
    fixture.conversationFactory = conversationId => {
      const session = new FakeConversationSession(
        conversationId,
        async () => undefined,
      );
      session.attachClient = () => { conversationCalls.push('attach'); };
      session.detachClient = () => { conversationCalls.push('detach'); };
      return session as unknown as ConversationSession;
    };

    const detach = await fixture.runtime.attachClient('conv_1');
    expect(accountCalls).toEqual(['attach']);
    expect(conversationCalls).toEqual(['attach']);

    detach();
    detach();
    expect(accountCalls).toEqual(['attach', 'detach']);
    expect(conversationCalls).toEqual(['attach', 'detach']);
  });

  it('invalidates a pending attach when admission closes without leaking counts', async () => {
    const activation = deferred<AccountRuntimeHandle>();
    const accountCalls: string[] = [];
    const conversationCalls: string[] = [];
    const fixture = createFixture();
    fixture.registry.getOrActivate = () => activation.promise;
    fixture.conversationFactory = conversationId => {
      const session = new FakeConversationSession(
        conversationId,
        async () => undefined,
      );
      session.attachClient = () => { conversationCalls.push('attach'); };
      session.detachClient = () => { conversationCalls.push('detach'); };
      return session as unknown as ConversationSession;
    };

    const attaching = fixture.runtime.attachClient('conv_1');
    fixture.runtime.closeAdmission();
    const draining = fixture.runtime.drain();
    activation.resolve({
      accountId: 'local-default',
      getConversationPort: () => null as never,
      initialize: async () => undefined,
      beginWork: () => undefined,
      endWork: () => undefined,
      attachClient: () => { accountCalls.push('attach'); },
      detachClient: () => { accountCalls.push('detach'); },
      closeWhenIdle: async () => 'closed',
    });

    await expect(attaching).rejects.toThrow('gateway_closing');
    await expect(draining).resolves.toBeUndefined();
    expect(accountCalls).toEqual([]);
    expect(conversationCalls).toEqual([]);
  });

  it('waits for active client detach during drain', async () => {
    const fixture = createFixture();
    fixture.registry.getOrActivate = async () => ({
      accountId: 'local-default',
      getConversationPort: () => null as never,
      initialize: async () => undefined,
      beginWork: () => undefined,
      endWork: () => undefined,
      attachClient: () => undefined,
      detachClient: () => undefined,
      closeWhenIdle: async () => 'closed',
    });

    const detach = await fixture.runtime.attachClient('conv_1');
    fixture.runtime.closeAdmission();
    let drained = false;
    const draining = fixture.runtime.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    detach();
    await draining;
    expect(drained).toBe(true);
  });
});

function createFixture(
  execute: (
    conversationId: string,
    command: GatewayCommand,
    session: FakeConversationSession,
  ) => Promise<void> | null = null,
) {
  const root = mkdtempSync(join(tmpdir(), 'anyfusion-conversation-gateway-'));
  roots.push(root);
  const journal = new FileEventJournal(root);
  const subscriptions = new GatewaySubscriptions();
  const conversations = new ConversationRegistry();
  let conversationFactory = (conversationId: string): ConversationSession => {
    let session!: FakeConversationSession;
    session = new FakeConversationSession(
      conversationId,
      command => operation(conversationId, command, session),
      fixture.turnIds,
    );
    return session as unknown as ConversationSession;
  };
  const fixture = {
    executions: [] as string[],
    turnIds: [] as Array<string | null>,
    journal,
    subscriptions,
    registry: {
      getOrActivate: async () => ({ accountId: 'local-default' }) as AccountRuntimeHandle,
      getIfLoaded: () => null,
    } as unknown as RuntimeRegistry,
    get conversationFactory() {
      return conversationFactory;
    },
    set conversationFactory(value: (conversationId: string) => ConversationSession) {
      conversationFactory = value;
    },
    runtime: null as unknown as ConversationGatewayRuntime,
    capture(conversationId: string): GatewayEventEnvelope[] {
      const events: GatewayEventEnvelope[] = [];
      subscriptions.subscribe({
        accountId: 'local-default',
        conversationId,
        listener: event => events.push(event),
      });
      return events;
    },
  };
  const operation = execute ?? (async (
    conversationId: string,
    command: GatewayCommand,
    session: FakeConversationSession,
  ) => {
    fixture.executions.push(`${conversationId}:${commandText(command)}`);
    session.output.push(`answer:${commandText(command)}`);
  });
  fixture.runtime = new ConversationGatewayRuntime({
    accountId: 'local-default',
    registry: fixture.registry,
    conversations,
    conversationFactory: conversationId => fixture.conversationFactory(conversationId),
    journal,
    subscriptions,
    createId: prefix => `${prefix}_${Math.random().toString(36).slice(2)}`,
  });
  return fixture;
}

class FakeConversationSession {
  readonly output: string[] = [];
  readonly resultDeliveries: Array<{
    resultId: string;
    content: string;
    completeness: 'complete' | 'partial' | 'incomplete';
    certification: 'certified' | 'uncertified';
  }> = [];
  private readonly mailbox: ConversationInputMailbox;

  constructor(
    readonly conversationId: string,
    private readonly execute: (command: GatewayCommand) => Promise<void>,
    private readonly turnIds: Array<string | null> = [],
  ) {
    this.mailbox = new ConversationInputMailbox({ execute: async () => undefined });
  }

  bindMailboxExecutor(execute: (command: MailboxCommand) => Promise<void>): void {
    this.mailbox.bindExecutor(execute);
  }

  submitCommand(command: MailboxCommand): MailboxReceipt {
    return this.mailbox.submit(command);
  }

  async executeGatewayCommand(
    command: GatewayCommand,
    options: { interactionTurnId?: string } = {},
  ): Promise<void> {
    this.turnIds.push(options.interactionTurnId ?? null);
    await this.execute(command);
  }

  getOutput(): string[] {
    return [...this.output];
  }

  recordResultDelivery(delivery: FakeConversationSession['resultDeliveries'][number]): void {
    this.resultDeliveries.push(delivery);
  }

  getResultDeliveries(): FakeConversationSession['resultDeliveries'] {
    return [...this.resultDeliveries];
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

function userMessage(text: string): GatewayCommand {
  return { kind: 'user_message', text, attachments: [] };
}

function commandText(command: GatewayCommand): string {
  return 'text' in command ? command.text : command.kind;
}

function hash(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
