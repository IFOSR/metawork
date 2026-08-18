// Durable upgrade journal for the native installer. Each install/update/rollback
// transaction records its phase progression so a crash can be resumed or rolled
// back without guessing which files or database pointers were already switched.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
export type InstallPhase =
  | 'preflight'
  | 'lock_acquired'
  | 'admission_closed'
  | 'dispatch_quiesced'
  | 'manifest_verified'
  | 'release_staged'
  | 'database_backed_up'
  | 'database_migrated'
  | 'installed'
  | 'configured'
  | 'doctor_passed'
  | 'activated'
  | 'candidate_started'
  | 'health_passed'
  | 'admission_reopened'
  | 'committed'
  | 'failed'
  | 'rolled_back';

export interface UpgradeJournalRecord {
  upgradeId: string;
  releaseId: string;
  phase: InstallPhase;
  error: string | null;
  updatedAt: string;
}

export class UpgradeJournal {
  private readonly records: UpgradeJournalRecord[];

  constructor(
    private readonly upgradeId: string,
    private readonly releaseId: string,
    private readonly journalPath?: string,
  ) {
    this.records = journalPath ? loadRecords(journalPath, upgradeId, releaseId) : [];
  }

  mark(phase: InstallPhase, updatedAt = new Date().toISOString()): void {
    this.records.push({
      upgradeId: this.upgradeId,
      releaseId: this.releaseId,
      phase,
      error: null,
      updatedAt,
    });
    this.persist();
  }

  fail(error: string, updatedAt = new Date().toISOString()): void {
    this.records.push({
      upgradeId: this.upgradeId,
      releaseId: this.releaseId,
      phase: 'failed',
      error,
      updatedAt,
    });
    this.persist();
  }

  get currentPhase(): InstallPhase | null {
    return this.records.length > 0 ? this.records[this.records.length - 1]!.phase : null;
  }

  list(): readonly UpgradeJournalRecord[] {
    return this.records.map(record => ({ ...record }));
  }

  private persist(): void {
    if (!this.journalPath) return;
    const parent = dirname(this.journalPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.journalPath}.tmp-${process.pid}`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ schemaVersion: 1, records: this.records }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const file = openSync(temporaryPath, 'r');
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporaryPath, this.journalPath);
    const directory = openSync(parent, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}

function loadRecords(
  journalPath: string,
  upgradeId: string,
  releaseId: string,
): UpgradeJournalRecord[] {
  if (!existsSync(journalPath)) return [];
  const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    schemaVersion?: unknown;
    records?: unknown;
  };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
    throw new Error('invalid upgrade journal');
  }
  return parsed.records.map(value => {
    const record = value as Partial<UpgradeJournalRecord>;
    if (
      record.upgradeId !== upgradeId
      || record.releaseId !== releaseId
      || typeof record.phase !== 'string'
      || (record.error !== null && typeof record.error !== 'string')
      || typeof record.updatedAt !== 'string'
    ) {
      throw new Error('upgrade journal identity or record is invalid');
    }
    return record as UpgradeJournalRecord;
  });
}
