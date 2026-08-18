import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export type ReleasePointerName =
  | 'database'
  | 'configuration'
  | 'generated'
  | 'application';

const SWITCH_ORDER: readonly ReleasePointerName[] = [
  'database',
  'configuration',
  'generated',
  'application',
];

export class ReleasePointerTransaction {
  constructor(private readonly dependencies: {
    paths: Record<ReleasePointerName, string>;
    journalPath?: string;
    afterSwitch?: (name: ReleasePointerName) => Promise<void>;
    healthCheck(): Promise<void>;
  }) {}

  async activate(
    candidateTargets: Record<ReleasePointerName, string>,
  ): Promise<void> {
    const previousTargets = await readTargets(this.dependencies.paths);
    const switched: ReleasePointerName[] = [];
    await this.writeJournal({
      schemaVersion: 1,
      phase: 'prepared',
      paths: this.dependencies.paths,
      previousTargets,
      candidateTargets,
    });
    try {
      for (const name of SWITCH_ORDER) {
        await replaceSymlink(this.dependencies.paths[name], candidateTargets[name]);
        switched.push(name);
        await this.dependencies.afterSwitch?.(name);
      }
      await this.dependencies.healthCheck();
      await this.writeJournal({
        schemaVersion: 1,
        phase: 'committed',
        paths: this.dependencies.paths,
        previousTargets,
        candidateTargets,
      });
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const name of switched.reverse()) {
        try {
          await replaceSymlink(this.dependencies.paths[name], previousTargets[name]);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'candidate activation failed and pointer rollback was incomplete',
        );
      }
      await this.clearJournal();
      throw error;
    }
  }

  async recover(): Promise<
    { status: 'none' | 'healthy' | 'rolled_back' }
  > {
    const journal = await this.readJournal();
    if (!journal) return { status: 'none' };
    assertSamePaths(journal.paths, this.dependencies.paths);
    if (journal.phase === 'prepared') {
      for (const name of SWITCH_ORDER) {
        await replaceSymlink(this.dependencies.paths[name], journal.previousTargets[name]);
      }
      await this.clearJournal();
      return { status: 'rolled_back' };
    }
    const current = await readTargets(this.dependencies.paths);
    for (const name of SWITCH_ORDER) {
      if (current[name] !== journal.candidateTargets[name]) {
        throw new Error(`committed activation journal does not match ${name} pointer`);
      }
    }
    return { status: 'healthy' };
  }

  private async writeJournal(journal: ReleaseActivationJournal): Promise<void> {
    if (!this.dependencies.journalPath) return;
    const path = this.dependencies.journalPath;
    const parent = dirname(path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    const handle = await open(temporary, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(parent);
  }

  private async readJournal(): Promise<ReleaseActivationJournal | null> {
    if (!this.dependencies.journalPath) return null;
    const present = await readFile(this.dependencies.journalPath, 'utf8')
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    if (present === null) return null;
    return readReleaseActivationJournal(this.dependencies.journalPath);
  }

  private async clearJournal(): Promise<void> {
    if (this.dependencies.journalPath) {
      await rm(this.dependencies.journalPath, { force: true });
    }
  }
}

export interface ReleaseActivationJournal {
  schemaVersion: 1;
  phase: 'prepared' | 'committed';
  paths: Record<ReleasePointerName, string>;
  previousTargets: Record<ReleasePointerName, string>;
  candidateTargets: Record<ReleasePointerName, string>;
}

export async function recoverPreparedReleaseActivations(
  journalDirectory: string,
  paths: Record<ReleasePointerName, string>,
): Promise<{ recoveredJournalPath: string | null }> {
  const names = await readdir(journalDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const prepared: string[] = [];
  for (const name of names.filter(name => name.endsWith('-activation.json')).sort()) {
    const journalPath = `${journalDirectory}/${name}`;
    const journal = await readReleaseActivationJournal(journalPath);
    if (journal.phase === 'prepared') prepared.push(journalPath);
  }
  if (prepared.length > 1) {
    throw new Error(
      `multiple prepared release activation journals require manual recovery: ${prepared.join(', ')}`,
    );
  }
  const journalPath = prepared[0];
  if (!journalPath) return { recoveredJournalPath: null };
  await new ReleasePointerTransaction({
    paths,
    journalPath,
    healthCheck: async () => undefined,
  }).recover();
  return { recoveredJournalPath: journalPath };
}

export async function readReleaseActivationJournal(
  path: string,
): Promise<ReleaseActivationJournal> {
  const value = JSON.parse(await readFile(path, 'utf8')) as ReleaseActivationJournal;
  if (
    value.schemaVersion !== 1
    || (value.phase !== 'prepared' && value.phase !== 'committed')
  ) {
    throw new Error('invalid release activation journal');
  }
  return value;
}

async function readTargets(
  paths: Record<ReleasePointerName, string>,
): Promise<Record<ReleasePointerName, string>> {
  const entries = await Promise.all(
    SWITCH_ORDER.map(async name => [name, await readlink(paths[name])] as const),
  );
  return Object.fromEntries(entries) as Record<ReleasePointerName, string>;
}

async function replaceSymlink(path: string, target: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.next-${randomUUID()}`;
  await symlink(target, temporary);
  try {
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
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

function assertSamePaths(
  journalPaths: Record<ReleasePointerName, string>,
  currentPaths: Record<ReleasePointerName, string>,
): void {
  for (const name of SWITCH_ORDER) {
    if (journalPaths[name] !== currentPaths[name]) {
      throw new Error(`release activation journal path mismatch: ${name}`);
    }
  }
}
