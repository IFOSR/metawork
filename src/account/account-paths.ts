/**
 * 账户作用域路径解析（ADR-0031 第 9 节）。
 *
 * 账户数据物理隔离：每个账户在 `accounts/<account-id>/` 下拥有独立的配置、
 * 密钥、生成运行时、SQLite、Planner 会话、Conversation、workspace、attempt
 * 与 gateway 目录。发布/应用文件保持安装全局。
 *
 * 账户 ID 必须通过校验，任何路径穿越都会在此抛错，从而阻止账户根目录逃逸。
 */

import { resolve } from 'node:path';
import { resolveAnyFusionPaths } from '../installation/paths.js';
import { isValidAccountId } from './account-id.js';

export interface AccountPaths {
  readonly root: string;
  readonly accountJson: string;
  readonly config: string;
  readonly configActive: string;
  readonly configRevisions: string;
  readonly secrets: string;
  readonly generated: string;
  readonly data: string;
  readonly database: string;
  readonly plannerSessions: string;
  readonly conversations: string;
  readonly workspaceStore: string;
  readonly attempts: string;
  readonly gateway: string;
}

export function resolveAccountPaths(accountId: string, installRoot?: string): AccountPaths {
  if (!isValidAccountId(accountId)) {
    throw new Error(`invalid account id: ${accountId}`);
  }
  const paths = installRoot !== undefined
    ? resolveAnyFusionPaths(undefined, installRoot)
    : resolveAnyFusionPaths();
  const root = resolve(paths.accountsRoot, accountId);
  const config = resolve(root, 'config');
  const data = resolve(root, 'data');
  const planner = resolve(root, 'planner');
  return {
    root,
    accountJson: resolve(root, 'account.json'),
    config,
    configActive: resolve(config, 'active'),
    configRevisions: resolve(config, 'revisions'),
    secrets: resolve(root, 'secrets'),
    generated: resolve(root, 'generated'),
    data,
    database: resolve(data, 'anyfusion.db'),
    plannerSessions: resolve(planner, 'sessions'),
    conversations: resolve(root, 'conversations'),
    workspaceStore: resolve(root, 'workspace-store'),
    attempts: resolve(root, 'attempts'),
    gateway: resolve(root, 'gateway'),
  };
}
