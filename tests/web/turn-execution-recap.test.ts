import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TurnExecutionRecap } from '../../web/src/components/TurnExecutionRecap';
import type { HttpClient } from '../../web/src/api/http';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};

/** Minimal HttpClient stand-in: the recap only calls getTaskWorkGraph. */
function httpStub(getTaskWorkGraph: (taskId: string) => Promise<unknown>): HttpClient {
  return { getTaskWorkGraph } as unknown as HttpClient;
}

describe('historical Turn execution record', () => {
  it('keeps the record visible and loads nothing until the reader expands it', () => {
    const getTaskWorkGraph = vi.fn(async () => null);
    const html = renderToStaticMarkup(createElement(TurnExecutionRecap, {
      taskId: 'task_old',
      http: httpStub(getTaskWorkGraph),
      statusLabel: '任务已完成',
    }));

    expect(html).toContain('执行计划与子任务');
    expect(html).toContain('任务已完成');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('展开');
    // Reopening a long conversation must not fan out one request per Turn.
    expect(getTaskWorkGraph).not.toHaveBeenCalled();
  });

  it('reads the graph of its own Task, never the conversation current Task', () => {
    // The projection is per-Turn data: the component passes exactly the taskId
    // it was given, which is how an older Turn keeps its own DAG.
    const source = TurnExecutionRecap.toString();
    expect(source).toContain('http.getTaskWorkGraph(taskId)');

    const calls: string[] = [];
    const http = httpStub(async taskId => { calls.push(taskId); return null; });
    renderToStaticMarkup(createElement(TurnExecutionRecap, {
      taskId: 'task_historical_turn',
      http,
      statusLabel: '任务已完成',
    }));
    expect(calls).toEqual([]);
  });
});
