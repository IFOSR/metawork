/**
 * 账户级 workspace/permission 服务簇（ADR-0031 第 2、9 节）。
 *
 * workspaceStore 的根目录由调用方传入：AccountRuntime 用账户作用域根
 * `accounts/<id>/`，MetaclawSession 默认用安装全局根（向后兼容）。
 */

import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { WorkspaceStore } from '../execution/workspace-store.js';
import { WorkspaceRetentionService } from '../execution/workspace-retention-service.js';
import { SqlitePermissionRepository } from '../storage/permission-repo.js';
import { SqliteAttemptExecutionRepository } from '../storage/attempt-execution-backend-repo.js';
import { SqliteWorkspaceRepository } from '../storage/workspace-repo.js';

export interface AccountWorkspaceServices {
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
  const permissionRepository = new SqlitePermissionRepository(db);
  const attemptExecutionRepository = new SqliteAttemptExecutionRepository(db);
  const workspaceRepository = new SqliteWorkspaceRepository(db);
  const workspaceStore = new WorkspaceStore(resolve(workspaceStoreRoot, 'workspace-store'));
  const workspaceRetentionService = new WorkspaceRetentionService(workspaceRepository, workspaceStore);

  return {
    permissionRepository,
    attemptExecutionRepository,
    workspaceRepository,
    workspaceStore,
    workspaceRetentionService,
  };
}
