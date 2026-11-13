import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { TrajectorySummary } from '../../web/src/components/TrajectorySummary';
import { TrajectoryView } from '../../web/src/components/TrajectoryView';
import type { ConversationTurnProjection } from '../../web/src/api/session-types';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

const root = new URL('../../web/src/components/', import.meta.url);

describe('Trajectory view', () => {
  it('keeps the trajectory to its DAG, timeline and events without a task-card summary', () => {
    const event = { id: 'old', sequence: 1, occurredAt: '2026-11-11T00:00:00Z',
      phase: 'execution', actor: 'executor', kind: 'executor_progress',
      title: 'Executor progress: skill', summary: '', subtaskId: 'sub', details: {} };
    const turn = { id: 'turn', sessionId: 'conv', status: 'completed', taskId: 'task', artifacts: [],
      traceEvents: [event], executionTimeline: { taskId: 'task', status: 'succeeded', stages: [
        { phase: 'execution', status: 'completed', subtasks: [{ id: 'sub', title: 'Analysis', status: 'done', attempts: [] }] },
      ] } } as unknown as ConversationTurnProjection;
    const html = renderToStaticMarkup(createElement(TrajectoryView, { turn }));
    // The retired card panel must not appear; the event table still shows the fact.
    expect(html).not.toContain('live-execution-panel');
    expect(html).not.toContain('EXECUTION SUMMARY');
    expect(html).toContain('Executor progress: skill');
  });
  it('projects shared turn data into summary, phase timeline, filters, and event rows', async () => {
    const [view, summary, timeline, table, styles] = await Promise.all([
      readFile(new URL('TrajectoryView.tsx', root), 'utf8'),
      readFile(new URL('TrajectorySummary.tsx', root), 'utf8'),
      readFile(new URL('TrajectoryTimeline.tsx', root), 'utf8'),
      readFile(new URL('TrajectoryEventTable.tsx', root), 'utf8'),
      readFile(new URL('../styles.css', root), 'utf8'),
    ]);

    expect(view).toContain('<TrajectorySummary');
    expect(view).toContain('<ExecutionNarrative');
    expect(view).toContain('<TrajectoryTimeline');
    expect(view).toContain('<TrajectoryEventTable');
    expect(view).toContain('onLoadMore={onLoadMore}');
    expect(summary).toContain('工具调用');
    expect(summary).toContain('Executor 尝试');
    expect(timeline).toContain('occurredAt');
    expect(table).toContain('actorFilter');
    expect(table).toContain('phaseFilter');
    // Trace events carry no status, so the table has no status filter or column.
    expect(table).not.toContain('statusFilter');
    expect(table).toContain('<details');
    expect(table).toContain('trajectory-pagination');
    expect(table).toContain('加载更多轨迹');
    expect(styles).toContain('--surface-trajectory-panel');
    expect(styles).toContain('--surface-trajectory-control');
    expect(styles).toContain('--surface-trajectory-header');
    expect(styles).toContain('--surface-trajectory-detail');
    expect(styles).toMatch(/\.trajectory-summary\s*\{[^}]*background: var\(--surface-trajectory-panel\);/u);
    expect(styles).toMatch(/\.trajectory-band\s*\{[^}]*background: var\(--surface-trajectory-panel\);/u);
    expect(styles).toMatch(/\.trajectory-filters input,[^{]+select\s*\{[^}]*background: var\(--surface-trajectory-control\);/u);
    expect(styles).toMatch(/\.trajectory-head\s*\{[^}]*background: var\(--surface-trajectory-header\);/u);
    expect(styles).toMatch(/\.trajectory-table\s*\{[^}]*max-height: min\(58vh, 680px\);/u);
    expect(styles).toMatch(/\.trajectory-head\s*\{[^}]*position: sticky;/u);
  });
});

describe('Trajectory summary durations', () => {
  function render(turn: Partial<ConversationTurnProjection>): string {
    return renderToStaticMarkup(createElement(TrajectorySummary, {
      turn: {
        id: 'turn_1', sessionId: 'session_1', userInput: '', status: 'completed',
        startedAt: '2026-10-28T06:34:22.485Z', completedAt: '2026-10-28T06:34:34.272Z',
        taskId: null, traceEvents: [], executionTimeline: null, artifacts: [],
        deliveryStatus: null, finalAnswer: null,
        ...turn,
      } as unknown as ConversationTurnProjection,
    }));
  }

  it('reports no measured execution duration instead of 0s', () => {
    const html = render({});
    expect(html).toContain('暂无耗时');
    expect(html).not.toContain('>0.0s<');
  });

  it('names the planning-only conclusion instead of a completed Task', () => {
    expect(render({})).toContain('已完成规划，未启动执行');
  });
});
