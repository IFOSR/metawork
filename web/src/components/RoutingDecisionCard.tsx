import type { WorkGraphPresentationProjection } from '../api/types';

type Routing = WorkGraphPresentationProjection['nodes'][number]['routing'][number];

export function RoutingDecisionCard({ routing }: { routing: Routing }) {
  return (
    <div className="routing-decision-card">
      <div className="routing-decision-head">
        <strong>{routing.agentClassRef}</strong>
        <span>{routing.policy.toUpperCase()}</span>
      </div>
      <div className="routing-decision-binding">
        {routing.providerRef && routing.modelRef
          ? `${routing.providerRef}/${routing.modelRef}`
          : '等待 Kernel concrete binding'}
        {routing.harnessRef ? ` · ${routing.harnessRef}` : ''}
      </div>
      {(routing.estimatedCost !== undefined || routing.estimatedLatencyMs !== undefined) && (
        <small>
          {routing.estimatedCost !== undefined ? `成本 ${routing.estimatedCost.toFixed(4)}` : ''}
          {routing.estimatedCost !== undefined && routing.estimatedLatencyMs !== undefined ? ' · ' : ''}
          {routing.estimatedLatencyMs !== undefined ? `延迟 ${routing.estimatedLatencyMs}ms` : ''}
        </small>
      )}
      {routing.rejectedCandidates.length > 0 && (
        <div className="routing-rejections">
          {routing.rejectedCandidates.map(candidate => (
            <span key={`${candidate.providerRef}/${candidate.modelRef}:${candidate.reason}`}>
              拒绝 {candidate.providerRef}/{candidate.modelRef}: {candidate.reason}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
