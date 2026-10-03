import type { AccountPermissionService } from './account-permission-service.js';
import type { AccountKernelServices } from './account-kernel-services.js';
import type { AccountRuntimeExecutionServices } from './account-runtime-execution-services.js';
import type { AccountTaskServices } from './account-task-services.js';
import type { AccountWorkspaceServices } from './account-workspace-services.js';
import type { AccountRepositories } from './account-repositories.js';
import {
  isPermissionRequestActive,
  permissionRequestExpiresAt,
  PermissionWorkflowService,
} from '../execution/permission-workflow-service.js';
import { RegisteredCapabilityResourceResolver } from '../execution/capability-resource-resolver.js';
import { buildPermissionRules, type PermissionRequestRecord } from '../resource/index.js';
import { isTerminalTaskLifecycle, toTaskLifecycleState } from '../task/task-lifecycle.js';

export function createSqliteAccountPermissionService(deps: {
  readonly kernelServices: AccountKernelServices;
  readonly runtimeExecutionServices: AccountRuntimeExecutionServices;
  readonly taskServices: AccountTaskServices;
  readonly workspaceServices: AccountWorkspaceServices;
  readonly repositories: AccountRepositories;
  readonly onContinuationReady?: () => void;
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
        permissionProfileId: record.request.permissionProfileId,
        containerId: attemptExecution?.containerId ?? '',
        workspaceId: attemptExecution?.workspaceId
          ?? `workspace:${record.request.taskId}:${record.request.generationId}:${record.request.subtaskId}`,
        checkpointId: null,
      },
      repository: deps.workspaceServices.permissionRepository,
      resolver: new RegisteredCapabilityResourceResolver(resourceRegistrations),
      executionBackend: deps.taskServices.attemptExecutionBackend,
      workflowStore: deps.kernelServices.kernelWorkflowRepo,
      kernel: deps.kernelServices.controlKernel,
      rules: buildPermissionRules({
        permissionProfileId: record.request.permissionProfileId,
        additionalReadPartitions: resourceRegistrations.values(),
      }),
      hooks: {
        checkpoint: async () => null,
        onEscalation: async () => undefined,
        onRecoveryAuthorized: async ({ request, decision }) => {
          if (!request) throw new Error('permission recovery request unavailable');
          const current = deps.taskServices.taskRuntimeService.findTask(request.taskId);
          const generation = deps.repositories.workGraphRevisionRepo.findActive(request.taskId);
          if (!current || isTerminalTaskLifecycle(toTaskLifecycleState(current.status))
            || generation?.generationId !== request.generationId) return;
          // markApplied commits this next input in the SAME transaction as the
          // permission application. No client callback can lose the continuation.
          return {
            schemaVersion: 5,
            type: 'task_resume_requested',
            configurationRevision: decision.configurationRevision,
            id: `permission_resume_${request.id}`,
            correlationId: request.id,
            causationId: decision.id,
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
      const store = deps.kernelServices.kernelWorkflowRepo;
      if (startup) store.reconcileProcessing();
      const work = store.listPermissionWork();
      for (const item of work) {
        if (resolving.has(item.requestId)) continue;
        const record = deps.workspaceServices.permissionRepository.findRequest(item.requestId);
        if (!record) continue;
        // Permission effects are idempotent: authorization/grant use unique identities,
        // backend resume first inspects state, and the continuation is committed with markApplied.
        if (item.decisionId && item.status === 'uncertain') {
          store.resolveUncertainApplication(item.decisionId, 'retry', new Date().toISOString());
        }
        const event = store.findEvent(item.eventId);
        if (!event) continue;
        resolving.add(item.requestId);
        try { await workflowFor(item.sessionId, record).recover(event); }
        finally { resolving.delete(item.requestId); }
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
      const decisions = deps.kernelServices.kernelDecisionRepo.listByCorrelation(input.requestId);
      const escalation = decisions.find(record => record.sessionId === input.sessionId
        && record.action === 'escalate_capability'
        && deps.kernelServices.kernelWorkflowRepo.isDecisionApplied(record.id));
      if (!escalation) {
        return conflict('Permission request does not belong to this Conversation.');
      }
      const currentRequest = deps.workspaceServices.permissionRepository.findRequest(input.requestId);
      if (!currentRequest || (input.expectedRevision !== undefined && input.expectedRevision !== currentRequest.request.fingerprint)
        || (input.expectedGenerationId !== undefined && input.expectedGenerationId !== currentRequest.request.generationId)) {
        return conflict('permission_request_revision_conflict');
      }
      const accepted = deps.kernelServices.kernelWorkflowRepo.findPermissionResolution(input.requestId);
      if (accepted) {
        return {
          status: accepted.resolution === input.resolution ? 'replayed' : 'conflict',
          resolution: accepted.resolution,
          message: 'Permission decision was already accepted; application may still be pending.',
          recoveryTaskId: null,
        };
      }
      const appliedResolution = decisions.find(
        record => record.event.type === 'permission_resolution_received'
          && deps.kernelServices.kernelWorkflowRepo.isDecisionApplied(record.id),
      );
      if (appliedResolution?.event.type === 'permission_resolution_received') {
        if (appliedResolution.sessionId === input.sessionId
          && appliedResolution.event.resolution === input.resolution) {
          return {
            status: 'replayed',
            resolution: input.resolution,
            message: 'Permission resolution was already recorded.',
            recoveryTaskId: null,
          };
        }
        return conflict('Permission request was already resolved.');
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
      if (!task || isTerminalTaskLifecycle(toTaskLifecycleState(task.status))
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
