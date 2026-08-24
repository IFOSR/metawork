import type { WorkGraphPresentationProjection } from '../api/types';
import { RoutingDecisionCard } from './RoutingDecisionCard';

export function WorkGraphPanel({ projection }: { projection: WorkGraphPresentationProjection | null }) {
  if (!projection) {
    return <section className="work-graph-panel work-graph-empty">当前任务暂无可展示的 Work Graph。</section>;
  }

  const grouped = new Map<number, WorkGraphPresentationProjection['nodes']>();
  for (const node of projection.nodes) {
    const bucket = grouped.get(node.phase) ?? [];
    bucket.push(node);
    grouped.set(node.phase, bucket);
  }

  return (
    <section className="work-graph-panel" aria-label="Work Graph">
      <header className="work-graph-header">
        <div>
          <span className="eyebrow">DAG / ROUTING</span>
          <h2>执行计划</h2>
        </div>
        <div className="work-graph-meta">
          <span>{projection.nodes.length} subtasks</span>
          <span>frontier {projection.currentRunnableFrontier.length}</span>
          <code>{projection.configurationRevision}</code>
        </div>
      </header>
      <div className="work-graph-desktop">
        {[...grouped.entries()].sort(([a], [b]) => a - b).map(([phase, nodes]) => (
          <div className="work-graph-phase" key={phase}>
            <div className="work-graph-phase-label">PHASE {phase + 1}</div>
            <div className="work-graph-phase-nodes">
              {nodes.map(node => <WorkGraphNode key={node.id} node={node} />)}
            </div>
          </div>
        ))}
      </div>
      <div className="work-graph-mobile">
        {projection.parallelGroups.map((group, index) => (
          <div className="work-graph-mobile-stage" key={index}>
            <div className="work-graph-phase-label">并行阶段 {index + 1}</div>
            {group.map(id => {
              const node = projection.nodes.find(candidate => candidate.id === id);
              return node ? <WorkGraphNode key={node.id} node={node} /> : null;
            })}
          </div>
        ))}
      </div>
      {projection.edges.length > 0 && (
        <div className="work-graph-edges">
          <span className="eyebrow">HANDOFFS</span>
          {projection.edges.map(edge => (
            <div className="work-graph-edge" key={`${edge.from}-${edge.to}-${edge.label}`}>
              <code>{edge.from}</code><span>→</span><code>{edge.to}</code>
              <small>{edge.kind} · {edge.label}</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkGraphNode({ node }: { node: WorkGraphPresentationProjection['nodes'][number] }) {
  return (
    <article className="work-graph-node" data-status={node.status} data-runnable={node.runnable}>
      <div className="work-graph-node-topline">
        <strong>{node.title}</strong>
        <span>{node.runnable ? 'RUNNABLE' : node.status}</span>
      </div>
      <p>{node.goal}</p>
      <div className="work-graph-tags">
        {node.requiredCapabilities.map(capability => <span key={capability}>{capability}</span>)}
      </div>
      {node.dependencies.length > 0 && (
        <small className="work-graph-dependencies">等待：{node.dependencies.join(', ')}</small>
      )}
      {node.routing.length > 0 && (
        <div className="work-graph-routing">
          {node.routing.map(routing => (
            <RoutingDecisionCard
              key={`${routing.agentClassRef}:${routing.modelRef ?? 'pending'}`}
              routing={routing}
            />
          ))}
        </div>
      )}
    </article>
  );
}
