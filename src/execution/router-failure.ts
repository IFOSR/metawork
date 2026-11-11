import type { RouteDecision } from '../routing/router.js';

/** Public failure facts; never expose a Provider response body or credential. */
export function routerFailureFacts(decision?: RouteDecision) {
  const decisionUnavailable = Boolean(decision && decision.candidates.length > 0);
  return {
    failureCode: decisionUnavailable ? 'route_decision_unavailable' : 'route_no_candidate',
    failureLabel: decisionUnavailable ? 'Router 决策未完成' : '没有可用的 Executor',
    failureSummary: decisionUnavailable
      ? '已有符合要求的 Executor，但 Router 决策服务未能选出执行器，任务已暂停。'
      : '没有符合当前任务要求的可用 Executor，当前子任务已暂停。',
    failureStage: 'routing',
    attemptStarted: false,
    userAction: decisionUnavailable
      ? '请检查 Router 决策模型配置、网络和服务状态，恢复后点击「继续未完成部分」。'
      : '请检查 Executor 是否启用、能力及模型配置是否满足要求，再点击「继续未完成部分」。',
  };
}
