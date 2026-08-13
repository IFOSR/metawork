// Orchestrates the transactional install/update/rollback flow. Activation never
// occurs after any blocking failure: every step is journaled, and a failure in
// any phase rolls back and returns without activating.
import { UpgradeJournal } from './upgrade-journal.js';

export interface InstallerCoreDeps {
  preflight(): Promise<void>;
  acquireUpdateLock(): Promise<boolean>;
  closeTaskAdmission(): Promise<void>;
  quiesceDispatch(): Promise<void>;
  awaitIdle(timeoutMs: number): Promise<boolean>;
  verifyManifest(): Promise<void>;
  stageRelease(): Promise<void>;
  backupDatabase(): Promise<void>;
  migrateDatabase(): Promise<void>;
  install(): Promise<void>;
  configure(): Promise<void>;
  doctor(): Promise<void>;
  activate(): Promise<void>;
  startCandidate(): Promise<void>;
  healthCheck(): Promise<void>;
  reopenAdmission(): Promise<void>;
  commitJournal(): Promise<void>;
  rollback(): Promise<void>;
  releaseUpdateLock(): Promise<void>;
}

export interface InstallTransactionResult {
  outcome: 'committed' | 'failed' | 'timeout' | 'lock_unavailable';
  error: string | null;
}

export class InstallerCore {
  constructor(private readonly deps: InstallerCoreDeps) {}

  async install(releaseId: string, upgradeId: string, timeoutMs: number): Promise<InstallTransactionResult> {
    const journal = new UpgradeJournal(upgradeId, releaseId);
    journal.mark('preflight');
    try {
      await this.deps.preflight();

      const lockHeld = await this.deps.acquireUpdateLock();
      if (!lockHeld) {
        const error = 'update lock is held by another transaction';
        journal.fail(error);
        return { outcome: 'lock_unavailable', error };
      }
      journal.mark('lock_acquired');

      try {
        await this.deps.closeTaskAdmission();
        journal.mark('admission_closed');

        await this.deps.quiesceDispatch();
        journal.mark('dispatch_quiesced');

        const idle = await this.deps.awaitIdle(timeoutMs);
        if (!idle) {
          const error = 'dispatch did not quiesce within timeout';
          journal.fail(error);
          await this.deps.rollback();
          journal.mark('rolled_back');
          return { outcome: 'timeout', error };
        }

        await this.deps.verifyManifest();
        journal.mark('manifest_verified');

        await this.deps.stageRelease();
        journal.mark('release_staged');

        await this.deps.backupDatabase();
        journal.mark('database_backed_up');

        await this.deps.migrateDatabase();
        journal.mark('database_migrated');

        await this.deps.install();
        journal.mark('installed');

        await this.deps.configure();
        journal.mark('configured');

        await this.deps.doctor();
        journal.mark('doctor_passed');

        await this.deps.activate();
        journal.mark('activated');

        await this.deps.startCandidate();
        journal.mark('candidate_started');

        await this.deps.healthCheck();
        journal.mark('health_passed');

        await this.deps.reopenAdmission();
        journal.mark('admission_reopened');

        await this.deps.commitJournal();
        journal.mark('committed');

        return { outcome: 'committed', error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        journal.fail(message);
        await this.deps.rollback();
        journal.mark('rolled_back');
        return { outcome: 'failed', error: message };
      } finally {
        await this.deps.releaseUpdateLock();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      journal.fail(message);
      return { outcome: 'failed', error: message };
    }
  }
}
