import type { RouteDecision } from '../routing/router.js';

/** Public failure facts; never expose a Provider response body or credential. */
export function routerFailureFacts(decision?: RouteDecision) {
  const decisionUnavailable = Boolean(decision && decision.candidates.length > 0);
  const unavailableReason = decision?.unavailableReason
    ?? (decision ? extractUnavailableReason(decision.rationale) : undefined);
  const reasonDetail = decisionUnavailable
    ? unavailableReason
      ? `（Router 原因：${unavailableReason}）`
      : '（Router 未返回具体原因）'
    : '';
  return {
    failureCode: decisionUnavailable ? 'route_decision_unavailable' : 'route_no_candidate',
    failureLabel: decisionUnavailable ? 'Router 决策未完成' : '没有可用的 Executor',
    failureSummary: decisionUnavailable
      ? `已有符合要求的 Executor，但 Router 决策服务未能选出执行器，任务已暂停。${reasonDetail}`
      : '没有符合当前任务要求的可用 Executor，当前子任务已暂停。',
    failureStage: 'routing',
    attemptStarted: false,
    userAction: decisionUnavailable
      ? '请检查 Router 决策模型配置、网络和服务状态，恢复后点击「继续未完成部分」。'
      : '请检查 Executor 是否启用、能力及模型配置是否满足要求，再点击「继续未完成部分」。',
  };
}

function extractUnavailableReason(rationale: string | undefined): string | undefined {
  if (!rationale) return undefined;
  const match = /^Router decision unavailable \(([^)]+)\)/u.exec(rationale);
  return match?.[1]?.trim() || undefined;
}

/**
 * Presentation-safe label for why the decision model produced no selection.
 * The Router then runs its deterministic default binding, so this text always
 * accompanies a successful route, never a failed Subtask.
 */
export function routerUnavailableReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'span_http_error':
      return '决策模型接口请求失败';
    case 'span_timeout':
      return '决策模型响应超时';
    case 'span_invalid_response':
      return '决策模型未返回合法的 System One 结果';
    case 'span_candidate_mismatch':
      return '决策模型返回的候选评分不完整或与当前候选不一致';
    case 'span_input_too_large':
      return '路由请求超出本地大小限制';
    case 'span_proposal_budget_exhausted':
      return '候选数量超出决策模型处理上限';
    case 'span_secret_unavailable':
      return '决策模型凭证不可用';
    case 'span_disabled':
      return '决策模型未启用';
    case 'decision_model_unavailable':
      return '决策模型未配置';
    default:
      return reason ? `决策模型不可用（${reason}）` : '决策模型不可用';
  }
}

/** Public facts for a Subtask that ran on the Router's default binding. */
export function routerDefaultFallbackFacts(decision: RouteDecision) {
  return {
    failureCode: 'route_decision_unavailable',
    failureStage: 'routing',
    selection: 'default_fallback',
    unavailableReason: decision.unavailableReason ?? 'decision_model_unavailable',
    attemptStarted: true,
  };
}
