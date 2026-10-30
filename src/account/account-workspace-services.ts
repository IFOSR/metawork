import { ServiceWorktreeService } from '../execution/service-worktree-service.js';
/**
 * 账户级 workspace/permission 服务簇（ADR-0031 第 2、9 节）。
 *
 * workspaceStore 的根目录由调用方传入：AccountRuntime 用账户作用域根
 * `accounts/<id>/`，MetaclawSession 默认用安装全局根（向后兼容）。
 */

import { dirname } from 'node:path';
import { WorkspaceGitService } from '../execution/workspace-git-service.js';
import { ConversationWorktreeService } from '../execution/conversation-worktree-service.js';
import { WorkspaceGitRepo } from '../storage/workspace-git-repo.js';
import { WorkspaceMergeWorker } from '../execution/workspace-merge-worker.js';
import type Database from 'better-sqlite3';
import { WorkspaceStore } from '../execution/workspace-store.js';
import { WorkspaceRetentionService } from '../execution/workspace-retention-service.js';
import { SqlitePermissionRepository } from '../storage/permission-repo.js';
import { SqliteAttemptExecutionRepository } from '../storage/attempt-execution-backend-repo.js';
import { SqliteWorkspaceRepository } from '../storage/workspace-repo.js';

export interface AccountWorkspaceServices {
  readonly serviceWorktrees: ServiceWorktreeService;
  readonly conversationWorktrees: ConversationWorktreeService;
  readonly workspaceMergeWorker: WorkspaceMergeWorker;
  readonly workspaceGitRepo: WorkspaceGitRepo;
  readonly permissionRepository: SqlitePermissionRepository;
  readonly attemptExecutionRepository: SqliteAttemptExecutionRepository;
  readonly workspaceRepository: SqliteWorkspaceRepository;
  readonly workspaceStore: WorkspaceStore;
  readonly workspaceRetentionService: WorkspaceRetentionService;
}

export function buildAccountWorkspaceServices(
  db: Database.Database,
  workspaceStoreRoot: string,
): AccountWorkspaceServices {
  const workspaceGitRepo = new WorkspaceGitRepo(db);
  const workspaceGit = new WorkspaceGitService({ internalRoot: dirname(workspaceStoreRoot) });
  const serviceWorktrees = new ServiceWorktreeService(workspaceGit,workspaceGitRepo);
  const conversationWorktrees = new ConversationWorktreeService(workspaceGit, workspaceGitRepo);
  const workspaceMergeWorker = new WorkspaceMergeWorker(workspaceGit, workspaceGitRepo);
  const permissionRepository = new SqlitePermissionRepository(db);
  const attemptExecutionRepository = new SqliteAttemptExecutionRepository(db);
  const workspaceRepository = new SqliteWorkspaceRepository(db);
  // The account root already ends in `workspace-store`; a second identical
  // segment only lengthened every managed workspace path.
  const workspaceStore = new WorkspaceStore(workspaceStoreRoot);
  const workspaceRetentionService = new WorkspaceRetentionService(workspaceRepository, workspaceStore);

  return {
    serviceWorktrees, conversationWorktrees, workspaceMergeWorker, workspaceGitRepo,
    permissionRepository,
    attemptExecutionRepository,
    workspaceRepository,
    workspaceStore,
    workspaceRetentionService,
  };
}
