// Durable upgrade journal for the native installer. Each install/update/rollback
// transaction records its phase progression so a crash can be resumed or rolled
// back without guessing which files or database pointers were already switched.
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
  private readonly records: UpgradeJournalRecord[] = [];

  constructor(
    private readonly upgradeId: string,
    private readonly releaseId: string,
  ) {}

  mark(phase: InstallPhase, updatedAt = new Date().toISOString()): void {
    this.records.push({
      upgradeId: this.upgradeId,
      releaseId: this.releaseId,
      phase,
      error: null,
      updatedAt,
    });
  }

  fail(error: string, updatedAt = new Date().toISOString()): void {
    this.records.push({
      upgradeId: this.upgradeId,
      releaseId: this.releaseId,
      phase: 'failed',
      error,
      updatedAt,
    });
  }

  get currentPhase(): InstallPhase | null {
    return this.records.length > 0 ? this.records[this.records.length - 1]!.phase : null;
  }

  list(): readonly UpgradeJournalRecord[] {
    return this.records;
  }
}
