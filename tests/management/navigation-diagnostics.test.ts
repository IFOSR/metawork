import { describe, expect, it } from 'vitest';
import {
  collectNavigationDiagnostics,
  measureNavigationStage,
  measureNavigationStageSync,
} from '../../src/utils/navigation-diagnostics.js';

describe('navigation diagnostics', () => {
  it('isolates concurrent requests and records counts without request contents', async () => {
    const [left, right] = await Promise.all([
      collectNavigationDiagnostics(async () => {
        await measureNavigationStage('catalog_read', async () => 'private user input', 97);
        return measureNavigationStageSync('activity_projection', () => 1, 10);
      }),
      collectNavigationDiagnostics(() => measureNavigationStage('journal_replay', async () => 2, 5)),
    ]);
    expect(left.result).toBe(1);
    expect(left.stages.catalog_read).toMatchObject({ calls: 1, items: 97 });
    expect(left.stages.activity_projection).toMatchObject({ calls: 1, items: 10 });
    expect(left.stages.journal_replay).toBeUndefined();
    expect(right.stages.journal_replay).toMatchObject({ calls: 1, items: 5 });
    expect(JSON.stringify(left.stages)).not.toContain('private user input');
  });

  it('preserves exceptions and does not require an active diagnostic scope', async () => {
    await expect(measureNavigationStage('catalog_read', async () => {
      throw new Error('read failed');
    })).rejects.toThrow('read failed');
    expect(measureNavigationStageSync('activity_projection', () => 42)).toBe(42);
  });
});
