import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../web/src/components/', import.meta.url);

describe('Trajectory view', () => {
  it('projects shared turn data into summary, phase timeline, filters, and event rows', async () => {
    const [view, summary, timeline, table, styles] = await Promise.all([
      readFile(new URL('TrajectoryView.tsx', root), 'utf8'),
      readFile(new URL('TrajectorySummary.tsx', root), 'utf8'),
      readFile(new URL('TrajectoryTimeline.tsx', root), 'utf8'),
      readFile(new URL('TrajectoryEventTable.tsx', root), 'utf8'),
      readFile(new URL('../styles.css', root), 'utf8'),
    ]);

    expect(view).toContain('<TrajectorySummary');
    expect(view).toContain('<TrajectoryTimeline');
    expect(view).toContain('<TrajectoryEventTable');
    expect(summary).toContain('工具调用');
    expect(summary).toContain('Executor 尝试');
    expect(timeline).toContain('occurredAt');
    expect(table).toContain('actorFilter');
    expect(table).toContain('statusFilter');
    expect(table).toContain('phaseFilter');
    expect(table).toContain('<details');
    expect(styles).toContain('--surface-trajectory-panel');
    expect(styles).toContain('--surface-trajectory-control');
    expect(styles).toContain('--surface-trajectory-header');
    expect(styles).toContain('--surface-trajectory-detail');
    expect(styles).toMatch(/\.trajectory-summary\s*\{[^}]*background: var\(--surface-trajectory-panel\);/u);
    expect(styles).toMatch(/\.trajectory-band\s*\{[^}]*background: var\(--surface-trajectory-panel\);/u);
    expect(styles).toMatch(/\.trajectory-filters input,[^{]+select\s*\{[^}]*background: var\(--surface-trajectory-control\);/u);
    expect(styles).toMatch(/\.trajectory-head\s*\{[^}]*background: var\(--surface-trajectory-header\);/u);
  });
});
