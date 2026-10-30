import { withWorkspaceGitLock } from './workspace-git-lock.js';
import type { WorkspaceMergeJob } from '../workspace/workspace-git-contracts.js';
import type { ConversationWorktreeService } from './conversation-worktree-service.js';
import type { WorkspaceMergeWorker } from './workspace-merge-worker.js';

/** Reconcile durable Git intents; never infer a business success or replay an Executor. */
export class WorkspaceGitRecovery {
  constructor(private readonly conversations: ConversationWorktreeService, private readonly merge: WorkspaceMergeWorker) {}

  async recover(observe: (job: WorkspaceMergeJob) => Promise<void>): Promise<void> {
    const {repo, git} = this.conversations;
    for (let root of repo.roots()) {
      try {
        if (!root.mainCommit && !root.deliveredCommit) root = await this.conversations.initialize(root);
        // A Planner process can disappear after claiming an observation but
        // before its RPC finally releases it. The durable PID witness lets
        // startup reclaim only a dead owner; a live or ambiguous PID remains
        // fenced so recovery never creates a second writer.
        for (const observation of repo.plannerObservations(root.workspaceId)) {
          let alive = false;
          if (observation.pid && observation.pid !== process.pid) {
            try { process.kill(observation.pid, 0); alive = true; } catch { alive = false; }
          }
          if (!alive) {
            repo.releaseConversation(observation.conversationId, observation.token);
            repo.operationState(observation.operationId, 'applied');
          }
        }
        for (const operation of repo.unfinishedOperations(root.workspaceId)) {
          if (operation.kind === 'initialize') {
            await git.validateRoot(root);
            repo.operationState(operation.operationId, 'applied');
          } else if (operation.kind === 'create_conversation' && typeof operation.payload.conversationId === 'string') {
            await this.conversations.ensure(root, operation.payload.conversationId);
            repo.operationState(operation.operationId, 'applied');
          } else if (operation.kind === 'external') {
            await withWorkspaceGitLock(root.repositoryPath, 'integration', async verify => {
              const target = operation.targetCommit!;
              for (const ref of ['refs/heads/main', 'refs/metawork/delivered']) {
                const current = await git.ref(root.repositoryPath, ref);
                if (current !== target && current !== operation.expectedRef) throw new Error('external_ref_identity_mismatch');
                await verify();
                if (current !== target) await git.updateRef(root.repositoryPath, ref, target, current);
              }
              await git.text(['-C', root.integrationPath, 'reset', '--hard', target]);
              root = {...root, mainCommit: target, deliveredCommit: target};
              repo.saveRoot(root);
              repo.operationState(operation.operationId, 'applied');
            });
          } else if (operation.kind === 'sync_conversation' && typeof operation.payload.conversationId === 'string') {
            const worktree = repo.conversation(operation.payload.conversationId);
            if (!worktree || repo.conversationState(worktree.worktreeId).ownerToken) continue;
            await withWorkspaceGitLock(root.repositoryPath, 'metadata', async () => {
              const head = await git.ref(root.repositoryPath, `refs/heads/${worktree.branch}`);
              if (head !== operation.expectedRef && head !== operation.targetCommit) throw new Error('sync_ref_identity_mismatch');
              const captured = await git.capture(root.repositoryPath,worktree.rootPath,head,'Recover session sync');
              if (captured !== head) throw new Error('conversation_has_unsealed_work');
              const synced = await git.syncConversation({...worktree,headCommit:head},operation.targetCommit!);
              repo.saveConversation(synced);
              repo.operationState(operation.operationId,'applied');
            });
          }
        }
        // Reconcile integration refs before sealing any stopped session: seal
        // validates main/delivered, which may still be midway through a durable merge.
        repo.saveRoot({...root, state: 'recovering'});
        await this.merge.recover(root.workspaceId, true);
        root = repo.root(root.workspaceId)!;
        await git.validateRoot(root);
        repo.saveRoot({...root, state: 'ready'});
        // Only durable backend removal proves that an old writer is gone.
        // Sealing retains its exact bytes; it never fabricates an Executor result.
        for (const owner of repo.stoppedOwners(root.workspaceId)) {
          const binding=repo.binding(owner.taskId,owner.generationId);
          if (!binding) throw new Error('recovery_conversation_binding_missing');
          root={...root,state:'ready'};
          repo.saveRoot(root);
          await this.conversations.sealAttempt(binding,owner.attemptId);
          repo.releaseConversation(owner.conversationId,owner.token);
        }
        let after = 0;
        for (;;) {
          const page = repo.queue(root.workspaceId, after);
          for (const job of page) await observe(job);
          if (page.length < 100) break;
          after = page[page.length - 1]!.sequence;
        }
        for (const worktree of repo.conversations(root.workspaceId)) {
          if (repo.conversationState(worktree.worktreeId).cleanupRequestedAt) {
            try { await this.conversations.requestCleanup(worktree.conversationId); }
            catch (error) {
              // A single retained/locked session must not poison the whole
              // Workspace integration root. The cleanup operation remains
              // durable and will be retried on the next recovery pass.
              const operationId = `cleanup_${worktree.worktreeId}`;
              repo.operation({operationId,workspaceId:root.workspaceId,kind:'cleanup_conversation',payload:{conversationId:worktree.conversationId,worktreeId:worktree.worktreeId}});
              repo.operationState(operationId,'needs_recovery');
            }
          }
        }
      } catch (error) {
        // Persist the observable fault; unrelated Workspaces still recover.
        repo.failRoot(root.workspaceId, error instanceof Error ? error.message : String(error));
      }
    }
  }
}
