import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { InstallerCore, type InstallerCoreDeps } from '../../src/installation/installer-core.js';

function makeDeps(overrides: {
  lockHeld?: boolean;
  idle?: boolean;
  failAt?: keyof InstallerCoreDeps;
} = {}): { deps: InstallerCoreDeps; calls: string[] } {
  const calls: string[] = [];
  const step = async (name: string) => {
    calls.push(name);
    if (overrides.failAt === name) throw new Error(`blocking failure at ${name}`);
  };
  const deps: InstallerCoreDeps = {
    preflight: () => step('preflight'),
    acquireUpdateLock: vi.fn(async () => { calls.push('acquireUpdateLock'); return overrides.lockHeld ?? true; }),
    closeTaskAdmission: () => step('closeTaskAdmission'),
    quiesceDispatch: () => step('quiesceDispatch'),
    awaitIdle: vi.fn(async () => { calls.push('awaitIdle'); return overrides.idle ?? true; }),
    verifyManifest: () => step('verifyManifest'),
    stageRelease: () => step('stageRelease'),
    backupDatabase: () => step('backupDatabase'),
    migrateDatabase: () => step('migrateDatabase'),
    install: () => step('install'),
    configure: () => step('configure'),
    doctor: () => step('doctor'),
    activate: () => step('activate'),
    startCandidate: () => step('startCandidate'),
    healthCheck: () => step('healthCheck'),
    reopenAdmission: () => step('reopenAdmission'),
    commitJournal: () => step('commitJournal'),
    rollback: () => step('rollback'),
    releaseUpdateLock: () => step('releaseUpdateLock'),
  };
  return { deps, calls };
}

describe('InstallerCore', () => {
  it('commits the full transaction in order', async () => {
    const { deps, calls } = makeDeps();
    const result = await new InstallerCore(deps).install('1.2.0', 'upgrade-1', 5_000);

    expect(result.outcome).toBe('committed');
    expect(calls).toEqual([
      'preflight',
      'acquireUpdateLock',
      'closeTaskAdmission',
      'quiesceDispatch',
      'awaitIdle',
      'verifyManifest',
      'stageRelease',
      'backupDatabase',
      'migrateDatabase',
      'install',
      'configure',
      'doctor',
      'activate',
      'startCandidate',
      'healthCheck',
      'reopenAdmission',
      'commitJournal',
      'releaseUpdateLock',
    ]);
  });

  it('never activates after a blocking failure before activation', async () => {
    const preActivationPhases: Array<keyof InstallerCoreDeps> = [
      'verifyManifest',
      'stageRelease',
      'backupDatabase',
      'migrateDatabase',
      'install',
      'configure',
      'doctor',
    ];
    for (const failAt of preActivationPhases) {
      const { deps, calls } = makeDeps({ failAt });
      const result = await new InstallerCore(deps).install('1.2.0', `upgrade-${failAt}`, 5_000);

      expect(result.outcome).toBe('failed');
      expect(calls).toContain('rollback');
      expect(calls).not.toContain('activate');
    }
  });

  it('rolls back when activation or later health checks fail', async () => {
    for (const failAt of ['activate', 'startCandidate', 'healthCheck'] as const) {
      const { deps, calls } = makeDeps({ failAt });
      const result = await new InstallerCore(deps).install('1.2.0', `upgrade-${failAt}`, 5_000);

      expect(result.outcome).toBe('failed');
      expect(calls).toContain('rollback');
    }
  });

  it('aborts on idle timeout without activating', async () => {
    const { deps, calls } = makeDeps({ idle: false });
    const result = await new InstallerCore(deps).install('1.2.0', 'upgrade-timeout', 5_000);

    expect(result.outcome).toBe('timeout');
    expect(calls).toContain('rollback');
    expect(calls).not.toContain('activate');
  });

  it('returns lock_unavailable when the update lock is held', async () => {
    const { deps, calls } = makeDeps({ lockHeld: false });
    const result = await new InstallerCore(deps).install('1.2.0', 'upgrade-lock', 5_000);

    expect(result.outcome).toBe('lock_unavailable');
    expect(calls).not.toContain('activate');
    expect(calls).not.toContain('rollback');
  });

  it('releases the lock on success and failure', async () => {
    for (const failAt of [undefined, 'healthCheck'] as const) {
      const { deps, calls } = makeDeps(failAt ? { failAt } : {});
      await new InstallerCore(deps).install('1.2.0', 'upgrade-release', 5_000);
      expect(calls).toContain('releaseUpdateLock');
    }
  });

  it('persists transaction progress to the configured journal path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-installer-core-journal-'));
    try {
      const journalPath = join(root, 'upgrade-1.json');
      const { deps } = makeDeps();

      await new InstallerCore(deps, { journalPath })
        .install('1.2.0', 'upgrade-1', 5_000);

      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        records: Array<{ phase: string }>;
      };
      expect(journal.records.at(-1)?.phase).toBe('committed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
