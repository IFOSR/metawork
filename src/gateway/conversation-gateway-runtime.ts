import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { AccountRuntimeHandle } from '../account/account-runtime-ports.js';
import type { RuntimeRegistry } from '../account/runtime-registry.js';
import type { ConversationRegistry } from '../session/conversation-registry.js';
import type { ConversationSession } from '../session/conversation-session.js';
import type { MailboxCommand, MailboxReceipt } from '../session/conversation-input-mailbox.js';
import type { InteractionTrace } from '../management/interaction-trace.js';
import type { GatewayCommand } from './client-protocol.js';
import {
  gatewayEventPayloadBytes,
  MAX_GATEWAY_EVENT_PAYLOAD_BYTES,
  sanitizeGatewayEventPayload,
  type GatewayEventEnvelope,
  type GatewayEventKind,
} from './client-events.js';
import type { EventJournal } from './event-journal.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

export interface ConversationGatewayRuntimeDeps {
  readonly accountId: string;
  readonly registry: RuntimeRegistry;
  readonly conversations: ConversationRegistry;
  readonly conversationFactory: (conversationId: string) => ConversationSession;
  readonly journal: EventJournal;
  readonly subscriptions: GatewaySubscriptions;
  readonly now?: () => string;
  readonly createId?: (prefix: string) => string;
}

export interface ConversationCommandCompletion {
  readonly status: 'completed' | 'failed';
  readonly reason?: string;
}

export interface ConversationCommandReceipt extends MailboxReceipt {
  readonly completion: Promise<ConversationCommandCompletion>;
}

interface PendingCompletion {
  readonly promise: Promise<ConversationCommandCompletion>;
  resolve(result: ConversationCommandCompletion): void;
}

export class ConversationGatewayRuntime {
  private readonly projected = new Set<string>();
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly submissions = new Map<string, Promise<ConversationCommandReceipt>>();
  private readonly pendingAttachments = new Set<Promise<() => void>>();
  private readonly activeAttachments = new Set<Promise<void>>();
  private admissionClosed = false;

  constructor(private readonly deps: ConversationGatewayRuntimeDeps) {}

  async activateAccount(accountId: string): Promise<AccountRuntimeHandle> {
    if (accountId !== this.deps.accountId) {
      throw new Error(`account runtime is unavailable: ${accountId}`);
    }
    return this.deps.registry.getOrActivate({ accountId, authorized: true });
  }

  async submit(
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
    command: GatewayCommand,
  ): Promise<ConversationCommandReceipt> {
    if (this.admissionClosed) {
      const reason = 'gateway_closing';
      return {
        requestId,
        idempotencyKey,
        status: 'rejected',
        reason,
        completion: Promise.resolve({ status: 'failed', reason }),
      };
    }
    const completionKey = this.completionKey(conversationId, idempotencyKey);
    const active = this.completions.get(completionKey);
    if (active) {
      return {
        requestId,
        idempotencyKey,
        status: 'duplicate',
        completion: active.promise,
      };
    }

    const pending = this.submissions.get(completionKey);
    if (pending) {
      return duplicateReceipt(await pending, requestId, idempotencyKey);
    }

    const submission = this.submitOnce(
      conversationId,
      requestId,
      idempotencyKey,
      command,
    );
    this.submissions.set(completionKey, submission);
    try {
      return await submission;
    } finally {
      if (this.submissions.get(completionKey) === submission) {
        this.submissions.delete(completionKey);
      }
    }
  }

  attachClient(conversationId: string): Promise<() => void> {
    if (this.admissionClosed) return Promise.reject(new Error('gateway_closing'));
    const attachment = this.attachClientOnce(conversationId);
    this.pendingAttachments.add(attachment);
    return attachment.finally(() => {
      this.pendingAttachments.delete(attachment);
    });
  }

  private async attachClientOnce(conversationId: string): Promise<() => void> {
    const accountRuntime = await this.activateAccount(this.deps.accountId);
    if (this.admissionClosed) throw new Error('gateway_closing');
    const conversation = await this.open(conversationId);
    if (this.admissionClosed) throw new Error('gateway_closing');

    accountRuntime.attachClient();
    try {
      conversation.attachClient();
    } catch (error) {
      accountRuntime.detachClient();
      throw error;
    }

    const detached = deferredSignal();
    this.activeAttachments.add(detached.promise);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      let detachError: unknown = null;
      try {
        conversation.detachClient();
      } catch (error) {
        detachError = error;
      }
      try {
        accountRuntime.detachClient();
      } catch (error) {
        detachError ??= error;
      } finally {
        this.activeAttachments.delete(detached.promise);
        detached.resolve();
      }
      if (detachError) throw detachError;
    };
  }

  closeAdmission(): void {
    this.admissionClosed = true;
  }

  async drain(): Promise<void> {
    while (
      this.submissions.size > 0
      || this.completions.size > 0
      || this.pendingAttachments.size > 0
      || this.activeAttachments.size > 0
    ) {
      await Promise.allSettled([
        ...this.submissions.values(),
        ...[...this.completions.values()].map(completion => completion.promise),
        ...this.pendingAttachments,
        ...this.activeAttachments,
      ]);
    }
  }

  private async submitOnce(
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
    command: GatewayCommand,
  ): Promise<ConversationCommandReceipt> {
    const completionKey = this.completionKey(conversationId, idempotencyKey);
    const recovered = await this.recoverDurableSubmission(
      conversationId,
      requestId,
      idempotencyKey,
    );
    if (recovered) return recovered;

    const conversation = await this.open(conversationId);
    const completion = deferredCompletion();
    this.completions.set(completionKey, completion);
    const receipt = conversation.submitCommand({
      requestId,
      idempotencyKey,
      command,
    });
    if (receipt.status === 'rejected') {
      completion.resolve({ status: 'failed', reason: receipt.reason });
      this.completions.delete(completionKey);
    }
    return { ...receipt, completion: completion.promise };
  }

  private async open(conversationId: string): Promise<ConversationSession> {
    const conversation = await this.deps.conversations.getOrOpen(
      conversationId,
      async () => {
        const created = this.deps.conversationFactory(conversationId);
        created.bindMailboxExecutor(command => this.execute(created, command));
        return created;
      },
    );
    if (!this.projected.has(conversationId)) {
      this.projected.add(conversationId);
      this.attachProjection(conversation);
    }
    return conversation;
  }

  private attachProjection(conversation: ConversationSession): void {
    let outputLength = 0;
    let traceTurnId: string | null = null;
    let traceSequence = 0;
    conversation.subscribe(snapshot => {
      const from = Math.min(outputLength, snapshot.output.length);
      const lines = snapshot.output.slice(from);
      outputLength = snapshot.output.length;
      if (lines.length > 0) {
        void this.publish(conversation.conversationId, null, null, 'conversation_snapshot', {
          from,
          lines,
          currentTaskId: snapshot.currentTaskId,
        });
      }
      void this.publish(conversation.conversationId, null, null, 'task_projection', {
        currentTaskId: snapshot.currentTaskId,
        runtimeState: snapshot.runtimeState,
        plannerState: snapshot.plannerState,
      });
    });
    conversation.subscribeInteractionTrace(trace => {
      if (!trace) return;
      const events = trace.turnId === traceTurnId
        ? trace.events.filter(event => event.sequence > traceSequence)
        : trace.events;
      traceTurnId = trace.turnId;
      traceSequence = trace.events.at(-1)?.sequence ?? 0;
      if (events.length > 0) {
        void this.publish(conversation.conversationId, null, trace.turnId, 'trace_delta', {
          turnId: trace.turnId,
          events,
        });
      }
    });
  }

  private async execute(
    conversation: ConversationSession,
    mailboxCommand: MailboxCommand,
  ): Promise<void> {
    if (!mailboxCommand.command) {
      throw new Error('Gateway mailbox command payload is missing');
    }
    const completionKey = this.completionKey(
      conversation.conversationId,
      mailboxCommand.idempotencyKey,
    );
    const completion = this.completions.get(completionKey);
    const accountRuntime = this.deps.registry.getIfLoaded(this.deps.accountId);
    const turnId = this.id('turn');
    const before = conversation.getOutput().length;
    const beforeResultDeliveries = conversation.getResultDeliveries().length;
    accountRuntime?.beginWork();
    try {
      await this.publish(
        conversation.conversationId,
        mailboxCommand.requestId,
        turnId,
        'turn_started',
        { commandKind: mailboxCommand.command.kind },
      );
      await conversation.executeGatewayCommand(
        mailboxCommand.command,
        {
          awaitAsyncWork: true,
          rethrowErrors: true,
          interactionTurnId: turnId,
        },
      );
      const lines = assistantOutputLines(
        conversation.getOutput().slice(before),
        mailboxCommand.command,
      );
      const projectedResult = conversation.getResultDeliveries()
        .slice(beforeResultDeliveries)
        .at(-1);
      const result = await this.publishResultDelivery(
        conversation.conversationId,
        mailboxCommand.requestId,
        turnId,
        projectedResult?.content ?? lines.join('\n'),
        projectedResult?.certification ?? 'certified',
        projectedResult?.completeness ?? 'complete',
        projectedResult?.resultId,
      );
      await this.publish(
        conversation.conversationId,
        mailboxCommand.requestId,
        turnId,
        'final_answer',
        finalAnswerPayload(projectedResult ? [] : lines, result),
      );
      completion?.resolve({ status: 'completed' });
    } catch (error) {
      const reason = (error as Error).message;
      try {
        await this.publish(
          conversation.conversationId,
          mailboxCommand.requestId,
          turnId,
          'terminal_error',
          { message: reason },
        );
      } finally {
        completion?.resolve({ status: 'failed', reason });
      }
      throw error;
    } finally {
      if (this.completions.get(completionKey) === completion) {
        this.completions.delete(completionKey);
      }
      accountRuntime?.endWork();
    }
  }

  private async recoverDurableSubmission(
    conversationId: string,
    requestId: string,
    idempotencyKey: string,
  ): Promise<ConversationCommandReceipt | null> {
    const replay = await this.deps.journal.replay(this.deps.accountId, conversationId);
    const events = uniqueEvents([...replay.snapshot, ...replay.deltas])
      .filter(event => event.requestId === requestId)
      .sort((left, right) => left.sequence - right.sequence);
    const terminal = findLastEvent(events, event => (
      event.kind === 'final_answer' || event.kind === 'terminal_error'
    ));
    if (terminal?.kind === 'final_answer') {
      return {
        requestId,
        idempotencyKey,
        status: 'duplicate',
        completion: Promise.resolve({ status: 'completed' }),
      };
    }
    if (terminal?.kind === 'terminal_error') {
      const reason = terminalErrorMessage(terminal);
      return {
        requestId,
        idempotencyKey,
        status: 'rejected',
        reason,
        completion: Promise.resolve({ status: 'failed', reason }),
      };
    }

    const started = findLastEvent(events, event => event.kind === 'turn_started');
    if (!started) return null;
    const reason = 'command_execution_uncertain';
    await this.publish(
      conversationId,
      requestId,
      started.turnId,
      'terminal_error',
      {
        code: reason,
        message: 'Command execution was interrupted after it started; it was not executed again.',
      },
    );
    return {
      requestId,
      idempotencyKey,
      status: 'rejected',
      reason,
      completion: Promise.resolve({ status: 'failed', reason }),
    };
  }

  private async publish(
    conversationId: string,
    requestId: string | null,
    turnId: string | null,
    kind: GatewayEventKind,
    payload: unknown,
  ): Promise<GatewayEventEnvelope> {
    const appended = await this.deps.journal.append({
      protocolVersion: 1,
      eventId: this.id('event'),
      sequence: 0,
      accountId: this.deps.accountId,
      conversationId,
      requestId,
      turnId,
      kind,
      payload,
      occurredAt: this.now(),
    });
    this.deps.subscriptions.publish(appended);
    return appended;
  }

  private async publishResultDelivery(
    conversationId: string,
    requestId: string,
    turnId: string,
    content: string,
    certification: 'certified' | 'uncertified',
    completeness: 'complete' | 'partial' | 'incomplete',
    persistedResultId?: string,
  ): Promise<ResultDeliveryMetadata> {
    // The journal applies the same redaction before persistence. Hash the
    // projected content so clients can verify exactly what they receive.
    const deliveryContent = redactSensitiveText(content);
    const bytes = Buffer.from(deliveryContent, 'utf8');
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const resultId = persistedResultId ?? `result_${contentHash.slice('sha256:'.length)}`;
    const metadata: ResultDeliveryMetadata = {
      resultId,
      contentHash,
      byteLength: bytes.byteLength,
      mediaType: 'text/markdown',
      completeness,
      certification,
    };
    const events: Array<{ kind: GatewayEventKind; payload: unknown }> = [{
      kind: 'result_delivery_available',
      payload: metadata,
    }];
    for (const chunk of splitResultChunks(bytes)) {
      events.push({
        kind: 'result_chunk',
        payload: {
          resultId,
          offset: chunk.offset,
          chunk: chunk.content,
          byteLength: chunk.byteLength,
        },
      });
    }
    events.push({
      kind: 'result_completed',
      payload: metadata,
    });
    await this.publishMany(
      conversationId,
      requestId,
      turnId,
      events,
    );
    return metadata;
  }

  private async publishMany(
    conversationId: string,
    requestId: string | null,
    turnId: string | null,
    events: Array<{ kind: GatewayEventKind; payload: unknown }>,
  ): Promise<GatewayEventEnvelope[]> {
    const envelopes = events.map(event => ({
      protocolVersion: 1 as const,
      eventId: this.id('event'),
      sequence: 0,
      accountId: this.deps.accountId,
      conversationId,
      requestId,
      turnId,
      kind: event.kind,
      payload: event.payload,
      occurredAt: this.now(),
    }));
    const appended = this.deps.journal.appendBatch
      ? await this.deps.journal.appendBatch(envelopes)
      : await appendSequentially(this.deps.journal, envelopes);
    for (const event of appended) this.deps.subscriptions.publish(event);
    return appended;
  }

  private id(prefix: string): string {
    return this.deps.createId?.(prefix) ?? `${prefix}_${nanoid(12)}`;
  }

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  private completionKey(conversationId: string, idempotencyKey: string): string {
    return `${conversationId}\0${idempotencyKey}`;
  }
}

function assistantOutputLines(lines: string[], command: GatewayCommand): string[] {
  if (command.kind !== 'user_message' && command.kind !== 'slash_command') return lines;
  const remaining = [...lines];
  if (remaining[0] === '') remaining.shift();
  if (remaining[0] === `> ${command.text.trim()}`) remaining.shift();
  return remaining;
}

function deferredCompletion(): PendingCompletion {
  let resolve!: (result: ConversationCommandCompletion) => void;
  const promise = new Promise<ConversationCommandCompletion>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function deferredSignal(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ResultDeliveryMetadata {
  resultId: string;
  contentHash: string;
  byteLength: number;
  mediaType: 'text/markdown';
  completeness: 'complete' | 'partial' | 'incomplete';
  certification: 'certified' | 'uncertified';
}

function finalAnswerPayload(lines: string[], result: ResultDeliveryMetadata): {
  lines: string[];
  resultId: string;
  contentHash: string;
  byteLength: number;
} {
  const full = { lines: lines.flatMap(splitGatewayLines) };
  const metadata = {
    resultId: result.resultId,
    contentHash: result.contentHash,
    byteLength: result.byteLength,
  };
  if (payloadFits({ ...full, ...metadata })) {
    return { ...full, ...metadata };
  }
  return { lines: [], ...metadata };
}

function splitResultChunks(
  bytes: Buffer,
  maxChunkBytes = 32 * 1024,
): Array<{ offset: number; byteLength: number; content: string }> {
  const chunks: Array<{ offset: number; byteLength: number; content: string }> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    let end = Math.min(offset + maxChunkBytes, bytes.byteLength);
    while (end > offset && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === offset) end = Math.min(offset + maxChunkBytes, bytes.byteLength);
    chunks.push({
      offset,
      byteLength: end - offset,
      content: bytes.subarray(offset, end).toString('utf8'),
    });
    offset = end;
  }
  if (chunks.length === 0) {
    chunks.push({ offset: 0, byteLength: 0, content: '' });
  }
  return chunks;
}

function splitGatewayLines(line: string): string[] {
  const maxLineBytes = 2 * 1024;
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= maxLineBytes) return [line];
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + maxLineBytes, bytes.length);
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) {
      end -= 1;
    }
    if (end === start) end = Math.min(start + maxLineBytes, bytes.length);
    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return chunks;
}

function payloadFits(payload: unknown): boolean {
  if (gatewayEventPayloadBytes(payload) > MAX_GATEWAY_EVENT_PAYLOAD_BYTES) return false;
  return gatewayEventPayloadBytes(sanitizeGatewayEventPayload(payload))
    <= MAX_GATEWAY_EVENT_PAYLOAD_BYTES;
}

function uniqueEvents(events: GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const unique = new Map<string, GatewayEventEnvelope>();
  for (const event of events) unique.set(event.eventId, event);
  return [...unique.values()];
}

function findLastEvent(
  events: GatewayEventEnvelope[],
  predicate: (event: GatewayEventEnvelope) => boolean,
): GatewayEventEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (predicate(event)) return event;
  }
  return undefined;
}

function terminalErrorMessage(event: GatewayEventEnvelope): string {
  const payload = event.payload as { code?: unknown; message?: unknown };
  if (typeof payload.code === 'string' && payload.code.length > 0) return payload.code;
  if (typeof payload.message === 'string' && payload.message.length > 0) return payload.message;
  return 'command_execution_failed';
}

function duplicateReceipt(
  receipt: ConversationCommandReceipt,
  requestId: string,
  idempotencyKey: string,
): ConversationCommandReceipt {
  return receipt.status === 'rejected'
    ? { ...receipt, requestId, idempotencyKey }
    : {
        ...receipt,
        requestId,
        idempotencyKey,
        status: 'duplicate',
      };
}

async function appendSequentially(
  journal: EventJournal,
  events: GatewayEventEnvelope[],
): Promise<GatewayEventEnvelope[]> {
  const appended: GatewayEventEnvelope[] = [];
  for (const event of events) appended.push(await journal.append(event));
  return appended;
}
