import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { ConversationMetadata, ConversationStore } from '../session/conversation-store.js';
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

export interface WorkspaceSelectionResult {
  readonly workspace: WorkspaceRecord;
  readonly created: boolean;
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
}

export interface WorkspaceDirectoryServiceDeps {
  readonly accountId: string;
  readonly workspaceCatalog: WorkspaceCatalogStore;
  readonly conversationStore: ConversationStore;
  readonly authorize: (path: string, principalId: string) => Promise<boolean> | boolean;
  readonly createWorkspaceId?: () => WorkspaceId;
  readonly createConversationId?: () => string;
  readonly now?: () => string;
  readonly projector?: WorkspaceConversationProjector;
  readonly getConversationActivity?: (
    conversationId: string,
    fallbackUpdatedAt: string,
  ) => ConversationActivityProjection;
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
    if (!isAbsolute(path)) throw new Error('workspace_path_invalid');
    const canonicalPath = await realpath(path);
    if (!(await stat(canonicalPath)).isDirectory()) throw new Error('workspace_path_invalid');
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
        return { workspace: existing, created: false };
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
      return { workspace, created: true };
    });
  }

  async listWorkspaces(principalId: string): Promise<WorkspaceSummary[]> {
    const workspaces = (await this.deps.workspaceCatalog.readCatalog()).workspaces
      .filter(workspace => workspace.accountId === this.deps.accountId)
      .filter(workspace => !workspace.archived);
    const authorized = await Promise.all(workspaces.map(async workspace => (
      await this.canAccessWorkspace(workspace, principalId) ? workspace : null
    )));
    return authorized
      .filter((workspace): workspace is WorkspaceRecord => workspace !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listConversations(
    workspaceId: string,
    principalId: string,
    page: WorkspaceConversationPageRequest = {},
  ): Promise<WorkspaceConversationPage> {
    await this.requireWorkspaceAccess(workspaceId, principalId);
    const limit = Math.min(Math.max(page.limit ?? 50, 1), 100);
    const offset = decodeCursor(page.cursor);
    const query = page.query?.trim().toLocaleLowerCase();
    const items = (await this.deps.conversationStore.readCatalog()).conversations
      .filter(metadata => metadata.accountId === this.deps.accountId)
      .map(metadata => this.projector.project(metadata))
      .filter((item): item is WorkspaceConversationSummary => item !== null)
      .filter(item => item.workspaceId === workspaceId)
      .filter(item => page.includeArchived || !item.archived)
      .filter(item => !query || item.title.toLocaleLowerCase().includes(query))
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
    const catalog = await this.deps.conversationStore.readCatalog();
    await this.deps.conversationStore.writeCatalog({
      ...catalog,
      conversations: [...catalog.conversations, metadata],
    });
    return metadata;
  }

  async resolveConversationWorkspace(
    conversationId: string,
    principalId: string,
  ): Promise<string | null> {
    const record = await this.deps.conversationStore.readConversation(conversationId);
    if (!record || record.conversation.accountId !== this.deps.accountId) return null;
    const workspaceId = record.conversation.workspaceBinding?.workspaceId;
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
    const catalog = await this.deps.conversationStore.readCatalog();
    await this.deps.conversationStore.writeCatalog({
      ...catalog,
      conversations: catalog.conversations.map(item => (
        item.id === conversationId ? metadata : item
      )),
    });
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
  const priority = { blocked: 5, executing: 4, waiting: 3, planning: 2, idle: 1 };
  const activity = priority[right.activity.state] - priority[left.activity.state];
  if (activity !== 0) return activity;
  const updated = right.updatedAt.localeCompare(left.updatedAt);
  return updated !== 0 ? updated : left.conversationId.localeCompare(right.conversationId);
}
