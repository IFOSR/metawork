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

  it('warns when the executor has been silent for 60-300s', () => {
    const badge = executorHealthBadge({
      updatedAt,
      nowMs: t0 + 90_000,
      running: true,
      activityState: 'idle',
    });
    expect(badge?.level).toBe('stale');
    expect(badge?.label).toContain('90');
    expect(badge?.label).toContain('无新活动');
  });

  it('flags a likely-lost executor after 300s of silence', () => {
    const badge = executorHealthBadge({
      updatedAt,
      nowMs: t0 + 360_000,
      running: true,
      activityState: 'idle',
    });
    expect(badge?.level).toBe('lost');
    expect(badge?.label).toContain('待确认');
    expect(badge?.label).not.toContain('Kernel 正在恢复');
  });

  it('tolerates unparsable timestamps', () => {
    expect(executorHealthBadge({
      updatedAt: 'not-a-date',
      nowMs: t0,
      running: true,
      activityState: 'idle',
    })).toBeNull();
  });

  it('shows uncertainty even if presentation heartbeats continue', () => {
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 360_000,
      running: true,
      activityState: 'active_operation',
    })).toMatchObject({ level: 'lost' });
    expect(executorHealthBadge({
      updatedAt,
      nowMs: t0 + 360_000,
      running: true,
      activityState: 'presentation_heartbeat',
    })).toMatchObject({ level: 'lost' });
  });
});
