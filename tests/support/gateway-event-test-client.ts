import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { RuntimeState } from '../../src/core/types.js';
import type { SessionSnapshot } from '../../src/session/session-types.js';
import type { ClientGateway } from '../../src/gateway/client-gateway.js';
import type { GatewayEventEnvelope } from '../../src/gateway/client-events.js';
import type { GatewayCommand } from '../../src/gateway/client-protocol.js';
import type { GatewaySubscriptions } from '../../src/gateway/gateway-subscriptions.js';
import { ResultStreamAssembler } from '../../src/gateway/result-stream-assembler.js';
import type { ScriptedSessionTestPort } from './scripted-session-test-helper.js';

export interface GatewayEventTestClientDeps {
  readonly accountId: string;
  readonly conversationId: string;
  readonly gateway: Pick<ClientGateway, 'handle'>;
  readonly subscriptions: GatewaySubscriptions;
  readonly connectionId?: string;
  readonly timeoutMs?: number;
  readonly createId?: (prefix: string) => string;
}

interface PendingTerminal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

const EMPTY_RUNTIME_STATE: RuntimeState = {
  runningTaskId: null,
  runningExecutorName: null,
  readyTaskIds: [],
  blockedTaskIds: [],
  parkedTaskIds: [],
  lastEvent: null,
};

export class GatewayEventTestClient implements ScriptedSessionTestPort {
  private readonly output: string[] = [];
  private readonly seenEventIds = new Set<string>();
  private readonly pending = new Map<string, PendingTerminal>();
  private readonly resultAssembler = new ResultStreamAssembler();
  private currentTaskId: string | null = null;
  private runtimeState: RuntimeState = { ...EMPTY_RUNTIME_STATE };
  private plannerState: SessionSnapshot['plannerState'] = { status: 'idle' };
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: GatewayEventTestClientDeps) {}

  initialize(): void {
    if (this.disposed) throw new Error('Gateway event test client is disposed');
    this.unsubscribe ??= this.deps.subscriptions.subscribe({
      accountId: this.deps.accountId,
      conversationId: this.deps.conversationId,
      liveConnectionId: this.connectionId,
      listener: event => this.consume(event),
    });
  }

  getSnapshot(): SessionSnapshot {
    return {
      output: [...this.output],
      currentTaskId: this.currentTaskId,
      currentTask: null,
      runtimeState: {
        ...this.runtimeState,
        readyTaskIds: [...this.runtimeState.readyTaskIds],
        blockedTaskIds: [...this.runtimeState.blockedTaskIds],
        parkedTaskIds: [...this.runtimeState.parkedTaskIds],
      },
      plannerState: { ...this.plannerState },
      latestGuidance: null,
    };
  }

  async submit(text: string): Promise<{ exitRequested: boolean }> {
    if (!this.unsubscribe) this.initialize();
    const requestId = this.id('req');
    const idempotencyKey = this.id('idem');
    const terminal = this.waitForTerminal(requestId);
    void terminal.promise.catch(() => undefined);
    const command: GatewayCommand = text.startsWith('/')
      ? { kind: 'slash_command', text }
      : { kind: 'user_message', text, attachments: [] };
    try {
      const receipt = await this.deps.gateway.handle({
        protocolVersion: 1,
        requestId,
        idempotencyKey,
        connectionId: this.connectionId,
        conversation: { mode: 'attach', conversationId: this.deps.conversationId },
        command,
        clientCapabilities: ['trace_v1'],
      }, 'local');
      if ('kind' in receipt || receipt.status === 'rejected') {
        throw new Error('kind' in receipt
          ? receipt.message
          : receipt.reason ?? 'Gateway rejected test input');
      }
      await terminal.promise;
      return { exitRequested: text.trim() === '/exit' };
    } catch (error) {
      this.clearPending(requestId);
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [requestId, terminal] of this.pending) {
      clearTimeout(terminal.timeout);
      terminal.reject(new Error('Gateway event test client disposed before completion'));
      this.pending.delete(requestId);
    }
    this.resultAssembler.clear();
  }

  private consume(event: GatewayEventEnvelope): void {
    if (this.seenEventIds.has(event.eventId)) return;
    this.seenEventIds.add(event.eventId);
    if (
      event.kind === 'result_delivery_available'
      || event.kind === 'result_chunk'
      || event.kind === 'result_completed'
    ) {
      try {
        this.resultAssembler.consume(event);
      } catch (error) {
        if (event.requestId) {
          const terminal = this.pending.get(event.requestId);
          this.clearPending(event.requestId);
          terminal?.reject(error as Error);
        }
      }
      return;
    }

    if (event.kind === 'conversation_snapshot') {
      const payload = asRecord(event.payload);
      const lines = stringArray(payload.lines);
      const from = nonNegativeInteger(payload.from) ?? this.output.length;
      if (from <= this.output.length) this.output.splice(from, this.output.length - from, ...lines);
      else this.output.push(...lines);
      if (typeof payload.currentTaskId === 'string' || payload.currentTaskId === null) {
        this.currentTaskId = payload.currentTaskId;
      }
      return;
    }

    if (event.kind === 'task_projection') {
      const payload = asRecord(event.payload);
      if (typeof payload.currentTaskId === 'string' || payload.currentTaskId === null) {
        this.currentTaskId = payload.currentTaskId;
      }
      const runtimeState = parseRuntimeState(payload.runtimeState);
      if (runtimeState) this.runtimeState = runtimeState;
      const plannerState = asRecord(payload.plannerState);
      if (plannerState.status === 'idle' || plannerState.status === 'running') {
        this.plannerState = { status: plannerState.status };
      }
      return;
    }

    if (!event.requestId) return;
    const terminal = this.pending.get(event.requestId);
    if (!terminal) return;
    if (event.kind === 'final_answer') {
      const payload = asRecord(event.payload);
      const resultId = stringValue(payload.resultId);
      const completed = resultId ? this.resultAssembler.find(resultId) : null;
      this.appendTerminalFallback(
        completed ? completed.content.split('\n') : stringArray(payload.lines),
      );
      this.clearPending(event.requestId);
      terminal.resolve();
    } else if (event.kind === 'terminal_error') {
      const message = stringValue(asRecord(event.payload).message) ?? 'Gateway execution failed';
      this.appendTerminalFallback([`错误: ${message}`]);
      this.clearPending(event.requestId);
      terminal.reject(new Error(message));
    }
  }

  private waitForTerminal(requestId: string): PendingTerminal {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timeout = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.reject(new Error('Timed out waiting for Gateway test terminal event'));
    }, this.deps.timeoutMs ?? 2 * 60 * 60 * 1000);
    const terminal = { promise, resolve, reject, timeout };
    this.pending.set(requestId, terminal);
    return terminal;
  }

  private clearPending(requestId: string): void {
    const terminal = this.pending.get(requestId);
    if (!terminal) return;
    clearTimeout(terminal.timeout);
    this.pending.delete(requestId);
  }

  private appendTerminalFallback(lines: string[]): void {
    if (lines.length === 0 || hasSuffix(this.output, lines)) return;
    this.output.push(...lines);
  }

  private get connectionId(): string {
    return this.deps.connectionId ?? 'test-client';
  }

  private id(prefix: string): string {
    return this.deps.createId?.(prefix) ?? `${prefix}_${nanoid(12)}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseRuntimeState(value: unknown): RuntimeState | null {
  const candidate = asRecord(value);
  if (!Array.isArray(candidate.readyTaskIds)
    || !Array.isArray(candidate.blockedTaskIds)
    || !Array.isArray(candidate.parkedTaskIds)) {
    return null;
  }
  return {
    runningTaskId: stringValue(candidate.runningTaskId),
    runningExecutorName: stringValue(candidate.runningExecutorName),
    readyTaskIds: stringArray(candidate.readyTaskIds),
    blockedTaskIds: stringArray(candidate.blockedTaskIds),
    parkedTaskIds: stringArray(candidate.parkedTaskIds),
    lastEvent: stringValue(candidate.lastEvent),
  };
}

function hasSuffix(output: string[], lines: string[]): boolean {
  if (lines.length > output.length) return false;
  const offset = output.length - lines.length;
  return lines.every((line, index) => output[offset + index] === line);
}

export function expectedContentHash(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content)).digest('hex')}`;
}
