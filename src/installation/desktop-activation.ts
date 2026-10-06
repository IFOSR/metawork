import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DesktopActivationRecord {
  schemaVersion: 1;
  phase: 'prepared' | 'runtime-updated' | 'shell-replaced' | 'committed' | 'rolled-back';
  previousReleaseId: string;
  candidateReleaseId: string;
  applicationPath: string;
  stagedApplicationPath: string;
  backupApplicationPath: string;
}
export interface DesktopActivationPort {
  verify(): Promise<void>;
  stop(): Promise<void>;
  updateRuntime(): Promise<void>;
  replaceShell(): Promise<void>;
  startAndVerifyCandidate(): Promise<void>;
  restoreRuntime(): Promise<void>;
  restoreShell(): Promise<void>;
  startPrevious(): Promise<void>;
}

/** Shell coordination around the native updater; no database or pointer mutation here. */
export class DesktopActivation {
  constructor(private readonly journalPath: string, private readonly port: DesktopActivationPort) {}
  async apply(input: Omit<DesktopActivationRecord, 'schemaVersion' | 'phase'>): Promise<void> {
    const existing = await this.read();
    if (existing && existing.phase !== 'committed' && existing.phase !== 'rolled-back') {
      throw new Error('An unfinished desktop activation requires recovery');
    }
    await this.port.verify();
    let record: DesktopActivationRecord = { ...input, schemaVersion: 1, phase: 'prepared' };
    await this.write(record);
    try {
      await this.port.stop();
      await this.port.updateRuntime();
      record = { ...record, phase: 'runtime-updated' }; await this.write(record);
      await this.port.replaceShell();
      record = { ...record, phase: 'shell-replaced' }; await this.write(record);
      await this.port.startAndVerifyCandidate();
      await this.write({ ...record, phase: 'committed' });
    } catch (error) {
      await this.recover();
      throw error;
    }
  }
  async recover(): Promise<void> {
    const record = await this.read();
    if (!record || record.phase === 'committed' || record.phase === 'rolled-back') return;
    await this.port.stop();
    // The native updater verifies database/journal companions before changing any pointer.
    // A failed prerequisite leaves this record and the shell intact for an explicit retry.
    await this.port.restoreRuntime();
    await this.port.restoreShell();
    await this.port.startPrevious();
    await this.write({ ...record, phase: 'rolled-back' });
  }
  async read(): Promise<DesktopActivationRecord | null> {
    const raw = await readFile(this.journalPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    if (raw === null) return null;
    const value = JSON.parse(raw) as DesktopActivationRecord;
    if (value.schemaVersion !== 1 || !['prepared', 'runtime-updated', 'shell-replaced', 'committed', 'rolled-back'].includes(value.phase)
      || ![value.previousReleaseId, value.candidateReleaseId, value.applicationPath, value.stagedApplicationPath,
        value.backupApplicationPath].every(field => typeof field === 'string' && field.length > 0 && field.length < 4096)) throw new Error('Invalid activation journal');
    return value;
  }
  private async write(record: DesktopActivationRecord): Promise<void> {
    await mkdir(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.journalPath}.tmp`;
    const handle = await open(temporary, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.journalPath);
    const directory = await open(dirname(this.journalPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
