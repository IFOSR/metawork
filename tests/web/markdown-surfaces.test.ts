import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { InteractionTraceEvent } from '../../web/src/api/types';
import { markdownPreview } from '../../web/src/markdown-preview';
import { collectExecutionCards, taskDagNodeDetails } from '../../web/src/task-dag';


const markdown = [
  '## 检索结论',
  '',
  '- **来源一**：`https://example.com` 已核对',
  '- [来源二](https://example.org) *待复核*',
  '',
  '```bash',
  'rg -n "价格" docs/',
  '```',
].join('\n');

function progressEvent(): InteractionTraceEvent {
  return {
    id: 'evt_1', sequence: 3, occurredAt: '2026-11-11T00:00:02.000Z',
    phase: 'execution', actor: 'executor', kind: 'executor_progress',
    title: 'Executor progress: log', summary: markdown,
    subtaskId: 'sub_1', attemptId: 'attempt_1',
    // The runtime ships the same Markdown as the node's current step.
    details: { subtaskId: 'sub_1', stepLabel: markdown },
  };
}

describe('Markdown-bearing audit surfaces', () => {
  it('renders detail, narrative and step bodies through the Markdown renderer', async () => {
    // MarkdownContent needs a DOM to sanitize, so the renderer wiring is asserted
    // at the source and the flattening behaviour at the pure helper below.
    const [drawer, narrative, step] = await Promise.all([
      readFile(new URL('../../web/src/components/ExecutionDetailDrawer.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../web/src/components/ExecutionNarrative.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../web/src/components/ExecutionStep.tsx', import.meta.url), 'utf8'),
    ]);
    expect(drawer).toContain('<MarkdownContent value={event.summary || event.title} />');
    expect(narrative).toContain('<MarkdownContent value={entry.text} />');
    expect(step).toContain('<MarkdownContent value={event.summary} />');
    // One-line previews never print the syntax.
    expect(drawer).toContain("title={markdownPreview(event.summary || event.title, 300)}");
    expect(step).toContain('markdownPreview(event.summary, 160)');
  });

  it('flattens Markdown on one-line DAG nodes instead of printing the syntax', () => {
    const cards = collectExecutionCards([progressEvent()], null, null);
    const detail = taskDagNodeDetails(cards, Date.parse('2026-11-11T00:00:03.000Z'), true).get('sub_1');
    expect(detail).toBeTruthy();
    expect(detail!.step).not.toContain('```');
    expect(detail!.step).not.toContain('##');
    expect(detail!.step).toContain('检索结论');
    expect(detail!.step).toContain('来源二');
  });

  it('flattens table cells and step previews through the shared preview helper', async () => {
    expect(markdownPreview('**粗体**与 `code`')).toBe('粗体与 code');
    expect(markdownPreview('| a | b |')).toBe('a · b');
    expect(markdownPreview('# 标题\n- 项目')).toBe('标题 项目');
    const [table, step] = await Promise.all([
      readFile(new URL('../../web/src/components/TrajectoryEventTable.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../../web/src/components/ExecutionStep.tsx', import.meta.url), 'utf8'),
    ]);
    expect(table).toContain('markdownPreview(event.summary');
    expect(step).toContain('markdownPreview(event.summary');
  });
});

describe('Health observations are not progress', () => {
  it('never lets a health event overwrite the current step of a DAG node', () => {
    const progress = {
      ...progressEvent(),
      id: 'evt_progress', sequence: 1,
      title: 'Executor progress: skill', summary: '读取工作区目录',
      details: { subtaskId: 'sub_1', stepLabel: '读取工作区目录' },
    } as InteractionTraceEvent;
    const health = {
      id: 'evt_health', sequence: 2, occurredAt: '2026-11-11T00:00:09.000Z',
      phase: 'execution', actor: 'executor', kind: 'executor_health',
      title: 'Executor health: waiting', summary: '暂无新进展（pi-model）',
      subtaskId: 'sub_1', attemptId: 'attempt_1',
      details: {
        subtaskId: 'sub_1', stepKey: 'executor_health',
        stepLabel: '暂无新进展（pi-model）',
        operationHealth: { operationId: 'pi-model', state: 'waiting', lastActivityAt: '2026-11-11T00:00:00.000Z', observedAt: '2026-11-11T00:00:09.000Z', evidence: 'No new operation activity' },
      },
    } as unknown as InteractionTraceEvent;
    const cards = collectExecutionCards([progress, health], null, null);
    expect(cards[0]!.stepLabel).toBe('读取工作区目录');
    const detail = taskDagNodeDetails(cards, Date.parse('2026-11-11T00:00:10.000Z'), true).get('sub_1');
    expect(detail!.step).toContain('读取工作区目录');
    // Health still reaches the dedicated health channel.
    expect(cards[0]!.healthText).toContain('暂无新进展');
  });
});
