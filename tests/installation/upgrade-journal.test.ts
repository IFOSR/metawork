import { describe, expect, it } from 'vitest';
import { UpgradeJournal } from '../../src/installation/upgrade-journal.js';

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
});
