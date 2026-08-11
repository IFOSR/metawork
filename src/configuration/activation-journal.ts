import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ActivationJournalIdentity {
  transactionId: string;
  previousRevisionId: string | null;
  nextRevisionId: string;
}

export type ActivationJournalRecord = ActivationJournalIdentity & {
  schemaVersion: 1;
  phase: 'prepared' | 'committed';
};

export class ActivationJournalStore {
  constructor(readonly path: string) {}

  async read(): Promise<ActivationJournalRecord | null> {
    const source = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (source === null) return null;

    const value = JSON.parse(source) as Partial<ActivationJournalRecord>;
    if (
      value.schemaVersion !== 1
      || !['prepared', 'committed'].includes(value.phase ?? '')
      || typeof value.transactionId !== 'string'
      || (value.previousRevisionId !== null && typeof value.previousRevisionId !== 'string')
      || typeof value.nextRevisionId !== 'string'
    ) {
      throw new Error('invalid configuration activation journal');
    }
    return value as ActivationJournalRecord;
  }

  async writePrepared(identity: ActivationJournalIdentity): Promise<void> {
    await this.write({ ...identity, schemaVersion: 1, phase: 'prepared' });
  }

  async writeCommitted(identity: ActivationJournalIdentity): Promise<void> {
    await this.write({ ...identity, schemaVersion: 1, phase: 'committed' });
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
    await syncDirectory(dirname(this.path));
  }

  private async write(record: ActivationJournalRecord): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await syncFile(temporaryPath);
    await rename(temporaryPath, this.path);
    await syncDirectory(directory);
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
