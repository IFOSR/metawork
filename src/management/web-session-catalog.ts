import { nanoid } from 'nanoid';
import type { ExecutionTimeline, TimelineStage } from './execution-projector.js';
import {
  sanitizeInteractionTraceDetails,
  sanitizeInteractionTraceText,
  type InteractionTraceEvent,
} from './interaction-trace.js';
import {
  WEB_SESSION_FORMAT_VERSION,
  boundConversationTraceEvents,
  boundWebSessionTurns,
  type ConversationTurn,
  type WebSessionMetadata,
  type WebSessionRecord,
} from './web-session-types.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import type { FileWebSessionStore } from '../storage/file-web-session-store.js';

const MAX_SESSION_TITLE_LENGTH = 80;
const DEFAULT_SESSION_TITLE = 'New session';

export interface WebSessionCatalogOptions {
  createId?: () => string;
  now?: () => string;
}

export interface CreateWebSessionInput {
  title?: string;
  active?: boolean;
}

export class WebSessionCatalog {
  private readonly createId: () => string;
  private readonly now: () => string;
  private initialized = false;

  constructor(
    private readonly store: FileWebSessionStore,
    options: WebSessionCatalogOptions = {},
  ) {
    this.createId = options.createId ?? (() => `sess_web_${nanoid(10)}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.initialized = true;
  }

  async create(input: CreateWebSessionInput = {}): Promise<WebSessionRecord> {
    await this.ensureInitialized();
    const timestamp = this.now();
    const session: WebSessionMetadata = {
      id: this.createId(),
      title: normalizeSessionTitle(input.title),
      createdAt: timestamp,
      updatedAt: timestamp,
      active: input.active ?? false,
      archived: false,
    };
    const record: WebSessionRecord = {
      version: WEB_SESSION_FORMAT_VERSION,
      session,
      turns: [],
    };
    await this.store.writeSession(record);
    await this.upsertMetadata(session);
    return record;
  }

  async list(): Promise<WebSessionMetadata[]> {
    await this.ensureInitialized();
    const catalog = await this.store.readCatalog();
    return [...catalog.sessions].sort(compareUpdatedAt);
  }

  async search(query: string): Promise<WebSessionMetadata[]> {
    const normalizedQuery = normalizeSearchText(query);
    const sessions = await this.list();
    if (!normalizedQuery) return sessions;

    const matches: WebSessionMetadata[] = [];
    for (const session of sessions) {
      if (normalizeSearchText(session.title).includes(normalizedQuery)) {
        matches.push(session);
        continue;
      }
      const record = await this.store.readSession(session.id);
      if (!record) continue;
      const text = record.turns
        .flatMap(turn => [turn.userInput, turn.finalAnswer ?? ''])
        .join('\n');
      if (normalizeSearchText(text).includes(normalizedQuery)) {
        matches.push(session);
      }
    }
    return matches;
  }

  async read(sessionId: string): Promise<WebSessionRecord | null> {
    await this.ensureInitialized();
    return this.store.readSession(sessionId);
  }

  async appendTurn(
    sessionId: string,
    turn: ConversationTurn,
  ): Promise<WebSessionRecord | null> {
    await this.ensureInitialized();
    const record = await this.store.readSession(sessionId);
    if (!record) return null;

    const safeTurn = sanitizeConversationTurn(turn, sessionId);
    const timestamp = this.now();
    const shouldDeriveTitle = record.session.title === DEFAULT_SESSION_TITLE;
    const updated: WebSessionRecord = {
      ...record,
      session: {
        ...record.session,
        title: shouldDeriveTitle
          ? normalizeSessionTitle(safeTurn.userInput)
          : record.session.title,
        updatedAt: timestamp,
      },
      turns: boundWebSessionTurns([...record.turns, safeTurn]),
    };
    await this.store.writeSession(updated);
    await this.upsertMetadata(updated.session);
    return updated;
  }

  /** 硬删除会话：文件移入 quarantine，catalog 同步移除。返回是否存在过。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    await this.ensureInitialized();
    return this.store.deleteSession(sessionId);
  }

  /** 批量硬删除（保留 exceptId），返回删除数量。 */
  async clearAll(exceptId?: string): Promise<number> {
    await this.ensureInitialized();
    return this.store.deleteAllSessions(exceptId);
  }

  async archive(sessionId: string): Promise<WebSessionRecord | null> {
    await this.ensureInitialized();
    const record = await this.store.readSession(sessionId);
    if (!record) return null;
    const updated: WebSessionRecord = {
      ...record,
      session: {
        ...record.session,
        active: false,
        archived: true,
        updatedAt: this.now(),
      },
    };
    await this.store.writeSession(updated);
    await this.upsertMetadata(updated.session);
    return updated;
  }

  async setActive(sessionId: string): Promise<WebSessionRecord | null> {
    await this.ensureInitialized();
    const target = await this.store.readSession(sessionId);
    if (!target || target.session.archived) return null;
    const catalog = await this.store.readCatalog();
    const updatedMetadata: WebSessionMetadata[] = [];

    for (const metadata of catalog.sessions) {
      const active = metadata.id === sessionId;
      const updated = { ...metadata, active };
      updatedMetadata.push(updated);
      const record = await this.store.readSession(metadata.id);
      if (record && record.session.active !== active) {
        await this.store.writeSession({
          ...record,
          session: { ...record.session, active },
        });
      }
    }
    await this.store.writeCatalog({
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: updatedMetadata.sort(compareUpdatedAt),
    });
    return this.store.readSession(sessionId);
  }

  private async upsertMetadata(session: WebSessionMetadata): Promise<void> {
    const catalog = await this.store.readCatalog();
    const sessions = catalog.sessions.filter(existing => existing.id !== session.id);
    sessions.push(session);
    await this.store.writeCatalog({
      version: WEB_SESSION_FORMAT_VERSION,
      sessions: sessions.sort(compareUpdatedAt),
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }
}

function normalizeSessionTitle(value?: string): string {
  const normalized = sanitizeInteractionTraceText(value ?? '', 500)
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return DEFAULT_SESSION_TITLE;
  return normalized.slice(0, MAX_SESSION_TITLE_LENGTH).trimEnd();
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function compareUpdatedAt(left: WebSessionMetadata, right: WebSessionMetadata): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
}

function sanitizeConversationTurn(
  turn: ConversationTurn,
  sessionId: string,
): ConversationTurn {
  return {
    ...turn,
    id: sanitizeInteractionTraceText(turn.id, 160),
    sessionId,
    userInput: sanitizeInteractionTraceText(turn.userInput, 8_000),
    finalAnswer: turn.finalAnswer === null
      ? null
      : sanitizeInteractionTraceText(turn.finalAnswer, 40_000),
    taskId: turn.taskId === null
      ? null
      : sanitizeInteractionTraceText(turn.taskId, 160),
    traceEvents: boundConversationTraceEvents(
      turn.traceEvents.map(sanitizeTraceEvent),
    ),
    executionTimeline: sanitizeExecutionTimeline(turn.executionTimeline),
    artifactRefs: turn.artifactRefs
      .slice(0, 100)
      .map(reference => sanitizeInteractionTraceText(reference, 500)),
    artifacts: sanitizeArtifactProjections(turn.artifacts),
  };
}

function sanitizeArtifactProjections(
  artifacts: ArtifactProjection[] | undefined,
): ArtifactProjection[] {
  if (!artifacts) return [];
  return artifacts.slice(0, 100).map(artifact => ({
    artifactId: sanitizeInteractionTraceText(artifact.artifactId, 160),
    taskId: sanitizeInteractionTraceText(artifact.taskId, 160),
    publicationId: artifact.publicationId === null
      ? null
      : sanitizeInteractionTraceText(artifact.publicationId, 160),
    displayName: sanitizeInteractionTraceText(artifact.displayName, 300),
    relativePath: sanitizeInteractionTraceText(artifact.relativePath, 500),
    mediaType: sanitizeInteractionTraceText(artifact.mediaType, 120),
    previewKind: artifact.previewKind,
    previewable: artifact.previewable === true,
    byteLength: Number.isFinite(artifact.byteLength) ? Math.max(0, Math.floor(artifact.byteLength)) : 0,
    contentHash: sanitizeInteractionTraceText(artifact.contentHash, 200),
    publishedAt: sanitizeInteractionTraceText(artifact.publishedAt, 80),
  }));
}

function sanitizeTraceEvent(event: InteractionTraceEvent): InteractionTraceEvent {
  return {
    ...event,
    id: sanitizeInteractionTraceText(event.id, 160),
    ...(event.cursor ? { cursor: sanitizeInteractionTraceText(event.cursor, 240) } : {}),
    ...(event.eventKey ? { eventKey: sanitizeInteractionTraceText(event.eventKey, 240) } : {}),
    ...(event.taskId ? { taskId: sanitizeInteractionTraceText(event.taskId, 160) } : {}),
    ...(event.subtaskId ? { subtaskId: sanitizeInteractionTraceText(event.subtaskId, 160) } : {}),
    ...(event.attemptId ? { attemptId: sanitizeInteractionTraceText(event.attemptId, 160) } : {}),
    kind: sanitizeInteractionTraceText(event.kind, 160),
    title: sanitizeInteractionTraceText(event.title, 300),
    summary: sanitizeInteractionTraceText(event.summary, 1_000),
    details: sanitizeInteractionTraceDetails(event.details),
  };
}

function sanitizeExecutionTimeline(
  timeline: ExecutionTimeline | null,
): ExecutionTimeline | null {
  if (!timeline) return null;
  return {
    taskId: sanitizeInteractionTraceText(timeline.taskId, 160),
    title: sanitizeInteractionTraceText(timeline.title, 500),
    status: sanitizeInteractionTraceText(timeline.status, 80),
    stages: timeline.stages.map(sanitizeTimelineStage),
  };
}

function sanitizeTimelineStage(stage: TimelineStage): TimelineStage {
  return {
    phase: stage.phase,
    status: stage.status,
    ...(stage.proposal ? {
      proposal: {
        subtasks: stage.proposal.subtasks
          .slice(0, 100)
          .map(title => sanitizeInteractionTraceText(title, 500)),
        dependencies: stage.proposal.dependencies
          .slice(0, 200)
          .map(edge => edge
            .slice(0, 2)
            .map(id => sanitizeInteractionTraceText(id, 160))),
      },
    } : {}),
    ...(stage.decisions ? {
      decisions: stage.decisions.slice(0, 200).map(decision => ({
        type: sanitizeInteractionTraceText(decision.type, 160),
        subtask: sanitizeInteractionTraceText(decision.subtask, 160),
        reason: sanitizeInteractionTraceText(decision.reason, 1_000),
      })),
    } : {}),
    ...(stage.subtasks ? {
      subtasks: stage.subtasks.slice(0, 100).map(subtask => ({
        id: sanitizeInteractionTraceText(subtask.id, 160),
        title: sanitizeInteractionTraceText(subtask.title, 500),
        status: sanitizeInteractionTraceText(subtask.status, 80),
        ...(subtask.executor ? {
          executor: sanitizeInteractionTraceText(subtask.executor, 160),
        } : {}),
        attempts: subtask.attempts.slice(0, 20).map(attempt => ({
          ...(attempt.attemptId === undefined ? {} : {
            attemptId: sanitizeInteractionTraceText(attempt.attemptId, 160),
          }),
          result: sanitizeInteractionTraceText(attempt.result, 160),
          ...(attempt.status === undefined ? {} : {
            status: sanitizeInteractionTraceText(attempt.status, 80),
          }),
          ...(attempt.startedAt === undefined ? {} : {
            startedAt: sanitizeInteractionTraceText(attempt.startedAt, 80),
          }),
          ...(attempt.updatedAt === undefined ? {} : {
            updatedAt: sanitizeInteractionTraceText(attempt.updatedAt, 80),
          }),
          ...(attempt.exitCode === undefined ? {} : { exitCode: attempt.exitCode }),
          ...(attempt.error === undefined ? {} : {
            error: sanitizeInteractionTraceText(attempt.error, 1_000),
          }),
          ...(attempt.progress === undefined ? {} : {
            progress: sanitizeInteractionTraceDetails(attempt.progress),
          }),
          ...(attempt.progressHistory === undefined ? {} : {
            progressHistory: attempt.progressHistory.slice(-20).map(entry => ({
              kind: sanitizeInteractionTraceText(entry.kind, 80),
              text: sanitizeInteractionTraceText(entry.text, 500),
              occurredAt: sanitizeInteractionTraceText(entry.occurredAt, 80),
            })),
          }),
        })),
      })),
    } : {}),
  };
}
