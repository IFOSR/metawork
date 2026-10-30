import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { ConversationMetadata, ConversationStore } from '../session/conversation-store.js';
import { updateConversationCatalog } from '../session/conversation-catalog-mutation.js';
import type { WorkspaceCatalogStore } from './workspace-catalog-store.js';
import {
  normalizeWorkspaceDisplayName,
  type WorkspaceId,
  type WorkspaceRecord,
} from './workspace-types.js';
import {
  WorkspaceConversationProjector,
  type WorkspaceConversationSummary,
} from './workspace-conversation-projector.js';
import type { ConversationActivityProjection } from './conversation-activity-projector.js';
import type { WorkspaceDirectoryProjection } from './workspace-directory-projection.js';
import { measureNavigationStageSync } from '../utils/navigation-diagnostics.js';

export interface WorkspaceSelectionResult {
  readonly workspace: WorkspaceRecord;
  readonly created: boolean;
  readonly gitState?: WorkspaceRecord['gitState'];
  readonly gitError?: string | null;
}

export type WorkspacePreflightCode =
  | 'workspace_contains_runtime_root'
  | 'workspace_contains_workspace_store';

export class WorkspacePreflightError extends Error {
  readonly stage = 'workspace_preflight' as const;
  readonly retryable = false as const;
  readonly attemptStarted = false as const;
  readonly externalSideEffect = false as const;

  constructor(
    readonly code: WorkspacePreflightCode,
    message: string,
    readonly userAction = '请选择具体项目目录后重新提交请求。',
  ) {
    super(message);
    this.name = 'WorkspacePreflightError';
  }
}

export interface WorkspaceSummary extends WorkspaceRecord {}

export interface WorkspaceConversationPageRequest {
  readonly cursor?: string;
  readonly limit?: number;
  readonly query?: string;
  readonly includeArchived?: boolean;
}

export interface WorkspaceConversationPage {
  readonly items: WorkspaceConversationSummary[];
  readonly nextCursor: string | null;
  readonly projectionVersion?: number;
}

export interface WorkspaceDirectoryServiceDeps {
  readonly gitLifecycle?: {
    initialize(input: { accountId: string; workspaceId: string; userRoot: string }): Promise<unknown>;
    beginInitialize?(input: { accountId: string; workspaceId: string; userRoot: string }): { state: NonNullable<WorkspaceRecord['gitState']>; ready: Promise<unknown> };
    state?(workspaceId: string): NonNullable<WorkspaceRecord['gitState']>;
    error?(workspaceId: string): string | null;
    prepareConversation(input: { accountId: string; workspaceId: string; userRoot: string; conversationId: string }): Promise<unknown>;
    requestCleanup(conversationId: string): Promise<void>;
    beginCleanup?(conversationId: string): { state: 'cleaning' | 'retained' | 'cleaned'; ready: Promise<void> };
  };
  readonly accountId: string;
  readonly workspaceCatalog: WorkspaceCatalogStore;
  readonly conversationStore: ConversationStore;
  readonly authorize: (path: string, principalId: string) => Promise<boolean> | boolean;
  /** Install and internal workspace roots which are never valid user Workspaces. */
  readonly runtimeRoot?: string;
  readonly workspaceStoreRoot?: string;
  readonly createWorkspaceId?: () => WorkspaceId;
  readonly createConversationId?: () => string;
  readonly now?: () => string;
  readonly projector?: WorkspaceConversationProjector;
  readonly projection?: WorkspaceDirectoryProjection;
  readonly getConversationActivity?: (
    conversationId: string,
    fallbackUpdatedAt: string,
  ) => ConversationActivityProjection;
  readonly getConversationActivities?: (
    conversations: readonly { conversationId: string; updatedAt: string }[],
  ) => ReadonlyMap<string, ConversationActivityProjection>;
}

export class WorkspaceDirectoryService {
  private mutation = Promise.resolve();
  private readonly projector: WorkspaceConversationProjector;

  constructor(private readonly deps: WorkspaceDirectoryServiceDeps) {
    this.projector = deps.projector ?? new WorkspaceConversationProjector(
      deps.getConversationActivity
        ? { project: deps.getConversationActivity }
        : undefined,
    );
  }

  async selectByPath(path: string, principalId: string): Promise<WorkspaceSelectionResult> {
    const canonicalPath = await this.preflightPath(path);
    if (!(await this.deps.authorize(canonicalPath, principalId))) {
      throw new Error('workspace_unauthorized');
    }
    return this.mutate(async () => {
      const existing = await this.deps.workspaceCatalog.findByCanonicalPath(canonicalPath);
      if (existing) {
        if (existing.accountId !== this.deps.accountId) {
          throw new Error('workspace_unauthorized');
        }
        if (existing.archived || existing.availability !== 'available') {
          throw new Error('workspace_unavailable');
        }
        const preparation = this.prepareGit(existing.id, canonicalPath);
        return { workspace: this.workspaceWithGitState(existing, preparation.state), created: false, gitState: preparation.state, gitError: this.deps.gitLifecycle?.error?.(existing.id) ?? null };
      }
      const registered = (await this.deps.workspaceCatalog.readCatalog()).workspaces;
      if (registered.some(item => item.accountId === this.deps.accountId && item.canonicalPath !== canonicalPath && pathsOverlap(item.canonicalPath, canonicalPath))) {
        throw new Error('workspace_path_overlap');
      }
      const now = this.deps.now?.() ?? new Date().toISOString();
      const workspace: WorkspaceRecord = {
        id: this.deps.createWorkspaceId?.() ?? `workspace_${randomUUID()}`,
        accountId: this.deps.accountId,
        displayName: normalizeWorkspaceDisplayName(basename(canonicalPath) || 'Workspace'),
        canonicalPath,
        availability: 'available',
        createdAt: now,
        updatedAt: now,
        createdByPrincipal: principalId,
        archived: false,
      };
      const catalog = await this.deps.workspaceCatalog.readCatalog();
      await this.deps.workspaceCatalog.writeCatalog({
        ...catalog,
        workspaces: [...catalog.workspaces, workspace],
      });
      const preparation = this.prepareGit(workspace.id, canonicalPath);
      return { workspace: this.workspaceWithGitState(workspace, preparation.state), created: true, gitState: preparation.state, gitError: this.deps.gitLifecycle?.error?.(workspace.id) ?? null };
    });
  }

  /** Fast, side-effect-free validation shared by dispatch, retry and recovery. */
  async preflightPath(path: string): Promise<string> {
    if (!isAbsolute(path)) throw new Error('workspace_path_invalid');
    const canonicalPath = await realpath(path).catch(() => { throw new Error('workspace_path_invalid'); });
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('workspace_path_invalid');
    await this.assertWorkspacePreflight(canonicalPath);
    return canonicalPath;
  }

  private async assertWorkspacePreflight(canonicalPath: string): Promise<void> {
    const runtimeRoot = this.deps.runtimeRoot
      ? await realpath(this.deps.runtimeRoot).catch(() => safeRealpathForComparison(this.deps.runtimeRoot!))
      : null;
    if (runtimeRoot && pathsOverlap(canonicalPath, runtimeRoot)) {
      throw new WorkspacePreflightError(
        'workspace_contains_runtime_root',
        `不能使用此目录作为 Workspace：${canonicalPath} 与 MetaWork 运行目录 ${runtimeRoot} 重叠。请选择具体项目目录。`,
      );
    }
    const workspaceStoreRoot = this.deps.workspaceStoreRoot
      ? await realpath(this.deps.workspaceStoreRoot).catch(() => safeRealpathForComparison(this.deps.workspaceStoreRoot!))
      : null;
    if (workspaceStoreRoot && pathsOverlap(canonicalPath, workspaceStoreRoot)) {
      throw new WorkspacePreflightError(
        'workspace_contains_workspace_store',
        `不能使用此目录作为 Workspace：${canonicalPath} 与 MetaWork 内部 Workspace 存储目录重叠。请选择具体项目目录。`,
      );
    }
  }

  async listWorkspaces(principalId: string): Promise<WorkspaceSummary[]> {
    const workspaces = (await this.deps.workspaceCatalog.readCatalog()).workspaces
      .filter(workspace => workspace.accountId === this.deps.accountId)
      .filter(workspace => !workspace.archived);
    const authorized = await Promise.all(workspaces.map(async workspace => (
      await this.canAccessWorkspace(workspace, principalId) ? workspace : null
    )));
    const available = await Promise.all(authorized
      .filter((workspace): workspace is WorkspaceRecord => workspace !== null)
      .map(async workspace => ({
        workspace,
        pathAvailable: await isWorkspaceDirectoryAvailable(workspace.canonicalPath),
      })));
    return available
      .map(({ workspace, pathAvailable }) => this.workspaceWithGitState({
        ...workspace,
        // The catalog keeps the last known state so historical Conversations
        // remain addressable. The directory projection must still reflect the
        // path on disk, otherwise the selector offers an entry that selection
        // can only reject in preflightPath().
        availability: pathAvailable ? workspace.availability : 'unavailable',
      }, this.deps.gitLifecycle?.state?.(workspace.id), this.deps.gitLifecycle?.error?.(workspace.id)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getWorkspace(workspaceId: string, principalId: string): Promise<WorkspaceRecord> {
    return this.requireWorkspaceAccess(workspaceId, principalId);
  }

  async listConversations(
    workspaceId: string,
    principalId: string,
    page: WorkspaceConversationPageRequest = {},
  ): Promise<WorkspaceConversationPage> {
    await this.requireWorkspaceAccess(workspaceId, principalId);
    if (this.deps.projection) {
      return measureNavigationStageSync('directory_read', () => this.deps.projection!.page(workspaceId, page));
    }
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 100);
    const offset = decodeCursor(page.cursor);
    const query = page.query?.trim().toLocaleLowerCase();
    const metadata = (await this.deps.conversationStore.readCatalog()).conversations
      .filter(metadata => metadata.accountId === this.deps.accountId)
      .filter(metadata => metadata.workspaceBinding?.workspaceId === workspaceId)
      .filter(metadata => page.includeArchived || !metadata.archived)
      .filter(metadata => !query || metadata.title.slice(0, 160).toLocaleLowerCase().includes(query));
    const activities = this.deps.getConversationActivities?.(
      metadata.map(item => ({ conversationId: item.id, updatedAt: item.updatedAt })),
    );
    const projector = activities
      ? new WorkspaceConversationProjector({
          project: (id, updatedAt) => activities.get(id)
            ?? { state: 'idle', taskId: null, updatedAt, latestTaskCreatedAt: updatedAt },
        })
      : this.projector;
    const items = metadata
      .map(metadata => projector.project(metadata))
      .filter((item): item is WorkspaceConversationSummary => item !== null)
      .sort(compareSummaries);
    const selected = items.slice(offset, offset + limit);
    return {
      items: selected,
      nextCursor: offset + selected.length < items.length
        ? Buffer.from(String(offset + selected.length)).toString('base64url')
        : null,
    };
  }

  async createConversation(
    workspaceId: string,
    principalId: string,
  ): Promise<ConversationMetadata> {
    const workspace = await this.requireWorkspaceAccess(workspaceId, principalId);
    if (workspace.availability !== 'available') {
      throw new Error('workspace_unavailable');
    }
    const gitState = this.deps.gitLifecycle?.state?.(workspaceId);
    if (gitState && gitState !== 'ready') throw new Error(gitState === 'initializing' ? 'workspace_initializing' : 'workspace_unavailable');
    const now = this.deps.now?.() ?? new Date().toISOString();
    const id = this.deps.createConversationId?.() ?? `conv_${randomUUID()}`;
    const metadata: ConversationMetadata = {
      id,
      plannerSessionId: id,
      accountId: this.deps.accountId,
      title: 'New conversation',
      createdAt: now,
      updatedAt: now,
      archived: false,
      workspaceBinding: {
        workspaceId,
        boundAt: now,
        boundByPrincipal: principalId,
      },
    };
    await this.deps.conversationStore.writeConversation({
      version: 3,
      conversation: metadata,
      turns: [],
    });
    await updateConversationCatalog(this.deps.conversationStore, catalog => ({
      ...catalog,
      conversations: [...catalog.conversations, metadata],
    }));
    await this.deps.gitLifecycle?.prepareConversation({accountId: this.deps.accountId, workspaceId, userRoot: workspace.canonicalPath, conversationId: id});
    return metadata;
  }

  async resolveConversationWorkspace(
    conversationId: string,
    principalId: string,
  ): Promise<string | null> {
    const metadata = this.deps.conversationStore.readMetadata
      ? await this.deps.conversationStore.readMetadata(conversationId)
      : (await this.deps.conversationStore.readConversation(conversationId))?.conversation;
    if (!metadata || metadata.accountId !== this.deps.accountId) return null;
    const workspaceId = metadata.workspaceBinding?.workspaceId;
    if (!workspaceId) return null;
    const workspace = await this.deps.workspaceCatalog.findById(workspaceId);
    if (
      !workspace
      || workspace.accountId !== this.deps.accountId
      || workspace.archived
      || !(await this.canAccessWorkspace(workspace, principalId))
    ) {
      return null;
    }
    return workspaceId;
  }

  async isConversationInWorkspace(
    workspaceId: string,
    conversationId: string,
    principalId: string,
  ): Promise<boolean> {
    return await this.resolveConversationWorkspace(conversationId, principalId)
      === workspaceId;
  }

  async archiveConversation(
    conversationId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<void> {
    await this.requireWorkspaceAccess(workspaceId, principalId);
    const record = await this.deps.conversationStore.readConversation(conversationId);
    if (
      !record
      || record.conversation.accountId !== this.deps.accountId
      || record.conversation.workspaceBinding?.workspaceId !== workspaceId
    ) {
      throw new Error('conversation_not_in_workspace');
    }
    if (record.turns.some(turn => turn.status === 'blocked')) {
      throw new Error('workspace_busy');
    }
    const updatedAt = this.deps.now?.() ?? new Date().toISOString();
    const metadata: ConversationMetadata = {
      ...record.conversation,
      archived: true,
      updatedAt,
    };
    await this.deps.conversationStore.writeConversation({
      ...record,
      conversation: metadata,
    });
    await updateConversationCatalog(this.deps.conversationStore, catalog => ({
      ...catalog,
      conversations: catalog.conversations.map(item => (
        item.id === conversationId ? metadata : item
      )),
    }));
    if (this.deps.gitLifecycle?.beginCleanup) {
      this.deps.gitLifecycle.beginCleanup(conversationId);
    } else {
      await this.deps.gitLifecycle?.requestCleanup(conversationId);
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async requireWorkspaceAccess(
    workspaceId: string,
    principalId: string,
  ): Promise<WorkspaceRecord> {
    const workspace = await this.deps.workspaceCatalog.findById(workspaceId);
    if (
      !workspace
      || workspace.accountId !== this.deps.accountId
      || workspace.archived
      || !(await this.canAccessWorkspace(workspace, principalId))
    ) {
      throw new Error('workspace_unauthorized');
    }
    return workspace;
  }

  private prepareGit(workspaceId: string, userRoot: string): { state: NonNullable<WorkspaceRecord['gitState']>; ready: Promise<unknown> } {
    const input = { accountId: this.deps.accountId, workspaceId, userRoot };
    if (this.deps.gitLifecycle?.beginInitialize) return this.deps.gitLifecycle.beginInitialize(input);
    const ready = this.deps.gitLifecycle?.initialize(input) ?? Promise.resolve();
    return { state: 'ready', ready };
  }

  private workspaceWithGitState(workspace: WorkspaceRecord, state?: WorkspaceRecord['gitState'], error?: string | null): WorkspaceRecord {
    return state ? { ...workspace, gitState: state, ...(error ? { gitError: error } : {}) } : workspace;
  }

  private async canAccessWorkspace(
    workspace: WorkspaceRecord,
    principalId: string,
  ): Promise<boolean> {
    try {
      return await this.deps.authorize(workspace.canonicalPath, principalId);
    } catch {
      return false;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relation = relative(left, right);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
    || relative(right, left) === ''
    || (!relative(right, left).startsWith('..') && !isAbsolute(relative(right, left)));
}

function safeRealpathForComparison(path: string): string {
  // The configured roots are created during Server composition. Normalizing
  // here also keeps tests and early-startup errors deterministic if a root is
  // not present yet.
  return path.endsWith(sep) && path.length > 1 ? path.slice(0, -1) : path;
}

async function isWorkspaceDirectoryAvailable(path: string): Promise<boolean> {
  try {
    const canonicalPath = await realpath(path);
    return (await stat(canonicalPath)).isDirectory();
  } catch {
    return false;
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid_cursor');
  return parsed;
}

function compareSummaries(
  left: WorkspaceConversationSummary,
  right: WorkspaceConversationSummary,
): number {
  const taskCreated = (right.latestTaskCreatedAt ?? right.createdAt)
    .localeCompare(left.latestTaskCreatedAt ?? left.createdAt);
  return taskCreated !== 0 ? taskCreated : left.conversationId.localeCompare(right.conversationId);
}
