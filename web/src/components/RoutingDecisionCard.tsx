import type { WorkGraphPresentationProjection } from '../api/types';

type Routing = WorkGraphPresentationProjection['nodes'][number]['routing'][number];

export function RoutingDecisionCard({ routing }: { routing: Routing }) {
  return (
    <div className="routing-decision-card">
      <div className="routing-decision-head">
        <strong>{routing.executorDisplayName}</strong>
        <span>{routing.policy.toUpperCase()}</span>
      </div>
      <span className="routing-section-label">最终选择</span>
      <div className="routing-decision-binding">
        {routing.selected
          ? `${routing.selected.providerDisplayName} / ${routing.selected.modelDisplayName}`
          : '等待 Kernel 最终选择'}
        {routing.harnessDisplayName ? ` · ${routing.harnessDisplayName}` : ''}
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
          <strong>未入选模型候选</strong>
          {routing.rejectedCandidates.map(candidate => (
            <div key={`${candidate.providerDisplayName}/${candidate.modelDisplayName}:${candidate.reasonCode}`}>
              <span>{candidate.providerDisplayName} / {candidate.modelDisplayName}</span>
              <small>{candidateReason(candidate.reasonCode, candidate.reasonDetail)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function candidateReason(reasonCode: string, reasonDetail?: string): string {
  if (reasonCode === 'missing_capability') {
    return `该模型未声明任务所需的 ${reasonDetail ?? '能力'} 能力`;
  }
  if (reasonCode === 'latency_limit_exceeded') return '预计延迟超过当前任务限制';
  if (reasonCode === 'cost_limit_exceeded') return '预计成本超过当前任务限制';
  if (reasonCode === 'unavailable') return '该模型当前不可用';
  return '该模型未满足本次任务的路由条件';
}
