import type { GatewayCommand } from './client-protocol.js';
import type { WorkspaceDirectoryService } from '../workspace/workspace-directory-service.js';

type WorkspaceGatewayCommand = Extract<GatewayCommand, {
  kind: 'select_workspace'
    | 'list_workspace_conversations'
    | 'create_conversation'
    | 'archive_conversation';
}>;

export interface WorkspaceGatewayRuntimeResult {
  readonly status: 'accepted' | 'rejected';
  readonly conversationId?: string;
  readonly reason?: string;
}

export interface WorkspaceGatewayRuntimeOptions {
  readonly publish?: (
    kind: 'workspace_directory_snapshot'
      | 'workspace_conversation_upserted'
      | 'workspace_conversation_removed',
    workspaceId: string,
    payload: unknown,
  ) => Promise<void> | void;
}

export class WorkspaceGatewayRuntime {
  private readonly activeWorkspaceByConnection = new Map<string, string>();

  constructor(
    private readonly directory: WorkspaceDirectoryService,
    private readonly options: WorkspaceGatewayRuntimeOptions = {},
  ) {}

  activeWorkspaceId(connectionId: string): string | null {
    return this.activeWorkspaceByConnection.get(connectionId) ?? null;
  }

  restoreConnectionWorkspace(connectionId: string, workspaceId: string): void {
    this.activeWorkspaceByConnection.set(connectionId, workspaceId);
  }

  closeConnection(connectionId: string): void {
    this.activeWorkspaceByConnection.delete(connectionId);
  }

  async handle(
    command: WorkspaceGatewayCommand,
    context: { principalId: string; connectionId: string },
  ): Promise<WorkspaceGatewayRuntimeResult> {
    try {
      if (command.kind === 'select_workspace') {
        const selection = await this.directory.selectByPath(command.path, context.principalId);
        this.activeWorkspaceByConnection.set(context.connectionId, selection.workspace.id);
        const page = await this.directory.listConversations(
          selection.workspace.id,
          context.principalId,
          {},
        );
        await this.options.publish?.(
          'workspace_directory_snapshot',
          selection.workspace.id,
          { workspace: selection.workspace, page },
        );
        return { status: 'accepted' };
      }
      const activeWorkspaceId = this.activeWorkspaceByConnection.get(context.connectionId);
      if (!activeWorkspaceId) {
        return { status: 'rejected', reason: 'workspace_required' };
      }
      if ('workspaceId' in command && command.workspaceId !== activeWorkspaceId) {
        return { status: 'rejected', reason: 'workspace_not_selected' };
      }
      if (command.kind === 'list_workspace_conversations') {
        const page = await this.directory.listConversations(activeWorkspaceId, context.principalId, {
          ...(command.cursor ? { cursor: command.cursor } : {}),
          ...(command.query ? { query: command.query } : {}),
        });
        await this.options.publish?.(
          'workspace_directory_snapshot',
          activeWorkspaceId,
          { page },
        );
        return { status: 'accepted' };
      }
      if (command.kind === 'create_conversation') {
        const conversation = await this.directory.createConversation(
          activeWorkspaceId,
          context.principalId,
        );
        const page = await this.directory.listConversations(
          activeWorkspaceId,
          context.principalId,
          { query: conversation.title },
        );
        const summary = page.items.find(item => item.conversationId === conversation.id);
        await this.options.publish?.(
          'workspace_conversation_upserted',
          activeWorkspaceId,
          { conversation: summary ?? conversation },
        );
        return { status: 'accepted', conversationId: conversation.id };
      }
      await this.directory.archiveConversation(
        command.conversationId,
        activeWorkspaceId,
        context.principalId,
      );
      await this.options.publish?.(
        'workspace_conversation_removed',
        activeWorkspaceId,
        { conversationId: command.conversationId },
      );
      return { status: 'accepted', conversationId: command.conversationId };
    } catch (error) {
      return { status: 'rejected', reason: (error as Error).message };
    }
  }
}
