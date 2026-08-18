/**
 * 账户元数据文件仓库（ADR-0031 第 9 节）。
 *
 * 每个账户在 `accounts/<account-id>/account.json` 保存一份版本化元数据记录。
 * 原子写入（临时文件 + rename），账户 ID 必须通过校验。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isValidAccountId } from './account-id.js';

export interface AccountRecord {
  readonly accountId: string;
  readonly schemaVersion: number;
  readonly migratedAt: string | null;
}

const ACCOUNT_RECORD_SCHEMA_VERSION = 1;

export class FileAccountRepository {
  constructor(private readonly accountsRoot: string) {}

  accountJsonPath(accountId: string): string {
    if (!isValidAccountId(accountId)) {
      throw new Error(`invalid account id: ${accountId}`);
    }
    return join(this.accountsRoot, accountId, 'account.json');
  }

  async load(accountId: string): Promise<AccountRecord | null> {
    try {
      const raw = await readFile(this.accountJsonPath(accountId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<AccountRecord>;
      if (
        parsed.accountId !== accountId
        || parsed.schemaVersion !== ACCOUNT_RECORD_SCHEMA_VERSION
        || (parsed.migratedAt !== null && typeof parsed.migratedAt !== 'string')
      ) {
        return null;
      }
      return {
        accountId: parsed.accountId,
        schemaVersion: parsed.schemaVersion,
        migratedAt: parsed.migratedAt,
      };
    } catch {
      return null;
    }
  }

  async save(record: AccountRecord): Promise<void> {
    const path = this.accountJsonPath(record.accountId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({
        accountId: record.accountId,
        schemaVersion: ACCOUNT_RECORD_SCHEMA_VERSION,
        migratedAt: record.migratedAt,
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, path);
  }
}
