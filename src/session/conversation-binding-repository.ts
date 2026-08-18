/**
 * Conversation 平台绑定仓库（ADR-0031 第 6、7 节）。
 *
 * 把某个平台聊天/线程映射到账户内的稳定 Conversation。绑定键是
 * `accountId + platform + channelId + threadId`，账户维度不可跨越：一个账户
 * 的绑定绝不能被另一个账户解析。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ConversationBindingRecord {
  readonly accountId: string;
  readonly platform: string;
  readonly channelId: string;
  readonly threadId?: string;
  readonly conversationId: string;
}

export class ConversationBindingRepository {
  constructor(private readonly bindingsPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.bindingsPath), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.bindingsPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        await this.write([]);
        return;
      }
      throw error;
    }
  }

  async resolve(
    accountId: string,
    platform: string,
    channelId: string,
    threadId?: string,
  ): Promise<string | null> {
    const bindings = await this.read();
    const found = bindings.find(binding => (
      binding.accountId === accountId
      && binding.platform === platform
      && binding.channelId === channelId
      && (binding.threadId ?? undefined) === threadId
    ));
    return found?.conversationId ?? null;
  }

  async bind(record: ConversationBindingRecord): Promise<void> {
    const bindings = await this.read();
    const key = (binding: ConversationBindingRecord) => (
      `${binding.accountId}\u0000${binding.platform}\u0000${binding.channelId}\u0000${binding.threadId ?? ''}`
    );
    const others = bindings.filter(binding => key(binding) !== key(record));
    others.push(record);
    await this.write(others);
  }

  private async read(): Promise<ConversationBindingRecord[]> {
    try {
      const raw = await readFile(this.bindingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isBindingRecord)) {
        throw new Error('Invalid conversation bindings file');
      }
      return parsed as ConversationBindingRecord[];
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  private async write(bindings: ConversationBindingRecord[]): Promise<void> {
    await mkdir(dirname(this.bindingsPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.bindingsPath}.tmp-${process.pid}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(bindings, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, this.bindingsPath);
  }
}

function isBindingRecord(value: unknown): value is ConversationBindingRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.accountId === 'string'
    && typeof record.platform === 'string'
    && typeof record.channelId === 'string'
    && (record.threadId === undefined || typeof record.threadId === 'string')
    && typeof record.conversationId === 'string';
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
