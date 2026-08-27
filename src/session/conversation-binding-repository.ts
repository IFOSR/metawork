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
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
}

export class ConversationBindingRepository {
  private mutation = Promise.resolve();

  constructor(private readonly bindingsPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.bindingsPath), { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.bindingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const normalized = normalizeBindings(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
        await this.write(normalized);
      }
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
    return (await this.resolveBinding(
      accountId,
      platform,
      channelId,
      threadId,
    ))?.conversationId ?? null;
  }

  async resolveBinding(
    accountId: string,
    platform: string,
    channelId: string,
    threadId?: string,
  ): Promise<ConversationBindingRecord | null> {
    const bindings = await this.read();
    return bindings.find(binding => sameBindingKey(binding, {
      accountId,
      platform,
      channelId,
      ...(threadId !== undefined ? { threadId } : {}),
    })) ?? null;
  }

  async set(record: ConversationBindingRecord): Promise<void> {
    await this.mutate(async () => {
      const bindings = await this.read();
      const others = bindings.filter(binding => !sameBindingKey(binding, record));
      others.push(record);
      await this.write(others);
    });
  }

  async bind(
    record: Omit<ConversationBindingRecord, 'workspaceId' | 'conversationId'> & {
      readonly workspaceId?: string | null;
      readonly conversationId: string;
    },
  ): Promise<void> {
    const existing = await this.resolveBinding(
      record.accountId,
      record.platform,
      record.channelId,
      record.threadId,
    );
    await this.set({
      ...record,
      workspaceId: record.workspaceId ?? existing?.workspaceId ?? null,
      conversationId: record.conversationId,
    });
  }

  private async read(): Promise<ConversationBindingRecord[]> {
    try {
      const raw = await readFile(this.bindingsPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return normalizeBindings(parsed);
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

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isBindingRecord(value: unknown): value is ConversationBindingRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.accountId === 'string'
    && typeof record.platform === 'string'
    && typeof record.channelId === 'string'
    && (record.threadId === undefined || typeof record.threadId === 'string')
    && (record.workspaceId === null || typeof record.workspaceId === 'string')
    && (record.conversationId === null || typeof record.conversationId === 'string');
}

function normalizeBindings(value: unknown): ConversationBindingRecord[] {
  if (!Array.isArray(value)) throw new Error('Invalid conversation bindings file');
  return value.map(item => {
    if (isBindingRecord(item)) return item;
    if (typeof item !== 'object' || item === null) {
      throw new Error('Invalid conversation bindings file');
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.accountId !== 'string'
      || typeof record.platform !== 'string'
      || typeof record.channelId !== 'string'
      || (record.threadId !== undefined && typeof record.threadId !== 'string')
      || typeof record.conversationId !== 'string'
      || record.workspaceId !== undefined
    ) {
      throw new Error('Invalid conversation bindings file');
    }
    return {
      accountId: record.accountId,
      platform: record.platform,
      channelId: record.channelId,
      ...(record.threadId !== undefined ? { threadId: record.threadId as string } : {}),
      workspaceId: null,
      conversationId: record.conversationId,
    };
  });
}

function sameBindingKey(
  left: Pick<ConversationBindingRecord, 'accountId' | 'platform' | 'channelId' | 'threadId'>,
  right: Pick<ConversationBindingRecord, 'accountId' | 'platform' | 'channelId' | 'threadId'>,
): boolean {
  return left.accountId === right.accountId
    && left.platform === right.platform
    && left.channelId === right.channelId
    && (left.threadId ?? undefined) === (right.threadId ?? undefined);
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
