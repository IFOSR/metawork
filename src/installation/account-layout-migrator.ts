/**
 * 账户布局迁移器（ADR-0031 第 9 节）。
 *
 * 把 legacy 安装全局状态（数据库、Planner 会话、workspace、attempt、配置、
 * 密钥、生成运行时）复制进 `accounts/<account-id>/`，并通过 account.json
 * 原子激活账户元数据。迁移遵循 ADR-0030 的验证规则：
 *
 * 1. 幂等：已迁移账户直接返回；
 * 2. 验证 legacy 数据库 SQLite 完整性；
 * 3. 复制到账户目录并做文件哈希 + SQLite 完整性二次验证；
 * 4. 原子写入账户元数据作为激活标记；
 * 5. legacy 状态保留（作为回滚依据），不做双写。
 */

import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { FileAccountRepository } from '../account/file-account-repository.js';
import { LOCAL_DEFAULT_ACCOUNT_ID } from '../account/account-id.js';
import { resolveAccountPaths } from '../account/account-paths.js';
import type { AnyFusionPaths } from './paths.js';

export interface AccountLayoutMigrationResult {
  readonly outcome: 'migrated' | 'already_migrated';
  readonly accountId: string;
}

export class AccountLayoutMigrator {
  private readonly accountId: string;
  private readonly now: () => string;

  constructor(private readonly deps: {
    paths: AnyFusionPaths;
    accountId?: string;
    now?: () => string;
  }) {
    this.accountId = deps.accountId ?? LOCAL_DEFAULT_ACCOUNT_ID;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async migrate(): Promise<AccountLayoutMigrationResult> {
    const paths = this.deps.paths;
    const accountPaths = resolveAccountPaths(this.accountId, paths.root);
    const repository = new FileAccountRepository(paths.accountsRoot);

    const existing = await repository.load(this.accountId);
    if (existing?.migratedAt) {
      return { outcome: 'already_migrated', accountId: this.accountId };
    }

    await this.assertLegacyDatabaseIntegrity(paths.database);
    await this.ensureAccountDirectories(accountPaths);

    if (await this.pathExists(paths.database)) {
      await cp(paths.database, accountPaths.database, { dereference: true, preserveTimestamps: true });
      await this.assertFileHash(paths.database, accountPaths.database);
      this.assertSqliteIntegrity(accountPaths.database);
    }

    await this.copyDirectoryIfExists(paths.plannerSessions, accountPaths.plannerSessions);
    await this.copyDirectoryIfExists(paths.executionWorkspaces, accountPaths.workspaceStore);
    await this.copyDirectoryIfExists(paths.attempts, accountPaths.attempts);
    await this.copyDirectoryIfExists(dirname(paths.configurationRevisions), accountPaths.config);
    await this.copyDirectoryIfExists(paths.secrets, accountPaths.secrets);
    await this.copyDirectoryIfExists(dirname(paths.generatedAgentRuntime), accountPaths.generated);

    await repository.save({
      accountId: this.accountId,
      schemaVersion: 1,
      migratedAt: this.now(),
    });

    return { outcome: 'migrated', accountId: this.accountId };
  }

  private async ensureAccountDirectories(
    accountPaths: ReturnType<typeof resolveAccountPaths>,
  ): Promise<void> {
    for (const dir of [
      accountPaths.root,
      accountPaths.config,
      accountPaths.data,
      accountPaths.secrets,
      accountPaths.generated,
      accountPaths.plannerSessions,
      accountPaths.conversations,
      accountPaths.workspaceStore,
      accountPaths.attempts,
      accountPaths.gateway,
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
  }

  private async copyDirectoryIfExists(source: string, target: string): Promise<void> {
    if (!(await this.pathExists(source))) return;
    await cp(source, target, { recursive: true, preserveTimestamps: true });
  }

  private async assertLegacyDatabaseIntegrity(databasePath: string): Promise<void> {
    if (!(await this.pathExists(databasePath))) return;
    this.assertSqliteIntegrity(databasePath);
  }

  private assertSqliteIntegrity(path: string): void {
    const db = new Database(path, { readonly: true });
    try {
      const result = db.pragma('integrity_check', { simple: true });
      if (result !== 'ok') {
        throw new Error(`sqlite integrity check failed for ${basename(path)}: ${String(result)}`);
      }
    } finally {
      db.close();
    }
  }

  private async assertFileHash(source: string, target: string): Promise<void> {
    const sourceHash = await hashFile(source);
    const targetHash = await hashFile(target);
    if (sourceHash !== targetHash) {
      throw new Error(`file hash mismatch after copy: ${basename(source)}`);
    }
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function hashFile(path: string): Promise<string> {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}
