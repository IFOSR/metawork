import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpgradeJournal } from '../../src/installation/upgrade-journal.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('UpgradeJournal', () => {
  it('records phase progression in order', () => {
    const journal = new UpgradeJournal('upgrade-1', '1.2.0');
    journal.mark('preflight');
    journal.mark('lock_acquired');
    journal.mark('committed');

    expect(journal.currentPhase).toBe('committed');
    expect(journal.list().map(record => record.phase)).toEqual([
      'preflight',
      'lock_acquired',
      'committed',
    ]);
  });

  it('records failure with the error message', () => {
    const journal = new UpgradeJournal('upgrade-1', '1.2.0');
    journal.mark('preflight');
    journal.fail('database migration failed');

    expect(journal.currentPhase).toBe('failed');
    expect(journal.list()[1]).toMatchObject({
      phase: 'failed',
      error: 'database migration failed',
    });
  });

  it('starts with no phase', () => {
    const journal = new UpgradeJournal('upgrade-1', '1.2.0');
    expect(journal.currentPhase).toBeNull();
    expect(journal.list()).toEqual([]);
  });

  it('persists every phase atomically and recovers after process restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'anyfusion-upgrade-journal-'));
    cleanup.push(root);
    const journalPath = join(root, 'upgrade-1.json');
    const journal = new UpgradeJournal('upgrade-1', '1.2.0', journalPath);
    journal.mark('preflight', '2026-08-14T00:00:00.000Z');
    journal.mark('database_backed_up', '2026-08-14T00:00:01.000Z');

    const recovered = new UpgradeJournal('upgrade-1', '1.2.0', journalPath);

    expect(recovered.currentPhase).toBe('database_backed_up');
    expect(recovered.list()).toEqual(journal.list());
  });
});
