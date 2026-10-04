import { createRequire } from 'node:module';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { WorkGraphPresentationProjection } from '../../web/src/api/types.js';
import { DAG_NODE_WIDTH, layoutWorkGraph } from '../../web/src/work-graph-layout.js';
import { WorkGraphPanel } from '../../web/src/components/WorkGraphPanel.js';

const requireFromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as {
  renderToStaticMarkup(element: ReturnType<typeof createElement>): string;
};
type Node = WorkGraphPresentationProjection['nodes'][number];
function node(id: string, phase = 0, dependencies: string[] = []): Node {
  return { id, title: `任务 ${id}`, goal: `目标 ${id}`, phase, dependencies, status: 'pending', runnable: false, requiredCapabilities: [], acceptanceCriteria: [], routing: [] };
}
function graph(nodes: Node[]): WorkGraphPresentationProjection {
  return { generationId: 'generation-1', nodes, edges: [], parallelGroups: [], currentRunnableFrontier: [] };
}

describe('inline Work Graph DAG', () => {
  it('renders an explicit single-node graph and full details with no invented edges', () => {
    const projection = graph([node('a')]);
    const layout = layoutWorkGraph(projection);
    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toEqual([]);
    const html = renderToStaticMarkup(createElement(WorkGraphPanel, { projection }));
    expect(html).toContain('当前任务拆解为 1 个子任务，无前置依赖');
    expect(html).toContain('aria-label="子任务 1：任务 a"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('目标 a');
  });

  it('lays out a diamond with parallel branches and a join, independent of input order', () => {
    const projection = graph([node('d', 2, ['b', 'c']), node('a'), node('c', 1, ['a']), node('b', 1, ['a'])]);
    const layout = layoutWorkGraph(projection);
    const positions = new Map(layout.nodes.map(value => [value.node.id, value]));
    expect(positions.get('b')!.x).toBe(positions.get('c')!.x);
    expect(positions.get('b')!.y).not.toBe(positions.get('c')!.y);
    expect(positions.get('a')!.x).toBeLessThan(positions.get('b')!.x);
    expect(positions.get('b')!.x).toBeLessThan(positions.get('d')!.x);
    expect(layout.edges.map(edge => `${edge.from}->${edge.to}`).sort()).toEqual(['a->b', 'a->c', 'b->d', 'c->d']);
    for (const position of layout.nodes) {
      expect(position.x + DAG_NODE_WIDTH).toBeLessThan(layout.width);
    }
    const html = renderToStaticMarkup(createElement(WorkGraphPanel, { projection }));
    expect(html.match(/class="work-graph-connector"/g)).toHaveLength(4);
    expect(html.match(/marker-end=/g)).toHaveLength(4);
    expect(html.match(/class="work-graph-diagram-node"/g)).toHaveLength(4);
  });

  it('draws one edge per dependency even when multiple handoff items exist', () => {
    const projection = graph([node('a'), node('b', 1, ['a', 'a'])]);
    projection.edges = [
      { from: 'a', to: 'b', kind: 'artifact', label: '研究报告' },
      { from: 'a', to: 'b', kind: 'handoff', label: '来源证据' },
    ];
    const { edges } = layoutWorkGraph(projection);
    expect(edges).toHaveLength(1);
    expect(edges[0].labels).toEqual(['研究报告', '来源证据']);
  });

  it('routes cross-layer edges around intermediate cards and retains disconnected nodes', () => {
    const layout = layoutWorkGraph(graph([
      node('a'), node('isolated'), node('b', 1, ['a']), node('c', 2, ['a', 'b']),
    ]));
    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(3);
    expect(layout.edges.find(edge => edge.from === 'a' && edge.to === 'c')?.path).toContain(' V ');
    expect(layout.edges.find(edge => edge.to === 'b')?.path).toContain(' C ');
  });

  it('does not fabricate an upstream node or edge for missing dependency facts', () => {
    const projection = graph([node('a', 1, ['missing'])]);
    expect(layoutWorkGraph(projection)).toMatchObject({ edges: [], missingDependencies: 1 });
    const html = renderToStaticMarkup(createElement(WorkGraphPanel, { projection }));
    expect(html).toContain('部分前置子任务信息缺失');
  });

  it('renders empty projections honestly instead of drawing a placeholder task', () => {
    for (const projection of [null, graph([])]) {
      const html = renderToStaticMarkup(createElement(WorkGraphPanel, { projection }));
      expect(html).toContain('暂无可展示的执行计划');
      expect(html).not.toContain('<svg');
    }
  });

  it('escapes titles and retains the full title for truncated graph nodes', () => {
    const task = node('a');
    task.title = '<script>坏标题</script>' + '很长的子任务名称'.repeat(30);
    const html = renderToStaticMarkup(createElement(WorkGraphPanel, { projection: graph([task]) }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('title="&lt;script&gt;');
    expect(html).toContain('很长的子任务名称'.repeat(30));
  });
});
