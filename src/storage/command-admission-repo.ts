import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { isValidAccountId } from '../account/account-id.js';
import type { CommandReceipt } from '../gateway/command-admission.js';
import {
  isImportableCommandAdmission,
  isStoredCommandAdmission,
  type CommandAdmissionLegacySource,
  type CommandAdmissionStore,
  type ReserveCommandAdmissionInput,
  type StoredCommandAdmission,
} from '../gateway/command-admission-store.js';

interface AdmissionRow {
  idempotency_key: string;
  state: string;
  body_json: string;
}

/** Account-bound durable adapter for the Gateway admission contract. */
export class SqliteCommandAdmissionStore implements CommandAdmissionStore {
  private initialized = false;
  private initialization: Promise<void> | null = null;

  constructor(private readonly db: Database.Database, private readonly accountId: string) {
    if (!isValidAccountId(accountId)) throw new Error(`Invalid account id: ${accountId}`);
  }

  async initialize(legacy: CommandAdmissionLegacySource): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    const operation = this.importLegacy(legacy);
    this.initialization = operation;
    try {
      await operation;
      this.initialized = true;
    } finally {
      this.initialization = null;
    }
  }

  async find(accountId: string, idempotencyKey: string): Promise<StoredCommandAdmission | null> {
    this.assertInitialized();
    if (!isValidAccountId(accountId)) throw new Error(`Invalid account id: ${accountId}`);
    if (accountId !== this.accountId) return null;
    return this.read(idempotencyKey);
  }

  async reserve(input: ReserveCommandAdmissionInput): Promise<StoredCommandAdmission> {
    this.assertAccount(input.accountId);
    return this.db.transaction(() => {
      const existing = this.read(input.idempotencyKey);
      // Fingerprint conflicts are returned to Gateway, exactly as in the file adapter.
      if (existing) return existing;
      const created: StoredCommandAdmission = {
        ...input, state: 'pending', receipt: null, uncertaintyReason: null,
        createdAt: input.now, updatedAt: input.now,
      };
      this.db.prepare(`INSERT INTO gateway_command_admissions
        (account_id, idempotency_key, state, body_json) VALUES (?, ?, ?, ?)`)
        .run(this.accountId, created.idempotencyKey, created.state, JSON.stringify(created));
      return structuredClone(created);
    }).immediate();
  }

  assignConversation(
    accountId: string, idempotencyKey: string, fingerprint: string, conversationId: string, now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.conversationId ? current : { ...current, conversationId, updatedAt: now }
    ));
  }

  markSubmitted(
    accountId: string, idempotencyKey: string, fingerprint: string, now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current : { ...current, state: 'submitted', uncertaintyReason: null, updatedAt: now }
    ));
  }

  markTerminal(
    accountId: string, idempotencyKey: string, fingerprint: string, receipt: CommandReceipt, now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current : { ...current, state: 'terminal', receipt, uncertaintyReason: null, updatedAt: now }
    ));
  }

  markUncertain(
    accountId: string, idempotencyKey: string, fingerprint: string, reason: string, now: string,
  ): Promise<StoredCommandAdmission> {
    return this.transition(accountId, idempotencyKey, fingerprint, current => (
      current.state === 'terminal'
        ? current : { ...current, state: 'uncertain', uncertaintyReason: reason, updatedAt: now }
    ));
  }

  async listRecoverable(): Promise<StoredCommandAdmission[]> {
    this.assertInitialized();
    const rows = this.db.prepare(`SELECT idempotency_key, state, body_json FROM gateway_command_admissions
      WHERE account_id = ? AND state != 'terminal'`).all(this.accountId) as AdmissionRow[];
    // Preserve the file adapter's locale ordering, but only hydrate recovery candidates.
    return rows.map(row => this.decode(row)).sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.accountId.localeCompare(right.accountId)
      || left.idempotencyKey.localeCompare(right.idempotencyKey)
    ));
  }

  private async importLegacy(legacy: CommandAdmissionLegacySource): Promise<void> {
    if (this.hasImported()) return;
    const admissions = await legacy.exportRetained(this.accountId);
    this.db.transaction(() => {
      // Another initialized adapter may have committed while the file was read.
      if (this.hasImported()) return;
      const retained = new Map<string, StoredCommandAdmission>();
      for (const admission of admissions) {
        if (!isImportableCommandAdmission(admission, this.accountId)) {
          throw new Error(`Invalid command admission import: ${this.accountId}`);
        }
        const previous = retained.get(admission.idempotencyKey);
        if (previous && !isDeepStrictEqual(previous, admission)) {
          throw new Error('command admission import conflict');
        }
        retained.set(admission.idempotencyKey, admission);
      }
      const insert = this.db.prepare(`INSERT INTO gateway_command_admissions
        (account_id, idempotency_key, state, body_json) VALUES (?, ?, ?, ?)`);
      for (const admission of retained.values()) {
        const existing = this.read(admission.idempotencyKey);
        if (existing) {
          if (!isDeepStrictEqual(existing, admission)) throw new Error('command admission import conflict');
        } else {
          insert.run(this.accountId, admission.idempotencyKey, admission.state, JSON.stringify(admission));
        }
      }
      this.db.prepare('INSERT INTO gateway_command_admission_imports (account_id) VALUES (?)').run(this.accountId);
    }).immediate();
  }

  private hasImported(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM gateway_command_admission_imports WHERE account_id = ?').get(this.accountId));
  }

  private read(idempotencyKey: string): StoredCommandAdmission | null {
    const row = this.db.prepare(`SELECT idempotency_key, state, body_json FROM gateway_command_admissions
      WHERE account_id = ? AND idempotency_key = ?`).get(this.accountId, idempotencyKey) as AdmissionRow | undefined;
    return row ? this.decode(row) : null;
  }

  private decode(row: AdmissionRow): StoredCommandAdmission {
    const admission: unknown = JSON.parse(row.body_json);
    if (!isStoredCommandAdmission(admission, this.accountId)
      || admission.idempotencyKey !== row.idempotency_key || admission.state !== row.state) {
      throw new Error(`Invalid command admission record: ${this.accountId}/${row.idempotency_key}`);
    }
    return admission;
  }

  private async transition(
    accountId: string, idempotencyKey: string, fingerprint: string,
    update: (current: StoredCommandAdmission) => StoredCommandAdmission,
  ): Promise<StoredCommandAdmission> {
    this.assertAccount(accountId);
    return this.db.transaction(() => {
      const current = this.read(idempotencyKey);
      if (!current) throw new Error('command admission is not reserved');
      if (current.fingerprint !== fingerprint) throw new Error('command admission fingerprint conflict');
      const updated = update(current);
      if (updated !== current) {
        this.db.prepare(`UPDATE gateway_command_admissions SET state = ?, body_json = ?
          WHERE account_id = ? AND idempotency_key = ?`)
          .run(updated.state, JSON.stringify(updated), this.accountId, idempotencyKey);
      }
      return structuredClone(updated);
    }).immediate();
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('command admission store is not initialized');
  }

  private assertAccount(accountId: string): void {
    this.assertInitialized();
    if (accountId !== this.accountId) throw new Error(`Invalid command admission account: ${accountId}`);
  }
}
