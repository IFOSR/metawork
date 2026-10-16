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
      {routing.spanRouting && (
        <div className="routing-span-evidence">
          <strong>决策模型</strong>
          {routing.spanRouting.decisionModel && (
            <div className="routing-span-model">
              <span>{routing.spanRouting.decisionModel.providerDisplayName} / {routing.spanRouting.decisionModel.modelDisplayName}</span>
              <small>{routing.spanRouting.applied ? '已参与本次排序' : `本次未生效：${spanRoutingReason(routing.spanRouting.reason)}`}</small>
            </div>
          )}
          {!routing.spanRouting.decisionModel && (
            <small>{routing.spanRouting.applied ? '已参与本次排序' : `本次未生效：${spanRoutingReason(routing.spanRouting.reason)}`}</small>
          )}
          {routing.spanRouting.candidates.map(candidate => (
            <div className={candidate.selected ? 'routing-span-candidate-selected' : undefined} key={`${candidate.providerDisplayName}/${candidate.modelDisplayName}`}>
              <span>{candidate.providerDisplayName} / {candidate.modelDisplayName}</span>
              <small>{candidate.selected ? '最终采用 · ' : ''}{(candidate.probability * 100).toFixed(1)}%</small>
            </div>
          ))}
        </div>
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

function spanRoutingReason(reason: string | null): string {
  switch (reason) {
    case 'span_candidate_mismatch':
      return '决策模型返回的答案结构或候选评分不完整，已回退到系统路由';
    case 'candidate_set_changed':
    case 'candidate_identity_mismatch':
    case 'incomplete_probabilities':
      return '评估结果与当前可用候选不一致，已回退到系统路由';
    case 'stale_observation':
      return '评估结果已过期，已回退到系统路由';
    case 'span_timeout':
      return '决策模型超时，已回退到系统路由';
    case 'span_input_too_large':
      return '候选数量或路由请求大小超出 MetaWork 本地限制，未调用决策模型，已回退到系统路由';
    case 'span_proposal_budget_exhausted':
      return '本次候选数量超出决策模型处理上限，已回退到系统路由';
    case 'span_secret_unavailable':
      return '决策模型凭证不可用，已回退到系统路由';
    case 'span_configuration_unavailable':
      return '决策模型配置不可用，已回退到系统路由';
    case 'span_http_error':
      return '决策模型接口请求失败，已回退到系统路由';
    case 'span_invalid_response':
      return '决策模型未返回合法的 System One 结果，已回退到系统路由';
    case 'span_disabled':
      return '决策模型未启用，使用系统路由';
    case 'single_candidate':
      return '只有一个可用候选，直接使用系统路由';
    case 'no_eligible_candidate':
      return '没有满足条件的候选，使用系统路由';
    case 'no_observation':
    case 'missing_subtask_observation':
      return '本次没有可用的决策模型结果，使用系统路由';
    default:
      return reason ?? '未提供原因，已回退到系统路由';
  }
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
