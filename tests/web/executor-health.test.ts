import { describe, expect, it } from 'vitest';
import { executorHealthBadge } from '../../web/src/executor-health';

describe('executorHealthBadge', () => {
  const t0 = Date.parse('2026-09-05T01:00:00.000Z');
  const updatedAt = '2026-09-05T01:00:00.000Z';

  it('returns null for completed turns or missing timestamps', () => {
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 200_000,
      running: false,
      activityState: 'idle',
    })).toBeNull();
    expect(executorHealthBadge({
      updatedAt: null,
      nowMs: t0,
      running: true,
      activityState: 'idle',
    })).toBeNull();
  });

  it('stays quiet while activity is fresh', () => {
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 5_000,
      running: true,
      activityState: 'idle',
    })).toBeNull();
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 30_000,
      running: true,
      activityState: 'idle',
    })).toBeNull();
  });

  it('warns when the executor has been silent for 30-120s', () => {
    const badge = executorHealthBadge({
      updatedAt,
      nowMs: t0 + 45_000,
      running: true,
      activityState: 'idle',
    });
    expect(badge?.level).toBe('stale');
    expect(badge?.label).toContain('45');
    expect(badge?.label).toContain('无新活动');
  });

  it('flags a likely-lost executor after 120s of silence', () => {
    const badge = executorHealthBadge({
      updatedAt,
      nowMs: t0 + 300_000,
      running: true,
      activityState: 'idle',
    });
    expect(badge?.level).toBe('lost');
    expect(badge?.label).toContain('失联');
    expect(badge?.label).toContain('Kernel');
  });

  it('tolerates unparsable timestamps', () => {
    expect(executorHealthBadge({
      updatedAt: 'not-a-date',
      nowMs: t0,
      running: true,
      activityState: 'idle',
    })).toBeNull();
  });

  it('does not infer lost execution from an active operation or presentation heartbeat', () => {
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 300_000,
      running: true,
      activityState: 'active_operation',
    })).toBeNull();
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 300_000,
      running: true,
      activityState: 'presentation_heartbeat',
    })).toBeNull();
  });
});
