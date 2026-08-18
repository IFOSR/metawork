/**
 * Gateway 文件事件日志（ADR-0031 第 8、9 节）。
 *
 * 每 Conversation 一个版本化 JSON 文件，原子写入、单调 sequence、重复
 * eventId 幂等、有界保留。账户/会话 ID 经校验防止路径穿越。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isValidAccountId } from '../account/account-id.js';
import { isValidConversationId } from '../session/conversation-types.js';
import {
  isTerminalGatewayEvent,
  type GatewayEventEnvelope,
  type GatewayReplay,
} from './client-events.js';
import type { EventJournal } from './event-journal.js';

interface JournalFile {
  readonly version: 1;
  lastSequence: number;
  events: GatewayEventEnvelope[];
}

const MAX_EVENTS_PER_CONVERSATION = 200;

export class FileEventJournal implements EventJournal {
  constructor(private readonly rootDir: string) {}

  async append(event: GatewayEventEnvelope): Promise<void> {
    const file = await this.read(event.accountId, event.conversationId);
    if (file.events.some(existing => existing.eventId === event.eventId)) return;

    const sequence = file.lastSequence + 1;
    file.events.push({ ...event, sequence });
    if (file.events.length > MAX_EVENTS_PER_CONVERSATION) {
      file.events = file.events.slice(-MAX_EVENTS_PER_CONVERSATION);
    }
    file.lastSequence = sequence;
    await this.write(file, event.accountId, event.conversationId);
  }

  async replay(
    accountId: string,
    conversationId: string,
    afterSequence = 0,
  ): Promise<GatewayReplay> {
    const file = await this.read(accountId, conversationId);
    const deltas = file.events.filter(event => event.sequence > afterSequence);
    const snapshot = file.events.filter(event => isTerminalGatewayEvent(event.kind));
    return { lastSequence: file.lastSequence, snapshot, deltas };
  }

  private path(accountId: string, conversationId: string): string {
    if (!isValidAccountId(accountId)) throw new Error(`Invalid account id: ${accountId}`);
    if (!isValidConversationId(conversationId)) throw new Error(`Invalid conversation id: ${conversationId}`);
    const path = resolve(this.rootDir, accountId, `${conversationId}.json`);
    if (!path.startsWith(resolve(this.rootDir))) {
      throw new Error(`Invalid journal path: ${accountId}/${conversationId}`);
    }
    return path;
  }

  private async read(accountId: string, conversationId: string): Promise<JournalFile> {
    try {
      const raw = await readFile(this.path(accountId, conversationId), 'utf8');
      const parsed = JSON.parse(raw) as Partial<JournalFile>;
      if (parsed.version !== 1
        || typeof parsed.lastSequence !== 'number'
        || !Array.isArray(parsed.events)) {
        throw new Error(`Invalid journal file: ${accountId}/${conversationId}`);
      }
      return {
        version: 1,
        lastSequence: parsed.lastSequence,
        events: parsed.events as GatewayEventEnvelope[],
      };
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, lastSequence: 0, events: [] };
      throw error;
    }
  }

  private async write(
    file: JournalFile,
    accountId: string,
    conversationId: string,
  ): Promise<void> {
    const path = this.path(accountId, conversationId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(file, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await rename(temporaryPath, path);
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
