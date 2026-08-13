import { describe, expect, it } from 'vitest';
import { parseInstallArgs, runInstall } from '../../src/installation/install-cli.js';
import type { InstallerCoreDeps } from '../../src/installation/installer-core.js';

function fakeDeps(calls: string[]): InstallerCoreDeps {
  const step = async (name: string) => { calls.push(name); };
  return {
    preflight: () => step('preflight'),
    acquireUpdateLock: async () => { calls.push('acquireUpdateLock'); return true; },
    closeTaskAdmission: () => step('closeTaskAdmission'),
    quiesceDispatch: () => step('quiesceDispatch'),
    awaitIdle: async () => { calls.push('awaitIdle'); return true; },
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
}

describe('install-cli', () => {
  it('parses install, update, and rollback commands', () => {
    expect(parseInstallArgs(['install', '1.2.0'])).toMatchObject({ command: 'install', releaseId: '1.2.0' });
    expect(parseInstallArgs(['update', '1.2.1'])).toMatchObject({ command: 'update', releaseId: '1.2.1' });
    expect(parseInstallArgs(['rollback', '1.1.9'])).toMatchObject({ command: 'rollback', releaseId: '1.1.9' });
  });

  it('rejects unknown commands and missing release ids', () => {
    expect(parseInstallArgs(['status'])).toBeNull();
    expect(parseInstallArgs(['install'])).toBeNull();
    expect(parseInstallArgs([])).toBeNull();
  });

  it('drives InstallerCore through the full transaction', async () => {
    const calls: string[] = [];
    const result = await runInstall(
      { command: 'update', releaseId: '1.2.1', timeoutMs: 1_000 },
      fakeDeps(calls),
    );

    expect(result.outcome).toBe('committed');
    expect(calls).toContain('activate');
    expect(calls).toContain('commitJournal');
    expect(calls).toContain('releaseUpdateLock');
  });
});
