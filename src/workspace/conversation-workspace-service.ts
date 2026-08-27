import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  ConversationMetadata,
  ConversationRecord,
  ConversationStore,
  ConversationWorkspace,
} from '../session/conversation-store.js';

export interface WorkspaceAuthorization {
  readonly authorize: (path: string, principalId: string) => Promise<boolean> | boolean;
  readonly isBusy: () => boolean;
}

export type WorkspaceCommandResult =
  | { readonly status: 'changed'; readonly workspace: ConversationWorkspace }
  | { readonly status: 'unchanged'; readonly workspace: ConversationWorkspace }
  | {
      readonly status: 'rejected';
      readonly code: WorkspaceRejectionCode;
      readonly message: string;
    };

export type WorkspaceRejectionCode =
  | 'workspace_command_invalid'
  | 'workspace_path_invalid'
  | 'workspace_unauthorized'
  | 'workspace_busy'
  | 'conversation_not_found';

export interface ConversationWorkspaceServiceDeps extends WorkspaceAuthorization {
  readonly store: ConversationStore;
  readonly conversationId: string;
  readonly principalId: string;
  readonly now?: () => string;
}

export interface ConversationWorkspacePort {
  getWorkspace(): Promise<ConversationWorkspace | null>;
  execute(input: string, principalId?: string): Promise<WorkspaceCommandResult>;
  initializeDefault(path: string, principalId?: string): Promise<WorkspaceCommandResult>;
}

export class ConversationWorkspaceService {
  constructor(private readonly deps: ConversationWorkspaceServiceDeps) {}

  async getWorkspace(): Promise<ConversationWorkspace | null> {
    const record = await this.deps.store.readConversation(this.deps.conversationId);
    return record?.conversation.workspace ?? null;
  }

  async execute(input: string, principalId = this.deps.principalId): Promise<WorkspaceCommandResult> {
    const rawPath = parseWorkspaceCommand(input);
    if (!rawPath) {
      return rejected('workspace_command_invalid', '用法: /workspace /absolute/path');
    }
    return this.changeWorkspace(rawPath, principalId);
  }

  async initializeDefault(
    path: string,
    principalId = this.deps.principalId,
  ): Promise<WorkspaceCommandResult> {
    const existing = await this.getWorkspace();
    if (existing) return { status: 'unchanged', workspace: existing };
    return this.changeWorkspace(path, principalId);
  }

  private async changeWorkspace(
    path: string,
    principalId: string,
  ): Promise<WorkspaceCommandResult> {
    if (!isAbsolute(path)) {
      return rejected('workspace_path_invalid', 'Workspace 必须是绝对路径');
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(path);
      if (!(await stat(canonicalPath)).isDirectory()) {
        return rejected('workspace_path_invalid', 'Workspace 必须是目录');
      }
    } catch {
      return rejected('workspace_path_invalid', 'Workspace 目录不存在或不可访问');
    }
    if (!(await this.deps.authorize(canonicalPath, principalId))) {
      return rejected('workspace_unauthorized', '当前 Principal 未被授权使用该 Workspace');
    }
    if (this.deps.isBusy()) {
      return rejected('workspace_busy', '当前 Conversation 有活动 Turn 或 Task，暂不能切换 Workspace');
    }

    const record = await this.deps.store.readConversation(this.deps.conversationId);
    if (!record) return rejected('conversation_not_found', 'Conversation 不存在');
    const workspace: ConversationWorkspace = {
      path: canonicalPath,
      selectedAt: this.deps.now?.() ?? new Date().toISOString(),
      selectedByPrincipal: principalId,
    };
    const updated: ConversationRecord = {
      ...record,
      conversation: {
        ...record.conversation,
        workspace,
        updatedAt: workspace.selectedAt,
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
    return { status: 'changed', workspace };
  }
}

function parseWorkspaceCommand(input: string): string | null {
  const prefix = '/workspace';
  if (!input.startsWith(prefix)) return null;
  const path = input.slice(prefix.length).trim();
  if (!path || /\s+\//u.test(path)) return null;
  return path;
}

function rejected(
  code: WorkspaceRejectionCode,
  message: string,
): WorkspaceCommandResult {
  return { status: 'rejected', code, message };
}

export function conversationMetadataWorkspace(
  metadata: ConversationMetadata,
): ConversationWorkspace | null {
  return metadata.workspace;
}
