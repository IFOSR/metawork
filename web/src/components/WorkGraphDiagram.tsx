import { useId, useMemo } from 'react';
import type { WorkGraphPresentationProjection } from '../api/types';
import { DAG_NODE_HEIGHT, DAG_NODE_WIDTH, layoutWorkGraph, workGraphNodeLabel } from '../work-graph-layout';

export function WorkGraphDiagram({ projection, selectedId, onSelect }: {
  projection: WorkGraphPresentationProjection;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const markerId = `dag-arrow-${useId().replace(/:/g, '')}`;
  const descriptionId = useId();
  const layout = useMemo(() => layoutWorkGraph(projection), [projection]);
  const numbers = new Map(projection.nodes.map((node, index) => [node.id, index + 1]));
  const titles = new Map(projection.nodes.map(node => [node.id, workGraphNodeLabel(node)]));
  return (
    <div className="work-graph-diagram">
      <p className="work-graph-diagram-guide" id={descriptionId}>
        {projection.nodes.length === 1 && projection.nodes[0].dependencies.length === 0
          ? '当前任务拆解为 1 个子任务，无前置依赖。'
          : '从左到右查看任务拆解：箭头由前置子任务指向依赖它的子任务，同层节点之间无前置依赖。'}
        {' '}点击节点查看详情；实际执行由调度决定。
      </p>
      <div className="work-graph-canvas-scroll" tabIndex={0} role="region" aria-label="子任务依赖图，可滚动查看" aria-describedby={descriptionId}>
        <div className="work-graph-canvas" style={{ width: layout.width, height: layout.height }}>
          <svg width={layout.width} height={layout.height} className="work-graph-connectors" aria-hidden="true">
            <defs>
              <marker id={markerId} viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {layout.edges.map(edge => (
              <path key={JSON.stringify([edge.from, edge.to])} d={edge.path} fill="none"
                className="work-graph-connector" data-related={edge.from === selectedId || edge.to === selectedId}
                markerEnd={`url(#${markerId})`}>
                <title>{`${titles.get(edge.from)} → ${titles.get(edge.to)}${edge.labels.length ? `：${edge.labels.join('；')}` : ''}`}</title>
              </path>
            ))}
          </svg>
          {layout.phases.map(({ phase, x }) => (
            <span className="work-graph-column-label" key={phase} style={{ left: x }}>依赖层级 {phase + 1}</span>
          ))}
          {layout.nodes.map(({ node, x, y }) => (
            <button key={node.id} type="button" className="work-graph-diagram-node"
              style={{ left: x, top: y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }}
              aria-pressed={node.id === selectedId}
              aria-label={`子任务 ${numbers.get(node.id)}：${workGraphNodeLabel(node)}`}
              title={workGraphNodeLabel(node)}
              data-runnable={node.runnable}
              onClick={() => onSelect(node.id)}>
              <span className="work-graph-diagram-node-meta"><span>子任务 {numbers.get(node.id)}</span>{node.runnable && <span>可调度</span>}</span>
              <strong>{workGraphNodeLabel(node)}</strong>
              <small>{node.dependencies.length ? `${node.dependencies.length} 个前置依赖` : '无前置依赖'}</small>
            </button>
          ))}
        </div>
      </div>
      {layout.missingDependencies > 0 && <p role="status">部分前置子任务信息缺失，未绘制对应连线。</p>}
      <small className="work-graph-diagram-hint">箭头表示依赖方向 · 分叉表示独立分支 · 汇合表示依赖多个上游 · 图较大时可横向或纵向滚动</small>
    </div>
  );
}
