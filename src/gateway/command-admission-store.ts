import { readdir, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isValidAccountId } from '../account/account-id.js';
import type { CommandReceipt } from './command-admission.js';
import type { GatewayCommand, GatewayScope } from './client-protocol.js';

export type CommandAdmissionState = 'pending' | 'submitted' | 'terminal' | 'uncertain';

export interface StoredCommandAdmission {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly principalId?: string;
  readonly scope: GatewayScope;
  readonly command: GatewayCommand;
  readonly conversationId: string | null;
  readonly state: CommandAdmissionState;
  readonly receipt: CommandReceipt | null;
  readonly uncertaintyReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReserveCommandAdmissionInput {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly requestId: string;
  readonly connectionId: string;
  readonly principalId?: string;
  readonly scope: GatewayScope;
  readonly command: GatewayCommand;
  readonly conversationId: string | null;
  readonly now: string;
}

export interface CommandAdmissionStore {
  find(accountId: string, idempotencyKey: string): Promise<StoredCommandAdmission | null>;
  reserve(input: ReserveCommandAdmissionInput): Promise<StoredCommandAdmission>;
  assignConversation(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    conversationId: string,
    now: string,
  ): Promise<StoredCommandAdmission>;
  markSubmitted(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    now: string,
  ): Promise<StoredCommandAdmission>;
  markTerminal(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    receipt: CommandReceipt,
    now: string,
  ): Promise<StoredCommandAdmission>;
  markUncertain(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    reason: string,
    now: string,
  ): Promise<StoredCommandAdmission>;
  listRecoverable(): Promise<StoredCommandAdmission[]>;
}

export class MemoryCommandAdmissionStore implements CommandAdmissionStore {
  private readonly entries = new Map<string, StoredCommandAdmission>();
  private tail: Promise<void> = Promise.resolve();

  find(accountId: string, idempotencyKey: string): Promise<StoredCommandAdmission | null> {
    return this.serial(() => clone(this.entries.get(key(accountId, idempotencyKey)) ?? null));
  }

  reserve(input: ReserveCommandAdmissionInput): Promise<StoredCommandAdmission> {
    return this.serial(() => {
      const entryKey = key(input.accountId, input.idempotencyKey);
      const existing = this.entries.get(entryKey);
      if (existing) return clone(existing);
      const created: StoredCommandAdmission = {
        ...input,
        state: 'pending',
        receipt: null,
        uncertaintyReason: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      this.entries.set(entryKey, created);
      return clone(created);
    });
  }

  assignConversation(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    conversationId: string,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => {
      if (current.conversationId) return current;
      return { ...current, conversationId, updatedAt: now };
    });
  }

  markSubmitted(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current
        : { ...current, state: 'submitted', uncertaintyReason: null, updatedAt: now }
    ));
  }

  markTerminal(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    receipt: CommandReceipt,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current
        : {
            ...current,
            state: 'terminal',
            receipt,
            uncertaintyReason: null,
            updatedAt: now,
          }
    ));
  }

  markUncertain(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    reason: string,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current
        : {
            ...current,
            state: 'uncertain',
            uncertaintyReason: reason,
            updatedAt: now,
          }
    ));
  }

  listRecoverable(): Promise<StoredCommandAdmission[]> {
    return this.serial(() => [...this.entries.values()]
      .filter(entry => entry.state !== 'terminal')
      .map(clone));
  }

  private transition(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    update: (current: StoredCommandAdmission) => StoredCommandAdmission,
  ): Promise<StoredCommandAdmission> {
    return this.serial(() => {
      const entryKey = key(accountId, idempotencyKey);
      const current = this.entries.get(entryKey);
      if (!current) throw new Error('command admission is not reserved');
      assertFingerprint(current, fingerprint);
      const updated = update(current);
      this.entries.set(entryKey, updated);
      return clone(updated);
    });
  }

  private serial<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

interface CommandAdmissionFile {
  readonly version: 2;
  readonly admissions: StoredCommandAdmission[];
}

interface LegacyStoredCommandAdmission {
  readonly accountId: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly requestId: string;
  readonly principalId?: string;
  readonly conversation: object;
  readonly command: GatewayCommand;
  readonly conversationId: string | null;
  readonly state: CommandAdmissionState;
  readonly receipt: CommandReceipt | null;
  readonly uncertaintyReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface LegacyCommandAdmissionFile {
  readonly version: 1;
  readonly admissions: LegacyStoredCommandAdmission[];
}

const fileTails = new Map<string, Promise<void>>();

export class FileCommandAdmissionStore implements CommandAdmissionStore {
  constructor(private readonly rootDir: string) {}

  find(accountId: string, idempotencyKey: string): Promise<StoredCommandAdmission | null> {
    return this.serial(accountId, async () => {
      const file = await this.read(accountId);
      return clone(file.admissions.find(item => item.idempotencyKey === idempotencyKey) ?? null);
    });
  }

  reserve(input: ReserveCommandAdmissionInput): Promise<StoredCommandAdmission> {
    return this.serial(input.accountId, async () => {
      const file = await this.read(input.accountId);
      const existing = file.admissions.find(item => item.idempotencyKey === input.idempotencyKey);
      if (existing) return clone(existing);
      const created: StoredCommandAdmission = {
        ...input,
        state: 'pending',
        receipt: null,
        uncertaintyReason: null,
        createdAt: input.now,
        updatedAt: input.now,
      };
      file.admissions.push(created);
      await this.write(input.accountId, file);
      return clone(created);
    });
  }

  assignConversation(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    conversationId: string,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => {
      if (current.conversationId) return current;
      return { ...current, conversationId, updatedAt: now };
    });
  }

  markSubmitted(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current
        : { ...current, state: 'submitted', uncertaintyReason: null, updatedAt: now }
    ));
  }

  markTerminal(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    receipt: CommandReceipt,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current
        : {
            ...current,
            state: 'terminal',
            receipt,
            uncertaintyReason: null,
            updatedAt: now,
          }
    ));
  }

  markUncertain(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    reason: string,
    now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current
        : {
            ...current,
            state: 'uncertain',
            uncertaintyReason: reason,
            updatedAt: now,
          }
    ));
  }

  async listRecoverable(): Promise<StoredCommandAdmission[]> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const accountIds = names
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length))
      .filter(isValidAccountId);
    const records = await Promise.all(accountIds.map(accountId => (
      this.serial(accountId, async () => {
        const file = await this.read(accountId);
        return file.admissions.filter(item => item.state !== 'terminal').map(clone);
      })
    )));
    return records.flat().sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.accountId.localeCompare(right.accountId)
      || left.idempotencyKey.localeCompare(right.idempotencyKey)
    ));
  }

  private transition(
    accountId: string,
    idempotencyKey: string,
    fingerprint: string,
    update: (current: StoredCommandAdmission) => StoredCommandAdmission,
  ): Promise<StoredCommandAdmission> {
    return this.serial(accountId, async () => {
      const file = await this.read(accountId);
      const index = file.admissions.findIndex(item => item.idempotencyKey === idempotencyKey);
      if (index < 0) throw new Error('command admission is not reserved');
      const current = file.admissions[index]!;
      assertFingerprint(current, fingerprint);
      const updated = update(current);
      file.admissions[index] = updated;
      await this.write(accountId, file);
      return clone(updated);
    });
  }

  private serial<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const path = this.path(accountId);
    const previous = fileTails.get(path) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    fileTails.set(path, settled);
    void settled.then(() => {
      if (fileTails.get(path) === settled) fileTails.delete(path);
    });
    return result;
  }

  private path(accountId: string): string {
    if (!isValidAccountId(accountId)) throw new Error(`Invalid account id: ${accountId}`);
    const root = resolve(this.rootDir);
    const path = resolve(root, `${accountId}.json`);
    if (dirname(path) !== root) {
      throw new Error(`Invalid command admission path: ${accountId}`);
    }
    return path;
  }

  private async read(accountId: string): Promise<CommandAdmissionFile> {
    try {
      const raw = await readFile(this.path(accountId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isCommandAdmissionFile(parsed, accountId)) {
        return parsed;
      }
      if (isLegacyCommandAdmissionFile(parsed, accountId)) {
        const migrated = migrateLegacyCommandAdmissionFile(parsed, accountId);
        await this.write(accountId, migrated);
        return migrated;
      }
      throw new Error(`Invalid command admission file: ${accountId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, admissions: [] };
      }
      throw error;
    }
  }

  private async write(accountId: string, file: CommandAdmissionFile): Promise<void> {
    const path = this.path(accountId);
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

function assertFingerprint(admission: StoredCommandAdmission, fingerprint: string): void {
  if (admission.fingerprint !== fingerprint) {
    throw new Error('command admission fingerprint conflict');
  }
}

function isCommandAdmissionFile(value: unknown, accountId: string): value is CommandAdmissionFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<CommandAdmissionFile>;
  return file.version === 2
    && Array.isArray(file.admissions)
    && file.admissions.every(item => isStoredCommandAdmission(item, accountId));
}

function isLegacyCommandAdmissionFile(
  value: unknown,
  accountId: string,
): value is LegacyCommandAdmissionFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<LegacyCommandAdmissionFile>;
  return file.version === 1
    && Array.isArray(file.admissions)
    && file.admissions.every(item => isLegacyStoredCommandAdmission(item, accountId));
}

function isLegacyStoredCommandAdmission(value: unknown, accountId: string): value is LegacyStoredCommandAdmission {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<LegacyStoredCommandAdmission>;
  return item.accountId === accountId
    && typeof item.idempotencyKey === 'string'
    && typeof item.fingerprint === 'string'
    && typeof item.requestId === 'string'
    && typeof item.conversation === 'object'
    && item.conversation !== null
    && typeof item.command === 'object'
    && item.command !== null
    && (item.conversationId === null || typeof item.conversationId === 'string')
    && ['pending', 'submitted', 'terminal', 'uncertain'].includes(String(item.state))
    && (item.receipt === null || typeof item.receipt === 'object')
    && (item.uncertaintyReason === null || typeof item.uncertaintyReason === 'string')
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}

function migrateLegacyCommandAdmissionFile(
  file: LegacyCommandAdmissionFile,
  accountId: string,
): CommandAdmissionFile {
  if (file.admissions.some(item => item.state !== 'terminal')) {
    throw new Error(`Unsafe nonterminal v1 command admission file: ${accountId}`);
  }
  if (file.admissions.some(item => !item.conversationId)) {
    throw new Error(`Unsafe v1 command admission without Conversation identity: ${accountId}`);
  }
  return {
    version: 2,
    admissions: file.admissions.map(item => ({
      accountId: item.accountId,
      idempotencyKey: item.idempotencyKey,
      fingerprint: item.fingerprint,
      requestId: item.requestId,
      connectionId: `legacy-${item.requestId}`,
      ...(item.principalId !== undefined ? { principalId: item.principalId } : {}),
      scope: {
        kind: 'conversation',
        selection: { mode: 'attach', conversationId: item.conversationId! },
      },
      command: item.command,
      conversationId: item.conversationId,
      state: item.state,
      receipt: item.receipt,
      uncertaintyReason: item.uncertaintyReason,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}

function isStoredCommandAdmission(value: unknown, accountId: string): value is StoredCommandAdmission {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<StoredCommandAdmission>;
  return item.accountId === accountId
    && typeof item.idempotencyKey === 'string'
    && typeof item.fingerprint === 'string'
    && typeof item.requestId === 'string'
    && typeof item.connectionId === 'string'
    && typeof item.scope === 'object'
    && item.scope !== null
    && typeof item.command === 'object'
    && item.command !== null
    && (item.conversationId === null || typeof item.conversationId === 'string')
    && ['pending', 'submitted', 'terminal', 'uncertain'].includes(String(item.state))
    && (item.receipt === null || typeof item.receipt === 'object')
    && (item.uncertaintyReason === null || typeof item.uncertaintyReason === 'string')
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}

function key(accountId: string, idempotencyKey: string): string {
  return `${accountId}\0${idempotencyKey}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
