import type { AccountPermissionService } from './account-permission-service.js';
import type { AccountControlServices } from './account-control-services.js';
import type { AccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import type { AccountTaskServices } from './account-task-services.js';
import type { AccountWorkspaceServices } from './account-workspace-services.js';
import type { AccountRepositories } from './account-repositories.js';
import {
  isPermissionRequestActive,
  permissionRequestExpiresAt,
  type ManagerPermissionJudge,
  PermissionWorkflowService,
} from '../execution/permission-workflow-service.js';
import { RegisteredCapabilityResourceResolver } from '../execution/capability-resource-resolver.js';
import { buildPermissionRules, type PermissionRequestRecord } from '../resource/index.js';
import { isTerminalTaskStatus } from '../task/task-state.js';

export function createSqliteAccountPermissionService(deps: {
  readonly kernelServices: AccountControlServices;
  readonly runtimeExecutionServices: AccountRuntimeExecutionServices;
  readonly taskServices: AccountTaskServices;
  readonly workspaceServices: AccountWorkspaceServices;
  readonly repositories: AccountRepositories;
  readonly onContinuationReady?: () => void;
  /** Applies the post-grant continuation on the Task's own control loop. */
  readonly deliverContinuation?: (event: import('../control/control-contracts.js').ControlEvent) => Promise<void>;
  readonly managerPermissionJudge?: ManagerPermissionJudge;
}): AccountPermissionService & { recoverPending(startup?: boolean): Promise<number> } {
  const resolving = new Set<string>();
  function workflowFor(sessionId: string, record: PermissionRequestRecord): PermissionWorkflowService {
    const dispatchItem = deps.runtimeExecutionServices.dispatchItemRepo.find(record.request.attemptId);
    if (!dispatchItem) throw new Error(`permission dispatch unavailable: ${record.request.attemptId}`);
    const attemptExecution = deps.workspaceServices.attemptExecutionRepository.find(record.request.attemptId);
    const task = deps.taskServices.taskRuntimeService.findTask(record.request.taskId);
    const resourceRegistrations = new Map((task?.resources ?? []).map((resource, index) => [
      resource,
      {
        kind: 'path' as const,
        mountId: `inputs-${record.request.taskId}`,
        normalizedRelativePath: `resource-${index}`,
      },
    ]));
    return new PermissionWorkflowService({
      context: {
        sessionId,
        taskId: record.request.taskId,
        generationId: record.request.generationId,
        subtaskId: record.request.subtaskId,
        attemptId: record.request.attemptId,
        agentClassName: record.request.agentClassName,
        configurationRevision: dispatchItem.configurationRevision,
        authorizedDecisionId: dispatchItem.decisionId,
        permissionProfileId: record.request.permissionProfileId,
        containerId: attemptExecution?.containerId ?? '',
        workspaceId: attemptExecution?.workspaceId
          ?? `workspace:${record.request.taskId}:${record.request.generationId}:${record.request.subtaskId}`,
        checkpointId: null,
      },
      repository: deps.workspaceServices.permissionRepository,
      resolver: new RegisteredCapabilityResourceResolver(resourceRegistrations),
      executionBackend: deps.taskServices.attemptExecutionBackend,
      ...(deps.deliverContinuation ? { deliverContinuation: deps.deliverContinuation } : {}),
      rules: buildPermissionRules({
        permissionProfileId: record.request.permissionProfileId,
        additionalReadPartitions: resourceRegistrations.values(),
      }),
      ...(deps.managerPermissionJudge ? { manager: deps.managerPermissionJudge } : {}),
      hooks: {
        checkpoint: async () => null,
        onEscalation: async () => undefined,
        onRecoveryAuthorized: async ({ request }) => {
          if (!request) throw new Error('permission recovery request unavailable');
          const current = deps.taskServices.taskRuntimeService.findTask(request.taskId);
          const generation = deps.repositories.workGraphRevisionRepo.findActive(request.taskId);
          if (!current || isTerminalTaskStatus(current.status)
            || generation?.generationId !== request.generationId) return;
          // markApplied commits this next input in the SAME transaction as the
          // permission application. No client callback can lose the continuation.
          return {
            schemaVersion: 5,
            type: 'task_resume_requested',
            configurationRevision: dispatchItem.configurationRevision,
            id: `permission_resume_${request.id}`,
            correlationId: request.id,
            causationId: dispatchItem.decisionId ?? `dispatch_${request.attemptId}`,
            occurredAt: new Date().toISOString(),
            sessionId,
            taskId: request.taskId,
            subtaskId: request.subtaskId,
            blockerCategory: 'explicit_resource',
            sourceInputExcerpt: 'User approved the exact capability request.',
            newlyProvidedResources: [],
            idempotencyKey: `permission_resume:${request.id}`,
          };
        },
      },
    });

  }
  return {
    async recoverPending(startup = false) {
      // Owner queue only: the event is reconstructed from durable permission facts.
      const repository = deps.workspaceServices.permissionRepository;
      const now = new Date().toISOString();
      if (startup) repository.reconcilePermissionWork?.(now);
      const work = repository.listPermissionWork?.() ?? [];
      for (const item of work) {
        if (resolving.has(item.requestId)) continue;
        const record = repository.findRequest(item.requestId);
        if (!record) continue;
        const dispatch = deps.runtimeExecutionServices.dispatchItemRepo.find(record.request.attemptId);
        const task = deps.taskServices.taskRuntimeService.findTask(record.request.taskId);
        const resolution = item.eventType === 'permission_resolution_received'
          ? repository.findResolution?.(item.requestId) ?? null
          : null;
        const sessionId = resolution?.sessionId
          ?? task?.ownerPlannerSessionId
          ?? task?.conversationId
          ?? null;
        if (!dispatch || !sessionId) continue;
        if (item.eventType === 'permission_resolution_received' && !resolution) continue;
        const event = item.eventType === 'permission_requested'
          ? {
              schemaVersion: 5 as const,
              configurationRevision: dispatch.configurationRevision,
              type: 'permission_requested' as const,
              id: item.eventId,
              correlationId: record.request.id,
              causationId: null,
              occurredAt: record.createdAt,
              sessionId,
              taskId: record.request.taskId,
              subtaskId: record.request.subtaskId,
              attemptId: record.request.attemptId,
              request: record.request,
            }
          : {
              schemaVersion: 5 as const,
              configurationRevision: dispatch.configurationRevision,
              type: 'permission_resolution_received' as const,
              id: item.eventId,
              correlationId: record.request.id,
              causationId: null,
              occurredAt: resolution!.createdAt,
              sessionId,
              taskId: record.request.taskId,
              subtaskId: record.request.subtaskId,
              attemptId: record.request.attemptId,
              requestId: record.request.id,
              resolution: resolution!.resolution,
              source: resolution!.source,
              plannerPlanId: resolution!.plannerPlanId,
            };
        const claimed = repository.claimPermissionWork
          ? repository.claimPermissionWork(item.eventId, now)
          : true;
        if (!claimed) continue;
        resolving.add(item.requestId);
        try {
          await workflowFor(sessionId, record).recover(event);
        } catch {
          // An interrupted continuation leaves the item pending for the next pass.
          repository.releasePermissionWork?.(item.eventId, new Date().toISOString());
        } finally { resolving.delete(item.requestId); }
      }
      return work.length;
    },
    listForSession(sessionId, afterId = '', limit = 32) {
      const now = new Date().toISOString();
      return deps.workspaceServices.permissionRepository.listEscalatedForSession(sessionId, afterId, limit,
        new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .filter(record => isPermissionRequestActive(record.createdAt, now))
        .map(record => {
          return {
            schemaVersion: 1,
            permissionRequestId: record.request.id,
            requestRevision: record.request.fingerprint,
            taskId: record.request.taskId,
            taskTitle: deps.taskServices.taskRuntimeService.findTask(record.request.taskId)?.title
              ?? record.request.taskId,
            generationId: record.request.generationId,
            subtaskId: record.request.subtaskId,
            subtaskTitle: deps.repositories.subtaskRepo.findById(record.request.subtaskId)?.title
              ?? record.request.subtaskId,
            attemptId: record.request.attemptId,
            executorName: record.request.agentClassName,
            permissionProfileId: record.request.permissionProfileId,
            capability: record.request.capability,
            resource: record.request.resource,
            operation: record.request.operation,
            reason: record.request.reason,
            suggestedScope: record.request.suggestedScope,
            escalationReason: record.decisionReason ?? '',
            createdAt: record.createdAt,
            expiresAt: permissionRequestExpiresAt(record.createdAt)!,
          };
        });
    },
    async resolve(input) {
      const visibleRequest = deps.workspaceServices.permissionRepository
        .listEscalatedForSession(
          input.sessionId,
          '',
          128,
          new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        )
        .some(record => record.request.id === input.requestId);
      if (!visibleRequest) {
        return conflict('Permission request does not belong to this Conversation.');
      }
      const currentRequest = deps.workspaceServices.permissionRepository.findRequest(input.requestId);
      if (!currentRequest || (input.expectedRevision !== undefined && input.expectedRevision !== currentRequest.request.fingerprint)
        || (input.expectedGenerationId !== undefined && input.expectedGenerationId !== currentRequest.request.generationId)) {
        return conflict('permission_request_revision_conflict');
      }
      const accepted = deps.workspaceServices.permissionRepository.findResolution?.(input.requestId) ?? null;
      if (accepted) {
        return {
          status: accepted.resolution === input.resolution ? 'replayed' : 'conflict',
          resolution: accepted.resolution,
          message: 'Permission decision was already accepted; application may still be pending.',
          recoveryTaskId: null,
        };
      }
      const record = deps.workspaceServices.permissionRepository.findRequest(input.requestId);
      if (!record || record.status !== 'escalated') {
        return conflict('Permission request is no longer escalated.');
      }
      if (!isPermissionRequestActive(record.createdAt, new Date().toISOString())) {
        return conflict('Permission request has expired.');
      }
      const dispatchItem = deps.runtimeExecutionServices.dispatchItemRepo.find(
        record.request.attemptId,
      );
      if (!dispatchItem) {
        return conflict(
          `Permission request has no authorized dispatch identity: ${record.request.attemptId}`,
        );
      }
      const task = deps.taskServices.taskRuntimeService.findTask(record.request.taskId);
      const revision = deps.repositories.workGraphRevisionRepo.findActive(record.request.taskId);
      if (!task || isTerminalTaskStatus(task.status)
        || (revision && revision.generationId !== record.request.generationId)
        || dispatchItem.taskId !== record.request.taskId || dispatchItem.generationId !== record.request.generationId) {
        return conflict('permission_request_execution_stale');
      }
      const workflow = workflowFor(input.sessionId, record);
      resolving.add(input.requestId);
      try {
      const result = await workflow.resolve({
        requestId: input.requestId,
        resolution: input.resolution,
        source: input.source,
        plannerPlanId: input.plannerPlanId,
        actor: input.actor,
      });
      if (result.status === 'accepted') deps.onContinuationReady?.();
      return {
        status: result.status === 'accepted' ? 'resolved' : result.status,
        resolution: result.resolution,
        message: result.status === 'conflict' ? 'Permission request was already resolved.' : 'Permission decision accepted.',
        recoveryTaskId: null,
      };
      } finally { resolving.delete(input.requestId); }
    },
  };
}

function conflict(message: string) {
  return {
    status: 'conflict' as const,
    resolution: null,
    message,
    recoveryTaskId: null,
  };
}
