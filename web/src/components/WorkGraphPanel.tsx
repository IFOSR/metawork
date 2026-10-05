import { useState } from 'react';
import type { WorkGraphPresentationProjection } from '../api/types';
import { workGraphNodeLabel } from '../work-graph-layout';
import { RoutingDecisionCard } from './RoutingDecisionCard';
import { WorkGraphDiagram } from './WorkGraphDiagram';

export function WorkGraphPanel({ projection }: { projection: WorkGraphPresentationProjection | null }) {
  const [selection, setSelection] = useState<{ generationId: string | null; id: string } | null>(null);
  if (!projection || projection.nodes.length === 0) {
    return <section className="work-graph-panel work-graph-empty">当前任务暂无可展示的执行计划。</section>;
  }
  const selected = (selection?.generationId === projection.generationId
    ? projection.nodes.find(node => node.id === selection?.id)
    : undefined) ?? projection.nodes[0];
  const titleById = new Map(projection.nodes.map(node => [node.id, workGraphNodeLabel(node)]));
  const downstream = projection.nodes.filter(node => node.dependencies.includes(selected.id));
  const handoffs = projection.edges.filter(edge => edge.from === selected.id || edge.to === selected.id);
  const parallelGroups = [...new Set(projection.nodes.map(node => node.phase))]
    .map(phase => ({ phase, nodes: projection.nodes.filter(node => node.phase === phase) }))
    .filter(group => group.nodes.length > 1);

  return (
    <section className="work-graph-panel" aria-label="Work Graph">
      <header className="work-graph-header">
        <div>
          <span className="eyebrow">DAG / ROUTING</span>
          <h2>执行计划</h2>
        </div>
        <div className="work-graph-meta">
          <span>{projection.nodes.length} 个子任务</span>
          <span>{projection.currentRunnableFrontier.length} 个可调度</span>
          {parallelGroups.map(group => <span key={group.phase}>阶段 {group.phase + 1} 可并行 {group.nodes.length} 项</span>)}
        </div>
      </header>
      <WorkGraphDiagram projection={projection} selectedId={selected.id}
        onSelect={id => setSelection({ generationId: projection.generationId, id })} />
      <div className="work-graph-selected-detail" role="region" aria-label="选中子任务详情">
        <span className="eyebrow">子任务 {projection.nodes.indexOf(selected) + 1} · 详情</span>
        <WorkGraphNode node={selected} titleById={titleById} />
        <div className="work-graph-relations">
          <p><strong>前置依赖：</strong>{selected.dependencies.map(id => titleById.get(id) ?? '信息缺失的上游子任务').join('、') || '无前置子任务'}</p>
          <p><strong>后续子任务：</strong>{downstream.map(workGraphNodeLabel).join('、') || '无，此分支的末端子任务'}</p>
        </div>
        {handoffs.length > 0 && (
          <div className="work-graph-edges">
            <span className="eyebrow">依赖与交接内容</span>
            {handoffs.map((edge, index) => (
              <div className="work-graph-edge" key={index}>
                <strong>{titleById.get(edge.from) ?? '上游子任务'}</strong>
                <span>→</span>
                <strong>{titleById.get(edge.to) ?? '下游子任务'}</strong>
                <small>{edge.kind === 'artifact' ? '产物' : edge.kind === 'handoff' ? '交接' : '依赖'} · {edge.label}</small>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function WorkGraphNode({
  node,
  titleById,
}: {
  node: WorkGraphPresentationProjection['nodes'][number];
  titleById: ReadonlyMap<string, string>;
}) {
  return (
    <article className="work-graph-node" data-status={node.status} data-runnable={node.runnable}>
      <div className="work-graph-node-topline">
        <strong>{workGraphNodeLabel(node)}</strong>
        <span>{node.runnable ? '可调度' : node.status}</span>
      </div>
      <p>{node.goal}</p>
      <div className="work-graph-tags">
        {node.requiredCapabilities.map(capability => <span key={capability}>{capability}</span>)}
      </div>
      {node.dependencies.length > 0 && (
        <small className="work-graph-dependencies">
          依赖：{node.dependencies.map(id => titleById.get(id) ?? '上游子任务').join('、')}
        </small>
      )}
      {node.routing.length > 0 && (
        <div className="work-graph-routing">
          {node.routing.map(routing => (
            <RoutingDecisionCard
              key={`${routing.executorDisplayName}:${routing.selected?.modelDisplayName ?? 'pending'}`}
              routing={routing}
            />
          ))}
        </div>
      )}
    </article>
  );
}
