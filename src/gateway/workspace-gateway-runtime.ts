import type { GatewayCommand } from './client-protocol.js';
import type { WorkspaceDirectoryService } from '../workspace/workspace-directory-service.js';
import { WorkspaceConversationProjector } from '../workspace/workspace-conversation-projector.js';

type WorkspaceGatewayCommand = Extract<GatewayCommand, {
  kind: 'select_workspace'
    | 'list_workspace_conversations'
    | 'create_conversation'
    | 'archive_conversation'
    | import('./client-protocol.js').GatewayWorkspaceMergeCommand['kind'];
}>;

export interface WorkspaceGatewayRuntimeResult {
  readonly status: 'accepted' | 'rejected';
  readonly workspaceId?: string;
  readonly workspaceMerge?:import('./command-admission.js').CommandReceipt['workspaceMerge'];
  readonly directory?: import('./command-admission.js').CommandReceipt['directory'];
  readonly conversationId?: string;
  readonly reason?: string;
}

export interface WorkspaceGatewayRuntimeOptions {
  readonly merge?:import('../execution/workspace-merge-worker.js').WorkspaceMergeWorker;
  readonly publish?: (
    kind: 'workspace_directory_snapshot'
      | 'workspace_conversation_upserted'
      | 'workspace_conversation_removed'
      | 'workspace_activity_changed',
    workspaceId: string,
    payload: unknown,
  ) => Promise<void> | void;
  readonly publishConnection?: (
    kind: 'workspace_directory_snapshot',
    connectionId: string,
    payload: unknown,
    requestId?: string,
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

  async activateWorkspace(
    connectionId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<void> {
    this.restoreConnectionWorkspace(connectionId, workspaceId);
    await this.publishWorkspaceSnapshot(workspaceId, principalId, connectionId);
  }

  async publishWorkspaceSnapshot(
    workspaceId: string,
    principalId: string,
    connectionId?: string,
  ): Promise<void> {
    const workspace = await this.directory.getWorkspace(workspaceId, principalId);
    const page = await this.directory.listConversations(workspaceId, principalId, {});
    if (connectionId) {
      await this.options.publishConnection?.(
        'workspace_directory_snapshot', connectionId, { workspaceId, workspace, page },
      );
      return;
    }
    await this.options.publish?.(
      'workspace_directory_snapshot',
      workspaceId,
      { workspace, page },
    );
  }

  closeConnection(connectionId: string): void {
    this.activeWorkspaceByConnection.delete(connectionId);
  }

  async publishActivity(
    workspaceId: string,
    payload: { conversationId: string; activity: unknown },
  ): Promise<void> {
    await this.options.publish?.('workspace_activity_changed', workspaceId, payload);
  }

  async publishConversation(conversation: import('../workspace/workspace-conversation-projector.js').WorkspaceConversationSummary): Promise<void> {
    await this.options.publish?.('workspace_conversation_upserted', conversation.workspaceId, { conversation });
  }

  async handle(
    command: WorkspaceGatewayCommand,
    context: { principalId: string; connectionId: string; requestId?: string },
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
        await this.options.publishConnection?.(
          'workspace_directory_snapshot',
          context.connectionId,
          { workspaceId: selection.workspace.id, workspace: selection.workspace, page },
          context.requestId,
        );
        return {
          status: 'accepted', workspaceId: selection.workspace.id,
          directory: { workspace: selection.workspace, page },
        };
      }
      const activeWorkspaceId = this.activeWorkspaceByConnection.get(context.connectionId);
      if (!activeWorkspaceId) {
        return { status: 'rejected', reason: 'workspace_required' };
      }
      if ('workspaceId' in command && command.workspaceId !== activeWorkspaceId) {
        return { status: 'rejected', reason: 'workspace_not_selected' };
      }
      if(command.kind==='get_workspace_conflict_versions'||command.kind==='get_workspace_merge_queue'||command.kind==='get_workspace_merge_conflict'||command.kind==='resolve_workspace_merge_conflict'||command.kind==='retry_workspace_merge'||command.kind==='cancel_workspace_merge') {
        // Authorization precedes every lookup: a bare jobId never grants access.
        await this.directory.getWorkspace(activeWorkspaceId,context.principalId);
        const merge=this.options.merge;if(!merge)throw new Error('workspace_merge_unavailable');
        if(command.kind==='get_workspace_merge_queue')return {status:'accepted',workspaceId:activeWorkspaceId,workspaceMerge:{jobs:merge.repo.queue(activeWorkspaceId,command.afterSequence)}};
        const job=merge.repo.job(command.jobId);if(!job||job.workspaceId!==activeWorkspaceId)throw new Error('merge_job_not_found');
        if(command.kind==='get_workspace_conflict_versions') return {status:'accepted',workspaceId:activeWorkspaceId,
          workspaceMerge:{versions:await merge.conflictVersions(job.jobId,command.conflictVersion,command.path,command.offset)}};
        if(command.kind==='get_workspace_merge_conflict') {
          const result=await merge.conflicts(job.jobId);const offset=command.offset??0;
          return {status:'accepted',workspaceId:activeWorkspaceId,workspaceMerge:{job,paths:result.paths.slice(offset,offset+100),nextOffset:offset+100<result.paths.length?offset+100:null}};
        }
        if(!context.requestId)throw new Error('request_id_required');
        if(command.kind==='resolve_workspace_merge_conflict') {
          await merge.resolve({jobId:job.jobId,requestId:context.requestId,expectedConflictVersion:command.conflictVersion,expectedRowVersion:command.rowVersion,
            actions:command.actions.map(a=>({path:a.path,action:a.action,newPath:a.newPath,content:a.contentBase64!==undefined?Buffer.from(a.contentBase64,'base64'):undefined}))});
        } else if(command.kind==='retry_workspace_merge')await merge.retry(job.jobId,command.rowVersion);
        else await merge.cancel(job.jobId,command.rowVersion,command.partialDecision,context.requestId);
        return {status:'accepted',workspaceId:activeWorkspaceId,workspaceMerge:{job:merge.repo.job(job.jobId)!}};
      }
      if (command.kind === 'list_workspace_conversations') {
        const workspace = await this.directory.getWorkspace(activeWorkspaceId, context.principalId);
        const page = await this.directory.listConversations(activeWorkspaceId, context.principalId, {
          ...(command.cursor ? { cursor: command.cursor } : {}),
          ...(command.query ? { query: command.query } : {}),
        });
        await this.options.publishConnection?.(
          'workspace_directory_snapshot',
          context.connectionId,
          { workspaceId: activeWorkspaceId, workspace, page, requestedCursor: command.cursor ?? null, query: command.query ?? '' },
          context.requestId,
        );
        return { status: 'accepted', workspaceId: activeWorkspaceId };
      }
      if (command.kind === 'create_conversation') {
        const conversation = await this.directory.createConversation(
          activeWorkspaceId,
          context.principalId,
        );
        const summary = new WorkspaceConversationProjector().project(conversation);
        await this.options.publish?.(
          'workspace_conversation_upserted',
          activeWorkspaceId,
          { conversation: summary ?? conversation },
        );
        return {
          status: 'accepted',
          workspaceId: activeWorkspaceId,
          conversationId: conversation.id,
        };
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
      return {
        status: 'accepted',
        workspaceId: activeWorkspaceId,
        conversationId: command.conversationId,
      };
    } catch (error) {
      return { status: 'rejected', reason: (error as Error).message };
    }
  }
}
