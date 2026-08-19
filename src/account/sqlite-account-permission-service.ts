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
import { buildPermissionRules } from '../resource/index.js';

export function createSqliteAccountPermissionService(deps: {
  readonly kernelServices: AccountKernelServices;
  readonly runtimeExecutionServices: AccountRuntimeExecutionServices;
  readonly taskServices: AccountTaskServices;
  readonly workspaceServices: AccountWorkspaceServices;
  readonly repositories: AccountRepositories;
}): AccountPermissionService {
  return {
    listForSession(sessionId) {
      const now = new Date().toISOString();
      const decisions = deps.kernelServices.kernelDecisionRepo.listBySession(sessionId);
      const appliedEscalations = new Map(decisions
        .filter(record => record.action === 'escalate_capability'
          && deps.kernelServices.kernelWorkflowRepo.isDecisionApplied(record.id))
        .map(record => [record.correlationId, record]));
      return deps.workspaceServices.permissionRepository.listEscalated()
        .filter(record => appliedEscalations.has(record.request.id))
        .filter(record => !deps.kernelServices.kernelDecisionRepo
          .listByCorrelation(record.request.id)
          .some(decision => decision.event.type === 'permission_resolution_received'
            && deps.kernelServices.kernelWorkflowRepo.isDecisionApplied(decision.id)))
        .filter(record => isPermissionRequestActive(record.createdAt, now))
        .map(record => {
          const escalation = appliedEscalations.get(record.request.id)!;
          return {
            schemaVersion: 1,
            permissionRequestId: record.request.id,
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
            escalationReason: escalation.reason,
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
      const appliedResolution = decisions.find(
        record => record.event.type === 'permission_resolution_received'
          && deps.kernelServices.kernelWorkflowRepo.isDecisionApplied(record.id),
      );
      if (appliedResolution?.event.type === 'permission_resolution_received') {
        if (appliedResolution.sessionId === input.sessionId
          && appliedResolution.event.resolution === input.resolution
          && appliedResolution.event.source === input.source) {
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
      const attemptExecution = deps.workspaceServices.attemptExecutionRepository.find(
        record.request.attemptId,
      );
      const task = deps.taskServices.taskRuntimeService.findTask(record.request.taskId);
      const resourceRegistrations = new Map((task?.resources ?? []).map((resource, index) => [
        resource,
        {
          kind: 'path' as const,
          mountId: `inputs-${record.request.taskId}`,
          normalizedRelativePath: `resource-${index}`,
        },
      ]));
      const workflow = new PermissionWorkflowService({
        context: {
          sessionId: input.sessionId,
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
          onRecoveryAuthorized: async () => undefined,
        },
      });
      await workflow.resolve({
        requestId: input.requestId,
        resolution: input.resolution,
        source: input.source,
        plannerPlanId: input.plannerPlanId,
      });
      return {
        status: 'resolved',
        resolution: input.resolution,
        message: 'Permission resolution recorded.',
        recoveryTaskId: input.resolution === 'approve' ? record.request.taskId : null,
      };
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
