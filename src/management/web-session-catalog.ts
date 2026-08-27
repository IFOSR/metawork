import type {
  ExecutionTimeline,
  TimelineAttempt,
  TimelineStage,
} from './execution-projector.js';
import {
  sanitizeInteractionTraceDetails,
  sanitizeInteractionTraceText,
  type InteractionTraceEvent,
} from './interaction-trace.js';
import {
  WEB_SESSION_FORMAT_VERSION,
  MAX_WEB_SESSION_TURNS,
  boundConversationTraceEvents,
  boundWebSessionTurns,
  type ConversationTurn,
  type WebSessionMetadata,
  type WebSessionRecord,
} from './web-session-types.js';
import type { ArtifactProjection } from '../delivery/user-artifact-types.js';
import type {
  ConversationPresentationStore,
} from '../storage/file-conversation-presentation-store.js';
import { CONVERSATION_PRESENTATION_VERSION } from '../storage/file-conversation-presentation-store.js';
import type { ConversationStore } from '../session/conversation-store.js';
import { MAX_CONVERSATION_TURNS } from '../session/conversation-store.js';
import type { WorkspaceDirectoryService } from '../workspace/workspace-directory-service.js';

const MAX_SESSION_TITLE_LENGTH = 80;
const DEFAULT_SESSION_TITLE = 'New session';

export interface WebSessionCatalogDeps {
  readonly directory: WorkspaceDirectoryService;
  readonly conversationStore: ConversationStore;
  readonly presentationStore: ConversationPresentationStore;
  now?: () => string;
  normalizeTurnPresentation?: (turn: ConversationTurn) => ConversationTurn;
}

export interface CreateWebSessionInput {
  readonly workspaceId: string;
  readonly principalId: string;
}

export interface ListWebSessionsInput {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly activeConversationId?: string | null;
  readonly query?: string;
}

export class WebSessionCatalog {
  private readonly now: () => string;
  private readonly normalizeTurnPresentation: (turn: ConversationTurn) => ConversationTurn;
  private initialized = false;

  constructor(private readonly deps: WebSessionCatalogDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.normalizeTurnPresentation = deps.normalizeTurnPresentation
      ?? (turn => structuredClone(turn));
  }

  async initialize(): Promise<void> {
    await Promise.all([
      this.deps.conversationStore.initialize(),
      this.deps.presentationStore.initialize(),
    ]);
    this.initialized = true;
  }

  async create(input: CreateWebSessionInput): Promise<WebSessionRecord> {
    await this.ensureInitialized();
    const conversation = await this.deps.directory.createConversation(
      input.workspaceId,
      input.principalId,
    );
    const record: WebSessionRecord = {
      version: WEB_SESSION_FORMAT_VERSION,
      session: metadataProjection(conversation, false),
      turns: [],
    };
    await this.deps.presentationStore.write({
      version: CONVERSATION_PRESENTATION_VERSION,
      conversationId: conversation.id,
      turns: [],
    });
    return record;
  }

  async list(input: ListWebSessionsInput): Promise<WebSessionMetadata[]> {
    await this.ensureInitialized();
    const sessions: WebSessionMetadata[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.deps.directory.listConversations(
        input.workspaceId,
        input.principalId,
        {
          limit: 100,
          ...(cursor ? { cursor } : {}),
          ...(input.query ? { query: input.query } : {}),
        },
      );
      sessions.push(...page.items.map(item => ({
        id: item.conversationId,
        title: item.title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        active: item.conversationId === input.activeConversationId,
        archived: item.archived,
      })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return sessions;
  }

  async search(input: ListWebSessionsInput): Promise<WebSessionMetadata[]> {
    return this.list(input);
  }

  async read(
    sessionId: string,
    activeConversationId: string | null = null,
  ): Promise<WebSessionRecord | null> {
    await this.ensureInitialized();
    const conversation = await this.deps.conversationStore.readConversation(sessionId);
    if (!conversation) return null;
    const presentation = await this.deps.presentationStore.read(sessionId);
    return {
      version: WEB_SESSION_FORMAT_VERSION,
      session: metadataProjection(
        conversation.conversation,
        sessionId === activeConversationId,
      ),
      turns: (presentation?.turns ?? []).map(turn => this.normalizeTurn(turn)),
    };
  }

  async workspaceIdForConversation(sessionId: string): Promise<string | null> {
    const record = await this.deps.conversationStore.readConversation(sessionId);
    return record?.conversation.workspaceBinding?.workspaceId ?? null;
  }

  listWorkspaces(principalId: string) {
    return this.deps.directory.listWorkspaces(principalId);
  }

  async appendTurn(
    sessionId: string,
    turn: ConversationTurn,
  ): Promise<WebSessionRecord | null> {
    await this.ensureInitialized();
    const conversation = await this.deps.conversationStore.readConversation(sessionId);
    if (!conversation) return null;
    const presentation = await this.deps.presentationStore.read(sessionId);
    const currentTurns = presentation?.turns ?? [];

    const safeTurn = this.normalizeTurn(sanitizeConversationTurn(turn, sessionId));
    const timestamp = this.now();
    const turns = boundWebSessionTurns([...currentTurns, safeTurn]);
    const firstQueryTitle = firstUserQueryTitle(turns);
    const metadata = {
      ...conversation.conversation,
      title: firstQueryTitle ?? conversation.conversation.title,
      updatedAt: timestamp,
    };
    await this.deps.presentationStore.write({
      version: CONVERSATION_PRESENTATION_VERSION,
      conversationId: sessionId,
      turns,
    });
    await this.deps.conversationStore.writeConversation({
      ...conversation,
      conversation: metadata,
      turns: [...conversation.turns, {
        id: safeTurn.id,
        conversationId: sessionId,
        userInput: safeTurn.userInput,
        finalAnswer: safeTurn.finalAnswer,
        status: safeTurn.status,
      }].slice(-MAX_CONVERSATION_TURNS),
    });
    const catalog = await this.deps.conversationStore.readCatalog();
    await this.deps.conversationStore.writeCatalog({
      ...catalog,
      conversations: catalog.conversations.map(item => item.id === sessionId ? metadata : item),
    });
    const updated: WebSessionRecord = {
      version: WEB_SESSION_FORMAT_VERSION,
      session: metadataProjection(metadata, false),
      turns,
    };
    return updated;
  }

  async archive(
    sessionId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<boolean> {
    await this.ensureInitialized();
    if (!(await this.deps.conversationStore.readConversation(sessionId))) return false;
    await this.deps.directory.archiveConversation(sessionId, workspaceId, principalId);
    return true;
  }

  async clearWorkspace(
    workspaceId: string,
    principalId: string,
    exceptId?: string,
  ): Promise<number> {
    await this.ensureInitialized();
    const sessions = await this.list({ workspaceId, principalId });
    let archived = 0;
    for (const session of sessions) {
      if (session.id === exceptId) continue;
      if (await this.archive(session.id, workspaceId, principalId)) archived += 1;
    }
    return archived;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private normalizeTurn(turn: ConversationTurn): ConversationTurn {
    return this.normalizeTurnPresentation(turn);
  }
}

function normalizeSessionTitle(value?: string): string {
  const normalized = sanitizeInteractionTraceText(value ?? '', 500)
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return DEFAULT_SESSION_TITLE;
  return normalized.slice(0, MAX_SESSION_TITLE_LENGTH).trimEnd();
}

function firstUserQueryTitle(turns: ConversationTurn[]): string | null {
  const query = turns.find(turn => isOrdinaryUserQuery(turn.userInput))?.userInput;
  return query ? normalizeSessionTitle(query) : null;
}

function isOrdinaryUserQuery(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && !normalized.startsWith('/');
}

function metadataProjection(
  metadata: import('../session/conversation-store.js').ConversationMetadata,
  active: boolean,
): WebSessionMetadata {
  return {
    id: metadata.id,
    title: metadata.title,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    active,
    archived: metadata.archived,
  };
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
        attempts: subtask.attempts.slice(0, 20).map((attempt, attemptIndex) => ({
          ...(attempt.attemptId === undefined ? {} : {
            attemptId: sanitizeInteractionTraceText(attempt.attemptId, 160),
          }),
          attemptKind: attempt.attemptKind ?? 'primary',
          attemptOrdinal: Math.max(1, Math.floor(attempt.attemptOrdinal ?? attemptIndex + 1)),
          attemptLabel: sanitizeInteractionTraceText(
            attempt.attemptLabel ?? legacyAttemptLabel(attempt.attemptKind),
            80,
          ),
          displayStatus: attempt.displayStatus ?? legacyDisplayStatus(attempt.status, attempt.result),
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

function legacyAttemptLabel(kind: TimelineAttempt['attemptKind'] | undefined): string {
  if (kind === 'continuation') return '继续执行';
  if (kind === 'fallback') return '回退执行';
  if (kind === 'contract_correction') return '结果修正';
  if (kind === 'merge_repair') return '合并修复';
  return '主执行';
}

function legacyDisplayStatus(
  status: string | undefined,
  result: string,
): TimelineAttempt['displayStatus'] {
  if (result === 'success' || status === 'terminal') return '已完成';
  if (result === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  if (status === 'pending_launch' || status === 'launching') return '等待启动';
  if (status === 'running' || result === 'running') return '执行中';
  return '状态未知';
}
