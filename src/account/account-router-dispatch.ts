import { authorizedExecutorBindingFingerprint } from '../core/authorized-executor-binding.js';
import type { RuntimeConfigurationView } from '../configuration/types.js';
import type { ExecutorAttemptReceipt } from '../storage/executor-attempt-receipt-repo.js';
import type { Subtask } from '../core/types.js';
import type { RouterDispatchInput, RouterDispatchResult } from '../execution/control-execution-runtime.js';
import type { RouterDispatchService } from '../execution/router-dispatch-service.js';
import { RouterError, type RouteExclusionReason, type RouteRequest } from '../routing/router.js';
import type { WorkGraphRevisionRecord } from '../storage/work-graph-revision-repo.js';
import { isTerminalTaskStatus, type TaskStatus } from '../task/task-state.js';
import {
  unavailableAgentClasses,
} from '../control/plan-routing-eligibility.js';
import type { ControlExecutorStatusProjection } from '../control/executor-status-projection.js';

type RoutingSubtask = Pick<Subtask, 'id' | 'taskId' | 'generationId' | 'graphRevision'
  | 'status' | 'goal' | 'acceptance' | 'executorBindings'>;
type RoutingRevision = Pick<WorkGraphRevisionRecord, 'generationId' | 'revision' | 'configurationRevision'>;

/** Account composition supplies synchronous owner reads, including at commit. */
export function createAccountRouteDispatcher(deps: {
  routerDispatch: RouterDispatchService;
  readConfiguration: (revision: string) => RuntimeConfigurationView | null;
  readAttempts: (taskId: string) => readonly ExecutorAttemptReceipt[];
  readTaskStatus: (taskId: string) => TaskStatus | null;
  readSubtask: (subtaskId: string) => RoutingSubtask | null;
  readActiveRevision: (taskId: string) => RoutingRevision | null;
  /**
   * Current Executor availability for the pinned revision. Routing is decided
   * after a model call, so health read at dispatch time is stale by the time
   * the decision is committed: this read runs inside the append transaction and
   * removes AgentClasses that are unavailable right now.
   */
  readExecutorStatuses?: (configurationRevision: string) => readonly ControlExecutorStatusProjection[];
}): (item: RouterDispatchInput) => Promise<RouterDispatchResult> {
  return async item => {
    const readCurrentRequest = (): RouteRequest | null => {
      const status = deps.readTaskStatus(item.taskId);
      const revision = deps.readActiveRevision(item.taskId);
      const subtask = deps.readSubtask(item.subtaskId);
      if (!status || isTerminalTaskStatus(status) || !revision || !subtask
        || subtask.taskId !== item.taskId
        || subtask.generationId !== item.generationId
        || revision.generationId !== item.generationId
        || subtask.graphRevision !== revision.revision
        || revision.configurationRevision !== item.configurationRevision
        || subtask.status === 'cancelled'
        || (subtask.status === 'done' && item.attemptPayload?.protocol !== 'metawork:service-repair:v1')
        || subtask.executorBindings.some(binding => binding.configurationRevision !== item.configurationRevision)) {
        return null;
      }
      const configuration = deps.readConfiguration(item.configurationRevision);
      if (!configuration || configuration.revisionId !== item.configurationRevision) return null;
      const failed = new Set(deps.readAttempts(item.taskId)
        .filter(attempt => attempt.subtaskId === item.subtaskId
          && attempt.generationId === item.generationId
          && attempt.graphRevision === revision.revision
          && attempt.attemptId !== item.attemptId
          && !(attempt.failure?.stage === 'context_preparation' && attempt.failure.attemptStarted === false
            && attempt.failure.externalSideEffect === false)
          && ['executor_failed', 'heartbeat_lost', 'contract_blocked'].includes(attempt.terminalState))
        .map(attempt => attempt.bindingFingerprint));
      const unavailable = deps.readExecutorStatuses
        ? unavailableAgentClasses(deps.readExecutorStatuses(item.configurationRevision), new Date().toISOString())
        : new Set<string>();
      const excluded = new Map<string, RouteExclusionReason>();
      const candidates = subtask.executorBindings
        .filter(binding => !failed.has(authorizedExecutorBindingFingerprint(binding)))
        .filter(binding => {
          if (!unavailable.has(binding.agentClassRef)) return true;
          excluded.set(binding.agentClassRef, 'provider_unavailable');
          return false;
        })
        .map(binding => ({
        agentClassRef: binding.agentClassRef, providerRef: binding.providerRef,
        modelRef: binding.modelRef, permissionProfileRef: binding.permissionProfileRef,
      }));
      if (candidates.some(candidate => !configuration.models[candidate.modelRef]
        || configuration.models[candidate.modelRef]!.providerRef !== candidate.providerRef)) return null;
      return {
        taskId: item.taskId, generationId: item.generationId, subtaskId: item.subtaskId,
        graphRevision: revision.revision, attemptOrdinal: stableAttemptOrdinal(item.attemptId),
        goal: subtask.goal, acceptance: subtask.acceptance.map(criterion => criterion.description),
        configurationRevision: revision.configurationRevision, candidates,
        excluded: [...excluded].map(([agentClassRef, reason]) => ({ agentClassRef, reason })),
        modelCatalog: candidates.map(candidate => ({
          providerRef: candidate.providerRef, modelRef: candidate.modelRef, modelId: configuration.models[candidate.modelRef]?.modelId ?? '',
        })),
      };
    };
    const request = readCurrentRequest();
    if (!request) throw stale();
    const decision = await deps.routerDispatch.route({
      request,
      readCurrentRequest,
      // The deciding Query pays for the Router call; the dispatch item carries
      // it from the execution request.
      queryId: item.queryId ?? null,
    });
    if (!decision.selected) return { binding: null, decision };
    const selected = deps.readSubtask(item.subtaskId)?.executorBindings.find(binding => (
      binding.agentClassRef === decision.selected!.agentClassRef
      && binding.providerRef === decision.selected!.providerRef
      && binding.modelRef === decision.selected!.modelRef
      && binding.permissionProfileRef === decision.selected!.permissionProfileRef
      && binding.configurationRevision === decision.configurationRevision
    ));
    // Never silently dispatch the originally suggested binding when the exact
    // persisted Router selection is no longer present in the owner facts.
    if (!selected) throw stale();
    return { binding: selected, decision };
  };
}

function stale(): RouterError {
  return new RouterError('route_stale_decision', 'Task or routing facts changed before dispatch');
}

function stableAttemptOrdinal(attemptId: string): number {
  let value = 17;
  for (const character of attemptId) value = (value * 31 + character.charCodeAt(0)) % 2_000_000_000;
  return value;
}
