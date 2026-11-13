import { isTerminalTaskStatus, type Task, type Subtask } from '../core/types.js';
import type { PlannerConfigurationView } from '../configuration/types.js';
import type { HarnessUsageEvent } from '../executor/harness-driver.js';
import type { PlanningContext } from '../planning/planning-types.js';
import type { NormalizedCapabilityRequest } from '../resource/types.js';
import { capabilityRequestFingerprint } from '../resource/permission-policy.js';
import { redactSensitiveText } from '../utils/redact-sensitive-text.js';

/** Account-owned read port: no current UI selection participates in this scope. */
export interface ManagerPermissionFacts {
  task: Pick<Task, 'id' | 'accountId' | 'conversationId' | 'workspaceId' | 'goal' | 'status'>;
  subtask: Pick<Subtask, 'id' | 'taskId' | 'generationId' | 'graphRevision' | 'goal' | 'status'>;
  graph: { generationId: string; revision: number; configurationRevision: string };
  attempt: {
    taskId: string; generationId: string; subtaskId: string; configurationRevision: string;
    status: string; agentClassRef: string; permissionProfileId: string;
  };
}

export interface ManagerPermissionContextDependencies {
  accountId: string;
  readFacts(request: NormalizedCapabilityRequest): ManagerPermissionFacts | null;
  readUserIntent(taskId: string, conversationId: string): { queryId: string; text: string } | null;
  readConfiguration(revision: string): Promise<PlannerConfigurationView>;
  onUsage(input: { queryId: string; taskId: string; requestId: string; configurationRevision: string; usage: HarnessUsageEvent }): void;
}

/** Resolve trusted intent and pinned model facts before asking the Manager. */
export function createManagerPermissionContextResolver(deps: ManagerPermissionContextDependencies) {
  return async (request: NormalizedCapabilityRequest): Promise<PlanningContext> => {
    const facts = validatedFacts(deps, request);
    const conversationId = facts.task.conversationId!;
    const intent = deps.readUserIntent(request.taskId, conversationId);
    if (!intent?.text.trim()) throw new Error('manager_permission_user_intent_unavailable');
    const configuration = await deps.readConfiguration(facts.graph.configurationRevision);
    // Loading a revision may yield while cancellation or a replan commits.
    const current = validatedFacts(deps, request);
    if (current.graph.revision !== facts.graph.revision || current.task.conversationId !== conversationId
      || current.task.workspaceId !== facts.task.workspaceId
      || configuration.revisionId !== facts.graph.configurationRevision) {
      throw new Error('manager_permission_context_stale');
    }
    const userInput = redactSensitiveText(JSON.stringify({
      originalUserIntent: intent.text, taskGoal: facts.task.goal, subtaskGoal: facts.subtask.goal,
    }));
    // Do not truncate away a restriction in the original user intent.
    if (Buffer.byteLength(userInput, 'utf8') > 32_768) throw new Error('manager_permission_context_too_large');
    return {
      userInput,
      request: { sessionId: conversationId, conversationId, source: 'manager-permission' },
      pendingAuthorizationRequest: null,
      configuration,
      timeoutMs: 10_000,
      onUsage: usage => deps.onUsage({ queryId: intent.queryId, taskId: request.taskId,
        requestId: request.id, configurationRevision: configuration.revisionId, usage }),
    };
  };
}

function validatedFacts(deps: ManagerPermissionContextDependencies, request: NormalizedCapabilityRequest): ManagerPermissionFacts {
  const facts = deps.readFacts(request);
  if (!facts || request.fingerprint !== capabilityRequestFingerprint(request)
    || facts.task.id !== request.taskId || facts.task.accountId !== deps.accountId
    || !facts.task.conversationId || !facts.task.workspaceId || isTerminalTaskStatus(facts.task.status)
    || facts.subtask.id !== request.subtaskId || facts.subtask.taskId !== request.taskId
    || facts.subtask.generationId !== request.generationId || facts.subtask.status !== 'running'
    || facts.graph.generationId !== request.generationId || facts.graph.revision !== facts.subtask.graphRevision
    || facts.attempt.taskId !== request.taskId || facts.attempt.subtaskId !== request.subtaskId
    || facts.attempt.generationId !== request.generationId
    || facts.attempt.configurationRevision !== facts.graph.configurationRevision
    || facts.attempt.agentClassRef !== request.agentClassName
    || facts.attempt.permissionProfileId !== request.permissionProfileId
    || !['launching', 'running'].includes(facts.attempt.status)) {
    throw new Error('manager_permission_context_stale');
  }
  return facts;
}
