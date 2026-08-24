import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import type { GatewayEventEnvelope, GatewayReplay } from '../gateway/client-events.js';
import type { GatewayCommand } from '../gateway/client-protocol.js';
import type { InteractionTraceEvent } from './interaction-trace.js';
import type { WebGatewayAdapter } from './web-gateway-adapter.js';
import type {
  WebSessionActivationResult,
  WebSessionCreationResult,
  WebSessionMetadata,
  WebSessionRecord,
} from './web-session-types.js';
import type { GatewayAttachmentStore } from '../gateway/attachment-store-port.js';

const MAX_ATTACHMENTS_PER_MESSAGE = 32;
const MAX_ENRICHMENT_BYTES = 16 * 1024;
const EXCERPT_MAX_LINES = 64;

function formatByteSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function buildTextExcerpt(bytes: Buffer, maxBytes: number): string | null {
  const text = bytes.toString('utf8');
  if (!text.trim()) return null;
  const lines = text.split('\n').slice(0, EXCERPT_MAX_LINES);
  let excerpt = lines.join('\n');
  while (Buffer.byteLength(excerpt, 'utf8') > maxBytes && excerpt.length > 0) {
    excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2));
  }
  return excerpt.length < text.length ? `${excerpt}\n…（已截断）` : excerpt;
}
import type {
  WebSessionRuntimeCatalog,
  WebSessionRuntimeEvent,
} from './web-session-runtime-types.js';

export interface WebGatewaySessionRuntimeDeps {
  readonly accountId: string;
  readonly catalog: WebSessionRuntimeCatalog;
  readonly gateway: WebGatewayAdapter;
  /** 会话附件存储；提供后用户消息可携带附件并自动增强 Planner 提示。 */
  readonly attachments?: GatewayAttachmentStore;
  readonly createId?: (prefix: string) => string;
  readonly now?: () => string;
}

export class WebGatewaySessionRuntime {
  private readonly listeners = new Set<(event: WebSessionRuntimeEvent) => void>();
  private readonly pendingInputs = new Map<string, string>();
  private readonly resultAssemblies = new Map<string, ResultAssembly>();
  private readonly completedResults = new Map<string, string>();
  private unsubscribe: (() => void) | null = null;
  private detachClient: (() => void) | null = null;
  private replayEvents: WebSessionRuntimeEvent[] = [];
  private _activeSessionId: string | null = null;
  private attachGeneration = 0;
  private readonly pendingAttaches = new Set<Promise<void>>();
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(private readonly deps: WebGatewaySessionRuntimeDeps) {}

  get activeSessionId(): string {
    if (!this._activeSessionId) throw new Error('Web Gateway runtime is not initialized');
    return this._activeSessionId;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error('Web Gateway runtime is disposed');
    if (this._activeSessionId) return;
    await this.deps.catalog.initialize();
    const sessions = await this.deps.catalog.list();
    const active = sessions.find(session => session.active && !session.archived);
    const record = active
      ? await this.deps.catalog.read(active.id)
      : await this.deps.catalog.create({ active: true });
    if (!record) throw new Error('Active Web conversation is unavailable');
    if (!record.session.active) await this.deps.catalog.setActive(record.session.id);
    await this.attach(record.session.id);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.attachGeneration += 1;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachClient?.();
    this.detachClient = null;
    this._activeSessionId = null;
    this.replayEvents = [];
    this.pendingInputs.clear();
    this.resultAssemblies.clear();
    this.completedResults.clear();
    this.disposePromise = Promise.allSettled([...this.pendingAttaches]).then(() => undefined);
    return this.disposePromise;
  }

  async submit(
    text: string,
    attachments: Array<{ attachmentId: string; kind: string }> = [],
  ): Promise<void> {
    const requestId = this.id('req');
    const effectiveText = await this.enrichWithAttachments(text, attachments);
    this.pendingInputs.set(requestId, text);
    const command: GatewayCommand = effectiveText.startsWith('/')
      ? { kind: 'slash_command', text: effectiveText }
      : { kind: 'user_message', text: effectiveText, attachments };
    const receipt = await this.deps.gateway.submit({
      protocolVersion: 1,
      requestId,
      idempotencyKey: this.id('idem'),
      connectionId: 'web',
      conversation: { mode: 'attach', conversationId: this.activeSessionId },
      command,
      clientCapabilities: ['trace_v1'],
    });
    if ('kind' in receipt || receipt.status === 'rejected') {
      this.pendingInputs.delete(requestId);
      throw new Error('kind' in receipt ? receipt.message : receipt.reason ?? 'Gateway rejected the command');
    }
  }

  /** 将已上传附件解析为 Planner 提示增强块；无附件或未配置存储时返回原文。 */
  private async enrichWithAttachments(
    text: string,
    attachments: Array<{ attachmentId: string; kind: string }>,
  ): Promise<string> {
    const store = this.deps.attachments;
    if (!store || attachments.length === 0) return text;
    const sections: string[] = [];
    let budget = MAX_ENRICHMENT_BYTES;
    for (const reference of attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      const resolved = await store.readAttachment(this.activeSessionId, reference.attachmentId);
      if (!resolved) continue;
      const { metadata } = resolved;
      const sizeLabel = formatByteSize(metadata.size);
      const header = `${sections.length + 1}. ${metadata.name} (${metadata.mime}, ${sizeLabel}) — 路径: ${resolved.path}`;
      let section = header;
      if (metadata.kind === 'text') {
        const excerpt = buildTextExcerpt(resolved.bytes, Math.max(1_000, budget));
        if (excerpt) section = `${header}\n   文本摘录（前 64 行）:\n${excerpt}`;
      }
      // 图片：内容已随消息以多模态 images 通道原生提供给 Planner；
      // 此处保留路径，供 Executor 在工作区读取原图。
      sections.push(section);
      budget -= Buffer.byteLength(section, 'utf8');
      if (budget <= 0) break;
    }
    if (sections.length === 0) return text;
    return [
      text,
      '---',
      `[附件] ${sections.length} 个文件随本消息提交；请结合以下内容理解意图，并让 Executor 通过上述路径读取完整原文：`,
      ...sections,
    ].join('\n');
  }

  listSessions(query = ''): Promise<WebSessionMetadata[]> {
    return query.trim() ? this.deps.catalog.search(query) : this.deps.catalog.list();
  }
  readSession(sessionId: string): Promise<WebSessionRecord | null> {
    return this.deps.catalog.read(sessionId);
  }

  async createSession(title?: string): Promise<WebSessionCreationResult> {
    const created = await this.deps.catalog.create({ title, active: false });
    const activation = await this.activateSession(created.session.id);
    return {
      session: await this.deps.catalog.read(created.session.id) ?? created,
      activation,
    };
  }

  async activateSession(sessionId: string): Promise<WebSessionActivationResult> {
    const target = await this.deps.catalog.read(sessionId);
    if (!target || target.session.archived) {
      return { state: 'activation_blocked', sessionId, reason: 'session_unavailable' };
    }
    await this.deps.catalog.setActive(sessionId);
    await this.attach(sessionId);
    this.emit({ type: 'active_session_changed', sessionId });
    this.emit({
      type: 'session_catalog',
      activeSessionId: sessionId,
      sessions: await this.deps.catalog.list(),
    });
    return { state: 'active', sessionId };
  }

  async deleteSession(sessionId: string): Promise<'deleted' | 'not_found' | 'active'> {
    if (sessionId === this._activeSessionId) return 'active';
    const deleted = await this.deps.catalog.deleteSession(sessionId);
    if (!deleted) return 'not_found';
    if (this._activeSessionId) {
      this.emit({
        type: 'session_catalog',
        activeSessionId: this._activeSessionId,
        sessions: await this.deps.catalog.list(),
      });
    }
    return 'deleted';
  }

  async clearAllSessions(): Promise<{ deleted: number }> {
    const deleted = await this.deps.catalog.clearAll(this._activeSessionId ?? undefined);
    if (this._activeSessionId) {
      this.emit({
        type: 'session_catalog',
        activeSessionId: this._activeSessionId,
        sessions: await this.deps.catalog.list(),
      });
    }
    return { deleted };
  }

  subscribe(listener: (event: WebSessionRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getReplayEvents(): WebSessionRuntimeEvent[] {
    return structuredClone(this.replayEvents);
  }

  private attach(sessionId: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Web Gateway runtime is disposed'));
    const generation = this.attachGeneration += 1;
    const attachment = this.attachOnce(sessionId, generation);
    this.pendingAttaches.add(attachment);
    return attachment.finally(() => {
      this.pendingAttaches.delete(attachment);
    });
  }

  private async attachOnce(sessionId: string, generation: number): Promise<void> {
    const detachClient = await this.deps.gateway.attachClient(this.deps.accountId, sessionId);
    const detachOnce = once(detachClient);
    if (this.disposed) {
      detachOnce();
      throw new Error('Web Gateway runtime is disposed');
    }
    if (generation !== this.attachGeneration) {
      detachOnce();
      return;
    }
    this.unsubscribe?.();
    this.detachClient?.();
    this._activeSessionId = sessionId;
    this.replayEvents = [];
    this.resultAssemblies.clear();
    this.completedResults.clear();
    const buffered: GatewayEventEnvelope[] = [];
    let replaying = true;
    const unsubscribe = this.deps.gateway.subscribe(
      this.deps.accountId,
      sessionId,
      event => {
        if (this.disposed || generation !== this.attachGeneration) return;
        if (replaying) buffered.push(event);
        else this.consume(event, false);
      },
    );
    const unsubscribeOnce = once(unsubscribe);
    this.unsubscribe = unsubscribeOnce;
    this.detachClient = detachOnce;

    let replay: GatewayReplay;
    try {
      replay = await this.deps.gateway.replay(this.deps.accountId, sessionId);
    } catch (error) {
      if (generation === this.attachGeneration) {
        unsubscribeOnce();
        this.unsubscribe = null;
        detachOnce();
        this.detachClient = null;
      }
      throw error;
    }
    if (this.disposed) {
      unsubscribeOnce();
      detachOnce();
      throw new Error('Web Gateway runtime is disposed');
    }
    if (generation !== this.attachGeneration) {
      unsubscribeOnce();
      detachOnce();
      return;
    }

    const seen = new Set<string>();
    for (const event of orderedUniqueReplayEvents(replay)) {
      seen.add(event.eventId);
      this.consume(event, true);
    }
    for (const event of orderedUniqueEvents(buffered)) {
      if (event.sequence <= replay.lastSequence || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      this.consume(event, true);
    }
    replaying = false;
  }

  private consume(event: GatewayEventEnvelope, replay: boolean): void {
    const userInput = event.requestId ? this.pendingInputs.get(event.requestId) : undefined;
    const resultEvent = this.consumeResultEvent(event);
    if (resultEvent) {
      if (replay) this.replayEvents.push(resultEvent);
      else this.emit(resultEvent);
    }
    const mapped = mapGatewayEvent(
      event,
      userInput,
      resultIdFromPayload(event.payload)
        ? this.completedResults.get(resultIdFromPayload(event.payload)!) ?? null
        : null,
    );
    if (mapped) {
      if (replay) this.replayEvents.push(mapped);
      else this.emit(mapped);
    }
    if (event.kind === 'final_answer' && event.requestId) {
      this.pendingInputs.delete(event.requestId);
      if (userInput) {
        const lines = mapped?.type === 'final_answer' ? mapped.lines : [];
        void this.deps.catalog.appendTurn(event.conversationId, {
          id: event.turnId ?? this.id('turn'),
          sessionId: event.conversationId,
          userInput,
          status: 'completed',
          finalAnswer: lines.join('\n'),
          taskId: null,
          startedAt: event.occurredAt,
          completedAt: event.occurredAt,
          traceEvents: [],
          executionTimeline: null,
          artifactRefs: [],
        });
      }
    }
    if (event.kind === 'terminal_error' && event.requestId) {
      this.pendingInputs.delete(event.requestId);
    }
  }

  private consumeResultEvent(event: GatewayEventEnvelope): WebSessionRuntimeEvent | null {
    if (!event.requestId || !event.turnId) return null;
    const payload = asRecord(event.payload);
    const resultId = stringValue(payload.resultId);
    if (!resultId) return null;
    if (event.kind === 'result_delivery_available') {
      const metadata = resultMetadata(payload);
      if (!metadata) return null;
      this.resultAssemblies.set(resultId, { ...metadata, chunks: new Map() });
      return {
        type: 'result_delivery_available',
        requestId: event.requestId,
        turnId: event.turnId,
        resultId,
        ...metadata,
      };
    }
    if (event.kind === 'result_chunk') {
      const offset = nonNegativeInteger(payload.offset);
      const chunk = stringValue(payload.chunk);
      if (offset === null || chunk === null) return null;
      const assembly = this.resultAssemblies.get(resultId);
      if (assembly) assembly.chunks.set(offset, chunk);
      return {
        type: 'result_chunk',
        requestId: event.requestId,
        turnId: event.turnId,
        resultId,
        offset,
        chunk,
      };
    }
    if (event.kind === 'result_completed') {
      const metadata = resultMetadata(payload);
      const assembly = this.resultAssemblies.get(resultId);
      if (!metadata || !assembly) return null;
      const content = [...assembly.chunks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, chunk]) => chunk)
        .join('');
      const bytes = Buffer.from(content, 'utf8');
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (bytes.byteLength !== metadata.byteLength || hash !== metadata.contentHash) {
        return null;
      }
      this.completedResults.set(resultId, content);
      return {
        type: 'result_completed',
        requestId: event.requestId,
        turnId: event.turnId,
        resultId,
        content,
        ...metadata,
      };
    }
    return null;
  }

  private emit(event: WebSessionRuntimeEvent): void {
    for (const listener of this.listeners) listener(structuredClone(event));
  }

  private id(prefix: string): string {
    return this.deps.createId?.(prefix) ?? `${prefix}_${nanoid(12)}`;
  }
}

function once(operation: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    operation();
  };
}

function orderedUniqueReplayEvents(replay: GatewayReplay): GatewayEventEnvelope[] {
  return orderedUniqueEvents([...replay.snapshot, ...replay.deltas]);
}

function orderedUniqueEvents(events: GatewayEventEnvelope[]): GatewayEventEnvelope[] {
  const seen = new Set<string>();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId))
    .filter(event => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    });
}

function mapGatewayEvent(
  event: GatewayEventEnvelope,
  userInput?: string,
  completedResult: string | null = null,
): WebSessionRuntimeEvent | null {
  if (event.kind === 'turn_started') {
    if (!event.requestId || !event.turnId || !userInput) return null;
    return {
      type: 'turn_started',
      requestId: event.requestId,
      turnId: event.turnId,
      userInput,
      startedAt: event.occurredAt,
    };
  }
  if (event.kind === 'conversation_snapshot') {
    const payload = event.payload as { from?: number; lines?: string[] };
    return {
      type: 'output',
      from: payload.from ?? 0,
      lines: payload.lines ?? [],
    };
  }
  if (event.kind === 'trace_delta') {
    const payload = event.payload as { turnId?: string; events?: InteractionTraceEvent[] };
    return {
      type: 'trace_delta',
      turnId: payload.turnId ?? event.turnId ?? 'turn_unknown',
      fromSequence: payload.events?.[0]?.sequence ?? 0,
      events: payload.events ?? [],
    };
  }
  if (event.kind === 'terminal_error') {
    const payload = event.payload as { message?: string };
    if (!event.requestId || !event.turnId) return null;
    return {
      type: 'terminal_error',
      requestId: event.requestId,
      turnId: event.turnId,
      message: payload.message ?? 'Gateway execution failed',
      completedAt: event.occurredAt,
    };
  }
  if (event.kind === 'final_answer') {
    const payload = event.payload as { lines?: string[] };
    if (!event.requestId || !event.turnId) return null;
    return {
      type: 'final_answer',
      requestId: event.requestId,
      turnId: event.turnId,
      lines: payload.lines && payload.lines.length > 0
        ? payload.lines
        : completedResult?.split('\n') ?? [],
      completedAt: event.occurredAt,
    };
  }
  return null;
}

interface ResultAssembly {
  contentHash: string;
  byteLength: number;
  completeness: 'complete' | 'partial' | 'incomplete';
  certification: 'certified' | 'uncertified';
  chunks: Map<number, string>;
}

function resultMetadata(payload: Record<string, unknown>): Omit<ResultAssembly, 'chunks'> | null {
  const contentHash = stringValue(payload.contentHash);
  const byteLength = nonNegativeInteger(payload.byteLength);
  const completeness = payload.completeness;
  const certification = payload.certification;
  if (
    !contentHash
    || byteLength === null
    || !['complete', 'partial', 'incomplete'].includes(String(completeness))
    || !['certified', 'uncertified'].includes(String(certification))
  ) {
    return null;
  }
  return {
    contentHash,
    byteLength,
    completeness: completeness as ResultAssembly['completeness'],
    certification: certification as ResultAssembly['certification'],
  };
}

function resultIdFromPayload(payload: unknown): string | null {
  return stringValue(asRecord(payload).resultId);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
