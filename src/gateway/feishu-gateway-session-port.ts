import type { SessionSnapshot } from '../session/session-types.js';
import type { FeishuSessionPort } from '../integrations/feishu-app.js';
import type { GatewayEventEnvelope, GatewayReplay } from './client-events.js';
import type { EventJournal } from './event-journal.js';
import type { FeishuGatewayAdapter } from './feishu-gateway-adapter.js';
import type { GatewaySubscriptions } from './gateway-subscriptions.js';
import { ResultStreamAssembler } from './result-stream-assembler.js';
import {
  formatFeishuWorkspaceConfirmation,
  formatFeishuWorkspaceRequired,
} from './feishu-events.js';

export interface FeishuGatewaySessionPortDeps {
  readonly accountId: string;
  readonly tenantKey: string;
  readonly adapter: FeishuGatewayAdapter;
  readonly journal: EventJournal;
  readonly subscriptions: GatewaySubscriptions;
  readonly timeoutMs?: number;
  readonly onSystemMessage?: (...lines: string[]) => void;
  readonly runtimePaths?: FeishuSessionPort['runtimePaths'];
}

export class FeishuGatewaySessionPort implements FeishuSessionPort {
  private readonly workspaceConfirmationCursors = new Map<
    string,
    { sequence: number; eventId: string }
  >();

  constructor(private readonly deps: FeishuGatewaySessionPortDeps) {}

  get runtimePaths(): FeishuSessionPort['runtimePaths'] {
    return this.deps.runtimePaths;
  }

  appendSystemMessage(...lines: string[]): void {
    this.deps.onSystemMessage?.(...lines);
  }

  subscribe(_listener: (snapshot: SessionSnapshot) => void): () => void {
    return () => undefined;
  }

  getSnapshot(): SessionSnapshot {
    return {
      output: [],
      currentTaskId: null,
      currentTask: null,
      runtimeState: {
        runningTaskId: null,
        runningExecutorName: null,
        readyTaskIds: [],
        blockedTaskIds: [],
        parkedTaskIds: [],
        lastEvent: null,
      },
      plannerState: { status: 'idle' },
      latestGuidance: null,
    };
  }

  async submit(_text: string): Promise<{ exitRequested: boolean }> {
    throw new Error('Feishu production input must use submitGatewayMessage');
  }

  async submitGatewayMessage(input: {
    senderId: string;
    chatId: string;
    text: string;
    requestId: string;
    onProgress: (text: string) => void;
  }): Promise<string[]> {
    const receipt = await this.deps.adapter.handleMessage(
      { tenantKey: this.deps.tenantKey, userId: input.senderId },
      { chatId: input.chatId },
      input.text,
      input.requestId,
      `feishu:${input.requestId}`,
    );
    if ('kind' in receipt) throw new Error(receipt.message);
    if (receipt.status === 'rejected' || !receipt.conversationId) {
      if (receipt.reason === 'workspace_required') {
        return [formatFeishuWorkspaceRequired()];
      }
      throw new Error(receipt.reason ?? 'Feishu Gateway command was rejected');
    }
    const conversationId = receipt.conversationId;
    const terminal = this.waitForTerminal(conversationId, input.requestId, input.onProgress);
    const replay = await this.deps.journal.replay(this.deps.accountId, conversationId);
    const replayEvents = orderedUniqueReplayEvents(replay);
    const latestWorkspaceEvent = replayEvents.filter(isWorkspaceProjectionEvent).at(-1);
    if (latestWorkspaceEvent) terminal.consume(latestWorkspaceEvent);
    for (const event of replayEvents) {
      if (isWorkspaceProjectionEvent(event)) continue;
      const result = terminal.consume(event);
      if (result) return result;
    }
    return terminal.promise;
  }

  private waitForTerminal(
    conversationId: string,
    requestId: string,
    onProgress: (text: string) => void,
  ): {
    promise: Promise<string[]>;
    consume(event: GatewayEventEnvelope): string[] | null;
  } {
    let unsubscribe: (() => void) | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;
    const seenEventIds = new Set<string>();
    const resultAssembler = new ResultStreamAssembler();
    const pendingProgress = new Map<string, string>();
    let progressFlushTimer: NodeJS.Timeout | null = null;
    let resolvePromise!: (lines: string[]) => void;
    let rejectPromise!: (error: Error) => void;
    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = null;
      if (timeout) clearTimeout(timeout);
      timeout = null;
      if (progressFlushTimer) clearTimeout(progressFlushTimer);
      progressFlushTimer = null;
    };
    const flushProgress = () => {
      if (pendingProgress.size === 0) return;
      const text = [...pendingProgress.values()].join('\n');
      pendingProgress.clear();
      onProgress(text);
    };
    const queueProgress = (key: string, text: string, immediate: boolean) => {
      if (!text.trim()) return;
      pendingProgress.set(key, text.slice(0, 500));
      if (immediate) {
        flushProgress();
        return;
      }
      if (progressFlushTimer) return;
      progressFlushTimer = setTimeout(() => {
        progressFlushTimer = null;
        flushProgress();
      }, 250);
      progressFlushTimer.unref?.();
    };
    const consume = (event: GatewayEventEnvelope): string[] | null => {
      if (settled) return null;
      if (seenEventIds.has(event.eventId)) return null;
      seenEventIds.add(event.eventId);
      if (isWorkspaceProjectionEvent(event)) {
        this.confirmWorkspace(event, onProgress);
        return null;
      }
      if (event.requestId !== requestId) return null;
      if (
        event.kind === 'result_delivery_available'
        || event.kind === 'result_chunk'
        || event.kind === 'result_completed'
      ) {
        try {
          resultAssembler.consume(event);
        } catch (error) {
          settled = true;
          cleanup();
          rejectPromise(error as Error);
        }
        return null;
      }
      if (event.kind === 'trace_delta') {
        const payload = event.payload as {
          events?: Array<{
            id?: string;
            kind?: string;
            title?: string;
            summary?: string;
            subtaskId?: string | null;
            details?: { subtaskId?: string };
          }>;
        };
        for (const item of payload.events ?? []) {
          const text = [item.title, item.summary].filter(Boolean).join('：');
          const terminal = Boolean(item.kind && (
            item.kind.includes('blocked')
            || item.kind.includes('failed')
            || item.kind.includes('publication')
            || item.kind.includes('delivery_completed')
            || item.kind.includes('result_observed')
          ));
          const key = item.subtaskId
            ?? item.details?.subtaskId
            ?? item.kind
            ?? item.id
            ?? 'execution';
          queueProgress(key, text, terminal);
        }
      }
      if (event.kind === 'terminal_error') {
        flushProgress();
        const message = (event.payload as { message?: string }).message
          ?? 'Gateway execution failed';
        settled = true;
        cleanup();
        if (/workspace_required|workspace (?:is )?not (?:selected|set)/iu.test(message)) {
          const lines = [formatFeishuWorkspaceRequired()];
          resolvePromise(lines);
          return lines;
        }
        rejectPromise(new Error(message));
        return null;
      }
      if (event.kind === 'final_answer') {
        flushProgress();
        const payload = event.payload as { lines?: string[]; resultId?: string };
        const completed = payload.resultId
          ? resultAssembler.find(payload.resultId)
          : null;
        const lines = completed ? completed.content.split('\n') : payload.lines ?? [];
        settled = true;
        cleanup();
        resolvePromise(lines);
        return lines;
      }
      return null;
    };
    const promise = new Promise<string[]>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    unsubscribe = this.deps.subscriptions.subscribe({
      accountId: this.deps.accountId,
      conversationId,
      listener: consume,
    });
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(new Error('Timed out waiting for Feishu Gateway final event'));
    }, this.deps.timeoutMs ?? 2 * 60 * 60 * 1000);
    timeout.unref?.();
    return { promise, consume };
  }

  private confirmWorkspace(
    event: GatewayEventEnvelope,
    onProgress: (text: string) => void,
  ): void {
    const path = workspacePathFromEvent(event);
    if (!path) return;
    const cursor = this.workspaceConfirmationCursors.get(event.conversationId);
    if (
      cursor
      && (
        event.sequence < cursor.sequence
        || (event.sequence === cursor.sequence && event.eventId <= cursor.eventId)
      )
    ) {
      return;
    }
    this.workspaceConfirmationCursors.set(event.conversationId, {
      sequence: event.sequence,
      eventId: event.eventId,
    });
    onProgress(formatFeishuWorkspaceConfirmation(path));
  }
}

function orderedUniqueReplayEvents(replay: GatewayReplay): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return [...replay.snapshot, ...replay.deltas]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    .filter(event => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}

function isWorkspaceProjectionEvent(event: GatewayEventEnvelope): boolean {
  if (event.kind !== 'conversation_snapshot' && event.kind !== 'workspace_changed') {
    return false;
  }
  return typeof event.payload === 'object'
    && event.payload !== null
    && 'workspace' in event.payload;
}

function workspacePathFromEvent(event: GatewayEventEnvelope): string | null {
  if (!isWorkspaceProjectionEvent(event)) return null;
  const payload = event.payload as {
    workspace?: { path?: unknown } | null;
  };
  return typeof payload.workspace?.path === 'string' && payload.workspace.path.length > 0
    ? payload.workspace.path
    : null;
}
