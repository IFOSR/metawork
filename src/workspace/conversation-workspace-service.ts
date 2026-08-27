import type {
  ConversationRecord,
  ConversationStore,
  ConversationWorkspaceBinding,
} from '../session/conversation-store.js';
import type { WorkspaceCatalogStore } from './workspace-catalog-store.js';
import type { WorkspaceId } from './workspace-types.js';

export interface ConversationWorkspaceSelection extends ConversationWorkspaceBinding {
  readonly path: string;
  readonly selectedAt: string;
  readonly selectedByPrincipal: string;
}

export type WorkspaceCommandResult =
  | { readonly status: 'changed'; readonly workspace: ConversationWorkspaceSelection }
  | { readonly status: 'unchanged'; readonly workspace: ConversationWorkspaceSelection }
  | {
      readonly status: 'rejected';
      readonly code: WorkspaceRejectionCode;
      readonly message: string;
    };

export type WorkspaceRejectionCode =
  | 'workspace_command_invalid'
  | 'workspace_path_invalid'
  | 'workspace_unauthorized'
  | 'workspace_unavailable'
  | 'workspace_binding_locked'
  | 'workspace_busy'
  | 'workspace_required'
  | 'conversation_not_found';

export interface ConversationWorkspaceServiceDeps {
  readonly store: ConversationStore;
  readonly workspaceCatalog: WorkspaceCatalogStore;
  readonly conversationId: string;
  readonly isBusy: () => boolean;
  readonly now?: () => string;
}

export interface ConversationWorkspacePort {
  getWorkspace(): Promise<ConversationWorkspaceSelection | null>;
  bindEmptyConversation(
    workspaceId: WorkspaceId,
    principalId: string,
  ): Promise<WorkspaceCommandResult>;
}

export class ConversationWorkspaceService implements ConversationWorkspacePort {
  constructor(private readonly deps: ConversationWorkspaceServiceDeps) {}

  async getWorkspace(): Promise<ConversationWorkspaceSelection | null> {
    const record = await this.deps.store.readConversation(this.deps.conversationId);
    const binding = record?.conversation.workspaceBinding;
    if (!binding) return null;
    const workspace = await this.deps.workspaceCatalog.findById(binding.workspaceId);
    if (!workspace || workspace.archived || workspace.availability !== 'available') return null;
    return {
      ...binding,
      path: workspace.canonicalPath,
      selectedAt: binding.boundAt,
      selectedByPrincipal: binding.boundByPrincipal,
    };
  }

  async bindEmptyConversation(
    workspaceId: WorkspaceId,
    principalId: string,
  ): Promise<WorkspaceCommandResult> {
    if (this.deps.isBusy()) {
      return rejected('workspace_busy', '当前 Conversation 有活动 Turn 或 Task');
    }
    const workspace = await this.deps.workspaceCatalog.findById(workspaceId);
    if (!workspace || workspace.archived) {
      return rejected('workspace_unauthorized', 'Workspace 不存在或未授权');
    }
    if (workspace.availability !== 'available') {
      return rejected('workspace_unavailable', 'Workspace 当前不可用');
    }
    const record = await this.deps.store.readConversation(this.deps.conversationId);
    if (!record) return rejected('conversation_not_found', 'Conversation 不存在');
    if (record.turns.length > 0) {
      return rejected('workspace_binding_locked', 'Conversation Workspace binding 已锁定');
    }
    const existing = record.conversation.workspaceBinding;
    if (existing?.workspaceId === workspaceId) {
      return {
        status: 'unchanged',
        workspace: {
          ...existing,
          path: workspace.canonicalPath,
          selectedAt: existing.boundAt,
          selectedByPrincipal: existing.boundByPrincipal,
        },
      };
    }
    const boundAt = this.deps.now?.() ?? new Date().toISOString();
    const binding: ConversationWorkspaceBinding = {
      workspaceId,
      boundAt,
      boundByPrincipal: principalId,
    };
    const updated: ConversationRecord = {
      ...record,
      conversation: {
        ...record.conversation,
        workspaceBinding: binding,
        updatedAt: boundAt,
      },
    };
    await this.deps.store.writeConversation(updated);
    const catalog = await this.deps.store.readCatalog();
    await this.deps.store.writeCatalog({
      ...catalog,
      conversations: catalog.conversations.map(metadata => (
        metadata.id === updated.conversation.id ? updated.conversation : metadata
      )),
    });
    return {
      status: 'changed',
      workspace: {
        ...binding,
        path: workspace.canonicalPath,
        selectedAt: binding.boundAt,
        selectedByPrincipal: binding.boundByPrincipal,
      },
    };
  }
}

function rejected(
  code: WorkspaceRejectionCode,
  message: string,
): WorkspaceCommandResult {
  return { status: 'rejected', code, message };
}

export function isAuthenticatedWorkspacePrincipalId(principalId: string): boolean {
  const match = /^(local|web|feishu|app):(.+)$/u.exec(principalId);
  if (!match) return false;
  const kind = match[1]!;
  const externalId = match[2]!;
  if (externalId !== externalId.trim()) return false;
  if (Buffer.byteLength(externalId, 'utf8') > 256 || /[\u0000-\u001f\u007f]/u.test(externalId)) {
    return false;
  }
  if (kind === 'local') return externalId === 'local-installation';
  if (kind === 'web') return externalId === 'local-web-user';
  if (kind === 'feishu') return /^[^:]+:[^:]+$/u.test(externalId);
  return true;
}
